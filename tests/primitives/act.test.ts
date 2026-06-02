/**
 * Tests for the `act` primitive (N-2).
 *
 * Three layers (mirrors see.test.ts):
 *   1. Unit tests with the `_open` / `_openStagehand` test seams. Fast, no
 *      real browser. Verifies engine selection, per-step dispatch, error
 *      propagation, stop-on-error vs continue, cost accumulation, artifacts
 *      isolation, schema field plumbing.
 *   2. Integration test with real Chromium against the existing fixture
 *      site. Exercises only the raw-Playwright engine — Stagehand's
 *      cold-start would dominate test time and isn't needed to prove the
 *      step dispatcher works.
 *   3. note synthesis via `_callVision` seam — never burns real LLM credits.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser } from "playwright";

import {
  act,
  defaultArtifactsRoot,
  pickEngine,
  DEFAULT_PERSONA_ID,
  type ActStep,
  type ActOptions,
  type OpenedPlaywright,
  type OpenedStagehand,
  type PlaywrightOpenFn,
  type StagehandOpenFn,
} from "../../src/core/primitives/act.js";
import { startFixtureServer, type FixtureServer } from "../fixtures/test-site/server.js";
import type { ConsoleError } from "../../src/core/types.js";
import { RESULT_SCHEMA_VERSION } from "../../src/core/result-schema.js";

// ─────────────────────────────────────────────────────────────
// Test fakes
// ─────────────────────────────────────────────────────────────

interface FakePageState {
  url: string;
  title: string;
  consoleErrors: ConsoleError[];
  /** Counts each method call so tests can assert dispatch correctness. */
  calls: {
    goto: Array<{ url: string }>;
    click: Array<{ selector: string }>;
    fill: Array<{ selector: string; value: string }>;
    press: Array<{ key: string; selector?: string; timeout?: number }>;
    waitForTimeout: number[];
    waitForSelector: Array<{ selector: string; state?: string }>;
    scroll: Array<{ deltaY?: number; toBottom?: boolean; selector?: string }>;
    screenshot: number;
    title: number;
    evaluate: number;
  };
  /** Selectors that raise on click / fill / wait_for, for error-path tests. */
  errorSelectors?: Set<string>;
}

function makeFakePage(state: FakePageState): import("playwright").Page {
  const page = {
    url: () => state.url,
    title: async () => {
      state.calls.title++;
      return state.title;
    },
    goto: async (url: string) => {
      state.calls.goto.push({ url });
      state.url = url;
    },
    click: async (selector: string) => {
      state.calls.click.push({ selector });
      if (state.errorSelectors?.has(selector)) {
        throw new Error(`fake click failed: ${selector}`);
      }
    },
    fill: async (selector: string, value: string) => {
      state.calls.fill.push({ selector, value });
      if (state.errorSelectors?.has(selector)) {
        throw new Error(`fake fill failed: ${selector}`);
      }
    },
    keyboard: {
      press: async (_key: string) => {
        // recorded via state.calls.press for the no-selector path
      },
    },
    locator: (selector: string) => ({
      first: () => ({
        press: async (key: string, opts?: { timeout?: number }) => {
          state.calls.press.push({ key, selector, timeout: opts?.timeout });
        },
        scrollIntoViewIfNeeded: async () => {
          state.calls.scroll.push({ selector });
        },
      }),
    }),
    waitForTimeout: async (ms: number) => {
      state.calls.waitForTimeout.push(ms);
    },
    waitForSelector: async (selector: string, opts?: { state?: string }) => {
      state.calls.waitForSelector.push({ selector, state: opts?.state });
      if (state.errorSelectors?.has(selector)) {
        throw new Error(`fake waitForSelector failed: ${selector}`);
      }
    },
    screenshot: async () => {
      state.calls.screenshot++;
      return makeTinyPng();
    },
    evaluate: async (_fn: unknown, _arg?: unknown) => {
      state.calls.evaluate++;
      // Used for both DOM summary extraction (object) and headings (array).
      // Return a heading array on every other call so DOM section + headings work.
      if (state.calls.evaluate % 2 === 1) {
        // Pretend this is the dom-summary call:
        return {
          title: state.title,
          elements: "[Headings]\nh1: Hello\n\n[Interactive Elements] (1)\n<button>Go</button>",
          totalInteractive: 1,
          headings: "h1: Hello",
          textContent: "Hello world",
        } as unknown;
      }
      return ["h1: Hello"] as unknown;
    },
    on: () => undefined,
  } as unknown as import("playwright").Page;
  return page;
}

function makeTinyPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  );
}

interface FakeOpenArgs {
  url?: string;
  title?: string;
  consoleErrors?: ConsoleError[];
  errorSelectors?: string[];
  /** For Stagehand-engine fakes only. */
  stagehandActImpl?: (instruction: string) => Promise<unknown>;
  /** Force open() to throw before returning. */
  openError?: Error;
}

function fakeOpen(args: FakeOpenArgs = {}): {
  open: PlaywrightOpenFn;
  state: FakePageState;
} {
  const state: FakePageState = {
    url: args.url ?? "https://target.example/",
    title: args.title ?? "Fake Page",
    consoleErrors: args.consoleErrors ?? [],
    errorSelectors: args.errorSelectors ? new Set(args.errorSelectors) : undefined,
    calls: {
      goto: [],
      click: [],
      fill: [],
      press: [],
      waitForTimeout: [],
      waitForSelector: [],
      scroll: [],
      screenshot: 0,
      title: 0,
      evaluate: 0,
    },
  };
  const open: PlaywrightOpenFn = async () => {
    if (args.openError) throw args.openError;
    const page = makeFakePage(state);
    return {
      page,
      context: null,
      consoleErrors: state.consoleErrors,
      close: async () => {},
    } satisfies OpenedPlaywright;
  };
  return { open, state };
}

function fakeOpenStagehand(args: FakeOpenArgs = {}): {
  open: StagehandOpenFn;
  state: FakePageState;
  actCalls: string[];
} {
  const { open: pwOpen, state } = fakeOpen(args);
  const actCalls: string[] = [];
  const open: StagehandOpenFn = async (cfg) => {
    const base = await pwOpen(cfg);
    return {
      ...base,
      stagehandAct: async (instruction: string) => {
        actCalls.push(instruction);
        if (args.stagehandActImpl) return args.stagehandActImpl(instruction);
        return { description: `pretended to ${instruction}` };
      },
    } satisfies OpenedStagehand;
  };
  return { open, state, actCalls };
}

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "act-test-"));
});

afterEach(() => {
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ─────────────────────────────────────────────────────────────
// Engine selection
// ─────────────────────────────────────────────────────────────

describe("pickEngine", () => {
  it("returns 'playwright' when no act step is present", () => {
    expect(
      pickEngine([
        { type: "goto", url: "https://x/" },
        { type: "click", selector: "a" },
        { type: "note", goal: "anything?" },
      ]),
    ).toBe("playwright");
  });

  it("returns 'stagehand' when any act step is present", () => {
    expect(
      pickEngine([
        { type: "goto", url: "https://x/" },
        { type: "act", instruction: "Click sign up" },
      ]),
    ).toBe("stagehand");
  });

  it("returns 'playwright' for an empty step list", () => {
    expect(pickEngine([])).toBe("playwright");
  });
});

// ─────────────────────────────────────────────────────────────
// Schema field plumbing
// ─────────────────────────────────────────────────────────────

describe("act — schema field plumbing", () => {
  it("returns a schema-stamped result with engine='playwright' for pure-deterministic steps", async () => {
    const { open } = fakeOpen({ url: "https://target/", title: "Hello" });
    const r = await act({
      url: "https://target/",
      steps: [{ type: "click", selector: ".cta" }],
      artifactsRoot: workspace,
      _open: open,
    });
    expect(r.schema_version).toBe(RESULT_SCHEMA_VERSION);
    expect(r.engine).toBe("playwright");
    expect(r.url_input).toBe("https://target/");
    expect(r.url_final).toBe("https://target/");
    expect(r.title).toBe("Hello");
    expect(r.status).toBe("ok");
    expect(r.persona_id).toBe(DEFAULT_PERSONA_ID);
    expect(r.cost_usd).toBe(0);
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.status).toBe("ok");
    expect(r.steps[0]!.type).toBe("click");
    expect(r.dom).not.toBeNull();
    expect(r.console).not.toBeNull();
    expect(r.screenshot).not.toBeNull();
    expect(r.screenshot!.path).toContain(workspace);
    expect(fs.existsSync(r.screenshot!.path)).toBe(true);
  });

  it("uses persona viewport / locale / timezone / id when provided", async () => {
    const { open } = fakeOpen({});
    const r = await act({
      url: "https://x/",
      steps: [],
      artifactsRoot: workspace,
      persona: {
        id: "uk-power",
        viewport: { width: 1920, height: 1080 },
        locale: "en-GB",
        timezone: "Europe/London",
      },
      _open: open,
    });
    expect(r.persona_id).toBe("uk-power");
    expect(r.screenshot!.width).toBe(1920);
    expect(r.screenshot!.height).toBe(1080);
  });

  it("nullifies dom and console when toggles off; still always takes final screenshot", async () => {
    const { open } = fakeOpen({});
    const r = await act({
      url: "https://x/",
      steps: [],
      artifactsRoot: workspace,
      includeDom: false,
      includeConsole: false,
      _open: open,
    });
    expect(r.dom).toBeNull();
    expect(r.console).toBeNull();
    expect(r.screenshot).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// Per-step dispatch
// ─────────────────────────────────────────────────────────────

describe("act — per-step dispatch (deterministic kinds)", () => {
  it("dispatches goto / click / fill / press / wait / wait_for / scroll / screenshot to Page", async () => {
    const { open, state } = fakeOpen({ url: "https://orig/" });
    const steps: ActStep[] = [
      { type: "goto", url: "https://next/" },
      { type: "click", selector: "button.cta" },
      { type: "fill", selector: "input[name=email]", value: "a@b.c" },
      { type: "press", key: "Enter" },
      { type: "wait", ms: 250 },
      { type: "wait_for", selector: "#done", state: "hidden" },
      { type: "scroll", selector: ".footer" },
      { type: "screenshot", label: "after-submit" },
    ];
    const r = await act({
      url: "https://orig/",
      steps,
      artifactsRoot: workspace,
      _open: open,
    });
    expect(r.status).toBe("ok");
    expect(r.steps.map((s) => s.status)).toEqual(Array(steps.length).fill("ok"));

    // The fake _open seam takes the place of defaultOpenPlaywright and does
    // not perform the initial navigation (the real defaultOpenPlaywright
    // does — see see.test.ts and act.ts:defaultOpenPlaywright). So the only
    // goto recorded is the explicit step 0.
    expect(state.calls.goto).toEqual([{ url: "https://next/" }]);
    expect(state.calls.click).toEqual([{ selector: "button.cta" }]);
    expect(state.calls.fill).toEqual([{ selector: "input[name=email]", value: "a@b.c" }]);
    expect(state.calls.press).toEqual([]); // top-level keyboard.press path is silent in fake
    expect(state.calls.waitForTimeout).toEqual([250]);
    expect(state.calls.waitForSelector).toEqual([{ selector: "#done", state: "hidden" }]);
    expect(state.calls.scroll).toEqual([{ selector: ".footer" }]);
    expect(state.calls.screenshot).toBeGreaterThanOrEqual(2); // step 7 + final

    // Screenshot step recorded a screenshot artefact per-step.
    const sshot = r.steps[7]!;
    expect(sshot.type).toBe("screenshot");
    expect(sshot.screenshot).toBeDefined();
    expect(sshot.screenshot!.path).toContain("after-submit.png");
    expect(fs.existsSync(sshot.screenshot!.path)).toBe(true);
  });

  it("press without selector goes through page.keyboard.press path", async () => {
    const { open, state } = fakeOpen({});
    const r = await act({
      url: "https://x/",
      steps: [{ type: "press", key: "Tab" }],
      artifactsRoot: workspace,
      _open: open,
    });
    expect(r.steps[0]!.status).toBe("ok");
    // No locator press call recorded — keyboard.press path is silent in fake.
    expect(state.calls.press).toEqual([]);
  });

  it("scroll to_bottom uses page.evaluate(window.scrollTo)", async () => {
    const { open, state } = fakeOpen({});
    const r = await act({
      url: "https://x/",
      steps: [{ type: "scroll", to_bottom: true }],
      artifactsRoot: workspace,
      _open: open,
    });
    expect(r.steps[0]!.status).toBe("ok");
    // evaluate() is also called by extractDomSummary + headings, so just
    // assert "called at least once" — the dispatch itself succeeded if
    // status is "ok".
    expect(state.calls.evaluate).toBeGreaterThan(0);
  });

  it("press with selector forwards the per-step timeout (E9)", async () => {
    const { open, state } = fakeOpen({});
    const r = await act({
      url: "https://x/",
      steps: [{ type: "press", key: "Enter", selector: "#search", timeout_ms: 1234 }],
      artifactsRoot: workspace,
      _open: open,
    });
    expect(r.steps[0]!.status).toBe("ok");
    expect(state.calls.press).toEqual([
      { key: "Enter", selector: "#search", timeout: 1234 },
    ]);
  });

  it("scroll with no target fails instead of silently passing (E9)", async () => {
    const { open } = fakeOpen({});
    const r = await act({
      url: "https://x/",
      steps: [{ type: "scroll" }],
      artifactsRoot: workspace,
      _open: open,
    });
    expect(r.steps[0]!.status).toBe("error");
    expect(r.steps[0]!.error).toMatch(/no-op/);
  });
});

describe("act — note step", () => {
  it("calls _callVision seam, returns the note text, and accumulates cost_usd", async () => {
    const { open } = fakeOpen({});
    const visionCalls: string[] = [];
    const r = await act({
      url: "https://x/",
      steps: [{ type: "note", goal: "Is the sign-up button visible?" }],
      artifactsRoot: workspace,
      _open: open,
      _callVision: async (req) => {
        visionCalls.push(req.userPrompt);
        return {
          text: "Yes, a centred 'Sign up' button under the email input.",
          inputTokens: 200,
          outputTokens: 30,
          costUsd: 0.0042,
        };
      },
    });
    expect(visionCalls).toEqual(["Is the sign-up button visible?"]);
    expect(r.steps[0]!.status).toBe("ok");
    expect(r.steps[0]!.note).toBe("Yes, a centred 'Sign up' button under the email input.");
    expect(r.steps[0]!.cost_usd).toBeCloseTo(0.0042, 6);
    expect(r.cost_usd).toBeCloseTo(0.0042, 6);
  });

  it("captures vision failure into status='error' on the note step", async () => {
    const { open } = fakeOpen({});
    const r = await act({
      url: "https://x/",
      steps: [{ type: "note", goal: "anything?" }],
      artifactsRoot: workspace,
      _open: open,
      _callVision: async () => {
        throw new Error("ANTHROPIC_API_KEY not set");
      },
    });
    expect(r.steps[0]!.status).toBe("error");
    expect(r.steps[0]!.error).toContain("ANTHROPIC_API_KEY");
    expect(r.cost_usd).toBe(0);
  });
});

describe("act — stagehand path", () => {
  it("invokes stagehandAct with the instruction and records output", async () => {
    const { open, actCalls } = fakeOpenStagehand({});
    const r = await act({
      url: "https://x/",
      steps: [{ type: "act", instruction: "Click the Sign Up button" }],
      artifactsRoot: workspace,
      _openStagehand: open,
    });
    expect(r.engine).toBe("stagehand");
    expect(actCalls).toEqual(["Click the Sign Up button"]);
    expect(r.steps[0]!.status).toBe("ok");
    expect(r.steps[0]!.output).toMatchObject({ description: expect.any(String) });
  });

  it("act step error surfaces as step status 'error' and triggers stop_on_error by default", async () => {
    const { open: shOpen } = fakeOpenStagehand({
      stagehandActImpl: async () => {
        throw new Error("Stagehand act failed: element not found");
      },
    });
    const r = await act({
      url: "https://x/",
      steps: [
        { type: "act", instruction: "Click missing thing" },
        { type: "click", selector: ".second" },
      ],
      artifactsRoot: workspace,
      _openStagehand: shOpen,
    });
    expect(r.status).toBe("error");
    expect(r.error).toContain("step 0 (act)");
    expect(r.steps[0]!.status).toBe("error");
    expect(r.steps[0]!.error).toContain("element not found");
    expect(r.steps[1]!.status).toBe("skipped");
  });

  it("explicit engine override bypasses pickEngine", async () => {
    const { open, actCalls } = fakeOpenStagehand({});
    const r = await act({
      url: "https://x/",
      steps: [{ type: "click", selector: "a" }],
      artifactsRoot: workspace,
      engine: "stagehand",
      _openStagehand: open,
    });
    expect(r.engine).toBe("stagehand");
    expect(actCalls).toEqual([]); // no act step
  });
});

// ─────────────────────────────────────────────────────────────
// Error semantics
// ─────────────────────────────────────────────────────────────

describe("act — error semantics", () => {
  it("stop_on_error=true (default): subsequent steps are skipped, status='error'", async () => {
    const { open } = fakeOpen({ errorSelectors: ["#bad"] });
    const r = await act({
      url: "https://x/",
      steps: [
        { type: "click", selector: "#first" },
        { type: "click", selector: "#bad" },
        { type: "click", selector: "#third" },
      ],
      artifactsRoot: workspace,
      _open: open,
    });
    expect(r.status).toBe("error");
    expect(r.error).toContain("step 1 (click)");
    expect(r.steps.map((s) => s.status)).toEqual(["ok", "error", "skipped"]);
  });

  it("stop_on_error=false: all steps run, status='error' if any failed", async () => {
    const { open } = fakeOpen({ errorSelectors: ["#bad"] });
    const r = await act({
      url: "https://x/",
      steps: [
        { type: "click", selector: "#first" },
        { type: "click", selector: "#bad" },
        { type: "click", selector: "#third" },
      ],
      artifactsRoot: workspace,
      stopOnError: false,
      _open: open,
    });
    expect(r.status).toBe("error");
    expect(r.steps.map((s) => s.status)).toEqual(["ok", "error", "ok"]);
  });

  it("captures open() failure into top-level status='error', steps=[]", async () => {
    const { open } = fakeOpen({ openError: new Error("net::ERR_NAME_NOT_RESOLVED") });
    const r = await act({
      url: "https://broken/",
      steps: [{ type: "click", selector: "x" }],
      artifactsRoot: workspace,
      _open: open,
    });
    expect(r.status).toBe("error");
    expect(r.error).toContain("ERR_NAME_NOT_RESOLVED");
    expect(r.steps).toEqual([]);
    expect(r.dom).toBeNull();
    expect(r.screenshot).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// Artifacts directory
// ─────────────────────────────────────────────────────────────

describe("act — artifacts directory", () => {
  it("creates a unique subdir per call", async () => {
    const a = await act({
      url: "https://x/",
      steps: [],
      artifactsRoot: workspace,
      _open: fakeOpen({}).open,
    });
    const b = await act({
      url: "https://x/",
      steps: [],
      artifactsRoot: workspace,
      _open: fakeOpen({}).open,
    });
    expect(a.artifacts_dir).not.toBe(b.artifacts_dir);
    expect(fs.existsSync(a.artifacts_dir)).toBe(true);
    expect(fs.existsSync(b.artifacts_dir)).toBe(true);
  });

  it("honors AUDIT_ACTS_DIR env override via defaultArtifactsRoot", () => {
    const prev = process.env.AUDIT_ACTS_DIR;
    try {
      process.env.AUDIT_ACTS_DIR = "/tmp/test-acts-override";
      expect(defaultArtifactsRoot()).toBe("/tmp/test-acts-override");
    } finally {
      if (prev === undefined) delete process.env.AUDIT_ACTS_DIR;
      else process.env.AUDIT_ACTS_DIR = prev;
    }
  });

  it("falls back to ~/.pixelcheck/acts when no env override is set", () => {
    const prev = process.env.AUDIT_ACTS_DIR;
    const prevHome = process.env.PIXELCHECK_HOME;
    const prevLegacyHome = process.env.AUDIT_HOME;
    try {
      delete process.env.AUDIT_ACTS_DIR;
      delete process.env.PIXELCHECK_HOME;
      delete process.env.AUDIT_HOME;
      const root = defaultArtifactsRoot();
      expect(root.endsWith(path.join(".pixelcheck", "acts"))).toBe(true);
    } finally {
      if (prev !== undefined) process.env.AUDIT_ACTS_DIR = prev;
      if (prevHome !== undefined) process.env.PIXELCHECK_HOME = prevHome;
      if (prevLegacyHome !== undefined) process.env.AUDIT_HOME = prevLegacyHome;
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Integration test — real Chromium + fixture site
// ─────────────────────────────────────────────────────────────

describe("act — integration (real Chromium + fixture site)", () => {
  let fixture: FixtureServer;
  let intWorkspace: string;
  let warmBrowser: Browser | null = null;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    intWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "act-int-"));
    try {
      warmBrowser = await chromium.launch({ headless: true });
    } catch {
      warmBrowser = null;
    }
  }, 60_000);

  afterAll(async () => {
    await warmBrowser?.close().catch(() => {});
    await fixture?.close().catch(() => {});
    try {
      fs.rmSync(intWorkspace, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("runs a multi-step sequence on the fixture site (fill + screenshot + scroll)", async () => {
    if (!warmBrowser) {
      // Skip when Chromium isn't installed.
      return;
    }
    const opts: ActOptions = {
      url: `${fixture.url}/index.html`,
      steps: [
        { type: "fill", selector: "#email", value: "user@example.com" },
        { type: "screenshot", label: "after-fill" },
        { type: "scroll", to_bottom: true },
      ],
      artifactsRoot: intWorkspace,
      waitFor: "domcontentloaded",
      timeoutMs: 15000,
    };
    const r = await act(opts);
    expect(r.status).toBe("ok");
    expect(r.engine).toBe("playwright");
    expect(r.steps.map((s) => s.status)).toEqual(["ok", "ok", "ok"]);
    expect(r.steps[1]!.screenshot).toBeDefined();
    expect(fs.existsSync(r.steps[1]!.screenshot!.path)).toBe(true);
    expect(fs.statSync(r.steps[1]!.screenshot!.path).size).toBeGreaterThan(100);
    expect(r.dom).not.toBeNull();
    expect(r.dom!.interactive_count).toBeGreaterThan(0);
    expect(r.screenshot).not.toBeNull();
  }, 30_000);
});

/**
 * Tests for the `see` primitive (N-1).
 *
 * Two layers:
 *   1. Unit tests with the `_open` test seam — fast, no real browser. Verify
 *      schema field plumbing, error path, dom/console/screenshot toggles,
 *      persona resolution, note-from-goal cost accounting.
 *   2. Integration test with real Chromium against the existing fixture site.
 *      This proves the default Playwright open path actually loads HTML and
 *      that DOM extraction sees real interactive elements.
 *
 * The note path is exercised via the `_callVision` test seam — we never spend
 * real LLM credits in CI.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";

import {
  see,
  defaultArtifactsRoot,
  DEFAULT_PERSONA_ID,
  DEFAULT_VIEWPORT,
  type OpenFn,
  type SeeOptions,
  type SeeResult,
} from "../../src/core/primitives/see.js";
import { startFixtureServer, type FixtureServer } from "../fixtures/test-site/server.js";
import type { ConsoleError } from "../../src/core/types.js";
import { RESULT_SCHEMA_VERSION } from "../../src/core/result-schema.js";

// ─────────────────────────────────────────────────────────────
// Test fakes
// ─────────────────────────────────────────────────────────────

/**
 * Build a fake `_open` that yields a Page-shaped stub. We only stub the
 * methods `see` actually calls: `url`, `title`, `screenshot`, `evaluate`.
 */
function fakeOpen(args: {
  finalUrl?: string;
  title?: string;
  png?: Buffer;
  consoleErrors?: ConsoleError[];
  domSummary?: { totalInteractive: number; elements: string; textContent: string };
  headings?: string[];
  navigateError?: Error;
}): OpenFn {
  return async () => {
    if (args.navigateError) throw args.navigateError;
    const png = args.png ?? makeTinyPng();
    const calls: { evaluate: number } = { evaluate: 0 };
    const evalImpls = [
      // First evaluate call: extractDomSummary's page.evaluate(({...}) => {...})
      () =>
        args.domSummary ?? {
          title: args.title ?? "fake",
          elements: "[Headings]\nh1: Hi\n\n[Interactive Elements] (3)\n<button>Go</button>",
          totalInteractive: 3,
          headings: "h1: Hi",
          textContent: "Hello world",
        },
      // Second evaluate call: extractHeadings — return an array
      () => args.headings ?? ["h1: Hi"],
    ];
    const page = {
      url: () => args.finalUrl ?? "https://example.com/",
      title: async () => args.title ?? "fake",
      screenshot: async () => png,
      evaluate: async () => {
        const impl = evalImpls[Math.min(calls.evaluate, evalImpls.length - 1)]!;
        calls.evaluate++;
        return impl();
      },
    } as unknown as import("playwright").Page;
    return {
      page,
      consoleErrors: args.consoleErrors ?? [],
      close: async () => {},
    };
  };
}

/** Smallest valid 1x1 PNG, ~70 bytes. */
function makeTinyPng(): Buffer {
  // 1x1 transparent PNG (precomputed).
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  );
}

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "see-test-"));
});

afterEach(() => {
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ─────────────────────────────────────────────────────────────
// Unit tests — `_open` seam, no real browser
// ─────────────────────────────────────────────────────────────

describe("see — schema field plumbing", () => {
  it("returns a schema-stamped result with all sections populated by default", async () => {
    const r = await see({
      url: "https://target.example/page",
      artifactsRoot: workspace,
      _open: fakeOpen({
        finalUrl: "https://target.example/page?after=redirect",
        title: "Hello",
        consoleErrors: [
          {
            type: "console",
            text: "an error",
            timestamp: "2026-04-29T00:00:00.000Z",
          },
        ],
      }),
    });

    expect(r.schema_version).toBe(RESULT_SCHEMA_VERSION);
    expect(r.url_input).toBe("https://target.example/page");
    expect(r.url_final).toBe("https://target.example/page?after=redirect");
    expect(r.title).toBe("Hello");
    expect(r.status).toBe("ok");
    expect(r.error).toBeUndefined();
    expect(r.persona_id).toBe(DEFAULT_PERSONA_ID);
    expect(r.cost_usd).toBe(0);
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
    expect(r.dom).not.toBeNull();
    expect(r.dom!.interactive_count).toBe(3);
    expect(r.dom!.headings).toEqual(["h1: Hi"]);
    expect(r.dom!.summary).toContain("[Headings]");
    expect(r.console).not.toBeNull();
    expect(r.console!.errors_count).toBe(1);
    expect(r.console!.errors[0]!.text).toBe("an error");
    expect(r.screenshot).not.toBeNull();
    expect(r.screenshot!.path).toContain(workspace);
    expect(fs.existsSync(r.screenshot!.path)).toBe(true);
    expect(fs.existsSync(`${r.screenshot!.path}.sha256`)).toBe(true);
    expect(r.note).toBeNull();
  });

  it("nullifies dom when includeDom is false; nullifies console when includeConsole is false", async () => {
    const r = await see({
      url: "https://x/",
      artifactsRoot: workspace,
      includeDom: false,
      includeConsole: false,
      _open: fakeOpen({}),
    });
    expect(r.dom).toBeNull();
    expect(r.console).toBeNull();
    // Screenshot is always taken — it is the cheapest, most useful artefact.
    expect(r.screenshot).not.toBeNull();
  });

  it("uses persona viewport / locale / timezone / id when provided", async () => {
    const r = await see({
      url: "https://x/",
      artifactsRoot: workspace,
      persona: {
        id: "uk-english-power-desktop",
        viewport: { width: 1920, height: 1080 },
        locale: "en-GB",
        timezone: "Europe/London",
      },
      _open: fakeOpen({}),
    });
    expect(r.persona_id).toBe("uk-english-power-desktop");
    expect(r.screenshot!.width).toBe(1920);
    expect(r.screenshot!.height).toBe(1080);
  });

  it("falls back to default viewport when neither persona nor opts.viewport is set", async () => {
    const r = await see({
      url: "https://x/",
      artifactsRoot: workspace,
      _open: fakeOpen({}),
    });
    expect(r.screenshot!.width).toBe(DEFAULT_VIEWPORT.width);
    expect(r.screenshot!.height).toBe(DEFAULT_VIEWPORT.height);
  });

  it("opts.viewport overrides persona viewport", async () => {
    const r = await see({
      url: "https://x/",
      artifactsRoot: workspace,
      persona: { id: "p", viewport: { width: 1920, height: 1080 } },
      viewport: { width: 800, height: 600 },
      _open: fakeOpen({}),
    });
    expect(r.screenshot!.width).toBe(800);
    expect(r.screenshot!.height).toBe(600);
  });
});

describe("see — error path", () => {
  it("captures navigation failures into status='error' without throwing", async () => {
    const r = await see({
      url: "https://broken.example/",
      artifactsRoot: workspace,
      _open: fakeOpen({ navigateError: new Error("net::ERR_NAME_NOT_RESOLVED") }),
    });
    expect(r.status).toBe("error");
    expect(r.error).toContain("ERR_NAME_NOT_RESOLVED");
    expect(r.dom).toBeNull();
    expect(r.console).toBeNull();
    expect(r.screenshot).toBeNull();
    expect(r.cost_usd).toBe(0);
  });
});

describe("see — note synthesis", () => {
  it("calls the vision stub when goal is set and accumulates cost_usd", async () => {
    const visionCalls: Array<{ userPrompt: string }> = [];
    const r = await see({
      url: "https://x/",
      goal: "Is there a Sign Up button visible?",
      artifactsRoot: workspace,
      _open: fakeOpen({}),
      _callVision: async (req) => {
        visionCalls.push({ userPrompt: req.userPrompt });
        return {
          text: "Yes, a centred 'Sign up' button under the email field.",
          inputTokens: 100,
          outputTokens: 30,
          costUsd: 0.0042,
        };
      },
    });
    expect(visionCalls).toHaveLength(1);
    expect(visionCalls[0]!.userPrompt).toBe("Is there a Sign Up button visible?");
    expect(r.note).toBe("Yes, a centred 'Sign up' button under the email field.");
    expect(r.cost_usd).toBeCloseTo(0.0042, 6);
  });

  it("does NOT invoke vision when goal is omitted (cost stays zero)", async () => {
    const visionCalls: number[] = [];
    const r = await see({
      url: "https://x/",
      artifactsRoot: workspace,
      _open: fakeOpen({}),
      _callVision: async () => {
        visionCalls.push(1);
        return {
          text: "should not be called",
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 999,
        };
      },
    });
    expect(visionCalls).toHaveLength(0);
    expect(r.note).toBeNull();
    expect(r.cost_usd).toBe(0);
  });

  it("swallows vision failure and returns empty note (cost stays zero)", async () => {
    const r = await see({
      url: "https://x/",
      goal: "Anything visible?",
      artifactsRoot: workspace,
      _open: fakeOpen({}),
      _callVision: async () => {
        throw new Error("ANTHROPIC_API_KEY not set");
      },
    });
    expect(r.note).toBe("");
    expect(r.cost_usd).toBe(0);
    expect(r.status).toBe("ok");
  });
});

describe("see — artifacts directory", () => {
  it("creates a unique subdir per call", async () => {
    const a = await see({ url: "https://x/", artifactsRoot: workspace, _open: fakeOpen({}) });
    const b = await see({ url: "https://x/", artifactsRoot: workspace, _open: fakeOpen({}) });
    expect(a.artifacts_dir).not.toBe(b.artifacts_dir);
    expect(fs.existsSync(a.artifacts_dir)).toBe(true);
    expect(fs.existsSync(b.artifacts_dir)).toBe(true);
  });

  it("honors AUDIT_SEES_DIR env override via defaultArtifactsRoot", () => {
    const prev = process.env.AUDIT_SEES_DIR;
    try {
      process.env.AUDIT_SEES_DIR = "/tmp/test-sees-override";
      expect(defaultArtifactsRoot()).toBe("/tmp/test-sees-override");
    } finally {
      if (prev === undefined) delete process.env.AUDIT_SEES_DIR;
      else process.env.AUDIT_SEES_DIR = prev;
    }
  });

  it("falls back to ~/.pixelcheck/sees when no env override is set", () => {
    const prev = process.env.AUDIT_SEES_DIR;
    const prevHome = process.env.PIXELCHECK_HOME;
    const prevLegacyHome = process.env.AUDIT_HOME;
    try {
      delete process.env.AUDIT_SEES_DIR;
      delete process.env.PIXELCHECK_HOME;
      delete process.env.AUDIT_HOME;
      const root = defaultArtifactsRoot();
      expect(root.endsWith(path.join(".pixelcheck", "sees"))).toBe(true);
    } finally {
      if (prev !== undefined) process.env.AUDIT_SEES_DIR = prev;
      if (prevHome !== undefined) process.env.PIXELCHECK_HOME = prevHome;
      if (prevLegacyHome !== undefined) process.env.AUDIT_HOME = prevLegacyHome;
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Integration test — real Chromium + fixture server
// ─────────────────────────────────────────────────────────────

describe("see — integration (real Chromium + fixture site)", () => {
  let fixture: FixtureServer;
  let intWorkspace: string;
  let warmBrowser: Browser | null = null;
  let warmCtx: BrowserContext | null = null;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    intWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "see-int-"));
    // Warm a browser to reduce per-test startup cost when we run multiple
    // assertions; each test still uses see's default open path though, so
    // the warm browser is unused except as a sanity probe that Chromium is
    // installed in this environment.
    try {
      warmBrowser = await chromium.launch({ headless: true });
      warmCtx = await warmBrowser.newContext();
    } catch {
      warmBrowser = null;
      warmCtx = null;
    }
  }, 60_000);

  afterAll(async () => {
    await warmCtx?.close().catch(() => {});
    await warmBrowser?.close().catch(() => {});
    await fixture?.close().catch(() => {});
    try {
      fs.rmSync(intWorkspace, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("loads a real fixture page, captures DOM + screenshot, no critic note", async () => {
    if (!warmBrowser) {
      // Skip when Chromium isn't installed (e.g. minimal CI).
      return;
    }
    const r: SeeResult = await see({
      url: `${fixture.url}/index.html`,
      artifactsRoot: intWorkspace,
      waitFor: "domcontentloaded",
      timeoutMs: 15000,
    });
    expect(r.status).toBe("ok");
    expect(r.url_final).toContain("index.html");
    expect(r.title).toBe("AV Fixture — Home");
    expect(r.dom).not.toBeNull();
    expect(r.dom!.interactive_count).toBeGreaterThan(0);
    // Real fixture has a "AV Fixture Site" h1 plus h2 cards.
    expect(r.dom!.headings.some((h) => h.includes("AV Fixture Site"))).toBe(true);
    expect(r.screenshot).not.toBeNull();
    expect(fs.statSync(r.screenshot!.path).size).toBeGreaterThan(100);
    expect(r.note).toBeNull();
    expect(r.cost_usd).toBe(0);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────
// PR-D / ADR-034 — visualScoring wiring (no real LLM)
// ─────────────────────────────────────────────────────────────

describe("see — visualScoring (PR-D)", () => {
  it("does not emit diagnostics.visual when visualScoring is omitted (default 'off')", async () => {
    const r = await see({
      url: "https://target.example/page",
      artifactsRoot: workspace,
      _open: fakeOpen({}),
    });
    expect(r.diagnostics).toBeUndefined();
  });

  it("emits a config_off skip envelope when visualScoring='off' explicitly", async () => {
    const r = await see({
      url: "https://target.example/page",
      artifactsRoot: workspace,
      visualScoring: "off",
      _open: fakeOpen({}),
    });
    expect(r.diagnostics).toBeUndefined();
  });

  it("emits a no_goal skip envelope when visualScoring='auto' but no goal supplied", async () => {
    const r = await see({
      url: "https://target.example/page",
      artifactsRoot: workspace,
      visualScoring: "auto",
      _open: fakeOpen({}),
    });
    expect(r.diagnostics).toBeDefined();
    expect(r.diagnostics?.visual).toBeDefined();
    expect(r.diagnostics?.visual?.scored).toBe(false);
    expect(r.diagnostics?.visual?.skip_reason).toBe("no_goal");
  });

  it("invokes the vision call when visualScoring='auto' AND goal is supplied", async () => {
    let visionCalls = 0;
    const r = await see({
      url: "https://target.example/page",
      goal: "is this page accessible?",
      artifactsRoot: workspace,
      visualScoring: "auto",
      _open: fakeOpen({}),
      _callVision: async () => {
        visionCalls++;
        return {
          model: "stub",
          text: JSON.stringify({
            verdicts: [
              {
                criterion_id: "visual_hierarchy",
                score: 7,
                rationale: "OK.",
                evidence: [],
              },
            ],
            findings: [],
            summary: null,
          }),
          costUsd: 0.01,
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    });
    // 2 vision calls expected: one for the `goal` note synthesis, one for visual scoring.
    expect(visionCalls).toBe(2);
    expect(r.diagnostics?.visual?.scored).toBe(true);
    expect(r.diagnostics?.visual?.verdicts).toHaveLength(1);
    expect(r.diagnostics?.visual?.verdicts[0]?.criterion_id).toBe("visual_hierarchy");
    // cost_usd accumulates note + visual cost
    expect(r.cost_usd).toBeGreaterThan(0.01);
  });

  it("invokes the vision call unconditionally when visualScoring='eager'", async () => {
    let visionCalls = 0;
    const r = await see({
      url: "https://target.example/page",
      // no goal
      artifactsRoot: workspace,
      visualScoring: "eager",
      _open: fakeOpen({}),
      _callVision: async () => {
        visionCalls++;
        return {
          model: "stub",
          text: JSON.stringify({
            verdicts: [
              {
                criterion_id: "visual_hierarchy",
                score: 9,
                rationale: "Strong.",
                evidence: [],
              },
            ],
            findings: [],
            summary: "Eager-mode test.",
          }),
          costUsd: 0.008,
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    });
    expect(visionCalls).toBe(1);
    expect(r.diagnostics?.visual?.scored).toBe(true);
    expect(r.diagnostics?.visual?.summary).toBe("Eager-mode test.");
    expect(r.cost_usd).toBe(0.008);
  });

  it("emits vision_error envelope (and stays status='ok') when visual scoring throws", async () => {
    const r = await see({
      url: "https://target.example/page",
      artifactsRoot: workspace,
      visualScoring: "eager",
      _open: fakeOpen({}),
      _callVision: async () => {
        throw new Error("upstream-503");
      },
    });
    // Visual failure must not contaminate the host primitive's status.
    expect(r.status).toBe("ok");
    expect(r.diagnostics?.visual?.scored).toBe(false);
    expect(r.diagnostics?.visual?.skip_reason).toBe("vision_error");
  });
});

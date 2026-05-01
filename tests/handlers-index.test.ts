/**
 * Tests for src/handlers/index.ts (T15 — closes R11 partial).
 *
 * The 804-LoC dispatcher exposes `executeStep` and routes 12 step types
 * to per-handler functions. Coverage strategy:
 *
 *   - Mock Stagehand / Recorder / Critic / Computer-Use / Mutations /
 *     waitForPageStable / email at module level
 *   - Build a minimal `StepContext` with stubs for the Playwright Page
 *   - Drive each handler through its happy + main error paths
 *   - Cover the executeStep retry / failure-screenshot / dispatch path
 *
 * Coverage target: ≥ 80% stmt for src/handlers/index.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Step, StepResult, Persona, Scenario } from "../src/core/types.js";

// ─────────────────────────────────────────────────────────────
// Module-level mocks
// ─────────────────────────────────────────────────────────────

const mockRunCritic = vi.fn();
const mockRunComputerUseTask = vi.fn();
const mockGenerateMutations = vi.fn();
const mockAutoDiscoverSelectors = vi.fn();
const mockWaitForPageStable = vi.fn(async () => undefined);
const mockWaitForMessage = vi.fn();
const mockDiffAgainstBaseline = vi.fn();

vi.mock("../src/core/critic.js", () => ({
  runCritic: (...args: unknown[]) => mockRunCritic(...args),
}));

vi.mock("../src/core/computer-use.js", () => ({
  runComputerUseTask: (...args: unknown[]) => mockRunComputerUseTask(...args),
}));

vi.mock("../src/core/instruction-mutator.js", () => ({
  generateMutations: (...args: unknown[]) => mockGenerateMutations(...args),
  autoDiscoverSelectors: (...args: unknown[]) => mockAutoDiscoverSelectors(...args),
}));

vi.mock("../src/core/page-stability.js", () => ({
  waitForPageStable: (...args: unknown[]) => mockWaitForPageStable(...args),
}));

vi.mock("../src/core/email.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/core/email.js")>(
      "../src/core/email.js",
    );
  return {
    ...actual,
    waitForMessage: (...args: unknown[]) => mockWaitForMessage(...args),
  };
});

vi.mock("../src/core/visual-diff.js", () => ({
  diffAgainstBaseline: (...args: unknown[]) => mockDiffAgainstBaseline(...args),
}));

import { executeStep, type StepContext } from "../src/handlers/index.js";

// ─────────────────────────────────────────────────────────────
// Test fixtures + stubs
// ─────────────────────────────────────────────────────────────

interface MockLocator {
  first: () => MockLocator;
  isVisible: () => Promise<boolean>;
  textContent: () => Promise<string | null>;
  count: () => Promise<number>;
  click: () => Promise<void>;
  waitFor: (opts?: unknown) => Promise<void>;
}

function makeLocator(opts: Partial<{
  visible: boolean;
  text: string | null;
  count: number;
  clickThrows: Error;
  waitForThrows: Error;
}> = {}): MockLocator {
  return {
    first() { return this; },
    isVisible: vi.fn(async () => opts.visible ?? true),
    textContent: vi.fn(async () => opts.text ?? "default text"),
    count: vi.fn(async () => opts.count ?? 1),
    click: vi.fn(async () => {
      if (opts.clickThrows) throw opts.clickThrows;
    }),
    waitFor: vi.fn(async () => {
      if (opts.waitForThrows) throw opts.waitForThrows;
    }),
  };
}

interface PageStub {
  url: () => string;
  goto: ReturnType<typeof vi.fn>;
  waitForTimeout: ReturnType<typeof vi.fn>;
  locator: ReturnType<typeof vi.fn>;
  getByText: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
  addScriptTag: ReturnType<typeof vi.fn>;
  viewportSize: () => { width: number; height: number } | null;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
}

function makePage(overrides: Partial<PageStub> = {}): PageStub {
  return {
    url: () => "https://example.com",
    goto: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined),
    locator: vi.fn(() => makeLocator()),
    getByText: vi.fn(() => makeLocator()),
    evaluate: vi.fn(async () => false),
    addScriptTag: vi.fn(async () => undefined),
    viewportSize: () => ({ width: 1280, height: 800 }),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  };
}

interface StagehandStub {
  act: ReturnType<typeof vi.fn>;
  extract: ReturnType<typeof vi.fn>;
  observe: ReturnType<typeof vi.fn>;
}

function makeStagehand(overrides: Partial<StagehandStub> = {}): StagehandStub {
  return {
    act: vi.fn(async () => ({ ok: true })),
    extract: vi.fn(async () => ({ data: "extracted" })),
    observe: vi.fn(async () => [{ description: "button", selector: "button.cta" }]),
    ...overrides,
  };
}

function makeRecorder() {
  return {
    screenshot: vi.fn(async (label: string) => ({
      filepath: `/tmp/${label}.png`,
      sha256: "abc123",
    })),
    screenshotSegments: vi.fn(async (label: string) => ({
      full: { filepath: `/tmp/${label}.png`, sha256: "abc" },
      thumbnail: Buffer.from([1, 2, 3]),
      segments: [Buffer.from([4, 5])],
    })),
    drainConsoleErrors: vi.fn(() => []),
  };
}

function mkPersona(): Persona {
  return {
    id: "p1",
    display_name: "P1",
    country: "US",
    language: "en",
    locale: "en-US",
    timezone: "UTC",
    device_class: "desktop",
    payment_tier: "free",
    mental_model: "",
    motivation: "",
    success_criteria: "",
  } as Persona;
}

function mkScenario(): Scenario {
  return { id: "s1", name: "S1", steps: [] } as Scenario;
}

function makeCtx(overrides: Partial<StepContext> = {}): StepContext {
  const page = makePage();
  const stagehand = makeStagehand();
  const recorder = makeRecorder();
  return {
    page: page as unknown as StepContext["page"],
    stagehand: stagehand as unknown as StepContext["stagehand"],
    recorder: recorder as unknown as StepContext["recorder"],
    persona: mkPersona(),
    scenario: mkScenario(),
    models: {
      default: "claude-sonnet-4-6",
      critic: "claude-sonnet-4-6",
      computerUse: "claude-opus-4-6",
    },
    store: {},
    criticResults: [],
    cost: { value: 0 },
    stripeSecrets: {},
    diffResults: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockRunCritic.mockReset();
  mockRunComputerUseTask.mockReset();
  mockGenerateMutations.mockReset();
  mockAutoDiscoverSelectors.mockReset();
  mockWaitForPageStable.mockReset();
  mockWaitForPageStable.mockResolvedValue(undefined);
  mockWaitForMessage.mockReset();
  mockDiffAgainstBaseline.mockReset();
});

// ─────────────────────────────────────────────────────────────
// executeStep — top-level dispatch + retry + error path
// ─────────────────────────────────────────────────────────────

describe("executeStep — orchestration", () => {
  it("returns a StepResult with timing + retries on success", async () => {
    const ctx = makeCtx();
    const step = {
      id: "s1",
      type: "visit",
      url: "https://example.com",
      retry: 0,
    } as Step;
    const result = await executeStep(step, ctx);
    expect(result.step_id).toBe("s1");
    expect(result.step_type).toBe("visit");
    expect(result.status).toBe("pass");
    expect(typeof result.duration_ms).toBe("number");
    expect(result.retries_used).toBe(0);
  });

  it("captures console errors via recorder.drainConsoleErrors", async () => {
    const ctx = makeCtx();
    (ctx.recorder.drainConsoleErrors as ReturnType<typeof vi.fn>).mockReturnValueOnce([
      { source: "console", text: "TypeError" },
    ]);
    const result = await executeStep(
      { id: "s1", type: "visit", url: "https://x", retry: 0 } as Step,
      ctx,
    );
    expect(result.console_errors?.length).toBe(1);
  });

  it("returns status=fail when a critical step fails", async () => {
    const ctx = makeCtx();
    (ctx.page.goto as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DNS fail"));
    const result = await executeStep(
      { id: "s1", type: "visit", url: "https://x", retry: 0, critical: true } as Step,
      ctx,
    );
    expect(result.status).toBe("fail");
    expect(result.error).toContain("DNS fail");
  });

  it("returns status=warn when a non-critical step fails", async () => {
    const ctx = makeCtx();
    (ctx.page.goto as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("nope"));
    const result = await executeStep(
      { id: "s1", type: "visit", url: "https://x", retry: 0 } as Step,
      ctx,
    );
    expect(result.status).toBe("warn");
  });

  it("captures a failure screenshot via recorder when an error occurs", async () => {
    const ctx = makeCtx();
    (ctx.page.goto as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const result = await executeStep(
      { id: "s1", type: "visit", url: "https://x", retry: 0, critical: true } as Step,
      ctx,
    );
    expect(ctx.recorder.screenshot).toHaveBeenCalledWith("s1-FAIL");
    expect(result.screenshot).toBe("/tmp/s1-FAIL.png");
  });

  it("retries the configured number of times before giving up", async () => {
    const ctx = makeCtx();
    let calls = 0;
    (ctx.page.goto as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls++;
      throw new Error("transient");
    });
    await executeStep(
      { id: "s1", type: "visit", url: "https://x", retry: 2, critical: false } as Step,
      ctx,
    );
    expect(calls).toBe(3); // 1 initial + 2 retries
  });
});

// ─────────────────────────────────────────────────────────────
// handleVisit
// ─────────────────────────────────────────────────────────────

describe("handleVisit", () => {
  it("calls page.goto with the resolved URL", async () => {
    const ctx = makeCtx();
    await executeStep(
      { id: "s1", type: "visit", url: "https://x.test/path", retry: 0, wait_until: "networkidle" } as Step,
      ctx,
    );
    expect(ctx.page.goto).toHaveBeenCalledWith(
      "https://x.test/path",
      expect.objectContaining({ waitUntil: "networkidle" }),
    );
  });

  it("substitutes template values from persona / store / env", async () => {
    const ctx = makeCtx({ store: { tag: "checkout" } });
    await executeStep(
      { id: "s1", type: "visit", url: "https://x.test/${store.tag}", retry: 0 } as Step,
      ctx,
    );
    expect(ctx.page.goto).toHaveBeenCalledWith(
      "https://x.test/checkout",
      expect.anything(),
    );
  });
});

// ─────────────────────────────────────────────────────────────
// handleAct — 4-layer fallback chain
// ─────────────────────────────────────────────────────────────

describe("handleAct — 4-layer fallback", () => {
  it("Layer 2 happy path: stagehand.act succeeds", async () => {
    const ctx = makeCtx();
    const result = await executeStep(
      {
        id: "s1",
        type: "act",
        instruction: "click checkout",
        retry: 0,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("pass");
    expect(result.execution_method).toBe("stagehand");
    expect(ctx.stagehand.act).toHaveBeenCalled();
  });

  it("Layer 3a selector_hint: stagehand fails, hint click succeeds", async () => {
    const ctx = makeCtx();
    (ctx.stagehand.act as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("stagehand failed"));
    const goodLocator = makeLocator({ visible: true });
    (ctx.page.locator as ReturnType<typeof vi.fn>).mockReturnValueOnce(goodLocator);
    const result = await executeStep(
      {
        id: "s1",
        type: "act",
        instruction: "click checkout",
        selector_hint: "button.checkout",
        retry: 0,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("pass");
    expect(result.execution_method).toBe("selector_hint");
  });

  it("Layer 3b instruction_mutation: stagehand+hint fail, mutation succeeds", async () => {
    const ctx = makeCtx();
    const stagehandAct = ctx.stagehand.act as ReturnType<typeof vi.fn>;
    stagehandAct.mockRejectedValueOnce(new Error("stagehand 1 fail"));
    stagehandAct.mockResolvedValueOnce({ ok: true });
    mockGenerateMutations.mockResolvedValueOnce([
      { type: "rephrase", instructions: ["click the checkout button"] },
    ]);
    const result = await executeStep(
      {
        id: "s1",
        type: "act",
        instruction: "click checkout",
        retry: 0,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("pass");
    expect(result.execution_method).toBe("instruction_mutation");
  });

  it("Layer 3c auto_selector: stagehand+mutations fail, observe-derived selector succeeds", async () => {
    const ctx = makeCtx();
    const stagehandAct = ctx.stagehand.act as ReturnType<typeof vi.fn>;
    stagehandAct.mockRejectedValue(new Error("stagehand fail"));
    mockGenerateMutations.mockResolvedValueOnce([]);
    mockAutoDiscoverSelectors.mockResolvedValueOnce(["a.cta"]);
    const goodLocator = makeLocator({ visible: true });
    (ctx.page.locator as ReturnType<typeof vi.fn>).mockReturnValue(goodLocator);
    const result = await executeStep(
      {
        id: "s1",
        type: "act",
        instruction: "click cta",
        retry: 0,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("pass");
    expect(result.execution_method).toBe("selector_hint");
  });

  it("Layer 4 computer_use: all earlier layers fail, computer-use succeeds", async () => {
    const ctx = makeCtx();
    (ctx.stagehand.act as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("stagehand fail"));
    mockGenerateMutations.mockResolvedValueOnce([]);
    mockAutoDiscoverSelectors.mockResolvedValueOnce([]);
    mockRunComputerUseTask.mockResolvedValueOnce({
      finalText: "done",
      iterations: 2,
      costUsd: 0.05,
      history: [],
    });
    const result = await executeStep(
      {
        id: "s1",
        type: "act",
        instruction: "click checkout",
        retry: 0,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("pass");
    expect(result.execution_method).toBe("computer_use");
    expect(ctx.cost.value).toBeCloseTo(0.05);
  });

  it("Layer 4 fallback=skip returns status=skip when all layers fail", async () => {
    const ctx = makeCtx();
    (ctx.stagehand.act as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fail"));
    mockGenerateMutations.mockResolvedValueOnce([]);
    mockAutoDiscoverSelectors.mockResolvedValueOnce([]);
    const result = await executeStep(
      {
        id: "s1",
        type: "act",
        instruction: "click x",
        fallback: "skip",
        retry: 0,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("skip");
  });

  it("Layer 4 fallback=fail propagates the error", async () => {
    const ctx = makeCtx();
    (ctx.stagehand.act as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("act fail"));
    mockGenerateMutations.mockResolvedValueOnce([]);
    mockAutoDiscoverSelectors.mockResolvedValueOnce([]);
    const result = await executeStep(
      {
        id: "s1",
        type: "act",
        instruction: "click x",
        fallback: "fail",
        retry: 0,
        critical: true,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("fail");
  });

  it("uses Opus + 8 iterations for critical_review steps", async () => {
    const ctx = makeCtx();
    (ctx.stagehand.act as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fail"));
    mockGenerateMutations.mockResolvedValueOnce([]);
    mockAutoDiscoverSelectors.mockResolvedValueOnce([]);
    mockRunComputerUseTask.mockResolvedValueOnce({
      finalText: "done",
      iterations: 1,
      costUsd: 0.1,
      history: [],
    });
    await executeStep(
      {
        id: "s1",
        type: "act",
        instruction: "x",
        critical_review: true,
        retry: 0,
      } as Step,
      ctx,
    );
    const args = mockRunComputerUseTask.mock.calls[0][0] as {
      model: string;
      maxIterations: number;
    };
    expect(args.model).toBe("claude-opus-4-6");
    expect(args.maxIterations).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────
// handleExtract / handleObserve
// ─────────────────────────────────────────────────────────────

describe("handleExtract", () => {
  it("calls stagehand.extract and stores the result via store_as", async () => {
    const ctx = makeCtx();
    (ctx.stagehand.extract as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ price: 99 });
    await executeStep(
      {
        id: "s1",
        type: "extract",
        instruction: "get price",
        schema: { type: "object" },
        store_as: "pricing",
        retry: 0,
      } as Step,
      ctx,
    );
    expect(ctx.store.pricing).toEqual({ price: 99 });
  });
});

describe("handleObserve", () => {
  it("calls stagehand.observe and stores observations via store_as", async () => {
    const ctx = makeCtx();
    (ctx.stagehand.observe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { selector: "a", description: "link" },
    ]);
    await executeStep(
      {
        id: "s1",
        type: "observe",
        instruction: "find ctas",
        store_as: "ctas",
        retry: 0,
      } as Step,
      ctx,
    );
    expect((ctx.store.ctas as unknown[]).length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// handleWaitFor
// ─────────────────────────────────────────────────────────────

describe("handleWaitFor", () => {
  it("waits on a selector when provided", async () => {
    const ctx = makeCtx();
    const result = await executeStep(
      { id: "s1", type: "wait_for", selector: "h1", retry: 0 } as Step,
      ctx,
    );
    expect(result.status).toBe("pass");
    expect(ctx.page.locator).toHaveBeenCalledWith("h1");
  });

  it("waits on text when provided", async () => {
    const ctx = makeCtx();
    const result = await executeStep(
      { id: "s1", type: "wait_for", text: "Welcome", retry: 0 } as Step,
      ctx,
    );
    expect(result.status).toBe("pass");
    expect(ctx.page.getByText).toHaveBeenCalledWith(
      "Welcome",
      expect.anything(),
    );
  });

  it("waits on ms when provided", async () => {
    const ctx = makeCtx();
    const result = await executeStep(
      { id: "s1", type: "wait_for", ms: 100, retry: 0 } as Step,
      ctx,
    );
    expect(result.status).toBe("pass");
    expect(ctx.page.waitForTimeout).toHaveBeenCalledWith(100);
  });

  it("throws when no selector / text / ms provided", async () => {
    const ctx = makeCtx();
    const result = await executeStep(
      { id: "s1", type: "wait_for", retry: 0, critical: true } as Step,
      ctx,
    );
    expect(result.status).toBe("fail");
    expect(result.error).toContain("requires selector, text, or ms");
  });
});

// ─────────────────────────────────────────────────────────────
// handleAssertVisual + critic + computer-use escalation
// ─────────────────────────────────────────────────────────────

describe("handleAssertVisual", () => {
  it("calls runCritic and accumulates result + cost", async () => {
    const ctx = makeCtx();
    mockRunCritic.mockResolvedValueOnce({
      verdict: { scores: [], issues: [] },
      scores: [{ dimension: "polish", score: 9, justification: "ok" }],
      issues: [],
      costUsd: 0.02,
      raw: { text: "", inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });
    const result = await executeStep(
      {
        id: "v1",
        type: "assert_visual",
        instruction: "check layout",
        retry: 0,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("pass");
    expect(ctx.criticResults).toHaveLength(1);
    expect(ctx.cost.value).toBeCloseTo(0.02);
  });

  it("returns status=warn when minScore < 7", async () => {
    const ctx = makeCtx();
    mockRunCritic.mockResolvedValueOnce({
      verdict: { scores: [], issues: [] },
      scores: [{ dimension: "polish", score: 5.5, justification: "" }],
      issues: [],
      costUsd: 0,
      raw: { text: "", inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });
    const result = await executeStep(
      {
        id: "v1",
        type: "assert_visual",
        instruction: "x",
        retry: 0,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("warn");
  });

  it("returns status=fail when minScore < 4 or critical issue", async () => {
    const ctx = makeCtx();
    mockRunCritic.mockResolvedValueOnce({
      verdict: { scores: [], issues: [] },
      scores: [{ dimension: "polish", score: 9, justification: "" }],
      issues: [
        { severity: "critical", description: "broken layout", recommendation: "fix" },
      ],
      costUsd: 0,
      raw: { text: "", inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });
    const result = await executeStep(
      {
        id: "v1",
        type: "assert_visual",
        instruction: "x",
        retry: 0,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("fail");
  });

  it("escalates to computer-use when critical_review + low score", async () => {
    const ctx = makeCtx();
    mockRunCritic.mockResolvedValueOnce({
      verdict: { scores: [], issues: [] },
      scores: [{ dimension: "polish", score: 6, justification: "" }],
      issues: [],
      costUsd: 0,
      raw: { text: "", inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });
    mockRunComputerUseTask.mockResolvedValueOnce({
      finalText: "looks ok",
      iterations: 1,
      costUsd: 0.04,
      history: [],
    });
    const result = await executeStep(
      {
        id: "v1",
        type: "assert_visual",
        instruction: "x",
        critical_review: true,
        retry: 0,
      } as Step,
      ctx,
    );
    expect(mockRunComputerUseTask).toHaveBeenCalled();
    expect(ctx.cost.value).toBeCloseTo(0.04);
    expect((result.output as { escalated_to_computer_use: boolean }).escalated_to_computer_use).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// handleAssertDom — visible / text / count
// ─────────────────────────────────────────────────────────────

describe("handleAssertDom", () => {
  it("passes when expected.visible matches", async () => {
    const ctx = makeCtx();
    (ctx.page.locator as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      makeLocator({ visible: true }),
    );
    const result = await executeStep(
      {
        id: "d1",
        type: "assert_dom",
        selector: "h1",
        expected: { visible: true },
        retry: 0,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("pass");
  });

  it("fails when expected.visible mismatches", async () => {
    const ctx = makeCtx();
    (ctx.page.locator as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      makeLocator({ visible: false }),
    );
    const result = await executeStep(
      {
        id: "d1",
        type: "assert_dom",
        selector: "h1",
        expected: { visible: true },
        retry: 0,
        critical: true,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("fail");
    expect(result.error).toContain("visible=true");
  });

  it("passes when expected.text_contains is satisfied", async () => {
    const ctx = makeCtx();
    (ctx.page.locator as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      makeLocator({ text: "Welcome to the app" }),
    );
    const result = await executeStep(
      {
        id: "d1",
        type: "assert_dom",
        selector: "h1",
        expected: { text_contains: "Welcome" },
        retry: 0,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("pass");
  });

  it("fails when expected.text_contains is not satisfied", async () => {
    const ctx = makeCtx();
    (ctx.page.locator as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      makeLocator({ text: "Bye" }),
    );
    const result = await executeStep(
      {
        id: "d1",
        type: "assert_dom",
        selector: "h1",
        expected: { text_contains: "Welcome" },
        retry: 0,
        critical: true,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("fail");
  });

  it("passes when expected.count matches", async () => {
    const ctx = makeCtx();
    (ctx.page.locator as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      makeLocator({ count: 3 }),
    );
    const result = await executeStep(
      {
        id: "d1",
        type: "assert_dom",
        selector: "li",
        expected: { count: 3 },
        retry: 0,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("pass");
  });
});

// ─────────────────────────────────────────────────────────────
// handleAssertA11y — axe-core pathway
// ─────────────────────────────────────────────────────────────

describe("handleAssertA11y", () => {
  it("returns warn when axe-core injection fails (non-critical)", async () => {
    const ctx = makeCtx();
    (ctx.page.evaluate as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false); // already injected check
    (ctx.page.evaluate as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("axe failed to load"),
    );
    const result = await executeStep(
      {
        id: "a1",
        type: "assert_a11y",
        retry: 0,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("warn");
    expect((result.output as { error: string }).error).toContain("axe-core failed");
  });

  it("returns pass with no violations", async () => {
    const ctx = makeCtx();
    (ctx.page.evaluate as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(false) // already-injected check
      .mockResolvedValueOnce({
        violations: [],
        passes: [{ id: "p1" }, { id: "p2" }],
        incomplete: [],
      });
    const result = await executeStep(
      {
        id: "a1",
        type: "assert_a11y",
        retry: 0,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("pass");
    expect((result.output as { total_violations: number }).total_violations).toBe(0);
  });

  it("returns fail with critical violations and pushes a critic result", async () => {
    const ctx = makeCtx();
    (ctx.page.evaluate as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce({
        violations: [
          {
            id: "color-contrast",
            impact: "critical",
            description: "Insufficient color contrast",
            help: "Improve contrast",
            helpUrl: "https://dequeuniversity.com/rules/axe/color-contrast",
            tags: ["wcag2aa", "wcag143"],
            nodes: [{ html: "<p></p>", target: ["p"], failureSummary: "" }],
          },
        ],
        passes: [],
        incomplete: [],
      });
    const result = await executeStep(
      {
        id: "a1",
        type: "assert_a11y",
        standard: "wcag2aa",
        retry: 0,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("fail");
    expect(ctx.criticResults).toHaveLength(1);
    expect(ctx.criticResults[0].issues).toHaveLength(1);
    expect(ctx.criticResults[0].issues[0].severity).toBe("critical");
  });

  it("filters violations by impact_filter", async () => {
    const ctx = makeCtx();
    (ctx.page.evaluate as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce({
        violations: [
          {
            id: "image-alt",
            impact: "minor",
            description: "missing alt",
            help: "Add alt",
            helpUrl: "https://x",
            tags: ["wcag2a"],
            nodes: [{ html: "", target: ["img"], failureSummary: "" }],
          },
          {
            id: "label",
            impact: "serious",
            description: "missing label",
            help: "Add label",
            helpUrl: "https://x",
            tags: ["wcag2a"],
            nodes: [{ html: "", target: ["input"], failureSummary: "" }],
          },
        ],
        passes: [],
        incomplete: [],
      });
    const result = await executeStep(
      {
        id: "a1",
        type: "assert_a11y",
        impact_filter: ["serious", "critical"],
        retry: 0,
      } as Step,
      ctx,
    );
    expect((result.output as { total_violations: number }).total_violations).toBe(1);
  });

  it("warns when violations exceed max_violations cap", async () => {
    const ctx = makeCtx();
    (ctx.page.evaluate as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce({
        violations: [
          {
            id: "x1",
            impact: "minor",
            description: "x",
            help: "",
            helpUrl: "",
            tags: [],
            nodes: [{ html: "", target: ["a"], failureSummary: "" }],
          },
          {
            id: "x2",
            impact: "minor",
            description: "x",
            help: "",
            helpUrl: "",
            tags: [],
            nodes: [{ html: "", target: ["b"], failureSummary: "" }],
          },
        ],
        passes: [],
        incomplete: [],
      });
    const result = await executeStep(
      {
        id: "a1",
        type: "assert_a11y",
        max_violations: 1,
        retry: 0,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("warn");
  });

  it("warns when axe returns invalid shape", async () => {
    const ctx = makeCtx();
    (ctx.page.evaluate as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce({ broken: true });
    const result = await executeStep(
      { id: "a1", type: "assert_a11y", retry: 0 } as Step,
      ctx,
    );
    expect(result.status).toBe("warn");
  });
});

// ─────────────────────────────────────────────────────────────
// handleCheckEmail
// ─────────────────────────────────────────────────────────────

describe("handleCheckEmail", () => {
  it("throws when no temp inbox is provided", async () => {
    const ctx = makeCtx();
    const result = await executeStep(
      {
        id: "e1",
        type: "check_email",
        wait_seconds: 1,
        retry: 0,
        critical: true,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("fail");
    expect(result.error).toContain("temp inbox");
  });

  it("returns pass when an email arrives matching the predicate", async () => {
    const ctx = makeCtx({
      tempInbox: { address: "test@inbox", id: "i" } as never,
    });
    mockWaitForMessage.mockResolvedValueOnce({
      from: "noreply@x",
      subject: "Verify your email",
      receivedAt: "2026-05-01T00:00:00Z",
    });
    const result = await executeStep(
      {
        id: "e1",
        type: "check_email",
        expected_subject_contains: "verify",
        wait_seconds: 5,
        retry: 0,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("pass");
  });

  it("throws when no email arrives", async () => {
    const ctx = makeCtx({
      tempInbox: { address: "test@inbox", id: "i" } as never,
    });
    mockWaitForMessage.mockResolvedValueOnce(null);
    const result = await executeStep(
      {
        id: "e1",
        type: "check_email",
        wait_seconds: 1,
        retry: 0,
        critical: true,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("fail");
    expect(result.error).toContain("Email did not arrive");
  });
});

// ─────────────────────────────────────────────────────────────
// handleScreenshot
// ─────────────────────────────────────────────────────────────

describe("handleScreenshot", () => {
  it("calls recorder.screenshot with the label or step id", async () => {
    const ctx = makeCtx();
    const result = await executeStep(
      {
        id: "shot1",
        type: "screenshot",
        label: "homepage",
        retry: 0,
      } as Step,
      ctx,
    );
    expect(ctx.recorder.screenshot).toHaveBeenCalledWith("homepage", undefined);
    expect(result.screenshot).toBe("/tmp/homepage.png");
  });

  it("falls back to step id when label is missing", async () => {
    const ctx = makeCtx();
    const result = await executeStep(
      {
        id: "shot2",
        type: "screenshot",
        retry: 0,
      } as Step,
      ctx,
    );
    expect(ctx.recorder.screenshot).toHaveBeenCalledWith("shot2", undefined);
    expect(result.status).toBe("pass");
  });

  it("returns warn when baseline diff regresses", async () => {
    const ctx = makeCtx({ baselineDir: "/tmp/baseline" });
    mockDiffAgainstBaseline.mockResolvedValueOnce({
      computed: true,
      regression: true,
      diffPixels: 500,
      reason: "differs",
      diffImagePath: "/tmp/diff.png",
    });
    const result = await executeStep(
      { id: "shot3", type: "screenshot", retry: 0 } as Step,
      ctx,
    );
    expect(result.status).toBe("warn");
  });

  it("does not call diff when baselineDir is unset", async () => {
    const ctx = makeCtx();
    await executeStep(
      { id: "shot4", type: "screenshot", retry: 0 } as Step,
      ctx,
    );
    expect(mockDiffAgainstBaseline).not.toHaveBeenCalled();
  });

  it("captures diff failure into a graceful DiffResult", async () => {
    const ctx = makeCtx({ baselineDir: "/tmp/baseline" });
    mockDiffAgainstBaseline.mockRejectedValueOnce(new Error("baseline missing"));
    const result = await executeStep(
      { id: "shot5", type: "screenshot", retry: 0 } as Step,
      ctx,
    );
    expect(result.status).toBe("pass");
  });
});

// ─────────────────────────────────────────────────────────────
// handleComputerUse
// ─────────────────────────────────────────────────────────────

describe("handleComputerUse", () => {
  it("delegates to runComputerUseTask and accumulates cost", async () => {
    const ctx = makeCtx();
    mockRunComputerUseTask.mockResolvedValueOnce({
      finalText: "task complete",
      iterations: 4,
      costUsd: 0.07,
      history: [],
    });
    await executeStep(
      {
        id: "cu1",
        type: "computer_use",
        task: "find pricing",
        max_iterations: 10,
        retry: 0,
      } as Step,
      ctx,
    );
    expect(mockRunComputerUseTask).toHaveBeenCalled();
    expect(ctx.cost.value).toBeCloseTo(0.07);
  });

  it("substitutes template values in the task description", async () => {
    const ctx = makeCtx({ store: { plan: "pro" } });
    mockRunComputerUseTask.mockResolvedValueOnce({
      finalText: "x",
      iterations: 1,
      costUsd: 0,
      history: [],
    });
    await executeStep(
      {
        id: "cu1",
        type: "computer_use",
        task: "select ${store.plan}",
        retry: 0,
      } as Step,
      ctx,
    );
    const args = mockRunComputerUseTask.mock.calls[0][0] as { task: string };
    expect(args.task).toBe("select pro");
  });
});

// ─────────────────────────────────────────────────────────────
// handleCustom
// ─────────────────────────────────────────────────────────────

describe("handleCustom", () => {
  it("returns a fail result when the handler module path is invalid", async () => {
    const ctx = makeCtx();
    const result = await executeStep(
      {
        id: "c1",
        type: "custom",
        handler: "/does/not/exist.js",
        retry: 0,
        critical: true,
      } as Step,
      ctx,
    );
    expect(result.status).toBe("fail");
    expect(result.error).toContain("Custom handler");
  });
});

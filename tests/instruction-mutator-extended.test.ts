/**
 * Extended tests for src/core/instruction-mutator.ts.
 *
 * The original instruction-mutator.test.ts covers mutateSpecific +
 * mutateDecompose. This file adds:
 *   - generateMutations orchestration (LLM + specific + decompose +
 *     rephrase merging, schema_version stamping, page.evaluate plumbing)
 *   - autoDiscoverSelectors (Stagehand observe mock + filter + slice)
 *   - llmRewrite via generateMutations(_, _, cost) path
 *   - rephrase verb-swap matrix exercised via mutateDecompose's
 *     no-pattern-matched rephrase fallback
 *
 * Mocks @anthropic-ai/sdk and ./cost-guard.js the same way llm.test.ts
 * does. Page.evaluate is mocked to return a deterministic DOM-summary
 * string — the inner DOM-walking callback runs in browser context only
 * (per ADR-017 §"M1-2 Phase 2/3 deferred / page-side evaluate(cb)").
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Page } from "playwright";
import { mutateDecompose } from "../src/core/instruction-mutator.js";

// ─────────────────────────────────────────────────────────────
// Hoisted mock state
// ─────────────────────────────────────────────────────────────

const sdkMock = vi.hoisted(() => {
  type Capture = {
    lastCreateRequest: unknown;
    nextCreateResult:
      | {
          content: Array<{ type: string; text?: string }>;
          usage: { input_tokens: number; output_tokens: number };
        }
      | Error;
  };
  const capture: Capture = {
    lastCreateRequest: null,
    nextCreateResult: {
      content: [{ type: "text", text: "Click on the primary button labeled 'Sign In'" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  };
  return { capture };
});

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    constructor() {
      // ignore
    }
    messages = {
      create: vi.fn(async (req: unknown) => {
        sdkMock.capture.lastCreateRequest = req;
        const v = sdkMock.capture.nextCreateResult;
        if (v instanceof Error) throw v;
        return v;
      }),
    };
  }
  return { default: FakeAnthropic };
});

const costGuardMock = vi.hoisted(() => ({
  checkBudget: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock("../src/core/cost-guard.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/core/cost-guard.js")
  >("../src/core/cost-guard.js");
  return {
    ...actual,
    getCostGuard: () => costGuardMock,
  };
});

const savedEnv = { ...process.env };

beforeEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  process.env.ANTHROPIC_API_KEY = "sk-test-x";
  sdkMock.capture.lastCreateRequest = null;
  sdkMock.capture.nextCreateResult = {
    content: [{ type: "text", text: "Click on the primary button labeled 'Sign In'" }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
  costGuardMock.checkBudget.mockClear();
  costGuardMock.recordUsage.mockClear();
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  vi.resetModules();
});

function makePage(domSummary = "<button#sign-in> \"Sign In\""): Page {
  return {
    evaluate: vi.fn(async () => domSummary),
  } as unknown as Page;
}

function makeFailingPage(): Page {
  return {
    evaluate: vi.fn(async () => {
      throw new Error("evaluation failed");
    }),
  } as unknown as Page;
}

// ─────────────────────────────────────────────────────────────
// generateMutations — orchestration
// ─────────────────────────────────────────────────────────────

describe("generateMutations — without cost (no LLM rewrite)", () => {
  it("returns specific + decompose + rephrase variants when patterns match", async () => {
    vi.resetModules();
    const { generateMutations } = await import(
      "../src/core/instruction-mutator.js"
    );
    const page = makePage(`<button#sign-in> "Sign In"
<input type="email" placeholder="email">`);

    const results = await generateMutations(
      "Click the sign in button, then type email",
      page,
    );

    // No LLM call without cost accumulator
    const sdkInstance = sdkMock.capture.lastCreateRequest;
    expect(sdkInstance).toBeNull();

    // Decompose + specific + rephrase fallback (specific result has rephrase
    // ineligibility check)
    const types = results.map((r) => r.type);
    expect(types).toContain("specific");
    expect(types).toContain("decompose");
    // rephrase added because no other rephrase was emitted
    expect(types).toContain("rephrase");
  });

  it("emits decompose only when the input has a 'then' or 'and' pattern", async () => {
    vi.resetModules();
    const { generateMutations } = await import(
      "../src/core/instruction-mutator.js"
    );
    const page = makePage("");
    const results = await generateMutations("Click the login button", page);
    const types = results.map((r) => r.type);
    expect(types).not.toContain("decompose");
    // Falls through to rephrase fallback
    expect(types).toContain("rephrase");
  });

  it("does not duplicate rephrase when mutateSpecific or mutateDecompose returned rephrase already", async () => {
    vi.resetModules();
    const { generateMutations } = await import(
      "../src/core/instruction-mutator.js"
    );
    // Empty DOM + no decompose pattern → mutateSpecific falls back to
    // rephrase, mutateDecompose falls back to rephrase. Neither is added
    // (only specific/decompose entries qualify), so the explicit fallback
    // adds exactly one rephrase entry.
    const page = makePage("");
    const results = await generateMutations("Toggle the dashboard", page);
    const rephrases = results.filter((r) => r.type === "rephrase");
    expect(rephrases).toHaveLength(1);
  });

  it("stamps schema_version on every result (any mutation path)", async () => {
    vi.resetModules();
    const { generateMutations } = await import(
      "../src/core/instruction-mutator.js"
    );
    const { RESULT_SCHEMA_VERSION } = await import(
      "../src/core/result-schema.js"
    );
    const page = makePage('<button> "OK"');
    const results = await generateMutations(
      "Click ok and click cancel",
      page,
    );
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.schema_version).toBe(RESULT_SCHEMA_VERSION);
    }
  });

  it("calls page.evaluate exactly once to gather DOM context", async () => {
    vi.resetModules();
    const { generateMutations } = await import(
      "../src/core/instruction-mutator.js"
    );
    const page = makePage('<button> "Confirm"');
    await generateMutations("Click confirm", page);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it("falls back to '(unable to read DOM)' when page.evaluate throws", async () => {
    vi.resetModules();
    const { generateMutations, mutateSpecific } = await import(
      "../src/core/instruction-mutator.js"
    );
    const page = makeFailingPage();
    // Should not crash — generateMutations swallows the evaluate error and
    // proceeds with an empty DOM context. mutateSpecific on empty context
    // returns rephrase fallback.
    const results = await generateMutations("Click confirm", page);
    expect(results.length).toBeGreaterThan(0);
    // mutateSpecific on the unreadable DOM yields rephrase, so the explicit
    // rephrase fallback should not duplicate.
    const rephrases = results.filter((r) => r.type === "rephrase");
    expect(rephrases).toHaveLength(1);
    // Sanity: the standalone helper agrees on the fallback shape
    const direct = mutateSpecific(
      "Click confirm",
      "(unable to read DOM)",
    );
    expect(direct.type).toBe("rephrase");
  });
});

describe("generateMutations — with cost (LLM rewrite)", () => {
  it("includes an LLM-rewrite result when the model returns a non-empty different instruction", async () => {
    sdkMock.capture.nextCreateResult = {
      content: [
        { type: "text", text: "Click the primary 'Submit' button at the top right" },
      ],
      usage: { input_tokens: 200, output_tokens: 30 },
    };
    vi.resetModules();
    const { generateMutations } = await import(
      "../src/core/instruction-mutator.js"
    );
    const page = makePage('<button#submit> "Submit"');
    const cost = { value: 0 };
    const results = await generateMutations("Click submit", page, cost);

    expect(results[0].type).toBe("rephrase");
    expect(results[0].instructions[0]).toMatch(/Submit/);
    // Cost accumulator advanced (haiku $0.80 in / $4 out per 1M)
    expect(cost.value).toBeGreaterThan(0);
    expect(costGuardMock.checkBudget).toHaveBeenCalledTimes(1);
    expect(costGuardMock.recordUsage).toHaveBeenCalledWith(
      "claude-haiku-4-5-20251001",
      200,
      30,
    );
  });

  it("ignores LLM output that is identical to the original (no-op rewrite)", async () => {
    sdkMock.capture.nextCreateResult = {
      content: [{ type: "text", text: "Click submit" }],
      usage: { input_tokens: 50, output_tokens: 10 },
    };
    vi.resetModules();
    const { generateMutations } = await import(
      "../src/core/instruction-mutator.js"
    );
    const page = makePage('<button#submit> "Submit"');
    const results = await generateMutations(
      "Click submit",
      page,
      { value: 0 },
    );
    // First result should NOT be the LLM rewrite (it was rejected as no-op)
    if (results[0].type === "rephrase") {
      expect(results[0].instructions[0]).not.toBe("Click submit");
    }
  });

  it("ignores LLM output that is empty after trim", async () => {
    sdkMock.capture.nextCreateResult = {
      content: [{ type: "text", text: "   \n  " }],
      usage: { input_tokens: 50, output_tokens: 5 },
    };
    vi.resetModules();
    const { generateMutations } = await import(
      "../src/core/instruction-mutator.js"
    );
    const page = makePage("");
    const results = await generateMutations(
      "Click submit",
      page,
      { value: 0 },
    );
    // No LLM rewrite at index 0; results still include downstream variants
    if (results[0]) {
      expect(results[0].instructions[0]).not.toBe("");
    }
  });

  it("silently swallows LLM errors and falls back to local mutations", async () => {
    sdkMock.capture.nextCreateResult = new Error(
      "503 Service Unavailable",
    );
    vi.resetModules();
    const { generateMutations } = await import(
      "../src/core/instruction-mutator.js"
    );
    const page = makePage('<button> "OK"');
    const results = await generateMutations("Click ok", page, { value: 0 });
    expect(results.length).toBeGreaterThan(0);
    // No LLM rewrite included → fallback rephrase is the only rephrase entry
    expect(results.filter((r) => r.type === "rephrase")).toHaveLength(1);
  });

  it("does not call recordUsage when the SDK call fails", async () => {
    sdkMock.capture.nextCreateResult = new Error("boom");
    vi.resetModules();
    const { generateMutations } = await import(
      "../src/core/instruction-mutator.js"
    );
    const page = makePage("");
    await generateMutations("Click ok", page, { value: 0 });
    expect(costGuardMock.recordUsage).not.toHaveBeenCalled();
  });

  it("does not call recordUsage when checkBudget throws", async () => {
    costGuardMock.checkBudget.mockImplementationOnce(() => {
      throw new Error("budget exceeded");
    });
    vi.resetModules();
    const { generateMutations } = await import(
      "../src/core/instruction-mutator.js"
    );
    const page = makePage("");
    const results = await generateMutations("Click ok", page, { value: 0 });
    // llmRewrite caught the throw → fell through to local mutations
    expect(results.length).toBeGreaterThan(0);
    expect(costGuardMock.recordUsage).not.toHaveBeenCalled();
  });

  it("does not call the LLM when cost accumulator is omitted", async () => {
    vi.resetModules();
    const { generateMutations } = await import(
      "../src/core/instruction-mutator.js"
    );
    const page = makePage('<button> "OK"');
    await generateMutations("Click ok", page);
    expect(sdkMock.capture.lastCreateRequest).toBeNull();
    expect(costGuardMock.checkBudget).not.toHaveBeenCalled();
  });

  it("forwards the original instruction + DOM context (truncated to 1500 chars) to the model", async () => {
    vi.resetModules();
    const { generateMutations } = await import(
      "../src/core/instruction-mutator.js"
    );
    const longDom = "X".repeat(2000);
    const page = makePage(longDom);
    await generateMutations("Click the elusive widget", page, { value: 0 });
    const req = sdkMock.capture.lastCreateRequest as {
      messages: { content: string }[];
      model: string;
      max_tokens: number;
      system: string;
    };
    expect(req.model).toBe("claude-haiku-4-5-20251001");
    expect(req.max_tokens).toBe(256);
    expect(req.system).toMatch(/browser automation expert/);
    const userContent = req.messages[0].content;
    expect(userContent).toMatch(/Click the elusive widget/);
    // Slice 1500 — count Xs in the prompt body
    const xs = (userContent.match(/X/g) ?? []).length;
    expect(xs).toBe(1500);
  });
});

// ─────────────────────────────────────────────────────────────
// autoDiscoverSelectors — Stagehand observe mock
// ─────────────────────────────────────────────────────────────

describe("autoDiscoverSelectors", () => {
  it("returns selectors observed by Stagehand", async () => {
    vi.resetModules();
    const { autoDiscoverSelectors } = await import(
      "../src/core/instruction-mutator.js"
    );
    const stagehand = {
      observe: vi.fn(async () => [
        { description: "Sign In button", selector: "#sign-in" },
        { description: "Email input", selector: 'input[type="email"]' },
      ]),
    };
    const result = await autoDiscoverSelectors("Click sign in", stagehand);
    expect(result).toEqual(["#sign-in", 'input[type="email"]']);
    expect(stagehand.observe).toHaveBeenCalledWith({
      instruction: 'Find all interactive elements that could match: "Click sign in"',
    });
  });

  it("filters out empty / missing selectors", async () => {
    vi.resetModules();
    const { autoDiscoverSelectors } = await import(
      "../src/core/instruction-mutator.js"
    );
    const stagehand = {
      observe: vi.fn(async () => [
        { description: "Some btn", selector: "#btn" },
        { description: "no selector" },
        { description: "empty", selector: "" },
        { description: "another", selector: ".cta" },
      ]),
    };
    const result = await autoDiscoverSelectors("x", stagehand);
    expect(result).toEqual(["#btn", ".cta"]);
  });

  it("slices to at most 5 selectors", async () => {
    vi.resetModules();
    const { autoDiscoverSelectors } = await import(
      "../src/core/instruction-mutator.js"
    );
    const stagehand = {
      observe: vi.fn(async () =>
        Array.from({ length: 10 }, (_, i) => ({ selector: `#el-${i}` })),
      ),
    };
    const result = await autoDiscoverSelectors("x", stagehand);
    expect(result).toHaveLength(5);
    expect(result).toEqual(["#el-0", "#el-1", "#el-2", "#el-3", "#el-4"]);
  });

  it("returns [] when stagehand.observe throws", async () => {
    vi.resetModules();
    const { autoDiscoverSelectors } = await import(
      "../src/core/instruction-mutator.js"
    );
    const stagehand = {
      observe: vi.fn(async () => {
        throw new Error("session closed");
      }),
    };
    expect(await autoDiscoverSelectors("x", stagehand)).toEqual([]);
  });

  it("returns [] when observe returns empty", async () => {
    vi.resetModules();
    const { autoDiscoverSelectors } = await import(
      "../src/core/instruction-mutator.js"
    );
    const stagehand = {
      observe: vi.fn(async () => []),
    };
    expect(await autoDiscoverSelectors("x", stagehand)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// rephrase — exercised through mutateDecompose's no-pattern fallback
// ─────────────────────────────────────────────────────────────

describe("rephrase verb-swap matrix (via mutateDecompose fallback)", () => {
  // Each input has no decompose pattern, so mutateDecompose returns a
  // type:"rephrase" result whose instruction is the rephrased form. We
  // verify the verb-swap rewrite for each pattern in the table.
  const cases: Array<{ name: string; input: string; pattern: RegExp }> = [
    { name: "click → press", input: "Click the menu", pattern: /^Press / },
    {
      name: "click on → press",
      input: "Click on the home tab",
      pattern: /^Press the home tab/,
    },
    { name: "press → click on", input: "Press enter", pattern: /^Click on / },
    { name: "tap → click on", input: "Tap the avatar", pattern: /^Click on / },
    {
      name: "tap on → click on",
      input: "Tap on the toggle",
      pattern: /^Click on the toggle/,
    },
    {
      name: "select → choose",
      input: "Select option three",
      pattern: /^Choose /,
    },
    { name: "choose → select", input: "Choose blue", pattern: /^Select / },
    {
      name: "navigate to → go to",
      input: "Navigate to settings",
      pattern: /^Go to /,
    },
    { name: "go to → navigate to", input: "Go to home", pattern: /^Navigate to / },
    { name: "open → click on", input: "Open the modal", pattern: /^Click on / },
    {
      name: "find → locate and click",
      input: "Find the FAQ section",
      pattern: /^Locate and click /,
    },
    { name: "enter → type", input: "Enter your name", pattern: /^Type / },
    { name: "type → enter", input: "Type the password", pattern: /^Enter / },
    {
      name: "scroll down to → find",
      input: "Scroll down to the footer",
      pattern: /^Find the footer/,
    },
    {
      name: "look for → find and click",
      input: "Look for the help icon",
      pattern: /^Find and click /,
    },
  ];

  for (const c of cases) {
    it(`rewrites: ${c.name}`, () => {
      // Trigger rephrase via mutateDecompose's no-pattern fallback.
      const r = mutateDecompose(c.input);
      expect(r.type).toBe("rephrase");
      expect(r.instructions[0]).toMatch(c.pattern);
    });
  }

  it("appends 'visible area' hint when the instruction mentions a button (no verb match)", () => {
    const r = mutateDecompose("Confirm the button is rendered");
    expect(r.type).toBe("rephrase");
    expect(r.instructions[0]).toMatch(/Look for it in the visible area of the page\.$/);
  });

  it("appends 'clickable text or anchor' hint for link mentions (no verb match)", () => {
    const r = mutateDecompose("Verify the link target");
    expect(r.type).toBe("rephrase");
    expect(r.instructions[0]).toMatch(/clickable text or anchor element\.$/);
  });

  it("appends a generic 'try a different approach' hint when no other heuristic matches", () => {
    const r = mutateDecompose("Verify the spinner stops");
    expect(r.type).toBe("rephrase");
    expect(r.instructions[0]).toMatch(
      /Try a different approach to locate and interact with this element\.$/,
    );
  });
});

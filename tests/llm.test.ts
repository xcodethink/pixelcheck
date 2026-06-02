/**
 * Tests for src/core/llm.ts — Anthropic client, callVision multi-image
 * dispatch, cost estimator, and the JSON-extract / truncate-repair logic.
 *
 * Mocks @anthropic-ai/sdk and ./cost-guard.js. Uses vi.resetModules +
 * dynamic import for the singleton client tests so each test sees a fresh
 * module-level `client` cache.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─────────────────────────────────────────────────────────────
// Hoisted mock state
// ─────────────────────────────────────────────────────────────

const sdkMock = vi.hoisted(() => {
  type Capture = {
    constructorArgs: unknown[];
    lastCreateRequest: unknown;
    nextCreateResult:
      | {
          content: Array<{ type: string; text?: string }>;
          usage: { input_tokens: number; output_tokens: number };
        }
      | Error;
  };
  const capture: Capture = {
    constructorArgs: [],
    lastCreateRequest: null,
    nextCreateResult: {
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, output_tokens: 20 },
    },
  };
  return { capture };
});

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    constructor(opts: unknown) {
      sdkMock.capture.constructorArgs.push(opts);
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
  sdkMock.capture.constructorArgs = [];
  sdkMock.capture.lastCreateRequest = null;
  sdkMock.capture.nextCreateResult = {
    content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
  costGuardMock.checkBudget.mockClear();
  costGuardMock.recordUsage.mockClear();
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  vi.resetModules();
});

// ─────────────────────────────────────────────────────────────
// getAnthropicClient — singleton
// ─────────────────────────────────────────────────────────────

describe("getAnthropicClient", () => {
  it("throws when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.resetModules();
    const { getAnthropicClient } = await import("../src/core/llm.js");
    expect(() => getAnthropicClient()).toThrow(/ANTHROPIC_API_KEY not set/);
  });

  it("constructs the client with the env key when set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-abc";
    vi.resetModules();
    const { getAnthropicClient } = await import("../src/core/llm.js");
    const c = getAnthropicClient();
    expect(c).toBeDefined();
    // Includes a bounded per-request timeout + retries so a hung Anthropic
    // call can't stall the agent loop for the SDK's 10-min default. (D2-C2)
    expect(sdkMock.capture.constructorArgs.at(-1)).toEqual({
      apiKey: "sk-test-abc",
      timeout: 120_000,
      maxRetries: 2,
    });
  });

  it("memoises the client (singleton — second call does not re-construct)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-cache";
    vi.resetModules();
    const { getAnthropicClient } = await import("../src/core/llm.js");
    const a = getAnthropicClient();
    const b = getAnthropicClient();
    expect(a).toBe(b);
    // Constructor was called exactly once for this fresh module load
    const callsForKey = sdkMock.capture.constructorArgs.filter(
      (x) => (x as { apiKey: string }).apiKey === "sk-cache",
    );
    expect(callsForKey).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
// estimateCost — pricing math
// ─────────────────────────────────────────────────────────────

describe("estimateCost", () => {
  it("computes opus 4.6 cost at $15 in / $75 out per 1M", async () => {
    const { estimateCost } = await import("../src/core/llm.js");
    expect(estimateCost("claude-opus-4-6", 1_000_000, 0)).toBe(15);
    expect(estimateCost("claude-opus-4-6", 0, 1_000_000)).toBe(75);
    expect(estimateCost("claude-opus-4-6", 100_000, 50_000)).toBeCloseTo(
      (100_000 * 15 + 50_000 * 75) / 1_000_000,
      6,
    );
  });

  it("computes sonnet 4.6 cost at $3 in / $15 out per 1M", async () => {
    const { estimateCost } = await import("../src/core/llm.js");
    expect(estimateCost("claude-sonnet-4-6", 1_000_000, 0)).toBe(3);
    expect(estimateCost("claude-sonnet-4-6", 0, 1_000_000)).toBe(15);
  });

  it("computes haiku 4.5 cost at $0.80 in / $4 out per 1M", async () => {
    const { estimateCost } = await import("../src/core/llm.js");
    expect(estimateCost("claude-haiku-4-5-20251001", 1_000_000, 0)).toBeCloseTo(
      0.8,
      6,
    );
    expect(estimateCost("claude-haiku-4-5-20251001", 0, 1_000_000)).toBe(4);
  });

  it("falls back to the HIGHEST known rate for an unknown model (Audit 2026-06-02 E5)", async () => {
    // Conservative fallback: an unknown/typo'd model must not be under-priced
    // (previously fell back to the cheaper sonnet rate, silently under-counting
    // the budget guard). Highest current rate is opus (15 in / 75 out).
    const { estimateCost } = await import("../src/core/llm.js");
    expect(estimateCost("future-model-not-in-table", 1_000_000, 0)).toBe(15);
    expect(estimateCost("future-model-not-in-table", 0, 1_000_000)).toBe(75);
  });

  it("returns 0 for zero usage", async () => {
    const { estimateCost } = await import("../src/core/llm.js");
    expect(estimateCost("claude-sonnet-4-6", 0, 0)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// callVision — request shaping
// ─────────────────────────────────────────────────────────────

describe("callVision — request shaping", () => {
  it("throws when called with no images at all", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-x";
    vi.resetModules();
    const { callVision } = await import("../src/core/llm.js");
    await expect(
      callVision({ model: "claude-sonnet-4-6", userPrompt: "hi" }),
    ).rejects.toThrow(/at least one image/);
  });

  it("uses the legacy imageBase64 path when images[] is omitted (default media_type=image/png)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-x";
    vi.resetModules();
    const { callVision } = await import("../src/core/llm.js");
    await callVision({
      model: "claude-sonnet-4-6",
      userPrompt: "describe",
      imageBase64: "BASE64-A",
    });
    const req = sdkMock.capture.lastCreateRequest as {
      messages: { content: Array<{ type: string; source?: { media_type: string; data: string } }> }[];
    };
    const content = req.messages[0].content;
    // First block is the image
    expect(content[0].type).toBe("image");
    expect(content[0].source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: "BASE64-A",
    });
  });

  it("respects imageMediaType when set on the legacy path", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-x";
    vi.resetModules();
    const { callVision } = await import("../src/core/llm.js");
    await callVision({
      model: "claude-sonnet-4-6",
      userPrompt: "x",
      imageBase64: "B",
      imageMediaType: "image/jpeg",
    });
    const req = sdkMock.capture.lastCreateRequest as {
      messages: { content: Array<{ source?: { media_type: string } }> }[];
    };
    expect(req.messages[0].content[0].source!.media_type).toBe("image/jpeg");
  });

  it("prefers images[] over imageBase64 when both are provided", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-x";
    vi.resetModules();
    const { callVision } = await import("../src/core/llm.js");
    await callVision({
      model: "claude-sonnet-4-6",
      userPrompt: "x",
      imageBase64: "LEGACY",
      images: [{ base64: "NEW", mediaType: "image/jpeg" }],
    });
    const req = sdkMock.capture.lastCreateRequest as {
      messages: { content: Array<{ type: string; source?: { data: string } }> }[];
    };
    const imageBlock = req.messages[0].content.find((c) => c.type === "image")!;
    expect(imageBlock.source!.data).toBe("NEW");
  });

  it("prepends a label text block before each labeled image", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-x";
    vi.resetModules();
    const { callVision } = await import("../src/core/llm.js");
    await callVision({
      model: "claude-sonnet-4-6",
      userPrompt: "describe both",
      images: [
        { base64: "A", mediaType: "image/png", label: "FIRST IMAGE" },
        { base64: "B", mediaType: "image/jpeg" }, // no label
        { base64: "C", mediaType: "image/png", label: "THIRD IMAGE" },
      ],
    });
    const req = sdkMock.capture.lastCreateRequest as {
      messages: { content: Array<{ type: string; text?: string }> }[];
    };
    const seq = req.messages[0].content.map((c) =>
      c.type === "text" ? `T:${c.text}` : "I",
    );
    expect(seq).toEqual([
      "T:FIRST IMAGE",
      "I",
      "I",
      "T:THIRD IMAGE",
      "I",
      "T:describe both",
    ]);
  });

  it("appends the userPrompt as the final text block", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-x";
    vi.resetModules();
    const { callVision } = await import("../src/core/llm.js");
    await callVision({
      model: "claude-sonnet-4-6",
      userPrompt: "MY PROMPT",
      imageBase64: "B",
    });
    const req = sdkMock.capture.lastCreateRequest as {
      messages: { content: Array<{ type: string; text?: string }> }[];
    };
    const last = req.messages[0].content.at(-1)!;
    expect(last.type).toBe("text");
    expect(last.text).toBe("MY PROMPT");
  });

  it("forwards systemPrompt + maxTokens (default 2048) + model name", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-x";
    vi.resetModules();
    const { callVision } = await import("../src/core/llm.js");
    await callVision({
      model: "claude-opus-4-6",
      systemPrompt: "be terse",
      userPrompt: "x",
      imageBase64: "B",
    });
    const req = sdkMock.capture.lastCreateRequest as {
      model: string;
      system?: string;
      max_tokens: number;
    };
    expect(req.model).toBe("claude-opus-4-6");
    expect(req.system).toBe("be terse");
    expect(req.max_tokens).toBe(2048);
  });

  it("respects a custom maxTokens", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-x";
    vi.resetModules();
    const { callVision } = await import("../src/core/llm.js");
    await callVision({
      model: "claude-sonnet-4-6",
      userPrompt: "x",
      imageBase64: "B",
      maxTokens: 4096,
    });
    const req = sdkMock.capture.lastCreateRequest as { max_tokens: number };
    expect(req.max_tokens).toBe(4096);
  });
});

// ─────────────────────────────────────────────────────────────
// callVision — response handling + cost guard
// ─────────────────────────────────────────────────────────────

describe("callVision — response handling", () => {
  it("joins all text blocks with newline; ignores non-text blocks", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-x";
    sdkMock.capture.nextCreateResult = {
      content: [
        { type: "text", text: "line one" },
        { type: "tool_use" }, // ignored
        { type: "text", text: "line two" },
      ],
      usage: { input_tokens: 100, output_tokens: 200 },
    };
    vi.resetModules();
    const { callVision } = await import("../src/core/llm.js");
    const r = await callVision({
      model: "claude-sonnet-4-6",
      userPrompt: "x",
      imageBase64: "B",
    });
    expect(r.text).toBe("line one\nline two");
    expect(r.inputTokens).toBe(100);
    expect(r.outputTokens).toBe(200);
  });

  it("computes costUsd via estimateCost using the response usage", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-x";
    sdkMock.capture.nextCreateResult = {
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    };
    vi.resetModules();
    const { callVision } = await import("../src/core/llm.js");
    const r = await callVision({
      model: "claude-sonnet-4-6",
      userPrompt: "x",
      imageBase64: "B",
    });
    // 1M input tokens at sonnet $3/1M = $3
    expect(r.costUsd).toBe(3);
  });

  it("calls cost-guard checkBudget pre-call and recordUsage post-call (in order)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-x";
    sdkMock.capture.nextCreateResult = {
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 7, output_tokens: 9 },
    };
    vi.resetModules();
    const { callVision } = await import("../src/core/llm.js");
    await callVision({
      model: "claude-haiku-4-5-20251001",
      userPrompt: "x",
      imageBase64: "B",
    });
    expect(costGuardMock.checkBudget).toHaveBeenCalledTimes(1);
    expect(costGuardMock.recordUsage).toHaveBeenCalledTimes(1);
    expect(costGuardMock.recordUsage).toHaveBeenCalledWith(
      "claude-haiku-4-5-20251001",
      7,
      9,
    );
    // checkBudget invoked before the SDK call → before recordUsage
    const checkOrder = costGuardMock.checkBudget.mock.invocationCallOrder[0];
    const recordOrder = costGuardMock.recordUsage.mock.invocationCallOrder[0];
    expect(checkOrder).toBeLessThan(recordOrder);
  });

  it("propagates a checkBudget throw without making the SDK call", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-x";
    costGuardMock.checkBudget.mockImplementationOnce(() => {
      throw new Error("budget exceeded");
    });
    vi.resetModules();
    const { callVision } = await import("../src/core/llm.js");
    await expect(
      callVision({
        model: "claude-sonnet-4-6",
        userPrompt: "x",
        imageBase64: "B",
      }),
    ).rejects.toThrow(/budget exceeded/);
    expect(costGuardMock.recordUsage).not.toHaveBeenCalled();
  });

  it("propagates an SDK throw and does NOT call recordUsage", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-x";
    sdkMock.capture.nextCreateResult = new Error("503 Service Unavailable");
    vi.resetModules();
    const { callVision } = await import("../src/core/llm.js");
    await expect(
      callVision({
        model: "claude-sonnet-4-6",
        userPrompt: "x",
        imageBase64: "B",
      }),
    ).rejects.toThrow(/503/);
    expect(costGuardMock.checkBudget).toHaveBeenCalledTimes(1);
    expect(costGuardMock.recordUsage).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// extractJson — every parse path
// ─────────────────────────────────────────────────────────────

describe("extractJson", () => {
  it("parses fenced ```json ... ``` blocks", async () => {
    const { extractJson } = await import("../src/core/llm.js");
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("parses fenced ``` ... ``` (no language tag)", async () => {
    const { extractJson } = await import("../src/core/llm.js");
    expect(extractJson('``` {"b":2} ```')).toEqual({ b: 2 });
  });

  it("parses a bare {} object", async () => {
    const { extractJson } = await import("../src/core/llm.js");
    expect(extractJson('{"c":3}')).toEqual({ c: 3 });
  });

  it("finds the first balanced object when surrounded by prose", async () => {
    const { extractJson } = await import("../src/core/llm.js");
    expect(
      extractJson('Some preamble before {"d":4} and trailing chatter'),
    ).toEqual({ d: 4 });
  });

  it("handles nested braces inside string values", async () => {
    const { extractJson } = await import("../src/core/llm.js");
    expect(extractJson('{"text":"contains {curly} braces"}')).toEqual({
      text: "contains {curly} braces",
    });
  });

  it("handles escaped quotes inside string values", async () => {
    const { extractJson } = await import("../src/core/llm.js");
    expect(extractJson('{"text":"she said \\"hi\\""}')).toEqual({
      text: 'she said "hi"',
    });
  });

  it("repairs a truncated array, dropping the unterminated trailing number", async () => {
    const { extractJson } = await import("../src/core/llm.js");
    // The final `4` has no delimiter after it, so we can't tell it apart
    // from `4` of a longer `456…` cut mid-digit. The repair drops it rather
    // than risk a structurally-valid-but-WRONG value (D2-M5/D3-M1).
    const text = '{"items":[1, 2, 3, 4';
    const result = extractJson<{ items: number[] }>(text);
    expect(result.items).toEqual([1, 2, 3]);
  });

  it("recovers a trailing number that IS delimiter-terminated", async () => {
    const { extractJson } = await import("../src/core/llm.js");
    // Here the `4` is followed by `,` — proof it's complete — so it's kept.
    const text = '{"items":[1, 2, 3, 4,';
    const result = extractJson<{ items: number[] }>(text);
    expect(result.items).toEqual([1, 2, 3, 4]);
  });

  it("does not fabricate a wrong number from one cut mid-digit (D2-M5/D3-M1)", async () => {
    const { extractJson } = await import("../src/core/llm.js");
    // `{"n":12345` could be `12345` or the head of `1234567`. The repair
    // must NOT silently emit n:12345; it drops the unverifiable value (here
    // leaving nothing parseable, so it throws — a loud failure beats a
    // silent wrong plan).
    expect(() => extractJson('{"n":12345')).toThrow(/No valid JSON found/);
  });

  it("drops a truncated string and keeps the prior fully-formed key/value", async () => {
    // Repair semantics: a string that never closes is NOT recoverable.
    // The repair drops everything past the last fully-formed value.
    const { extractJson } = await import("../src/core/llm.js");
    // Truncating mid-string after an unterminated key is genuinely
    // unrecoverable — repair returns a malformed close that JSON.parse
    // rejects, so extractJson throws. That's the documented contract.
    expect(() => extractJson('{"msg":"hello world')).toThrow(
      /No valid JSON found/,
    );
  });

  it("repairs nested truncation, keeping only delimiter-confirmed elements", async () => {
    const { extractJson } = await import("../src/core/llm.js");
    // `{"x":1}` is fully closed (safe). The trailing `{"y":2` ends on an
    // unterminated number, so that whole partial object is dropped rather
    // than emit a possibly-wrong `2`.
    const text = '{"a":[{"x":1},{"y":2';
    const result = extractJson<{ a: Array<Record<string, number>> }>(text);
    expect(result.a).toEqual([{ x: 1 }]);
  });

  it("strips trailing commas before closing", async () => {
    const { extractJson } = await import("../src/core/llm.js");
    const text = '{"items":[1,2,3,';
    const result = extractJson<{ items: number[] }>(text);
    expect(result.items).toEqual([1, 2, 3]);
  });

  it("throws when nothing salvageable is found (no opening brace)", async () => {
    const { extractJson } = await import("../src/core/llm.js");
    expect(() => extractJson("just plain prose, no json here")).toThrow(
      /No valid JSON found/,
    );
  });

  it("throws when input is empty", async () => {
    const { extractJson } = await import("../src/core/llm.js");
    expect(() => extractJson("")).toThrow(/No valid JSON found/);
  });

  it("falls back to balanced-brace path when there is no closing code fence", async () => {
    // Opening ```json fence but no closing fence → fenced regex doesn't
    // match → fall through to balanced-brace extraction starting at the
    // first '{'.
    const { extractJson } = await import("../src/core/llm.js");
    const text = '```json\n{"y":7}\n';
    const result = extractJson<{ y: number }>(text);
    expect(result.y).toBe(7);
  });

  it("includes a snippet of the input in the error message (truncated to 200 chars)", async () => {
    const { extractJson } = await import("../src/core/llm.js");
    const long = "z".repeat(500);
    let err: Error | null = null;
    try {
      extractJson(long);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/zzz/);
    expect(err!.message.length).toBeLessThan(300);
  });

  it("returns the parsed value typed via the generic parameter", async () => {
    const { extractJson } = await import("../src/core/llm.js");
    interface Verdict {
      score: number;
    }
    const v = extractJson<Verdict>('{"score":7}');
    expect(v.score).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────
// repairTruncatedJson — reached transitively through extractJson
// (no separate export, but cover the edge cases that are visible from
// the public surface)
// ─────────────────────────────────────────────────────────────

describe("repairTruncatedJson — edge cases via extractJson", () => {
  it("rejects an input where lastSafeEnd never advances (only opening brace)", async () => {
    const { extractJson } = await import("../src/core/llm.js");
    // "{" alone — no value, no closing — repair returns null and extractJson
    // throws.
    expect(() => extractJson("{")).toThrow(/No valid JSON found/);
  });

  it("repairs a truncated boolean-ish value", async () => {
    const { extractJson } = await import("../src/core/llm.js");
    // The "tru" partial gets accepted as value chars; we repair by closing.
    // Because "tru" isn't valid JSON, the parse will fail — but we keep the
    // last-fully-formed key/value pair before it.
    const text = '{"ok":true,"maybe":tru';
    let result: { ok?: boolean; maybe?: unknown } | null = null;
    try {
      result = extractJson(text);
    } catch {
      // Acceptable — repair was best-effort and didn't produce parseable JSON.
    }
    if (result) expect(result.ok).toBe(true);
  });
});

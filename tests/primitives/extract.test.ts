/**
 * Tests for the `extract` primitive (N-4).
 *
 * Three layers (mirrors see.test.ts / act.test.ts):
 *   1. Unit tests for the JSON Schema → Zod converter — pure function, fast.
 *   2. Unit tests with the `_openStagehand` / `_callExtract` test seams.
 *      Verify schema field plumbing, instruction synthesis, error paths,
 *      cost-from-metrics tracking, BudgetExceeded handling, artifacts
 *      isolation, env override.
 *   3. Integration test with real Chromium + fixture site — exercises the
 *      navigation / DOM-summary / screenshot / data-artifact path with
 *      the LLM call stubbed via `_callExtract` (no real Stagehand spin).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser } from "playwright";
import { z } from "zod";

import {
  extract,
  defaultArtifactsRoot,
  jsonSchemaToZod,
  synthesizeInstruction,
  DEFAULT_PERSONA_ID,
  DEFAULT_MODEL,
  type ExtractCallArgs,
  type ExtractCallFn,
  type ExtractOptions,
  type OpenedExtractor,
  type StagehandOpenFn,
  type StagehandMetricsSnapshot,
} from "../../src/core/primitives/extract.js";
import { startFixtureServer, type FixtureServer } from "../fixtures/test-site/server.js";
import type { ConsoleError } from "../../src/core/types.js";
import { RESULT_SCHEMA_VERSION } from "../../src/core/result-schema.js";
import {
  _resetCostGuardForTests,
  BudgetExceededError,
} from "../../src/core/cost-guard.js";

// ─────────────────────────────────────────────────────────────
// Test fakes
// ─────────────────────────────────────────────────────────────

interface FakePageState {
  url: string;
  title: string;
  consoleErrors: ConsoleError[];
}

function makeTinyPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  );
}

function makeFakePage(state: FakePageState): import("playwright").Page {
  const page = {
    url: () => state.url,
    title: async () => state.title,
    goto: async (url: string) => {
      state.url = url;
    },
    screenshot: async () => makeTinyPng(),
    evaluate: async () => {
      return {
        title: state.title,
        elements:
          "[Headings]\nh1: Pricing\n\n[Interactive Elements] (3)\n<a href=\"#\">Free</a>\n<a href=\"#\">Pro</a>\n<a href=\"#\">Max</a>",
        totalInteractive: 3,
        headings: "h1: Pricing",
        textContent: "Pricing page text",
      } as unknown;
    },
    on: () => undefined,
  } as unknown as import("playwright").Page;
  return page;
}

interface FakeOpenArgs {
  url?: string;
  title?: string;
  consoleErrors?: ConsoleError[];
  /** If set, the fake extract call returns this. */
  extractData?: unknown;
  /** If set, the fake extract call rejects with this error. */
  extractError?: Error;
  /** Tokens consumed by the simulated extract call. */
  inTokens?: number;
  outTokens?: number;
  /** Force open() to throw before returning. */
  openError?: Error;
}

function fakeOpenStagehand(args: FakeOpenArgs = {}): {
  open: StagehandOpenFn;
  state: FakePageState;
  /** Args captured every time the extract method is called. */
  extractCalls: ExtractCallArgs[];
} {
  const state: FakePageState = {
    url: args.url ?? "https://target.example/",
    title: args.title ?? "Fake Pricing Page",
    consoleErrors: args.consoleErrors ?? [],
  };
  const extractCalls: ExtractCallArgs[] = [];
  const inTokens = args.inTokens ?? 0;
  const outTokens = args.outTokens ?? 0;
  let metrics: StagehandMetricsSnapshot = {
    extractPromptTokens: 0,
    extractCompletionTokens: 0,
  };
  const open: StagehandOpenFn = async () => {
    if (args.openError) throw args.openError;
    const page = makeFakePage(state);
    const extract: ExtractCallFn = async (a) => {
      extractCalls.push(a);
      // Bump metrics like Stagehand would.
      metrics = {
        extractPromptTokens: metrics.extractPromptTokens + inTokens,
        extractCompletionTokens: metrics.extractCompletionTokens + outTokens,
      };
      if (args.extractError) throw args.extractError;
      return args.extractData ?? {};
    };
    return {
      page,
      context: null,
      consoleErrors: state.consoleErrors,
      extract,
      readMetrics: () => ({ ...metrics }),
      close: async () => {},
    } satisfies OpenedExtractor;
  };
  return { open, state, extractCalls };
}

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "extract-test-"));
  _resetCostGuardForTests();
});

afterEach(() => {
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ─────────────────────────────────────────────────────────────
// JSON Schema → Zod
// ─────────────────────────────────────────────────────────────

describe("jsonSchemaToZod — supported subset", () => {
  it("converts a simple object with primitive fields", () => {
    const z1 = jsonSchemaToZod({
      type: "object",
      properties: {
        name: { type: "string" },
        price: { type: "number" },
        active: { type: "boolean" },
      },
      required: ["name", "price", "active"],
    });
    expect(() => z1.parse({ name: "Pro", price: 29, active: true })).not.toThrow();
    expect(() => z1.parse({ name: "Pro", price: 29 })).toThrow();
  });

  it("makes properties not in `required` optional", () => {
    const z1 = jsonSchemaToZod({
      type: "object",
      properties: {
        name: { type: "string" },
        tagline: { type: "string" },
      },
      required: ["name"],
    });
    expect(() => z1.parse({ name: "Pro" })).not.toThrow();
    expect(() => z1.parse({ name: "Pro", tagline: "best plan" })).not.toThrow();
    expect(() => z1.parse({})).toThrow();
  });

  it("converts nested objects and arrays of objects", () => {
    const z1 = jsonSchemaToZod({
      type: "object",
      properties: {
        plans: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              features: { type: "array", items: { type: "string" } },
            },
            required: ["name", "features"],
          },
        },
      },
      required: ["plans"],
    });
    expect(() =>
      z1.parse({
        plans: [
          { name: "Free", features: ["a"] },
          { name: "Pro", features: ["a", "b"] },
        ],
      }),
    ).not.toThrow();
  });

  it("converts integer to z.number().int()", () => {
    const z1 = jsonSchemaToZod({
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
    });
    expect(() => z1.parse({ count: 42 })).not.toThrow();
    expect(() => z1.parse({ count: 1.5 })).toThrow();
  });

  it("converts string-only enum to z.enum", () => {
    const z1 = jsonSchemaToZod({
      type: "object",
      properties: { tier: { enum: ["free", "pro", "max"] } },
      required: ["tier"],
    });
    expect(() => z1.parse({ tier: "pro" })).not.toThrow();
    expect(() => z1.parse({ tier: "ultra" })).toThrow();
  });

  it("converts mixed enum (numbers / booleans) to z.union of literals", () => {
    const z1 = jsonSchemaToZod({
      type: "object",
      properties: { discount: { enum: [0, 10, 25, 50] } },
      required: ["discount"],
    });
    expect(() => z1.parse({ discount: 25 })).not.toThrow();
    expect(() => z1.parse({ discount: 30 })).toThrow();
  });

  it("supports nullable via OpenAPI-style nullable: true", () => {
    const z1 = jsonSchemaToZod({
      type: "object",
      properties: { tagline: { type: "string", nullable: true } },
      required: ["tagline"],
    });
    expect(() => z1.parse({ tagline: "yo" })).not.toThrow();
    expect(() => z1.parse({ tagline: null })).not.toThrow();
  });

  it("supports nullable via type: ['string', 'null'] shorthand", () => {
    const z1 = jsonSchemaToZod({
      type: "object",
      properties: { tagline: { type: ["string", "null"] } },
      required: ["tagline"],
    });
    expect(() => z1.parse({ tagline: null })).not.toThrow();
    expect(() => z1.parse({ tagline: "ok" })).not.toThrow();
  });

  it("preserves description annotations onto the Zod field (helps LLM prompt quality)", () => {
    const z1 = jsonSchemaToZod({
      type: "object",
      properties: { price: { type: "number", description: "Monthly price in USD" } },
      required: ["price"],
    });
    // Zod stores `description` on the underlying ZodType definition.
    const desc = (z1.shape.price._def as { description?: string }).description;
    expect(desc).toBe("Monthly price in USD");
  });

  it("accepts a bare { properties: {...} } as shorthand for type: object", () => {
    const z1 = jsonSchemaToZod({
      properties: { x: { type: "string" } },
      required: ["x"],
    });
    expect(() => z1.parse({ x: "hi" })).not.toThrow();
  });

  it("ignores accepted-but-unused keywords (pattern, minLength, title, default)", () => {
    const z1 = jsonSchemaToZod({
      type: "object",
      properties: {
        name: {
          type: "string",
          pattern: "^[A-Z]+$",
          minLength: 1,
          title: "Name",
          default: "Anon",
        },
      },
      required: ["name"],
    });
    // pattern is intentionally not enforced — the LLM does the matching.
    expect(() => z1.parse({ name: "lowercase" })).not.toThrow();
  });
});

describe("jsonSchemaToZod — rejected inputs", () => {
  it("rejects non-object root", () => {
    expect(() => jsonSchemaToZod(null as unknown)).toThrow(/JSON Schema object/);
    expect(() => jsonSchemaToZod("hello" as unknown)).toThrow();
    expect(() => jsonSchemaToZod([1, 2, 3] as unknown)).toThrow();
  });

  it("rejects root with non-object type", () => {
    expect(() => jsonSchemaToZod({ type: "string" })).toThrow(
      /root schema must have type "object"/,
    );
    expect(() => jsonSchemaToZod({ type: "array", items: { type: "string" } })).toThrow(
      /root schema must have type "object"/,
    );
  });

  it("rejects oneOf / anyOf / allOf / not / $ref / const at any depth", () => {
    for (const bad of [
      { type: "object", properties: { x: { oneOf: [{ type: "string" }] } } },
      { type: "object", properties: { x: { anyOf: [{ type: "string" }] } } },
      { type: "object", properties: { x: { allOf: [{ type: "string" }] } } },
      { type: "object", properties: { x: { not: { type: "string" } } } },
      { type: "object", properties: { x: { $ref: "#/defs/Foo" } } },
      { type: "object", properties: { x: { const: 5 } } },
    ]) {
      expect(() => jsonSchemaToZod(bad)).toThrow(/unsupported JSON Schema keyword/);
    }
  });

  it("rejects array without items", () => {
    expect(() =>
      jsonSchemaToZod({
        type: "object",
        properties: { tags: { type: "array" } },
        required: ["tags"],
      }),
    ).toThrow(/requires an "items" schema/);
  });

  it("rejects empty enum", () => {
    expect(() =>
      jsonSchemaToZod({
        type: "object",
        properties: { x: { enum: [] } },
        required: ["x"],
      }),
    ).toThrow(/enum at .* must have at least one value/);
  });

  it("rejects unknown type names", () => {
    expect(() =>
      jsonSchemaToZod({
        type: "object",
        properties: { x: { type: "wibble" } },
        required: ["x"],
      }),
    ).toThrow(/unsupported type "wibble"/);
  });

  it("rejected error path includes a useful path locator", () => {
    let err: Error | undefined;
    try {
      jsonSchemaToZod({
        type: "object",
        properties: {
          plans: {
            type: "array",
            items: {
              type: "object",
              properties: { discount: { oneOf: [{ type: "number" }] } },
            },
          },
        },
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/plans\[\]\.discount/);
  });
});

// ─────────────────────────────────────────────────────────────
// Instruction synthesis
// ─────────────────────────────────────────────────────────────

describe("synthesizeInstruction", () => {
  it("lists top-level fields when no descriptions are given", () => {
    const out = synthesizeInstruction({
      type: "object",
      properties: { name: { type: "string" }, price: { type: "number" } },
    });
    expect(out).toMatch(/name/);
    expect(out).toMatch(/price/);
  });

  it("includes description hint per field when present", () => {
    const out = synthesizeInstruction({
      type: "object",
      properties: {
        price: { type: "number", description: "Monthly price in USD" },
      },
    });
    expect(out).toContain("price (Monthly price in USD)");
  });

  it("falls back to a generic instruction when properties is empty / missing", () => {
    expect(synthesizeInstruction({})).toMatch(/Extract structured data/);
    expect(synthesizeInstruction(undefined)).toMatch(/Extract structured data/);
  });
});

// ─────────────────────────────────────────────────────────────
// Schema field plumbing
// ─────────────────────────────────────────────────────────────

describe("extract — schema field plumbing", () => {
  it("returns a schema-stamped result with engine='stagehand' on success", async () => {
    const { open } = fakeOpenStagehand({
      url: "https://target/",
      title: "Pricing",
      extractData: { plans: [{ name: "Pro", price: 29 }] },
    });
    const r = await extract({
      url: "https://target/",
      schema: {
        type: "object",
        properties: {
          plans: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, price: { type: "number" } },
              required: ["name", "price"],
            },
          },
        },
        required: ["plans"],
      },
      artifactsRoot: workspace,
      _openStagehand: open,
    });
    expect(r.schema_version).toBe(RESULT_SCHEMA_VERSION);
    expect(r.engine).toBe("stagehand");
    expect(r.url_input).toBe("https://target/");
    expect(r.url_final).toBe("https://target/");
    expect(r.title).toBe("Pricing");
    expect(r.status).toBe("ok");
    expect(r.persona_id).toBe(DEFAULT_PERSONA_ID);
    expect(r.cost_usd).toBe(0);
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
    expect(r.data).toEqual({ plans: [{ name: "Pro", price: 29 }] });
    expect(r.dom).not.toBeNull();
    expect(r.console).not.toBeNull();
    expect(r.screenshot).not.toBeNull();
    expect(r.screenshot!.path).toContain(workspace);
    expect(fs.existsSync(r.screenshot!.path)).toBe(true);
  });

  it("uses persona viewport / locale / timezone / id when provided", async () => {
    const { open } = fakeOpenStagehand({});
    const r = await extract({
      url: "https://x/",
      schema: { type: "object", properties: { x: { type: "string" } } },
      artifactsRoot: workspace,
      persona: {
        id: "uk-power",
        viewport: { width: 1920, height: 1080 },
        locale: "en-GB",
        timezone: "Europe/London",
      },
      _openStagehand: open,
    });
    expect(r.persona_id).toBe("uk-power");
    expect(r.screenshot!.width).toBe(1920);
    expect(r.screenshot!.height).toBe(1080);
  });

  it("nullifies dom and console when toggles off; still always takes final screenshot", async () => {
    const { open } = fakeOpenStagehand({});
    const r = await extract({
      url: "https://x/",
      artifactsRoot: workspace,
      includeDom: false,
      includeConsole: false,
      _openStagehand: open,
    });
    expect(r.dom).toBeNull();
    expect(r.console).toBeNull();
    expect(r.screenshot).not.toBeNull();
  });

  it("echoes back schema_used / instruction_used / selector_used for caller debugging", async () => {
    const { open } = fakeOpenStagehand({ extractData: {} });
    const inputSchema = {
      type: "object" as const,
      properties: { tagline: { type: "string" as const } },
    };
    const r = await extract({
      url: "https://x/",
      schema: inputSchema,
      instruction: "Find the hero tagline",
      selector: "main.hero",
      artifactsRoot: workspace,
      _openStagehand: open,
    });
    expect(r.schema_used).toBe(inputSchema);
    expect(r.instruction_used).toBe("Find the hero tagline");
    expect(r.selector_used).toBe("main.hero");
  });
});

// ─────────────────────────────────────────────────────────────
// Extract dispatch + auto-instruction synthesis
// ─────────────────────────────────────────────────────────────

describe("extract — dispatch", () => {
  it("auto-synthesises an instruction from the schema when caller omits one", async () => {
    const { open, extractCalls } = fakeOpenStagehand({});
    await extract({
      url: "https://x/",
      schema: {
        type: "object",
        properties: { name: { type: "string" }, price: { type: "number" } },
      },
      artifactsRoot: workspace,
      _openStagehand: open,
    });
    expect(extractCalls).toHaveLength(1);
    expect(extractCalls[0]!.instruction).toMatch(/name/);
    expect(extractCalls[0]!.instruction).toMatch(/price/);
    expect(extractCalls[0]!.schema).toBeInstanceOf(z.ZodObject);
  });

  it("forwards caller-provided instruction verbatim", async () => {
    const { open, extractCalls } = fakeOpenStagehand({});
    await extract({
      url: "https://x/",
      schema: { type: "object", properties: { x: { type: "string" } } },
      instruction: "MY HAND-CRAFTED INSTRUCTION",
      artifactsRoot: workspace,
      _openStagehand: open,
    });
    expect(extractCalls[0]!.instruction).toBe("MY HAND-CRAFTED INSTRUCTION");
  });

  it("forwards selector for sub-region extraction", async () => {
    const { open, extractCalls } = fakeOpenStagehand({});
    await extract({
      url: "https://x/",
      schema: { type: "object", properties: { x: { type: "string" } } },
      selector: "section.pricing",
      artifactsRoot: workspace,
      _openStagehand: open,
    });
    expect(extractCalls[0]!.selector).toBe("section.pricing");
  });

  it("when schema is omitted, calls extract without a Zod schema (Stagehand default)", async () => {
    const { open, extractCalls } = fakeOpenStagehand({
      extractData: { extraction: "free-form fallback prose" },
    });
    const r = await extract({
      url: "https://x/",
      instruction: "What's the headline?",
      artifactsRoot: workspace,
      _openStagehand: open,
    });
    expect(extractCalls[0]!.schema).toBeUndefined();
    expect(extractCalls[0]!.instruction).toBe("What's the headline?");
    expect(r.data).toEqual({ extraction: "free-form fallback prose" });
  });

  it("honors _callExtract test seam, bypassing opened.extract", async () => {
    const { open } = fakeOpenStagehand({ extractData: { x: "from-opened" } });
    const calls: ExtractCallArgs[] = [];
    const seamed: ExtractCallFn = async (a) => {
      calls.push(a);
      return { x: "from-seam" };
    };
    const r = await extract({
      url: "https://x/",
      schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
      artifactsRoot: workspace,
      _openStagehand: open,
      _callExtract: seamed,
    });
    expect(calls).toHaveLength(1);
    expect(r.data).toEqual({ x: "from-seam" });
  });
});

// ─────────────────────────────────────────────────────────────
// Error paths
// ─────────────────────────────────────────────────────────────

describe("extract — error paths", () => {
  it("returns status='error' with a clear message when the JSON Schema is malformed", async () => {
    const { open, extractCalls } = fakeOpenStagehand({});
    const r = await extract({
      url: "https://x/",
      schema: {
        type: "object",
        properties: { x: { oneOf: [{ type: "string" }] } },
      },
      artifactsRoot: workspace,
      _openStagehand: open,
    });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/unsupported JSON Schema keyword "oneOf"/);
    // No Stagehand was spun up (fail-fast before the cold-start cost).
    expect(extractCalls).toHaveLength(0);
    expect(r.data).toBeNull();
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns status='error' when page.extract throws (LLM failure / target down)", async () => {
    const { open } = fakeOpenStagehand({
      extractError: new Error("LLM provider 503"),
    });
    const r = await extract({
      url: "https://x/",
      schema: { type: "object", properties: { x: { type: "string" } } },
      artifactsRoot: workspace,
      _openStagehand: open,
    });
    expect(r.status).toBe("error");
    expect(r.error).toBe("LLM provider 503");
    // We still capture envelope side-effects (DOM / console / screenshot)
    // because the page is loaded — only the LLM call failed.
    expect(r.dom).not.toBeNull();
    expect(r.screenshot).not.toBeNull();
  });

  it("returns status='error' with the open error when navigation / Stagehand init fails", async () => {
    const { open } = fakeOpenStagehand({
      openError: new Error("net::ERR_NAME_NOT_RESOLVED"),
    });
    const r = await extract({
      url: "https://does-not-exist.local/",
      schema: { type: "object", properties: { x: { type: "string" } } },
      artifactsRoot: workspace,
      _openStagehand: open,
    });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/ERR_NAME_NOT_RESOLVED/);
    expect(r.dom).toBeNull();
    expect(r.console).toBeNull();
    expect(r.screenshot).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// Cost tracking via Stagehand metrics
// ─────────────────────────────────────────────────────────────

describe("extract — cost tracking", () => {
  it("reports cost_usd derived from Stagehand metrics delta when tokens are consumed", async () => {
    const { open } = fakeOpenStagehand({
      extractData: { x: "ok" },
      inTokens: 1000,
      outTokens: 200,
    });
    const r = await extract({
      url: "https://x/",
      schema: { type: "object", properties: { x: { type: "string" } } },
      artifactsRoot: workspace,
      model: "claude-sonnet-4-6",
      _openStagehand: open,
    });
    // claude-sonnet-4-6: 3 in / 15 out per million.
    // 1000 * 3 + 200 * 15 = 3000 + 3000 = 6000 micro-usd = 0.006 USD
    expect(r.cost_usd).toBeCloseTo(0.006, 6);
    expect(r.status).toBe("ok");
  });

  it("reports cost_usd = 0 when metrics did not move (LLM never ran)", async () => {
    const { open } = fakeOpenStagehand({
      extractError: new Error("instant fail before LLM"),
      inTokens: 0,
      outTokens: 0,
    });
    const r = await extract({
      url: "https://x/",
      schema: { type: "object", properties: { x: { type: "string" } } },
      artifactsRoot: workspace,
      _openStagehand: open,
    });
    expect(r.cost_usd).toBe(0);
    expect(r.status).toBe("error");
  });

  it("flips status='error' when recordUsage trips a budget cap, but still surfaces data and cost", async () => {
    process.env.AUDIT_COST_MAX_RUN_USD = "0.001"; // very tight
    process.env.AUDIT_COST_GUARD_DISABLED = "0";
    _resetCostGuardForTests();
    try {
      const { open } = fakeOpenStagehand({
        extractData: { x: "from-llm" },
        inTokens: 1000,
        outTokens: 200, // 0.006 USD — well over 0.001 cap
      });
      const r = await extract({
        url: "https://x/",
        schema: { type: "object", properties: { x: { type: "string" } } },
        artifactsRoot: workspace,
        model: "claude-sonnet-4-6",
        _openStagehand: open,
      });
      expect(r.status).toBe("error");
      expect(r.error).toMatch(/run-usd|budget exceeded/i);
      expect(r.data).toEqual({ x: "from-llm" });
      expect(r.cost_usd).toBeCloseTo(0.006, 6);
    } finally {
      delete process.env.AUDIT_COST_MAX_RUN_USD;
      delete process.env.AUDIT_COST_GUARD_DISABLED;
      _resetCostGuardForTests();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Artifacts uniqueness + env override
// ─────────────────────────────────────────────────────────────

describe("extract — artifacts dir uniqueness + env override", () => {
  it("creates a unique subdirectory per call (parallel-safe)", async () => {
    const { open: openA } = fakeOpenStagehand({});
    const { open: openB } = fakeOpenStagehand({});
    const a = await extract({
      url: "https://x/",
      artifactsRoot: workspace,
      _openStagehand: openA,
    });
    const b = await extract({
      url: "https://x/",
      artifactsRoot: workspace,
      _openStagehand: openB,
    });
    expect(a.artifacts_dir).not.toBe(b.artifacts_dir);
    expect(fs.existsSync(a.artifacts_dir)).toBe(true);
    expect(fs.existsSync(b.artifacts_dir)).toBe(true);
  });

  it("honors AUDIT_EXTRACTS_DIR env override via defaultArtifactsRoot", () => {
    const prev = process.env.AUDIT_EXTRACTS_DIR;
    try {
      process.env.AUDIT_EXTRACTS_DIR = "/tmp/test-extracts-override";
      expect(defaultArtifactsRoot()).toBe("/tmp/test-extracts-override");
    } finally {
      if (prev === undefined) delete process.env.AUDIT_EXTRACTS_DIR;
      else process.env.AUDIT_EXTRACTS_DIR = prev;
    }
  });

  it("falls back to ~/.pixelcheck/extracts when no env override is set", () => {
    const prev = process.env.AUDIT_EXTRACTS_DIR;
    const prevHome = process.env.PIXELCHECK_HOME;
    const prevLegacyHome = process.env.AUDIT_HOME;
    try {
      delete process.env.AUDIT_EXTRACTS_DIR;
      delete process.env.PIXELCHECK_HOME;
      delete process.env.AUDIT_HOME;
      const root = defaultArtifactsRoot();
      expect(root.endsWith(path.join(".pixelcheck", "extracts"))).toBe(true);
    } finally {
      if (prev !== undefined) process.env.AUDIT_EXTRACTS_DIR = prev;
      if (prevHome !== undefined) process.env.PIXELCHECK_HOME = prevHome;
      if (prevLegacyHome !== undefined) process.env.AUDIT_HOME = prevLegacyHome;
    }
  });

  it("writes data.json artifact alongside the screenshot for replay / debug", async () => {
    const { open } = fakeOpenStagehand({
      extractData: { plans: [{ name: "Pro", price: 29 }] },
    });
    const r = await extract({
      url: "https://x/",
      schema: { type: "object", properties: { x: { type: "string" } } },
      artifactsRoot: workspace,
      _openStagehand: open,
    });
    const dataPath = path.join(r.artifacts_dir, "data.json");
    expect(fs.existsSync(dataPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    expect(parsed).toEqual({ plans: [{ name: "Pro", price: 29 }] });
  });
});

// ─────────────────────────────────────────────────────────────
// DEFAULT_MODEL surface
// ─────────────────────────────────────────────────────────────

describe("extract — defaults", () => {
  it("DEFAULT_MODEL is a known PRICING entry (claude-sonnet-4-6)", () => {
    expect(DEFAULT_MODEL).toBe("claude-sonnet-4-6");
  });
});

// ─────────────────────────────────────────────────────────────
// Integration test — real Chromium + fixture site (LLM stubbed)
// ─────────────────────────────────────────────────────────────

describe("extract — integration (real Chromium + fixture site, stubbed LLM)", () => {
  let fixture: FixtureServer;
  let intWorkspace: string;
  let warmBrowser: Browser | null = null;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    intWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "extract-int-"));
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

  /**
   * Minimal Stagehand-shaped open that uses real Chromium to load the
   * fixture page (so we exercise navigation + DOM extraction + screenshot
   * for real) but stubs `extract()` so no LLM is ever called.
   */
  function realChromiumStubExtract(extracted: unknown): {
    open: StagehandOpenFn;
    /** Invocation count of the stubbed extract. */
    count: () => number;
  } {
    let calls = 0;
    let metrics: StagehandMetricsSnapshot = {
      extractPromptTokens: 0,
      extractCompletionTokens: 0,
    };
    const open: StagehandOpenFn = async (cfg) => {
      const browser = await chromium.launch({ headless: cfg.headless });
      const context = await browser.newContext({
        viewport: cfg.viewport,
        locale: cfg.locale,
        timezoneId: cfg.timezone,
        userAgent: cfg.userAgent,
      });
      const page = await context.newPage();
      const consoleErrors: ConsoleError[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          consoleErrors.push({
            type: "console",
            text: msg.text(),
            location: msg.location()?.url,
            timestamp: new Date().toISOString(),
          });
        }
      });
      await page.goto(cfg.url, {
        waitUntil:
          cfg.waitFor === "load" ||
          cfg.waitFor === "domcontentloaded" ||
          cfg.waitFor === "networkidle"
            ? cfg.waitFor
            : "domcontentloaded",
        timeout: cfg.timeoutMs,
      });
      return {
        page,
        context,
        consoleErrors,
        extract: async () => {
          calls++;
          metrics = {
            extractPromptTokens: metrics.extractPromptTokens + 800,
            extractCompletionTokens: metrics.extractCompletionTokens + 100,
          };
          return extracted;
        },
        readMetrics: () => ({ ...metrics }),
        close: async () => {
          try {
            await context.close();
          } catch {
            // ignore
          }
          try {
            await browser.close();
          } catch {
            // ignore
          }
        },
      };
    };
    return { open, count: () => calls };
  }

  it("loads the fixture page, runs the (stubbed) LLM extract, persists data.json + screenshot", async () => {
    if (!warmBrowser) {
      // Skip when Chromium isn't installed.
      return;
    }
    const expected = { headline: "AV Fixture Site", links_count: 5 };
    const { open, count } = realChromiumStubExtract(expected);
    const opts: ExtractOptions = {
      url: `${fixture.url}/index.html`,
      schema: {
        type: "object",
        properties: {
          headline: { type: "string" },
          links_count: { type: "integer" },
        },
        required: ["headline", "links_count"],
      },
      artifactsRoot: intWorkspace,
      waitFor: "domcontentloaded",
      timeoutMs: 15000,
      _openStagehand: open,
    };
    const r = await extract(opts);
    expect(count()).toBe(1);
    expect(r.status).toBe("ok");
    expect(r.engine).toBe("stagehand");
    expect(r.title).toContain("AV Fixture");
    expect(r.data).toEqual(expected);
    expect(r.dom).not.toBeNull();
    expect(r.dom!.interactive_count).toBeGreaterThan(0);
    expect(r.screenshot).not.toBeNull();
    expect(fs.existsSync(r.screenshot!.path)).toBe(true);
    expect(fs.statSync(r.screenshot!.path).size).toBeGreaterThan(100);
    const dataPath = path.join(r.artifacts_dir, "data.json");
    expect(fs.existsSync(dataPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(dataPath, "utf8"))).toEqual(expected);
    // 800 in + 100 out tokens at sonnet pricing = 800*3 + 100*15 = 3900 micro-usd
    expect(r.cost_usd).toBeCloseTo(0.0039, 6);
  }, 30_000);
});

// Suppress unused-warning for BudgetExceededError import since it's only
// referenced via instanceof within the primitive itself; the test
// observes the symptom (status='error' + matching message), not the
// type.
void BudgetExceededError;

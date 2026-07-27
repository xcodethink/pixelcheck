/**
 * Coverage for the M9-5 `list_capabilities` MCP self-describe tool.
 *
 * Layers:
 *   1. `buildCapabilities` projection — registry → snake_case JSON,
 *      schema-valid, idempotent for the same input.
 *   2. handler smoke — dispatched through the registry produces a
 *      stamped ToolResult whose body parses against
 *      ListCapabilitiesResultSchema and contains exactly the shipped
 *      tools.
 *   3. envelope completeness — every shipped tool appears with the
 *      M9-4 cacheable matrix preserved; the env table covers every
 *      env var the codebase actually reads at runtime; no secret
 *      VALUE leaks anywhere in the output (only names).
 *   4. live cache reflection — toggling AUDIT_RESULT_CACHE_DISABLED
 *      flips the `cache.enabled` flag; per-call TTL override surfaces
 *      in `cache.ttl_ms_default` when set.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";

import {
  ListCapabilitiesResultSchema,
  RESULT_SCHEMA_VERSION,
} from "../src/core/result-schema.js";
import { ALL_TOOLS, buildDefaultRegistry } from "../src/mcp/server.js";
import {
  buildCapabilities,
  listCapabilitiesTool,
} from "../src/mcp/tools/list-capabilities.js";

// ─────────────────────────────────────────────────────────────
// 1. buildCapabilities projection
// ─────────────────────────────────────────────────────────────

describe("buildCapabilities — registry projection", () => {
  it("emits one row per shipped tool in the exact order of ALL_TOOLS", () => {
    const out = buildCapabilities(ALL_TOOLS) as { tools: Array<{ name: string }> };
    expect(out.tools.map((t) => t.name)).toEqual(ALL_TOOLS.map((t) => t.name));
  });

  it("each row mirrors ToolDefinition fields with snake_case keys", () => {
    const out = buildCapabilities(ALL_TOOLS) as {
      tools: Array<Record<string, unknown>>;
    };
    for (let i = 0; i < ALL_TOOLS.length; i++) {
      const def = ALL_TOOLS[i]!;
      const row = out.tools[i]!;
      expect(row.name).toBe(def.name);
      expect(row.description).toBe(def.description);
      expect(row.kind).toBe(def.kind);
      expect(row.input_schema).toBe(def.inputSchema);
      expect(row.cacheable).toBe(def.cacheable);
      expect((row.cost_estimate_usd as { typical: number }).typical).toBe(
        def.costEstimateUsd.typical,
      );
      expect((row.cost_estimate_usd as { unit: string }).unit).toBe(
        def.costEstimateUsd.unit,
      );
      expect(row.side_effects).toEqual([...def.sideEffects]);
      expect((row.requires as { browser: boolean }).browser).toBe(
        def.requires.browser,
      );
      expect((row.requires as { api_keys: string[] }).api_keys).toEqual(
        def.requires.apiKeys,
      );
    }
  });

  it("omits result_schema when the source resultSchema is unset", () => {
    // Synthesise a fake catalog with one tool missing resultSchema.
    const fake = [
      ...ALL_TOOLS,
      {
        name: "_test_no_schema",
        description: "test",
        kind: "meta" as const,
        inputSchema: { type: "object", properties: {} },
        cacheable: false,
        costEstimateUsd: { typical: 0, min: 0, max: 0, unit: "per_call" as const },
        sideEffects: ["fs_reads"] as const,
        requires: { apiKeys: [], browser: false },
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
    ];
    const out = buildCapabilities(fake) as { tools: Array<Record<string, unknown>> };
    const last = out.tools.at(-1)!;
    expect("result_schema" in last).toBe(false);
  });

  it("output validates against ListCapabilitiesResultSchema after schema_version stamp", () => {
    const stamped = {
      schema_version: RESULT_SCHEMA_VERSION,
      ...(buildCapabilities(ALL_TOOLS) as Record<string, unknown>),
    };
    expect(() => ListCapabilitiesResultSchema.parse(stamped)).not.toThrow();
  });

  it("personas_dir / scenarios_dir only appear when the source declares them", () => {
    const out = buildCapabilities(ALL_TOOLS) as {
      tools: Array<{ name: string; requires: Record<string, unknown> }>;
    };
    const personas = out.tools.find((t) => t.name === "list_personas")!;
    expect(personas.requires.personas_dir).toBe(true);

    const scenarios = out.tools.find((t) => t.name === "list_scenarios")!;
    expect(scenarios.requires.scenarios_dir).toBe(true);

    // see / act / extract / judge / compare don't declare these — fields absent
    const see = out.tools.find((t) => t.name === "see")!;
    expect("personas_dir" in see.requires).toBe(false);
    expect("scenarios_dir" in see.requires).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 2. handler smoke — full registry dispatch
// ─────────────────────────────────────────────────────────────

describe("listCapabilitiesTool — registry dispatch", () => {
  it("is registered as a meta tool with the right name", () => {
    expect(listCapabilitiesTool.name).toBe("list_capabilities");
    expect(listCapabilitiesTool.kind).toBe("meta");
    expect(listCapabilitiesTool.cacheable).toBe(false);
    expect(listCapabilitiesTool.requires.browser).toBe(false);
    expect(listCapabilitiesTool.requires.apiKeys).toEqual([]);
  });

  it("dispatching through the registry returns a ListCapabilitiesResult body", async () => {
    const r = buildDefaultRegistry();
    const tool = r.get("list_capabilities");
    expect(tool).toBeDefined();

    const result = await tool!.handler({});
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    const text = result.content[0]!.text;
    const parsed = JSON.parse(text);
    expect(() => ListCapabilitiesResultSchema.parse(parsed)).not.toThrow();
    expect(parsed.schema_version).toBe(RESULT_SCHEMA_VERSION);
    expect(parsed.tools.map((t: { name: string }) => t.name)).toEqual(
      ALL_TOOLS.map((t) => t.name),
    );
  });

  it("ignores any args (input schema declares no properties)", async () => {
    const r = buildDefaultRegistry();
    const tool = r.get("list_capabilities")!;
    const a = JSON.parse((await tool.handler({})).content[0]!.text);
    const b = JSON.parse(
      (await tool.handler({ junk: 42, irrelevant: "no-op" })).content[0]!.text,
    );
    expect(a.tools.length).toBe(b.tools.length);
    expect(a.server).toEqual(b.server);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. envelope completeness — coverage + secret-leak
// ─────────────────────────────────────────────────────────────

describe("listCapabilitiesTool — envelope completeness", () => {
  it("env table includes every audit-prefix env var the codebase reads", () => {
    // Static set: one row per AUDIT_* / LOG_* / ANTHROPIC_* env var that
    // appears anywhere in src/. Adding a new env var to a primitive must
    // include adding a row to envTable() in list-capabilities.ts so this
    // assertion forces the contract to stay in sync.
    const required = [
      "ANTHROPIC_API_KEY",
      "AUDIT_RESULT_CACHE_PATH",
      "AUDIT_RESULT_CACHE_TTL_MS",
      "AUDIT_RESULT_CACHE_DISABLED",
      "AUDIT_COST_LEDGER_PATH",
      "AUDIT_COST_MAX_RUN_USD",
      "AUDIT_COST_MAX_DAILY_USD",
      "AUDIT_COST_GUARD_DISABLED",
      "AUDIT_SEES_DIR",
      "AUDIT_ACTS_DIR",
      "AUDIT_EXTRACTS_DIR",
      "AUDIT_JUDGES_DIR",
      "AUDIT_COMPARES_DIR",
      "AUDIT_REPORTS_DIR",
      "AUDIT_MEMORY_PATH",
      "AUDIT_MEMORY_DISABLED",
      "AUDIT_PLAN_CACHE_PATH",
      "AUDIT_PLAN_CACHE_DISABLED",
      "LOG_LEVEL",
      "LOG_PRETTY",
      "LOG_FILE",
    ];
    const out = buildCapabilities(ALL_TOOLS) as {
      env: Array<{ name: string }>;
    };
    const names = new Set(out.env.map((e) => e.name));
    for (const r of required) {
      expect({ envName: r, present: names.has(r) }).toEqual({
        envName: r,
        present: true,
      });
    }
  });

  it("env entries name secrets but never carry their values", async () => {
    // Plant a fake secret value, run the tool, prove it never leaks.
    const fakeSecret = "sk-ant-FAKE-LEAK-SENTINEL-VALUE-9876543210";
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = fakeSecret;
    try {
      const tool = buildDefaultRegistry().get("list_capabilities")!;
      const text = (await tool.handler({})).content[0]!.text;
      expect(text.includes(fakeSecret)).toBe(false);
      // Sanity check: ANTHROPIC_API_KEY *name* should still be there.
      expect(text.includes("ANTHROPIC_API_KEY")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it("server identity matches the MCP server constants", () => {
    const out = buildCapabilities(ALL_TOOLS) as {
      server: { name: string; version: string };
      result_schema_version: string;
    };
    expect(out.server.name).toBe("pixelcheck");
    expect(out.server.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(out.result_schema_version).toBe(RESULT_SCHEMA_VERSION);
  });

  it("every env scope appears at least once (closed enum coverage)", () => {
    const out = buildCapabilities(ALL_TOOLS) as {
      env: Array<{ scope: string }>;
    };
    const scopes = new Set(out.env.map((e) => e.scope));
    expect(scopes.has("auth")).toBe(true);
    expect(scopes.has("cache")).toBe(true);
    expect(scopes.has("cost_guard")).toBe(true);
    expect(scopes.has("artifacts")).toBe(true);
    expect(scopes.has("logging")).toBe(true);
    expect(scopes.has("memory")).toBe(true);
    expect(scopes.has("reports")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 4. live cache reflection
// ─────────────────────────────────────────────────────────────

describe("listCapabilitiesTool — live cache reflection", () => {
  let prevDisabled: string | undefined;
  let prevTtl: string | undefined;
  beforeEach(() => {
    prevDisabled = process.env.AUDIT_RESULT_CACHE_DISABLED;
    prevTtl = process.env.AUDIT_RESULT_CACHE_TTL_MS;
  });
  afterEach(() => {
    if (prevDisabled === undefined) delete process.env.AUDIT_RESULT_CACHE_DISABLED;
    else process.env.AUDIT_RESULT_CACHE_DISABLED = prevDisabled;
    if (prevTtl === undefined) delete process.env.AUDIT_RESULT_CACHE_TTL_MS;
    else process.env.AUDIT_RESULT_CACHE_TTL_MS = prevTtl;
  });

  it("AUDIT_RESULT_CACHE_DISABLED=1 → cache.enabled=false", () => {
    process.env.AUDIT_RESULT_CACHE_DISABLED = "1";
    const out = buildCapabilities(ALL_TOOLS) as { cache: { enabled: boolean } };
    expect(out.cache.enabled).toBe(false);
  });

  it("AUDIT_RESULT_CACHE_DISABLED unset → cache.enabled=true", () => {
    delete process.env.AUDIT_RESULT_CACHE_DISABLED;
    const out = buildCapabilities(ALL_TOOLS) as { cache: { enabled: boolean } };
    expect(out.cache.enabled).toBe(true);
  });

  it("AUDIT_RESULT_CACHE_TTL_MS surfaces in cache.ttl_ms_default", () => {
    process.env.AUDIT_RESULT_CACHE_TTL_MS = "3600000"; // 1h
    const out = buildCapabilities(ALL_TOOLS) as {
      cache: { ttl_ms_default: number };
    };
    expect(out.cache.ttl_ms_default).toBe(3_600_000);
  });

  it("invalid TTL falls back to the 24h default", () => {
    process.env.AUDIT_RESULT_CACHE_TTL_MS = "not-a-number";
    const out = buildCapabilities(ALL_TOOLS) as {
      cache: { ttl_ms_default: number };
    };
    expect(out.cache.ttl_ms_default).toBe(24 * 60 * 60 * 1000);
  });

  it("cache.path is a non-empty string (paths are not secrets)", () => {
    const out = buildCapabilities(ALL_TOOLS) as { cache: { path: string } };
    expect(typeof out.cache.path).toBe("string");
    expect(out.cache.path.length).toBeGreaterThan(0);
  });
});

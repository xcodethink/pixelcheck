/**
 * Coverage for the MCP tool registry abstraction (M3-6 + M9-1).
 *
 * Three layers:
 *   1. ToolRegistry class — register / get / has / list / size / describe;
 *      duplicate registration rejected; describe() emits the read-only
 *      record subset.
 *   2. ALL_TOOLS catalog invariants — every shipped tool has the required
 *      shape, names are unique, every declared `resultSchema` matches a
 *      published JSON Schema in docs/schemas/, and `kind` is one of the
 *      legal discriminators.
 *   3. Smoke routing — registry.get(name) returns the same tool the MCP
 *      dispatcher resolves; calling a no-LLM tool through the registry
 *      produces a valid stamped ToolResult.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { ToolRegistry, type ToolDefinition } from "../src/mcp/registry.js";
import { ALL_TOOLS, buildDefaultRegistry } from "../src/mcp/server.js";
import type { ToolResult } from "../src/mcp/result.js";

const VALID_KINDS = new Set(["preset", "primitive", "meta"]);
const VALID_SIDE_EFFECTS = new Set([
  "navigation",
  "state_changing",
  "fs_writes_artifacts",
  "fs_writes_history",
  "fs_reads",
  "network_egress",
]);
const VALID_COST_UNITS = new Set(["per_call", "per_step", "per_persona_scenario"]);

function fakeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "fake",
    description: "test fake",
    kind: "meta",
    inputSchema: { type: "object", properties: {} },
    cacheable: false,
    costEstimateUsd: { typical: 0, min: 0, max: 0, unit: "per_call" },
    sideEffects: ["fs_reads"],
    requires: { apiKeys: [], browser: false },
    handler: async () =>
      ({ content: [{ type: "text", text: "ok" }] }) as ToolResult,
    ...overrides,
  };
}

describe("ToolRegistry", () => {
  it("register stores a tool and exposes it via get/has/list/size", () => {
    const r = new ToolRegistry();
    expect(r.size()).toBe(0);
    expect(r.has("fake")).toBe(false);

    const tool = fakeTool();
    r.register(tool);
    expect(r.size()).toBe(1);
    expect(r.has("fake")).toBe(true);
    expect(r.get("fake")).toBe(tool);
    expect(r.list()).toEqual([tool]);
  });

  it("rejects duplicate registration with the tool name in the error", () => {
    const r = new ToolRegistry();
    r.register(fakeTool({ name: "dup" }));
    expect(() => r.register(fakeTool({ name: "dup" }))).toThrow(/dup/);
  });

  it("registerAll batches and preserves order", () => {
    const r = new ToolRegistry();
    const a = fakeTool({ name: "a" });
    const b = fakeTool({ name: "b" });
    const c = fakeTool({ name: "c" });
    r.registerAll([a, b, c]);
    expect(r.list().map((t) => t.name)).toEqual(["a", "b", "c"]);
  });

  it("get returns undefined for unknown names", () => {
    const r = new ToolRegistry();
    expect(r.get("nothing")).toBeUndefined();
  });

  it("describe drops the handler and only includes resultSchema when set", () => {
    const r = new ToolRegistry();
    r.register(fakeTool({ name: "with-schema", resultSchema: "X" }));
    r.register(fakeTool({ name: "without-schema" }));
    const describe = r.describe();
    expect(describe).toHaveLength(2);
    const a = describe[0]!;
    const b = describe[1]!;
    expect(a.resultSchema).toBe("X");
    expect("handler" in a).toBe(false);
    expect(b.resultSchema).toBeUndefined();
    // describe still carries kind for future list_capabilities
    expect(a.kind).toBe("meta");
  });
});

describe("ALL_TOOLS catalog invariants", () => {
  it("contains the 14 shipped tools in stable order", () => {
    expect(ALL_TOOLS.map((t) => t.name)).toEqual([
      "audit_url",
      "explore_url",
      "see",
      "act",
      "extract",
      "judge",
      "compare",
      "diagnose",
      "list_personas",
      "list_scenarios",
      "list_capabilities",
      "calibrate_critic",
      "get_last_report",
      "doctor",
    ]);
  });

  it("every kind is represented (preset, primitive, meta)", () => {
    const kinds = new Set(ALL_TOOLS.map((t) => t.kind));
    expect(kinds.has("preset")).toBe(true);
    expect(kinds.has("primitive")).toBe(true);
    expect(kinds.has("meta")).toBe(true);
  });

  it("every tool has a non-empty name and description", () => {
    for (const t of ALL_TOOLS) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it("every tool has an object-shaped inputSchema", () => {
    for (const t of ALL_TOOLS) {
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.inputSchema.properties).toBe("object");
    }
  });

  it("every tool's kind is preset | primitive | meta", () => {
    for (const t of ALL_TOOLS) {
      expect(VALID_KINDS.has(t.kind)).toBe(true);
    }
  });

  it("tool names are globally unique", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every declared resultSchema matches a published JSON Schema", () => {
    // Read docs/schemas/index.json once and assert each tool's resultSchema
    // hint exists in the public catalog. Catches drift between a tool's
    // declared result shape and the schemas committed to the repo.
    const indexPath = path.join(process.cwd(), "docs/schemas/index.json");
    const raw = fs.readFileSync(indexPath, "utf-8");
    const index = JSON.parse(raw) as { schemas: Array<{ title: string }> };
    const titles = new Set(index.schemas.map((s) => s.title));
    for (const t of ALL_TOOLS) {
      if (!t.resultSchema) continue;
      expect(titles.has(t.resultSchema)).toBe(true);
    }
  });

  it("buildDefaultRegistry returns a registry containing every catalog entry", () => {
    const r = buildDefaultRegistry();
    expect(r.size()).toBe(ALL_TOOLS.length);
    for (const t of ALL_TOOLS) {
      expect(r.get(t.name)).toBe(t);
    }
  });

  // ── M9-5 metadata invariants ─────────────────────────────────────

  it("every tool declares a boolean cacheable flag", () => {
    for (const t of ALL_TOOLS) {
      expect(typeof t.cacheable).toBe("boolean");
    }
  });

  it("every tool has a well-formed costEstimateUsd band (min ≤ typical ≤ max, all ≥ 0)", () => {
    for (const t of ALL_TOOLS) {
      const c = t.costEstimateUsd;
      expect(typeof c.typical).toBe("number");
      expect(c.min).toBeGreaterThanOrEqual(0);
      expect(c.typical).toBeGreaterThanOrEqual(c.min);
      expect(c.max).toBeGreaterThanOrEqual(c.typical);
      expect(VALID_COST_UNITS.has(c.unit)).toBe(true);
    }
  });

  it("every tool's sideEffects entries are from the closed enum", () => {
    for (const t of ALL_TOOLS) {
      expect(Array.isArray(t.sideEffects)).toBe(true);
      for (const eff of t.sideEffects) {
        expect(VALID_SIDE_EFFECTS.has(eff)).toBe(true);
      }
    }
  });

  it("every tool has a requires record (apiKeys array + browser boolean)", () => {
    for (const t of ALL_TOOLS) {
      expect(Array.isArray(t.requires.apiKeys)).toBe(true);
      expect(typeof t.requires.browser).toBe("boolean");
    }
  });

  it("network_egress matches non-empty apiKeys requirement", () => {
    // If a tool calls an LLM provider, it must (a) declare network_egress
    // and (b) declare ANTHROPIC_API_KEY in requires.apiKeys. The two flags
    // are independent encodings of the same underlying fact and must agree.
    for (const t of ALL_TOOLS) {
      const hasEgress = t.sideEffects.includes("network_egress");
      const hasKey = t.requires.apiKeys.length > 0;
      expect(hasEgress).toBe(hasKey);
    }
  });

  it("every tool that drives a browser declares the navigation side-effect", () => {
    for (const t of ALL_TOOLS) {
      if (!t.requires.browser) continue;
      expect(t.sideEffects.includes("navigation")).toBe(true);
    }
  });

  it("M9-4 cacheable matrix matches the v1 design (judge / extract / see cache; act / compare / presets / meta do not)", () => {
    const expected: Record<string, boolean> = {
      audit_url: false,
      explore_url: false,
      see: true,
      act: false,
      extract: true,
      judge: true,
      compare: false,
      diagnose: true,
      list_personas: false,
      list_scenarios: false,
      list_capabilities: false,
      calibrate_critic: false,
      get_last_report: false,
      doctor: false,
    };
    for (const t of ALL_TOOLS) {
      expect(`${t.name}=${t.cacheable}`).toBe(`${t.name}=${expected[t.name]}`);
    }
  });
});

describe("registry routing smoke", () => {
  it("dispatching list_personas through the registry produces a stamped ToolResult", async () => {
    // Use the project's own personas/ directory so we exercise the full
    // file-system path.
    const r = buildDefaultRegistry();
    const tool = r.get("list_personas");
    expect(tool).toBeDefined();

    const result = await tool!.handler({});
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    const text = result.content[0]!.text;
    // list_personas returns a top-level JSON array of summaries.
    const parsed = JSON.parse(text) as Array<{ id: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    if (parsed.length > 0) {
      expect(typeof parsed[0]!.id).toBe("string");
    }
  });

  it("dispatching list_scenarios with a missing dir returns the not-found textResult", async () => {
    const r = buildDefaultRegistry();
    const tool = r.get("list_scenarios");
    expect(tool).toBeDefined();

    const result = await tool!.handler({
      scenarios_dir: "/tmp/definitely-no-scenarios-here-" + Date.now(),
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/no scenarios directory/);
  });
});

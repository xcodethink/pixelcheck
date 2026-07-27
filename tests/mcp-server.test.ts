/**
 * Unit tests for pure MCP server helpers.
 * The live stdio transport is covered by manual smoke (MCP client integration).
 */

import { describe, it, expect } from "vitest";
import { textResult, errorResult, stampedTextResult } from "../src/mcp/result.js";
import { installProcessGuards } from "../src/mcp/server.js";
import { requireString, resolvePersona } from "../src/mcp/helpers.js";
import {
  AuditUrlResultSchema,
  ListScenariosResultSchema,
  RESULT_SCHEMA_VERSION,
} from "../src/core/result-schema.js";
import type { Persona } from "../src/core/types.js";

function mk(id: string, overrides: Partial<Persona> = {}): Persona {
  return {
    id,
    display_name: id,
    country: "US",
    language: "en",
    locale: "en-US",
    timezone: "UTC",
    device_class: "desktop",
    payment_tier: "free",
    mental_model: "",
    critical_concerns: [],
    ...overrides,
  };
}

describe("textResult / errorResult", () => {
  it("wraps text in the MCP content format", () => {
    const r = textResult("hi");
    expect(r.content).toEqual([{ type: "text", text: "hi" }]);
    expect(r.isError).toBeUndefined();
  });
  it("errorResult marks isError", () => {
    const r = errorResult("boom");
    expect(r.isError).toBe(true);
  });
});

describe("requireString", () => {
  it("passes a non-empty string through", () => {
    expect(requireString("x", "url")).toBe("x");
  });
  it("throws on non-string", () => {
    expect(() => requireString(123, "url")).toThrow(/url/);
  });
  it("throws on empty string", () => {
    expect(() => requireString("", "url")).toThrow(/url/);
  });
});

describe("resolvePersona", () => {
  const personas = new Map<string, Persona>([
    ["jp-mobile", mk("jp-mobile", { country: "JP", device_class: "mobile" })],
    ["us-desktop", mk("us-desktop", { country: "US", device_class: "desktop" })],
    ["de-tablet", mk("de-tablet", { country: "DE", device_class: "tablet" })],
  ]);

  it("returns exact match when id exists", () => {
    expect(resolvePersona(personas, "jp-mobile").id).toBe("jp-mobile");
  });

  it("falls back to US desktop when id missing", () => {
    expect(resolvePersona(personas, "not-a-real-id").id).toBe("us-desktop");
  });

  it("falls back to first when no US desktop present", () => {
    const small = new Map<string, Persona>([
      ["br-mobile", mk("br-mobile", { country: "BR", device_class: "mobile" })],
    ]);
    expect(resolvePersona(small, undefined).id).toBe("br-mobile");
  });

  it("throws when no personas at all", () => {
    expect(() => resolvePersona(new Map(), undefined)).toThrow();
  });
});

describe("installProcessGuards (D2-L2)", () => {
  it("installs unhandledRejection + uncaughtException guards", () => {
    // Before the fix the long-lived MCP server had no process-level guards,
    // so a stray async rejection (e.g. a screencast frame callback firing
    // after its tool call returned) would terminate the whole server under
    // Node's default policy. installProcessGuards() must register both.
    installProcessGuards();
    expect(process.listenerCount("unhandledRejection")).toBeGreaterThanOrEqual(1);
    expect(
      process.listenerCount("uncaughtExceptionMonitor"),
    ).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent — repeated calls do not stack duplicate listeners", () => {
    installProcessGuards();
    const rejections = process.listenerCount("unhandledRejection");
    const monitors = process.listenerCount("uncaughtExceptionMonitor");
    // runMcpServer() runs once per test-spawned server; the module flag must
    // keep us from leaking a listener (and a MaxListenersExceededWarning) on
    // every spin-up.
    installProcessGuards();
    installProcessGuards();
    expect(process.listenerCount("unhandledRejection")).toBe(rejections);
    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(monitors);
  });
});

describe("stampedTextResult (M9-2 C3)", () => {
  it("stamps schema_version onto an object payload at the top of the JSON", () => {
    const r = stampedTextResult("AuditUrlResult", AuditUrlResultSchema, {
      status: "pass" as const,
      overall_score: 8.0,
      cost_usd: 0.1,
      issues: 0,
      critical_issues: 0,
      report_json: "/tmp/audit.json",
      report_html: "/tmp/audit.html",
    });
    const body = r.content[0]!.text;
    const parsed = JSON.parse(body);
    expect(parsed.schema_version).toBe(RESULT_SCHEMA_VERSION);
    // schema_version should be the first key in the serialized JSON.
    expect(body.startsWith(`{\n  "schema_version":`)).toBe(true);
  });

  it("does not wrap arrays — passes them through verbatim", () => {
    const r = stampedTextResult(
      "ListScenariosResult",
      ListScenariosResultSchema,
      ["smoke.yaml", "auth.yaml"],
    );
    const body = r.content[0]!.text;
    const parsed = JSON.parse(body);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual(["smoke.yaml", "auth.yaml"]);
  });

  it("returns the payload even when validation would fail (warn-not-throw)", () => {
    // Intentionally pass a malformed object — handler should still succeed.
    const r = stampedTextResult(
      "AuditUrlResult",
      AuditUrlResultSchema,
      { cost_usd: -1 } as unknown as { cost_usd: number },
    );
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain("schema_version");
  });
});

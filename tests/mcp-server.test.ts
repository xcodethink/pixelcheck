/**
 * Unit tests for pure MCP server helpers.
 * The live stdio transport is covered by manual smoke (MCP client integration).
 */

import { describe, it, expect } from "vitest";
import {
  textResult,
  errorResult,
  requireString,
  resolvePersona,
} from "../src/mcp/server.js";
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

import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock the heavy core primitive + the persona loader so we can unit-test the
// MCP `see` wrapper's arg->options mapping and persona resolution without a
// browser or persona files on disk.
vi.mock("../src/core/primitives/see.js", () => ({
  see: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../src/core/persona.js", () => ({
  resolvePersonasDir: () => process.cwd(), // exists, so loadPersonaHints proceeds
  loadPersonas: vi.fn(async () => new Map()),
}));

import { seeTool } from "../src/mcp/tools/see.js";
import { see } from "../src/core/primitives/see.js";
import { loadPersonas } from "../src/core/persona.js";

const mockSee = vi.mocked(see);
const mockLoadPersonas = vi.mocked(loadPersonas);

function lastOpts() {
  return mockSee.mock.calls.at(-1)![0] as Record<string, unknown>;
}

describe("MCP see — arg mapping + persona resolution (G3)", () => {
  beforeEach(() => {
    mockSee.mockClear();
    mockLoadPersonas.mockReset();
    mockLoadPersonas.mockResolvedValue(new Map());
  });

  it("maps a minimal {url} and leaves optionals undefined", async () => {
    await seeTool.handler({ url: "https://example.com" });
    const o = lastOpts();
    expect(o.url).toBe("https://example.com");
    expect(o.goal).toBeUndefined();
    expect(o.waitFor).toBeUndefined();
    expect(o.viewport).toBeUndefined();
    expect(o.persona).toBeUndefined();
  });

  it("returns a stamped (schema_version) JSON ToolResult", async () => {
    const res = await seeTool.handler({ url: "https://example.com" });
    const body = JSON.parse(res.content[0]!.text);
    expect(body.schema_version).toBeDefined();
    expect(body.ok).toBe(true);
  });

  it("treats a known wait literal as a literal, anything else as a selector", async () => {
    await seeTool.handler({ url: "https://example.com", wait_for: "networkidle" });
    expect(lastOpts().waitFor).toBe("networkidle");

    await seeTool.handler({ url: "https://example.com", wait_for: "#app.ready" });
    expect(lastOpts().waitFor).toEqual({ type: "selector", selector: "#app.ready" });
  });

  it("applies viewport only when BOTH width and height are given", async () => {
    await seeTool.handler({ url: "https://example.com", viewport_width: 390 });
    expect(lastOpts().viewport).toBeUndefined();

    await seeTool.handler({
      url: "https://example.com",
      viewport_width: 390,
      viewport_height: 844,
    });
    expect(lastOpts().viewport).toEqual({ width: 390, height: 844 });
  });

  it("threads through goal + boolean + cache options", async () => {
    await seeTool.handler({
      url: "https://example.com",
      goal: "is the CTA visible?",
      full_page: false,
      include_dom: false,
      include_console: true,
      headless: false,
      cache: false,
      cache_bust: true,
      cache_ttl_ms: 5000,
      timeout_ms: 12000,
    });
    const o = lastOpts();
    expect(o.goal).toBe("is the CTA visible?");
    expect(o.fullPage).toBe(false);
    expect(o.includeDom).toBe(false);
    expect(o.includeConsole).toBe(true);
    expect(o.headless).toBe(false);
    expect(o.cache).toBe(false);
    expect(o.cacheBust).toBe(true);
    expect(o.cacheTtlMs).toBe(5000);
    expect(o.timeoutMs).toBe(12000);
  });

  it("resolves persona viewport/locale/timezone hints when the id matches", async () => {
    mockLoadPersonas.mockResolvedValue(
      new Map([
        [
          "jp-mobile",
          {
            id: "jp-mobile",
            viewport: { width: 390, height: 844 },
            locale: "ja-JP",
            timezone: "Asia/Tokyo",
          },
        ],
      ]) as unknown as Awaited<ReturnType<typeof loadPersonas>>,
    );
    await seeTool.handler({ url: "https://example.com", persona: "jp-mobile" });
    expect(lastOpts().persona).toMatchObject({
      id: "jp-mobile",
      viewport: { width: 390, height: 844 },
      locale: "ja-JP",
      timezone: "Asia/Tokyo",
    });
  });

  it("falls back to a bare {id} hint when the persona id is unknown", async () => {
    mockLoadPersonas.mockResolvedValue(new Map());
    await seeTool.handler({ url: "https://example.com", persona: "ghost" });
    expect(lastOpts().persona).toEqual({ id: "ghost" });
  });
});

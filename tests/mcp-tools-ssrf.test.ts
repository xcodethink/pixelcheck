import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { UnsafeUrlError } from "../src/core/url-guard.js";
import { seeTool } from "../src/mcp/tools/see.js";
import { auditUrlTool } from "../src/mcp/tools/audit-url.js";
import { exploreUrlTool } from "../src/mcp/tools/explore-url.js";
import { extractTool } from "../src/mcp/tools/extract.js";
import { actTool } from "../src/mcp/tools/act.js";
import { diagnoseTool } from "../src/mcp/tools/diagnose.js";
import { judgeTool } from "../src/mcp/tools/judge.js";
import { compareTool } from "../src/mcp/tools/compare.js";
import type { ToolDefinition } from "../src/mcp/registry.js";

/**
 * B2 regression: every URL-taking MCP tool must run the SSRF guard at the
 * handler boundary, BEFORE launching a browser or calling an LLM. An MCP
 * client is untrusted; without this it could point a tool at 169.254.169.254
 * (cloud IMDS), localhost, or an internal panel. The audit found the guard
 * missing on audit_url / explore_url; this locks it across the whole surface.
 *
 * These tests pass a blocked URL and assert the handler rejects with
 * UnsafeUrlError. The guard throws before any browser work, so no mock is
 * needed — if a guard regresses, the handler would instead try to launch a
 * browser and the test would hang/fail loudly.
 */

// (tool, build args from a url) — judge guards only when `url` is present;
// compare guards each side input.
const URL_TOOLS: Array<{ name: string; tool: ToolDefinition; args: (url: string) => Record<string, unknown> }> = [
  { name: "see", tool: seeTool, args: (url) => ({ url }) },
  { name: "audit_url", tool: auditUrlTool, args: (url) => ({ url }) },
  { name: "explore_url", tool: exploreUrlTool, args: (url) => ({ url, goal: "x" }) },
  { name: "extract", tool: extractTool, args: (url) => ({ url }) },
  { name: "act", tool: actTool, args: (url) => ({ url, steps: [] }) },
  { name: "diagnose", tool: diagnoseTool, args: (url) => ({ url }) },
  { name: "judge", tool: judgeTool, args: (url) => ({ url, rubrics: ["visual_hierarchy"] }) },
  { name: "compare", tool: compareTool, args: (url) => ({ a: { url }, b: { url } }) },
];

const BLOCKED = [
  "http://169.254.169.254/latest/meta-data/", // AWS IMDS (link-local)
  "http://localhost:3000/admin",
  "http://10.0.0.5/internal",
  "http://127.0.0.1/",
];

describe("MCP URL tools — SSRF guard (G3 / B2)", () => {
  beforeEach(() => {
    delete process.env.PIXELCHECK_ALLOW_PRIVATE;
  });
  afterEach(() => {
    delete process.env.PIXELCHECK_ALLOW_PRIVATE;
  });

  for (const { name, tool, args } of URL_TOOLS) {
    describe(name, () => {
      for (const url of BLOCKED) {
        it(`rejects ${url}`, async () => {
          await expect(tool.handler(args(url))).rejects.toThrow(UnsafeUrlError);
        });
      }

      it("rejects a non-http(s) scheme (file://)", async () => {
        await expect(tool.handler(args("file:///etc/passwd"))).rejects.toThrow(UnsafeUrlError);
      });
    });
  }

  it("every URL tool declares it needs a browser (so the guard matters)", () => {
    for (const { tool } of URL_TOOLS) {
      expect(tool.requires.browser).toBe(true);
    }
  });
});

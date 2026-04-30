#!/usr/bin/env node
/**
 * AI Browser Auditor — MCP Server
 *
 * Exposes the auditor as a Model Context Protocol server over stdio so any
 * MCP-aware client (Claude Code, Cursor, Cline, Continue, Zed agent, etc.)
 * can run audits against URLs without leaving their workflow.
 *
 * Architecture (M3-6 + M9-1):
 *   server.ts       — transport lifecycle + dispatcher (this file)
 *   registry.ts     — ToolRegistry + ToolDefinition shape
 *   result.ts       — ToolResult helpers (text / error / stamped)
 *   helpers.ts      — argument coercion + persona resolution
 *   tools/<name>.ts — one file per tool, exports ToolDefinition
 *
 * Tools registered (kind in parens):
 *   - audit_url         (preset)    — full audit pipeline against a URL
 *   - explore_url       (preset)    — autonomous agent run with a goal
 *   - see               (primitive) — one-shot navigation snapshot (N-1)
 *   - act               (primitive) — execute a sequence of actions (N-2)
 *   - extract           (primitive) — schema-bound structured extraction (N-4)
 *   - judge             (primitive) — rubric-driven page critic (N-8)
 *   - compare           (primitive) — A/B page comparison (N-3)
 *   - list_personas     (meta)      — enumerate installed personas
 *   - list_scenarios    (meta)      — enumerate installed scenarios
 *   - list_capabilities (meta)      — self-describe the MCP server (M9-5)
 *   - calibrate_critic  (meta)      — run the critic calibration gate
 *   - get_last_report   (meta)      — read the most recent audit summary
 *
 * Adding a new tool: drop a file under `src/mcp/tools/<name>.ts` exporting
 * a `ToolDefinition`, then push it into the `ALL_TOOLS` array below.
 *
 * Registration example for Claude Code ~/.mcp.json:
 *   {
 *     "mcpServers": {
 *       "ai-browser-auditor": {
 *         "command": "node",
 *         "args": ["<abs-path>/dist/mcp/server.js"]
 *       }
 *     }
 *   }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getLogger, registerSecret } from "../core/logger.js";
import { buildRedactPatterns } from "../core/secrets.js";
import { withCostRun } from "../core/cost-guard.js";
import { errorResult, type ToolResult } from "./result.js";
import { ToolRegistry, type ToolDefinition } from "./registry.js";
import { auditUrlTool } from "./tools/audit-url.js";
import { exploreUrlTool } from "./tools/explore-url.js";
import { seeTool } from "./tools/see.js";
import { actTool } from "./tools/act.js";
import { extractTool } from "./tools/extract.js";
import { judgeTool } from "./tools/judge.js";
import { compareTool } from "./tools/compare.js";
import { listPersonasTool } from "./tools/list-personas.js";
import { listScenariosTool } from "./tools/list-scenarios.js";
import { listCapabilitiesTool } from "./tools/list-capabilities.js";
import { calibrateCriticTool } from "./tools/calibrate-critic.js";
import { getLastReportTool } from "./tools/get-last-report.js";

const log = getLogger("mcp.server");

// Wire env-derived secrets into the logger redaction layer at module load,
// before any tool handler can fire. Done at module level (not inside
// runMcpServer) so any dynamic import path also picks it up.
for (const p of buildRedactPatterns([])) registerSecret(p);

/**
 * The canonical tool catalog. Order is preserved in `tools/list` output.
 * Exported so unit tests can iterate and assert per-tool invariants
 * without spinning up the transport.
 */
export const ALL_TOOLS: readonly ToolDefinition[] = [
  auditUrlTool,
  exploreUrlTool,
  seeTool,
  actTool,
  extractTool,
  judgeTool,
  compareTool,
  listPersonasTool,
  listScenariosTool,
  listCapabilitiesTool,
  calibrateCriticTool,
  getLastReportTool,
];

/** Build a fresh registry containing every shipped tool. */
export function buildDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(ALL_TOOLS);
  return registry;
}

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    { name: "ai-browser-auditor", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  const registry = buildDefaultRegistry();

  // List tools. Map down to the spec-compliant subset; `kind` and
  // `resultSchema` live on the registry record but are not part of the
  // MCP `Tool` shape, so we don't leak them to clients that may strict-
  // validate. M9-5 `list_capabilities` will surface the richer fields.
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: registry.list().map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
    })),
  }));

  // Dispatch tool calls. Handlers return ToolResult; the SDK's ServerResult
  // union requires an escape hatch cast because the type includes unrelated
  // task/progress shapes that aren't relevant to CallToolResult.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    // Cost guard: every MCP tool invocation runs inside its own
    // AsyncLocalStorage cost scope (M9-3). Two parallel tool calls served
    // by this same MCP server process see independent per-run counters,
    // so one call's spend never bleeds into another's run-USD cap. The
    // persistent daily ledger is still shared (and write-locked).
    return withCostRun(async () => {
      let result: ToolResult;
      try {
        const tool = registry.get(name);
        result = tool
          ? await tool.handler(args)
          : errorResult(`unknown tool: ${name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result = errorResult(`tool ${name} failed: ${msg}`);
      }
      return result as unknown as Record<string, unknown>;
    }) as unknown as Promise<Record<string, unknown>>;
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ─────────────────────────────────────────────────────────────
// Entry point (when invoked as a binary)
// ─────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  runMcpServer().catch((err) => {
    log.fatal(
      {
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      `MCP server crashed`,
    );
    process.exit(1);
  });
}

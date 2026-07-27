#!/usr/bin/env node
/**
 * PixelCheck — MCP Server
 *
 * Exposes PixelCheck's browser primitives + audit preset as a Model Context
 * Protocol server over stdio so any MCP-aware client (Claude Code, Cursor,
 * Cline, Continue, Zed agent, Claude Desktop, etc.) can give an AI agent
 * real eyes and hands on the web without leaving its workflow.
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
 *   - diagnose          (preset)    — holistic page-health diagnosis (PR-E / ADR-034)
 *   - list_personas     (meta)      — enumerate installed personas
 *   - list_scenarios    (meta)      — enumerate installed scenarios
 *   - list_capabilities (meta)      — self-describe the MCP server (M9-5)
 *   - calibrate_critic  (meta)      — run the critic calibration gate
 *   - get_last_report   (meta)      — read the most recent audit summary
 *   - doctor            (meta)      — diagnose / self-heal the environment
 *
 * Adding a new tool: drop a file under `src/mcp/tools/<name>.ts` exporting
 * a `ToolDefinition`, then push it into the `ALL_TOOLS` array below.
 *
 * Registration example for Claude Code ~/.mcp.json:
 *   {
 *     "mcpServers": {
 *       "pixelcheck": {
 *         "command": "pixelcheck-mcp"
 *       }
 *     }
 *   }
 */

import { pathToFileURL } from "node:url";

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
import { getPackageVersion } from "../core/version.js";
import { ToolRegistry, type ToolDefinition } from "./registry.js";
import { auditUrlTool } from "./tools/audit-url.js";
import { exploreUrlTool } from "./tools/explore-url.js";
import { seeTool } from "./tools/see.js";
import { actTool } from "./tools/act.js";
import { extractTool } from "./tools/extract.js";
import { judgeTool } from "./tools/judge.js";
import { compareTool } from "./tools/compare.js";
import { diagnoseTool } from "./tools/diagnose.js";
import { listPersonasTool } from "./tools/list-personas.js";
import { listScenariosTool } from "./tools/list-scenarios.js";
import { listCapabilitiesTool } from "./tools/list-capabilities.js";
import { calibrateCriticTool } from "./tools/calibrate-critic.js";
import { getLastReportTool } from "./tools/get-last-report.js";
import { doctorTool } from "./tools/doctor.js";

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
  diagnoseTool,
  listPersonasTool,
  listScenariosTool,
  listCapabilitiesTool,
  calibrateCriticTool,
  getLastReportTool,
  doctorTool,
];

/** Build a fresh registry containing every shipped tool. */
export function buildDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(ALL_TOOLS);
  return registry;
}

// Install global process guards exactly once. The MCP server is a
// long-lived stdio process (it outlives any single tool call), so a
// single stray async rejection must not take it — and every other
// in-flight tool call — down. Guarded by a module flag so repeated
// runMcpServer() calls (the test suite spins it up many times) don't
// stack duplicate listeners and trip MaxListenersExceededWarning.
let processGuardsInstalled = false;

/**
 * Last-resort process-level guards for the long-lived MCP server (D2-L2).
 *
 * - `unhandledRejection`: under Node's default policy an unhandled
 *   promise rejection terminates the process. For a stdio MCP server the
 *   common source is fire-and-forget browser callbacks (screencast frame
 *   handlers, CDP event listeners) whose promises reject *after* the
 *   originating tool call has already returned and reported its own
 *   failure. We log and keep serving instead of tearing down every other
 *   concurrent tool call.
 * - `uncaughtExceptionMonitor`: an uncaught exception leaves the process
 *   in an undefined state — Node is explicit that you must not resume
 *   normal operation after one. We therefore do NOT swallow it; the
 *   monitor lets us emit a structured fatal log (with stack) and then
 *   Node's default handler still terminates with a non-zero exit so a
 *   supervising MCP client restarts us cleanly.
 *
 * Idempotent and exported for unit testing.
 */
export function installProcessGuards(): void {
  if (processGuardsInstalled) return;
  processGuardsInstalled = true;

  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    log.error(
      { err: err.message, stack: err.stack },
      "unhandledRejection in MCP server — ignored, server kept alive",
    );
  });

  process.on("uncaughtExceptionMonitor", (err) => {
    log.fatal(
      { err: err.message, stack: err.stack },
      "uncaughtException in MCP server — process will terminate",
    );
  });
}

export async function runMcpServer(): Promise<void> {
  installProcessGuards();


  const server = new Server(
    { name: "pixelcheck", version: getPackageVersion() },
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

  // Lazy prune of stale primitive artifact dirs (T9 — closes R50).
  // At-most-once-per-24h via prune-stamp.json so we don't burn CPU on
  // every MCP-server connect. Failures are logged and ignored — prune
  // is a janitor task, never block server start.
  try {
    const { pruneIfStale } = await import("../core/artifacts-prune.js");
    const result = pruneIfStale();
    if (result) {
      log.info(
        {
          totalDeleted: result.totalDeleted,
          totalBytesFreed: result.totalBytesFreed,
        },
        "lazy-pruned stale primitive artifacts",
      );
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "lazy artifact prune failed",
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ─────────────────────────────────────────────────────────────
// Entry point (when invoked as a binary)
// ─────────────────────────────────────────────────────────────

// ESM "is this the main module" check.
//
// `import.meta.url` is always a percent-encoded forward-slash URL
// (`file:///D:/a/.../server.js` on Windows). `process.argv[1]` is
// the platform-native path (`D:\a\...\server.js` on Windows). The
// naive `\`file://${process.argv[1]}\`` template only matches on
// POSIX — on Windows it produces `file://D:\a\...` (backslashes,
// only two slashes after `file:`) and the comparison ALWAYS fails.
// Result: the MCP server's entry-point branch never runs on Windows,
// every stdio MCP client sees the process exit immediately with
// "MCP error -32000: Connection closed" or a request timeout.
//
// `pathToFileURL` is Node's canonical conversion that handles drive
// letters, backslashes, and percent-encoding consistently across
// platforms — the standard ESM entry-check pattern.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
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

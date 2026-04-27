#!/usr/bin/env node
/**
 * AI Browser Auditor — MCP Server
 *
 * Exposes the auditor as a Model Context Protocol server over stdio so any
 * MCP-aware client (Claude Code, Cursor, Cline, Continue, Zed agent, etc.)
 * can run audits against URLs without leaving their workflow.
 *
 * Tools registered:
 *   - audit_url         — run a single-persona audit against any URL
 *   - list_personas     — enumerate installed personas
 *   - list_scenarios    — enumerate installed scenarios
 *   - explore_url       — ad-hoc autonomous exploration (goal + URL)
 *   - calibrate_critic  — run the critic calibration gate
 *   - get_last_report   — read the most recent audit.json from history
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
import * as path from "node:path";
import * as fs from "node:fs";
import { loadPersonas } from "../core/persona.js";
import { ProjectConfigSchema, ScenarioSchema, type Persona } from "../core/types.js";
import { getLogger, registerSecret } from "../core/logger.js";
import { buildRedactPatterns } from "../core/secrets.js";

const log = getLogger("mcp.server");

// Wire env-derived secrets into the logger redaction layer at module load,
// before any tool handler can fire. Done at module level (not inside
// runMcpServer) so any dynamic import path also picks it up.
for (const p of buildRedactPatterns([])) registerSecret(p);

// ─────────────────────────────────────────────────────────────
// Tool input schemas
// ─────────────────────────────────────────────────────────────

const AUDIT_URL_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", description: "The URL to audit" },
    persona: {
      type: "string",
      description: "Persona id (e.g. 'us-chatgpt-pro-macbook', 'jp-mobile'). If omitted, uses a sensible default.",
    },
    scenario: {
      type: "string",
      description: "Path to a scenario YAML. Omit to use the default 'smoke' autonomous scenario.",
    },
    budget_usd: {
      type: "number",
      description: "Maximum USD to spend on this audit. Defaults to 2.0.",
    },
    cost_mode: {
      type: "string",
      enum: ["max", "balanced", "economy"],
      description: "Cost/quality profile. Defaults to 'balanced'.",
    },
    personas_dir: {
      type: "string",
      description: "Optional personas directory. Defaults to './personas'.",
    },
  },
  required: ["url"],
};

const EXPLORE_URL_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", description: "The start URL" },
    goal: { type: "string", description: "The exploration goal, in natural language" },
    success_criteria: {
      type: "array",
      items: { type: "string" },
      description: "One or more human-language success criteria the agent must satisfy.",
    },
    persona: { type: "string", description: "Persona id. Optional." },
    budget_usd: { type: "number", description: "Max USD. Default: 2.0." },
    max_actions: { type: "number", description: "Hard cap on agent actions. Default: 30." },
  },
  required: ["url", "goal"],
};

const CALIBRATE_SCHEMA = {
  type: "object",
  properties: {
    fixtures_dir: { type: "string", description: "Calibration fixtures dir." },
    model: { type: "string", description: "Critic model id override." },
  },
};

const GET_LAST_REPORT_SCHEMA = {
  type: "object",
  properties: {
    reports_root: {
      type: "string",
      description: "Path to reports root. Defaults to './reports'.",
    },
  },
};

// ─────────────────────────────────────────────────────────────
// Server
// ─────────────────────────────────────────────────────────────

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    { name: "ai-browser-auditor", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "audit_url",
        description:
          "Run a UX audit against a URL using one persona. Returns the audit summary + report path.",
        inputSchema: AUDIT_URL_SCHEMA,
      },
      {
        name: "list_personas",
        description: "List all personas available in the project's personas/ directory.",
        inputSchema: {
          type: "object",
          properties: {
            personas_dir: { type: "string", description: "Optional personas dir. Default: './personas'." },
          },
        },
      },
      {
        name: "list_scenarios",
        description: "List all scenarios available in the project's scenarios/ directory.",
        inputSchema: {
          type: "object",
          properties: {
            scenarios_dir: { type: "string", description: "Optional scenarios dir. Default: './scenarios'." },
          },
        },
      },
      {
        name: "explore_url",
        description:
          "Send the autonomous agent to explore a URL with a free-form goal. Faster than audit_url; no scenario file required.",
        inputSchema: EXPLORE_URL_SCHEMA,
      },
      {
        name: "calibrate_critic",
        description:
          "Run the critic calibration gate against labeled screenshot fixtures. Returns pass/fail + metrics.",
        inputSchema: CALIBRATE_SCHEMA,
      },
      {
        name: "get_last_report",
        description:
          "Read the most recent audit's summary JSON from the reports history DB.",
        inputSchema: GET_LAST_REPORT_SCHEMA,
      },
    ],
  }));

  // Dispatch tool calls. Handlers return ToolResult; the SDK's ServerResult
  // union requires an escape hatch cast because the type includes unrelated
  // task/progress shapes that aren't relevant to CallToolResult.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    let result: ToolResult;
    try {
      switch (name) {
        case "list_personas":
          result = await handleListPersonas(args); break;
        case "list_scenarios":
          result = await handleListScenarios(args); break;
        case "audit_url":
          result = await handleAuditUrl(args); break;
        case "explore_url":
          result = await handleExploreUrl(args); break;
        case "calibrate_critic":
          result = await handleCalibrate(args); break;
        case "get_last_report":
          result = await handleGetLastReport(args); break;
        default:
          result = errorResult(`unknown tool: ${name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = errorResult(`tool ${name} failed: ${msg}`);
    }
    return result as unknown as Record<string, unknown>;
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ─────────────────────────────────────────────────────────────
// Tool handlers
// ─────────────────────────────────────────────────────────────

async function handleListPersonas(args: Record<string, unknown>): Promise<ToolResult> {
  const dir = typeof args.personas_dir === "string" ? args.personas_dir : "./personas";
  const personas = await loadPersonas(path.resolve(dir));
  const summary = Array.from(personas.values()).map((p) => ({
    id: p.id,
    display_name: p.display_name,
    country: p.country,
    language: p.language,
    device: p.device_class,
    payment_tier: p.payment_tier,
  }));
  return textResult(JSON.stringify(summary, null, 2));
}

async function handleListScenarios(args: Record<string, unknown>): Promise<ToolResult> {
  const dir = typeof args.scenarios_dir === "string" ? args.scenarios_dir : "./scenarios";
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) {
    return textResult(`no scenarios directory at ${resolved}`);
  }
  const files = fs
    .readdirSync(resolved)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  return textResult(JSON.stringify(files, null, 2));
}

async function handleAuditUrl(args: Record<string, unknown>): Promise<ToolResult> {
  const url = requireString(args.url, "url");
  const personaId = typeof args.persona === "string" ? args.persona : undefined;
  const costMode = (args.cost_mode as "max" | "balanced" | "economy") ?? "balanced";
  const budget = typeof args.budget_usd === "number" ? args.budget_usd : 2.0;
  const personasDir = typeof args.personas_dir === "string" ? args.personas_dir : "./personas";

  const { runAudit } = await import("../core/runner.js");
  const { writeSpaReport } = await import("../core/reporter-spa.js");
  const { writeJsonReport } = await import("../core/reporter.js");

  const personas = await loadPersonas(path.resolve(personasDir));
  const persona = resolvePersona(personas, personaId);

  // Build an ad-hoc autonomous scenario (schema fills defaults)
  const scenario = ScenarioSchema.parse({
    id: "mcp-audit",
    name: `MCP audit: ${url}`,
    priority: "P1",
    goal: `Evaluate the UX and functional health of ${url} as ${persona.display_name}`,
    applies_to: { personas: [persona.id] },
    mode: "autonomous",
    start_url: url,
    success_criteria: [
      {
        id: "page_loads",
        description: "Page loads without errors",
        verification: "error",
        expected: { pageerror_max: 0 },
      },
    ],
    agent_config: { max_actions: 15 },
  });

  const config = ProjectConfigSchema.parse({
    project_name: "mcp",
    base_url: url,
    default_concurrency: 1,
    budget_usd: budget,
    cost_mode: costMode,
  });

  const outRoot = path.resolve("./reports/mcp");
  const { audit } = await runAudit({
    config,
    personas,
    scenarios: [scenario],
    matrix: [{ scenario, personaId: persona.id }],
    outputRoot: outRoot,
    headless: true,
    tag: "mcp",
  });

  const runDir = path.join(outRoot, audit.run_id);
  const jsonPath = writeJsonReport(audit, runDir);
  const spaPath = writeSpaReport(audit, runDir);
  const r = audit.results[0];
  return textResult(
    JSON.stringify(
      {
        status: r?.status,
        overall_score: r?.overall_score,
        cost_usd: audit.summary.total_cost_usd,
        issues: r?.issues.length ?? 0,
        critical_issues: audit.summary.critical_issues,
        report_json: jsonPath,
        report_html: spaPath,
      },
      null,
      2,
    ),
  );
}

async function handleExploreUrl(args: Record<string, unknown>): Promise<ToolResult> {
  const url = requireString(args.url, "url");
  const goal = requireString(args.goal, "goal");
  const criteriaInput = Array.isArray(args.success_criteria)
    ? (args.success_criteria as string[])
    : [];
  const personaId = typeof args.persona === "string" ? args.persona : undefined;
  const budget = typeof args.budget_usd === "number" ? args.budget_usd : 2.0;
  const maxActions = typeof args.max_actions === "number" ? args.max_actions : 30;

  const { runAudit } = await import("../core/runner.js");
  const personas = await loadPersonas(path.resolve("./personas"));
  const persona = resolvePersona(personas, personaId);

  const successCriteria =
    criteriaInput.length > 0
      ? criteriaInput.map((d, i) => ({
          id: `c${i}`,
          description: d,
          verification: "visual" as const,
        }))
      : [{ id: "goal_met", description: goal, verification: "visual" as const }];

  const scenario = ScenarioSchema.parse({
    id: "mcp-explore",
    name: `MCP explore: ${goal.slice(0, 40)}`,
    priority: "P1",
    goal,
    applies_to: { personas: [persona.id] },
    mode: "autonomous",
    start_url: url,
    success_criteria: successCriteria,
    agent_config: { max_actions: maxActions },
  });

  const config = ProjectConfigSchema.parse({
    project_name: "mcp-explore",
    base_url: url,
    default_concurrency: 1,
    budget_usd: budget,
    cost_mode: "balanced",
  });

  const outRoot = path.resolve("./reports/mcp-explore");
  const { audit } = await runAudit({
    config,
    personas,
    scenarios: [scenario],
    matrix: [{ scenario, personaId: persona.id }],
    outputRoot: outRoot,
    headless: true,
    tag: "explore",
  });

  const r = audit.results[0];
  return textResult(
    JSON.stringify(
      {
        status: r?.status,
        convergence: r?.agent_summary?.convergence_reason,
        criteria_met: r?.agent_summary?.criteria_met,
        criteria_missed: r?.agent_summary?.criteria_missed,
        total_actions: r?.agent_summary?.total_actions,
        cost_usd: audit.summary.total_cost_usd,
      },
      null,
      2,
    ),
  );
}

async function handleCalibrate(args: Record<string, unknown>): Promise<ToolResult> {
  const fixturesDir =
    typeof args.fixtures_dir === "string"
      ? args.fixtures_dir
      : "./tests/fixtures/critic-calibration";
  const model = typeof args.model === "string" ? args.model : "claude-sonnet-4-6";
  const { runCalibration, scoreReport } = await import("../calibration/runner.js");
  const outDir = path.resolve(`./reports/calibration/mcp_${Date.now()}`);
  const report = await runCalibration({
    fixturesDir: path.resolve(fixturesDir),
    model,
    tag: "mcp",
    outputDir: outDir,
  });
  const gate = scoreReport(report);
  return textResult(
    JSON.stringify(
      {
        passed: gate.passed,
        violations: gate.violations,
        mean_agreement: gate.computed.mean_agreement,
        mean_max_distance: gate.computed.mean_max_distance,
        fully_aligned_rate: gate.computed.fully_aligned_rate,
        total_cost_usd: report.total_cost_usd,
        report_dir: outDir,
      },
      null,
      2,
    ),
  );
}

async function handleGetLastReport(args: Record<string, unknown>): Promise<ToolResult> {
  const reportsRoot =
    typeof args.reports_root === "string" ? args.reports_root : "./reports";
  const { loadHistory } = await import("../core/history.js");
  const entries = loadHistory(path.resolve(reportsRoot), { limit: 1 });
  if (entries.length === 0) return textResult("no audits found in history");
  return textResult(JSON.stringify(entries[0], null, 2));
}

// ─────────────────────────────────────────────────────────────
// Helpers (exported for unit tests)
// ─────────────────────────────────────────────────────────────

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function requireString(val: unknown, name: string): string {
  if (typeof val !== "string" || val.length === 0) {
    throw new Error(`missing required string argument: ${name}`);
  }
  return val;
}

/**
 * Resolve a persona id to a Persona object, falling back to a sensible
 * default (first US desktop, else first available) when no id is given
 * or the requested id doesn't exist.
 */
export function resolvePersona(personas: Map<string, Persona>, id: string | undefined): Persona {
  if (id && personas.has(id)) return personas.get(id)!;
  for (const [, p] of personas) {
    if (p.country === "US" && p.device_class === "desktop") return p;
  }
  const first = personas.values().next();
  if (first.done) throw new Error("no personas available");
  return first.value;
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

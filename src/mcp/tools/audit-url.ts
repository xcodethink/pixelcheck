/**
 * `audit_url` — full UX audit pipeline against a single URL/persona.
 *
 * Composed `preset` tool: under the hood it builds an ad-hoc autonomous
 * scenario, runs the agent loop, scores it, and writes both JSON and
 * SPA reports. When the N-1~N-4 primitives land, this stays as the
 * curated end-to-end path; primitive callers can choose to skip it.
 */

import * as path from "node:path";
import { loadPersonas, resolvePersonasDir } from "../../core/persona.js";
import { ProjectConfigSchema, ScenarioSchema } from "../../core/types.js";
import { AuditUrlResultSchema } from "../../core/result-schema.js";
import { stampedTextResult, type ToolResult } from "../result.js";
import { requireString, resolvePersona } from "../helpers.js";
import type { ToolDefinition } from "../registry.js";

const inputSchema = {
  type: "object",
  properties: {
    url: { type: "string", description: "The URL to audit" },
    persona: {
      type: "string",
      description:
        "Persona id (e.g. 'us-chatgpt-pro-macbook', 'jp-mobile'). If omitted, uses a sensible default.",
    },
    scenario: {
      type: "string",
      description:
        "Path to a scenario YAML. Omit to use the default 'smoke' autonomous scenario.",
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

async function handler(args: Record<string, unknown>): Promise<ToolResult> {
  const url = requireString(args.url, "url");
  // SSRF guard: an MCP client is untrusted. Block private/internal/metadata
  // targets unless the operator explicitly opts in. (Audit 2026-06-02 B2.)
  const { assertSafeUrl } = await import("../../core/url-guard.js");
  assertSafeUrl(url, { allowPrivate: process.env.PIXELCHECK_ALLOW_PRIVATE === "1" });
  const personaId = typeof args.persona === "string" ? args.persona : undefined;
  const costMode = (args.cost_mode as "max" | "balanced" | "economy") ?? "balanced";
  const budget = typeof args.budget_usd === "number" ? args.budget_usd : 2.0;
  const personasDir =
    typeof args.personas_dir === "string" ? args.personas_dir : "./personas";

  // Dynamic imports keep these heavy modules (playwright wrapper, anthropic SDK)
  // out of the MCP server cold-start path. list_personas / list_scenarios never
  // pay this cost.
  const { runAudit } = await import("../../core/runner.js");
  const { writeSpaReport } = await import("../../core/reporter-spa.js");
  const { writeJsonReport } = await import("../../core/reporter.js");

  const personas = await loadPersonas(resolvePersonasDir(personasDir));
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
  return stampedTextResult("AuditUrlResult", AuditUrlResultSchema, {
    status: r?.status,
    overall_score: r?.overall_score,
    cost_usd: audit.summary.total_cost_usd,
    issues: r?.issues.length ?? 0,
    critical_issues: audit.summary.critical_issues,
    report_json: jsonPath,
    report_html: spaPath,
  });
}

export const auditUrlTool: ToolDefinition = {
  name: "audit_url",
  description:
    "Run a UX audit against a URL using one persona. Returns the audit summary + report path.",
  kind: "preset",
  resultSchema: "AuditUrlResult",
  cacheable: false,
  costEstimateUsd: {
    typical: 0.3,
    min: 0.05,
    max: 2.0,
    unit: "per_persona_scenario",
    notes:
      "Full audit pipeline: navigation + scenario steps + critic vision pass + reporter. Cost scales with scenario step count. The per-call `budget_usd` cap (default $2) hard-limits worst case.",
  },
  sideEffects: [
    "navigation",
    "network_egress",
    "fs_writes_artifacts",
    "fs_writes_history",
  ],
  requires: {
    apiKeys: ["ANTHROPIC_API_KEY"],
    browser: true,
    personasDir: true,
  },
  inputSchema,
  handler,
};

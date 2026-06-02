/**
 * `explore_url` — autonomous agent run with a free-form goal.
 *
 * Composed `preset` tool. Lighter than `audit_url`: no scenario YAML,
 * no full reporter pipeline, just goal + URL → agent loop → convergence
 * summary. Once N-1 (`see`) and N-2 (`act`) primitives ship, AI clients
 * can either keep using this preset or wire their own loop.
 */

import * as path from "node:path";
import { loadPersonas, resolvePersonasDir } from "../../core/persona.js";
import { ProjectConfigSchema, ScenarioSchema } from "../../core/types.js";
import { ExploreUrlResultSchema } from "../../core/result-schema.js";
import { stampedTextResult, type ToolResult } from "../result.js";
import { requireString, resolvePersona } from "../helpers.js";
import type { ToolDefinition } from "../registry.js";

const inputSchema = {
  type: "object",
  properties: {
    url: { type: "string", description: "The start URL" },
    goal: { type: "string", description: "The exploration goal, in natural language" },
    success_criteria: {
      type: "array",
      items: { type: "string" },
      description:
        "One or more human-language success criteria the agent must satisfy.",
    },
    persona: { type: "string", description: "Persona id. Optional." },
    budget_usd: { type: "number", description: "Max USD. Default: 2.0." },
    max_actions: {
      type: "number",
      description: "Hard cap on agent actions. Default: 30.",
    },
  },
  required: ["url", "goal"],
};

async function handler(args: Record<string, unknown>): Promise<ToolResult> {
  const url = requireString(args.url, "url");
  // SSRF guard: an MCP client is untrusted. Block private/internal/metadata
  // targets unless the operator explicitly opts in. (Audit 2026-06-02 B2.)
  const { assertSafeUrl } = await import("../../core/url-guard.js");
  assertSafeUrl(url, { allowPrivate: process.env.PIXELCHECK_ALLOW_PRIVATE === "1" });
  const goal = requireString(args.goal, "goal");
  const criteriaInput = Array.isArray(args.success_criteria)
    ? (args.success_criteria as string[])
    : [];
  const personaId = typeof args.persona === "string" ? args.persona : undefined;
  const budget = typeof args.budget_usd === "number" ? args.budget_usd : 2.0;
  const maxActions =
    typeof args.max_actions === "number" ? args.max_actions : 30;

  const { runAudit } = await import("../../core/runner.js");
  const personas = await loadPersonas(resolvePersonasDir());
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
  return stampedTextResult("ExploreUrlResult", ExploreUrlResultSchema, {
    status: r?.status,
    convergence: r?.agent_summary?.convergence_reason,
    criteria_met: r?.agent_summary?.criteria_met,
    criteria_missed: r?.agent_summary?.criteria_missed,
    total_actions: r?.agent_summary?.total_actions,
    cost_usd: audit.summary.total_cost_usd,
  });
}

export const exploreUrlTool: ToolDefinition = {
  name: "explore_url",
  description:
    "Send the autonomous agent to explore a URL with a free-form goal. Faster than audit_url; no scenario file required.",
  kind: "preset",
  resultSchema: "ExploreUrlResult",
  cacheable: false,
  costEstimateUsd: {
    typical: 0.15,
    min: 0.02,
    max: 2.0,
    unit: "per_call",
    notes:
      "Autonomous agent loop with free-form goal — cost scales with action count and replan rate. The per-call `budget_usd` cap (default $2) hard-limits worst case.",
  },
  sideEffects: [
    "navigation",
    "state_changing",
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

/**
 * `list_personas` — enumerate persona YAMLs in a project.
 *
 * Pure file-system read. No LLM, no browser. Safe to call without
 * any API keys.
 */

import { loadPersonas, resolvePersonasDir } from "../../core/persona.js";
import { ListPersonasResultSchema } from "../../core/result-schema.js";
import { stampedTextResult, type ToolResult } from "../result.js";
import type { ToolDefinition } from "../registry.js";

const inputSchema = {
  type: "object",
  properties: {
    personas_dir: {
      type: "string",
      description: "Optional personas dir. Default: './personas'.",
    },
  },
};

async function handler(args: Record<string, unknown>): Promise<ToolResult> {
  const dir = typeof args.personas_dir === "string" ? args.personas_dir : "./personas";
  const personas = await loadPersonas(resolvePersonasDir(dir));
  const summary = Array.from(personas.values()).map((p) => ({
    id: p.id,
    display_name: p.display_name,
    country: p.country,
    language: p.language,
    device: p.device_class,
    payment_tier: p.payment_tier,
  }));
  return stampedTextResult("ListPersonasResult", ListPersonasResultSchema, summary);
}

export const listPersonasTool: ToolDefinition = {
  name: "list_personas",
  description: "List all personas available in the project's personas/ directory.",
  kind: "meta",
  resultSchema: "ListPersonasResult",
  cacheable: false,
  costEstimateUsd: { typical: 0, min: 0, max: 0, unit: "per_call" },
  sideEffects: ["fs_reads"],
  requires: { apiKeys: [], browser: false, personasDir: true },
  inputSchema,
  handler,
};

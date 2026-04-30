/**
 * `list_scenarios` — enumerate scenario YAMLs in a project.
 *
 * Pure file-system read. No LLM, no browser.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ListScenariosResultSchema } from "../../core/result-schema.js";
import { stampedTextResult, textResult, type ToolResult } from "../result.js";
import type { ToolDefinition } from "../registry.js";

const inputSchema = {
  type: "object",
  properties: {
    scenarios_dir: {
      type: "string",
      description: "Optional scenarios dir. Default: './scenarios'.",
    },
  },
};

async function handler(args: Record<string, unknown>): Promise<ToolResult> {
  const dir = typeof args.scenarios_dir === "string" ? args.scenarios_dir : "./scenarios";
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) {
    return textResult(`no scenarios directory at ${resolved}`);
  }
  const files = fs
    .readdirSync(resolved)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  return stampedTextResult("ListScenariosResult", ListScenariosResultSchema, files);
}

export const listScenariosTool: ToolDefinition = {
  name: "list_scenarios",
  description: "List all scenarios available in the project's scenarios/ directory.",
  kind: "meta",
  resultSchema: "ListScenariosResult",
  cacheable: false,
  costEstimateUsd: { typical: 0, min: 0, max: 0, unit: "per_call" },
  sideEffects: ["fs_reads"],
  requires: { apiKeys: [], browser: false, scenariosDir: true },
  inputSchema,
  handler,
};

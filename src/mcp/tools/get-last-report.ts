/**
 * `get_last_report` — fetch the most recent audit's summary JSON
 * from the local reports history DB.
 */

import * as path from "node:path";
import { HistoryEntrySchema } from "../../core/result-schema.js";
import { stampedTextResult, textResult, type ToolResult } from "../result.js";
import type { ToolDefinition } from "../registry.js";

const inputSchema = {
  type: "object",
  properties: {
    reports_root: {
      type: "string",
      description: "Path to reports root. Defaults to './reports'.",
    },
  },
};

async function handler(args: Record<string, unknown>): Promise<ToolResult> {
  const reportsRoot =
    typeof args.reports_root === "string" ? args.reports_root : "./reports";
  const { loadHistory } = await import("../../core/history.js");
  const entries = loadHistory(path.resolve(reportsRoot), { limit: 1 });
  if (entries.length === 0) return textResult("no audits found in history");
  return stampedTextResult("HistoryEntry", HistoryEntrySchema, entries[0]!);
}

export const getLastReportTool: ToolDefinition = {
  name: "get_last_report",
  description:
    "Read the most recent audit's summary JSON from the reports history DB.",
  kind: "meta",
  resultSchema: "HistoryEntry",
  cacheable: false,
  costEstimateUsd: { typical: 0, min: 0, max: 0, unit: "per_call" },
  sideEffects: ["fs_reads"],
  requires: { apiKeys: [], browser: false },
  inputSchema,
  handler,
};

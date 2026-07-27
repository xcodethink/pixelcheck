/**
 * `get_last_report` — fetch the most recent audit's summary JSON
 * from the local reports history DB.
 */

import * as path from "node:path";
import { HistoryEntrySchema } from "../../core/result-schema.js";
import { pixelcheckHome } from "../../core/home-dir.js";
import { stampedTextResult, textResult, type ToolResult } from "../result.js";
import type { ToolDefinition } from "../registry.js";

/**
 * Confine a caller-supplied reports root to the current project (cwd) or the
 * pixelcheck home dir. An MCP client is untrusted; without this it could point
 * `reports_root` at any directory and read prior audits (which may contain
 * unredacted page content) across projects on a shared host. (Audit 2026-06-02 B3.)
 */
function resolveSafeReportsRoot(raw: string): string {
  const resolved = path.resolve(raw);
  const allowedBases = [process.cwd(), pixelcheckHome()].map((b) =>
    path.resolve(b),
  );
  const ok = allowedBases.some(
    (base) => resolved === base || resolved.startsWith(base + path.sep),
  );
  if (!ok) {
    throw new Error(
      `reports_root "${raw}" is outside the allowed locations ` +
        `(the current project directory or ${pixelcheckHome()}).`,
    );
  }
  return resolved;
}

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
  const safeRoot = resolveSafeReportsRoot(reportsRoot);
  const { loadHistory } = await import("../../core/history.js");
  const entries = loadHistory(safeRoot, { limit: 1 });
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

/**
 * `calibrate_critic` — run the critic calibration gate against labeled
 * screenshot fixtures and return pass/fail + agreement metrics.
 *
 * Operations / quality tool, not a primitive.
 */

import * as path from "node:path";
import { CalibrateCriticResultSchema } from "../../core/result-schema.js";
import { stampedTextResult, type ToolResult } from "../result.js";
import type { ToolDefinition } from "../registry.js";

const inputSchema = {
  type: "object",
  properties: {
    fixtures_dir: { type: "string", description: "Calibration fixtures dir." },
    model: { type: "string", description: "Critic model id override." },
  },
};

async function handler(args: Record<string, unknown>): Promise<ToolResult> {
  const fixturesDir =
    typeof args.fixtures_dir === "string"
      ? args.fixtures_dir
      : "./tests/fixtures/critic-calibration";
  const model = typeof args.model === "string" ? args.model : "claude-sonnet-4-6";
  const { runCalibration, scoreReport } = await import(
    "../../calibration/runner.js"
  );
  const outDir = path.resolve(`./reports/calibration/mcp_${Date.now()}`);
  const report = await runCalibration({
    fixturesDir: path.resolve(fixturesDir),
    model,
    tag: "mcp",
    outputDir: outDir,
  });
  const gate = scoreReport(report);
  return stampedTextResult("CalibrateCriticResult", CalibrateCriticResultSchema, {
    passed: gate.passed,
    violations: gate.violations,
    mean_agreement: gate.computed.mean_agreement,
    mean_max_distance: gate.computed.mean_max_distance,
    fully_aligned_rate: gate.computed.fully_aligned_rate,
    total_cost_usd: report.total_cost_usd,
    report_dir: outDir,
  });
}

export const calibrateCriticTool: ToolDefinition = {
  name: "calibrate_critic",
  description:
    "Run the critic calibration gate against labeled screenshot fixtures. Returns pass/fail + metrics.",
  kind: "meta",
  resultSchema: "CalibrateCriticResult",
  cacheable: false,
  costEstimateUsd: {
    typical: 0.5,
    min: 0.1,
    max: 2.0,
    unit: "per_call",
    notes: "1 vision call per fixture; depends on fixture set size.",
  },
  sideEffects: ["network_egress", "fs_reads", "fs_writes_artifacts"],
  requires: { apiKeys: ["ANTHROPIC_API_KEY"], browser: false },
  inputSchema,
  handler,
};

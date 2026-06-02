/**
 * Critic Calibration Runner.
 *
 * For each sample:
 *   1. Load the screenshot
 *   2. Build a minimal (persona, scenario) context and call runCritic()
 *   3. Compare the returned scores against the labeled ranges
 *   4. Compute agreement_rate, max_distance, and an overall report
 *
 * Output: CalibrationReport (JSON + markdown) for CI gate and trend tracking.
 *
 * Gate criteria (commercial-practice defaults):
 *   - mean_agreement       ≥ 0.85
 *   - mean_max_distance    ≤ 1.5
 *   - fully_aligned ratio  ≥ 0.70
 * Exposed via scoreReport() so CI can assert against them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CalibrationSample,
  CalibrationReport,
  SampleAgreement,
  DimensionAgreement,
} from "./types.js";
import { CalibrationSampleSchema } from "./types.js";
import type { Persona, Scenario } from "../core/types.js";
import { runCritic } from "../core/critic.js";
import { RESULT_SCHEMA_VERSION } from "../core/result-schema.js";

export interface CalibrationRunOpts {
  fixturesDir: string;
  /** Override set of sample files (optional; default: all *.json in fixturesDir) */
  sampleFiles?: string[];
  model: string;
  tag: string;
  outputDir: string;
  /** Optional persona map for persona_id lookup; falls back to synthetic stub */
  personas?: Map<string, Persona>;
  onSampleComplete?: (s: SampleAgreement) => void;
}

// ─────────────────────────────────────────────────────────────
// Sample loading
// ─────────────────────────────────────────────────────────────

export function loadSamples(dir: string, files?: string[]): CalibrationSample[] {
  const names = files ?? fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  const out: CalibrationSample[] = [];
  for (const name of names) {
    const full = path.join(dir, name);
    const raw = JSON.parse(fs.readFileSync(full, "utf8"));
    const parsed = CalibrationSampleSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`calibration sample ${name} invalid: ${parsed.error.message}`);
    }
    out.push(parsed.data);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Agreement math (pure, testable)
// ─────────────────────────────────────────────────────────────

export interface CriticDimensionScore {
  dimension: string;
  score: number;
}

export function computeDimensionAgreement(
  labels: CalibrationSample["labels"],
  critic: CriticDimensionScore[],
): DimensionAgreement[] {
  return labels.map((label) => {
    const match = critic.find((c) => c.dimension === label.dimension);
    if (!match) {
      return {
        dimension: label.dimension,
        critic_score: null,
        expected_min: label.min_score,
        expected_max: label.max_score,
        in_range: false,
        distance: label.max_score - label.min_score + 1, // treated as large miss
      };
    }
    const inRange = match.score >= label.min_score && match.score <= label.max_score;
    const distance = inRange
      ? 0
      : match.score < label.min_score
        ? label.min_score - match.score
        : match.score - label.max_score;
    return {
      dimension: label.dimension,
      critic_score: match.score,
      expected_min: label.min_score,
      expected_max: label.max_score,
      in_range: inRange,
      distance,
    };
  });
}

export function summarizeAgreement(per: DimensionAgreement[]): {
  agreement_rate: number;
  max_distance: number;
} {
  if (per.length === 0) return { agreement_rate: 0, max_distance: 0 };
  const inRange = per.filter((d) => d.in_range).length;
  const maxDistance = per.reduce((m, d) => Math.max(m, d.distance), 0);
  return { agreement_rate: inRange / per.length, max_distance: maxDistance };
}

export function checkIssueExpectations(
  expected: CalibrationSample["expected_issues"],
  issues: Array<{ severity: string; description: string }>,
): { passed: boolean; detail: string } {
  if (!expected) return { passed: true, detail: "n/a" };
  const crit = issues.filter((i) => i.severity === "critical").length;
  if (expected.min_critical !== undefined && crit < expected.min_critical) {
    return {
      passed: false,
      detail: `critical issues: ${crit} < min ${expected.min_critical}`,
    };
  }
  if (expected.max_critical !== undefined && crit > expected.max_critical) {
    return {
      passed: false,
      detail: `critical issues: ${crit} > max ${expected.max_critical}`,
    };
  }
  if (expected.must_flag_any_of && expected.must_flag_any_of.length > 0) {
    const haystack = issues.map((i) => i.description.toLowerCase()).join(" | ");
    const hit = expected.must_flag_any_of.some((needle) =>
      haystack.includes(needle.toLowerCase()),
    );
    if (!hit) {
      return {
        passed: false,
        detail: `expected at least one of: [${expected.must_flag_any_of.join(", ")}], none flagged`,
      };
    }
  }
  return { passed: true, detail: "issue expectations met" };
}

// ─────────────────────────────────────────────────────────────
// Report aggregation (pure)
// ─────────────────────────────────────────────────────────────

export function aggregateReport(
  samples: SampleAgreement[],
  tag: string,
  model: string,
  startedAt: Date,
  finishedAt: Date,
): CalibrationReport {
  const total = samples.length;
  const fullyAligned = samples.filter(
    (s) => s.agreement_rate === 1 && s.issue_check.passed,
  ).length;
  const dimsAligned = samples.filter((s) => s.agreement_rate === 1).length;
  const meanAgreement =
    total === 0 ? 0 : samples.reduce((s, x) => s + x.agreement_rate, 0) / total;
  const meanMaxDist =
    total === 0 ? 0 : samples.reduce((s, x) => s + x.max_distance, 0) / total;
  const totalCost = samples.reduce((s, x) => s + x.cost_usd, 0);

  // Per-dimension stats
  const perDim: Record<string, { count: number; in_range: number; avg_distance: number; sum_distance: number }> = {};
  for (const s of samples) {
    for (const d of s.per_dimension) {
      if (!perDim[d.dimension]) {
        perDim[d.dimension] = { count: 0, in_range: 0, avg_distance: 0, sum_distance: 0 };
      }
      perDim[d.dimension]!.count++;
      if (d.in_range) perDim[d.dimension]!.in_range++;
      perDim[d.dimension]!.sum_distance += d.distance;
    }
  }
  const per_dimension_stats: CalibrationReport["per_dimension_stats"] = {};
  for (const [dim, stat] of Object.entries(perDim)) {
    per_dimension_stats[dim] = {
      count: stat.count,
      in_range: stat.in_range,
      in_range_rate: stat.in_range / stat.count,
      avg_distance: stat.sum_distance / stat.count,
    };
  }

  return {
    schema_version: RESULT_SCHEMA_VERSION,
    tag,
    model,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    total_samples: total,
    fully_aligned: fullyAligned,
    dimensions_aligned: dimsAligned,
    mean_agreement: meanAgreement,
    mean_max_distance: meanMaxDist,
    per_dimension_stats,
    samples,
    total_cost_usd: Math.round(totalCost * 10000) / 10000,
  };
}

// ─────────────────────────────────────────────────────────────
// Gate / scoring for CI
// ─────────────────────────────────────────────────────────────

export interface GateThresholds {
  min_mean_agreement?: number;
  max_mean_max_distance?: number;
  min_fully_aligned_rate?: number;
}

export const DEFAULT_GATE: Required<GateThresholds> = {
  min_mean_agreement: 0.85,
  max_mean_max_distance: 1.5,
  min_fully_aligned_rate: 0.7,
};

export interface GateResult {
  /** Result schema version (SemVer). Stamped by `scoreReport`. */
  schema_version?: string;
  passed: boolean;
  violations: string[];
  computed: {
    mean_agreement: number;
    mean_max_distance: number;
    fully_aligned_rate: number;
  };
}

export function scoreReport(
  report: CalibrationReport,
  thresholds: GateThresholds = {},
): GateResult {
  // Only apply overrides that are actually numeric — a naive spread would
  // overwrite defaults with `undefined` from CLI options that weren't supplied,
  // silently disabling the gate. (Caught in Phase 2 live smoke v0.3.0-rc.1.)
  const t = { ...DEFAULT_GATE };
  if (typeof thresholds.min_mean_agreement === "number") t.min_mean_agreement = thresholds.min_mean_agreement;
  if (typeof thresholds.max_mean_max_distance === "number") t.max_mean_max_distance = thresholds.max_mean_max_distance;
  if (typeof thresholds.min_fully_aligned_rate === "number") t.min_fully_aligned_rate = thresholds.min_fully_aligned_rate;
  const fullyAlignedRate =
    report.total_samples === 0 ? 0 : report.fully_aligned / report.total_samples;
  const violations: string[] = [];
  if (report.mean_agreement < t.min_mean_agreement) {
    violations.push(
      `mean_agreement ${report.mean_agreement.toFixed(3)} < ${t.min_mean_agreement}`,
    );
  }
  if (report.mean_max_distance > t.max_mean_max_distance) {
    violations.push(
      `mean_max_distance ${report.mean_max_distance.toFixed(3)} > ${t.max_mean_max_distance}`,
    );
  }
  if (fullyAlignedRate < t.min_fully_aligned_rate) {
    violations.push(
      `fully_aligned_rate ${fullyAlignedRate.toFixed(3)} < ${t.min_fully_aligned_rate}`,
    );
  }
  return {
    schema_version: RESULT_SCHEMA_VERSION,
    passed: violations.length === 0,
    violations,
    computed: {
      mean_agreement: report.mean_agreement,
      mean_max_distance: report.mean_max_distance,
      fully_aligned_rate: fullyAlignedRate,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Runtime orchestration
// ─────────────────────────────────────────────────────────────

/**
 * Execute the calibration run. Uses a minimal scenario stub per sample so
 * runCritic() has the contextual bits it needs without requiring a full
 * YAML scenario.
 */
export async function runCalibration(opts: CalibrationRunOpts): Promise<CalibrationReport> {
  const startedAt = new Date();
  const samples = loadSamples(opts.fixturesDir, opts.sampleFiles);
  fs.mkdirSync(opts.outputDir, { recursive: true });
  const perSample: SampleAgreement[] = [];

  for (const sample of samples) {
    const persona =
      opts.personas?.get(sample.persona_id) ?? makeStubPersona(sample.persona_id);
    const scenario = makeStubScenario(sample);
    const start = Date.now();
    try {
      const buf = fs.readFileSync(path.join(opts.fixturesDir, sample.screenshot));
      const result = await runCritic({
        model: opts.model,
        persona,
        scenario,
        instruction: sample.instruction,
        imageBuffers: [buf],
        stepId: sample.id,
      });

      const perDim = computeDimensionAgreement(
        sample.labels,
        result.scores.map((s) => ({ dimension: s.dimension, score: s.score })),
      );
      const agg = summarizeAgreement(perDim);
      const issueCheck = checkIssueExpectations(sample.expected_issues, result.issues);

      const entry: SampleAgreement = {
        sample_id: sample.id,
        description: sample.description,
        tags: sample.tags,
        per_dimension: perDim,
        agreement_rate: agg.agreement_rate,
        max_distance: agg.max_distance,
        issue_check: issueCheck,
        cost_usd: result.costUsd,
        duration_ms: Date.now() - start,
      };
      perSample.push(entry);
      opts.onSampleComplete?.(entry);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const entry: SampleAgreement = {
        sample_id: sample.id,
        description: sample.description,
        tags: sample.tags,
        per_dimension: [],
        agreement_rate: 0,
        max_distance: 10,
        issue_check: { passed: false, detail: "run error" },
        cost_usd: 0,
        duration_ms: Date.now() - start,
        error: errMsg,
      };
      perSample.push(entry);
      opts.onSampleComplete?.(entry);
    }
  }

  const report = aggregateReport(perSample, opts.tag, opts.model, startedAt, new Date());
  fs.writeFileSync(
    path.join(opts.outputDir, "calibration.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(opts.outputDir, "calibration.md"),
    renderCalibrationMarkdown(report),
    "utf8",
  );
  return report;
}

export function renderCalibrationMarkdown(report: CalibrationReport): string {
  const lines: string[] = [];
  lines.push(`# Critic Calibration: ${report.tag}`);
  lines.push("");
  lines.push(`- Model: \`${report.model}\``);
  lines.push(`- Samples: ${report.total_samples}`);
  lines.push(`- Total cost: $${report.total_cost_usd.toFixed(3)}`);
  lines.push("");
  lines.push(`## Gate metrics`);
  lines.push(`| metric | value |`);
  lines.push(`|---|---|`);
  lines.push(`| mean agreement | **${(report.mean_agreement * 100).toFixed(1)}%** |`);
  lines.push(`| mean max distance | **${report.mean_max_distance.toFixed(2)}** |`);
  const fa =
    report.total_samples === 0 ? 0 : report.fully_aligned / report.total_samples;
  lines.push(`| fully aligned | ${(fa * 100).toFixed(1)}% (${report.fully_aligned}/${report.total_samples}) |`);
  lines.push(`| dimensions aligned | ${report.dimensions_aligned}/${report.total_samples} |`);
  lines.push("");

  lines.push(`## Per-dimension`);
  lines.push(`| dimension | in-range rate | avg distance | count |`);
  lines.push(`|---|---|---|---|`);
  for (const [d, stat] of Object.entries(report.per_dimension_stats)) {
    lines.push(`| ${d} | ${(stat.in_range_rate * 100).toFixed(1)}% | ${stat.avg_distance.toFixed(2)} | ${stat.count} |`);
  }
  lines.push("");

  lines.push(`## Per-sample`);
  lines.push(`| sample | agreement | max dist | issues | cost |`);
  lines.push(`|---|---|---|---|---|`);
  for (const s of report.samples) {
    lines.push(
      `| ${s.sample_id} | ${(s.agreement_rate * 100).toFixed(0)}% | ${s.max_distance.toFixed(1)} | ${s.issue_check.passed ? "[OK]" : "[FAIL]"} | $${s.cost_usd.toFixed(3)} |`,
    );
  }
  return lines.join("\n") + "\n";
}

// ─────────────────────────────────────────────────────────────
// Stubs for minimal critic context
// ─────────────────────────────────────────────────────────────

function makeStubPersona(id: string): Persona {
  return {
    id,
    display_name: id,
    country: "US",
    language: "en",
    locale: "en-US",
    timezone: "America/New_York",
    device_class: "desktop",
    payment_tier: "free",
    mental_model: "calibration stub persona",
    critical_concerns: [],
  };
}

function makeStubScenario(sample: CalibrationSample): Scenario {
  const dims = sample.labels.map((l) => l.dimension);
  // Cast is safe — Scenario allows the superset via free-form dims
  return {
    id: `calib_${sample.id}`,
    name: `Calibration: ${sample.description.slice(0, 40)}`,
    priority: "P2",
    goal: sample.scenario_goal,
    applies_to: { personas: [sample.persona_id] },
    scoring_dimensions: dims as unknown as Scenario["scoring_dimensions"],
    mode: "scripted",
    steps: [{ type: "screenshot", id: "s1", full_page: true, critical: false, critical_review: false, retry: 0 }],
    persistent_storage: false,
  };
}

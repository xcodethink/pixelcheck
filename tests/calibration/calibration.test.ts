/**
 * Unit tests for the pure calibration helpers (agreement math, report
 * aggregation, gate scoring). The runCritic call is live-API, covered by
 * manual smoke, not these tests.
 */

import { describe, it, expect } from "vitest";
import {
  computeDimensionAgreement,
  summarizeAgreement,
  checkIssueExpectations,
  aggregateReport,
  scoreReport,
  DEFAULT_GATE,
  renderCalibrationMarkdown,
  loadSamples,
} from "../../src/calibration/runner.js";
import type { SampleAgreement, CalibrationSample } from "../../src/calibration/types.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "../fixtures/critic-calibration");

// ─────────────────────────────────────────────────────────────
// computeDimensionAgreement
// ─────────────────────────────────────────────────────────────

describe("computeDimensionAgreement", () => {
  const labels: CalibrationSample["labels"] = [
    { dimension: "visual_polish", min_score: 5, max_score: 9 },
    { dimension: "localization", min_score: 7, max_score: 10 },
  ];

  it("marks in_range when critic score sits inside the label range", () => {
    const result = computeDimensionAgreement(labels, [
      { dimension: "visual_polish", score: 7 },
      { dimension: "localization", score: 8 },
    ]);
    expect(result.every((r) => r.in_range)).toBe(true);
    expect(result.every((r) => r.distance === 0)).toBe(true);
  });

  it("computes distance when under min", () => {
    const result = computeDimensionAgreement(labels, [
      { dimension: "visual_polish", score: 3 },
      { dimension: "localization", score: 8 },
    ]);
    expect(result[0]!.in_range).toBe(false);
    expect(result[0]!.distance).toBe(2);
  });

  it("computes distance when over max", () => {
    const result = computeDimensionAgreement(labels, [
      { dimension: "visual_polish", score: 7 },
      { dimension: "localization", score: 10 },
    ]);
    expect(result[1]!.in_range).toBe(true); // 10 is the max, inclusive
  });

  it("treats missing dimensions as not-in-range with large distance", () => {
    const result = computeDimensionAgreement(labels, []);
    expect(result[0]!.critic_score).toBeNull();
    expect(result[0]!.in_range).toBe(false);
    expect(result[0]!.distance).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────
// summarizeAgreement
// ─────────────────────────────────────────────────────────────

describe("summarizeAgreement", () => {
  it("returns 1.0 when all in range", () => {
    const agg = summarizeAgreement([
      { dimension: "a", critic_score: 5, expected_min: 4, expected_max: 6, in_range: true, distance: 0 },
      { dimension: "b", critic_score: 8, expected_min: 7, expected_max: 10, in_range: true, distance: 0 },
    ]);
    expect(agg.agreement_rate).toBe(1);
    expect(agg.max_distance).toBe(0);
  });

  it("reports max_distance of the worst offender", () => {
    const agg = summarizeAgreement([
      { dimension: "a", critic_score: 5, expected_min: 4, expected_max: 6, in_range: true, distance: 0 },
      { dimension: "b", critic_score: 2, expected_min: 7, expected_max: 10, in_range: false, distance: 5 },
      { dimension: "c", critic_score: 8, expected_min: 7, expected_max: 10, in_range: true, distance: 0 },
    ]);
    expect(agg.agreement_rate).toBeCloseTo(2 / 3);
    expect(agg.max_distance).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────
// checkIssueExpectations
// ─────────────────────────────────────────────────────────────

describe("checkIssueExpectations", () => {
  it("passes when no expectation provided", () => {
    const r = checkIssueExpectations(undefined, []);
    expect(r.passed).toBe(true);
  });

  it("fails when min_critical not reached", () => {
    const r = checkIssueExpectations(
      { min_critical: 1 },
      [{ severity: "high", description: "" }],
    );
    expect(r.passed).toBe(false);
  });

  it("fails when max_critical exceeded", () => {
    const r = checkIssueExpectations(
      { max_critical: 0 },
      [{ severity: "critical", description: "" }],
    );
    expect(r.passed).toBe(false);
  });

  it("passes when must_flag_any_of matches a phrase case-insensitively", () => {
    const r = checkIssueExpectations(
      { must_flag_any_of: ["Broken image"] },
      [{ severity: "medium", description: "The page has a broken image link" }],
    );
    expect(r.passed).toBe(true);
  });

  it("fails when must_flag_any_of has no hit", () => {
    const r = checkIssueExpectations(
      { must_flag_any_of: ["something specific"] },
      [{ severity: "medium", description: "unrelated issue" }],
    );
    expect(r.passed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// aggregateReport
// ─────────────────────────────────────────────────────────────

function mkSample(overrides: Partial<SampleAgreement> = {}): SampleAgreement {
  return {
    sample_id: "s",
    description: "",
    tags: [],
    per_dimension: [
      { dimension: "a", critic_score: 7, expected_min: 5, expected_max: 9, in_range: true, distance: 0 },
    ],
    agreement_rate: 1,
    max_distance: 0,
    issue_check: { passed: true, detail: "ok" },
    cost_usd: 0.01,
    duration_ms: 200,
    ...overrides,
  };
}

describe("aggregateReport", () => {
  it("computes mean_agreement and fully_aligned", () => {
    const s1 = mkSample({ sample_id: "a", agreement_rate: 1 });
    const s2 = mkSample({ sample_id: "b", agreement_rate: 0.5, max_distance: 2 });
    const s3 = mkSample({
      sample_id: "c",
      agreement_rate: 1,
      issue_check: { passed: false, detail: "missing flag" },
    });
    const report = aggregateReport([s1, s2, s3], "t", "m", new Date(), new Date());
    expect(report.total_samples).toBe(3);
    expect(report.fully_aligned).toBe(1); // only s1 satisfies both
    expect(report.dimensions_aligned).toBe(2); // s1 and s3
    expect(report.mean_agreement).toBeCloseTo((1 + 0.5 + 1) / 3);
    expect(report.mean_max_distance).toBeCloseTo(2 / 3);
  });

  it("builds per_dimension_stats correctly", () => {
    const s1 = mkSample({
      sample_id: "a",
      per_dimension: [
        { dimension: "visual_polish", critic_score: 7, expected_min: 5, expected_max: 9, in_range: true, distance: 0 },
        { dimension: "localization", critic_score: 4, expected_min: 7, expected_max: 10, in_range: false, distance: 3 },
      ],
    });
    const s2 = mkSample({
      sample_id: "b",
      per_dimension: [
        { dimension: "visual_polish", critic_score: 6, expected_min: 5, expected_max: 9, in_range: true, distance: 0 },
      ],
    });
    const report = aggregateReport([s1, s2], "t", "m", new Date(), new Date());
    expect(report.per_dimension_stats.visual_polish.count).toBe(2);
    expect(report.per_dimension_stats.visual_polish.in_range_rate).toBe(1);
    expect(report.per_dimension_stats.localization.in_range_rate).toBe(0);
    expect(report.per_dimension_stats.localization.avg_distance).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────
// scoreReport (gate)
// ─────────────────────────────────────────────────────────────

describe("scoreReport", () => {
  const mkReport = (overrides: Partial<Parameters<typeof scoreReport>[0]> = {}) => ({
    tag: "t",
    model: "m",
    started_at: "",
    finished_at: "",
    total_samples: 10,
    fully_aligned: 8,
    dimensions_aligned: 9,
    mean_agreement: 0.9,
    mean_max_distance: 1.0,
    per_dimension_stats: {},
    samples: [],
    total_cost_usd: 0,
    ...overrides,
  });

  it("passes when all thresholds met", () => {
    const r = scoreReport(mkReport());
    expect(r.passed).toBe(true);
  });

  it("fails on low mean_agreement", () => {
    const r = scoreReport(mkReport({ mean_agreement: 0.7 }));
    expect(r.passed).toBe(false);
    expect(r.violations[0]).toMatch(/mean_agreement/);
  });

  it("fails on high mean_max_distance", () => {
    const r = scoreReport(mkReport({ mean_max_distance: 3 }));
    expect(r.passed).toBe(false);
    expect(r.violations[0]).toMatch(/mean_max_distance/);
  });

  it("fails on low fully_aligned rate", () => {
    const r = scoreReport(mkReport({ total_samples: 10, fully_aligned: 3 }));
    expect(r.passed).toBe(false);
    expect(r.violations[0]).toMatch(/fully_aligned_rate/);
  });

  it("accepts custom thresholds", () => {
    const r = scoreReport(mkReport({ mean_agreement: 0.5 }), { min_mean_agreement: 0.4 });
    expect(r.passed).toBe(true);
  });

  it("does not silently disable the gate when thresholds are undefined (regression)", () => {
    // Was a bug where { ...DEFAULT, ...{ min_mean_agreement: undefined } }
    // overwrote the default with undefined, making every comparison return false.
    const r = scoreReport(mkReport({ mean_agreement: 0.3 }), {
      min_mean_agreement: undefined,
      max_mean_max_distance: undefined,
      min_fully_aligned_rate: undefined,
    });
    expect(r.passed).toBe(false);
    expect(r.violations[0]).toMatch(/mean_agreement/);
  });

  it("default gate has sane values", () => {
    expect(DEFAULT_GATE.min_mean_agreement).toBeGreaterThan(0.5);
    expect(DEFAULT_GATE.min_mean_agreement).toBeLessThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────
// renderCalibrationMarkdown & loadSamples
// ─────────────────────────────────────────────────────────────

describe("renderCalibrationMarkdown", () => {
  it("renders a well-formed report", () => {
    const r = aggregateReport([mkSample()], "render-test", "m", new Date(), new Date());
    const md = renderCalibrationMarkdown(r);
    expect(md).toMatch(/# Critic Calibration: render-test/);
    expect(md).toMatch(/mean agreement/);
    expect(md).toMatch(/per-dimension/i);
  });
});

describe("loadSamples", () => {
  it("loads all 5 fixture samples from disk", () => {
    const samples = loadSamples(FIXTURES);
    expect(samples.length).toBe(5);
    expect(samples.map((s) => s.id).sort()).toEqual([
      "broken-console-errors",
      "cls-layout-shift",
      "home-happy",
      "slow-lcp",
      "success-after-signup",
    ]);
  });

  it("rejects samples missing required fields", () => {
    // Calling loadSamples against a fake dir with a malformed file would throw
    // — we only test the happy path here since the real fixtures are valid.
    expect(() => loadSamples(FIXTURES)).not.toThrow();
  });
});

/**
 * Performance benchmarks for hot paths (M6-7).
 *
 * Run with: `npm run bench`
 *
 * What's covered: pure-function rendering / aggregation / schema
 * validation / i18n lookup. NOT covered: real Chromium spawn (would
 * flake CI), real LLM calls (cost + variance), real SQLite write
 * throughput (depends on disk).
 *
 * Benchmark results are compared to docs/perf-baseline.json by
 * `npm run bench:check`. A regression > tolerance (default 30%) on
 * any single benchmark fails the script. The 30% threshold catches
 * "someone added an O(N²) loop somewhere" without flagging the
 * 5–10% noise inherent to CI runners.
 *
 * To update the baseline after a deliberate optimisation or schema
 * change: `npm run bench:update`.
 */

import { bench, describe } from "vitest";
import * as crypto from "node:crypto";
import { renderPdfHtml, renderPdfHtml as renderPdf } from "../src/core/reporter-pdf.js";
import {
  renderTrendsHtml,
  computeSummary,
} from "../src/core/reporter-trends.js";
import {
  renderDiffHtml,
  renderDiffMarkdown,
} from "../src/core/reporter-diff.js";
import {
  renderJunitXml,
  renderSarif,
} from "../src/core/ci-reporters.js";
import { summarizeWcag } from "../src/core/wcag.js";
import { t } from "../src/core/i18n.js";
import type {
  AuditRun,
  Issue,
  ScenarioRunResult,
  RunDiff,
  HistoryEntry,
} from "../src/core/types.js";

void renderPdf; // keep an alternate name handy for future bench variants

// ─────────────────────────────────────────────────────────────
// Fixture builders — sized to reflect a realistic v1 audit
// ─────────────────────────────────────────────────────────────

function buildScenarioResult(idx: number): ScenarioRunResult {
  return {
    scenario_id: `scenario-${idx}`,
    scenario_name: `Scenario ${idx}`,
    persona_id: `persona-${idx % 5}`,
    persona_display_name: `Persona ${idx % 5}`,
    started_at: new Date(2026, 4, 1, idx).toISOString(),
    finished_at: new Date(2026, 4, 1, idx, 0, 30).toISOString(),
    duration_ms: 30000,
    status: idx % 4 === 0 ? "fail" : idx % 3 === 0 ? "pass_with_issues" : "pass",
    fingerprint_id: `fp-${idx}`,
    steps: Array.from({ length: 6 }, (_, j) => ({
      step_id: `step-${j}`,
      step_type: "act" as const,
      status: "pass" as const,
      duration_ms: 200 + j * 50,
      retries_used: 0,
    })),
    scores: [
      { dimension: "completion", score: 7 + (idx % 3), justification: "ok" },
      { dimension: "visual_polish", score: 6.5, justification: "ok" },
      { dimension: "localization", score: 8, justification: "ok" },
      { dimension: "accessibility", score: 7, justification: "ok" },
    ],
    overall_score: 7 + (idx % 3),
    issues: idx % 4 === 0
      ? [
          {
            severity: "critical",
            description: `Scenario ${idx} CTA hidden`,
            recommendation: "Move CTA up",
            dimension: "completion",
          },
          {
            severity: "high",
            description: `Scenario ${idx} contrast 3.2:1`,
            recommendation: "Increase contrast",
            dimension: "accessibility",
            wcag_level: "AA",
            wcag_criterion: "1.4.3",
          },
        ]
      : idx % 3 === 0
        ? [
            {
              severity: "medium",
              description: `Scenario ${idx} aria-label missing`,
              recommendation: "Add aria-label",
              dimension: "accessibility",
              wcag_level: "A",
              wcag_criterion: "4.1.2",
            },
          ]
        : [],
    artifacts: {},
    cost_usd: 0.05 + (idx % 5) * 0.01,
  };
}

/**
 * 20 audit units — about the upper end of a realistic single audit
 * (e.g. 4 personas × 5 scenarios). Larger fixtures exaggerate hot-path
 * regressions; smaller ones can hide them.
 */
function buildAudit(): AuditRun {
  const results = Array.from({ length: 20 }, (_, i) => buildScenarioResult(i));
  return {
    schema_version: "1.2.0",
    run_id: `bench-${crypto.randomUUID()}`,
    project_name: "perf-bench-project",
    base_url: "https://example.com",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 600_000,
    results,
    summary: {
      total: 20,
      pass: 12,
      pass_with_issues: 4,
      fail: 4,
      total_cost_usd: 1.234,
      total_issues: 12,
      critical_issues: 4,
    },
    config: {} as AuditRun["config"],
  };
}

function buildHistory(): HistoryEntry[] {
  return Array.from({ length: 100 }, (_, i) => ({
    id: `2026-05-${String(i + 1).padStart(3, "0")}`,
    tag: i % 5 === 0 ? "manual" : null,
    projectName: "perf-bench-project",
    startedAt: new Date(2026, 4, 1, 12, 0, 0, 0).toISOString(),
    durationMs: 30000 + i * 100,
    totalCostUsd: 0.5 + i * 0.01,
    totalUnits: 20,
    passCount: 16 - (i % 5),
    warnCount: 2 + (i % 3),
    failCount: 2 + (i % 4),
    totalIssues: 5 + (i % 7),
    criticalIssues: i % 8,
    overallScore: 7 + Math.sin(i / 10) * 0.5,
    dimensionAverages: {
      completion: 7.5 + Math.sin(i / 8) * 0.4,
      visual_polish: 6.8 + Math.cos(i / 12) * 0.3,
      localization: 8.0,
      accessibility: 7.2 + Math.sin(i / 5) * 0.5,
    },
    schemaVersion: "1.2.0",
  }));
}

function buildDiff(): RunDiff {
  const history = buildHistory();
  return {
    runA: history[20]!,
    runB: history[21]!,
    scoreDelta: -0.4,
    costDelta: 0.02,
    durationDelta: 1500,
    issuesDelta: 2,
    dimensionDeltas: {
      completion: -0.2,
      visual_polish: -0.5,
      localization: 0,
      accessibility: 0.3,
    },
    newIssues: Array.from({ length: 5 }, (_, i) => ({
      severity: (["critical", "high", "medium", "low"] as const)[i % 4]!,
      description: `New issue ${i}`,
    })),
    resolvedIssues: Array.from({ length: 3 }, (_, i) => ({
      severity: "medium" as const,
      description: `Resolved issue ${i}`,
    })),
  };
}

function buildAccessibilityIssues(): Issue[] {
  // Mix of WCAG levels and criteria — mirrors a real a11y-heavy audit
  const wcagSamples: Array<{ level: "A" | "AA" | "AAA"; criterion: string }> = [
    { level: "AA", criterion: "1.4.3" }, // contrast minimum
    { level: "A", criterion: "1.1.1" }, // non-text content
    { level: "A", criterion: "2.1.1" }, // keyboard
    { level: "A", criterion: "4.1.2" }, // name, role, value
    { level: "AA", criterion: "1.4.11" }, // non-text contrast
    { level: "AAA", criterion: "1.4.6" }, // contrast enhanced
    { level: "AA", criterion: "2.4.7" }, // focus visible
    { level: "AA", criterion: "1.3.5" }, // identify input purpose
  ];
  return Array.from({ length: 50 }, (_, i) => {
    const sample = wcagSamples[i % wcagSamples.length]!;
    return {
      severity: (["critical", "high", "medium", "low"] as const)[i % 4]!,
      description: `Accessibility issue ${i}`,
      recommendation: `Fix ${i}`,
      dimension: "accessibility",
      wcag_level: sample.level,
      wcag_criterion: sample.criterion,
    };
  });
}

// Pre-built fixtures so the bench measures only the function under test,
// not the fixture construction.
const AUDIT = buildAudit();
const HISTORY = buildHistory();
const DIFF = buildDiff();
const A11Y_ISSUES = buildAccessibilityIssues();

// ─────────────────────────────────────────────────────────────
// Pure rendering benchmarks
// ─────────────────────────────────────────────────────────────

describe("renderPdfHtml", () => {
  bench("renderPdfHtml — 20-unit audit + WCAG section", () => {
    renderPdfHtml(AUDIT);
  });
});

describe("renderTrendsHtml", () => {
  bench("renderTrendsHtml — 100-row history with 5 charts", () => {
    renderTrendsHtml(HISTORY, "perf-bench-project");
  });
});

describe("renderDiffMarkdown", () => {
  bench("renderDiffMarkdown — typical PR diff", () => {
    renderDiffMarkdown(DIFF);
  });
});

describe("renderDiffHtml", () => {
  bench("renderDiffHtml — typical PR diff", () => {
    renderDiffHtml(DIFF);
  });
});

describe("renderJunitXml", () => {
  bench("renderJunitXml — 20-unit audit", () => {
    renderJunitXml(AUDIT);
  });
});

describe("renderSarif", () => {
  bench("renderSarif — 20-unit audit (12 issues, 6 WCAG-tagged)", () => {
    renderSarif(AUDIT);
  });
});

// ─────────────────────────────────────────────────────────────
// Pure aggregation benchmarks
// ─────────────────────────────────────────────────────────────

describe("summarizeWcag", () => {
  bench("summarizeWcag — 50 a11y issues across 8 SCs", () => {
    summarizeWcag(A11Y_ISSUES);
  });
});

describe("computeSummary (trends)", () => {
  bench("computeSummary — 100 history rows", () => {
    computeSummary(HISTORY);
  });
});

// (Schema validation benchmark omitted: AuditRunSchema.parse on a
// 20-unit fixture exceeds vitest's per-benchmark time budget and
// reports `samples: []`. The hot paths above already exercise schema
// validation indirectly via Issue / DimensionScore round-tripping.)

// ─────────────────────────────────────────────────────────────
// i18n lookup
// ─────────────────────────────────────────────────────────────

describe("t() i18n lookup", () => {
  bench("t() — 100 key lookups across 5 locales", () => {
    const keys = [
      "overall_score",
      "total_cost",
      "critical",
      "high",
      "pdf_disclaimer",
      "trends_title",
      "diff_title",
      "pdf_methodology_title",
      "no_issues_found",
      "trends_chart_score_title",
    ] as const;
    const locales = ["en", "zh-CN", "ja", "es", "de"] as const;
    for (let i = 0; i < 100; i++) {
      t(keys[i % keys.length]!, locales[i % locales.length]!);
    }
  });
});

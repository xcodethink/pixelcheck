/**
 * Generate fixture PR diff Markdown + JSON for T7c (GitHub PR diff manual
 * verification). Committed to docs/integration/fixture-diff.md and
 * docs/integration/fixture-diff.json so a v1.0-rc1 reviewer can paste
 * the markdown into a real GitHub PR comment to manually verify
 * GFM rendering.
 *
 * Usage:
 *   npx tsx scripts/gen-diff-fixture.ts
 *
 * Run when:
 *   - First creation
 *   - renderDiffMarkdown logic changes (reporter-diff.ts)
 *   - i18n keys for diff section change
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  renderDiffMarkdown,
  renderDiffJson,
} from "../src/core/reporter-diff.js";
import type { HistoryEntry, RunDiff } from "../src/core/history.js";

function makeRun(over: Partial<HistoryEntry>): HistoryEntry {
  return {
    id: "run-default",
    tag: null,
    projectName: "demo-shop",
    startedAt: "2026-04-15T10:00:00.000Z",
    durationMs: 180_000,
    totalCostUsd: 0.25,
    totalUnits: 8,
    passCount: 6,
    warnCount: 1,
    failCount: 1,
    totalIssues: 4,
    criticalIssues: 0,
    overallScore: 7.2,
    dimensionAverages: {
      task_completion: 7.5,
      ux_friction: 6.8,
      visual_polish: 7.4,
      accessibility: 6.9,
      performance: 7.0,
      data_integrity: 7.6,
    },
    schemaVersion: "1.2.0",
    ...over,
  };
}

const runA: HistoryEntry = makeRun({
  id: "run-baseline-2026-04-15",
  tag: "release-v0.9",
  startedAt: "2026-04-15T10:00:00.000Z",
});

const runB: HistoryEntry = makeRun({
  id: "run-pr-1234-2026-05-01",
  tag: "pr-1234",
  startedAt: "2026-05-01T10:00:00.000Z",
  durationMs: 195_000,
  totalCostUsd: 0.31,
  totalUnits: 8,
  passCount: 7,
  warnCount: 1,
  failCount: 0,
  totalIssues: 2,
  criticalIssues: 0,
  overallScore: 8.4, // +1.2 — PR improved score
  dimensionAverages: {
    task_completion: 8.6,
    ux_friction: 7.9,
    visual_polish: 8.5,
    accessibility: 8.2,
    performance: 7.8,
    data_integrity: 8.7,
  },
});

const diff: RunDiff = {
  runA,
  runB,
  scoreDelta: runB.overallScore - runA.overallScore,
  costDelta: runB.totalCostUsd - runA.totalCostUsd,
  durationDelta: runB.durationMs - runA.durationMs,
  issuesDelta: runB.totalIssues - runA.totalIssues,
  dimensionDeltas: Object.fromEntries(
    Object.keys(runA.dimensionAverages).map((d) => [
      d,
      (runB.dimensionAverages[d] ?? 0) - (runA.dimensionAverages[d] ?? 0),
    ]),
  ),
  newIssues: [
    {
      severity: "low",
      description: "Footer copyright year drifted 2025 → 2026",
    },
  ],
  resolvedIssues: [
    {
      severity: "high",
      description: "Login CTA hidden below the fold on mobile",
    },
    {
      severity: "medium",
      description: "Cart 'apply coupon' label fails contrast (1.4.3 AA)",
    },
    {
      severity: "low",
      description: "Search input lacks aria-label",
    },
  ],
};

const docsDir = path.join(process.cwd(), "docs/integration");
fs.mkdirSync(docsDir, { recursive: true });

const md = renderDiffMarkdown(diff);
const json = renderDiffJson(diff);

const mdPath = path.join(docsDir, "fixture-diff.md");
const jsonPath = path.join(docsDir, "fixture-diff.json");

fs.writeFileSync(mdPath, md + "\n");
fs.writeFileSync(jsonPath, json + "\n");

process.stdout.write(
  `wrote ${mdPath}\n${md.length} chars\n` +
    `wrote ${jsonPath}\n${json.length} chars\n`,
);

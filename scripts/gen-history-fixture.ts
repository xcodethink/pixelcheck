/**
 * Generate tests/fixtures/history-100-runs.json — fixture for T7d trends
 * dashboard performance test.
 *
 * 100 deterministic AuditRun history rows over ~3 months. Deterministic
 * because we seed the PRNG with a fixed value; running this script
 * produces the same JSON byte-for-byte every time, so commits to the
 * fixture only happen on intentional change.
 *
 * Usage:
 *   npx tsx scripts/gen-history-fixture.ts
 *
 * Run when:
 *   - First creation
 *   - HistoryEntry / AuditRun shape changes (e.g. M9-2 schema_version added)
 */

import * as fs from "node:fs";
import * as path from "node:path";

// Seeded mulberry32 PRNG — fast, deterministic.
function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = makeRng(20260501);

const DIMENSIONS = [
  "task_completion",
  "ux_friction",
  "visual_polish",
  "accessibility",
  "performance",
  "data_integrity",
];

const PROJECT_NAMES = ["acme-shop", "demo-saas", "blog-cms"];

// Generate 100 runs, ~daily over 100 days ending today.
const ROWS = 100;
const ENDED_AT = new Date("2026-05-01T12:00:00Z").getTime();
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface DimensionAverage {
  dimension: string;
  average: number;
}

interface HistoryEntry {
  id: string;
  tag: string | null;
  project_name: string;
  base_url: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  total_cost_usd: number;
  total_units: number;
  pass_count: number;
  warn_count: number;
  fail_count: number;
  total_issues: number;
  critical_issues: number;
  overall_score: number;
  schema_version: string;
  dimensionAverages: Record<string, number>;
}

const entries: HistoryEntry[] = [];

for (let i = 0; i < ROWS; i++) {
  // Reverse chronological: i=0 is oldest
  const startedAt = new Date(ENDED_AT - (ROWS - 1 - i) * ONE_DAY_MS);
  const durationMs = 60_000 + Math.floor(rng() * 540_000); // 1-10 min
  const finishedAt = new Date(startedAt.getTime() + durationMs);

  // Score trends slightly upward over time (realistic: project improving),
  // with daily noise ±0.5.
  const trendScore = 6.5 + (i / ROWS) * 1.5;
  const overallScore = Math.max(
    0,
    Math.min(10, trendScore + (rng() - 0.5)),
  );

  const totalUnits = 5 + Math.floor(rng() * 8); // 5-12 unit per run
  const failRate = Math.max(0, 0.3 - (i / ROWS) * 0.25 + (rng() - 0.5) * 0.15);
  const failCount = Math.floor(totalUnits * failRate);
  const warnCount = Math.floor(rng() * (totalUnits - failCount) * 0.4);
  const passCount = totalUnits - failCount - warnCount;

  const totalIssues = failCount * 3 + warnCount + Math.floor(rng() * 5);
  const criticalIssues = Math.floor(totalIssues * 0.15);

  const dimAvgs: Record<string, number> = {};
  for (const dim of DIMENSIONS) {
    dimAvgs[dim] = Math.max(
      0,
      Math.min(10, overallScore + (rng() - 0.5) * 2),
    );
  }

  entries.push({
    id: `run-${String(i + 1).padStart(3, "0")}-${Math.floor(rng() * 0xffffff)
      .toString(16)
      .padStart(6, "0")}`,
    tag: i % 7 === 0 ? `release-${Math.floor(i / 7) + 1}` : null,
    project_name: PROJECT_NAMES[i % PROJECT_NAMES.length]!,
    base_url: `https://${PROJECT_NAMES[i % PROJECT_NAMES.length]}.example.com`,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: durationMs,
    total_cost_usd: Number((0.05 + rng() * 0.45).toFixed(4)),
    total_units: totalUnits,
    pass_count: passCount,
    warn_count: warnCount,
    fail_count: failCount,
    total_issues: totalIssues,
    critical_issues: criticalIssues,
    overall_score: Number(overallScore.toFixed(2)),
    schema_version: "1.2.0",
    dimensionAverages: dimAvgs,
  });
}

const outputPath = path.join(
  process.cwd(),
  "tests/fixtures/history-100-runs.json",
);

fs.writeFileSync(outputPath, JSON.stringify(entries, null, 2) + "\n");

const stats = fs.statSync(outputPath);
process.stdout.write(
  `wrote ${outputPath}\n` +
    `${entries.length} entries / ${(stats.size / 1024).toFixed(1)} KB\n`,
);

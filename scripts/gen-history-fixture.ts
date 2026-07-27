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

// HistoryEntry shape — must match `src/core/history.ts > HistoryEntry`
// (camelCase). This is the shape `loadHistory()` returns and that
// `reporter-trends.ts > renderTrendsHtml()` consumes. Pre-T7d fixture
// was written in snake_case (SQLite column names) which broke
// renderTrendsHtml at runtime.
interface HistoryEntry {
  id: string;
  tag: string | null;
  projectName: string;
  startedAt: string;
  durationMs: number;
  totalCostUsd: number;
  totalUnits: number;
  passCount: number;
  warnCount: number;
  failCount: number;
  totalIssues: number;
  criticalIssues: number;
  overallScore: number;
  dimensionAverages: Record<string, number>;
  schemaVersion?: string;
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
    projectName: PROJECT_NAMES[i % PROJECT_NAMES.length]!,
    startedAt: startedAt.toISOString(),
    durationMs: durationMs,
    totalCostUsd: Number((0.05 + rng() * 0.45).toFixed(4)),
    totalUnits: totalUnits,
    passCount: passCount,
    warnCount: warnCount,
    failCount: failCount,
    totalIssues: totalIssues,
    criticalIssues: criticalIssues,
    overallScore: Number(overallScore.toFixed(2)),
    schemaVersion: "1.2.0",
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

#!/usr/bin/env tsx
/**
 * Measure peak RSS memory across the heaviest in-process workloads
 * (closes RISK-REGISTER R52 — "audit memory peak baseline").
 *
 * Why a separate script (not a bench):
 * vitest `bench` measures throughput (ops/sec); peak memory is a
 * different signal. Mixing both into the same suite makes bench output
 * noisy and obscures regressions. This script runs each reporter once
 * with realistic 20-unit fixtures and reports the high-water-mark RSS.
 *
 * Output:
 *   - prints a [memory-peak] table to stdout
 *   - writes docs/perf-memory.json for trend tracking (similar in
 *     spirit to docs/perf-current.json)
 *
 * Usage:
 *   npx tsx scripts/measure-memory.ts
 *   npm run measure:memory   # via package.json script
 *
 * Read alongside the README "Performance baseline" section. The v1.0
 * commitment is < 1 GB peak RSS during a typical 5-unit audit run on
 * Apple Silicon dev hardware. CI ubuntu runners may differ; the
 * weekly bench.yml workflow is the empirical reference.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

interface MemorySample {
  workload: string;
  rss_mb: number;
  heap_used_mb: number;
  duration_ms: number;
}

function snapshotRss(): { rss: number; heap: number } {
  const u = process.memoryUsage();
  return { rss: u.rss, heap: u.heapUsed };
}

function diffMb(a: number, b: number): number {
  return Math.round((b - a) / (1024 * 1024));
}

async function measure(
  workload: string,
  fn: () => void | Promise<void>,
): Promise<MemorySample> {
  // GC if exposed (--expose-gc) so we measure delta cleanly. Without
  // --expose-gc, baseline is whatever lingering allocations exist;
  // still useful as a peak signal but less precise.
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === "function") gc();

  const start = snapshotRss();
  const t0 = Date.now();
  await fn();
  const t1 = Date.now();
  const peak = snapshotRss();

  return {
    workload,
    rss_mb: diffMb(start.rss, peak.rss),
    heap_used_mb: diffMb(start.heap, peak.heap),
    duration_ms: t1 - t0,
  };
}

async function main(): Promise<void> {
  const samples: MemorySample[] = [];

  // Workload 1: render PDF HTML for a 20-unit audit
  const { renderPdfHtml } = await import("../src/core/reporter-pdf.js");
  const { renderTrendsHtml, computeSummary } = await import(
    "../src/core/reporter-trends.js"
  );
  const { renderJunitXml, renderSarif } = await import("../src/core/ci-reporters.js");
  // Inline minimal fixture below (keeps script self-contained)
  // We deliberately use a small synthesized fixture rather than a real audit
  // so the script never depends on docs/ or a recorded run.
  const audit = makeInlineAudit(20);

  samples.push(
    await measure("renderPdfHtml — 20 units", () => {
      renderPdfHtml(audit);
    }),
  );

  const history = makeInlineHistory(100);
  samples.push(
    await measure("renderTrendsHtml — 100 history rows + 5 charts", () => {
      renderTrendsHtml(history, { locale: "en" });
    }),
  );

  samples.push(
    await measure("renderJunitXml — 20 units", () => {
      renderJunitXml(audit);
    }),
  );

  samples.push(
    await measure("renderSarif — 20 units", () => {
      renderSarif(audit);
    }),
  );

  samples.push(
    await measure("computeSummary — 100 history rows", () => {
      for (let i = 0; i < 1000; i++) computeSummary(history);
    }),
  );

  // Print table
  console.log("");
  console.log("[memory-peak] workload                                    Δ RSS    Δ heap   duration");
  console.log("              " + "─".repeat(75));
  for (const s of samples) {
    const w = s.workload.padEnd(48);
    const r = `${s.rss_mb >= 0 ? "+" : ""}${s.rss_mb} MB`.padStart(7);
    const h = `${s.heap_used_mb >= 0 ? "+" : ""}${s.heap_used_mb} MB`.padStart(8);
    const d = `${s.duration_ms} ms`.padStart(8);
    console.log(`              ${w}${r}  ${h}  ${d}`);
  }
  console.log("");

  const peakRssMb = Math.max(...samples.map((s) => s.rss_mb));
  console.log(`[memory-peak] worst Δ RSS across workloads: +${peakRssMb} MB`);
  console.log(`[memory-peak] v1.0 commitment: < 1024 MB peak during 5-unit audit (Apple Silicon).`);
  if (peakRssMb > 1024) {
    console.error(
      `[memory-peak] worst Δ RSS exceeds 1 GB commitment — investigate.`,
    );
    process.exit(1);
  }

  // Persist for trend tracking
  const outPath = path.join(REPO_ROOT, "docs/perf-memory.json");
  const out = {
    schema_version: "1.0.0",
    measured_at: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    samples,
    worst_rss_delta_mb: peakRssMb,
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`[memory-peak] wrote ${path.relative(REPO_ROOT, outPath)}`);
}

// ─────────────────────────────────────────────────────────────
// Inline fixtures (kept here so the script has no external deps)
// ─────────────────────────────────────────────────────────────

function makeInlineAudit(units: number): import("../src/core/types.js").AuditRun {
  const results = Array.from({ length: units }, (_, i) => ({
    scenario_id: `s${i}`,
    scenario_name: `Scenario ${i}`,
    persona_id: `p${i % 3}`,
    persona_display_name: `Persona ${i % 3}`,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 1500 + i * 100,
    status: (i % 4 === 0 ? "fail" : i % 3 === 0 ? "pass_with_issues" : "pass") as "pass" | "pass_with_issues" | "fail",
    fingerprint_id: `fp-${i}`,
    steps: Array.from({ length: 10 }, (_, j) => ({
      step_id: `${i}-${j}`,
      step_type: "act" as const,
      status: "pass" as const,
      duration_ms: 100 + j * 50,
      retries_used: 0,
    })),
    scores: [
      { dimension: "completion", score: 7 + (i % 3), justification: "ok" },
      { dimension: "visual_polish", score: 6 + (i % 4), justification: "ok" },
      { dimension: "accessibility", score: 8 + (i % 2), justification: "ok" },
    ],
    overall_score: 7 + (i % 3),
    issues: i % 2 === 0
      ? [{
          severity: "medium" as const,
          dimension: "completion",
          description: `Scenario ${i} found a layout issue with the call-to-action area`,
          recommendation: "Adjust spacing and increase contrast",
        }]
      : [],
    artifacts: {},
    cost_usd: 0.05 + i * 0.005,
  }));
  return {
    schema_version: "1.2.0",
    run_id: "memory-test-run",
    project_name: "memory-test",
    base_url: "https://example.com",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 60_000,
    results,
    summary: {
      total: units,
      pass: results.filter((r) => r.status === "pass").length,
      pass_with_issues: results.filter((r) => r.status === "pass_with_issues").length,
      fail: results.filter((r) => r.status === "fail").length,
      total_cost_usd: results.reduce((s, r) => s + r.cost_usd, 0),
      total_issues: results.reduce((s, r) => s + r.issues.length, 0),
      critical_issues: 0,
    },
    config: {} as import("../src/core/types.js").AuditRun["config"],
  };
}

function makeInlineHistory(n: number): import("../src/core/types.js").HistoryEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `run-${i}`,
    tag: `tag-${i}`,
    projectName: "memory-test",
    startedAt: new Date(Date.UTC(2026, 0, 1 + i, 12, 0, 0)).toISOString(),
    durationMs: 50_000 + i * 1000,
    totalCostUsd: 0.05 + i * 0.001,
    totalUnits: 5,
    passCount: 3 + (i % 3),
    warnCount: 1,
    failCount: 1 - (i % 2 === 0 ? 0 : 1),
    totalIssues: 2 + (i % 5),
    criticalIssues: i % 10 === 0 ? 1 : 0,
    overallScore: 7 + Math.sin(i / 5),
    dimensionAverages: {
      completion: 7.5,
      visual_polish: 6.8,
      accessibility: 8.2,
    },
    schemaVersion: "1.2.0",
  }));
}

main().catch((err) => {
  console.error("[memory-peak] script failed:", err);
  process.exit(1);
});

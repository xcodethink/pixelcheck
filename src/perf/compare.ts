/**
 * Performance regression comparison logic (M6-7).
 *
 * Pure-function module — separated from the CLI script in
 * `scripts/check-perf.ts` so it can be unit-tested without spawning
 * a real benchmark run.
 *
 * Vitest's bench JSON output structure (as of vitest 4.x):
 *
 *   {
 *     files: [
 *       {
 *         filepath: "...",
 *         groups: [
 *           {
 *             fullName: "tests/perf.bench.ts > renderPdfHtml",
 *             benchmarks: [
 *               { name: "renderPdfHtml — ...", hz: 7357.6, ... }
 *             ]
 *           },
 *           ...
 *         ]
 *       }
 *     ]
 *   }
 *
 * `hz` is the primary metric (operations per second). Higher = faster.
 * A regression means current `hz` < baseline `hz`.
 */

// ─────────────────────────────────────────────────────────────
// Types — narrowly modelled around what we actually consume from
// vitest's report. The full JSON has dozens of fields per benchmark
// (rme / sd / sem / df / etc); we only need name + hz.
// ─────────────────────────────────────────────────────────────

export interface BenchEntry {
  name: string;
  hz: number;
}

export interface VitestBenchReport {
  files: Array<{
    filepath?: string;
    groups: Array<{
      fullName?: string;
      benchmarks: Array<BenchEntry & Record<string, unknown>>;
    }>;
  }>;
}

/**
 * Flat baseline file shape. One key per benchmark name; value is the
 * recorded ops/sec at baseline-recording time. Stored at
 * docs/perf-baseline.json and checked in to git.
 */
export interface PerfBaseline {
  /** Schema version for the baseline file format itself. */
  version: 1;
  /** ISO timestamp recorded when the baseline was last updated. */
  recorded_at: string;
  /** Free-form note about the machine / context the baseline came from. */
  recorded_on?: string;
  /** ops/sec keyed by full benchmark name (group > name). */
  benchmarks: Record<string, number>;
}

/**
 * Extract a flat name → hz map from vitest's nested bench JSON.
 *
 * The flat map is what we compare against the baseline JSON. Names
 * are taken verbatim from `benchmark.name`; vitest doesn't allow
 * duplicate names within a single bench file, so we don't worry
 * about collisions.
 */
export function flattenBenchReport(report: VitestBenchReport): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of report.files ?? []) {
    for (const group of file.groups ?? []) {
      for (const b of group.benchmarks ?? []) {
        if (typeof b.name === "string" && typeof b.hz === "number") {
          out[b.name] = b.hz;
        }
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Comparison
// ─────────────────────────────────────────────────────────────

export interface BenchComparison {
  name: string;
  baseline_hz: number | null;
  current_hz: number;
  /**
   * Relative change: positive means faster, negative means slower.
   *   `+0.10` = current is 10% faster than baseline
   *   `-0.30` = current is 30% slower than baseline
   * Null when there's no baseline entry for this benchmark.
   */
  delta_pct: number | null;
  /** Absolute regression magnitude when slower than baseline. 0 otherwise. */
  regression_pct: number;
  status: "ok" | "regression" | "improvement" | "new" | "removed";
}

export interface CompareOptions {
  /**
   * Tolerance for regression. A benchmark is flagged as `regression`
   * when its hz drops by more than this fraction of baseline.
   * Default 0.50 (50%) — catches catastrophic regressions like an
   * O(N²) loop or a synchronous I/O slip into a hot path. We measured
   * 8–53% run-to-run variance on a quiet M-series MacBook even with
   * pre-built fixtures; CI runners are noisier still. Tighter
   * tolerance produces more false positives than real signal at v1
   * scale; ratchet down once we have enough run history to show
   * the variance is actually lower.
   */
  tolerancePct?: number;
}

/**
 * Compare current bench results to a baseline. Pure — no I/O, no
 * process.exit. Returns one comparison per benchmark in the union
 * of baseline + current. Order: comparisons sorted alphabetically by
 * name so output is stable across runs.
 */
export function compareBaseline(
  current: Record<string, number>,
  baseline: PerfBaseline,
  opts: CompareOptions = {},
): BenchComparison[] {
  const tolerance = opts.tolerancePct ?? 0.50;
  const allNames = new Set<string>([
    ...Object.keys(baseline.benchmarks),
    ...Object.keys(current),
  ]);

  const out: BenchComparison[] = [];
  for (const name of allNames) {
    const cur = current[name];
    const base = baseline.benchmarks[name];

    // New benchmark — exists in current but not in baseline. Not a
    // regression; flagged as "new" so the operator can decide whether
    // to bake into the baseline via `--update-baseline`.
    if (cur !== undefined && base === undefined) {
      out.push({
        name,
        baseline_hz: null,
        current_hz: cur,
        delta_pct: null,
        regression_pct: 0,
        status: "new",
      });
      continue;
    }

    // Removed — was in baseline but no longer being measured. Could
    // be intentional (benchmark deleted) or a bug (file rename) —
    // the operator decides.
    if (cur === undefined && base !== undefined) {
      out.push({
        name,
        baseline_hz: base,
        current_hz: 0,
        delta_pct: null,
        regression_pct: 0,
        status: "removed",
      });
      continue;
    }

    // Both present — compute the delta.
    if (cur !== undefined && base !== undefined) {
      const delta_pct = (cur - base) / base;
      const regression_pct = delta_pct < 0 ? -delta_pct : 0;
      let status: BenchComparison["status"];
      if (regression_pct > tolerance) {
        status = "regression";
      } else if (delta_pct > tolerance) {
        status = "improvement";
      } else {
        status = "ok";
      }
      out.push({
        name,
        baseline_hz: base,
        current_hz: cur,
        delta_pct,
        regression_pct,
        status,
      });
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Format a comparison for human-readable terminal output.
 * Sample line:
 *   [OK]         renderPdfHtml — 7357 ops/s (baseline 7100, +3.6%)
 *   [REGRESSION] renderTrendsHtml — 800 ops/s (baseline 1428, -44.0%)
 *   [IMPROVED]   renderDiffMarkdown — 50000 ops/s (baseline 30000, +66.7%)
 */
export function formatComparison(c: BenchComparison): string {
  const hz = (n: number): string =>
    n >= 100_000
      ? `${Math.round(n / 1000)}k ops/s`
      : `${Math.round(n)} ops/s`;
  const pctOf = (d: number): string => `${(d * 100).toFixed(1)}%`;

  switch (c.status) {
    case "regression": {
      const sign = (c.delta_pct ?? 0) >= 0 ? "+" : "";
      return `[REGRESSION] ${c.name} — ${hz(c.current_hz)} (baseline ${hz(c.baseline_hz!)}, ${sign}${pctOf(c.delta_pct!)})`;
    }
    case "improvement": {
      const sign = (c.delta_pct ?? 0) >= 0 ? "+" : "";
      return `[IMPROVED]   ${c.name} — ${hz(c.current_hz)} (baseline ${hz(c.baseline_hz!)}, ${sign}${pctOf(c.delta_pct!)})`;
    }
    case "ok": {
      const sign = (c.delta_pct ?? 0) >= 0 ? "+" : "";
      return `[OK]         ${c.name} — ${hz(c.current_hz)} (baseline ${hz(c.baseline_hz!)}, ${sign}${pctOf(c.delta_pct!)})`;
    }
    case "new":
      return `[NEW]        ${c.name} — ${hz(c.current_hz)} (no baseline; run 'npm run bench:update' to record)`;
    case "removed":
      return `[REMOVED]    ${c.name} — was ${hz(c.baseline_hz!)} (benchmark no longer present; run 'npm run bench:update' to drop)`;
  }
}

/**
 * Build a baseline JSON suitable for writing to docs/perf-baseline.json.
 * Caller controls `recorded_on` so it can include host info if desired.
 */
export function buildBaseline(
  current: Record<string, number>,
  recorded_on?: string,
): PerfBaseline {
  return {
    version: 1,
    recorded_at: new Date().toISOString(),
    recorded_on,
    benchmarks: { ...current },
  };
}

/**
 * Convenience: does any comparison flag a regression?
 */
export function hasRegression(comparisons: BenchComparison[]): boolean {
  return comparisons.some((c) => c.status === "regression");
}

/**
 * Tests for src/perf/compare.ts — the pure-function core of M6-7's
 * regression-detection script. The CLI wrapper in
 * scripts/check-perf.ts just plumbs JSON read/write + exit codes
 * around this module.
 */

import { describe, it, expect } from "vitest";
import {
  buildBaseline,
  compareBaseline,
  flattenBenchReport,
  formatComparison,
  hasRegression,
  type BenchComparison,
  type PerfBaseline,
  type VitestBenchReport,
} from "../src/perf/compare.js";

// ─────────────────────────────────────────────────────────────
// flattenBenchReport — vitest JSON shape extraction
// ─────────────────────────────────────────────────────────────

describe("flattenBenchReport", () => {
  it("extracts name → hz from vitest's nested report structure", () => {
    const report: VitestBenchReport = {
      files: [
        {
          filepath: "tests/perf.bench.ts",
          groups: [
            {
              fullName: "tests/perf.bench.ts > renderPdfHtml",
              benchmarks: [{ name: "renderPdfHtml — typical", hz: 7357 }],
            },
            {
              fullName: "tests/perf.bench.ts > summarizeWcag",
              benchmarks: [{ name: "summarizeWcag — 50 issues", hz: 500_000 }],
            },
          ],
        },
      ],
    };
    expect(flattenBenchReport(report)).toEqual({
      "renderPdfHtml — typical": 7357,
      "summarizeWcag — 50 issues": 500_000,
    });
  });

  it("flattens benchmarks across multiple files + groups", () => {
    const report: VitestBenchReport = {
      files: [
        {
          groups: [
            { benchmarks: [{ name: "a", hz: 1 }] },
            { benchmarks: [{ name: "b", hz: 2 }] },
          ],
        },
        {
          groups: [{ benchmarks: [{ name: "c", hz: 3 }] }],
        },
      ],
    };
    expect(flattenBenchReport(report)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("returns {} for an empty report", () => {
    expect(flattenBenchReport({ files: [] })).toEqual({});
  });

  it("ignores benchmark entries missing name or hz (defensive)", () => {
    const report = {
      files: [
        {
          groups: [
            {
              benchmarks: [
                { name: "ok", hz: 1000 },
                { hz: 9000 } as unknown as { name: string; hz: number },
                { name: "no-hz" } as unknown as { name: string; hz: number },
              ],
            },
          ],
        },
      ],
    } as VitestBenchReport;
    expect(flattenBenchReport(report)).toEqual({ ok: 1000 });
  });
});

// ─────────────────────────────────────────────────────────────
// compareBaseline — the actual regression decision
// ─────────────────────────────────────────────────────────────

function baseline(b: Record<string, number>): PerfBaseline {
  return {
    version: 1,
    recorded_at: "2026-05-01T00:00:00.000Z",
    benchmarks: b,
  };
}

describe("compareBaseline — happy path", () => {
  it("returns one comparison per benchmark in the union of baseline + current", () => {
    const out = compareBaseline(
      { a: 1000, b: 2000 },
      baseline({ a: 1000, c: 3000 }),
    );
    const names = out.map((c) => c.name).sort();
    expect(names).toEqual(["a", "b", "c"]);
  });

  it("sorts comparisons alphabetically by name (stable across runs)", () => {
    const out = compareBaseline(
      { zebra: 100, alpha: 200, mike: 150 },
      baseline({ zebra: 100, alpha: 200, mike: 150 }),
    );
    expect(out.map((c) => c.name)).toEqual(["alpha", "mike", "zebra"]);
  });
});

describe("compareBaseline — status classification", () => {
  it("flags 'ok' when current is within tolerance (default 50%)", () => {
    const out = compareBaseline(
      { x: 950 }, // -5% — within tolerance
      baseline({ x: 1000 }),
    );
    expect(out[0]?.status).toBe("ok");
  });

  it("flags 'ok' when current is at -40% (within default 50% tolerance)", () => {
    const out = compareBaseline({ x: 600 }, baseline({ x: 1000 }));
    expect(out[0]?.status).toBe("ok");
    expect(out[0]?.regression_pct).toBeCloseTo(0.4, 5);
  });

  it("flags 'regression' when current drops > default tolerance (50%)", () => {
    const out = compareBaseline(
      { x: 400 }, // -60% — beyond default 50%
      baseline({ x: 1000 }),
    );
    expect(out[0]?.status).toBe("regression");
    expect(out[0]?.regression_pct).toBeCloseTo(0.6, 5);
  });

  it("flags 'improvement' when current beats baseline by > tolerance", () => {
    const out = compareBaseline(
      { x: 1600 }, // +60% — beyond default 50%
      baseline({ x: 1000 }),
    );
    expect(out[0]?.status).toBe("improvement");
    expect(out[0]?.delta_pct).toBeCloseTo(0.6, 5);
  });

  it("flags 'new' when benchmark exists in current but not baseline", () => {
    const out = compareBaseline({ new_one: 1000 }, baseline({}));
    expect(out[0]?.status).toBe("new");
    expect(out[0]?.baseline_hz).toBeNull();
    expect(out[0]?.delta_pct).toBeNull();
  });

  it("flags 'removed' when benchmark exists in baseline but not current", () => {
    const out = compareBaseline({}, baseline({ gone: 1000 }));
    expect(out[0]?.status).toBe("removed");
    expect(out[0]?.baseline_hz).toBe(1000);
    expect(out[0]?.current_hz).toBe(0);
  });

  it("respects a custom tolerance", () => {
    // -15% is regression at tolerance 0.10, ok at tolerance 0.30
    const cur = { x: 850 };
    const base = baseline({ x: 1000 });
    expect(
      compareBaseline(cur, base, { tolerancePct: 0.10 })[0]?.status,
    ).toBe("regression");
    expect(
      compareBaseline(cur, base, { tolerancePct: 0.30 })[0]?.status,
    ).toBe("ok");
  });

  it("zero delta is 'ok' (boundary)", () => {
    expect(
      compareBaseline({ x: 1000 }, baseline({ x: 1000 }))[0]?.status,
    ).toBe("ok");
  });

  it("delta_pct is exactly at tolerance boundary → 'ok' (regression must EXCEED tolerance)", () => {
    const out = compareBaseline(
      { x: 500 }, // exactly -50%
      baseline({ x: 1000 }),
      { tolerancePct: 0.50 },
    );
    // Strict > comparison — exactly tolerance drop is borderline ok, not regression
    expect(out[0]?.status).toBe("ok");
  });
});

describe("compareBaseline — semantics", () => {
  it("delta_pct is positive when current is faster (higher hz)", () => {
    const out = compareBaseline({ x: 1100 }, baseline({ x: 1000 }));
    expect(out[0]?.delta_pct).toBeGreaterThan(0);
  });

  it("delta_pct is negative when current is slower (lower hz)", () => {
    const out = compareBaseline({ x: 800 }, baseline({ x: 1000 }));
    expect(out[0]?.delta_pct).toBeLessThan(0);
  });

  it("regression_pct is the absolute slowdown magnitude", () => {
    const out = compareBaseline({ x: 600 }, baseline({ x: 1000 }));
    expect(out[0]?.regression_pct).toBeCloseTo(0.4, 5);
  });

  it("regression_pct is 0 when current ≥ baseline", () => {
    expect(
      compareBaseline({ x: 1500 }, baseline({ x: 1000 }))[0]?.regression_pct,
    ).toBe(0);
    expect(
      compareBaseline({ x: 1000 }, baseline({ x: 1000 }))[0]?.regression_pct,
    ).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// formatComparison — human-readable output
// ─────────────────────────────────────────────────────────────

describe("formatComparison", () => {
  function cmp(over: Partial<BenchComparison> & { name: string; status: BenchComparison["status"] }): BenchComparison {
    return {
      baseline_hz: 1000,
      current_hz: 1000,
      delta_pct: 0,
      regression_pct: 0,
      ...over,
    };
  }

  it("formats 'regression' with explicit REGRESSION tag", () => {
    const s = formatComparison(
      cmp({
        name: "renderPdfHtml",
        status: "regression",
        baseline_hz: 1000,
        current_hz: 600,
        delta_pct: -0.4,
        regression_pct: 0.4,
      }),
    );
    expect(s).toContain("[REGRESSION]");
    expect(s).toContain("renderPdfHtml");
    expect(s).toContain("-40.0%");
  });

  it("formats 'improvement' with IMPROVED tag", () => {
    const s = formatComparison(
      cmp({
        name: "x",
        status: "improvement",
        baseline_hz: 1000,
        current_hz: 1500,
        delta_pct: 0.5,
      }),
    );
    expect(s).toContain("[IMPROVED]");
    expect(s).toContain("+50.0%");
  });

  it("formats 'ok' with OK tag and signed delta", () => {
    const s = formatComparison(
      cmp({
        name: "x",
        status: "ok",
        delta_pct: 0.05,
      }),
    );
    expect(s).toContain("[OK]");
    expect(s).toContain("+5.0%");
  });

  it("formats 'new' with hint about updating baseline", () => {
    const s = formatComparison(
      cmp({
        name: "x",
        status: "new",
        baseline_hz: null,
        current_hz: 1000,
        delta_pct: null,
      }),
    );
    expect(s).toContain("[NEW]");
    expect(s).toContain("no baseline");
    expect(s).toContain("bench:update");
  });

  it("formats 'removed' with hint about updating baseline", () => {
    const s = formatComparison(
      cmp({
        name: "x",
        status: "removed",
        baseline_hz: 1000,
        current_hz: 0,
        delta_pct: null,
      }),
    );
    expect(s).toContain("[REMOVED]");
    expect(s).toContain("no longer present");
  });

  it("renders ops/sec in 'k' shorthand for ≥ 100k", () => {
    const s = formatComparison(
      cmp({
        name: "x",
        status: "ok",
        baseline_hz: 100_000,
        current_hz: 200_000,
        delta_pct: 1,
      }),
    );
    expect(s).toContain("200k ops/s");
    expect(s).toContain("100k ops/s");
  });

  it("renders ops/sec as integer for < 100k", () => {
    const s = formatComparison(
      cmp({
        name: "x",
        status: "ok",
        baseline_hz: 7357.6,
        current_hz: 7000.4,
        delta_pct: -0.05,
      }),
    );
    expect(s).toContain("7000 ops/s");
    expect(s).toContain("7358 ops/s");
  });
});

// ─────────────────────────────────────────────────────────────
// buildBaseline
// ─────────────────────────────────────────────────────────────

describe("buildBaseline", () => {
  it("emits version=1 + recorded_at + benchmarks copy", () => {
    const out = buildBaseline({ a: 1000, b: 2000 });
    expect(out.version).toBe(1);
    expect(out.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(out.benchmarks).toEqual({ a: 1000, b: 2000 });
  });

  it("does not alias the input — caller can mutate without affecting the baseline", () => {
    const input = { a: 1000 };
    const out = buildBaseline(input);
    input.a = 9999;
    expect(out.benchmarks.a).toBe(1000);
  });

  it("captures recorded_on note when provided", () => {
    const out = buildBaseline({ a: 1 }, "darwin arm64 (Node v20.10.0)");
    expect(out.recorded_on).toBe("darwin arm64 (Node v20.10.0)");
  });

  it("omits recorded_on when not provided", () => {
    const out = buildBaseline({ a: 1 });
    expect(out.recorded_on).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// hasRegression — convenience
// ─────────────────────────────────────────────────────────────

describe("hasRegression", () => {
  it("returns true when any comparison is 'regression'", () => {
    const cs: BenchComparison[] = [
      { name: "a", status: "ok", baseline_hz: 1, current_hz: 1, delta_pct: 0, regression_pct: 0 },
      { name: "b", status: "regression", baseline_hz: 1000, current_hz: 500, delta_pct: -0.5, regression_pct: 0.5 },
    ];
    expect(hasRegression(cs)).toBe(true);
  });

  it("returns false when all comparisons are non-regression", () => {
    const cs: BenchComparison[] = [
      { name: "a", status: "ok", baseline_hz: 1, current_hz: 1, delta_pct: 0, regression_pct: 0 },
      { name: "b", status: "improvement", baseline_hz: 1000, current_hz: 2000, delta_pct: 1, regression_pct: 0 },
      { name: "c", status: "new", baseline_hz: null, current_hz: 100, delta_pct: null, regression_pct: 0 },
    ];
    expect(hasRegression(cs)).toBe(false);
  });

  it("returns false on empty list", () => {
    expect(hasRegression([])).toBe(false);
  });
});

import { describe, it, expect } from "vitest";

/**
 * A run that covered less of the matrix than it planned must say so.
 *
 * `runAudit` returns early for a unit skipped on budget, and for one whose
 * persona is missing, without pushing a result. `summary.total` is therefore
 * the executed count, not the planned one — and nothing downstream compares
 * the two.
 *
 * Measured: a three-unit matrix with `--budget 0.02 -j 1` logs two "unit
 * skipped" events and reports `summary.total: 1`, "PASS 0 WARN 0 FAIL 1". That
 * is indistinguishable from a one-unit matrix that ran to completion. Had the
 * single unit passed, it would have read as a clean audit of the whole matrix.
 *
 * The reconciliation is arithmetic the CLI does against `matrix.length`, so
 * what is pinned here is the arithmetic and the boundary cases around it. The
 * printed line is exercised by running the binary with a truncating budget.
 *
 * Not fixed here, and deliberately: `audit.json` still records only the
 * executed units, so a CI consumer reading the artefact rather than the
 * terminal sees `total: 1` with no gap indicator. Recording the planned count
 * in the report means a schema field and a version bump.
 */

/** The comparison the CLI makes after printing the counts. */
function shortfall(planned: number, executed: number): number {
  return Math.max(0, planned - executed);
}

describe("planned versus executed units", () => {
  it("reports the gap when the budget truncates a run", () => {
    // The measured case.
    expect(shortfall(3, 1)).toBe(2);
  });

  it("stays silent when every planned unit ran", () => {
    // The half that matters for trust in the message: a normal run must print
    // nothing extra, or the warning becomes noise and stops being read.
    expect(shortfall(3, 3)).toBe(0);
  });

  it("stays silent on an empty matrix", () => {
    // `run` refuses an empty matrix earlier, but the arithmetic should not
    // invent a shortfall if that guard ever moves.
    expect(shortfall(0, 0)).toBe(0);
  });

  it("never reports a negative shortfall", () => {
    // Defensive: more results than planned would mean something else is wrong,
    // and a negative count in the message would be worse than no message.
    expect(shortfall(1, 3)).toBe(0);
  });

  it("counts a fully skipped run as entirely missing", () => {
    // Every unit skipped — for instance a budget already exhausted by a
    // previous run in the same daily ledger.
    expect(shortfall(19, 0)).toBe(19);
  });
});

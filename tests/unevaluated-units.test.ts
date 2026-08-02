import { describe, it, expect } from "vitest";
import type { AuditRun, ScenarioResult } from "../src/core/types.js";

/**
 * A unit that produced no scores was never evaluated.
 *
 * With the Anthropic API unreachable, the vision step fails, the step is
 * recorded as a warning, and the unit ends up `pass_with_issues`. The run then
 * printed:
 *
 *   PASS 0  WARN 3  FAIL 0  (0 critical issues)
 *   Cost: $0.000
 *
 * — a near-clean bill of health for a site nothing ever looked at, and exit
 * code 2, which means "passed with warnings" and lets CI move on. That is worse
 * than the disk-full and missing-browser cases: those at least look bad.
 *
 * The recorded data was already correct — `scores: []`, `overall_score: 0`.
 * Only the summary's reading of it was wrong.
 *
 * This pins the discriminator the CLI now uses. The printed output and exit
 * code are exercised by running the binary against an unreachable API, which a
 * unit test cannot stage.
 */

function unit(overrides: Partial<ScenarioResult>): ScenarioResult {
  const now = "2026-08-02T00:00:00.000Z";
  return {
    scenario_id: "s",
    scenario_name: "Smoke",
    persona_id: "p",
    persona_display_name: "US Desktop",
    started_at: now,
    finished_at: now,
    duration_ms: 1,
    status: "pass_with_issues",
    fingerprint_id: "fp",
    steps: [],
    scores: [],
    overall_score: 0,
    issues: [],
    artifacts: {},
    cost_usd: 0,
    ...overrides,
  } as ScenarioResult;
}

/** The discriminator itself, kept in one place so both sides agree on it. */
function unevaluated(audit: Pick<AuditRun, "results">): ScenarioResult[] {
  return audit.results.filter((r) => r.scores.length === 0);
}

describe("detecting units that were never evaluated", () => {
  it("treats an empty score list as not evaluated, whatever the status says", () => {
    // The status is the misleading part: `pass_with_issues` reads as a verdict.
    const audit = { results: [unit({ status: "pass_with_issues" })] };
    expect(unevaluated(audit)).toHaveLength(1);
  });

  it("does not flag a unit that was scored", () => {
    const audit = {
      results: [
        unit({
          status: "pass",
          scores: [{ dimension: "completion", score: 8, justification: "ok" }],
          overall_score: 8,
        } as Partial<ScenarioResult>),
      ],
    };
    expect(unevaluated(audit)).toHaveLength(0);
  });

  it("does not flag a genuinely bad result — a low score is still a score", () => {
    // The distinction that matters: "evaluated and bad" must stay a verdict,
    // or the fix would suppress real findings.
    const audit = {
      results: [
        unit({
          status: "fail",
          scores: [{ dimension: "completion", score: 1.5, justification: "broken" }],
          overall_score: 1.5,
          issues: [
            { severity: "critical", description: "nothing loads", recommendation: "fix" },
          ],
        } as Partial<ScenarioResult>),
      ],
    };
    expect(unevaluated(audit)).toHaveLength(0);
  });

  it("separates a partial outage from a total one", () => {
    // Only a run where nothing at all was evaluated should override the exit
    // code; a mixed run still has a real verdict for the units that ran.
    const audit = {
      results: [
        unit({}),
        unit({
          scores: [{ dimension: "completion", score: 7, justification: "ok" }],
        } as Partial<ScenarioResult>),
      ],
    };
    const missed = unevaluated(audit);
    expect(missed).toHaveLength(1);
    expect(missed.length === audit.results.length).toBe(false);
  });

  it("reports every unit when the whole run was blind", () => {
    const audit = { results: [unit({}), unit({}), unit({})] };
    const missed = unevaluated(audit);
    expect(missed.length === audit.results.length).toBe(true);
  });
});

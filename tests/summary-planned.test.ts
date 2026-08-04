import { describe, it, expect } from "vitest";
import { AuditRunSchema, RESULT_SCHEMA_VERSION } from "../src/core/result-schema.js";

/**
 * The report says how many units the matrix asked for, not only how many
 * answered.
 *
 * A unit skipped on budget, or dropped because its persona was missing,
 * returns from the runner without pushing a result, so `summary.total` is the
 * executed count. A three-unit matrix truncated after the first records
 * `total: 1`, which is indistinguishable from a one-unit matrix that ran to
 * completion — and if that unit passed, from a clean audit of all three.
 *
 * The CLI has printed the shortfall since it could compute it from the matrix
 * it holds in memory. Nothing in the artefact carried it, so a CI job reading
 * audit.json rather than watching the terminal could not see it at all. That
 * was recorded as deferred on the grounds that it needed a schema field; this
 * is the schema field.
 *
 * `planned` is optional in the schema and required in the TypeScript type,
 * deliberately. The runner must always write it — TypeScript caught two
 * script call-sites that would otherwise have omitted it — while a report
 * written before schema 1.4.0 has to keep parsing. Absent means unknown, not
 * zero.
 */

const NOW = "2026-08-04T00:00:00.000Z";

function auditWith(summary: Record<string, number>): unknown {
  return {
    schema_version: RESULT_SCHEMA_VERSION,
    run_id: "r",
    project_name: "p",
    base_url: "https://example.test",
    started_at: NOW,
    finished_at: NOW,
    duration_ms: 1,
    results: [],
    summary: {
      total: 0,
      pass: 0,
      pass_with_issues: 0,
      fail: 0,
      total_cost_usd: 0,
      total_issues: 0,
      critical_issues: 0,
      ...summary,
    },
    config: {
      project_name: "p",
      base_url: "https://example.test",
      personas: [],
      scenarios_dir: "./scenarios",
      output_dir: "./reports",
      redact_patterns: [],
    },
  };
}

describe("summary.planned in the schema", () => {
  it("accepts a report that carries it", () => {
    const parsed = AuditRunSchema.safeParse(auditWith({ planned: 3, total: 1 }));
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.[0])).toBe(true);
  });

  it("accepts a report written before the field existed", () => {
    // Every audit.json produced up to and including v2.0.0. A required field
    // would make all of them fail to parse, which is a worse outcome than the
    // gap it closes.
    const parsed = AuditRunSchema.safeParse(auditWith({ total: 1 }));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.summary.planned).toBeUndefined();
    }
  });

  it("rejects a negative or fractional count", () => {
    expect(AuditRunSchema.safeParse(auditWith({ planned: -1 })).success).toBe(false);
    expect(AuditRunSchema.safeParse(auditWith({ planned: 1.5 })).success).toBe(false);
  });

  it("was published under a new schema version", () => {
    // Additive, so a minor. A consumer pinned to 1.3.x still parses these
    // reports; one that wants the field can require >=1.4.0.
    expect(RESULT_SCHEMA_VERSION).toBe("1.4.0");
  });
});

describe("reading the shortfall from the artefact alone", () => {
  /** What a CI consumer would compute, with no access to the terminal. */
  function shortfall(summary: { planned?: number; total: number }): number | null {
    if (summary.planned === undefined) return null;
    return Math.max(0, summary.planned - summary.total);
  }

  it("reports the gap for a truncated run", () => {
    // The measured case: matrix of 3, --budget 0.02, -j 1.
    expect(shortfall({ planned: 3, total: 1 })).toBe(2);
  });

  it("reports zero for a complete run", () => {
    expect(shortfall({ planned: 3, total: 3 })).toBe(0);
  });

  it("distinguishes a complete one-unit run from a truncated three-unit one", () => {
    // The whole point. Both record `total: 1`.
    expect(shortfall({ planned: 1, total: 1 })).toBe(0);
    expect(shortfall({ planned: 3, total: 1 })).toBe(2);
  });

  it("says unknown rather than zero for a pre-1.4.0 report", () => {
    // Returning 0 would tell a consumer the run was complete, which is
    // precisely the claim the old reports cannot support.
    expect(shortfall({ total: 1 })).toBeNull();
  });

  it("never reports a negative gap", () => {
    expect(shortfall({ planned: 1, total: 3 })).toBe(0);
  });
});

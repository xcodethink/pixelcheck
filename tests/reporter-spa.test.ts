/**
 * Tests for the SPA report writer — verifies the output is a self-contained
 * HTML file embedding the audit JSON safely.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeSpaReport } from "../src/core/reporter-spa.js";
import type { AuditRun } from "../src/core/types.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spa-rep-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function mkAudit(overrides: Partial<AuditRun> = {}): AuditRun {
  return {
    run_id: "run-x",
    project_name: "demo-project",
    base_url: "https://demo.example",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 1000,
    results: [
      {
        scenario_id: "s1",
        scenario_name: "Signup",
        persona_id: "p1",
        persona_display_name: "US Desktop",
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: 500,
        status: "pass",
        fingerprint_id: "fp-1",
        steps: [
          { step_id: "s1-visit", step_type: "visit", status: "pass", duration_ms: 200, retries_used: 0 },
          { step_id: "s1-act", step_type: "act", status: "pass", duration_ms: 300, retries_used: 0, execution_method: "stagehand" },
        ],
        scores: [
          { dimension: "completion", score: 9.0, justification: "ok" },
          { dimension: "visual_polish", score: 7.5, justification: "meh" },
        ],
        overall_score: 8.3,
        issues: [
          { severity: "medium", description: "Button alignment off", recommendation: "fix CSS" },
        ],
        artifacts: {},
        cost_usd: 0.02,
      },
    ],
    summary: {
      total: 1,
      pass: 1,
      pass_with_issues: 0,
      fail: 0,
      total_cost_usd: 0.02,
      total_issues: 1,
      critical_issues: 0,
    },
    config: {} as AuditRun["config"],
    ...overrides,
  };
}

describe("writeSpaReport", () => {
  it("writes audit-explorer.html to the runDir", () => {
    const p = writeSpaReport(mkAudit(), tmp);
    expect(p).toBe(path.join(tmp, "audit-explorer.html"));
    expect(fs.existsSync(p)).toBe(true);
  });

  it("embeds the audit JSON in a <script type=application/json> tag", () => {
    const p = writeSpaReport(mkAudit(), tmp);
    const html = fs.readFileSync(p, "utf8");
    expect(html).toContain('type="application/json"');
    expect(html).toContain('id="__AUDIT_DATA__"');
    expect(html).toContain("demo-project");
  });

  it("escapes angle brackets inside embedded JSON to prevent XSS", () => {
    const audit = mkAudit();
    audit.results[0]!.issues.push({
      severity: "low",
      description: "<script>alert('x')</script>",
      recommendation: "sanitize",
    });
    const p = writeSpaReport(audit, tmp);
    const html = fs.readFileSync(p, "utf8");
    // Raw injection must not appear verbatim
    expect(html).not.toMatch(/<script>alert\('x'\)<\/script>/);
    // But it should be present in escaped form (\u003C = <)
    expect(html).toContain("\\u003Cscript\\u003E");
  });

  it("renders all results from audit.results", () => {
    const audit = mkAudit();
    audit.results.push({
      ...audit.results[0]!,
      scenario_id: "s2",
      scenario_name: "Checkout",
      persona_display_name: "JP Mobile",
      status: "fail",
      overall_score: 3.2,
    });
    audit.summary.total = 2;
    audit.summary.fail = 1;
    const p = writeSpaReport(audit, tmp);
    const html = fs.readFileSync(p, "utf8");
    expect(html).toContain("Checkout");
    expect(html).toContain("JP Mobile");
  });

  it("respects redaction patterns (literal substring match)", () => {
    // redact() uses substring replace, not regex
    const audit = mkAudit({
      redact_patterns: ["secret-token-abcdef123"],
    });
    audit.results[0]!.issues.push({
      severity: "low",
      description: "saw secret-token-abcdef123 in page",
      recommendation: "hide it",
    });
    const p = writeSpaReport(audit, tmp);
    const html = fs.readFileSync(p, "utf8");
    expect(html).not.toContain("secret-token-abcdef123");
    expect(html).toContain("[REDACTED]");
  });
});

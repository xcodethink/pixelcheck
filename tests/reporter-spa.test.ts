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

  it("associates each filter label with its control via for= (H6 a11y)", () => {
    const html = fs.readFileSync(writeSpaReport(mkAudit(), tmp), "utf8");
    for (const id of ["fPersona", "fScenario", "fStatus", "fDimMax", "fSeverity"]) {
      expect(html).toContain(`for="${id}"`);
    }
  });

  it("uses the AA-contrast fail-badge background, not the 3.86:1 one (H6)", () => {
    const html = fs.readFileSync(writeSpaReport(mkAudit(), tmp), "utf8");
    expect(html).toContain(".status-fail { background: #3a1000;");
    expect(html).not.toContain("#5a1e02");
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

  it("does not run redaction when redact_patterns is empty (skips deep walk)", () => {
    // patterns.length === 0 → fast path returns audit unchanged
    const audit = mkAudit({ redact_patterns: [] });
    audit.results[0]!.issues[0]!.description = "secret-not-redacted";
    const p = writeSpaReport(audit, tmp);
    const html = fs.readFileSync(p, "utf8");
    expect(html).toContain("secret-not-redacted");
  });

  it("does not run redaction when redact_patterns is undefined", () => {
    const audit = mkAudit();
    delete (audit as { redact_patterns?: unknown }).redact_patterns;
    audit.results[0]!.issues[0]!.description = "another-untouched-secret";
    const p = writeSpaReport(audit, tmp);
    const html = fs.readFileSync(p, "utf8");
    expect(html).toContain("another-untouched-secret");
  });
});

describe("writeSpaReport — escapeHtml on header metadata", () => {
  // escapeHtml only runs on audit.project_name and audit.run_id (the two
  // <title> + header text interpolations outside the <script type=json>
  // block). The JSON itself is escaped via < / >. This block
  // covers each switch case explicitly so all four characters' branches
  // are exercised.
  it("escapes & in the project_name", () => {
    const audit = mkAudit({ project_name: "Marketing & Sales" });
    const html = fs.readFileSync(writeSpaReport(audit, tmp), "utf8");
    expect(html).toContain("Marketing &amp; Sales");
    expect(html).not.toContain("Marketing & Sales</title>");
  });

  it("escapes < in the project_name (defense against title injection)", () => {
    const audit = mkAudit({ project_name: "Less<Than" });
    const html = fs.readFileSync(writeSpaReport(audit, tmp), "utf8");
    expect(html).toContain("Less&lt;Than");
  });

  it("escapes > in the run_id", () => {
    const audit = mkAudit({ run_id: "run>2026" });
    const html = fs.readFileSync(writeSpaReport(audit, tmp), "utf8");
    expect(html).toContain("run&gt;2026");
  });

  it('escapes " in the project_name', () => {
    const audit = mkAudit({ project_name: 'Quote"Test' });
    const html = fs.readFileSync(writeSpaReport(audit, tmp), "utf8");
    expect(html).toContain("Quote&quot;Test");
  });

  it("leaves plain ASCII unchanged in the title", () => {
    const audit = mkAudit({ project_name: "Plain ASCII", run_id: "abc-123" });
    const html = fs.readFileSync(writeSpaReport(audit, tmp), "utf8");
    expect(html).toContain("Plain ASCII");
    expect(html).toContain("abc-123");
  });

  it("escapes a mix of all four special chars in one string", () => {
    const audit = mkAudit({
      project_name: 'A&B<C>D"E',
      run_id: '<run>',
    });
    const html = fs.readFileSync(writeSpaReport(audit, tmp), "utf8");
    // Title + header pick up project_name; run_id is escaped too
    expect(html).toContain("A&amp;B&lt;C&gt;D&quot;E");
    expect(html).toContain("&lt;run&gt;");
    // No raw injection survives
    expect(html).not.toContain('A&B<C>D"E');
  });
});

describe("SPA i18n integration (T18 — closes R65 partial)", () => {
  it("inlines the 5-locale i18n dictionary as a JSON script tag", () => {
    const html = fs.readFileSync(writeSpaReport(mkAudit(), tmp), "utf8");
    expect(html).toContain('id="__AUDIT_I18N__"');
    expect(html).toContain('"audit_explorer_title"');
    // All 5 locales should be present in the embedded JSON
    expect(html).toContain('"en":');
    expect(html).toContain('"zh-CN":');
    expect(html).toContain('"ja":');
    expect(html).toContain('"es":');
    expect(html).toContain('"de":');
  });

  it("declares the html lang attribute as the default locale", () => {
    const html = fs.readFileSync(writeSpaReport(mkAudit(), tmp), "utf8");
    expect(html).toMatch(/<html\s+lang="en"\s+data-default-lang="en"/);
  });

  it("annotates every static UI label with data-i18n attributes", () => {
    const html = fs.readFileSync(writeSpaReport(mkAudit(), tmp), "utf8");
    const expectedKeys = [
      "audit_explorer_title",
      "btn_collapse",
      "btn_expand_all",
      "filter_persona",
      "filter_scenario",
      "filter_status",
      "filter_dim_max",
      "filter_issue",
      "filter_all",
      "filter_any",
    ];
    for (const k of expectedKeys) {
      expect(html).toContain(`data-i18n="${k}"`);
    }
  });

  it("ships translations for the 27 SPA keys in zh-CN / ja / es / de", () => {
    const html = fs.readFileSync(writeSpaReport(mkAudit(), tmp), "utf8");
    // A few high-confidence native phrases that must appear in the
    // inlined JSON (sanity check that translations didn't get truncated).
    expect(html).toContain("审计浏览器"); // zh-CN audit_explorer_title
    expect(html).toContain("監査エクスプローラー"); // ja
    expect(html).toContain("Explorador de auditoría"); // es
    expect(html).toContain("Audit-Explorer"); // de
  });

  it("references the URLSearchParams + navigator.language fallback in JS", () => {
    const html = fs.readFileSync(writeSpaReport(mkAudit(), tmp), "utf8");
    expect(html).toContain("URLSearchParams");
    expect(html).toContain("navigator.language");
    expect(html).toContain("DEFAULT_LOCALE");
  });
});

/**
 * Tests for src/core/reporter.ts (T12 — closes R11 partial).
 *
 * The 528-LoC reporter exposes 3 entry points (writeJsonReport /
 * writeMarkdownSummary / writeHtmlReport) and a thicket of internal
 * render helpers (renderUnit / renderAgentSummary / renderTrendSection /
 * renderReliabilityStats / escapeHtml). These tests cover:
 *
 *   - All 3 public exports for shape + side effects
 *   - Redaction applied vs skipped fast path
 *   - Trend section gating on history.length >= 2
 *   - SVG sparkline composition (gridlines / dots / polyline / fill)
 *   - Reliability stats card per HistoryEntry
 *   - Agent summary 4 convergence_reason styles + criteria_met/missed
 *   - HTML escaping of project_name / scenario_name / persona / issue
 *     description / step_id / step error / agent criteria strings
 *   - Markdown summary structure, score / dimension / issue rows
 *   - Steps with retries_used / execution_method / error variants
 *
 * Coverage target: ≥ 80% stmt for src/core/reporter.ts. See vitest.config.ts
 * for the global ratchet contract (ADR-017).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  writeJsonReport,
  writeMarkdownSummary,
  writeHtmlReport,
} from "../src/core/reporter.js";
import type { AuditRun, ScenarioRunResult } from "../src/core/types.js";
import {
  saveAuditToHistory,
  type HistoryEntry,
} from "../src/core/history.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reporter-test-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function makeUnit(overrides: Partial<ScenarioRunResult> = {}): ScenarioRunResult {
  return {
    scenario_id: "s1",
    scenario_name: "Login flow",
    persona_id: "p1",
    persona_display_name: "US Desktop",
    started_at: "2026-05-02T12:00:00Z",
    finished_at: "2026-05-02T12:00:01Z",
    duration_ms: 1500,
    status: "pass",
    fingerprint_id: "fp-1",
    steps: [
      {
        step_id: "s1-visit",
        step_type: "visit",
        status: "pass",
        duration_ms: 200,
        retries_used: 0,
      },
    ],
    scores: [
      { dimension: "completion", score: 9.0, justification: "ok" },
    ],
    overall_score: 9.0,
    issues: [],
    artifacts: {},
    cost_usd: 0.05,
    ...overrides,
  };
}

function mkAudit(overrides: Partial<AuditRun> = {}): AuditRun {
  return {
    run_id: "run-x",
    project_name: "demo-project",
    base_url: "https://demo.example",
    started_at: "2026-05-02T12:00:00Z",
    finished_at: "2026-05-02T12:00:05Z",
    duration_ms: 5000,
    results: [makeUnit()],
    summary: {
      total: 1,
      pass: 1,
      pass_with_issues: 0,
      fail: 0,
      total_cost_usd: 0.05,
      total_issues: 0,
      critical_issues: 0,
    },
    config: {} as AuditRun["config"],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// writeJsonReport
// ─────────────────────────────────────────────────────────────

describe("writeJsonReport", () => {
  it("writes audit.json to runDir and returns the path", () => {
    const p = writeJsonReport(mkAudit(), tmp);
    expect(p).toBe(path.join(tmp, "audit.json"));
    expect(fs.existsSync(p)).toBe(true);
  });

  it("emits valid JSON that parses back to the same shape", () => {
    const audit = mkAudit();
    const p = writeJsonReport(audit, tmp);
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(parsed.project_name).toBe("demo-project");
    expect(parsed.run_id).toBe("run-x");
    expect(parsed.results).toHaveLength(1);
  });

  it("redacts string values when redact_patterns is non-empty", () => {
    const audit = mkAudit({ redact_patterns: ["sk-secret-abc123"] });
    audit.results[0]!.issues.push({
      severity: "low",
      description: "saw sk-secret-abc123 in DOM",
      recommendation: "hide it",
    });
    const html = fs.readFileSync(writeJsonReport(audit, tmp), "utf8");
    expect(html).not.toContain("sk-secret-abc123");
    expect(html).toContain("[REDACTED]");
  });

  it("skips redaction (fast path) when redact_patterns is empty", () => {
    const audit = mkAudit({ redact_patterns: [] });
    audit.results[0]!.issues.push({
      severity: "low",
      description: "secret-not-redacted",
      recommendation: "ignored",
    });
    const html = fs.readFileSync(writeJsonReport(audit, tmp), "utf8");
    expect(html).toContain("secret-not-redacted");
  });

  it("always redacts known env secrets even with empty redact_patterns (Audit 2026-06-02 C2)", () => {
    const prev = process.env.SCAMLENS_ADMIN_COOKIE;
    process.env.SCAMLENS_ADMIN_COOKIE = "session-token=supersecretvalue123";
    try {
      const audit = mkAudit({ redact_patterns: [] });
      audit.results[0]!.issues.push({
        severity: "low",
        description: "leaked session-token=supersecretvalue123 into a finding",
        recommendation: "n/a",
      });
      const json = fs.readFileSync(writeJsonReport(audit, tmp), "utf8");
      expect(json).not.toContain("supersecretvalue123");
      expect(json).toContain("[REDACTED]");
    } finally {
      if (prev === undefined) delete process.env.SCAMLENS_ADMIN_COOKIE;
      else process.env.SCAMLENS_ADMIN_COOKIE = prev;
    }
  });

  it("skips redaction when redact_patterns is undefined", () => {
    const audit = mkAudit();
    delete (audit as Partial<AuditRun>).redact_patterns;
    const p = writeJsonReport(audit, tmp);
    expect(fs.existsSync(p)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// writeMarkdownSummary
// ─────────────────────────────────────────────────────────────

describe("writeMarkdownSummary", () => {
  it("writes summary.md to runDir and returns the path", () => {
    const p = writeMarkdownSummary(mkAudit(), tmp);
    expect(p).toBe(path.join(tmp, "summary.md"));
    expect(fs.existsSync(p)).toBe(true);
  });

  it("renders run metadata in the header", () => {
    const md = fs.readFileSync(writeMarkdownSummary(mkAudit(), tmp), "utf8");
    expect(md).toContain("# Audit Run: run-x");
    expect(md).toContain("- Project: demo-project");
    expect(md).toContain("- Base URL: https://demo.example");
    expect(md).toMatch(/Total cost: \$0\.050/);
    expect(md).toMatch(/Duration: 5\.0s/);
  });

  it("renders the summary metrics table with all 6 rows", () => {
    const md = fs.readFileSync(writeMarkdownSummary(mkAudit(), tmp), "utf8");
    expect(md).toContain("| Total | 1 |");
    expect(md).toContain("| Pass | 1 |");
    expect(md).toContain("| Pass with issues | 0 |");
    expect(md).toContain("| Fail | 0 |");
    expect(md).toContain("| Total issues | 0 |");
    expect(md).toContain("| Critical issues | 0 |");
  });

  it("renders per-result section with score / cost / duration", () => {
    const audit = mkAudit();
    audit.results[0] = makeUnit({
      scenario_name: "Checkout",
      persona_display_name: "JP Mobile",
      status: "pass_with_issues",
      overall_score: 7.4,
      cost_usd: 0.123,
      duration_ms: 2300,
    });
    const md = fs.readFileSync(writeMarkdownSummary(audit, tmp), "utf8");
    expect(md).toContain("### [PASS_WITH_ISSUES] Checkout — JP Mobile");
    expect(md).toContain("Score: **7.4 / 10**");
    expect(md).toContain("Cost: $0.123");
    expect(md).toContain("Duration: 2.3s");
  });

  it("emits a per-dimension score table when scores are present", () => {
    const audit = mkAudit();
    audit.results[0]!.scores = [
      { dimension: "completion", score: 9.0, justification: "" },
      { dimension: "visual_polish", score: 7.5, justification: "" },
    ];
    const md = fs.readFileSync(writeMarkdownSummary(audit, tmp), "utf8");
    expect(md).toContain("| Dimension | Score |");
    expect(md).toContain("| completion | 9.0 |");
    expect(md).toContain("| visual_polish | 7.5 |");
  });

  it("escapes pipes / backticks / newlines so audit-derived text can't corrupt tables (H9)", () => {
    const audit = mkAudit();
    audit.results[0] = makeUnit({
      scenario_name: "Check|out",
      scores: [{ dimension: "a|b", score: 5, justification: "" }],
      issues: [
        {
          severity: "high",
          description: "broke on `code` and a | pipe\nsecond line",
          recommendation: "fix | it",
        },
      ],
    });
    const md = fs.readFileSync(writeMarkdownSummary(audit, tmp), "utf8");
    // The dimension cell pipe is escaped, keeping the table 2-column.
    expect(md).toContain("| a\\|b | 5.0 |");
    // Raw unescaped pipes from audit content must not appear in the issue line.
    expect(md).toContain("broke on \\`code\\` and a \\| pipe second line");
    expect(md).toContain("Recommendation: fix \\| it");
    // Heading pipe escaped too.
    expect(md).toContain("Check\\|out");
  });

  it("omits the dimension table when scores are empty", () => {
    const audit = mkAudit();
    audit.results[0]!.scores = [];
    const md = fs.readFileSync(writeMarkdownSummary(audit, tmp), "utf8");
    expect(md).not.toContain("| Dimension | Score |");
  });

  it("renders an Issues section with severity + recommendation", () => {
    const audit = mkAudit();
    audit.results[0]!.issues = [
      {
        severity: "critical",
        description: "Login button missing",
        recommendation: "add a visible CTA",
      },
      {
        severity: "low",
        description: "minor typo",
        recommendation: "fix it",
      },
    ];
    const md = fs.readFileSync(writeMarkdownSummary(audit, tmp), "utf8");
    expect(md).toContain("**Issues:**");
    expect(md).toContain("- [CRITICAL] Login button missing");
    expect(md).toContain("- Recommendation: add a visible CTA");
    expect(md).toContain("- [LOW] minor typo");
  });

  it("redacts string values when redact_patterns is non-empty", () => {
    const audit = mkAudit({ redact_patterns: ["secret-token-xyz"] });
    audit.results[0]!.issues = [
      {
        severity: "low",
        description: "saw secret-token-xyz in body",
        recommendation: "hide it",
      },
    ];
    const md = fs.readFileSync(writeMarkdownSummary(audit, tmp), "utf8");
    expect(md).not.toContain("secret-token-xyz");
    expect(md).toContain("[REDACTED]");
  });
});

// ─────────────────────────────────────────────────────────────
// writeHtmlReport — top-level shape + escapes + cards
// ─────────────────────────────────────────────────────────────

describe("writeHtmlReport — base render", () => {
  it("writes audit.html to runDir and returns the path", () => {
    const p = writeHtmlReport(mkAudit(), tmp);
    expect(p).toBe(path.join(tmp, "audit.html"));
    expect(fs.existsSync(p)).toBe(true);
  });

  it("emits a valid <!doctype html> document with the project name in <title>", () => {
    const html = fs.readFileSync(writeHtmlReport(mkAudit(), tmp), "utf8");
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("<title>demo-project — Audit run-x</title>");
  });

  it("renders the 6 summary cards (Total / Pass / Warn / Fail / Issues / Critical)", () => {
    const audit = mkAudit({
      summary: {
        total: 9,
        pass: 5,
        pass_with_issues: 3,
        fail: 1,
        total_cost_usd: 0.42,
        total_issues: 17,
        critical_issues: 2,
      },
    });
    const html = fs.readFileSync(writeHtmlReport(audit, tmp), "utf8");
    expect(html).toContain('<div class="num">9</div><div class="label">Total</div>');
    expect(html).toContain(">5</div><div class=\"label\">Pass<");
    expect(html).toContain(">3</div><div class=\"label\">Warn<");
    expect(html).toContain(">1</div><div class=\"label\">Fail<");
    expect(html).toContain(">17</div><div class=\"label\">Issues<");
    expect(html).toContain(">2</div><div class=\"label\">Critical<");
    expect(html).toContain("Cost: $0.420");
  });

  it("escapes HTML metacharacters in project_name / run_id / base_url", () => {
    const audit = mkAudit({
      project_name: 'A&B<C>D"E\'F',
      run_id: '<run-id>',
      base_url: 'https://x.test/?q=1&v=2',
    });
    const html = fs.readFileSync(writeHtmlReport(audit, tmp), "utf8");
    expect(html).toContain("A&amp;B&lt;C&gt;D&quot;E&#39;F");
    expect(html).toContain("&lt;run-id&gt;");
    expect(html).toContain("https://x.test/?q=1&amp;v=2");
    // Raw injection must not survive
    expect(html).not.toContain('<run-id>');
  });

  it("renders one .unit block per result", () => {
    const audit = mkAudit();
    audit.results = [
      makeUnit({ scenario_id: "a", scenario_name: "A", persona_id: "p", persona_display_name: "X" }),
      makeUnit({ scenario_id: "b", scenario_name: "B", persona_id: "p", persona_display_name: "Y" }),
      makeUnit({ scenario_id: "c", scenario_name: "C", persona_id: "p", persona_display_name: "Z" }),
    ];
    audit.summary.total = 3;
    audit.summary.pass = 3;
    const html = fs.readFileSync(writeHtmlReport(audit, tmp), "utf8");
    const matches = html.match(/<div class="unit">/g) ?? [];
    expect(matches.length).toBe(3);
    expect(html).toContain("> A</h2");
    expect(html).toContain("> B</h2");
    expect(html).toContain("> C</h2");
  });
});

// ─────────────────────────────────────────────────────────────
// Per-unit rendering — badge / steps / issues / agent / gallery
// ─────────────────────────────────────────────────────────────

describe("writeHtmlReport — renderUnit details", () => {
  it("renders the pass badge for status=pass", () => {
    const html = fs.readFileSync(writeHtmlReport(mkAudit(), tmp), "utf8");
    expect(html).toContain("badge badge-pass");
  });

  it("renders the warn badge for status=pass_with_issues", () => {
    const audit = mkAudit();
    audit.results[0]!.status = "pass_with_issues";
    const html = fs.readFileSync(writeHtmlReport(audit, tmp), "utf8");
    expect(html).toContain("badge badge-warn");
  });

  it("renders the fail badge for status=fail", () => {
    const audit = mkAudit();
    audit.results[0]!.status = "fail";
    const html = fs.readFileSync(writeHtmlReport(audit, tmp), "utf8");
    expect(html).toContain("badge badge-fail");
  });

  it("renders score chips per dimension", () => {
    const audit = mkAudit();
    audit.results[0]!.scores = [
      { dimension: "completion", score: 9.0, justification: "" },
      { dimension: "perf", score: 7.2, justification: "" },
    ];
    const html = fs.readFileSync(writeHtmlReport(audit, tmp), "utf8");
    expect(html).toContain('class="score-chip">completion: <span class="v">9.0</span>');
    expect(html).toContain('class="score-chip">perf: <span class="v">7.2</span>');
  });

  it("renders issues with severity class and escapes description / recommendation", () => {
    const audit = mkAudit();
    audit.results[0]!.issues = [
      {
        severity: "critical",
        description: 'Bad <input>',
        recommendation: 'Use "secure" value',
      },
    ];
    const html = fs.readFileSync(writeHtmlReport(audit, tmp), "utf8");
    expect(html).toContain('class="issue critical"');
    expect(html).toContain("[CRITICAL]");
    expect(html).toContain("Bad &lt;input&gt;");
    expect(html).toContain("Use &quot;secure&quot; value");
  });

  it("renders steps with retries_used / execution_method / error annotations", () => {
    const audit = mkAudit();
    audit.results[0]!.steps = [
      { step_id: "ok", step_type: "visit", status: "pass", duration_ms: 100, retries_used: 0 },
      { step_id: "retry", step_type: "act", status: "pass", duration_ms: 200, retries_used: 2 },
      { step_id: "via", step_type: "see", status: "pass", duration_ms: 300, retries_used: 0, execution_method: "computer-use" },
      { step_id: "err", step_type: "assert", status: "fail", duration_ms: 50, retries_used: 0, error: 'boom <"ouch">' },
    ];
    const html = fs.readFileSync(writeHtmlReport(audit, tmp), "utf8");
    expect(html).toContain("retries=2");
    expect(html).toContain("via=computer-use");
    expect(html).toContain("boom &lt;&quot;ouch&quot;&gt;");
    // Default stagehand execution method is omitted
    expect(html).not.toMatch(/via=stagehand/);
  });

  it("renders the screenshot gallery when steps have a screenshot path", () => {
    const screenshotPath = path.join(tmp, "shots", "01.png");
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, "");
    const audit = mkAudit();
    audit.results[0]!.steps = [
      {
        step_id: "shot",
        step_type: "see",
        status: "pass",
        duration_ms: 100,
        retries_used: 0,
        screenshot: screenshotPath,
      },
    ];
    const html = fs.readFileSync(writeHtmlReport(audit, tmp), "utf8");
    expect(html).toContain('class="gallery"');
    expect(html).toContain("shots/01.png");
  });

  it("omits the gallery when no steps have screenshots", () => {
    const html = fs.readFileSync(writeHtmlReport(mkAudit(), tmp), "utf8");
    expect(html).not.toContain('class="gallery"');
  });

  it("renders the steps details summary with the step count", () => {
    const audit = mkAudit();
    audit.results[0]!.steps = [
      { step_id: "a", step_type: "visit", status: "pass", duration_ms: 100, retries_used: 0 },
      { step_id: "b", step_type: "see", status: "pass", duration_ms: 100, retries_used: 0 },
      { step_id: "c", step_type: "act", status: "pass", duration_ms: 100, retries_used: 0 },
    ];
    const html = fs.readFileSync(writeHtmlReport(audit, tmp), "utf8");
    expect(html).toContain("Step trace (3 steps)");
  });
});

// ─────────────────────────────────────────────────────────────
// Agent summary rendering (autonomous mode)
// ─────────────────────────────────────────────────────────────

describe("writeHtmlReport — renderAgentSummary", () => {
  it("renders the agent summary block when agent_summary is present", () => {
    const audit = mkAudit();
    audit.results[0]!.agent_summary = {
      total_actions: 12,
      plan_count: 3,
      convergence_reason: "goal_met",
      criteria_met: ["found checkout"],
      criteria_missed: [],
    };
    const html = fs.readFileSync(writeHtmlReport(audit, tmp), "utf8");
    expect(html).toContain("Agent Summary (Autonomous Mode)");
    expect(html).toContain("Actions: <strong style=\"color:#c9d1d9\">12</strong>");
    expect(html).toContain("Plans: <strong style=\"color:#c9d1d9\">3</strong>");
    expect(html).toContain("goal_met");
    expect(html).toContain("Criteria met: found checkout");
  });

  it("omits the agent summary block when agent_summary is undefined", () => {
    const html = fs.readFileSync(writeHtmlReport(mkAudit(), tmp), "utf8");
    expect(html).not.toContain("Agent Summary (Autonomous Mode)");
  });

  it.each([
    ["goal_met", "var(--pass)"],
    ["budget_exceeded", "var(--warn)"],
    ["max_actions", "var(--warn)"],
    ["stalled", "var(--fail)"],
  ] as const)(
    "uses border colour %s for convergence_reason=%s",
    (reason, expectedColor) => {
      const audit = mkAudit();
      audit.results[0]!.agent_summary = {
        total_actions: 1,
        plan_count: 1,
        convergence_reason: reason,
        criteria_met: [],
        criteria_missed: [],
      };
      const html = fs.readFileSync(writeHtmlReport(audit, tmp), "utf8");
      expect(html).toContain(`border-left:3px solid ${expectedColor}`);
    },
  );

  it("renders criteria_missed in warn colour when present", () => {
    const audit = mkAudit();
    audit.results[0]!.agent_summary = {
      total_actions: 5,
      plan_count: 2,
      convergence_reason: "max_actions",
      criteria_met: [],
      criteria_missed: ["found <pricing>", "found 'plan' page"],
    };
    const html = fs.readFileSync(writeHtmlReport(audit, tmp), "utf8");
    expect(html).toContain("Criteria missed:");
    expect(html).toContain("found &lt;pricing&gt;");
    expect(html).toContain("found &#39;plan&#39; page");
  });
});

// ─────────────────────────────────────────────────────────────
// Trend section (only renders when reportsDir + history >= 2)
// ─────────────────────────────────────────────────────────────

describe("writeHtmlReport — renderTrendSection", () => {
  function seedHistory(reportsDir: string, projectName: string, n: number): void {
    fs.mkdirSync(reportsDir, { recursive: true });
    for (let i = 0; i < n; i++) {
      const audit = mkAudit({
        project_name: projectName,
        run_id: `run-${i}`,
        started_at: new Date(Date.UTC(2026, 4, 1 + i, 12, 0, 0)).toISOString(),
        finished_at: new Date(Date.UTC(2026, 4, 1 + i, 12, 0, 5)).toISOString(),
        summary: {
          total: 5,
          pass: 4 - (i % 2),
          pass_with_issues: i % 2,
          fail: 0,
          total_cost_usd: 0.1 + i * 0.02,
          total_issues: i,
          critical_issues: 0,
        },
      });
      audit.results = Array.from({ length: 5 }, (_, j) => makeUnit({
        scenario_id: `s${j}`,
        scenario_name: `Scenario ${j}`,
        persona_id: `p${j}`,
        persona_display_name: `Persona ${j}`,
        overall_score: 7.5 + i * 0.1,
      }));
      saveAuditToHistory(audit, reportsDir);
    }
  }

  it("omits the trend section when reportsDir is not provided", () => {
    const html = fs.readFileSync(writeHtmlReport(mkAudit(), tmp), "utf8");
    expect(html).not.toContain("Quality Trend");
  });

  it("omits the trend section when history has < 2 entries", () => {
    const reportsDir = path.join(tmp, "reports");
    seedHistory(reportsDir, "demo-project", 1);
    const html = fs.readFileSync(writeHtmlReport(mkAudit(), tmp, reportsDir), "utf8");
    expect(html).not.toContain("Quality Trend");
  });

  it("renders the trend section with SVG sparkline when history >= 2", () => {
    const reportsDir = path.join(tmp, "reports");
    seedHistory(reportsDir, "demo-project", 4);
    const html = fs.readFileSync(writeHtmlReport(mkAudit(), tmp, reportsDir), "utf8");
    expect(html).toContain("Quality Trend (Last 4 Runs)");
    expect(html).toContain("<svg viewBox=\"0 0 600 150\"");
    expect(html).toContain("<polyline points=");
    expect(html).toContain("<polygon points=");
    // Gridlines at scores 2/4/6/8 → 4 <line> + 4 <text>
    const lineMatches = html.match(/<line x1="30"/g) ?? [];
    expect(lineMatches.length).toBe(4);
    // Data point dots — one circle per history entry
    const circleMatches = html.match(/<circle cx=/g) ?? [];
    expect(circleMatches.length).toBe(4);
  });

  it("renders the history table with up to 10 rows", () => {
    const reportsDir = path.join(tmp, "reports");
    seedHistory(reportsDir, "demo-project", 12);
    const html = fs.readFileSync(writeHtmlReport(mkAudit(), tmp, reportsDir), "utf8");
    expect(html).toContain('class="trend-table"');
    const rows = html.match(/<tr>\s*<td>2026-/g) ?? [];
    expect(rows.length).toBeLessThanOrEqual(10);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("renders the reliability stats cards from latest history entry", () => {
    const reportsDir = path.join(tmp, "reports");
    seedHistory(reportsDir, "demo-project", 3);
    const html = fs.readFileSync(writeHtmlReport(mkAudit(), tmp, reportsDir), "utf8");
    expect(html).toContain('class="reliability-stats"');
    expect(html).toContain('class="label">Passed</div>');
    expect(html).toContain('class="label">Warnings</div>');
    expect(html).toContain('class="label">Failed</div>');
    expect(html).toContain('class="label">Overall Score</div>');
  });
});

// ─────────────────────────────────────────────────────────────
// Misc end-to-end shape — redact + multi-result + agent + history
// ─────────────────────────────────────────────────────────────

describe("writeHtmlReport — redaction + composition", () => {
  it("redacts secrets across the entire HTML body", () => {
    const audit = mkAudit({ redact_patterns: ["sk-ant-secret-DONT_LEAK"] });
    audit.results[0]!.issues = [
      {
        severity: "low",
        description: "found sk-ant-secret-DONT_LEAK in headers",
        recommendation: "rotate it",
      },
    ];
    const html = fs.readFileSync(writeHtmlReport(audit, tmp), "utf8");
    expect(html).not.toContain("sk-ant-secret-DONT_LEAK");
    expect(html).toContain("[REDACTED]");
  });

  it("composes summary cards + trend + units + agent in the right order", () => {
    const reportsDir = path.join(tmp, "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    // Seed enough history for trend to render
    for (let i = 0; i < 3; i++) {
      const a = mkAudit({
        run_id: `run-${i}`,
        started_at: new Date(Date.UTC(2026, 4, 1 + i, 12)).toISOString(),
      });
      saveAuditToHistory(a, reportsDir);
    }
    const audit = mkAudit();
    audit.results[0]!.agent_summary = {
      total_actions: 1,
      plan_count: 1,
      convergence_reason: "goal_met",
      criteria_met: [],
      criteria_missed: [],
    };
    const html = fs.readFileSync(writeHtmlReport(audit, tmp, reportsDir), "utf8");
    const summaryAt = html.indexOf('class="summary"');
    const trendAt = html.indexOf("Quality Trend");
    const unitAt = html.indexOf('class="unit"');
    expect(summaryAt).toBeGreaterThan(0);
    expect(trendAt).toBeGreaterThan(summaryAt);
    expect(unitAt).toBeGreaterThan(trendAt);
  });
});

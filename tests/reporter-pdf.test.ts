/**
 * Tests for src/core/reporter-pdf.ts.
 *
 * Two surfaces:
 *   1. renderPdfHtml + helpers — pure functions, fully unit-tested.
 *   2. writePdfReport — mocked Playwright (a real chromium launch
 *      adds ~2s + flaky CI; the integration is verified separately
 *      via the live MCP smoke). We assert the wiring (HTML →
 *      page.setContent → page.pdf with the expected options) +
 *      cleanup paths (page.close, browser.close on both happy and
 *      throwing paths).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  collectTopFindings,
  colourForScore,
  computeOverallScore,
  escapeHtml,
  isPdfReportingSupported,
  renderPdfHtml,
  writePdfReport,
} from "../src/core/reporter-pdf.js";
import type { AuditRun, Issue, ScenarioRunResult } from "../src/core/types.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-rep-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────

function makeIssue(over: Partial<Issue> = {}): Issue {
  return {
    severity: "high",
    description: "Login button not visible above the fold",
    recommendation: "Move the CTA up by 80px",
    dimension: "completion",
    ...over,
  };
}

function makeScenario(over: Partial<ScenarioRunResult> = {}): ScenarioRunResult {
  return {
    scenario_id: "signup",
    scenario_name: "Sign up flow",
    persona_id: "us-desktop",
    persona_display_name: "US Desktop User",
    started_at: "2026-05-01T10:00:00.000Z",
    finished_at: "2026-05-01T10:00:30.000Z",
    duration_ms: 30000,
    status: "fail",
    fingerprint_id: "fp-1",
    steps: [
      {
        step_id: "v1",
        step_type: "visit",
        status: "pass",
        duration_ms: 200,
        retries_used: 0,
      },
    ],
    scores: [
      { dimension: "completion", score: 4.0, justification: "blocked" },
      { dimension: "visual_polish", score: 6.5, justification: "ok" },
    ],
    overall_score: 5.0,
    issues: [makeIssue()],
    artifacts: {},
    cost_usd: 0.05,
    ...over,
  };
}

function makeAudit(over: Partial<AuditRun> = {}): AuditRun {
  return {
    schema_version: "1.2.0",
    run_id: "20260501_100000_smoke",
    project_name: "demo-shop",
    base_url: "https://shop.example",
    started_at: "2026-05-01T10:00:00.000Z",
    finished_at: "2026-05-01T10:00:30.000Z",
    duration_ms: 30000,
    results: [makeScenario()],
    summary: {
      total: 1,
      pass: 0,
      pass_with_issues: 0,
      fail: 1,
      total_cost_usd: 0.05,
      total_issues: 1,
      critical_issues: 0,
    },
    config: {} as AuditRun["config"],
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────

describe("computeOverallScore", () => {
  it("returns 0 for an empty results array", () => {
    expect(computeOverallScore(makeAudit({ results: [] }))).toBe(0);
  });

  it("returns the score itself for a single result", () => {
    expect(
      computeOverallScore(
        makeAudit({ results: [makeScenario({ overall_score: 7.5 })] }),
      ),
    ).toBe(7.5);
  });

  it("returns the arithmetic mean across multiple results", () => {
    expect(
      computeOverallScore(
        makeAudit({
          results: [
            makeScenario({ overall_score: 6 }),
            makeScenario({ overall_score: 8 }),
            makeScenario({ overall_score: 10 }),
          ],
        }),
      ),
    ).toBe(8);
  });
});

describe("colourForScore", () => {
  it("returns green-700 for ≥ 8", () => {
    expect(colourForScore(8)).toBe("#15803d");
    expect(colourForScore(9.5)).toBe("#15803d");
    expect(colourForScore(10)).toBe("#15803d");
  });

  it("returns amber-700 for 5–8", () => {
    expect(colourForScore(5)).toBe("#a16207");
    expect(colourForScore(6.4)).toBe("#a16207");
    expect(colourForScore(7.99)).toBe("#a16207");
  });

  it("returns red-700 for < 5", () => {
    expect(colourForScore(0)).toBe("#b91c1c");
    expect(colourForScore(4.99)).toBe("#b91c1c");
  });
});

describe("collectTopFindings", () => {
  it("returns [] when audit has no issues", () => {
    expect(
      collectTopFindings(makeAudit({ results: [] }), 5),
    ).toEqual([]);
  });

  it("sorts by severity (critical → high → medium → low)", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          issues: [
            makeIssue({ severity: "low", description: "L1" }),
            makeIssue({ severity: "critical", description: "C1" }),
            makeIssue({ severity: "medium", description: "M1" }),
            makeIssue({ severity: "high", description: "H1" }),
          ],
        }),
      ],
    });
    const out = collectTopFindings(audit, 10);
    expect(out.map((i) => i.severity)).toEqual([
      "critical",
      "high",
      "medium",
      "low",
    ]);
  });

  it("respects the cap, taking the highest-severity ones first", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          issues: [
            makeIssue({ severity: "low" }),
            makeIssue({ severity: "low" }),
            makeIssue({ severity: "critical" }),
            makeIssue({ severity: "medium" }),
            makeIssue({ severity: "high" }),
          ],
        }),
      ],
    });
    const out = collectTopFindings(audit, 3);
    expect(out).toHaveLength(3);
    expect(out.map((i) => i.severity)).toEqual([
      "critical",
      "high",
      "medium",
    ]);
  });

  it("attaches the originating ScenarioRunResult to each finding", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          scenario_name: "Signup",
          persona_display_name: "US",
          issues: [makeIssue({ severity: "critical" })],
        }),
        makeScenario({
          scenario_name: "Checkout",
          persona_display_name: "JP",
          issues: [makeIssue({ severity: "low" })],
        }),
      ],
    });
    const out = collectTopFindings(audit, 5);
    expect(out[0].run.scenario_name).toBe("Signup");
    expect(out[0].run.persona_display_name).toBe("US");
    expect(out[1].run.scenario_name).toBe("Checkout");
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml("<a href=\"&q=1\">'x'</a>")).toBe(
      "&lt;a href=&quot;&amp;q=1&quot;&gt;&#39;x&#39;&lt;/a&gt;",
    );
  });

  it("returns plain ASCII unchanged", () => {
    expect(escapeHtml("Hello World 123")).toBe("Hello World 123");
  });
});

// ─────────────────────────────────────────────────────────────
// renderPdfHtml — the print-optimised template
// ─────────────────────────────────────────────────────────────

describe("renderPdfHtml — cover page", () => {
  it("includes project_name, base_url, and run date", () => {
    const html = renderPdfHtml(makeAudit());
    expect(html).toContain("demo-shop");
    expect(html).toContain("https://shop.example");
    expect(html).toContain("2026-05-01");
  });

  it("renders the overall score with the correct colour", () => {
    const html = renderPdfHtml(
      makeAudit({
        results: [
          makeScenario({ overall_score: 9 }),
          makeScenario({ overall_score: 9 }),
        ],
      }),
    );
    expect(html).toMatch(/score-number/);
    expect(html).toContain("#15803d"); // green for 9
    expect(html).toMatch(/9\.0/);
  });

  it("renders the summary card with all 7 audit-level counters", () => {
    const html = renderPdfHtml(makeAudit());
    expect(html).toMatch(/Total scenarios run/);
    expect(html).toMatch(/pass with issues/i);
    expect(html).toMatch(/Critical issues/);
    expect(html).toMatch(/Total cost/);
    expect(html).toMatch(/\$0\.050/);
  });

  it("emits an <img> with the supplied logoDataUri when set", () => {
    const html = renderPdfHtml(makeAudit(), {
      logoDataUri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
    });
    expect(html).toMatch(/<img src="data:image\/png;base64,/);
  });

  it("omits the logo when logoDataUri is not provided", () => {
    const html = renderPdfHtml(makeAudit());
    expect(html).not.toMatch(/<img src="data:image\/png/);
  });
});

describe("renderPdfHtml — top findings section", () => {
  it("emits a 'no issues found' message when the run is clean", () => {
    const audit = makeAudit({
      results: [makeScenario({ status: "pass", issues: [] })],
      summary: {
        total: 1,
        pass: 1,
        pass_with_issues: 0,
        fail: 0,
        total_cost_usd: 0,
        total_issues: 0,
        critical_issues: 0,
      },
    });
    const html = renderPdfHtml(audit);
    expect(html).toMatch(/No issues found in this run/);
  });

  it("orders findings by severity and caps at maxTopFindings", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          issues: [
            makeIssue({ severity: "low", description: "L issue" }),
            makeIssue({ severity: "critical", description: "C issue" }),
            makeIssue({ severity: "high", description: "H issue" }),
            makeIssue({ severity: "medium", description: "M issue" }),
          ],
        }),
      ],
    });
    const html = renderPdfHtml(audit, { maxTopFindings: 2 });
    // Critical and high are inside the cap; medium and low must not appear
    // in the top-findings section. ("M issue" / "L issue" still appears in
    // the per-scenario block below — we just don't cite it as a top
    // finding.)
    const findingsBlock = html.split("Top findings")[1]?.split("Scenario results")[0] ?? "";
    expect(findingsBlock).toContain("C issue");
    expect(findingsBlock).toContain("H issue");
    expect(findingsBlock).not.toContain("M issue");
    expect(findingsBlock).not.toContain("L issue");
  });

  it("attaches severity tag and scenario × persona context to each finding", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          scenario_name: "Sign up",
          persona_display_name: "JP Mobile",
          issues: [
            makeIssue({
              severity: "critical",
              description: "Form fails to submit",
            }),
          ],
        }),
      ],
    });
    const html = renderPdfHtml(audit);
    expect(html).toMatch(
      /<span class="severity-tag critical">critical<\/span>/,
    );
    expect(html).toContain("Sign up");
    expect(html).toContain("JP Mobile");
    expect(html).toContain("Form fails to submit");
  });
});

describe("renderPdfHtml — scenario results section", () => {
  it("emits one block per scenario × persona unit", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          scenario_id: "a",
          scenario_name: "Onboarding",
          persona_display_name: "US",
        }),
        makeScenario({
          scenario_id: "a",
          scenario_name: "Onboarding",
          persona_display_name: "JP",
        }),
        makeScenario({
          scenario_id: "b",
          scenario_name: "Checkout",
          persona_display_name: "US",
        }),
      ],
    });
    const html = renderPdfHtml(audit);
    const scenarioBlock = html
      .split("Scenario results")[1]
      ?.split("Methodology")[0] ?? "";
    expect((scenarioBlock.match(/scenario-block/g) ?? []).length).toBe(3);
  });

  it("includes per-dimension scores in a table", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          scores: [
            { dimension: "visual_polish", score: 6.5, justification: "" },
            { dimension: "completion", score: 4.0, justification: "" },
          ],
        }),
      ],
    });
    const html = renderPdfHtml(audit);
    expect(html).toMatch(/visual_polish[^<]*<\/td><td>6\.5/);
    expect(html).toMatch(/completion[^<]*<\/td><td>4\.0/);
  });

  it("emits a status badge with the unit's status (using i18n full-name)", () => {
    const audit = makeAudit({
      results: [
        makeScenario({ status: "pass", issues: [] }),
        makeScenario({ status: "pass_with_issues" }),
        makeScenario({ status: "fail" }),
      ],
    });
    const html = renderPdfHtml(audit);
    // CSS class still encodes the canonical English status; the visible
    // text is the localised full-form label (default 'en' → "Passed" /
    // "Passed with issues" / "Failed"). Localised in C2 of M2-4.
    expect(html).toMatch(/<span class="status pass">Passed<\/span>/);
    expect(html).toMatch(
      /<span class="status pass_with_issues">Passed with issues<\/span>/,
    );
    expect(html).toMatch(/<span class="status fail">Failed<\/span>/);
  });

  it("falls back to 'No issues raised' when a unit has zero issues", () => {
    const audit = makeAudit({
      results: [makeScenario({ status: "pass", issues: [] })],
    });
    const html = renderPdfHtml(audit);
    expect(html).toContain("No issues raised");
  });

  it("emits a placeholder section when audit.results is empty", () => {
    const audit = makeAudit({
      results: [],
      summary: {
        total: 0,
        pass: 0,
        pass_with_issues: 0,
        fail: 0,
        total_cost_usd: 0,
        total_issues: 0,
        critical_issues: 0,
      },
    });
    const html = renderPdfHtml(audit);
    expect(html).toContain("No scenarios ran in this audit.");
  });
});

describe("renderPdfHtml — methodology section", () => {
  it("lists every unique persona used in the run, sorted", () => {
    const audit = makeAudit({
      results: [
        makeScenario({ persona_display_name: "US Desktop" }),
        makeScenario({ persona_display_name: "JP Mobile" }),
        makeScenario({ persona_display_name: "US Desktop" }), // dup
      ],
    });
    const html = renderPdfHtml(audit);
    const methSection = html.split("Methodology")[1] ?? "";
    expect(methSection).toMatch(/<li>JP Mobile<\/li>/);
    expect(methSection).toMatch(/<li>US Desktop<\/li>/);
    // Sorted: JP < US
    expect(methSection.indexOf("JP Mobile")).toBeLessThan(
      methSection.indexOf("US Desktop"),
    );
  });

  it("lists every unique scenario in the run", () => {
    const audit = makeAudit({
      results: [
        makeScenario({ scenario_name: "Onboarding" }),
        makeScenario({ scenario_name: "Checkout" }),
      ],
    });
    const html = renderPdfHtml(audit);
    const methSection = html.split("Methodology")[1] ?? "";
    expect(methSection).toMatch(/<li>Onboarding<\/li>/);
    expect(methSection).toMatch(/<li>Checkout<\/li>/);
  });

  it("includes the run_id in the disclaimer footer for archival", () => {
    const audit = makeAudit({ run_id: "run-archival-12345" });
    const html = renderPdfHtml(audit);
    expect(html).toContain("run-archival-12345");
  });
});

describe("renderPdfHtml — escaping", () => {
  it("escapes XSS-style HTML in project_name + scenario_name + descriptions", () => {
    const audit = makeAudit({
      project_name: "<script>alert('x')</script>",
      results: [
        makeScenario({
          scenario_name: 'A & "B"',
          persona_display_name: '<img src=x>',
          issues: [
            makeIssue({
              description: 'Found <script>alert(1)</script> in body',
            }),
          ],
        }),
      ],
    });
    const html = renderPdfHtml(audit);
    expect(html).not.toContain("<script>alert('x')</script>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)");
    expect(html).toContain('A &amp; &quot;B&quot;');
    expect(html).toContain("&lt;img src=x&gt;");
  });
});

describe("renderPdfHtml — redaction", () => {
  it("redacts secrets from issue descriptions before rendering", () => {
    const audit = makeAudit({
      redact_patterns: ["sk-ant-pdf-secret-9999"],
      results: [
        makeScenario({
          issues: [
            makeIssue({
              description: "Saw token sk-ant-pdf-secret-9999 in the page",
            }),
          ],
        }),
      ],
    });
    const html = renderPdfHtml(audit);
    expect(html).not.toContain("sk-ant-pdf-secret-9999");
    expect(html).toContain("[REDACTED]");
  });
});

describe("renderPdfHtml — WCAG compliance section (M2-2)", () => {
  it("omits the WCAG section when there are no accessibility issues", () => {
    const html = renderPdfHtml(makeAudit());
    // Default fixture has only a non-a11y issue (no wcag fields)
    expect(html).not.toContain('class="section wcag"');
    expect(html).not.toContain("WCAG compliance summary");
  });

  it("emits the WCAG section when accessibility issues are present", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          status: "fail",
          issues: [
            makeIssue({
              severity: "high",
              dimension: "accessibility",
              wcag_level: "AA",
              wcag_criterion: "1.4.3",
              description: "Contrast 3.2:1 on hero CTA",
            }),
            makeIssue({
              severity: "critical",
              dimension: "accessibility",
              wcag_level: "A",
              wcag_criterion: "2.1.1",
              description: "Modal close button not keyboard accessible",
            }),
            makeIssue({
              severity: "medium",
              dimension: "accessibility",
              wcag_level: "AA",
              wcag_criterion: "1.4.3",
            }),
          ],
        }),
      ],
    });
    const html = renderPdfHtml(audit);
    expect(html).toContain("WCAG compliance summary");
    expect(html).toContain('class="section wcag"');
  });

  it("includes a by-level table with correct counts", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          issues: [
            makeIssue({ wcag_level: "A", wcag_criterion: "1.1.1" }),
            makeIssue({ wcag_level: "AA", wcag_criterion: "1.4.3" }),
            makeIssue({ wcag_level: "AA", wcag_criterion: "1.4.3" }),
            makeIssue({ wcag_level: "AAA", wcag_criterion: "1.4.6" }),
          ],
        }),
      ],
    });
    const html = renderPdfHtml(audit);
    const wcagSec = html.split('class="section wcag"')[1] ?? "";
    expect(wcagSec).toMatch(/<td>A<\/td><td>1<\/td>/);
    expect(wcagSec).toMatch(/<td>AA<\/td><td>2<\/td>/);
    expect(wcagSec).toMatch(/<td>AAA<\/td><td>1<\/td>/);
  });

  it("includes top criteria table sorted by count desc with W3C deep links", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          issues: [
            makeIssue({ wcag_level: "AA", wcag_criterion: "1.4.3" }),
            makeIssue({ wcag_level: "AA", wcag_criterion: "1.4.3" }),
            makeIssue({ wcag_level: "AA", wcag_criterion: "1.4.3" }),
            makeIssue({ wcag_level: "A", wcag_criterion: "2.1.1" }),
          ],
        }),
      ],
    });
    const html = renderPdfHtml(audit);
    expect(html).toContain(
      'href="https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum"',
    );
    expect(html).toContain("Contrast (Minimum)");
    expect(html).toContain("(AA)");
    // 1.4.3 has 3 violations vs 2.1.1's 1 — appears first
    const wcagSec = html.split('class="section wcag"')[1] ?? "";
    expect(wcagSec.indexOf("1.4.3")).toBeLessThan(wcagSec.indexOf("2.1.1"));
  });

  it("includes by-principle counts (Perceivable / Operable / etc)", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          issues: [
            makeIssue({ wcag_level: "AA", wcag_criterion: "1.4.3" }), // perceivable
            makeIssue({ wcag_level: "A", wcag_criterion: "2.1.1" }), // operable
            makeIssue({ wcag_level: "A", wcag_criterion: "4.1.2" }), // robust
          ],
        }),
      ],
    });
    const html = renderPdfHtml(audit);
    expect(html).toContain("Perceivable");
    expect(html).toContain("Operable");
    expect(html).toContain("Robust");
  });

  it("translates the WCAG section in zh-CN", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          issues: [makeIssue({ wcag_level: "AA", wcag_criterion: "1.4.3" })],
        }),
      ],
    });
    const html = renderPdfHtml(audit, { locale: "zh-CN" });
    expect(html).toContain("WCAG 合规摘要");
    expect(html).toContain("按一致性级别");
    expect(html).toContain("可感知");
  });
});

describe("renderPdfHtml — i18n integration (M2-4)", () => {
  it("renders the cover labels in zh-CN when locale is set", () => {
    const html = renderPdfHtml(makeAudit(), { locale: "zh-CN" });
    expect(html).toContain("AI 浏览器审计报告");
    expect(html).toContain("项目"); // Project label
    expect(html).toContain("总评分"); // Overall score
    expect(html).toContain("总场景数"); // Total scenarios
    // English text shouldn't be there in localised form
    expect(html).not.toContain("AI Browser Audit Report");
  });

  it("renders the cover labels in ja", () => {
    const html = renderPdfHtml(makeAudit(), { locale: "ja" });
    expect(html).toContain("AIブラウザ監査レポート");
    expect(html).toContain("プロジェクト");
    expect(html).toContain("総合スコア");
  });

  it("renders the cover labels in es", () => {
    const html = renderPdfHtml(makeAudit(), { locale: "es" });
    expect(html).toContain("Informe de Auditoría AI Browser");
    expect(html).toContain("Proyecto");
    expect(html).toContain("Puntuación general");
  });

  it("renders the cover labels in de", () => {
    const html = renderPdfHtml(makeAudit(), { locale: "de" });
    expect(html).toContain("KI-Browser-Audit-Bericht");
    expect(html).toContain("Projekt");
    expect(html).toContain("Gesamtpunktzahl");
  });

  it("severity tags are translated in the issue cards", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          status: "fail",
          issues: [makeIssue({ severity: "critical" })],
        }),
      ],
    });
    const zh = renderPdfHtml(audit, { locale: "zh-CN" });
    expect(zh).toContain(">严重<"); // critical → 严重
    const ja = renderPdfHtml(audit, { locale: "ja" });
    expect(ja).toContain(">致命的<");
  });

  it("methodology disclaimer is translated", () => {
    const html = renderPdfHtml(makeAudit(), { locale: "zh-CN" });
    expect(html).toContain("方法说明"); // Methodology
    expect(html).toContain("校准"); // 'calibrated' from disclaimer
  });

  it("default locale (no opts) is English", () => {
    const html = renderPdfHtml(makeAudit());
    expect(html).toContain("AI Browser Audit Report");
    expect(html).toContain("Methodology");
  });
});

describe("renderPdfHtml — global structure", () => {
  it("starts with <!doctype html> and ends with </html>", () => {
    const html = renderPdfHtml(makeAudit());
    expect(html).toMatch(/^<!doctype html>/);
    expect(html.trim()).toMatch(/<\/html>$/);
  });

  it("has page-break controls so cover/findings/scenarios/methodology never split", () => {
    const html = renderPdfHtml(makeAudit());
    expect(html).toContain("page-break-after: always");
    expect(html).toContain("page-break-before: always");
    expect(html).toContain("page-break-inside: avoid");
  });

  it("respects the brandColor option", () => {
    const html = renderPdfHtml(makeAudit(), { brandColor: "#ff0066" });
    expect(html).toContain("#ff0066");
  });
});

// ─────────────────────────────────────────────────────────────
// writePdfReport — Playwright wiring (mocked)
// ─────────────────────────────────────────────────────────────

describe("writePdfReport — wiring", () => {
  function buildMockBrowser(opts: { pdfThrows?: boolean } = {}) {
    const captures: {
      setContentArgs: unknown[][];
      pdfArgs: unknown[][];
      pageClosed: number;
      browserClosed: number;
    } = {
      setContentArgs: [],
      pdfArgs: [],
      pageClosed: 0,
      browserClosed: 0,
    };
    const page = {
      setContent: vi.fn(async (...args: unknown[]) => {
        captures.setContentArgs.push(args);
      }),
      pdf: vi.fn(async (...args: unknown[]) => {
        captures.pdfArgs.push(args);
        if (opts.pdfThrows) throw new Error("render failed");
        // Real Playwright writes the file when `path` is set; emulate.
        const arg = args[0] as { path?: string };
        if (arg?.path) fs.writeFileSync(arg.path, Buffer.from("%PDF-1.4\n%mock\n"));
      }),
      close: vi.fn(async () => {
        captures.pageClosed++;
      }),
    };
    const browser = {
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {
        captures.browserClosed++;
      }),
    };
    return { browser, page, captures };
  }

  it("renders HTML, sets it on a page, and writes the PDF to <runDir>/audit.pdf", async () => {
    const { browser, captures } = buildMockBrowser();
    const audit = makeAudit();
    const out = await writePdfReport(audit, tmp, {
      launchBrowser: async () => browser,
    });
    expect(out).toBe(path.join(tmp, "audit.pdf"));
    expect(fs.existsSync(out)).toBe(true);
    // setContent received the rendered HTML
    expect(captures.setContentArgs).toHaveLength(1);
    expect(captures.setContentArgs[0][0]).toContain("demo-shop");
    expect(captures.setContentArgs[0][1]).toEqual({ waitUntil: "networkidle" });
    // pdf was called with A4 + 1.5cm margins + header/footer template
    expect(captures.pdfArgs).toHaveLength(1);
    const pdfCall = captures.pdfArgs[0][0] as {
      format: string;
      printBackground: boolean;
      margin: { top: string };
      displayHeaderFooter: boolean;
      headerTemplate: string;
      footerTemplate: string;
      path: string;
    };
    expect(pdfCall.format).toBe("A4");
    expect(pdfCall.printBackground).toBe(true);
    expect(pdfCall.margin.top).toBe("1.5cm");
    expect(pdfCall.displayHeaderFooter).toBe(true);
    expect(pdfCall.headerTemplate).toContain("demo-shop");
    expect(pdfCall.footerTemplate).toContain("20260501_100000_smoke");
    expect(pdfCall.path).toBe(out);
  });

  it("closes the page and the browser even on success", async () => {
    const { browser, captures } = buildMockBrowser();
    await writePdfReport(makeAudit(), tmp, { launchBrowser: async () => browser });
    expect(captures.pageClosed).toBe(1);
    expect(captures.browserClosed).toBe(1);
  });

  it("closes the page and the browser when page.pdf() throws", async () => {
    const { browser, captures } = buildMockBrowser({ pdfThrows: true });
    await expect(
      writePdfReport(makeAudit(), tmp, { launchBrowser: async () => browser }),
    ).rejects.toThrow(/render failed/);
    expect(captures.pageClosed).toBe(1);
    expect(captures.browserClosed).toBe(1);
  });

  it("is idempotent — overwrites an existing audit.pdf with new content", async () => {
    const { browser } = buildMockBrowser();
    const out = path.join(tmp, "audit.pdf");
    fs.writeFileSync(out, "old garbage");
    await writePdfReport(makeAudit(), tmp, { launchBrowser: async () => browser });
    const after = fs.readFileSync(out, "utf8");
    expect(after).toMatch(/^%PDF-1\.4/);
  });

  it("propagates redaction patterns into the rendered HTML", async () => {
    const { browser, captures } = buildMockBrowser();
    const audit = makeAudit({
      redact_patterns: ["wire-secret-aaaa"],
      results: [
        makeScenario({
          issues: [
            makeIssue({ description: "page leaked wire-secret-aaaa" }),
          ],
        }),
      ],
    });
    await writePdfReport(audit, tmp, { launchBrowser: async () => browser });
    const html = captures.setContentArgs[0][0] as string;
    expect(html).not.toContain("wire-secret-aaaa");
    expect(html).toContain("[REDACTED]");
  });
});

// ─────────────────────────────────────────────────────────────
// Capability probe
// ─────────────────────────────────────────────────────────────

describe("isPdfReportingSupported", () => {
  it("returns true when playwright is installed (we ship it as a dep)", () => {
    expect(isPdfReportingSupported()).toBe(true);
  });
});

/**
 * PDF report generator — stakeholder-facing summary of an audit run.
 *
 * Produces `audit.pdf` alongside the existing JSON / HTML / SPA reports.
 * Targets non-technical readers (PMs, executives, customers) who need a
 * concise 3-minute scan rather than a deep-dive — so screenshots and
 * step-level detail are deliberately omitted; for those, the recipient
 * opens audit-explorer.html.
 *
 * Implementation: render a print-optimised HTML document, then use
 * Playwright's chromium PDF export. Vector text, embedded fonts,
 * searchable inside any PDF reader. No new dependencies.
 *
 * Layout (A4 portrait, 1.5cm margins, 12pt body):
 *   Page 1 — Cover: project name, run date, base URL, big colour-coded
 *            score, summary stats card.
 *   Page 2 — Top critical findings (by severity, max 5).
 *   Page 3+ — Per-scenario × persona summary blocks.
 *   Last page — Methodology: personas used, scenarios run, AI model
 *               versions, disclaimer.
 *   Every page: project name (header), page X/Y + run_id (footer).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AuditRun, Issue, ScenarioRunResult } from "./types.js";
import { redactDeep } from "./secrets.js";
import { DEFAULT_LOCALE, t, type Locale } from "./i18n.js";
import { summarizeWcag, wcagHelpUrl, type WcagSummary } from "./wcag.js";

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

export interface PdfReportOptions {
  /** Brand accent colour (hex). Default: deep blue #1e3a8a. */
  brandColor?: string;
  /** Optional logo data URI rendered top-left of the cover page. */
  logoDataUri?: string;
  /** Cap on findings shown in the "Top critical findings" section. Default 5. */
  maxTopFindings?: number;
  /** Locale for the report skeleton (labels, headings, disclaimers). Default 'en'. */
  locale?: Locale;
  /**
   * Override Playwright launch — the audit's already-running browser
   * can be reused if passed in, avoiding a 2 s cold-start per run.
   * If not set, writePdfReport() spawns a fresh chromium for the render.
   */
  launchBrowser?: () => Promise<{
    newPage(): Promise<{
      setContent(html: string, opts?: { waitUntil?: "load" | "networkidle" }): Promise<void>;
      pdf(opts: PdfRenderOptions): Promise<Buffer>;
      close(): Promise<void>;
    }>;
    close(): Promise<void>;
  }>;
}

export interface PdfRenderOptions {
  format?: "A4" | "Letter";
  printBackground?: boolean;
  margin?: { top: string; right: string; bottom: string; left: string };
  displayHeaderFooter?: boolean;
  headerTemplate?: string;
  footerTemplate?: string;
  path?: string;
}

/**
 * Render the print-optimised HTML for an audit. Pure function — no I/O,
 * no browser launch. Useful for inspection / unit tests / piping to a
 * different PDF backend.
 */
export function renderPdfHtml(
  inputAudit: AuditRun,
  opts: PdfReportOptions = {},
): string {
  const audit = applyRedaction(inputAudit);
  const brand = opts.brandColor ?? "#1e3a8a";
  const maxTopFindings = opts.maxTopFindings ?? 5;
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const overall = computeOverallScore(audit);
  const scoreColor = colourForScore(overall);
  const topFindings = collectTopFindings(audit, maxTopFindings);
  const personasUsed = uniquePersonas(audit);
  const scenariosUsed = uniqueScenarios(audit);

  // M2-2: WCAG compliance summary appears between top findings and the
  // per-scenario blocks when any accessibility issues are present in
  // the run. Skipped entirely on runs that don't include an
  // assert_a11y step (no a11y issues = no compliance section).
  const allIssues: Issue[] = audit.results.flatMap((r) => r.issues);
  const wcagSummary = summarizeWcag(allIssues);

  return [
    PDF_HEADER_OPEN,
    `<style>${pdfStylesheet(brand)}</style>`,
    PDF_HEADER_CLOSE,
    coverSection(audit, overall, scoreColor, locale, opts.logoDataUri),
    findingsSection(topFindings, brand, locale),
    wcagSummary.totalIssues > 0
      ? wcagSection(wcagSummary, locale)
      : "",
    scenarioSections(audit, locale),
    methodologySection(audit, personasUsed, scenariosUsed, locale),
    PDF_FOOTER,
  ].join("\n");
}

/**
 * Render an audit as PDF and write it to <runDir>/audit.pdf.
 *
 * Spawns a fresh Chromium via Playwright unless `launchBrowser` is
 * supplied. Returns the absolute path of the written PDF.
 */
export async function writePdfReport(
  audit: AuditRun,
  runDir: string,
  opts: PdfReportOptions = {},
): Promise<string> {
  const filePath = path.join(runDir, "audit.pdf");
  const html = renderPdfHtml(audit, opts);

  const browser = opts.launchBrowser
    ? await opts.launchBrowser()
    : await launchChromium();
  let page;
  try {
    page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const locale = opts.locale ?? DEFAULT_LOCALE;
    await page.pdf({
      path: filePath,
      format: "A4",
      printBackground: true,
      margin: { top: "1.5cm", right: "1.5cm", bottom: "1.8cm", left: "1.5cm" },
      displayHeaderFooter: true,
      headerTemplate: pdfHeaderTemplate(audit, locale),
      footerTemplate: pdfFooterTemplate(audit),
    });
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return filePath;
}

// Test seam — exposed so unit tests can stub Playwright without spawning
// a real chromium. Real callers route through writePdfReport which uses
// dynamic import to avoid loading playwright on cold paths.
export async function _launchChromium(): Promise<ReturnType<NonNullable<PdfReportOptions["launchBrowser"]>>> {
  return launchChromium();
}

async function launchChromium(): Promise<NonNullable<Awaited<ReturnType<NonNullable<PdfReportOptions["launchBrowser"]>>>>> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  return browser as unknown as NonNullable<
    Awaited<ReturnType<NonNullable<PdfReportOptions["launchBrowser"]>>>
  >;
}

// ─────────────────────────────────────────────────────────────
// HTML composition helpers (pure)
// ─────────────────────────────────────────────────────────────

const PDF_HEADER_OPEN = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Audit Report</title>`;

const PDF_HEADER_CLOSE = `</head>
<body>`;

const PDF_FOOTER = `</body></html>`;

function pdfStylesheet(brand: string): string {
  // Print-optimised: 12pt body, Helvetica fallback chain (every PDF
  // reader has these), high contrast (passes 4.5:1), strict page-break
  // controls so sections never split awkwardly.
  return `
    @page { size: A4 portrait; }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
      font-size: 12pt;
      line-height: 1.5;
      color: #111;
      margin: 0;
    }
    h1 { font-size: 22pt; font-weight: 700; margin: 0 0 4pt 0; color: ${brand}; }
    h2 { font-size: 16pt; font-weight: 700; margin: 18pt 0 6pt 0; color: ${brand}; page-break-after: avoid; }
    h3 { font-size: 13pt; font-weight: 600; margin: 12pt 0 4pt 0; page-break-after: avoid; }
    p { margin: 0 0 6pt 0; }
    .cover { page-break-after: always; padding-top: 30pt; }
    .cover .meta { color: #555; font-size: 11pt; }
    .cover .meta div { margin-bottom: 2pt; }
    .score-block { text-align: center; margin: 36pt 0; }
    .score-number { font-size: 72pt; font-weight: 700; line-height: 1; }
    .score-label { font-size: 11pt; color: #555; text-transform: uppercase; letter-spacing: 1pt; margin-top: 8pt; }
    .summary-card { border: 1pt solid #ccc; border-radius: 4pt; padding: 12pt; margin: 18pt 0; }
    .summary-card table { width: 100%; border-collapse: collapse; }
    .summary-card td { padding: 4pt 8pt; font-size: 11pt; }
    .summary-card td:first-child { color: #555; }
    .summary-card td:last-child { text-align: right; font-weight: 600; }

    .section { page-break-before: always; }
    .findings .finding {
      border-left: 3pt solid #ccc; padding: 8pt 12pt; margin-bottom: 10pt; page-break-inside: avoid;
    }
    .findings .finding.critical { border-left-color: #b91c1c; }
    .findings .finding.high { border-left-color: #b91c1c; }
    .findings .finding.medium { border-left-color: #a16207; }
    .findings .finding.low { border-left-color: #555; }
    .severity-tag {
      display: inline-block; font-size: 9pt; font-weight: 700; text-transform: uppercase;
      padding: 1pt 6pt; border-radius: 3pt; margin-right: 6pt; letter-spacing: 0.5pt;
    }
    .severity-tag.critical, .severity-tag.high { background: #fee2e2; color: #991b1b; }
    .severity-tag.medium { background: #fef3c7; color: #854d0e; }
    .severity-tag.low { background: #e5e7eb; color: #374151; }
    .recommendation { font-size: 10pt; color: #555; margin-top: 4pt; }

    .scenario-block { margin-bottom: 16pt; page-break-inside: avoid; }
    .scenario-hdr { display: flex; align-items: baseline; gap: 8pt; }
    .scenario-hdr .status {
      font-size: 9pt; font-weight: 700; text-transform: uppercase;
      padding: 1pt 6pt; border-radius: 3pt; letter-spacing: 0.5pt;
    }
    .status.pass { background: #dcfce7; color: #14532d; }
    .status.pass_with_issues { background: #fef3c7; color: #854d0e; }
    .status.fail { background: #fee2e2; color: #991b1b; }
    .scenario-meta { font-size: 10pt; color: #555; margin-top: 2pt; }
    .dim-table { width: 100%; border-collapse: collapse; margin: 6pt 0; font-size: 10pt; }
    .dim-table td { padding: 2pt 4pt; border-bottom: 0.5pt solid #eee; }
    .dim-table td:last-child { text-align: right; font-weight: 600; }

    .methodology { font-size: 11pt; }
    .methodology ul { margin: 4pt 0 8pt 18pt; padding: 0; }
    .methodology li { margin-bottom: 2pt; }
    .disclaimer { font-size: 9pt; color: #777; margin-top: 18pt; border-top: 0.5pt solid #ccc; padding-top: 8pt; }
  `;
}

function pdfHeaderTemplate(audit: AuditRun, locale: Locale): string {
  // Chromium's headerTemplate runs in print context; it can use only a
  // subset of CSS (no external resources). Inline minimal styling.
  return `<div style="font-size: 8pt; color: #888; padding: 0 1.5cm; width: 100%; display: flex; justify-content: space-between;">
    <span>${escapeHtml(audit.project_name)} — ${escapeHtml(t("audit_report_title", locale))}</span>
    <span>${escapeHtml(audit.started_at.split("T")[0] ?? audit.started_at)}</span>
  </div>`;
}

function pdfFooterTemplate(audit: AuditRun): string {
  return `<div style="font-size: 8pt; color: #888; padding: 0 1.5cm; width: 100%; display: flex; justify-content: space-between;">
    <span>${escapeHtml(audit.run_id)}</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
  </div>`;
}

function coverSection(
  audit: AuditRun,
  overall: number,
  scoreColor: string,
  locale: Locale,
  logoDataUri?: string,
): string {
  const dateStr = audit.started_at.split("T")[0] ?? audit.started_at;
  const durationStr = `${(audit.duration_ms / 1000).toFixed(1)} s`;
  const cost = `$${audit.summary.total_cost_usd.toFixed(3)}`;

  const logo = logoDataUri
    ? `<img src="${logoDataUri}" alt="logo" style="max-height: 36pt; margin-bottom: 18pt;">`
    : "";

  return `<section class="cover">
    ${logo}
    <h1>${escapeHtml(t("audit_report_title", locale))}</h1>
    <div class="meta">
      <div><strong>${escapeHtml(t("project_label", locale))}:</strong> ${escapeHtml(audit.project_name)}</div>
      <div><strong>${escapeHtml(t("url_label", locale))}:</strong> ${escapeHtml(audit.base_url)}</div>
      <div><strong>${escapeHtml(t("date_label", locale))}:</strong> ${escapeHtml(dateStr)}</div>
      <div><strong>${escapeHtml(t("duration", locale))}:</strong> ${durationStr}</div>
    </div>

    <div class="score-block">
      <div class="score-number" style="color: ${scoreColor};">${overall.toFixed(1)}</div>
      <div class="score-label">${escapeHtml(t("overall_score", locale))} · ${escapeHtml(t("score_scale", locale))}</div>
    </div>

    <div class="summary-card">
      <table>
        <tr><td>${escapeHtml(t("total_scenarios", locale))}</td><td>${audit.summary.total}</td></tr>
        <tr><td>${escapeHtml(t("pass", locale))}</td><td>${audit.summary.pass}</td></tr>
        <tr><td>${escapeHtml(t("pass_with_issues", locale))}</td><td>${audit.summary.pass_with_issues}</td></tr>
        <tr><td>${escapeHtml(t("fail", locale))}</td><td>${audit.summary.fail}</td></tr>
        <tr><td>${escapeHtml(t("critical_issues", locale))}</td><td>${audit.summary.critical_issues}</td></tr>
        <tr><td>${escapeHtml(t("total_issues", locale))}</td><td>${audit.summary.total_issues}</td></tr>
        <tr><td>${escapeHtml(t("total_cost", locale))}</td><td>${cost}</td></tr>
      </table>
    </div>
  </section>`;
}

function findingsSection(
  findings: Array<Issue & { run: ScenarioRunResult }>,
  brand: string,
  locale: Locale,
): string {
  if (findings.length === 0) {
    return `<section class="section findings">
      <h2>${escapeHtml(t("pdf_top_findings_title", locale))}</h2>
      <p>${escapeHtml(t("no_issues_found", locale))}</p>
    </section>`;
  }
  const items = findings
    .map(
      (f) => `<div class="finding ${f.severity}">
        <span class="severity-tag ${f.severity}">${escapeHtml(t(f.severity, locale))}</span>
        <strong>${escapeHtml(f.run.scenario_name)}</strong>
        <span style="color:#555"> · ${escapeHtml(f.run.persona_display_name)}</span>
        <p style="margin-top: 4pt;">${escapeHtml(f.description)}</p>
        <div class="recommendation">${escapeHtml(t("recommendation", locale))}: ${escapeHtml(f.recommendation)}</div>
      </div>`,
    )
    .join("\n");
  return `<section class="section findings">
    <h2>${escapeHtml(t("pdf_top_findings_title", locale))}</h2>
    <p style="color: #555; font-size: 11pt;">${escapeHtml(t("pdf_findings_subtitle", locale))}</p>
    ${items}
  </section>`;
}

function wcagSection(summary: WcagSummary, locale: Locale): string {
  // 3 sub-blocks: by-level table, by-principle table, top criteria.
  // Compact tables — this section sits between findings and the
  // per-scenario detail and shouldn't dominate the PDF page count.
  const principleKey = (
    p: "perceivable" | "operable" | "understandable" | "robust" | "unknown",
  ): "pdf_wcag_principle_perceivable" | "pdf_wcag_principle_operable"
    | "pdf_wcag_principle_understandable" | "pdf_wcag_principle_robust"
    | "pdf_wcag_principle_unknown" => {
    switch (p) {
      case "perceivable":
        return "pdf_wcag_principle_perceivable";
      case "operable":
        return "pdf_wcag_principle_operable";
      case "understandable":
        return "pdf_wcag_principle_understandable";
      case "robust":
        return "pdf_wcag_principle_robust";
      case "unknown":
        return "pdf_wcag_principle_unknown";
    }
  };

  const levelRows = (
    [
      ["A", summary.byLevel.A],
      ["AA", summary.byLevel.AA],
      ["AAA", summary.byLevel.AAA],
      [t("pdf_wcag_level_unknown", locale), summary.byLevel.unknown],
    ] as Array<[string, number]>
  )
    .filter(([, count]) => count > 0)
    .map(
      ([label, count]) =>
        `<tr><td>${escapeHtml(label)}</td><td>${count}</td></tr>`,
    )
    .join("\n");

  const principleRows = (
    [
      ["perceivable", summary.byPrinciple.perceivable],
      ["operable", summary.byPrinciple.operable],
      ["understandable", summary.byPrinciple.understandable],
      ["robust", summary.byPrinciple.robust],
      ["unknown", summary.byPrinciple.unknown],
    ] as Array<
      ["perceivable" | "operable" | "understandable" | "robust" | "unknown", number]
    >
  )
    .filter(([, count]) => count > 0)
    .map(
      ([principle, count]) =>
        `<tr><td>${escapeHtml(t(principleKey(principle), locale))}</td><td>${count}</td></tr>`,
    )
    .join("\n");

  // Top 8 criteria — beyond that the PDF gets long and stakeholders
  // glaze over. Engineers wanting the full list look at audit.json.
  const topCriteria = summary.byCriterion.slice(0, 8);
  const criterionRows = topCriteria
    .map(
      (entry) =>
        `<tr><td><a href="${escapeHtml(wcagHelpUrl(entry.criterion))}">${escapeHtml(entry.criterion.id)}</a> ${escapeHtml(entry.criterion.name)} <span style="color:#555">(${entry.criterion.level})</span></td><td>${entry.count}</td></tr>`,
    )
    .join("\n");

  return `<section class="section wcag">
    <h2>${escapeHtml(t("pdf_wcag_section_title", locale))}</h2>
    <p style="color: #555; font-size: 11pt;">${escapeHtml(t("pdf_wcag_section_intro", locale))}</p>

    <h3>${escapeHtml(t("pdf_wcag_by_level", locale))}</h3>
    ${
      levelRows
        ? `<table class="dim-table"><thead><tr><th>${escapeHtml(t("pdf_wcag_by_level", locale))}</th><th>${escapeHtml(t("pdf_wcag_count_label", locale))}</th></tr></thead><tbody>${levelRows}</tbody></table>`
        : ""
    }

    <h3>${escapeHtml(t("pdf_wcag_by_principle", locale))}</h3>
    ${
      principleRows
        ? `<table class="dim-table"><thead><tr><th>${escapeHtml(t("pdf_wcag_by_principle", locale))}</th><th>${escapeHtml(t("pdf_wcag_count_label", locale))}</th></tr></thead><tbody>${principleRows}</tbody></table>`
        : ""
    }

    ${
      topCriteria.length > 0
        ? `<h3>${escapeHtml(t("pdf_wcag_by_criterion", locale))}</h3>
    <table class="dim-table"><tbody>${criterionRows}</tbody></table>`
        : ""
    }
  </section>`;
}

function scenarioSections(audit: AuditRun, locale: Locale): string {
  if (audit.results.length === 0) {
    return `<section class="section">
      <h2>${escapeHtml(t("pdf_scenario_results_title", locale))}</h2>
      <p>${escapeHtml(t("pdf_no_scenarios", locale))}</p>
    </section>`;
  }
  const blocks = audit.results.map((r) => renderScenarioBlock(r, locale)).join("\n");
  return `<section class="section">
    <h2>${escapeHtml(t("pdf_scenario_results_title", locale))}</h2>
    ${blocks}
  </section>`;
}

function renderScenarioBlock(r: ScenarioRunResult, locale: Locale): string {
  const dimRows = r.scores
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.dimension)}</td><td>${s.score.toFixed(1)}</td></tr>`,
    )
    .join("");
  const issuesText =
    r.issues.length === 0
      ? `<p style="color:#555; font-size:10pt;">${escapeHtml(t("no_issues_raised", locale))}</p>`
      : r.issues
          .map(
            (i) =>
              `<div class="finding ${i.severity}" style="margin: 4pt 0;">
                <span class="severity-tag ${i.severity}">${escapeHtml(t(i.severity, locale))}</span>
                ${escapeHtml(i.description)}
                <div class="recommendation">→ ${escapeHtml(i.recommendation)}</div>
              </div>`,
          )
          .join("\n");
  // Status badge: use the localised full-name form for screen readers /
  // PDF text search; the underlying CSS class still carries the canonical
  // english key so styling stays consistent.
  const statusKey =
    r.status === "pass"
      ? "status_pass_full"
      : r.status === "pass_with_issues"
        ? "status_warn_full"
        : "status_fail_full";
  return `<div class="scenario-block">
    <div class="scenario-hdr">
      <h3>${escapeHtml(r.scenario_name)} <span style="color:#555; font-weight: 400;">×</span> ${escapeHtml(r.persona_display_name)}</h3>
      <span class="status ${r.status}">${escapeHtml(t(statusKey as "status_pass_full" | "status_warn_full" | "status_fail_full", locale))}</span>
    </div>
    <div class="scenario-meta">${escapeHtml(t("score", locale))} ${r.overall_score.toFixed(1)} / 10  ·  ${escapeHtml(t("cost", locale))} $${r.cost_usd.toFixed(3)}  ·  ${(r.duration_ms / 1000).toFixed(1)} s  ·  ${r.steps.length} ${escapeHtml(t("steps", locale))}</div>
    ${dimRows ? `<table class="dim-table">${dimRows}</table>` : ""}
    ${issuesText}
  </div>`;
}

function methodologySection(
  audit: AuditRun,
  personas: string[],
  scenarios: string[],
  locale: Locale,
): string {
  return `<section class="section methodology">
    <h2>${escapeHtml(t("pdf_methodology_title", locale))}</h2>
    <p>${escapeHtml(t("pdf_methodology_intro", locale))}</p>

    <h3>${escapeHtml(t("pdf_personas_in_run", locale))} (${personas.length})</h3>
    <ul>
      ${personas.map((p) => `<li>${escapeHtml(p)}</li>`).join("\n      ")}
    </ul>

    <h3>${escapeHtml(t("pdf_scenarios_in_run", locale))} (${scenarios.length})</h3>
    <ul>
      ${scenarios.map((s) => `<li>${escapeHtml(s)}</li>`).join("\n      ")}
    </ul>

    <p class="disclaimer">
      ${escapeHtml(t("pdf_disclaimer", locale))} ${escapeHtml(t("pdf_run_id_archival", locale))}: <code>${escapeHtml(audit.run_id)}</code>.
    </p>
  </section>`;
}

// ─────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────

export function computeOverallScore(audit: AuditRun): number {
  if (audit.results.length === 0) return 0;
  const sum = audit.results.reduce((acc, r) => acc + r.overall_score, 0);
  return sum / audit.results.length;
}

export function colourForScore(score: number): string {
  // Green ≥ 8, amber 5–8, red < 5. Hex chosen to pass 4.5:1 contrast on
  // white. Tweak via opts.brandColor doesn't apply here — score colour
  // is a fixed health signal.
  if (score >= 8) return "#15803d"; // green-700
  if (score >= 5) return "#a16207"; // amber-700
  return "#b91c1c"; // red-700
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;

export function collectTopFindings(
  audit: AuditRun,
  cap: number,
): Array<Issue & { run: ScenarioRunResult }> {
  const all: Array<Issue & { run: ScenarioRunResult }> = [];
  for (const r of audit.results) {
    for (const issue of r.issues) {
      all.push({ ...issue, run: r });
    }
  }
  all.sort((a, b) => {
    const ai = SEVERITY_ORDER.indexOf(a.severity);
    const bi = SEVERITY_ORDER.indexOf(b.severity);
    return ai - bi;
  });
  return all.slice(0, cap);
}

function uniquePersonas(audit: AuditRun): string[] {
  const set = new Set<string>();
  for (const r of audit.results) set.add(r.persona_display_name);
  return [...set].sort();
}

function uniqueScenarios(audit: AuditRun): string[] {
  const set = new Set<string>();
  for (const r of audit.results) set.add(r.scenario_name);
  return [...set].sort();
}

function applyRedaction(audit: AuditRun): AuditRun {
  const patterns = audit.redact_patterns ?? [];
  return patterns.length > 0 ? redactDeep(audit, patterns) : audit;
}

/**
 * Escape a string for safe inclusion in HTML body or attribute. Same
 * five-character set used by reporter-spa (& < > " ').
 */
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
    }
    return c;
  });
}

/**
 * Whether reporter-pdf can run in this environment. Always true today;
 * reserved for future opts (e.g. node-pdfkit fallback).
 */
export function isPdfReportingSupported(): boolean {
  return fs.existsSync(path.resolve("node_modules/playwright"));
}

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
  const overall = computeOverallScore(audit);
  const scoreColor = colourForScore(overall);
  const topFindings = collectTopFindings(audit, maxTopFindings);
  const personasUsed = uniquePersonas(audit);
  const scenariosUsed = uniqueScenarios(audit);

  return [
    PDF_HEADER_OPEN,
    `<style>${pdfStylesheet(brand)}</style>`,
    PDF_HEADER_CLOSE,
    coverSection(audit, overall, scoreColor, opts.logoDataUri),
    findingsSection(topFindings, brand),
    scenarioSections(audit),
    methodologySection(audit, personasUsed, scenariosUsed),
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
    await page.pdf({
      path: filePath,
      format: "A4",
      printBackground: true,
      margin: { top: "1.5cm", right: "1.5cm", bottom: "1.8cm", left: "1.5cm" },
      displayHeaderFooter: true,
      headerTemplate: pdfHeaderTemplate(audit),
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

function pdfHeaderTemplate(audit: AuditRun): string {
  // Chromium's headerTemplate runs in print context; it can use only a
  // subset of CSS (no external resources). Inline minimal styling.
  return `<div style="font-size: 8pt; color: #888; padding: 0 1.5cm; width: 100%; display: flex; justify-content: space-between;">
    <span>${escapeHtml(audit.project_name)} — Audit Report</span>
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
    <h1>AI Browser Audit Report</h1>
    <div class="meta">
      <div><strong>Project:</strong> ${escapeHtml(audit.project_name)}</div>
      <div><strong>URL:</strong> ${escapeHtml(audit.base_url)}</div>
      <div><strong>Run date:</strong> ${escapeHtml(dateStr)}</div>
      <div><strong>Duration:</strong> ${durationStr}</div>
    </div>

    <div class="score-block">
      <div class="score-number" style="color: ${scoreColor};">${overall.toFixed(1)}</div>
      <div class="score-label">Overall score · 0–10</div>
    </div>

    <div class="summary-card">
      <table>
        <tr><td>Total scenarios run</td><td>${audit.summary.total}</td></tr>
        <tr><td>Pass</td><td>${audit.summary.pass}</td></tr>
        <tr><td>Pass with issues</td><td>${audit.summary.pass_with_issues}</td></tr>
        <tr><td>Fail</td><td>${audit.summary.fail}</td></tr>
        <tr><td>Critical issues</td><td>${audit.summary.critical_issues}</td></tr>
        <tr><td>Total issues</td><td>${audit.summary.total_issues}</td></tr>
        <tr><td>Total cost</td><td>${cost}</td></tr>
      </table>
    </div>
  </section>`;
}

function findingsSection(findings: Array<Issue & { run: ScenarioRunResult }>, brand: string): string {
  if (findings.length === 0) {
    return `<section class="section findings">
      <h2>Critical findings</h2>
      <p>No issues found in this run. The audit completed cleanly across all scenario × persona combinations.</p>
    </section>`;
  }
  const items = findings
    .map(
      (f) => `<div class="finding ${f.severity}">
        <span class="severity-tag ${f.severity}">${f.severity}</span>
        <strong>${escapeHtml(f.run.scenario_name)}</strong>
        <span style="color:#555"> · ${escapeHtml(f.run.persona_display_name)}</span>
        <p style="margin-top: 4pt;">${escapeHtml(f.description)}</p>
        <div class="recommendation">Recommendation: ${escapeHtml(f.recommendation)}</div>
      </div>`,
    )
    .join("\n");
  return `<section class="section findings">
    <h2>Top findings</h2>
    <p style="color: #555; font-size: 11pt;">Sorted by severity. Critical / high issues are blockers; medium / low are improvement opportunities.</p>
    ${items}
  </section>`;
}

function scenarioSections(audit: AuditRun): string {
  if (audit.results.length === 0) {
    return `<section class="section">
      <h2>Scenario results</h2>
      <p>No scenarios ran in this audit.</p>
    </section>`;
  }
  const blocks = audit.results
    .map((r) => renderScenarioBlock(r))
    .join("\n");
  return `<section class="section">
    <h2>Scenario results</h2>
    ${blocks}
  </section>`;
}

function renderScenarioBlock(r: ScenarioRunResult): string {
  const dimRows = r.scores
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.dimension)}</td><td>${s.score.toFixed(1)}</td></tr>`,
    )
    .join("");
  const issuesText =
    r.issues.length === 0
      ? `<p style="color:#555; font-size:10pt;">No issues raised.</p>`
      : r.issues
          .map(
            (i) =>
              `<div class="finding ${i.severity}" style="margin: 4pt 0;">
                <span class="severity-tag ${i.severity}">${i.severity}</span>
                ${escapeHtml(i.description)}
                <div class="recommendation">→ ${escapeHtml(i.recommendation)}</div>
              </div>`,
          )
          .join("\n");
  return `<div class="scenario-block">
    <div class="scenario-hdr">
      <h3>${escapeHtml(r.scenario_name)} <span style="color:#555; font-weight: 400;">×</span> ${escapeHtml(r.persona_display_name)}</h3>
      <span class="status ${r.status}">${r.status.replace(/_/g, " ")}</span>
    </div>
    <div class="scenario-meta">Score ${r.overall_score.toFixed(1)} / 10  ·  Cost $${r.cost_usd.toFixed(3)}  ·  ${(r.duration_ms / 1000).toFixed(1)} s  ·  ${r.steps.length} steps</div>
    ${dimRows ? `<table class="dim-table">${dimRows}</table>` : ""}
    ${issuesText}
  </div>`;
}

function methodologySection(
  audit: AuditRun,
  personas: string[],
  scenarios: string[],
): string {
  return `<section class="section methodology">
    <h2>Methodology</h2>
    <p>The AI Browser Auditor launches real Chromium browser sessions configured with persona-specific device fingerprints and runs scripted user journeys end-to-end. After each run, screenshots and DOM data are scored by Anthropic's Claude vision model against a defined rubric.</p>

    <h3>Personas in this run (${personas.length})</h3>
    <ul>
      ${personas.map((p) => `<li>${escapeHtml(p)}</li>`).join("\n      ")}
    </ul>

    <h3>Scenarios in this run (${scenarios.length})</h3>
    <ul>
      ${scenarios.map((s) => `<li>${escapeHtml(s)}</li>`).join("\n      ")}
    </ul>

    <p class="disclaimer">
      AI scoring is calibrated against a labelled fixture set and trends to within ±1 point of human review on a 10-point scale. Scores reflect what an experienced reviewer would see in a single user session — they do not guarantee absence of regressions in untested flows. For full evidence (screenshots, video, console logs), open <code>audit-explorer.html</code> in the same run directory. Run id: <code>${escapeHtml(audit.run_id)}</code>.
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

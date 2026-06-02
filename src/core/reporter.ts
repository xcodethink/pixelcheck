import * as fs from "node:fs";
import * as path from "node:path";
import type { AuditRun, ScenarioRunResult, Issue } from "./types.js";
import { redactDeep, buildRedactPatterns } from "./secrets.js";
import { loadHistory, type HistoryEntry } from "./history.js";

/**
 * Write JSON report (machine-readable, primary source of truth).
 *
 * Applies redaction to all string values using the patterns attached to
 * the audit object by the runner.
 */
export function writeJsonReport(audit: AuditRun, runDir: string): string {
  const filePath = path.join(runDir, "audit.json");
  // Always redact, and always seed from buildRedactPatterns so known env
  // secrets (ANTHROPIC_API_KEY, SCAMLENS_ADMIN_COOKIE, STRIPE_TEST_*, …) are
  // stripped even when the runner attached no patterns — a report on disk must
  // never carry a secret that reached the audit tree. (Audit 2026-06-02 C2.)
  const patterns = buildRedactPatterns(audit.redact_patterns ?? []);
  const safe = redactDeep(audit, patterns);
  fs.writeFileSync(filePath, JSON.stringify(safe, null, 2));
  return filePath;
}

/**
 * Write a terminal-friendly markdown summary.
 */
/**
 * Escape a string for safe inclusion in a Markdown table cell / inline
 * context. `|` ends a table column, a backtick opens a code span, and a
 * newline ends the row — all of which corrupt the rendered report when the
 * value is audit-target-controlled (issue text, dimension/scenario names a
 * page can influence). (Audit 2026-06-02 H9.)
 */
export function escapeMdCell(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/\r?\n/g, " ");
}

export function writeMarkdownSummary(
  inputAudit: AuditRun,
  runDir: string,
): string {
  const filePath = path.join(runDir, "summary.md");
  const patterns = buildRedactPatterns(inputAudit.redact_patterns ?? []);
  const audit = redactDeep(inputAudit, patterns);
  const lines: string[] = [];
  lines.push(`# Audit Run: ${audit.run_id}`);
  lines.push("");
  lines.push(`- Project: ${audit.project_name}`);
  lines.push(`- Base URL: ${audit.base_url}`);
  lines.push(`- Started: ${audit.started_at}`);
  lines.push(`- Duration: ${(audit.duration_ms / 1000).toFixed(1)}s`);
  lines.push(
    `- Total cost: $${audit.summary.total_cost_usd.toFixed(3)}`,
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Count |`);
  lines.push(`|---|---|`);
  lines.push(`| Total | ${audit.summary.total} |`);
  lines.push(`| Pass | ${audit.summary.pass} |`);
  lines.push(`| Pass with issues | ${audit.summary.pass_with_issues} |`);
  lines.push(`| Fail | ${audit.summary.fail} |`);
  lines.push(`| Total issues | ${audit.summary.total_issues} |`);
  lines.push(`| Critical issues | ${audit.summary.critical_issues} |`);
  lines.push("");
  lines.push("## Results");
  lines.push("");
  for (const r of audit.results) {
    lines.push(
      `### [${r.status.toUpperCase()}] ${escapeMdCell(r.scenario_name)} — ${escapeMdCell(r.persona_display_name)}`,
    );
    lines.push("");
    lines.push(`- Score: **${r.overall_score.toFixed(1)} / 10**`);
    lines.push(`- Cost: $${r.cost_usd.toFixed(3)}`);
    lines.push(`- Duration: ${(r.duration_ms / 1000).toFixed(1)}s`);
    if (r.scores.length > 0) {
      lines.push("");
      lines.push("| Dimension | Score |");
      lines.push("|---|---|");
      for (const s of r.scores) {
        lines.push(`| ${escapeMdCell(s.dimension)} | ${s.score.toFixed(1)} |`);
      }
    }
    if (r.issues.length > 0) {
      lines.push("");
      lines.push("**Issues:**");
      for (const issue of r.issues) {
        lines.push(
          `- [${issue.severity.toUpperCase()}] ${escapeMdCell(issue.description)}`,
        );
        lines.push(`  - Recommendation: ${escapeMdCell(issue.recommendation)}`);
      }
    }
    lines.push("");
  }
  fs.writeFileSync(filePath, lines.join("\n"));
  return filePath;
}

/**
 * Write the rich HTML report (dark theme, scenario sections, embedded video).
 * If reportsDir is provided, trend data is loaded from SQLite and embedded.
 */
export function writeHtmlReport(
  audit: AuditRun,
  runDir: string,
  reportsDir?: string,
): string {
  const filePath = path.join(runDir, "audit.html");
  const patterns = buildRedactPatterns(audit.redact_patterns ?? []);
  const safe = redactDeep(audit, patterns);
  const history = reportsDir
    ? loadHistory(reportsDir, { limit: 20, project: audit.project_name })
    : [];
  const html = renderHtml(safe, runDir, history);
  fs.writeFileSync(filePath, html);
  return filePath;
}

function renderHtml(
  audit: AuditRun,
  runDir: string,
  history: HistoryEntry[] = [],
): string {
  const sections = audit.results.map((r) => renderUnit(r, runDir)).join("\n");
  const trendSection = history.length >= 2 ? renderTrendSection(history) : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(audit.project_name)} — Audit ${escapeHtml(audit.run_id)}</title>
<style>
  :root {
    --bg: #0a0e14;
    --bg-card: #11161d;
    --bg-elevated: #1a212b;
    --fg: #c9d1d9;
    --fg-dim: #8b949e;
    --border: #30363d;
    --accent: #58a6ff;
    --pass: #3fb950;
    --warn: #d29922;
    --fail: #f85149;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--fg);
    line-height: 1.55;
  }
  header {
    padding: 24px 32px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-card);
  }
  header h1 {
    margin: 0 0 6px;
    font-size: 22px;
    font-weight: 600;
  }
  header .meta {
    color: var(--fg-dim);
    font-size: 13px;
  }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px 32px; }
  .summary {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 12px;
    margin-bottom: 32px;
  }
  .summary .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    text-align: center;
  }
  .summary .card .num {
    font-size: 28px;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .summary .card .label {
    color: var(--fg-dim);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .unit {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px 24px;
    margin-bottom: 20px;
  }
  .unit h2 {
    margin: 0 0 8px;
    font-size: 17px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .badge-pass { background: rgba(63, 185, 80, 0.15); color: var(--pass); }
  .badge-warn { background: rgba(210, 153, 34, 0.15); color: var(--warn); }
  .badge-fail { background: rgba(248, 81, 73, 0.15); color: var(--fail); }
  .meta-row {
    color: var(--fg-dim);
    font-size: 12px;
    margin-bottom: 16px;
  }
  .scores { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  .score-chip {
    background: var(--bg-elevated);
    padding: 6px 12px;
    border-radius: 4px;
    font-size: 12px;
  }
  .score-chip .v { font-weight: 600; color: var(--accent); }
  .issues { margin-top: 12px; }
  .issue {
    padding: 10px 12px;
    border-left: 3px solid var(--fail);
    background: var(--bg-elevated);
    border-radius: 0 4px 4px 0;
    margin-bottom: 8px;
    font-size: 13px;
  }
  .issue.high { border-color: var(--warn); }
  .issue.medium { border-color: var(--accent); }
  .issue.low { border-color: var(--fg-dim); }
  .issue .rec {
    color: var(--fg-dim);
    margin-top: 4px;
    font-size: 12px;
  }
  .steps {
    margin-top: 16px;
    background: var(--bg-elevated);
    border-radius: 4px;
    padding: 10px 14px;
  }
  .steps details summary {
    cursor: pointer;
    color: var(--fg-dim);
    font-size: 12px;
    user-select: none;
  }
  .step-list { list-style: none; padding: 0; margin: 10px 0 0; }
  .step-list li {
    padding: 4px 0;
    font-size: 12px;
    font-family: 'SF Mono', Consolas, monospace;
    border-bottom: 1px solid var(--border);
  }
  .step-list li:last-child { border-bottom: none; }
  .step-list li .st { display: inline-block; width: 50px; }
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-top: 16px; }
  .gallery img { width: 100%; border: 1px solid var(--border); border-radius: 4px; cursor: pointer; }
  a { color: var(--accent); text-decoration: none; }
  .trend-section {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px 24px;
    margin-bottom: 24px;
  }
  .trend-section h2 { margin: 0 0 16px; font-size: 17px; }
  .trend-chart {
    width: 100%;
    height: 200px;
    position: relative;
    overflow: hidden;
  }
  .trend-chart canvas { width: 100% !important; height: 100% !important; }
  .trend-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 16px; }
  .trend-table th, .trend-table td {
    padding: 6px 10px;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  .trend-table th { color: var(--fg-dim); text-transform: uppercase; letter-spacing: 0.05em; font-size: 11px; }
  .trend-delta-up { color: var(--pass); }
  .trend-delta-down { color: var(--fail); }
  .trend-delta-flat { color: var(--fg-dim); }
  .reliability-stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    margin-top: 16px;
  }
  .reliability-stats .card {
    background: var(--bg-elevated);
    border-radius: 4px;
    padding: 12px;
    text-align: center;
  }
  .reliability-stats .card .num { font-size: 20px; font-weight: 600; }
  .reliability-stats .card .label { font-size: 11px; color: var(--fg-dim); }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(audit.project_name)} — AI Browser Audit</h1>
  <div class="meta">
    Run: <code>${escapeHtml(audit.run_id)}</code> &middot;
    ${escapeHtml(audit.base_url)} &middot;
    ${escapeHtml(audit.started_at)} &middot;
    ${(audit.duration_ms / 1000).toFixed(1)}s &middot;
    Cost: $${audit.summary.total_cost_usd.toFixed(3)}
  </div>
</header>
<div class="container">
  <div class="summary">
    <div class="card"><div class="num">${audit.summary.total}</div><div class="label">Total</div></div>
    <div class="card"><div class="num" style="color:var(--pass)">${audit.summary.pass}</div><div class="label">Pass</div></div>
    <div class="card"><div class="num" style="color:var(--warn)">${audit.summary.pass_with_issues}</div><div class="label">Warn</div></div>
    <div class="card"><div class="num" style="color:var(--fail)">${audit.summary.fail}</div><div class="label">Fail</div></div>
    <div class="card"><div class="num">${audit.summary.total_issues}</div><div class="label">Issues</div></div>
    <div class="card"><div class="num" style="color:var(--fail)">${audit.summary.critical_issues}</div><div class="label">Critical</div></div>
  </div>
  ${trendSection}
  ${sections}
</div>
</body>
</html>`;
}

function renderUnit(r: ScenarioRunResult, runDir: string): string {
  const badgeClass =
    r.status === "pass"
      ? "badge-pass"
      : r.status === "pass_with_issues"
        ? "badge-warn"
        : "badge-fail";
  const scores = r.scores
    .map(
      (s) =>
        `<div class="score-chip">${escapeHtml(s.dimension)}: <span class="v">${s.score.toFixed(1)}</span></div>`,
    )
    .join("");
  const issues = r.issues
    .map(
      (i: Issue) => `<div class="issue ${i.severity}">
        <strong>[${i.severity.toUpperCase()}]</strong> ${escapeHtml(i.description)}
        <div class="rec">→ ${escapeHtml(i.recommendation)}</div>
      </div>`,
    )
    .join("");
  const steps = r.steps
    .map(
      (s) =>
        `<li><span class="st">${s.status.toUpperCase()}</span> ${escapeHtml(s.step_id)} (${s.step_type}, ${s.duration_ms}ms${s.retries_used ? `, retries=${s.retries_used}` : ""}${s.execution_method && s.execution_method !== "stagehand" ? `, via=${s.execution_method}` : ""})${s.error ? ` — ${escapeHtml(s.error)}` : ""}</li>`,
    )
    .join("");
  const screenshots = r.steps
    .filter((s) => s.screenshot)
    .map((s) => {
      // Always emit forward-slash URLs in HTML — `path.relative` returns
      // platform-native separators (backslash on Windows) which produce
      // both broken hyperlinks AND test asserts that mismatch by character
      // (e.g. expected `shots/01.png` vs actual `shots\01.png`).
      const rel = path.relative(runDir, s.screenshot!).split(path.sep).join("/");
      return `<a href="${escapeHtml(rel)}" target="_blank"><img src="${escapeHtml(rel)}" alt="${escapeHtml(s.step_id)}" loading="lazy" /></a>`;
    })
    .join("");

  return `<div class="unit">
    <h2><span class="badge ${badgeClass}">${r.status}</span> ${escapeHtml(r.scenario_name)}</h2>
    <div class="meta-row">
      Persona: <strong>${escapeHtml(r.persona_display_name)}</strong> &middot;
      Score: <strong>${r.overall_score.toFixed(1)}/10</strong> &middot;
      Duration: ${(r.duration_ms / 1000).toFixed(1)}s &middot;
      Cost: $${r.cost_usd.toFixed(3)} &middot;
      Fingerprint: ${escapeHtml(r.fingerprint_id)}
    </div>
    ${scores ? `<div class="scores">${scores}</div>` : ""}
    ${r.agent_summary ? renderAgentSummary(r.agent_summary) : ""}
    ${issues ? `<div class="issues">${issues}</div>` : ""}
    ${screenshots ? `<div class="gallery">${screenshots}</div>` : ""}
    <div class="steps"><details><summary>Step trace (${r.steps.length} steps)</summary><ul class="step-list">${steps}</ul></details></div>
  </div>`;
}

function renderAgentSummary(summary: NonNullable<ScenarioRunResult["agent_summary"]>): string {
  const convergenceColor =
    summary.convergence_reason === "goal_met" ? "var(--pass)" :
    summary.convergence_reason === "budget_exceeded" || summary.convergence_reason === "max_actions" ? "var(--warn)" :
    "var(--fail)";

  return `<div class="agent-summary" style="margin:12px 0;padding:10px 14px;background:#1a1f2e;border-radius:6px;border-left:3px solid ${convergenceColor}">
    <div style="font-weight:600;margin-bottom:6px">Agent Summary (Autonomous Mode)</div>
    <div style="display:flex;gap:20px;font-size:13px;color:#8b949e">
      <span>Actions: <strong style="color:#c9d1d9">${summary.total_actions}</strong></span>
      <span>Plans: <strong style="color:#c9d1d9">${summary.plan_count}</strong></span>
      <span>Convergence: <strong style="color:${convergenceColor}">${summary.convergence_reason}</strong></span>
    </div>
    ${summary.criteria_met.length > 0 ? `<div style="margin-top:6px;font-size:12px;color:var(--pass)">Criteria met: ${summary.criteria_met.map(c => escapeHtml(c)).join(", ")}</div>` : ""}
    ${summary.criteria_missed.length > 0 ? `<div style="margin-top:4px;font-size:12px;color:var(--warn)">Criteria missed: ${summary.criteria_missed.map(c => escapeHtml(c)).join(", ")}</div>` : ""}
  </div>`;
}

/**
 * Render the trend section with an inline SVG sparkline chart and history table.
 * Uses pure SVG (no external JS dependencies) so the HTML report stays self-contained.
 */
function renderTrendSection(history: HistoryEntry[]): string {
  // Sort oldest first for chart
  const sorted = [...history].reverse();

  // Build SVG sparkline for overall score
  const chartWidth = 600;
  const chartHeight = 150;
  const padding = 30;
  const plotW = chartWidth - padding * 2;
  const plotH = chartHeight - padding * 2;
  const n = sorted.length;
  const maxScore = 10;
  const minScore = 0;

  const points = sorted.map((entry, i) => {
    const x = padding + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
    const y =
      padding +
      plotH -
      ((entry.overallScore - minScore) / (maxScore - minScore)) * plotH;
    return { x, y, entry };
  });

  const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  // Gradient fill below the line
  const fillPoints = [
    `${points[0]?.x.toFixed(1) ?? padding},${padding + plotH}`,
    ...points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`),
    `${points[points.length - 1]?.x.toFixed(1) ?? padding + plotW},${padding + plotH}`,
  ].join(" ");

  // Grid lines at score 2, 4, 6, 8
  const gridLines = [2, 4, 6, 8].map((score) => {
    const y = padding + plotH - ((score - minScore) / (maxScore - minScore)) * plotH;
    return `<line x1="${padding}" y1="${y.toFixed(1)}" x2="${padding + plotW}" y2="${y.toFixed(1)}" stroke="#30363d" stroke-width="0.5"/>
    <text x="${padding - 5}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#8b949e" font-size="10">${score}</text>`;
  }).join("\n");

  // Data point dots
  const dots = points.map(
    (p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#58a6ff" stroke="#0a0e14" stroke-width="1.5"/>`,
  ).join("\n");

  const svg = `<svg viewBox="0 0 ${chartWidth} ${chartHeight}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-height:200px;">
    <defs>
      <linearGradient id="fill-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#58a6ff" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="#58a6ff" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    ${gridLines}
    <polygon points="${fillPoints}" fill="url(#fill-grad)"/>
    <polyline points="${polyline}" fill="none" stroke="#58a6ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
  </svg>`;

  // History table (most recent first)
  const tableRows = history
    .slice(0, 10)
    .map((entry) => {
      const date = entry.startedAt.split("T")[0] ?? entry.startedAt.slice(0, 10);
      const score = entry.overallScore.toFixed(1);
      const passRate =
        entry.totalUnits > 0
          ? ((entry.passCount / entry.totalUnits) * 100).toFixed(0)
          : "0";
      return `<tr>
        <td>${escapeHtml(date)}</td>
        <td>${escapeHtml(entry.tag ?? "-")}</td>
        <td style="color:var(--accent);font-weight:600">${score}</td>
        <td>${passRate}%</td>
        <td>${entry.totalIssues} (${entry.criticalIssues} critical)</td>
        <td>$${entry.totalCostUsd.toFixed(3)}</td>
        <td>${(entry.durationMs / 1000).toFixed(0)}s</td>
      </tr>`;
    })
    .join("\n");

  // Reliability stack stats from current run (if execution_method data available)
  const reliabilitySection = renderReliabilityStats(history[0]);

  return `<div class="trend-section">
    <h2>Quality Trend (Last ${sorted.length} Runs)</h2>
    <div class="trend-chart">${svg}</div>
    ${reliabilitySection}
    <table class="trend-table">
      <thead>
        <tr><th>Date</th><th>Tag</th><th>Score</th><th>Pass Rate</th><th>Issues</th><th>Cost</th><th>Duration</th></tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
  </div>`;
}

function renderReliabilityStats(latest?: HistoryEntry): string {
  if (!latest) return "";

  return `<div class="reliability-stats">
    <div class="card">
      <div class="num" style="color:var(--pass)">${latest.passCount}</div>
      <div class="label">Passed</div>
    </div>
    <div class="card">
      <div class="num" style="color:var(--warn)">${latest.warnCount}</div>
      <div class="label">Warnings</div>
    </div>
    <div class="card">
      <div class="num" style="color:var(--fail)">${latest.failCount}</div>
      <div class="label">Failed</div>
    </div>
    <div class="card">
      <div class="num" style="color:var(--accent)">${latest.overallScore.toFixed(1)}</div>
      <div class="label">Overall Score</div>
    </div>
  </div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

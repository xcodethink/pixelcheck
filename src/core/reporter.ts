import * as fs from "node:fs";
import * as path from "node:path";
import type { AuditRun, ScenarioRunResult, Issue } from "./types.js";
import { redactDeep } from "./secrets.js";

/**
 * Write JSON report (machine-readable, primary source of truth).
 *
 * Applies redaction to all string values using the patterns attached to
 * the audit object by the runner.
 */
export function writeJsonReport(audit: AuditRun, runDir: string): string {
  const filePath = path.join(runDir, "audit.json");
  const patterns = audit.redact_patterns ?? [];
  const safe = patterns.length > 0 ? redactDeep(audit, patterns) : audit;
  fs.writeFileSync(filePath, JSON.stringify(safe, null, 2));
  return filePath;
}

/**
 * Write a terminal-friendly markdown summary.
 */
export function writeMarkdownSummary(
  inputAudit: AuditRun,
  runDir: string,
): string {
  const filePath = path.join(runDir, "summary.md");
  const patterns = inputAudit.redact_patterns ?? [];
  const audit = patterns.length > 0 ? redactDeep(inputAudit, patterns) : inputAudit;
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
      `### [${r.status.toUpperCase()}] ${r.scenario_name} — ${r.persona_display_name}`,
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
        lines.push(`| ${s.dimension} | ${s.score.toFixed(1)} |`);
      }
    }
    if (r.issues.length > 0) {
      lines.push("");
      lines.push("**Issues:**");
      for (const issue of r.issues) {
        lines.push(
          `- [${issue.severity.toUpperCase()}] ${issue.description}`,
        );
        lines.push(`  - Recommendation: ${issue.recommendation}`);
      }
    }
    lines.push("");
  }
  fs.writeFileSync(filePath, lines.join("\n"));
  return filePath;
}

/**
 * Write the rich HTML report (dark theme, scenario sections, embedded video).
 */
export function writeHtmlReport(audit: AuditRun, runDir: string): string {
  const filePath = path.join(runDir, "audit.html");
  const patterns = audit.redact_patterns ?? [];
  const safe = patterns.length > 0 ? redactDeep(audit, patterns) : audit;
  const html = renderHtml(safe, runDir);
  fs.writeFileSync(filePath, html);
  return filePath;
}

function renderHtml(audit: AuditRun, runDir: string): string {
  const sections = audit.results.map((r) => renderUnit(r, runDir)).join("\n");
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
        `<li><span class="st">${s.status.toUpperCase()}</span> ${escapeHtml(s.step_id)} (${s.step_type}, ${s.duration_ms}ms${s.retries_used ? `, retries=${s.retries_used}` : ""})${s.error ? ` — ${escapeHtml(s.error)}` : ""}</li>`,
    )
    .join("");
  const screenshots = r.steps
    .filter((s) => s.screenshot)
    .map((s) => {
      const rel = path.relative(runDir, s.screenshot!);
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
    ${issues ? `<div class="issues">${issues}</div>` : ""}
    ${screenshots ? `<div class="gallery">${screenshots}</div>` : ""}
    <div class="steps"><details><summary>Step trace (${r.steps.length} steps)</summary><ul class="step-list">${steps}</ul></details></div>
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

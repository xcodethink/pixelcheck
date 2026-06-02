/**
 * Report Explorer — interactive single-page HTML report.
 *
 * Augments the existing static audit.html with a rich, filterable view:
 *   - Filter bar: persona, scenario, status, dimension, severity
 *   - Per-unit cards with expandable step details
 *   - Step timing "gantt" bar (duration distribution per unit)
 *   - Issue browser grouped by dimension/severity
 *   - Cost breakdown (per unit + overall)
 *
 * Emits audit-explorer.html alongside audit.html. The full audit object is
 * inlined as JSON so the file is self-contained (no HTTP fetches required).
 * No build step; vanilla JS.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AuditRun } from "./types.js";
import { redactDeep } from "./secrets.js";
import {
  SPA_I18N,
  SPA_DEFAULT_LOCALE,
  type SpaLocale,
} from "./reporter-spa-i18n.js";

export function writeSpaReport(audit: AuditRun, runDir: string): string {
  const filePath = path.join(runDir, "audit-explorer.html");
  const patterns = audit.redact_patterns ?? [];
  const safe = patterns.length > 0 ? redactDeep(audit, patterns) : audit;
  const html = renderSpa(safe);
  fs.writeFileSync(filePath, html);
  return filePath;
}

function renderSpa(audit: AuditRun): string {
  // IMPORTANT: embed JSON using a script tag with type=application/json to
  // avoid HTML/JS escape hazards. The SPA reads from #__AUDIT_DATA__.
  // Escape both < and > so an attacker-controlled string value can never
  // prematurely close the wrapping <script> tag.
  const jsonSafe = JSON.stringify(audit)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E");
  const i18nJson = JSON.stringify(SPA_I18N)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E");
  const defaultLocale: SpaLocale = SPA_DEFAULT_LOCALE;
  return `<!doctype html>
<html lang="${defaultLocale}" data-default-lang="${defaultLocale}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Audit Explorer — ${escapeHtml(audit.project_name)} · ${escapeHtml(audit.run_id)}</title>
<style>
  :root {
    --bg: #0a0e14; --bg-card: #11161d; --bg-el: #1a212b;
    --fg: #c9d1d9; --fg-dim: #8b949e; --border: #30363d;
    --accent: #58a6ff; --pass: #3fb950; --warn: #d29922; --fail: #f85149;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; line-height: 1.5; }
  header { padding: 14px 24px; background: var(--bg-card); border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 14px; position: sticky; top: 0; z-index: 10; }
  header h1 { margin: 0; font-size: 15px; font-weight: 600; }
  header .meta { color: var(--fg-dim); font-size: 12px; }
  .container { max-width: 1400px; margin: 0 auto; padding: 16px 24px; }
  .summary { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin-bottom: 14px; }
  .summary .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; padding: 10px; }
  .summary .label { color: var(--fg-dim); font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
  .summary .value { font-size: 20px; font-weight: 600; }
  .value.pass { color: var(--pass); } .value.fail { color: var(--fail); } .value.warn { color: var(--warn); }

  .filter-bar {
    display: flex; gap: 10px; padding: 10px; margin-bottom: 14px;
    background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px;
    flex-wrap: wrap; align-items: center;
  }
  .filter-bar label { font-size: 11px; color: var(--fg-dim); text-transform: uppercase; letter-spacing: 0.5px; }
  .filter-bar select, .filter-bar input {
    background: var(--bg-el); border: 1px solid var(--border); color: var(--fg);
    padding: 4px 8px; border-radius: 4px; font-size: 12px; min-width: 120px;
  }
  .filter-bar .count { margin-left: auto; font-size: 12px; color: var(--fg-dim); }
  .filter-bar button {
    background: transparent; border: 1px solid var(--border); color: var(--fg);
    padding: 4px 10px; border-radius: 4px; font-size: 12px; cursor: pointer;
  }
  .filter-bar button:hover { background: var(--bg-el); }

  .unit {
    background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;
    padding: 14px; margin-bottom: 10px;
  }
  .unit-hdr { display: flex; align-items: center; gap: 10px; cursor: pointer; }
  .unit-hdr h3 { margin: 0; font-size: 14px; flex: 1; }
  .status-badge {
    padding: 2px 9px; border-radius: 10px; font-size: 10px; font-weight: 600;
    text-transform: uppercase;
  }
  .status-pass { background: #0e3a16; color: var(--pass); }
  .status-pass_with_issues { background: #4d2d00; color: var(--warn); }
  /* Darker bg so #f85149 text clears WCAG AA: the prior badge was 3.86:1; this is ~5:1. */
  .status-fail { background: #3a1000; color: var(--fail); }
  .score-pill { font-size: 11px; color: var(--fg-dim); font-weight: 600; }

  .unit-body { margin-top: 10px; display: none; }
  .unit.expanded .unit-body { display: block; }
  .unit-body h4 { font-size: 11px; color: var(--fg-dim); text-transform: uppercase;
    letter-spacing: 0.5px; margin: 14px 0 6px 0; }

  .dims { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 6px; }
  .dim { background: var(--bg-el); padding: 6px 8px; border-radius: 4px; font-size: 11px; }
  .dim .name { color: var(--fg-dim); }
  .dim .score { float: right; font-weight: 600; }

  .steps-table { width: 100%; border-collapse: collapse; font-size: 11px; }
  .steps-table th, .steps-table td { padding: 4px 8px; text-align: left; border-bottom: 1px solid var(--border); }
  .steps-table th { color: var(--fg-dim); font-weight: 500; font-size: 10px; text-transform: uppercase; }
  .steps-table .bar-cell { width: 180px; }
  .bar { height: 6px; background: var(--bg-el); border-radius: 3px; overflow: hidden; }
  .bar-fill { height: 100%; background: var(--accent); }
  .bar-fill.fail { background: var(--fail); } .bar-fill.warn { background: var(--warn); }
  .bar-fill.skip { background: var(--fg-dim); }

  .issues { }
  .issue {
    border-left: 3px solid var(--border); padding: 8px 10px; margin-bottom: 6px;
    background: var(--bg-el); border-radius: 0 4px 4px 0; font-size: 12px;
  }
  .issue.critical { border-left-color: var(--fail); }
  .issue.high { border-left-color: var(--fail); }
  .issue.medium { border-left-color: var(--warn); }
  .issue.low { border-left-color: var(--fg-dim); }
  .issue .sev { font-size: 10px; font-weight: 600; text-transform: uppercase; margin-right: 6px; }
  .issue .rec { color: var(--fg-dim); font-size: 11px; margin-top: 3px; }

  .empty { padding: 40px; text-align: center; color: var(--fg-dim); }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
</style>
</head>
<body>

<header>
  <h1 data-i18n="audit_explorer_title">Audit Explorer</h1>
  <span class="meta" id="metaProject"></span>
  <span class="meta" id="metaRun"></span>
</header>

<div class="container">
  <div class="summary" id="summary"></div>

  <div class="filter-bar">
    <label for="fPersona" data-i18n="filter_persona">persona</label>
    <select id="fPersona"><option value="" data-i18n="filter_all">all</option></select>
    <label for="fScenario" data-i18n="filter_scenario">scenario</label>
    <select id="fScenario"><option value="" data-i18n="filter_all">all</option></select>
    <label for="fStatus" data-i18n="filter_status">status</label>
    <select id="fStatus">
      <option value="" data-i18n="filter_all">all</option>
      <option value="pass">pass</option>
      <option value="pass_with_issues">warn</option>
      <option value="fail">fail</option>
    </select>
    <label for="fDimMax" data-i18n="filter_dim_max">dim ≤</label>
    <input id="fDimMax" type="number" min="0" max="10" step="0.5" placeholder="10" />
    <label for="fSeverity" data-i18n="filter_issue">issue</label>
    <select id="fSeverity">
      <option value="" data-i18n="filter_any">any</option>
      <option value="critical">critical</option>
      <option value="high">high</option>
      <option value="medium">medium</option>
      <option value="low">low</option>
    </select>
    <button onclick="expandAll()" data-i18n="btn_expand_all">Expand all</button>
    <button onclick="collapseAll()" data-i18n="btn_collapse">Collapse</button>
    <span class="count" id="count">0 of 0</span>
  </div>

  <div id="units"></div>
</div>

<script type="application/json" id="__AUDIT_DATA__">${jsonSafe}</script>
<script type="application/json" id="__AUDIT_I18N__">${i18nJson}</script>
<script>
const audit = JSON.parse(document.getElementById('__AUDIT_DATA__').textContent);
const I18N = JSON.parse(document.getElementById('__AUDIT_I18N__').textContent);
const DEFAULT_LOCALE = ${JSON.stringify(defaultLocale)};

// ── Locale resolution ──
// Priority: ?lang=... query string → navigator.language family fallback → default.
function resolveLocale() {
  const params = new URLSearchParams(window.location.search);
  const fromQs = params.get('lang') || params.get('locale');
  const candidate = fromQs || (typeof navigator !== 'undefined' ? navigator.language : '');
  if (!candidate) return DEFAULT_LOCALE;
  if (I18N[candidate]) return candidate;
  // Family fallback (zh-* → zh-CN, etc).
  const lower = String(candidate).toLowerCase();
  for (const k of Object.keys(I18N)) {
    if (k.toLowerCase() === lower) return k;
  }
  if (lower.startsWith('zh')) return I18N['zh-CN'] ? 'zh-CN' : DEFAULT_LOCALE;
  if (lower.startsWith('ja')) return I18N['ja'] ? 'ja' : DEFAULT_LOCALE;
  if (lower.startsWith('es')) return I18N['es'] ? 'es' : DEFAULT_LOCALE;
  if (lower.startsWith('de')) return I18N['de'] ? 'de' : DEFAULT_LOCALE;
  return DEFAULT_LOCALE;
}

const LOCALE = resolveLocale();
document.documentElement.lang = LOCALE;

function t(key, vars) {
  const dict = I18N[LOCALE] || I18N[DEFAULT_LOCALE];
  let s = (dict && dict[key]) || I18N[DEFAULT_LOCALE][key] || key;
  if (vars) {
    s = s.replace(/\\{(\\w+)\\}/g, function (_m, k) {
      return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : '{' + k + '}';
    });
  }
  return s;
}

function applyStaticI18n() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.getAttribute('data-i18n'));
  }
}

// ── Initial render ──
document.getElementById('metaProject').textContent = audit.project_name;
document.getElementById('metaRun').textContent = audit.run_id + ' · ' + new Date(audit.started_at).toLocaleString(LOCALE);

function renderSummary() {
  const s = audit.summary;
  const cards = [
    [t('summary_total'), s.total, ''],
    [t('summary_pass'), s.pass, 'pass'],
    [t('summary_warn'), s.pass_with_issues, 'warn'],
    [t('summary_fail'), s.fail, 'fail'],
    [t('summary_issues'), s.total_issues, ''],
    [t('summary_cost'), '$' + s.total_cost_usd.toFixed(3), ''],
  ];
  document.getElementById('summary').innerHTML = cards.map(([l,v,cls]) =>
    '<div class="card"><div class="label">' + esc(l) + '</div><div class="value ' + cls + '">' + esc(String(v)) + '</div></div>'
  ).join('');
}

function populateFilters() {
  const personas = [...new Set(audit.results.map(r => r.persona_display_name))].sort();
  const scenarios = [...new Set(audit.results.map(r => r.scenario_name))].sort();
  for (const p of personas) {
    const opt = document.createElement('option'); opt.value = p; opt.textContent = p;
    document.getElementById('fPersona').appendChild(opt);
  }
  for (const s of scenarios) {
    const opt = document.createElement('option'); opt.value = s; opt.textContent = s;
    document.getElementById('fScenario').appendChild(opt);
  }
}

function filteredResults() {
  const persona = document.getElementById('fPersona').value;
  const scenario = document.getElementById('fScenario').value;
  const status = document.getElementById('fStatus').value;
  const dimMaxRaw = document.getElementById('fDimMax').value;
  const dimMax = dimMaxRaw === '' ? null : Number(dimMaxRaw);
  const severity = document.getElementById('fSeverity').value;

  return audit.results.filter(r => {
    if (persona && r.persona_display_name !== persona) return false;
    if (scenario && r.scenario_name !== scenario) return false;
    if (status && r.status !== status) return false;
    if (dimMax !== null && !r.scores.some(s => s.score <= dimMax)) return false;
    if (severity && !r.issues.some(i => i.severity === severity)) return false;
    return true;
  });
}

function renderUnits() {
  const results = filteredResults();
  document.getElementById('count').textContent = t('count_format', { n: results.length, total: audit.results.length });
  const container = document.getElementById('units');
  if (results.length === 0) {
    container.innerHTML = '<div class="empty">' + esc(t('empty_no_results')) + '</div>';
    return;
  }

  // Compute global max step duration for bar scaling
  let globalMax = 1;
  for (const r of audit.results) for (const s of r.steps) globalMax = Math.max(globalMax, s.duration_ms || 0);

  container.innerHTML = results.map(r => renderUnit(r, globalMax)).join('');
  for (const hdr of container.querySelectorAll('.unit-hdr')) {
    hdr.onclick = () => hdr.parentElement.classList.toggle('expanded');
  }
}

function renderUnit(r, globalMax) {
  const status = r.status;
  const dims = r.scores.map(s => '<div class="dim"><span class="name">' + esc(s.dimension) +
    '</span><span class="score">' + s.score.toFixed(1) + '</span></div>').join('');
  const steps = r.steps.map(s => {
    const width = Math.max(4, Math.round(((s.duration_ms || 0) / globalMax) * 100));
    const cls = s.status === 'pass' ? '' : s.status;
    return '<tr><td>' + esc(s.step_id) + '</td>' +
      '<td>' + esc(s.step_type) + '</td>' +
      '<td class="status-' + s.status + '">' + s.status + '</td>' +
      '<td>' + (s.duration_ms || 0) + 'ms</td>' +
      '<td class="bar-cell"><div class="bar"><div class="bar-fill ' + cls + '" style="width:' + width + '%"></div></div></td>' +
      '<td>' + esc(s.execution_method || '') + '</td></tr>';
  }).join('');
  const issues = r.issues.map(i =>
    '<div class="issue ' + i.severity + '"><span class="sev">' + i.severity + '</span>' + esc(i.description) +
    (i.recommendation ? '<div class="rec">→ ' + esc(i.recommendation) + '</div>' : '') + '</div>'
  ).join('');

  const stepHeader = '<tr>' +
    '<th>' + esc(t('step_col_id')) + '</th>' +
    '<th>' + esc(t('step_col_type')) + '</th>' +
    '<th>' + esc(t('step_col_status')) + '</th>' +
    '<th>' + esc(t('step_col_duration')) + '</th>' +
    '<th>' + esc(t('step_col_timing')) + '</th>' +
    '<th>' + esc(t('step_col_via')) + '</th></tr>';

  return '<div class="unit">' +
    '<div class="unit-hdr">' +
      '<h3>' + esc(r.scenario_name) + ' × ' + esc(r.persona_display_name) + '</h3>' +
      '<span class="score-pill">' + r.overall_score.toFixed(1) + '/10 · $' + r.cost_usd.toFixed(3) + ' · ' + (r.duration_ms/1000).toFixed(1) + 's</span>' +
      '<span class="status-badge status-' + status + '">' + esc(status.replace(/_/g, ' ')) + '</span>' +
    '</div>' +
    '<div class="unit-body">' +
      (dims ? '<h4>' + esc(t('section_dimensions')) + '</h4><div class="dims">' + dims + '</div>' : '') +
      (steps ? '<h4>' + esc(t('section_steps_n', { n: r.steps.length })) + '</h4>' +
        '<table class="steps-table"><thead>' + stepHeader + '</thead>' +
        '<tbody>' + steps + '</tbody></table>' : '') +
      (issues ? '<h4>' + esc(t('section_issues_n', { n: r.issues.length })) + '</h4><div class="issues">' + issues + '</div>' : '') +
    '</div>' +
  '</div>';
}

function esc(s) { return String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function expandAll() { for (const u of document.querySelectorAll('.unit')) u.classList.add('expanded'); }
function collapseAll() { for (const u of document.querySelectorAll('.unit')) u.classList.remove('expanded'); }

// Re-render on any filter change
for (const id of ['fPersona','fScenario','fStatus','fDimMax','fSeverity']) {
  document.getElementById(id).addEventListener('input', renderUnits);
}

applyStaticI18n();
renderSummary();
populateFilters();
renderUnits();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
    }
    return c;
  });
}

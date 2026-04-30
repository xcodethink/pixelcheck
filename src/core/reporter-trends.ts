/**
 * Trends dashboard — long-running quality monitoring.
 *
 * Reads the project's audit history (SQLite at <reportsDir>/history.db)
 * and renders a standalone HTML dashboard answering: "Is our UX
 * trending up or down?"
 *
 * Five charts (inline SVG — no external deps):
 *   1. Overall score over time (line)
 *   2. Pass / Warn / Fail breakdown per run (stacked bars)
 *   3. Issues over time, critical highlighted (line)
 *   4. Cost over time (line)
 *   5. Per-dimension score trends (multi-line)
 *
 * Plus summary cards (latest score, 7-day mean, vs-first-run delta) and
 * a recent-runs table for navigation.
 *
 * Output: <out>/trends.html (default <reportsDir>/trends.html). Light
 * theme — matches the PDF report's stakeholder aesthetic; readable
 * when forwarded over email, embedded in slides, or printed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { HistoryEntry } from "./history.js";
import { loadHistory } from "./history.js";

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

export interface TrendsDashboardOptions {
  /** Filter by project name. */
  project?: string;
  /** Cap on history rows. Default 100 (about 3 months of daily runs). */
  limit?: number;
  /** Output path. Default <reportsDir>/trends.html. */
  outPath?: string;
}

/**
 * Render the trends dashboard HTML for an array of HistoryEntry rows.
 * Pure — no I/O, no DB. Useful for inspection, alternate backends, tests.
 *
 * Entries are expected newest-first (matching loadHistory's default).
 * Internally reverses for left-to-right time-series rendering.
 */
export function renderTrendsHtml(entries: HistoryEntry[], project?: string): string {
  const ordered = [...entries].reverse(); // chronological for charts
  const projectLabel = project ?? (entries[0]?.projectName ?? "all projects");
  const summary = computeSummary(ordered);

  return [
    HTML_OPEN,
    `<style>${stylesheet()}</style>`,
    HTML_HEAD_CLOSE,
    headerSection(projectLabel, ordered.length, summary),
    summaryCards(summary),
    chartsSection(ordered),
    tableSection(entries.slice(0, 25)),
    HTML_FOOTER,
  ].join("\n");
}

/**
 * Load history from <reportsDir>/history.db and write the dashboard to
 * disk. Returns the absolute output path.
 */
export function writeTrendsDashboard(
  reportsDir: string,
  opts: TrendsDashboardOptions = {},
): string {
  const limit = opts.limit ?? 100;
  const entries = loadHistory(reportsDir, { limit, project: opts.project });
  const outPath = opts.outPath ?? path.join(reportsDir, "trends.html");
  const html = renderTrendsHtml(entries, opts.project);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
  return outPath;
}

// ─────────────────────────────────────────────────────────────
// Summary computation
// ─────────────────────────────────────────────────────────────

export interface TrendsSummary {
  totalRuns: number;
  latestScore: number;
  meanLast7: number | null;
  meanLast30: number | null;
  scoreDeltaVsFirst: number | null;
  totalCostUsd: number;
  totalIssues: number;
  totalCriticalIssues: number;
  windowStart: string | null;
  windowEnd: string | null;
}

export function computeSummary(orderedAsc: HistoryEntry[]): TrendsSummary {
  if (orderedAsc.length === 0) {
    return {
      totalRuns: 0,
      latestScore: 0,
      meanLast7: null,
      meanLast30: null,
      scoreDeltaVsFirst: null,
      totalCostUsd: 0,
      totalIssues: 0,
      totalCriticalIssues: 0,
      windowStart: null,
      windowEnd: null,
    };
  }
  const first = orderedAsc[0]!;
  const latest = orderedAsc[orderedAsc.length - 1]!;
  const last7 = orderedAsc.slice(-7);
  const last30 = orderedAsc.slice(-30);
  const sum = (rows: HistoryEntry[]): number =>
    rows.reduce((acc, r) => acc + r.overallScore, 0);
  return {
    totalRuns: orderedAsc.length,
    latestScore: latest.overallScore,
    meanLast7: last7.length > 0 ? sum(last7) / last7.length : null,
    meanLast30: last30.length > 0 ? sum(last30) / last30.length : null,
    scoreDeltaVsFirst: latest.overallScore - first.overallScore,
    totalCostUsd: orderedAsc.reduce((acc, r) => acc + r.totalCostUsd, 0),
    totalIssues: orderedAsc.reduce((acc, r) => acc + r.totalIssues, 0),
    totalCriticalIssues: orderedAsc.reduce(
      (acc, r) => acc + r.criticalIssues,
      0,
    ),
    windowStart: first.startedAt,
    windowEnd: latest.startedAt,
  };
}

// ─────────────────────────────────────────────────────────────
// SVG chart primitives
// ─────────────────────────────────────────────────────────────

interface LinePoint {
  x: number; // index in time series
  y: number; // value
}

export interface LineChartOptions {
  width?: number;
  height?: number;
  color?: string;
  yMin?: number;
  yMax?: number;
  yLabel?: string;
  yTicks?: number[];
}

/**
 * Render a single-line SVG chart. Pure — returns an SVG string for
 * inline embedding. No JS, no fonts, no external resources.
 *
 * Empty point array returns an empty SVG with a "No data" caption so
 * dashboards never crash on a freshly-initialised reportsDir.
 */
export function lineChartSvg(
  points: LinePoint[],
  opts: LineChartOptions = {},
): string {
  const w = opts.width ?? 600;
  const h = opts.height ?? 160;
  const padL = 40;
  const padR = 12;
  const padT = 12;
  const padB = 22;
  const color = opts.color ?? "#1e3a8a";

  if (points.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><text x="${w / 2}" y="${h / 2}" text-anchor="middle" fill="#888" font-size="12">No data</text></svg>`;
  }

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = opts.yMin ?? Math.min(...ys);
  const yMax = opts.yMax ?? Math.max(...ys);
  const yRange = yMax - yMin || 1;
  const xRange = xMax - xMin || 1;

  const sx = (x: number): number => padL + ((x - xMin) / xRange) * (w - padL - padR);
  const sy = (y: number): number => h - padB - ((y - yMin) / yRange) * (h - padT - padB);

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`)
    .join(" ");

  const yTicks = opts.yTicks ?? deriveTicks(yMin, yMax);
  const gridLines = yTicks
    .map(
      (t) =>
        `<line x1="${padL}" y1="${sy(t).toFixed(1)}" x2="${w - padR}" y2="${sy(t).toFixed(1)}" stroke="#eee" stroke-width="1"/>` +
        `<text x="${padL - 6}" y="${(sy(t) + 4).toFixed(1)}" text-anchor="end" fill="#888" font-size="10">${formatTick(t)}</text>`,
    )
    .join("\n");

  const dots = points
    .map(
      (p) =>
        `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="2.5" fill="${color}"/>`,
    )
    .join("");

  const yLabel = opts.yLabel
    ? `<text x="6" y="${padT + 6}" fill="#666" font-size="10">${escapeAttr(opts.yLabel)}</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
${gridLines}
<path d="${path}" stroke="${color}" stroke-width="2" fill="none" stroke-linejoin="round"/>
${dots}
${yLabel}
</svg>`;
}

interface StackBar {
  segments: Array<{ value: number; color: string; label: string }>;
}

export interface StackedBarsOptions {
  width?: number;
  height?: number;
  /** Maximum total value to scale all bars against. If omitted, derived. */
  yMax?: number;
}

/**
 * Render a stacked-bar SVG chart. Each `bar` has segments rendered
 * bottom-up in declaration order. Used for pass / warn / fail per-run
 * composition.
 */
export function stackedBarsSvg(
  bars: StackBar[],
  opts: StackedBarsOptions = {},
): string {
  const w = opts.width ?? 600;
  const h = opts.height ?? 160;
  const padL = 40;
  const padR = 12;
  const padT = 12;
  const padB = 22;
  if (bars.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><text x="${w / 2}" y="${h / 2}" text-anchor="middle" fill="#888" font-size="12">No data</text></svg>`;
  }

  const totals = bars.map((b) =>
    b.segments.reduce((acc, s) => acc + s.value, 0),
  );
  const yMax = opts.yMax ?? Math.max(...totals, 1);
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const barWidth = (innerW / bars.length) * 0.7;
  const gap = innerW / bars.length - barWidth;

  const ticks = deriveTicks(0, yMax);
  const gridLines = ticks
    .map((t) => {
      const y = padT + (1 - t / yMax) * innerH;
      return (
        `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="#eee" stroke-width="1"/>` +
        `<text x="${padL - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#888" font-size="10">${formatTick(t)}</text>`
      );
    })
    .join("\n");

  const barsSvg = bars
    .map((b, i) => {
      const x = padL + i * (barWidth + gap) + gap / 2;
      let yCursor = h - padB;
      const segs = b.segments
        .map((s) => {
          const segH = (s.value / yMax) * innerH;
          yCursor -= segH;
          return `<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${segH.toFixed(1)}" fill="${s.color}"><title>${escapeAttr(s.label)}: ${s.value}</title></rect>`;
        })
        .join("");
      return segs;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
${gridLines}
${barsSvg}
</svg>`;
}

interface MultiLine {
  label: string;
  color: string;
  points: LinePoint[];
}

export function multiLineChartSvg(
  series: MultiLine[],
  opts: LineChartOptions = {},
): string {
  const w = opts.width ?? 600;
  const h = opts.height ?? 200;
  const padL = 40;
  const padR = 110;
  const padT = 12;
  const padB = 22;

  const allPoints = series.flatMap((s) => s.points);
  if (allPoints.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><text x="${w / 2}" y="${h / 2}" text-anchor="middle" fill="#888" font-size="12">No data</text></svg>`;
  }

  const xs = allPoints.map((p) => p.x);
  const ys = allPoints.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = opts.yMin ?? Math.min(...ys);
  const yMax = opts.yMax ?? Math.max(...ys);
  const yRange = yMax - yMin || 1;
  const xRange = xMax - xMin || 1;

  const sx = (x: number): number => padL + ((x - xMin) / xRange) * (w - padL - padR);
  const sy = (y: number): number => h - padB - ((y - yMin) / yRange) * (h - padT - padB);

  const ticks = opts.yTicks ?? deriveTicks(yMin, yMax);
  const gridLines = ticks
    .map(
      (t) =>
        `<line x1="${padL}" y1="${sy(t).toFixed(1)}" x2="${w - padR}" y2="${sy(t).toFixed(1)}" stroke="#eee" stroke-width="1"/>` +
        `<text x="${padL - 6}" y="${(sy(t) + 4).toFixed(1)}" text-anchor="end" fill="#888" font-size="10">${formatTick(t)}</text>`,
    )
    .join("\n");

  const lines = series
    .map((s) => {
      if (s.points.length === 0) return "";
      const path = s.points
        .map(
          (p, i) =>
            `${i === 0 ? "M" : "L"} ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`,
        )
        .join(" ");
      return `<path d="${path}" stroke="${s.color}" stroke-width="1.5" fill="none" stroke-linejoin="round"/>`;
    })
    .join("\n");

  const legend = series
    .map((s, i) => {
      const ly = padT + 6 + i * 14;
      return `<g><rect x="${w - padR + 6}" y="${ly - 8}" width="10" height="3" fill="${s.color}"/><text x="${w - padR + 20}" y="${ly - 4}" fill="#444" font-size="10">${escapeAttr(s.label)}</text></g>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
${gridLines}
${lines}
${legend}
</svg>`;
}

/**
 * Choose nice round tick marks between min and max. Targets ~5 ticks.
 */
export function deriveTicks(min: number, max: number): number[] {
  if (max <= min) return [min];
  const range = max - min;
  const step = niceStep(range / 5);
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step / 2; v += step) {
    if (v >= min - step / 10) ticks.push(Math.round(v * 100) / 100);
  }
  return ticks.length > 0 ? ticks : [min, max];
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / exp;
  if (norm < 1.5) return 1 * exp;
  if (norm < 3) return 2 * exp;
  if (norm < 7) return 5 * exp;
  return 10 * exp;
}

function formatTick(v: number): string {
  if (Math.abs(v) >= 100 || Number.isInteger(v)) return String(Math.round(v));
  return v.toFixed(1);
}

// ─────────────────────────────────────────────────────────────
// HTML composition
// ─────────────────────────────────────────────────────────────

const HTML_OPEN = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Browser Auditor — Trends</title>`;

const HTML_HEAD_CLOSE = `</head><body>`;

const HTML_FOOTER = `</body></html>`;

function stylesheet(): string {
  return `
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 24px;
      background: #fafafa; color: #111;
      font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
      font-size: 14px; line-height: 1.5;
    }
    .container { max-width: 1100px; margin: 0 auto; }
    header h1 { font-size: 22px; margin: 0 0 4px; color: #1e3a8a; }
    header .meta { color: #666; font-size: 12px; }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px; margin: 18px 0 24px;
    }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 14px; }
    .card .label { color: #666; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .card .value { font-size: 22px; font-weight: 700; color: #111; }
    .card .delta { margin-left: 6px; font-size: 12px; font-weight: 600; }
    .delta.up { color: #15803d; }
    .delta.down { color: #b91c1c; }
    .delta.flat { color: #888; }
    .charts { display: grid; gap: 18px; }
    .chart-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px 18px; }
    .chart-card h2 { font-size: 14px; margin: 0 0 8px; color: #111; }
    .chart-card .hint { font-size: 12px; color: #666; margin-bottom: 10px; }
    .chart-card svg { display: block; width: 100%; height: auto; }
    .legend { font-size: 12px; color: #444; display: flex; gap: 14px; margin-top: 6px; flex-wrap: wrap; }
    .legend .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
    table.runs { width: 100%; border-collapse: collapse; margin-top: 18px; background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; }
    table.runs th, table.runs td { padding: 8px 10px; text-align: left; font-size: 12px; border-bottom: 1px solid #f1f5f9; }
    table.runs th { background: #f8fafc; color: #555; font-weight: 600; }
    table.runs tr:last-child td { border-bottom: none; }
    .empty {
      padding: 60px 20px; text-align: center; color: #666; font-size: 14px;
      border: 1px dashed #d1d5db; border-radius: 6px; margin-top: 18px;
    }
  `;
}

function headerSection(
  projectLabel: string,
  totalRuns: number,
  summary: TrendsSummary,
): string {
  const span =
    summary.windowStart && summary.windowEnd
      ? ` · ${formatDate(summary.windowStart)} → ${formatDate(summary.windowEnd)}`
      : "";
  return `<div class="container">
<header>
  <h1>AI Browser Auditor — Trends</h1>
  <div class="meta">${escapeHtml(projectLabel)} · ${totalRuns} run${totalRuns === 1 ? "" : "s"}${span}</div>
</header>`;
}

function summaryCards(s: TrendsSummary): string {
  if (s.totalRuns === 0) {
    return `<div class="empty">No audit history found yet. Run <code>ai-audit run</code> to seed the trend dashboard.</div></div>`;
  }
  const delta = s.scoreDeltaVsFirst ?? 0;
  const dCls = delta > 0.1 ? "up" : delta < -0.1 ? "down" : "flat";
  const dStr =
    delta > 0
      ? `▲ ${delta.toFixed(1)}`
      : delta < 0
        ? `▼ ${Math.abs(delta).toFixed(1)}`
        : "—";
  const m7 = s.meanLast7 !== null ? s.meanLast7.toFixed(1) : "—";
  const m30 = s.meanLast30 !== null ? s.meanLast30.toFixed(1) : "—";
  return `<div class="cards">
  <div class="card"><div class="label">Latest score</div><div class="value">${s.latestScore.toFixed(1)} <span class="delta ${dCls}">${dStr}</span></div></div>
  <div class="card"><div class="label">Mean last 7</div><div class="value">${m7}</div></div>
  <div class="card"><div class="label">Mean last 30</div><div class="value">${m30}</div></div>
  <div class="card"><div class="label">Total cost</div><div class="value">$${s.totalCostUsd.toFixed(2)}</div></div>
  <div class="card"><div class="label">Total issues</div><div class="value">${s.totalIssues}</div></div>
  <div class="card"><div class="label">Critical issues</div><div class="value">${s.totalCriticalIssues}</div></div>
</div>`;
}

function chartsSection(orderedAsc: HistoryEntry[]): string {
  if (orderedAsc.length === 0) return "";

  const scorePts = orderedAsc.map((r, i) => ({ x: i, y: r.overallScore }));
  const issuePts = orderedAsc.map((r, i) => ({ x: i, y: r.totalIssues }));
  const critPts = orderedAsc.map((r, i) => ({ x: i, y: r.criticalIssues }));
  const costPts = orderedAsc.map((r, i) => ({ x: i, y: r.totalCostUsd }));

  // Pass / Warn / Fail stacked bars
  const stackBars: StackBar[] = orderedAsc.map((r) => ({
    segments: [
      { value: r.passCount, color: "#15803d", label: "Pass" },
      { value: r.warnCount, color: "#a16207", label: "Warn" },
      { value: r.failCount, color: "#b91c1c", label: "Fail" },
    ],
  }));

  // Per-dimension multi-line
  const dimNames = collectDimensions(orderedAsc);
  const dimSeries = dimNames.map((name, i) => ({
    label: name,
    color: DIMENSION_PALETTE[i % DIMENSION_PALETTE.length]!,
    points: orderedAsc
      .map((r, idx) => ({
        x: idx,
        y: r.dimensionAverages[name],
      }))
      .filter((p): p is LinePoint => typeof p.y === "number"),
  }));

  return `<div class="charts">

  <div class="chart-card">
    <h2>Overall score</h2>
    <p class="hint">0–10 scale. Higher is better. Trends across the last ${orderedAsc.length} runs.</p>
    ${lineChartSvg(scorePts, { yMin: 0, yMax: 10, color: "#1e3a8a" })}
  </div>

  <div class="chart-card">
    <h2>Pass / Warn / Fail breakdown</h2>
    <p class="hint">Counts of audit units by status, per run. Tall green bars = consistent runs; growing red = regression.</p>
    ${stackedBarsSvg(stackBars)}
    <div class="legend">
      <span><span class="swatch" style="background:#15803d"></span>Pass</span>
      <span><span class="swatch" style="background:#a16207"></span>Pass with issues</span>
      <span><span class="swatch" style="background:#b91c1c"></span>Fail</span>
    </div>
  </div>

  <div class="chart-card">
    <h2>Issues over time</h2>
    <p class="hint">Total issues raised, with critical issues called out. Lower is better.</p>
    ${multiLineChartSvg(
      [
        { label: "Total", color: "#1e3a8a", points: issuePts },
        { label: "Critical", color: "#b91c1c", points: critPts },
      ],
      { yMin: 0 },
    )}
  </div>

  <div class="chart-card">
    <h2>Cost over time</h2>
    <p class="hint">USD spent on AI inference per run. Drift up suggests inefficient scoring or larger scenarios.</p>
    ${lineChartSvg(costPts, { yMin: 0, color: "#0f766e", yLabel: "USD" })}
  </div>

  <div class="chart-card">
    <h2>Per-dimension scores</h2>
    <p class="hint">One line per scoring dimension (visual, completion, localisation, etc). Spot when a single dimension regresses while the overall stays flat.</p>
    ${multiLineChartSvg(dimSeries, { yMin: 0, yMax: 10 })}
  </div>

</div>`;
}

function tableSection(recent: HistoryEntry[]): string {
  if (recent.length === 0) return "</div>"; // close .container
  const rows = recent
    .map((r) => {
      const date = formatDate(r.startedAt);
      const score = r.overallScore.toFixed(1);
      const cost = `$${r.totalCostUsd.toFixed(3)}`;
      return `<tr>
      <td>${escapeHtml(date)}</td>
      <td>${escapeHtml(r.id)}</td>
      <td>${score}</td>
      <td>${r.passCount}</td>
      <td>${r.warnCount}</td>
      <td>${r.failCount}</td>
      <td>${r.totalIssues}</td>
      <td>${r.criticalIssues}</td>
      <td>${cost}</td>
      <td>${escapeHtml(r.tag ?? "—")}</td>
    </tr>`;
    })
    .join("\n");
  return `<table class="runs">
  <thead>
    <tr><th>Date</th><th>Run</th><th>Score</th><th>Pass</th><th>Warn</th><th>Fail</th><th>Issues</th><th>Critical</th><th>Cost</th><th>Tag</th></tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
</div>`;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const DIMENSION_PALETTE = [
  "#1e3a8a",
  "#0f766e",
  "#a16207",
  "#b91c1c",
  "#7c3aed",
  "#15803d",
  "#0ea5e9",
  "#db2777",
];

export function collectDimensions(entries: HistoryEntry[]): string[] {
  const set = new Set<string>();
  for (const r of entries) {
    for (const k of Object.keys(r.dimensionAverages)) set.add(k);
  }
  return [...set].sort();
}

function formatDate(iso: string): string {
  // YYYY-MM-DD HH:MM in UTC. Local-time formatting would surprise users
  // who copy the dashboard between machines.
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!m) return iso;
  return `${m[1]} ${m[2]}`;
}

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

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/**
 * Tests for src/core/reporter-trends.ts.
 *
 * Three surfaces:
 *   1. SVG chart primitives (lineChartSvg / stackedBarsSvg /
 *      multiLineChartSvg / deriveTicks) — pure, fully unit-tested
 *      including empty-data fallback and tick generation
 *   2. computeSummary + collectDimensions — pure aggregation helpers
 *   3. renderTrendsHtml + writeTrendsDashboard — composition and disk
 *      writes (writeTrendsDashboard exercises a real loadHistory call
 *      against a temp SQLite file built via saveAuditToHistory)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  collectDimensions,
  computeSummary,
  deriveTicks,
  escapeHtml,
  lineChartSvg,
  multiLineChartSvg,
  renderTrendsHtml,
  stackedBarsSvg,
  writeTrendsDashboard,
} from "../src/core/reporter-trends.js";
import type { HistoryEntry } from "../src/core/history.js";
import { saveAuditToHistory } from "../src/core/history.js";
import type { AuditRun } from "../src/core/types.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trends-rep-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────

function makeEntry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "20260501_120000_smoke",
    tag: "manual",
    projectName: "demo-shop",
    startedAt: "2026-05-01T12:00:00.000Z",
    durationMs: 30000,
    totalCostUsd: 0.12,
    totalUnits: 4,
    passCount: 3,
    warnCount: 0,
    failCount: 1,
    totalIssues: 5,
    criticalIssues: 1,
    overallScore: 7.2,
    dimensionAverages: { completion: 7.0, visual_polish: 7.5 },
    schemaVersion: "1.2.0",
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────
// SVG chart primitives
// ─────────────────────────────────────────────────────────────

describe("deriveTicks", () => {
  it("returns nice round ticks across a 0–10 range", () => {
    const t = deriveTicks(0, 10);
    expect(t).toContain(0);
    expect(t).toContain(10);
    expect(t.length).toBeGreaterThanOrEqual(3);
  });

  it("collapses to a single tick when min === max", () => {
    expect(deriveTicks(5, 5)).toEqual([5]);
  });

  it("handles small fractional ranges", () => {
    const t = deriveTicks(0.1, 0.5);
    expect(t.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...t)).toBeGreaterThanOrEqual(0.5);
  });

  it("handles large positive ranges with sane step size", () => {
    const t = deriveTicks(0, 1000);
    // ~5 ticks at step 200 expected
    expect(t).toContain(0);
    expect(t.some((v) => v >= 1000)).toBe(true);
    expect(t.length).toBeLessThanOrEqual(7);
  });
});

describe("lineChartSvg", () => {
  it('emits a "No data" placeholder for empty input', () => {
    const svg = lineChartSvg([]);
    expect(svg).toContain("No data");
    expect(svg).toMatch(/<svg /);
  });

  it("emits an SVG with the expected dimensions", () => {
    const svg = lineChartSvg(
      [
        { x: 0, y: 5 },
        { x: 1, y: 7 },
      ],
      { width: 800, height: 200 },
    );
    expect(svg).toContain('viewBox="0 0 800 200"');
    expect(svg).toContain('width="800"');
    expect(svg).toContain('height="200"');
  });

  it("draws an M…L SVG path through the points in order", () => {
    const svg = lineChartSvg([
      { x: 0, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 3 },
    ]);
    const m = svg.match(/<path d="(M [^"]+)"/);
    expect(m).not.toBeNull();
    // First command is M, two L commands follow
    expect(m![1]).toMatch(/^M /);
    expect(m![1].match(/L /g) ?? []).toHaveLength(2);
  });

  it("accepts a custom yMin / yMax (clamps the axis)", () => {
    const svg = lineChartSvg(
      [
        { x: 0, y: 7 },
        { x: 1, y: 9 },
      ],
      { yMin: 0, yMax: 10 },
    );
    // Both points 7 and 9 sit in upper region of the 0–10 axis. Tick "10"
    // appears as a label.
    expect(svg).toMatch(/>10<\/text>|>10\.0<\/text>/);
  });

  it("renders a circle marker at every point", () => {
    const svg = lineChartSvg([
      { x: 0, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 3 },
    ]);
    expect((svg.match(/<circle /g) ?? []).length).toBe(3);
  });

  it("respects the color option in path stroke and circle fill", () => {
    const svg = lineChartSvg(
      [
        { x: 0, y: 1 },
        { x: 1, y: 2 },
      ],
      { color: "#ff0066" },
    );
    expect(svg).toContain('stroke="#ff0066"');
    expect(svg).toContain('fill="#ff0066"');
  });

  it("emits the optional yLabel as a text element", () => {
    const svg = lineChartSvg([{ x: 0, y: 1 }], { yLabel: "USD" });
    expect(svg).toMatch(/<text [^>]*>USD<\/text>/);
  });
});

describe("stackedBarsSvg", () => {
  it('emits a "No data" placeholder for empty input', () => {
    const svg = stackedBarsSvg([]);
    expect(svg).toContain("No data");
  });

  it("renders one rect per segment per bar (sum)", () => {
    const svg = stackedBarsSvg([
      {
        segments: [
          { value: 3, color: "#0f0", label: "Pass" },
          { value: 1, color: "#f00", label: "Fail" },
        ],
      },
      {
        segments: [
          { value: 2, color: "#0f0", label: "Pass" },
          { value: 0, color: "#f00", label: "Fail" }, // zero-height segment still emitted
          { value: 1, color: "#a16207", label: "Warn" },
        ],
      },
    ]);
    expect((svg.match(/<rect /g) ?? []).length).toBe(5);
  });

  it("attaches a <title> to each rect for hover-detail", () => {
    const svg = stackedBarsSvg([
      {
        segments: [{ value: 7, color: "#0f0", label: "Pass" }],
      },
    ]);
    expect(svg).toMatch(/<title>Pass: 7<\/title>/);
  });

  it("derives yMax from the tallest bar when not supplied", () => {
    const svg = stackedBarsSvg([
      {
        segments: [
          { value: 5, color: "#0f0", label: "A" },
          { value: 3, color: "#f00", label: "B" },
        ],
      },
      {
        segments: [{ value: 2, color: "#0f0", label: "A" }],
      },
    ]);
    // tallest bar = 8 → tick label "8" must appear
    expect(svg).toMatch(/>8<\/text>|>8\.0<\/text>/);
  });
});

describe("multiLineChartSvg", () => {
  it('emits "No data" when every series is empty', () => {
    const svg = multiLineChartSvg([
      { label: "A", color: "#000", points: [] },
      { label: "B", color: "#111", points: [] },
    ]);
    expect(svg).toContain("No data");
  });

  it("emits one path per non-empty series + a legend entry per series", () => {
    const svg = multiLineChartSvg([
      {
        label: "completion",
        color: "#1e3a8a",
        points: [
          { x: 0, y: 7 },
          { x: 1, y: 7.5 },
        ],
      },
      {
        label: "visual_polish",
        color: "#0f766e",
        points: [
          { x: 0, y: 6 },
          { x: 1, y: 6.5 },
        ],
      },
    ]);
    expect((svg.match(/<path /g) ?? []).length).toBe(2);
    expect(svg).toContain("completion");
    expect(svg).toContain("visual_polish");
    expect(svg).toContain('fill="#1e3a8a"');
    expect(svg).toContain('fill="#0f766e"');
  });

  it("skips the path for an individual empty series but keeps others", () => {
    const svg = multiLineChartSvg([
      { label: "A", color: "#000", points: [] },
      {
        label: "B",
        color: "#111",
        points: [
          { x: 0, y: 1 },
          { x: 1, y: 2 },
        ],
      },
    ]);
    expect((svg.match(/<path /g) ?? []).length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// computeSummary + collectDimensions
// ─────────────────────────────────────────────────────────────

describe("computeSummary", () => {
  it("returns zeroed summary for empty input", () => {
    const s = computeSummary([]);
    expect(s.totalRuns).toBe(0);
    expect(s.latestScore).toBe(0);
    expect(s.meanLast7).toBeNull();
    expect(s.meanLast30).toBeNull();
    expect(s.scoreDeltaVsFirst).toBeNull();
  });

  it("computes latest score, totals, and delta vs first run", () => {
    const entries = [
      makeEntry({ overallScore: 6, totalCostUsd: 0.1, totalIssues: 5, criticalIssues: 1 }),
      makeEntry({ overallScore: 7, totalCostUsd: 0.1, totalIssues: 3, criticalIssues: 0 }),
      makeEntry({ overallScore: 8, totalCostUsd: 0.1, totalIssues: 2, criticalIssues: 0 }),
    ];
    const s = computeSummary(entries);
    expect(s.totalRuns).toBe(3);
    expect(s.latestScore).toBe(8);
    expect(s.scoreDeltaVsFirst).toBe(2); // 8 - 6
    expect(s.totalCostUsd).toBeCloseTo(0.3, 5);
    expect(s.totalIssues).toBe(10);
    expect(s.totalCriticalIssues).toBe(1);
  });

  it("computes 7-day mean from the trailing 7 runs", () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({ overallScore: i + 1 }),
    );
    const s = computeSummary(entries);
    // last 7 → scores 4..10 → mean 7
    expect(s.meanLast7).toBeCloseTo(7, 5);
  });

  it("computes 30-day mean from the trailing 30 runs", () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ overallScore: i + 5 }),
    );
    const s = computeSummary(entries);
    // last 30 (only 5 exist) → mean of 5..9 = 7
    expect(s.meanLast30).toBeCloseTo(7, 5);
  });

  it("captures windowStart + windowEnd from boundary runs", () => {
    const entries = [
      makeEntry({ startedAt: "2026-04-01T10:00:00.000Z" }),
      makeEntry({ startedAt: "2026-04-15T10:00:00.000Z" }),
      makeEntry({ startedAt: "2026-04-30T10:00:00.000Z" }),
    ];
    const s = computeSummary(entries);
    expect(s.windowStart).toBe("2026-04-01T10:00:00.000Z");
    expect(s.windowEnd).toBe("2026-04-30T10:00:00.000Z");
  });
});

describe("collectDimensions", () => {
  it("returns [] for empty input", () => {
    expect(collectDimensions([])).toEqual([]);
  });

  it("returns the union of dimension keys across all entries, sorted", () => {
    const out = collectDimensions([
      makeEntry({ dimensionAverages: { completion: 7, visual_polish: 8 } }),
      makeEntry({ dimensionAverages: { completion: 7, localization: 6 } }),
    ]);
    expect(out).toEqual(["completion", "localization", "visual_polish"]);
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml("<a href=\"&q\">'x'</a>")).toBe(
      "&lt;a href=&quot;&amp;q&quot;&gt;&#39;x&#39;&lt;/a&gt;",
    );
  });
});

// ─────────────────────────────────────────────────────────────
// renderTrendsHtml — composition
// ─────────────────────────────────────────────────────────────

describe("renderTrendsHtml — empty history", () => {
  it("emits a friendly empty-state placeholder", () => {
    const html = renderTrendsHtml([]);
    expect(html).toContain("No audit history found yet");
    expect(html).toContain("pixelcheck run");
    expect(html).toMatch(/^<!doctype html>/);
  });
});

describe("renderTrendsHtml — populated history", () => {
  function buildHistory(): HistoryEntry[] {
    // newest-first like loadHistory returns
    return [
      makeEntry({
        id: "20260510_100000",
        startedAt: "2026-05-10T10:00:00.000Z",
        overallScore: 8.0,
        passCount: 4,
        warnCount: 0,
        failCount: 0,
        totalIssues: 1,
        criticalIssues: 0,
        totalCostUsd: 0.20,
        dimensionAverages: { completion: 8, visual_polish: 8 },
      }),
      makeEntry({
        id: "20260505_100000",
        startedAt: "2026-05-05T10:00:00.000Z",
        overallScore: 7.0,
        passCount: 3,
        warnCount: 1,
        failCount: 0,
        totalIssues: 3,
        criticalIssues: 0,
        totalCostUsd: 0.15,
        dimensionAverages: { completion: 7, visual_polish: 7 },
      }),
      makeEntry({
        id: "20260501_100000",
        startedAt: "2026-05-01T10:00:00.000Z",
        overallScore: 6.5,
        passCount: 2,
        warnCount: 1,
        failCount: 1,
        totalIssues: 5,
        criticalIssues: 1,
        totalCostUsd: 0.10,
        dimensionAverages: { completion: 6, visual_polish: 7 },
      }),
    ];
  }

  it("includes a header with the project name + run count + window", () => {
    const html = renderTrendsHtml(buildHistory(), "demo-shop");
    expect(html).toContain("demo-shop");
    expect(html).toContain("3 runs");
    expect(html).toContain("2026-05-01");
    expect(html).toContain("2026-05-10");
  });

  it("falls back to the first entry's project name when project arg is not supplied", () => {
    const html = renderTrendsHtml(buildHistory());
    expect(html).toContain("demo-shop");
  });

  it("renders 6 summary cards (latest / mean7 / mean30 / cost / issues / critical)", () => {
    const html = renderTrendsHtml(buildHistory());
    expect(html).toContain('class="label">Latest score</div>');
    expect(html).toContain('class="label">Mean last 7</div>');
    expect(html).toContain('class="label">Mean last 30</div>');
    expect(html).toContain('class="label">Total cost</div>');
    expect(html).toContain('class="label">Total issues</div>');
    expect(html).toContain('class="label">Critical issues</div>');
  });

  it("shows score delta arrow (▲ for improvement, ▼ for regression)", () => {
    // 6.5 → 7.0 → 8.0 → improvement
    const html = renderTrendsHtml(buildHistory());
    expect(html).toContain("▲");
    expect(html).not.toContain("▼");
  });

  it("renders 5 chart cards with their h2 titles", () => {
    const html = renderTrendsHtml(buildHistory());
    expect(html).toMatch(/<h2>Overall score<\/h2>/);
    expect(html).toMatch(/<h2>Pass \/ Warn \/ Fail breakdown<\/h2>/);
    expect(html).toMatch(/<h2>Issues over time<\/h2>/);
    expect(html).toMatch(/<h2>Cost over time<\/h2>/);
    expect(html).toMatch(/<h2>Per-dimension scores<\/h2>/);
  });

  it("emits an SVG inside each chart card", () => {
    const html = renderTrendsHtml(buildHistory());
    const charts = html.split('<div class="chart-card">').slice(1);
    expect(charts.length).toBe(5);
    for (const c of charts) {
      expect(c).toMatch(/<svg /);
    }
  });

  it("includes a recent-runs table with one row per entry", () => {
    const html = renderTrendsHtml(buildHistory());
    // Table is present
    expect(html).toContain('<table class="runs">');
    // 3 data rows
    expect((html.match(/<tr>\n      <td>/g) ?? []).length).toBe(3);
  });

  it("displays date in YYYY-MM-DD HH:MM format (UTC, never local)", () => {
    const html = renderTrendsHtml(buildHistory());
    expect(html).toContain("2026-05-10 10:00");
    expect(html).toContain("2026-05-05 10:00");
    expect(html).toContain("2026-05-01 10:00");
  });

  it("emits one path per dimension in the per-dimension chart", () => {
    const html = renderTrendsHtml(buildHistory());
    const dimChart = html.split("Per-dimension scores")[1] ?? "";
    // Two dimensions in the fixture (completion + visual_polish)
    expect(dimChart).toContain("completion");
    expect(dimChart).toContain("visual_polish");
  });

  it("starts with <!doctype html> and ends with </html>", () => {
    const html = renderTrendsHtml(buildHistory());
    expect(html).toMatch(/^<!doctype html>/);
    expect(html.trim()).toMatch(/<\/html>$/);
  });

  it("escapes XSS-style HTML in tag / id / project name", () => {
    const evil = makeEntry({
      tag: '<script>alert(1)</script>',
      id: '<img src=x>',
      projectName: "Sales & <Marketing>",
    });
    const html = renderTrendsHtml([evil], "Sales & <Marketing>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).toContain("Sales &amp; &lt;Marketing&gt;");
  });
});

// ─────────────────────────────────────────────────────────────
// writeTrendsDashboard — disk write integration
// ─────────────────────────────────────────────────────────────

describe("renderTrendsHtml — i18n integration (M2-4)", () => {
  function buildHistory(): HistoryEntry[] {
    return [
      makeEntry({
        startedAt: "2026-05-10T10:00:00.000Z",
        overallScore: 8.0,
        totalIssues: 1,
      }),
      makeEntry({
        startedAt: "2026-05-05T10:00:00.000Z",
        overallScore: 7.5,
        totalIssues: 2,
      }),
    ];
  }

  it("renders titles + cards in zh-CN", () => {
    const html = renderTrendsHtml(buildHistory(), "demo-shop", "zh-CN");
    expect(html).toContain("AI 浏览器审计 — 趋势");
    expect(html).toContain("最新评分");
    expect(html).toContain("近 7 次平均");
    expect(html).toContain("总评分"); // first chart title
    expect(html).toContain("通过 / 警告 / 失败分布");
    expect(html).toContain("各维度评分");
  });

  it("renders titles + cards in ja", () => {
    const html = renderTrendsHtml(buildHistory(), "demo-shop", "ja");
    expect(html).toContain("AIブラウザ監査 — トレンド");
    expect(html).toContain("最新スコア");
    expect(html).toContain("総合スコア");
  });

  it("renders titles + cards in de", () => {
    const html = renderTrendsHtml(buildHistory(), "demo-shop", "de");
    expect(html).toContain("KI-Browser-Audit — Trends");
    expect(html).toContain("Gesamtpunktzahl");
  });

  it("uses locale-correct singular for 1 run in es", () => {
    const html = renderTrendsHtml([buildHistory()[0]!], "demo", "es");
    expect(html).toContain("1 ejecución");
  });

  it("uses locale-correct plural for >1 in es", () => {
    const html = renderTrendsHtml(buildHistory(), "demo", "es");
    expect(html).toContain("2 ejecuciones");
  });

  it("default locale (no arg) renders English", () => {
    const html = renderTrendsHtml(buildHistory());
    expect(html).toContain("PixelCheck — Trends");
    expect(html).toContain("Latest score");
    expect(html).toContain("2 runs");
  });

  it("empty-state translates correctly per locale", () => {
    const zh = renderTrendsHtml([], "demo-shop", "zh-CN");
    expect(zh).toContain("尚无审计历史");
    const ja = renderTrendsHtml([], "demo-shop", "ja");
    expect(ja).toContain("監査履歴がまだありません");
  });
});

describe("writeTrendsDashboard", () => {
  function seedHistory(reportsDir: string, runs: number = 3): void {
    fs.mkdirSync(reportsDir, { recursive: true });
    for (let i = 0; i < runs; i++) {
      const audit = buildSeedAudit(i);
      const runDir = path.join(reportsDir, audit.run_id);
      fs.mkdirSync(runDir, { recursive: true });
      saveAuditToHistory(audit, reportsDir, runDir);
    }
  }

  function buildSeedAudit(idx: number): AuditRun {
    const date = new Date(Date.UTC(2026, 4, 1 + idx, 12, 0, 0)).toISOString();
    return {
      schema_version: "1.2.0",
      run_id: `seed-${idx.toString().padStart(3, "0")}`,
      project_name: "demo-shop",
      base_url: "https://shop.example",
      started_at: date,
      finished_at: date,
      duration_ms: 30000,
      results: [
        {
          scenario_id: "smoke",
          scenario_name: "Smoke",
          persona_id: "us",
          persona_display_name: "US",
          started_at: date,
          finished_at: date,
          duration_ms: 1000,
          status: idx % 3 === 0 ? "fail" : "pass",
          fingerprint_id: "fp",
          steps: [],
          scores: [
            { dimension: "completion", score: 6 + idx * 0.5, justification: "" },
            { dimension: "visual_polish", score: 7 + idx * 0.3, justification: "" },
          ],
          overall_score: 6.5 + idx * 0.4,
          issues: [],
          artifacts: {},
          cost_usd: 0.05 + idx * 0.01,
        },
      ],
      summary: {
        total: 1,
        pass: idx % 3 === 0 ? 0 : 1,
        pass_with_issues: 0,
        fail: idx % 3 === 0 ? 1 : 0,
        total_cost_usd: 0.05 + idx * 0.01,
        total_issues: 0,
        critical_issues: 0,
      },
      config: {} as AuditRun["config"],
    };
  }

  it("writes trends.html to <reportsDir>/trends.html by default", () => {
    seedHistory(tmp);
    const out = writeTrendsDashboard(tmp);
    expect(out).toBe(path.join(tmp, "trends.html"));
    expect(fs.existsSync(out)).toBe(true);
    const html = fs.readFileSync(out, "utf8");
    expect(html).toContain("PixelCheck — Trends");
    expect(html).toContain("demo-shop");
    expect(html).toContain("3 runs");
  });

  it("respects a custom outPath", () => {
    seedHistory(tmp, 2);
    const customPath = path.join(tmp, "subdir", "my-trends.html");
    const out = writeTrendsDashboard(tmp, { outPath: customPath });
    expect(out).toBe(customPath);
    expect(fs.existsSync(out)).toBe(true);
  });

  it("writes the empty-state placeholder when history.db is missing", () => {
    // No seed call — reportsDir has no history.db
    const out = writeTrendsDashboard(tmp);
    const html = fs.readFileSync(out, "utf8");
    expect(html).toContain("No audit history found yet");
  });

  it("respects the project filter (only emits matching runs)", () => {
    seedHistory(tmp, 4);
    const out = writeTrendsDashboard(tmp, { project: "nonexistent-project" });
    const html = fs.readFileSync(out, "utf8");
    expect(html).toContain("No audit history found yet");
  });

  // 15s timeout (vs vitest default 5s) — this case seeds 10 history rows
  // (more than any other case in this file) which costs ~3-4 seconds of
  // fs writes + HTML render on Windows GitHub runners during peak load.
  // Linux/macOS finish in <500ms, so the bump only matters for Windows.
  // Observed PR-B (xcodethink/pixelcheck#18) intermittent windows-Node-22
  // 5s timeout on this exact case while the same case ran in 2.5s on PR-A.
  it("respects the limit option (caps history rows for chart density)", () => {
    seedHistory(tmp, 10);
    const out = writeTrendsDashboard(tmp, { limit: 3 });
    const html = fs.readFileSync(out, "utf8");
    expect(html).toContain("3 runs");
  }, 15_000);

  it("creates parent directories for outPath when missing", () => {
    seedHistory(tmp);
    const nested = path.join(tmp, "a", "b", "c", "trends.html");
    expect(fs.existsSync(path.dirname(nested))).toBe(false);
    writeTrendsDashboard(tmp, { outPath: nested });
    expect(fs.existsSync(nested)).toBe(true);
  });
});

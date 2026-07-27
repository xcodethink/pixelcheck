/**
 * Tests for src/core/reporter-diff.ts — Markdown / HTML / JSON / text
 * renderers + writeDiffReport disk-write helper.
 *
 * Each renderer is exercised against:
 *   1. A "regression" fixture (score down, issues up, new criticals)
 *   2. An "improvement" fixture (score up, issues resolved)
 *   3. A "no change" fixture (score and issues unchanged)
 *   4. A "cross-project diff" fixture (different projectName each side)
 *
 * Plus delta-arrow polarity verification (score↑ = good, issues↑ = bad,
 * cost↑ = bad, duration↑ = bad), severity tag rendering, redaction
 * passthrough, and writeDiffReport's format-from-extension inference.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  escapeHtml,
  renderDiffHtml,
  renderDiffJson,
  renderDiffMarkdown,
  renderDiffText,
  writeDiffReport,
} from "../src/core/reporter-diff.js";
import type { RunDiff } from "../src/core/history.js";
import type { HistoryEntry } from "../src/core/history.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diff-rep-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────

function makeEntry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "20260501_120000_main",
    tag: "main",
    projectName: "demo-shop",
    startedAt: "2026-05-01T12:00:00.000Z",
    durationMs: 30000,
    totalCostUsd: 0.12,
    totalUnits: 4,
    passCount: 3,
    warnCount: 0,
    failCount: 1,
    totalIssues: 5,
    criticalIssues: 0,
    overallScore: 7.5,
    dimensionAverages: { completion: 7.5, visual_polish: 7.0, localization: 8.0 },
    schemaVersion: "1.2.0",
    ...over,
  };
}

function regressionDiff(): RunDiff {
  return {
    runA: makeEntry(),
    runB: makeEntry({
      id: "20260501_130000_pr",
      tag: "pr-42",
      overallScore: 7.0,
      totalIssues: 8,
      criticalIssues: 1,
      totalCostUsd: 0.14,
      durationMs: 33000,
      dimensionAverages: { completion: 7.0, visual_polish: 7.0, localization: 8.5 },
    }),
    scoreDelta: -0.5,
    costDelta: 0.02,
    durationDelta: 3000,
    issuesDelta: 3,
    dimensionDeltas: { completion: -0.5, visual_polish: 0, localization: 0.5 },
    newIssues: [
      {
        severity: "critical",
        description: "Sign-in CTA overlaps hero image on mobile",
      },
      { severity: "high", description: "Pricing card missing aria-label" },
      { severity: "medium", description: "Footer link colour contrast 3.2:1" },
    ],
    resolvedIssues: [],
  };
}

function improvementDiff(): RunDiff {
  return {
    runA: makeEntry({ overallScore: 7.0, totalIssues: 8, criticalIssues: 1 }),
    runB: makeEntry({
      id: "20260501_140000",
      overallScore: 8.2,
      totalIssues: 4,
      criticalIssues: 0,
      totalCostUsd: 0.10,
      durationMs: 27000,
      dimensionAverages: { completion: 8.5, visual_polish: 8.0, localization: 8.0 },
    }),
    scoreDelta: 1.2,
    costDelta: -0.02,
    durationDelta: -3000,
    issuesDelta: -4,
    dimensionDeltas: { completion: 1.0, visual_polish: 1.0, localization: 0 },
    newIssues: [],
    resolvedIssues: [
      { severity: "critical", description: "Cart button vanishes on iPad" },
      { severity: "medium", description: "Checkout step 2 jumps focus" },
    ],
  };
}

function noChangeDiff(): RunDiff {
  return {
    runA: makeEntry(),
    runB: makeEntry({ id: "20260501_140000_same" }),
    scoreDelta: 0,
    costDelta: 0,
    durationDelta: 0,
    issuesDelta: 0,
    dimensionDeltas: {},
    newIssues: [],
    resolvedIssues: [],
  };
}

function crossProjectDiff(): RunDiff {
  return {
    runA: makeEntry({ projectName: "demo-shop" }),
    runB: makeEntry({
      id: "20260501_150000",
      projectName: "other-app",
      overallScore: 6,
    }),
    scoreDelta: -1.5,
    costDelta: 0,
    durationDelta: 0,
    issuesDelta: 0,
    dimensionDeltas: {},
    newIssues: [],
    resolvedIssues: [],
  };
}

// ─────────────────────────────────────────────────────────────
// Markdown renderer
// ─────────────────────────────────────────────────────────────

describe("renderDiffMarkdown — structure", () => {
  it("starts with the audit-diff heading and the run-id transition", () => {
    const md = renderDiffMarkdown(regressionDiff());
    expect(md).toMatch(/^## AI Browser Audit Diff/);
    expect(md).toContain("`20260501_120000_main` (baseline) → `20260501_130000_pr` (this run)");
  });

  it("emits a GFM headline-metrics table with all 5 rows", () => {
    const md = renderDiffMarkdown(regressionDiff());
    expect(md).toContain("| Metric | Before | After | Delta |");
    expect(md).toContain("| Overall score |");
    expect(md).toContain("| Issues |");
    expect(md).toContain("| Critical issues |");
    expect(md).toContain("| Cost |");
    expect(md).toContain("| Duration |");
  });

  it("uses ▲/▼ trend arrows with [WARN] polarity for regressions (CLAUDE.md 铁律 #10 — 通知禁 emoji)", () => {
    const md = renderDiffMarkdown(regressionDiff());
    // score down by 0.5 → ▼ + [WARN]
    expect(md).toMatch(/▼ -0\.5 \[WARN\]/);
    // issues up by 3 → ▲ + [WARN] (issues up = bad)
    expect(md).toMatch(/▲ \+3 \[WARN\]/);
  });

  it("flips polarity for improvement (score up → [OK], issues down → [OK])", () => {
    const md = renderDiffMarkdown(improvementDiff());
    expect(md).toMatch(/▲ \+1\.2 \[OK\]/); // score
    expect(md).toMatch(/▼ -4 \[OK\]/); // issues
  });

  it("renders flat delta as em-dash (—) when score and issues are unchanged", () => {
    const md = renderDiffMarkdown(noChangeDiff());
    expect(md).toMatch(/\| Overall score \| 7\.5 \| 7\.5 \| — \|/);
    expect(md).toMatch(/\| Issues \| 5 \| 5 \| — \|/);
  });

  it("emits the per-dimension table when dimensionDeltas is non-empty, sorted by absolute magnitude", () => {
    const md = renderDiffMarkdown(regressionDiff());
    expect(md).toContain("### Per-dimension changes");
    // Sort by |delta|: completion -0.5, localization 0.5, visual_polish 0
    const dimSection = md.split("Per-dimension changes")[1] ?? "";
    expect(dimSection.indexOf("completion")).toBeGreaterThan(0);
    expect(dimSection.indexOf("localization")).toBeGreaterThan(0);
    expect(dimSection.indexOf("visual_polish")).toBeGreaterThan(0);
    // Highest |delta| first
    const completionIdx = dimSection.indexOf("completion");
    const visualIdx = dimSection.indexOf("visual_polish");
    expect(completionIdx).toBeLessThan(visualIdx);
  });

  it("omits per-dimension section when dimensionDeltas is empty", () => {
    const md = renderDiffMarkdown(noChangeDiff());
    expect(md).not.toContain("Per-dimension changes");
  });

  it("emits the new-issues section with severity tags as bold text", () => {
    const md = renderDiffMarkdown(regressionDiff());
    expect(md).toContain("### [NEW] New issues (3)");
    expect(md).toContain("**[critical]** Sign-in CTA overlaps hero image on mobile");
    expect(md).toContain("**[high]** Pricing card missing aria-label");
  });

  it("caps issue lists at maxIssues and adds an '…and N more' line", () => {
    const diff = regressionDiff();
    diff.newIssues = Array.from({ length: 15 }, (_, i) => ({
      severity: "low" as const,
      description: `issue ${i}`,
    }));
    const md = renderDiffMarkdown(diff, { maxIssues: 5 });
    expect((md.match(/\*\*\[low\]\*\*/g) ?? []).length).toBe(5);
    expect(md).toMatch(/_…and 10 more_/);
  });

  it("emits the resolved-issues section with [RESOLVED] heading", () => {
    const md = renderDiffMarkdown(improvementDiff());
    expect(md).toContain("### [RESOLVED] Resolved issues (2)");
    expect(md).toContain("**[critical]** Cart button vanishes on iPad");
  });

  it("emits 'no meaningful UX changes' message when nothing changed", () => {
    const md = renderDiffMarkdown(noChangeDiff());
    expect(md).toContain("_No meaningful UX changes detected between these runs._");
  });

  it("emits a cross-project warning when projectName differs", () => {
    const md = renderDiffMarkdown(crossProjectDiff());
    expect(md).toMatch(/\*\*\[WARN\]\*\* Cross-project diff: `demo-shop` vs `other-app`/);
  });

  it("does NOT emit cross-project warning when projects match", () => {
    const md = renderDiffMarkdown(regressionDiff());
    expect(md).not.toContain("Cross-project diff");
  });

  it("includes a footer with run ids and project name", () => {
    const md = renderDiffMarkdown(regressionDiff());
    expect(md).toContain("Generated by [PixelCheck]");
    expect(md).toContain("`20260501_120000_main` → `20260501_130000_pr`");
  });

  it("can suppress the footer when includeFooter:false", () => {
    const md = renderDiffMarkdown(regressionDiff(), { includeFooter: false });
    expect(md).not.toContain("Generated by");
  });
});

// ─────────────────────────────────────────────────────────────
// HTML renderer
// ─────────────────────────────────────────────────────────────

describe("renderDiffHtml — structure", () => {
  it("starts with <!doctype html> and ends with </html>", () => {
    const html = renderDiffHtml(regressionDiff());
    expect(html).toMatch(/^<!doctype html>/);
    expect(html.trim()).toMatch(/<\/html>$/);
  });

  it("includes the audit-diff title with project name", () => {
    const html = renderDiffHtml(regressionDiff());
    expect(html).toContain("AI Browser Audit Diff — demo-shop");
  });

  it("sets <html lang> to the report locale, not a hardcoded en (H5)", () => {
    expect(renderDiffHtml(regressionDiff())).toContain('<html lang="en">');
    expect(renderDiffHtml(regressionDiff(), { locale: "zh-CN" })).toContain(
      '<html lang="zh-CN">',
    );
  });

  it("emits 5 metric rows in the headline table", () => {
    const html = renderDiffHtml(regressionDiff());
    const headlineSection = html.split("Headline metrics")[1]?.split("</section>")[0] ?? "";
    expect((headlineSection.match(/<tr>/g) ?? []).length).toBe(6); // 1 header + 5 data rows
  });

  it("renders delta with delta-up class for improvements", () => {
    const html = renderDiffHtml(improvementDiff());
    expect(html).toMatch(/<span class="delta up">▲ \+1\.2<\/span>/);
  });

  it("renders delta with delta-down class for regressions", () => {
    const html = renderDiffHtml(regressionDiff());
    expect(html).toMatch(/<span class="delta down">▼ -0\.5<\/span>/);
  });

  it("renders delta with delta-flat for no-change", () => {
    const html = renderDiffHtml(noChangeDiff());
    expect(html).toMatch(/<span class="delta flat">—<\/span>/);
  });

  it("emits new-issues list with severity-coloured class", () => {
    const html = renderDiffHtml(regressionDiff());
    expect(html).toContain('class="issue critical"');
    expect(html).toContain('class="issue high"');
    expect(html).toContain('class="issue medium"');
  });

  it("emits resolved-issues with .issue.resolved class", () => {
    const html = renderDiffHtml(improvementDiff());
    expect(html).toContain('class="issue resolved"');
  });

  it("caps issues at maxIssues and adds a 'more' indicator", () => {
    const diff = regressionDiff();
    diff.newIssues = Array.from({ length: 15 }, (_, i) => ({
      severity: "low" as const,
      description: `issue ${i}`,
    }));
    const html = renderDiffHtml(diff, { maxIssues: 5 });
    expect((html.match(/class="issue low"/g) ?? []).length).toBe(5);
    expect(html).toContain('class="more"');
    expect(html).toContain("…and 10 more");
  });

  it("emits cross-project warning banner when projects differ", () => {
    const html = renderDiffHtml(crossProjectDiff());
    expect(html).toContain('class="warning"');
    expect(html).toContain("Cross-project diff");
  });

  it("emits 'no changes' message when both lists empty and score flat", () => {
    const html = renderDiffHtml(noChangeDiff());
    expect(html).toContain("No meaningful UX changes detected");
  });

  it("escapes HTML-injection in run ids / project names / issue text", () => {
    const evil = regressionDiff();
    evil.runA.id = "<script>alert(1)</script>";
    evil.runA.projectName = "Sales & <Co>";
    evil.newIssues[0]!.description = '<img src=x onerror="alert(1)">';
    const html = renderDiffHtml(evil);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain('<img src=x onerror=');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Sales &amp; &lt;Co&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("includes the footer with run ids", () => {
    const html = renderDiffHtml(regressionDiff());
    expect(html).toMatch(/Generated by PixelCheck/);
    expect(html).toContain("20260501_120000_main");
    expect(html).toContain("20260501_130000_pr");
  });
});

// ─────────────────────────────────────────────────────────────
// JSON renderer
// ─────────────────────────────────────────────────────────────

describe("renderDiffJson", () => {
  it("emits a JSON envelope with kind + rendered_at + diff", () => {
    const out = JSON.parse(renderDiffJson(regressionDiff()));
    expect(out.kind).toBe("audit_diff");
    expect(typeof out.rendered_at).toBe("string");
    expect(out.diff).toBeDefined();
  });

  it("preserves the RunDiff shape inside .diff", () => {
    const diff = regressionDiff();
    const out = JSON.parse(renderDiffJson(diff)) as { diff: RunDiff };
    expect(out.diff.scoreDelta).toBe(-0.5);
    expect(out.diff.newIssues).toHaveLength(3);
    expect(out.diff.runA.id).toBe("20260501_120000_main");
  });

  it("rendered_at is a valid ISO-8601 timestamp", () => {
    const out = JSON.parse(renderDiffJson(regressionDiff())) as { rendered_at: string };
    expect(out.rendered_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Number.isFinite(new Date(out.rendered_at).getTime())).toBe(true);
  });

  it("is parseable JSON (round-trip stable)", () => {
    const text = renderDiffJson(regressionDiff());
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// Text renderer
// ─────────────────────────────────────────────────────────────

describe("renderDiffText", () => {
  it("emits the canonical 'Diff: A -> B' header", () => {
    const out = renderDiffText(regressionDiff());
    expect(out).toMatch(/^Diff: 20260501_120000_main -> 20260501_130000_pr$/m);
  });

  it("includes 4 headline metric lines", () => {
    const out = renderDiffText(regressionDiff());
    expect(out).toContain("Overall Score:");
    expect(out).toContain("Issues:");
    expect(out).toContain("Cost:");
    expect(out).toContain("Duration:");
  });

  it("emits dimension deltas when present", () => {
    const out = renderDiffText(regressionDiff());
    expect(out).toContain("Dimension deltas:");
    expect(out).toMatch(/completion: -0\.5/);
  });

  it("omits dimension deltas when empty", () => {
    const out = renderDiffText(noChangeDiff());
    expect(out).not.toContain("Dimension deltas:");
  });

  it("emits new-issues and resolved-issues sections capped at 10", () => {
    const out = renderDiffText(improvementDiff());
    expect(out).toContain("Resolved issues (2):");
  });

  it("contains no ANSI colour escape sequences (file-redirection safe)", () => {
    const out = renderDiffText(regressionDiff());
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\[/);
  });
});

// ─────────────────────────────────────────────────────────────
// writeDiffReport — disk-write helper
// ─────────────────────────────────────────────────────────────

describe("writeDiffReport", () => {
  it("writes Markdown when format='markdown'", () => {
    const out = writeDiffReport(
      regressionDiff(),
      path.join(tmp, "diff.md"),
      "markdown",
    );
    expect(out).toBe(path.join(tmp, "diff.md"));
    const content = fs.readFileSync(out, "utf8");
    expect(content).toMatch(/^## AI Browser Audit Diff/);
  });

  it("writes HTML when format='html'", () => {
    const out = writeDiffReport(
      regressionDiff(),
      path.join(tmp, "diff.html"),
      "html",
    );
    const content = fs.readFileSync(out, "utf8");
    expect(content).toMatch(/^<!doctype html>/);
  });

  it("writes JSON when format='json'", () => {
    const out = writeDiffReport(
      regressionDiff(),
      path.join(tmp, "diff.json"),
      "json",
    );
    const content = fs.readFileSync(out, "utf8");
    expect(JSON.parse(content).kind).toBe("audit_diff");
  });

  it("writes text when format='text'", () => {
    const out = writeDiffReport(
      regressionDiff(),
      path.join(tmp, "diff.txt"),
      "text",
    );
    const content = fs.readFileSync(out, "utf8");
    expect(content).toMatch(/^Diff:/);
  });

  it("infers format from .md extension when format is omitted", () => {
    const out = writeDiffReport(regressionDiff(), path.join(tmp, "x.md"));
    const content = fs.readFileSync(out, "utf8");
    expect(content).toMatch(/^## AI Browser Audit Diff/);
  });

  it("infers format from .html extension when format is omitted", () => {
    const out = writeDiffReport(regressionDiff(), path.join(tmp, "x.html"));
    const content = fs.readFileSync(out, "utf8");
    expect(content).toMatch(/^<!doctype html>/);
  });

  it("infers format from .json extension when format is omitted", () => {
    const out = writeDiffReport(regressionDiff(), path.join(tmp, "x.json"));
    const content = fs.readFileSync(out, "utf8");
    expect(JSON.parse(content).kind).toBe("audit_diff");
  });

  it("falls back to text when extension is unknown", () => {
    const out = writeDiffReport(regressionDiff(), path.join(tmp, "x.xyz"));
    const content = fs.readFileSync(out, "utf8");
    expect(content).toMatch(/^Diff:/);
  });

  it("creates parent directories when missing", () => {
    const nested = path.join(tmp, "a", "b", "c", "diff.md");
    expect(fs.existsSync(path.dirname(nested))).toBe(false);
    writeDiffReport(regressionDiff(), nested, "markdown");
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("returns absolute path even when called with a relative one", () => {
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      const out = writeDiffReport(regressionDiff(), "diff.md", "markdown");
      expect(path.isAbsolute(out)).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  it("respects maxIssues option in markdown output", () => {
    const diff = regressionDiff();
    diff.newIssues = Array.from({ length: 20 }, (_, i) => ({
      severity: "low" as const,
      description: `issue ${i}`,
    }));
    const out = writeDiffReport(diff, path.join(tmp, "x.md"), "markdown", {
      maxIssues: 3,
    });
    const content = fs.readFileSync(out, "utf8");
    expect(content).toMatch(/_…and 17 more_/);
  });
});

// ─────────────────────────────────────────────────────────────
// escapeHtml
// ─────────────────────────────────────────────────────────────

describe("renderDiff — i18n integration (M2-4)", () => {
  it("renders Markdown diff in zh-CN", () => {
    const md = renderDiffMarkdown(regressionDiff(), { locale: "zh-CN" });
    expect(md).toContain("## AI 浏览器审计差异");
    expect(md).toContain("（基准）");
    expect(md).toContain("（本次）");
    expect(md).toContain("| 指标 | 之前 | 之后 | 差异 |");
    expect(md).toContain("总评分");
    expect(md).toContain("各维度变化");
    expect(md).toContain("[NEW] 新增问题");
    expect(md).toContain("**[严重]**"); // critical → 严重
    expect(md).toContain("**[高]**"); // high → 高
  });

  it("renders Markdown diff in ja", () => {
    const md = renderDiffMarkdown(regressionDiff(), { locale: "ja" });
    expect(md).toContain("## AIブラウザ監査差分");
    expect(md).toContain("（ベースライン）");
    expect(md).toContain("総合スコア");
    expect(md).toContain("**[致命的]**");
  });

  it("renders Markdown diff in es", () => {
    const md = renderDiffMarkdown(improvementDiff(), { locale: "es" });
    expect(md).toContain("## Diferencias de Auditoría AI Browser");
    expect(md).toContain("(referencia)");
    expect(md).toContain("Puntuación general");
    expect(md).toContain("[RESOLVED] Incidencias resueltas");
  });

  it("renders HTML diff in de with German labels", () => {
    const html = renderDiffHtml(regressionDiff(), { locale: "de" });
    expect(html).toContain("KI-Browser-Audit-Differenz");
    expect(html).toContain("Gesamtpunktzahl");
    expect(html).toContain("Kerngrößen"); // Headline metrics
    expect(html).toContain("Änderungen pro Dimension");
  });

  it("translates the no-changes message", () => {
    const md = renderDiffMarkdown(noChangeDiff(), { locale: "zh-CN" });
    expect(md).toContain("两次运行之间未检测到有意义的体验变化");
  });

  it("translates the cross-project warning", () => {
    const md = renderDiffMarkdown(crossProjectDiff(), { locale: "ja" });
    expect(md).toContain("プロジェクト間差分");
  });

  it("preserves the GitHub link in the footer (i18n-independent)", () => {
    const md = renderDiffMarkdown(regressionDiff(), { locale: "zh-CN" });
    expect(md).toContain(
      "[PixelCheck](https://github.com/xcodethink/pixelcheck)",
    );
    expect(md).toContain("由"); // Chinese "Generated by" prefix
  });

  it("default locale renders English", () => {
    const md = renderDiffMarkdown(regressionDiff());
    expect(md).toContain("## AI Browser Audit Diff");
    expect(md).toContain("(baseline)");
    expect(md).toContain("Per-dimension changes");
  });

  it("writeDiffReport propagates locale through to the rendered file", () => {
    const out = writeDiffReport(
      regressionDiff(),
      path.join(tmp, "diff.md"),
      "markdown",
      { locale: "zh-CN" },
    );
    const content = fs.readFileSync(out, "utf8");
    expect(content).toContain("AI 浏览器审计差异");
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml("<a href=\"&q\">'x'</a>")).toBe(
      "&lt;a href=&quot;&amp;q&quot;&gt;&#39;x&#39;&lt;/a&gt;",
    );
  });
});

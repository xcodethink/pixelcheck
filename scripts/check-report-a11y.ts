#!/usr/bin/env tsx
/**
 * Run this project's own accessibility engine against this project's own
 * reports.
 *
 * pixelcheck ships an accessibility auditor. Its reports were never scanned by
 * it. The 2026-07-30 audit rendered the trends dashboard and pointed axe-core
 * at it, which returned one serious violation: `.delta.flat` drew `#888` text
 * on the `#fafafa` page background, 3.40:1 against a 4.5:1 requirement. Nine
 * other checks passed, so the markup was broadly sound — the gap was that
 * nothing was looking.
 *
 * Worth recording, because it is the trap this gate exists to close: the
 * obvious fix is `#767676`, the grey usually quoted as "minimum compliant".
 * That figure is against white. These pages are `#fafafa`, where it lands at
 * 4.35:1 and still fails. Computing the ratio against the real background is
 * the only way to know, and this gate does it on the rendered page rather than
 * on the stylesheet.
 *
 * Scope: every HTML report this project produces. An earlier version of this
 * gate covered only the trends dashboard and recorded the other two as needing
 * "a completed run" — which turned out to be an assumption nobody had checked.
 * `writeHtmlReport` and `writeSpaReport` take a plain `AuditRun` object and a
 * directory, exactly as their unit tests already demonstrated, so a fixture is
 * enough. Recording a limitation without testing it is how a gate quietly
 * covers a third of what it appears to.
 *
 * What this still does not cover, so the number is not read as more than it
 * is: axe sees the DOM as rendered. The SPA explorer has filters and expandable
 * rows whose states are never entered here, and no report is checked after a
 * theme toggle. A clean run means the initial render of three reports is clean.
 *
 * Exits 0 (no violations) / 1 (violations found).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium } from "playwright";
import { renderTrendsHtml } from "../src/core/reporter-trends.js";
import { writeHtmlReport } from "../src/core/reporter.js";
import { writeSpaReport } from "../src/core/reporter-spa.js";
import type { AuditRun } from "../src/core/types.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** WCAG 2.1 A + AA. The level the project's own docs claim to hold others to. */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

interface AxeNode {
  target: string[];
  html: string;
  failureSummary?: string;
}
interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: AxeNode[];
}

/**
 * A minimal but representative run: one passing scenario with scores, one
 * issue, and a step list. Enough for every report to render its tables,
 * badges and status colours, which is where contrast problems live.
 */
function sampleAudit(): AuditRun {
  const now = new Date("2026-07-31T00:00:00.000Z").toISOString();
  return {
    run_id: "a11y-gate",
    project_name: "sample-project",
    base_url: "https://sample.example",
    started_at: now,
    finished_at: now,
    duration_ms: 1000,
    results: [
      {
        scenario_id: "s1",
        scenario_name: "Signup",
        persona_id: "p1",
        persona_display_name: "US Desktop",
        started_at: now,
        finished_at: now,
        duration_ms: 500,
        status: "pass_with_issues",
        fingerprint_id: "fp-1",
        steps: [
          { step_id: "s1-visit", step_type: "visit", status: "pass", duration_ms: 200, retries_used: 0 },
          { step_id: "s1-act", step_type: "act", status: "fail", duration_ms: 300, retries_used: 1 },
        ],
        scores: [
          { dimension: "completion", score: 9.0, justification: "reached the goal" },
          { dimension: "visual_polish", score: 6.5, justification: "spacing is uneven" },
        ],
        overall_score: 7.8,
        issues: [
          { severity: "critical", description: "Payment button unreachable on mobile", recommendation: "raise the tap target" },
          { severity: "medium", description: "Button alignment off", recommendation: "fix CSS" },
        ],
        artifacts: {},
        cost_usd: 0.02,
      },
    ],
    summary: {
      total: 1,
      pass: 0,
      pass_with_issues: 1,
      fail: 0,
      total_cost_usd: 0.02,
      total_issues: 2,
      critical_issues: 1,
    },
    config: {} as AuditRun["config"],
  } as AuditRun;
}

async function buildPages(dir: string): Promise<Array<{ name: string; file: string }>> {
  const pages: Array<{ name: string; file: string }> = [];

  const historyRaw = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "tests/fixtures/history-100-runs.json"), "utf8"),
  );
  const runs = Array.isArray(historyRaw)
    ? historyRaw
    : (historyRaw.runs ?? historyRaw.entries ?? []);

  const trends = path.join(dir, "trends.html");
  fs.writeFileSync(
    trends,
    renderTrendsHtml(runs.slice(0, 30) as never),
    "utf8",
  );
  pages.push({ name: "trends dashboard", file: trends });

  const audit = sampleAudit();
  pages.push({ name: "audit report", file: writeHtmlReport(audit, dir) });
  pages.push({ name: "audit explorer (SPA)", file: writeSpaReport(audit, dir) });

  return pages;
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixelcheck-a11y-"));
  const axeSource = fs.readFileSync(
    path.join(REPO_ROOT, "node_modules/axe-core/axe.min.js"),
    "utf8",
  );

  let total = 0;
  const browser = await chromium.launch();
  try {
    const pages = await buildPages(dir);

    for (const { name, file } of pages) {
      const page = await browser.newPage();
      await page.goto(`file://${file}`);
      await page.addScriptTag({ content: axeSource });
      const result = (await page.evaluate(async (tags) => {
        // @ts-expect-error axe is injected above, not imported
        return await window.axe.run(document, {
          runOnly: { type: "tag", values: tags },
        });
      }, TAGS)) as { violations: AxeViolation[]; passes: unknown[] };

      const { violations, passes } = result;
      total += violations.length;

      process.stdout.write(
        `report-a11y: ${name} — ${violations.length} violation(s), ${passes.length} check(s) passed\n`,
      );
      for (const v of violations) {
        process.stderr.write(`  [${v.impact}] ${v.id} — ${v.help}\n`);
        for (const n of v.nodes) {
          process.stderr.write(`      at ${n.target.join(" ")}\n`);
          process.stderr.write(`      ${n.html.slice(0, 120)}\n`);
          if (n.failureSummary) {
            process.stderr.write(
              `      ${n.failureSummary.replace(/\n/g, " ").slice(0, 200)}\n`,
            );
          }
        }
      }
      await page.close();
    }
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (total > 0) {
    process.stderr.write(
      `\nERROR: ${total} accessibility violation(s) in this project's own reports.\n` +
        "       This project ships an accessibility auditor; its output holding\n" +
        "       to a lower standard than it asks of the pages it audits is the\n" +
        "       one defect it cannot argue with.\n" +
        "       Contrast must be computed against the real background, not white.\n",
    );
    process.exit(1);
  }
  process.stdout.write("report-a11y check: ok\n");
}

await main();

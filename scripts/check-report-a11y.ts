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
 * Scope: the reports that can be rendered from fixtures without a network or
 * an API key. `audit.html` and the SPA explorer need a completed run, so they
 * are not covered here — see the TODO at the bottom rather than assuming they
 * are clean.
 *
 * Exits 0 (no violations) / 1 (violations found).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium } from "playwright";
import { renderTrendsHtml } from "../src/core/reporter-trends.js";

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
    renderTrendsHtml(runs.slice(0, 30) as never, {} as never),
    "utf8",
  );
  pages.push({ name: "trends dashboard", file: trends });

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

// TODO: audit.html and the SPA explorer need a completed run to render, so
// they are outside this gate. They are unscanned, not known-clean.
await main();

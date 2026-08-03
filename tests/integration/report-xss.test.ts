import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeHtmlReport } from "../../src/core/reporter.js";
import { writeSpaReport } from "../../src/core/reporter-spa.js";
import type { AuditRun } from "../../src/core/types.js";

/**
 * The reports must not execute anything from the audit they render, checked
 * in a browser.
 *
 * There is a string-level test for this in `tests/report-escaping.test.ts`,
 * and on its own it is not enough. The SPA embeds the audit as JSON in a
 * script tag with `<` written `<`, then builds its DOM at runtime from
 * the parsed object — so a payload that reaches an `innerHTML` sink never
 * appears verbatim in the file, and no assertion about the file's text can
 * see it.
 *
 * That is not hypothetical. Verifying the string test red found it: removing
 * the escaping from
 *
 *   '<span class="status-badge status-' + status + '">'
 *
 * left every string assertion passing. Chromium caught it, and Chromium had
 * already been what found the sink in the first place — the text beside it
 * was escaped, and a grep for `x.y` interpolation does not match a bare
 * variable.
 *
 * Before the fix: three executions in `audit.html`, six in
 * `audit-explorer.html`.
 */

const NOW = "2026-08-04T00:00:00.000Z";

/** Each shape lands somewhere different: text, attribute, script context. */
const PAYLOADS: Array<[string, string]> = [
  ["double-quoted attribute", `"><img src=x onerror="window.__XSS=(window.__XSS||0)+1">`],
  ["single-quoted attribute", `'><img src=x onerror='window.__XSS=(window.__XSS||0)+1'>`],
  ["unquoted attribute", `x onerror=window.__XSS=(window.__XSS||0)+1 y`],
  ["script close", `</script><img src=x onerror="window.__XSS=(window.__XSS||0)+1">`],
];

function auditWith(payload: string): AuditRun {
  return {
    run_id: payload,
    project_name: payload,
    base_url: "https://example.test/",
    started_at: NOW,
    finished_at: NOW,
    duration_ms: 1,
    results: [
      {
        scenario_id: payload,
        scenario_name: payload,
        persona_id: payload,
        persona_display_name: payload,
        started_at: NOW,
        finished_at: NOW,
        duration_ms: 1,
        status: payload,
        fingerprint_id: payload,
        steps: [
          {
            step_id: payload,
            step_type: payload,
            status: payload,
            duration_ms: 1,
            retries_used: 0,
            error: payload,
            execution_method: payload,
          },
        ],
        scores: [{ dimension: payload, score: 5, justification: payload }],
        overall_score: 5,
        issues: [
          { severity: payload, description: payload, recommendation: payload },
        ],
        artifacts: {},
        cost_usd: 0,
      },
    ],
    summary: {
      total: 1,
      pass: 0,
      pass_with_issues: 1,
      fail: 0,
      total_cost_usd: 0,
      total_issues: 1,
      critical_issues: 0,
    },
    config: {} as AuditRun["config"],
  } as unknown as AuditRun;
}

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

/** Opens the file, expands every unit so each renderer runs, reports the count. */
async function executionsIn(file: string): Promise<{ fired: number; units: number }> {
  const page = await browser.newPage();
  try {
    await page.goto("file://" + file);
    await page.waitForTimeout(600);
    // Collapsed units never render their step tables or issue lists, and
    // those are where most of the sinks are.
    await page.evaluate(() =>
      (window as unknown as { expandAll?: () => void }).expandAll?.(),
    );
    await page.waitForTimeout(600);
    return {
      fired: await page.evaluate(
        () => (window as unknown as { __XSS?: number }).__XSS ?? 0,
      ),
      units: await page.evaluate(
        () => document.querySelectorAll(".unit, .issue").length,
      ),
    };
  } finally {
    await page.close();
  }
}

describe.each(PAYLOADS)("a %s payload", (_label, payload) => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-xss-"));
    writeHtmlReport(auditWith(payload) as never, dir);
    writeSpaReport(auditWith(payload) as never, dir);
  });

  it("does not execute in audit.html", async () => {
    expect((await executionsIn(path.join(dir, "audit.html"))).fired).toBe(0);
  });

  it("does not execute in audit-explorer.html", async () => {
    expect(
      (await executionsIn(path.join(dir, "audit-explorer.html"))).fired,
    ).toBe(0);
  });

  it("still renders the report", async () => {
    // Escaping that drops the field would pass the two assertions above and
    // leave the user with an empty report. Both files must still show the
    // unit and its issue.
    for (const name of ["audit.html", "audit-explorer.html"]) {
      expect((await executionsIn(path.join(dir, name))).units).toBeGreaterThan(0);
    }
  });
});

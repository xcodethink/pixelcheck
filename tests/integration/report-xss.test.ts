import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeHtmlReport } from "../../src/core/reporter.js";
import { writeSpaReport } from "../../src/core/reporter-spa.js";
import { ObserverServer } from "../../src/observer/server.js";
import { SessionStore } from "../../src/observer/session-store.js";
import { AgentEventBus } from "../../src/agent/events.js";
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

/**
 * The observer dashboard renders live event data into the page, so it belongs
 * to the same question as the reports above: can what it displays execute.
 *
 * It could. `getTagLabel(evt.type)` returns `type.split(':')[1].toUpperCase()`
 * and was interpolated unescaped, and a payload in the event type produced a
 * real `<img onerror=…>` element in the DOM. Nothing ran, but only because
 * that `.toUpperCase()` had mangled `window.__XSS` into `WINDOW.__XSS`. An
 * accident is not a defence.
 *
 * Two other sinks were unescaped and are not reachable today: the detail
 * drawer's `step.status`, which `deriveTimeline` computes as one of "fail",
 * "warn" or "ok", and `step.timestamp`, which `emitEvent` sets from
 * `toISOString()`. They are escaped anyway — the reachability argument is
 * what failed in the reports.
 *
 * The page also had two functions called `escapeHtml` in one script scope.
 * The later declaration wins, so the earlier one — which escaped only
 * `&`, `<` and `>`, not even the double quote — was dead code that read like
 * it was doing the work. It is gone.
 */
describe("the observer dashboard", () => {
  it("does not execute a payload carried in an event type", async () => {
    // Both quote styles, because the escaper's replacement map has to cover
    // every character in its own character class. A class listing `'` with no
    // `'` entry in the map substitutes the string "undefined" — verified by
    // removing that entry, which a double-quote-only payload does not catch.
    const payload = `"'><img src=x onerror="window.__XSS=(window.__XSS||0)+1">`;
    const bus = new AgentEventBus("s");
    const store = new SessionStore("s");
    store.attach(bus);
    const server = new ObserverServer({ eventBus: bus, sessionStore: store, port: 0 });
    await server.start();

    bus.emitEvent((`step:${payload}`) as never, {
      step_id: "a",
      step_type: payload,
      status: payload,
      instruction: payload,
      duration_ms: 1,
    });
    bus.emitEvent("step:complete" as never, { step_id: "a", status: payload });

    const page = await browser.newPage();
    try {
      await page.goto(server.url, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      // Open the detail drawer, which is where the other two sinks live.
      await page.evaluate(() =>
        document.querySelector<HTMLElement>(".tl-step, [class*=tl-]")?.click(),
      );
      await page.waitForTimeout(800);

      expect(
        await page.evaluate(() => document.querySelectorAll("img[onerror]").length),
      ).toBe(0);
      expect(
        await page.evaluate(() => (window as unknown as { __XSS?: number }).__XSS ?? 0),
      ).toBe(0);
      // The page must still show its events; escaping that dropped the
      // content would satisfy both assertions above.
      expect(
        await page.evaluate(() => document.querySelectorAll("[class*=event-]").length),
      ).toBeGreaterThan(0);
      // The escaper's replacement map must cover every character in its own
      // character class, or it substitutes the string "undefined".
      expect(await page.evaluate(() => document.body.innerText)).not.toContain(
        "undefined",
      );
    } finally {
      await page.close();
      await (server as unknown as { stop?: () => Promise<void> }).stop?.();
    }
  });
});

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeHtmlReport } from "../src/core/reporter.js";
import { writeSpaReport } from "../src/core/reporter-spa.js";
import type { AuditRun } from "../src/core/types.js";

/**
 * Report renderers must escape every field, not only the ones that look
 * dangerous.
 *
 * Free text was escaped throughout — `description`, `justification`,
 * `step_id`, `error`. The enum-typed fields were not: `status`, `severity`,
 * `step_type`, `execution_method`, and the derived class names built from
 * them. That is a coherent decision as long as the object came through the Zod
 * boundary, where `severity` really is `z.enum([...])`.
 *
 * It stops being coherent at the package boundary. `writeHtmlReport` and
 * `writeSpaReport` are both exported from the package index, and
 * `loadAuditReport` is `JSON.parse(raw) as AuditRun` — a cast, with no schema.
 * So a report rendered from an audit.json that did not come from this process
 * reaches those fields directly, and audit.json is exactly the artefact people
 * attach to bug reports and publish from CI.
 *
 * Measured in Chromium before the fix: a payload in those fields executed
 * three times in `audit.html` and six times in `audit-explorer.html`. After
 * it, zero across four payload shapes — double-quoted, single-quoted,
 * unquoted, and `</script>` — with both reports still rendering and no
 * console errors.
 *
 * One of the six SPA sinks was found by the browser and not by reading:
 *
 *   '<span class="status-badge status-' + status + '">' + esc(status…) + '</span>'
 *
 * The text was escaped and the class attribute beside it was not, and a grep
 * for `x.y` interpolation does not match a bare variable. That is the reason
 * the assertions below check rendered output rather than the source.
 */

const NOW = "2026-08-04T00:00:00.000Z";

/**
 * Payloads that contain at least one character escaping is meant to neutralise,
 * so "does not appear verbatim" is a meaningful thing to assert about them.
 *
 * Deliberately not in this list: `x onerror=boom() y`, which contains nothing
 * escapable and therefore survives any correct escaper. It reaches the output
 * inside `<title>Audit Explorer — x onerror=boom() y · …</title>`, which is
 * element text, and every attribute these renderers emit is double-quoted, so
 * there is no unquoted position for it to land in. Chromium agrees: zero
 * executions. Asserting it were absent would be asserting something false
 * about escaping, and the assertion would have to be weakened later by
 * somebody who did not know why it was there.
 */
const PAYLOADS: Array<[string, string]> = [
  ["double-quoted attribute", `"><img src=x onerror="boom()">`],
  ["single-quoted attribute", `'><img src=x onerror='boom()'>`],
  ["script close", `</script><img src=x onerror="boom()">`],
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

function render(payload: string): { html: string; spa: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-escaping-"));
  writeHtmlReport(auditWith(payload) as never, dir);
  writeSpaReport(auditWith(payload) as never, dir);
  return {
    html: fs.readFileSync(path.join(dir, "audit.html"), "utf-8"),
    spa: fs.readFileSync(path.join(dir, "audit-explorer.html"), "utf-8"),
  };
}

describe.each(PAYLOADS)("a %s payload", (_label, payload) => {
  it("never reaches audit.html unescaped", () => {
    expect(render(payload).html).not.toContain(payload);
  });

  it("never reaches audit-explorer.html unescaped", () => {
    // The SPA embeds the data as JSON in a script tag, where `<` is written
    // `<`, so the raw payload must not appear in either form.
    const { spa } = render(payload);
    expect(spa).not.toContain(payload);
  });
});

describe("what the renderers must still do", () => {
  it("keeps the escaped text readable rather than dropping it", () => {
    // A renderer that satisfied the assertions above by discarding the field
    // would be worse than the defect: the report would silently lose content.
    const { html, spa } = render(`<b>bold</b>`);
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(spa).toContain("bold");
  });

  it("still produces a report of a plausible size", () => {
    const { html, spa } = render("pass");
    expect(html.length).toBeGreaterThan(1000);
    expect(spa.length).toBeGreaterThan(1000);
  });
});

describe("the escaping helpers themselves", () => {
  it("escapes the single quote in both reporters", () => {
    // Three of this repository's eight escapeHtml copies escaped `'` and
    // three did not. An unescaped `'` breaks out of any single-quoted
    // attribute, and the same name meaning different things in different
    // files is how that survived.
    //
    // The SPA is checked with its script block removed. The page carries its
    // own renderer as source, and that source contains string literals like
    // `'<div class="value ' + cls + '">'` which any regex looking for a quote
    // inside a class attribute will match. Those are code, not output — `cls`
    // there is one of four hardcoded values.
    const { html, spa } = render(`it's`);
    expect(html).toContain("&#39;");

    const body = spa.replace(/<script[\s\S]*?<\/script>/g, "");
    expect(body).toContain("&#39;");
    expect(body).not.toMatch(/class="[^"]*'/);
  });
});

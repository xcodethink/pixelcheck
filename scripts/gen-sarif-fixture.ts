/**
 * Generate docs/integration/fixture-sarif.json — committed SARIF fixture
 * for T6 (real axe + GitHub Code Scanning UI verification).
 *
 * Why committed:
 *   - Manual GHCS upload step needs a stable file
 *   - Diff-based audit trail: any renderSarif change shows up as a SARIF
 *     diff in PR review (catches regressions in field shape / ruleId
 *     format / W3C URL slugs)
 *
 * Usage:
 *   npx tsx scripts/gen-sarif-fixture.ts
 *
 * Run when:
 *   - First creation
 *   - renderSarif logic changes (ci-reporters.ts) — review diff before
 *     committing
 *   - WCAG_CATALOG slug logic changes (wcag.ts)
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { renderSarif } from "../src/core/ci-reporters.js";
import type { AuditRun, Issue, ScenarioRunResult } from "../src/core/types.js";

function makeWcagIssue(
  description: string,
  level: "A" | "AA" | "AAA",
  criterion: string,
  axeRule: string,
): Issue {
  return {
    severity: level === "A" ? "high" : "medium",
    description,
    recommendation: `Fix ${axeRule}: ${description}`,
    dimension: "accessibility",
    wcag_level: level,
    wcag_criterion: criterion,
  };
}

const scenario: ScenarioRunResult = {
  scenario_id: "a11y-fixture",
  scenario_name: "WCAG broken fixture",
  persona_id: "us-desktop",
  persona_display_name: "US Desktop User",
  started_at: "2026-05-01T10:00:00.000Z",
  finished_at: "2026-05-01T10:00:30.000Z",
  duration_ms: 30_000,
  status: "fail",
  fingerprint_id: "fp-a11y",
  steps: [
    {
      step_id: "assert-a11y-1",
      step_type: "assert_a11y",
      status: "fail",
      duration_ms: 1500,
      retries_used: 0,
    },
  ],
  scores: [
    { dimension: "accessibility", score: 3.0, justification: "many WCAG fails" },
  ],
  overall_score: 3.0,
  issues: [
    makeWcagIssue("Image missing alt attribute", "A", "1.1.1", "image-alt"),
    makeWcagIssue("Form field missing label", "A", "4.1.2", "label"),
    makeWcagIssue("Low contrast text", "AA", "1.4.3", "color-contrast"),
    makeWcagIssue("Empty button name", "A", "4.1.2", "button-name"),
    makeWcagIssue("Ambiguous link text", "A", "2.4.4", "link-name"),
    makeWcagIssue("Heading order skipped", "AA", "1.3.1", "heading-order"),
  ],
  artifacts: {},
  cost_usd: 0,
};

const audit: AuditRun = {
  schema_version: "1.2.0",
  run_id: "20260501_100000_t6-axe-integ",
  project_name: "wcag-fixture",
  base_url: "file:///tests/fixtures/a11y-broken-page.html",
  started_at: "2026-05-01T10:00:00.000Z",
  finished_at: "2026-05-01T10:00:30.000Z",
  duration_ms: 30_000,
  results: [scenario],
  summary: {
    total: 1,
    pass: 0,
    pass_with_issues: 0,
    fail: 1,
    total_cost_usd: 0,
    total_issues: 6,
    critical_issues: 0,
  },
  config: {} as AuditRun["config"],
};

const sarif = renderSarif(audit);
// Neutralize the tool driver version (mirrors package.json) to a stable
// sentinel so the committed fixture doesn't need a re-pin every release. The
// matching test (wcag-axe.test.ts) normalizes the generated SARIF the same
// way before comparing. The SARIF schema version (top-level) is untouched.
const driver = (sarif as { runs?: Array<{ tool?: { driver?: { version?: string } } }> })
  .runs?.[0]?.tool?.driver;
if (driver && typeof driver.version === "string") {
  driver.version = "0.0.0-fixture";
}
const out = path.join(process.cwd(), "docs/integration/fixture-sarif.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(sarif, null, 2));

const stat = fs.statSync(out);
process.stdout.write(
  `wrote ${out}\n${stat.size} bytes\n${
    sarif.runs[0]?.tool.driver.rules?.length ?? 0
  } rules / ${sarif.runs[0]?.results?.length ?? 0} results\n`,
);

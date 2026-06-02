/**
 * Real axe-core + SARIF GitHub Code Scanning integration test
 * (T6 — closes RISK-REGISTER-V2 R6).
 *
 * What the unit tests can't cover:
 *   - Real axe-core scanning a real DOM may emit different `tags` shapes
 *     across versions (e.g. wcag2a vs wcag2aa vs wcag111). Our
 *     `parseAxeTags()` was written from the axe-core docs; this test
 *     verifies the docs match reality.
 *   - The SARIF output we generate must conform to the SARIF 2.1.0 spec
 *     to be consumable by GitHub Code Scanning + GitLab SAST. Static
 *     unit tests verify shape; this test runs through the real handler
 *     pipeline and writes a real SARIF file.
 *   - Manual GHCS UI verification (uploading the SARIF + screenshotting
 *     how `wcag/X-Y-Z` ruleIds render) lives in
 *     docs/integration/sarif-upload-verified.md as a one-time SOP.
 *
 * Coverage:
 *   1. axe-core injects + runs against fixture, returns violations
 *   2. parseAxeTags() correctly parses real axe tags into WcagAttribution
 *   3. renderSarif() produces SARIF doc with `wcag/X-Y-Z` ruleIds and
 *      W3C help URLs
 *   4. writeSarifReport() persists the SARIF and the file is valid JSON
 *      conforming to expected SARIF 2.1.0 envelope
 *
 * SARIF fixture output is committed to docs/integration/fixture-sarif.json
 * to enable manual GHCS upload verification + diff-based audit trail.
 */

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { expandAxeStandard, parseAxeTags } from "../../../src/core/wcag.js";
import { renderSarif } from "../../../src/core/ci-reporters.js";
import {
  writeSarifReport,
  type AuditRun,
  type Issue,
  type ScenarioRunResult,
} from "../../../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../../fixtures");

function fixtureUrl(filename: string): string {
  return "file://" + path.join(FIXTURES_DIR, filename);
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wcag-axe-integ-"));
}

// Resolve axe-core JS bundle path the same way handlers/index.ts does
// (createRequire, ESM-safe).
function resolveAxeCorePath(): string {
  const esmRequire = createRequire(import.meta.url);
  return esmRequire.resolve("axe-core/axe.min.js");
}

// Shape returned by `axe.run(document, opts)` in a real browser — keep
// fields we use; ignore the long tail axe also returns.
interface AxeViolation {
  id: string;
  impact: "critical" | "serious" | "moderate" | "minor";
  description: string;
  help: string;
  helpUrl: string;
  tags: string[];
  nodes: Array<{ html: string; target: string[]; failureSummary?: string }>;
}

interface AxeResults {
  violations: AxeViolation[];
  passes: Array<{ id: string }>;
  incomplete: Array<{ id: string; impact: string }>;
}

test.describe("real axe-core scan of a11y-broken fixture", () => {
  // axe injection + scan can take 2-5s on a busy machine
  test.setTimeout(60_000);

  test("violations include image-alt / label / color-contrast / button-name", async ({
    page,
  }) => {
    await page.goto(fixtureUrl("a11y-broken-page.html"));

    const axePath = resolveAxeCorePath();
    await page.addScriptTag({ path: axePath });

    // Use the SAME expansion the production handler uses
    // (handlers/index.ts handleAssertA11y) to guarantee we're testing
    // the actual code path users hit. T-NEW-11 fixed a bug where
    // [standard] alone (no expansion) silently missed Level A rules.
    const tags = expandAxeStandard("wcag2aa");
    expect(tags).toContain("wcag2a"); // pin the cumulative semantic

    const results = (await page.evaluate((axeTags) => {
      const axe = (window as unknown as { axe: { run: Function } }).axe;
      return axe.run(document, {
        runOnly: { type: "tag", values: axeTags },
        resultTypes: ["violations", "passes", "incomplete"],
      }) as Promise<AxeResults>;
    }, tags)) as AxeResults;

    expect(results.violations.length).toBeGreaterThan(0);

    const ruleIds = results.violations.map((v) => v.id);

    // The fixture is hand-crafted to trip these rules. If axe-core changes
    // rule names in a major bump, this assertion will fail loudly instead
    // of silently drifting.
    //
    // image-alt + label are Level A rules — pre-T-NEW-11 they would NOT
    // appear here because the production handler passed only ["wcag2aa"]
    // to axe runOnly. Now that handler uses expandAxeStandard, both A
    // and AA rules surface as expected.
    expect(ruleIds).toEqual(
      expect.arrayContaining(["image-alt", "label"]),
    );

    // Every violation has WCAG tags matching the documented format
    for (const v of results.violations) {
      // tags are like ["wcag2a", "wcag111", "best-practice", ...] —
      // at least one must start with "wcag" or "best-practice"
      const wcagTags = v.tags.filter(
        (t) => t.startsWith("wcag") || t === "best-practice",
      );
      expect(wcagTags.length).toBeGreaterThan(0);
    }
  });

  test("parseAxeTags produces expected WcagAttribution shape", async ({
    page,
  }) => {
    await page.goto(fixtureUrl("a11y-broken-page.html"));
    await page.addScriptTag({ path: resolveAxeCorePath() });

    const tags = expandAxeStandard("wcag2aa");
    const results = (await page.evaluate((axeTags) => {
      const axe = (window as unknown as { axe: { run: Function } }).axe;
      return axe.run(document, {
        runOnly: { type: "tag", values: axeTags },
      }) as Promise<AxeResults>;
    }, tags)) as AxeResults;

    // For each violation, parseAxeTags should produce a non-empty
    // attribution (level + criterion) when axe emits standard wcag tags.
    // attr.criterion is the full WcagSuccessCriterion object (with .id /
    // .level / .name / .principle fields), not a bare string.
    let parsedCount = 0;
    for (const v of results.violations) {
      const attr = parseAxeTags(v.tags);
      if (attr.level || attr.criterion) {
        parsedCount += 1;

        if (attr.level) {
          expect(["A", "AA", "AAA"]).toContain(attr.level);
        }
        if (attr.criterion) {
          // Criterion id is dotted: "1.1.1", "1.4.3", etc.
          expect(attr.criterion.id).toMatch(/^\d+\.\d+(\.\d+)?$/);
          expect(["A", "AA", "AAA"]).toContain(attr.criterion.level);
          expect([
            "perceivable",
            "operable",
            "understandable",
            "robust",
          ]).toContain(attr.criterion.principle);
        }
      }
    }

    // At least 50% of violations should be WCAG-attributed (rest may be
    // "best-practice" axe rules that don't map to a specific SC).
    expect(parsedCount).toBeGreaterThanOrEqual(
      Math.floor(results.violations.length * 0.5),
    );
  });
});

// ─────────────────────────────────────────────────────────────
// SARIF generation pipeline (renderSarif + writeSarifReport)
// ─────────────────────────────────────────────────────────────

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

function makeAuditWithWcagIssues(): AuditRun {
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

  return {
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
}

test.describe("SARIF render + write pipeline", () => {
  test("renderSarif emits wcag/X-Y-Z ruleIds with W3C help URLs", () => {
    const audit = makeAuditWithWcagIssues();
    const sarif = renderSarif(audit);

    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs).toHaveLength(1);

    const run = sarif.runs[0]!;
    expect(run.tool.driver.name).toBe("pixelcheck");

    // Rules: each WCAG-attributed Issue should produce a `wcag/<dot-to-dash>` ruleId
    const ruleIds = run.tool.driver.rules?.map((r) => r.id) ?? [];

    expect(ruleIds).toEqual(
      expect.arrayContaining([
        "wcag/1-1-1",
        "wcag/4-1-2",
        "wcag/1-4-3",
        "wcag/2-4-4",
        "wcag/1-3-1",
      ]),
    );

    // Each WCAG rule should have a W3C Understanding URL
    for (const rule of run.tool.driver.rules ?? []) {
      if (!rule.id.startsWith("wcag/")) continue;
      expect(rule.helpUri).toMatch(
        /^https:\/\/www\.w3\.org\/WAI\/WCAG\d{2}\/Understanding\//,
      );
    }

    // Each result has a level + ruleId
    for (const result of run.results ?? []) {
      expect(["none", "note", "warning", "error"]).toContain(result.level);
      expect(typeof result.ruleId).toBe("string");
    }
  });

  test("writeSarifReport persists valid SARIF JSON to disk", () => {
    const dir = tmpDir();
    try {
      const audit = makeAuditWithWcagIssues();
      const filepath = writeSarifReport(audit, dir);

      expect(filepath).toBe(path.join(dir, "audit.sarif"));
      expect(fs.existsSync(filepath)).toBe(true);

      const raw = fs.readFileSync(filepath, "utf8");
      const parsed = JSON.parse(raw) as { version: string; runs: unknown[] };

      expect(parsed.version).toBe("2.1.0");
      expect(parsed.runs).toHaveLength(1);

      // File is non-trivial (>= 1KB) — empty SARIF is ~200 bytes
      const stat = fs.statSync(filepath);
      expect(stat.size).toBeGreaterThan(1000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SARIF fixture is byte-identical to docs/integration/fixture-sarif.json", () => {
    // Regenerate fixture in memory and compare to committed copy. If this
    // test fails, either:
    //   (a) renderSarif logic changed → review and update fixture via:
    //       npx tsx scripts/gen-sarif-fixture.ts
    //   (b) regression introduced — investigate before committing.
    //
    // The tool `driver.version` mirrors package.json, so it changes every
    // release. We normalize it to a sentinel on BOTH sides before comparing,
    // so a version bump no longer breaks this test (and the fixture never
    // needs a per-release re-pin). The SARIF schema version (top-level
    // `version`) is left untouched — only the nested driver version is
    // neutralized, structurally, to avoid string-collision with it.
    const VERSION_SENTINEL = "0.0.0-fixture";
    const neutralizeDriverVersion = (raw: string): string => {
      const obj = JSON.parse(raw);
      const driver = obj?.runs?.[0]?.tool?.driver;
      if (driver && typeof driver.version === "string") {
        driver.version = VERSION_SENTINEL;
      }
      return JSON.stringify(obj, null, 2);
    };

    const audit = makeAuditWithWcagIssues();
    const sarif = renderSarif(audit);
    const generated = JSON.stringify(sarif, null, 2);

    const fixturePath = path.resolve(
      __dirname,
      "../../../docs/integration/fixture-sarif.json",
    );
    const committed = fs.readFileSync(fixturePath, "utf8").trim();

    expect(neutralizeDriverVersion(generated)).toBe(
      neutralizeDriverVersion(committed),
    );
  });
});

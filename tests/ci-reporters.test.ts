/**
 * Tests for src/core/ci-reporters.ts — JUnit XML, SARIF 2.1.0, JSONL,
 * and GitHub Actions workflow-command output writers + CI auto-detect.
 *
 * Each writer is exercised end-to-end against a fixture AuditRun and
 * verified through:
 *   1. structural validity (e.g. SARIF parses + matches the shape that
 *      GitHub Code Scanning expects)
 *   2. severity mapping (critical/high → error, medium → warning,
 *      low → notice/note)
 *   3. redaction (audit.redact_patterns substrings never appear in any
 *      output format)
 *   4. encoding (XML special chars, GHA workflow-command escapes, SARIF
 *      properties roundtrip JSON cleanly)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectCiEnvironment,
  resolveCiFormats,
  CI_FORMATS,
  encodeWorkflowCommandValue,
  escapeXml,
  renderGithubAnnotations,
  renderJsonLines,
  renderJunitXml,
  renderSarif,
  SEVERITY_LEVELS,
  writeGithubAnnotationsReport,
  writeJsonLinesReport,
  writeJunitXmlReport,
  writeSarifReport,
} from "../src/core/ci-reporters.js";
import type { AuditRun, Issue, ScenarioRunResult } from "../src/core/types.js";

let tmp: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ci-rep-"));
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

// ─────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────

function makeIssue(over: Partial<Issue> = {}): Issue {
  return {
    severity: "high",
    description: "Login button not visible above the fold",
    recommendation: "Move the CTA up by 80px",
    dimension: "completion",
    ...over,
  };
}

function makeScenario(over: Partial<ScenarioRunResult> = {}): ScenarioRunResult {
  return {
    scenario_id: "signup",
    scenario_name: "Sign up flow",
    persona_id: "us-desktop",
    persona_display_name: "US Desktop User",
    started_at: "2026-05-01T10:00:00.000Z",
    finished_at: "2026-05-01T10:00:30.000Z",
    duration_ms: 30000,
    status: "fail",
    fingerprint_id: "fp-1",
    steps: [
      {
        step_id: "v1",
        step_type: "visit",
        status: "pass",
        duration_ms: 200,
        retries_used: 0,
      },
    ],
    scores: [
      { dimension: "completion", score: 4.0, justification: "blocked" },
      { dimension: "visual_polish", score: 6.5, justification: "ok" },
    ],
    overall_score: 5.0,
    issues: [makeIssue()],
    artifacts: {},
    cost_usd: 0.05,
    ...over,
  };
}

function makeAudit(over: Partial<AuditRun> = {}): AuditRun {
  return {
    schema_version: "1.2.0",
    run_id: "20260501_100000_smoke",
    project_name: "demo-shop",
    base_url: "https://shop.example",
    started_at: "2026-05-01T10:00:00.000Z",
    finished_at: "2026-05-01T10:00:30.000Z",
    duration_ms: 30000,
    results: [makeScenario()],
    summary: {
      total: 1,
      pass: 0,
      pass_with_issues: 0,
      fail: 1,
      total_cost_usd: 0.05,
      total_issues: 1,
      critical_issues: 0,
    },
    config: {} as AuditRun["config"],
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────
// SEVERITY_LEVELS table sanity
// ─────────────────────────────────────────────────────────────

describe("resolveCiFormats (H7)", () => {
  const noCi: NodeJS.ProcessEnv = {}; // no CI vars set

  it("returns a comma-separated subset verbatim", () => {
    expect(resolveCiFormats("junit,sarif", noCi)).toEqual(
      new Set(["junit", "sarif"]),
    );
  });

  it("'all' expands to every format; 'none' is empty", () => {
    expect(resolveCiFormats("all", noCi)).toEqual(new Set(CI_FORMATS));
    expect(resolveCiFormats("none", noCi)).toEqual(new Set());
  });

  it("auto/unset emits nothing off-CI and everything on-CI", () => {
    expect(resolveCiFormats(undefined, noCi)).toEqual(new Set());
    expect(resolveCiFormats("auto", { GITHUB_ACTIONS: "true" })).toEqual(
      new Set(CI_FORMATS),
    );
  });

  it("THROWS on an unknown token instead of silently dropping it", () => {
    // The bug: `--ci-format saraf` used to yield an empty set → zero CI
    // output → build passes green. Now it must fail loud.
    expect(() => resolveCiFormats("saraf", noCi)).toThrow(/Unknown.*saraf/);
    expect(() => resolveCiFormats("junit,saraf", noCi)).toThrow(/saraf/);
  });
});

describe("SEVERITY_LEVELS — mapping table", () => {
  it("maps critical and high to SARIF error / GHA error", () => {
    expect(SEVERITY_LEVELS.critical).toEqual({ sarif: "error", gha: "error" });
    expect(SEVERITY_LEVELS.high).toEqual({ sarif: "error", gha: "error" });
  });

  it("maps medium to SARIF warning / GHA warning", () => {
    expect(SEVERITY_LEVELS.medium).toEqual({
      sarif: "warning",
      gha: "warning",
    });
  });

  it("maps low to SARIF note / GHA notice (the visibility floor in each tool)", () => {
    expect(SEVERITY_LEVELS.low).toEqual({ sarif: "note", gha: "notice" });
  });
});

// ─────────────────────────────────────────────────────────────
// escapeXml
// ─────────────────────────────────────────────────────────────

describe("escapeXml", () => {
  it("escapes the five XML special characters", () => {
    expect(escapeXml("<a href=\"&q\">'x'</a>")).toBe(
      "&lt;a href=&quot;&amp;q&quot;&gt;&apos;x&apos;&lt;/a&gt;",
    );
  });

  it("returns input unchanged when no special characters present", () => {
    expect(escapeXml("Hello World 123")).toBe("Hello World 123");
  });

  it("coerces non-string input via String()", () => {
    expect(escapeXml(42 as unknown as string)).toBe("42");
  });
});

// ─────────────────────────────────────────────────────────────
// JUnit XML
// ─────────────────────────────────────────────────────────────

describe("JUnit XML writer", () => {
  it("writes junit.xml to runDir and returns the path", () => {
    const audit = makeAudit();
    const p = writeJunitXmlReport(audit, tmp);
    expect(p).toBe(path.join(tmp, "junit.xml"));
    expect(fs.existsSync(p)).toBe(true);
    const xml = fs.readFileSync(p, "utf8");
    expect(xml).toMatch(/^<\?xml version="1.0"/);
  });

  it("groups testcases under per-scenario testsuite elements", () => {
    const a = makeScenario({
      scenario_id: "signup",
      scenario_name: "Sign up",
      persona_id: "us",
      persona_display_name: "US",
    });
    const b = makeScenario({
      scenario_id: "signup",
      scenario_name: "Sign up",
      persona_id: "jp",
      persona_display_name: "JP",
      status: "pass",
      issues: [],
    });
    const c = makeScenario({
      scenario_id: "checkout",
      scenario_name: "Checkout",
      persona_id: "us",
      persona_display_name: "US",
      status: "pass",
      issues: [],
    });
    const audit = makeAudit({ results: [a, b, c] });
    const xml = renderJunitXml(audit);
    // 2 testsuite elements (signup + checkout)
    expect((xml.match(/<testsuite name="/g) ?? []).length).toBe(2);
    expect(xml).toMatch(/<testsuite name="Sign up" tests="2"/);
    expect(xml).toMatch(/<testsuite name="Checkout" tests="1"/);
    // 3 testcase elements total
    expect((xml.match(/<testcase /g) ?? []).length).toBe(3);
  });

  it("emits <failure type=\"error\"> for fail status with the top issue summary", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          status: "fail",
          issues: [
            makeIssue({
              severity: "critical",
              description: "Page crashed on load",
            }),
          ],
        }),
      ],
    });
    const xml = renderJunitXml(audit);
    expect(xml).toMatch(/<failure type="error"/);
    expect(xml).toMatch(/Page crashed on load/);
  });

  it("emits <failure type=\"warning\"> for pass_with_issues status", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          status: "pass_with_issues",
          issues: [makeIssue({ severity: "medium" })],
        }),
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
    });
    const xml = renderJunitXml(audit);
    expect(xml).toMatch(/<failure type="warning"/);
  });

  it("does not emit <failure> for pass status", () => {
    const audit = makeAudit({
      results: [
        makeScenario({ status: "pass", issues: [] }),
      ],
      summary: {
        total: 1,
        pass: 1,
        pass_with_issues: 0,
        fail: 0,
        total_cost_usd: 0,
        total_issues: 0,
        critical_issues: 0,
      },
    });
    const xml = renderJunitXml(audit);
    expect(xml).not.toMatch(/<failure/);
  });

  it("includes overall score + cost in <system-out>", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          status: "pass",
          issues: [],
          overall_score: 8.7,
          cost_usd: 0.123,
        }),
      ],
    });
    const xml = renderJunitXml(audit);
    expect(xml).toMatch(/Overall score: 8\.7/);
    expect(xml).toMatch(/Cost: \$0\.123/);
  });

  it("escapes XML special characters in scenario / persona / issue text", () => {
    const audit = makeAudit({
      project_name: "Sales & <Marketing>",
      results: [
        makeScenario({
          scenario_name: 'A & B',
          persona_display_name: '<JP>',
          issues: [makeIssue({ description: 'Quote " & angle <tag>' })],
        }),
      ],
    });
    const xml = renderJunitXml(audit);
    expect(xml).toContain("Sales &amp; &lt;Marketing&gt;");
    expect(xml).toContain("A &amp; B");
    expect(xml).toContain("&lt;JP&gt;");
    expect(xml).toContain("Quote &quot; &amp; angle &lt;tag&gt;");
    // Raw injection must not survive
    expect(xml).not.toContain("Sales & <Marketing>");
  });

  it("emits a well-formed empty document when results is empty", () => {
    const audit = makeAudit({
      results: [],
      summary: {
        total: 0,
        pass: 0,
        pass_with_issues: 0,
        fail: 0,
        total_cost_usd: 0,
        total_issues: 0,
        critical_issues: 0,
      },
    });
    const xml = renderJunitXml(audit);
    expect(xml).toMatch(/^<\?xml/);
    expect(xml).toMatch(/<testsuites name="demo-shop" tests="0"/);
    expect(xml).not.toMatch(/<testsuite /);
  });

  it("redacts secrets from issue descriptions", () => {
    const audit = makeAudit({
      redact_patterns: ["sk-ant-secret-9999"],
      results: [
        makeScenario({
          issues: [
            makeIssue({
              description: "Saw token sk-ant-secret-9999 in the page",
            }),
          ],
        }),
      ],
    });
    const p = writeJunitXmlReport(audit, tmp);
    const xml = fs.readFileSync(p, "utf8");
    expect(xml).not.toContain("sk-ant-secret-9999");
    expect(xml).toContain("[REDACTED]");
  });
});

// ─────────────────────────────────────────────────────────────
// SARIF 2.1.0
// ─────────────────────────────────────────────────────────────

describe("SARIF 2.1.0 writer", () => {
  it("writes audit.sarif to runDir and returns the path", () => {
    const p = writeSarifReport(makeAudit(), tmp);
    expect(p).toBe(path.join(tmp, "audit.sarif"));
    expect(fs.existsSync(p)).toBe(true);
  });

  it("emits a valid v2.1.0 envelope with $schema + version + runs", () => {
    const sarif = renderSarif(makeAudit());
    expect(sarif.$schema).toBe(
      "https://docs.oasis-open.org/sarif/sarif/v2.1.0/cos02/schemas/sarif-schema-2.1.0.json",
    );
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0].tool.driver.name).toBe("pixelcheck");
    // Version is read dynamically from package.json — assert non-empty
    // semver-shaped string instead of pinning to a specific release.
    expect(sarif.runs[0].tool.driver.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("emits one result per issue with severity-mapped level", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          issues: [
            makeIssue({ severity: "critical" }),
            makeIssue({ severity: "high" }),
            makeIssue({ severity: "medium" }),
            makeIssue({ severity: "low" }),
          ],
        }),
      ],
    });
    const sarif = renderSarif(audit);
    const results = sarif.runs[0].results;
    expect(results).toHaveLength(4);
    expect(results.map((r) => r.level)).toEqual([
      "error",
      "error",
      "warning",
      "note",
    ]);
  });

  it("uses wcag/X-Y-Z ruleId for accessibility issues with WCAG attribution (M2-2)", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          issues: [
            makeIssue({
              severity: "high",
              dimension: "accessibility",
              wcag_level: "AA",
              wcag_criterion: "1.4.3",
            }),
            makeIssue({
              severity: "critical",
              dimension: "accessibility",
              wcag_level: "A",
              wcag_criterion: "2.1.1",
            }),
          ],
        }),
      ],
    });
    const sarif = renderSarif(audit);
    const ruleIds = sarif.runs[0].results.map((r) => r.ruleId);
    expect(ruleIds).toContain("wcag/1-4-3");
    expect(ruleIds).toContain("wcag/2-1-1");
    // No fallback to "audit/accessibility" when WCAG attribution exists
    expect(ruleIds).not.toContain("audit/accessibility");
  });

  it("emits per-WCAG-criterion rule entries with W3C documentation in fullDescription", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          issues: [
            makeIssue({
              severity: "high",
              dimension: "accessibility",
              wcag_level: "AA",
              wcag_criterion: "1.4.3",
            }),
          ],
        }),
      ],
    });
    const sarif = renderSarif(audit);
    const rules = sarif.runs[0].tool.driver.rules;
    const wcagRule = rules.find((r) => r.id === "wcag/1-4-3");
    expect(wcagRule).toBeDefined();
    expect(wcagRule!.shortDescription.text).toContain("Contrast (Minimum)");
    expect(wcagRule!.shortDescription.text).toContain("Level AA");
    expect(wcagRule!.fullDescription.text).toContain(
      "https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum",
    );
  });

  it("falls back to dimension-based ruleId when WCAG attribution is missing", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          issues: [
            makeIssue({
              severity: "medium",
              dimension: "accessibility",
              // no wcag_criterion — e.g. axe best-practice rule
            }),
          ],
        }),
      ],
    });
    const sarif = renderSarif(audit);
    expect(sarif.runs[0].results[0].ruleId).toBe("audit/accessibility");
  });

  it("derives a stable kebab-case ruleId from issue.dimension", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          issues: [
            makeIssue({ dimension: "visual_polish" }),
            makeIssue({ dimension: "completion" }),
          ],
        }),
      ],
    });
    const sarif = renderSarif(audit);
    expect(sarif.runs[0].results[0].ruleId).toBe("audit/visual-polish");
    expect(sarif.runs[0].results[1].ruleId).toBe("audit/completion");
  });

  it("falls back to audit/general-issue when issue.dimension is missing", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          issues: [makeIssue({ dimension: undefined })],
        }),
      ],
    });
    const sarif = renderSarif(audit);
    expect(sarif.runs[0].results[0].ruleId).toBe("audit/general-issue");
  });

  it("dedupes ruleId entries in tool.driver.rules", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          issues: [
            makeIssue({ dimension: "completion" }),
            makeIssue({ dimension: "completion" }),
            makeIssue({ dimension: "visual_polish" }),
          ],
        }),
      ],
    });
    const sarif = renderSarif(audit);
    const ruleIds = sarif.runs[0].tool.driver.rules.map((r) => r.id);
    expect(new Set(ruleIds).size).toBe(ruleIds.length);
    expect(ruleIds.sort()).toEqual([
      "audit/completion",
      "audit/visual-polish",
    ]);
  });

  it("includes scenario + persona + score + cost in result.properties", () => {
    const sarif = renderSarif(makeAudit());
    const props = sarif.runs[0].results[0].properties;
    expect(props.scenario_id).toBe("signup");
    expect(props.persona_id).toBe("us-desktop");
    expect(props.overall_score).toBe(5.0);
    expect(props.cost_usd).toBe(0.05);
    expect(props.severity).toBe("high");
    expect(props.recommendation).toBe("Move the CTA up by 80px");
  });

  it("attaches a synthetic artifactLocation per result for inline annotation", () => {
    const sarif = renderSarif(makeAudit());
    const loc = sarif.runs[0].results[0].locations?.[0]?.physicalLocation
      ?.artifactLocation?.uri;
    expect(loc).toBe("audit/signup/us-desktop");
  });

  it("emits run.properties with run_id + project_name + base_url + summary", () => {
    const sarif = renderSarif(makeAudit());
    const p = sarif.runs[0].properties as {
      run_id: string;
      project_name: string;
      base_url: string;
      summary: { fail: number };
    };
    expect(p.run_id).toBe("20260501_100000_smoke");
    expect(p.project_name).toBe("demo-shop");
    expect(p.base_url).toBe("https://shop.example");
    expect(p.summary.fail).toBe(1);
  });

  it("emits an empty results array when there are no issues", () => {
    const audit = makeAudit({
      results: [makeScenario({ status: "pass", issues: [] })],
    });
    const sarif = renderSarif(audit);
    expect(sarif.runs[0].results).toEqual([]);
  });

  it("redacts secrets from issue descriptions in the SARIF body", () => {
    const audit = makeAudit({
      redact_patterns: ["super-secret-token-aaaa"],
      results: [
        makeScenario({
          issues: [
            makeIssue({
              description: "page leaked super-secret-token-aaaa",
            }),
          ],
        }),
      ],
    });
    const p = writeSarifReport(audit, tmp);
    const text = fs.readFileSync(p, "utf8");
    expect(text).not.toContain("super-secret-token-aaaa");
    expect(text).toContain("[REDACTED]");
  });

  it("accepts a custom tool-driver override (name/version/uri)", () => {
    const sarif = renderSarif(makeAudit(), {
      name: "pixelcheck",
      version: "9.9.9",
      informationUri: "https://example.com",
    });
    expect(sarif.runs[0].tool.driver.name).toBe("pixelcheck");
    expect(sarif.runs[0].tool.driver.version).toBe("9.9.9");
    expect(sarif.runs[0].tool.driver.informationUri).toBe(
      "https://example.com",
    );
  });
});

// ─────────────────────────────────────────────────────────────
// JSONL
// ─────────────────────────────────────────────────────────────

describe("JSONL writer", () => {
  it("writes audit.jsonl to runDir", () => {
    const p = writeJsonLinesReport(makeAudit(), tmp);
    expect(p).toBe(path.join(tmp, "audit.jsonl"));
    expect(fs.existsSync(p)).toBe(true);
  });

  it("first line is a `summary` record carrying the audit-level header", () => {
    const lines = renderJsonLines(makeAudit());
    const head = JSON.parse(lines[0]) as { kind: string; run_id: string };
    expect(head.kind).toBe("summary");
    expect(head.run_id).toBe("20260501_100000_smoke");
  });

  it("emits one `scenario_result` line per audit unit", () => {
    const audit = makeAudit({
      results: [
        makeScenario({ persona_id: "us" }),
        makeScenario({ persona_id: "jp" }),
        makeScenario({ persona_id: "de" }),
      ],
    });
    const lines = renderJsonLines(audit);
    expect(lines).toHaveLength(4); // 1 summary + 3 scenarios
    const kinds = lines.map((l) => (JSON.parse(l) as { kind: string }).kind);
    expect(kinds).toEqual([
      "summary",
      "scenario_result",
      "scenario_result",
      "scenario_result",
    ]);
  });

  it("each line is independently parseable JSON (jq-friendly)", () => {
    const lines = renderJsonLines(makeAudit());
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("ends with a trailing newline", () => {
    const p = writeJsonLinesReport(makeAudit(), tmp);
    const content = fs.readFileSync(p, "utf8");
    expect(content.endsWith("\n")).toBe(true);
  });

  it("redacts secrets in scenario records", () => {
    const audit = makeAudit({
      redact_patterns: ["my-secret-123"],
      results: [
        makeScenario({
          issues: [makeIssue({ description: "saw my-secret-123 in body" })],
        }),
      ],
    });
    const p = writeJsonLinesReport(audit, tmp);
    const content = fs.readFileSync(p, "utf8");
    expect(content).not.toContain("my-secret-123");
    expect(content).toContain("[REDACTED]");
  });
});

// ─────────────────────────────────────────────────────────────
// GitHub Actions workflow commands
// ─────────────────────────────────────────────────────────────

describe("encodeWorkflowCommandValue", () => {
  it("escapes the five characters required by the GHA spec", () => {
    expect(encodeWorkflowCommandValue("a%b")).toBe("a%25b");
    expect(encodeWorkflowCommandValue("a\rb")).toBe("a%0Db");
    expect(encodeWorkflowCommandValue("a\nb")).toBe("a%0Ab");
    expect(encodeWorkflowCommandValue("a:b")).toBe("a%3Ab");
    expect(encodeWorkflowCommandValue("a,b")).toBe("a%2Cb");
  });

  it("escapes percent FIRST so subsequent escapes aren't double-encoded", () => {
    // "a:b" must encode to "a%3Ab", not "a%253Ab"
    expect(encodeWorkflowCommandValue("a:b")).toBe("a%3Ab");
  });

  it("preserves regular ASCII", () => {
    expect(encodeWorkflowCommandValue("Hello World 123")).toBe(
      "Hello World 123",
    );
  });
});

describe("GitHub Actions annotations writer", () => {
  it("writes github-annotations.txt to runDir", () => {
    const p = writeGithubAnnotationsReport(makeAudit(), tmp);
    expect(p).toBe(path.join(tmp, "github-annotations.txt"));
    expect(fs.existsSync(p)).toBe(true);
  });

  it("emits one line per issue with severity-mapped level prefix", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          issues: [
            makeIssue({ severity: "critical" }),
            makeIssue({ severity: "high" }),
            makeIssue({ severity: "medium" }),
            makeIssue({ severity: "low" }),
          ],
        }),
      ],
    });
    const lines = renderGithubAnnotations(audit);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^::error /);
    expect(lines[1]).toMatch(/^::error /);
    expect(lines[2]).toMatch(/^::warning /);
    expect(lines[3]).toMatch(/^::notice /);
  });

  it("emits the workflow-command shape `::level file=…,title=…::message`", () => {
    const lines = renderGithubAnnotations(makeAudit());
    const line = lines[0];
    // file= property — slashes pass through (they're not in GHA's escape
    // table); only %, CR, LF, ':', ',' are encoded
    expect(line).toMatch(/^::error file=audit\/signup\/us-desktop,/);
    expect(line).toContain("title=");
    expect(line).toContain("Login button not visible");
  });

  it("encodes the description→recommendation newline as %0A, not double-encoded %250A (Audit 2026-06-02 H2)", () => {
    const line = renderGithubAnnotations(makeAudit())[0]!;
    expect(line).toContain("%0A"); // a real newline, encoded once
    expect(line).not.toContain("%250A"); // never the double-encoded form
  });

  it("escapes commas / newlines / colons inside the message", () => {
    const audit = makeAudit({
      results: [
        makeScenario({
          issues: [
            makeIssue({
              description: "Found: error, with multiple\nlines",
              recommendation: "Fix: a, b\n c",
            }),
          ],
        }),
      ],
    });
    const lines = renderGithubAnnotations(audit);
    // commas in message → %2C; newlines → %0A; colons → %3A
    expect(lines[0]).toContain("Found%3A");
    expect(lines[0]).toContain("error%2C with multiple");
    // Raw injection of colon/comma/newline in message must not survive
    expect(lines[0]).not.toMatch(/Found: error, with multiple\nlines/);
  });

  it("emits an empty list when there are no issues", () => {
    const audit = makeAudit({
      results: [makeScenario({ status: "pass", issues: [] })],
    });
    expect(renderGithubAnnotations(audit)).toEqual([]);
  });

  it("writes an empty file (no trailing newline) when there are no issues", () => {
    const audit = makeAudit({
      results: [makeScenario({ status: "pass", issues: [] })],
    });
    const p = writeGithubAnnotationsReport(audit, tmp);
    expect(fs.readFileSync(p, "utf8")).toBe("");
  });

  it("redacts secrets in annotation text", () => {
    const audit = makeAudit({
      redact_patterns: ["aws-key-AKIAEXAMPLE"],
      results: [
        makeScenario({
          issues: [
            makeIssue({ description: "Page leaked aws-key-AKIAEXAMPLE in body" }),
          ],
        }),
      ],
    });
    const p = writeGithubAnnotationsReport(audit, tmp);
    const text = fs.readFileSync(p, "utf8");
    expect(text).not.toContain("aws-key-AKIAEXAMPLE");
    expect(text).toContain("[REDACTED]");
  });
});

// ─────────────────────────────────────────────────────────────
// CI environment auto-detection
// ─────────────────────────────────────────────────────────────

describe("detectCiEnvironment", () => {
  it("returns null when no recognised CI flag is set", () => {
    expect(detectCiEnvironment({})).toBeNull();
  });

  it("detects GitHub Actions via GITHUB_ACTIONS=true", () => {
    expect(detectCiEnvironment({ GITHUB_ACTIONS: "true" })).toBe(
      "github-actions",
    );
  });

  it("does not detect GitHub Actions when GITHUB_ACTIONS=false", () => {
    expect(detectCiEnvironment({ GITHUB_ACTIONS: "false" })).toBeNull();
  });

  it("detects GitLab CI via GITLAB_CI=true", () => {
    expect(detectCiEnvironment({ GITLAB_CI: "true" })).toBe("gitlab-ci");
  });

  it("detects CircleCI via CIRCLECI=true", () => {
    expect(detectCiEnvironment({ CIRCLECI: "true" })).toBe("circle-ci");
  });

  it("detects Azure Pipelines via TF_BUILD=True", () => {
    expect(detectCiEnvironment({ TF_BUILD: "True" })).toBe("azure-pipelines");
  });

  it("detects Azure Pipelines via AZURE_HTTP_USER_AGENT", () => {
    expect(
      detectCiEnvironment({ AZURE_HTTP_USER_AGENT: "VSTS_..." }),
    ).toBe("azure-pipelines");
  });

  it("detects Jenkins via JENKINS_URL", () => {
    expect(detectCiEnvironment({ JENKINS_URL: "https://jenkins.example" })).toBe(
      "jenkins",
    );
  });

  it("falls back to generic-ci on bare CI=true / CI=1", () => {
    expect(detectCiEnvironment({ CI: "true" })).toBe("generic-ci");
    expect(detectCiEnvironment({ CI: "1" })).toBe("generic-ci");
  });

  it("does not flag local dev when CI is unset", () => {
    expect(detectCiEnvironment({ NODE_ENV: "development" })).toBeNull();
  });

  it("uses process.env when no env override is passed", () => {
    process.env.GITHUB_ACTIONS = "true";
    expect(detectCiEnvironment()).toBe("github-actions");
  });
});

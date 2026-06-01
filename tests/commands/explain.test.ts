/**
 * Unit tests for src/commands/explain.ts.
 *
 * Covers:
 *  - findLatestReport: resolution from reports/ directory
 *  - runExplain: index-based lookup, dimension-based lookup, empty results,
 *    out-of-range index, related issues grouping
 *  - renderExplainText: human-readable output formatting
 *  - renderExplainJson: machine-readable JSON output
 *  - WCAG-enriched issues: wcag_criterion, wcag_level, wcag_url
 *  - locale support via --locale flag
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuditRun } from "../../src/core/types.js";
import {
  findLatestReport,
  loadAuditReport,
  runExplain,
  renderExplainText,
  renderExplainJson,
  type ExplainResult,
} from "../../src/commands/explain.js";

// ─────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────

function makeAuditFixture(overrides?: Partial<AuditRun>): AuditRun {
  return {
    schema_version: "1.2.0",
    run_id: "2026-05-01_120000_test",
    project_name: "TestProject",
    base_url: "https://example.com",
    started_at: "2026-05-01T12:00:00.000Z",
    finished_at: "2026-05-01T12:05:00.000Z",
    duration_ms: 300000,
    results: [
      {
        scenario_id: "01-smoke",
        scenario_name: "Smoke Test",
        persona_id: "us-english-free-mobile",
        persona_display_name: "Sarah (32, NYC)",
        started_at: "2026-05-01T12:00:00.000Z",
        finished_at: "2026-05-01T12:02:00.000Z",
        duration_ms: 120000,
        status: "pass_with_issues",
        fingerprint_id: "iphone-15-pro",
        steps: [],
        scores: [
          { dimension: "localization", score: 6, justification: "Some issues" },
          { dimension: "visual_polish", score: 8, justification: "Good" },
        ],
        overall_score: 7,
        issues: [
          {
            severity: "high",
            step_id: "home-i18n-check",
            dimension: "localization",
            description: "Placeholder text is in English instead of Japanese",
            recommendation: "Translate the placeholder to Japanese",
          },
          {
            severity: "medium",
            dimension: "localization",
            description: "Currency shown in USD instead of JPY",
            recommendation: "Use locale-appropriate currency formatting",
          },
          {
            severity: "low",
            dimension: "visual_polish",
            description: "Button border radius inconsistent",
            recommendation: "Standardize border-radius to 8px",
          },
        ],
        artifacts: {},
        cost_usd: 0.05,
      },
      {
        scenario_id: "02-a11y",
        scenario_name: "Accessibility Audit",
        persona_id: "us-english-free-mobile",
        persona_display_name: "Sarah (32, NYC)",
        started_at: "2026-05-01T12:02:00.000Z",
        finished_at: "2026-05-01T12:05:00.000Z",
        duration_ms: 180000,
        status: "fail",
        fingerprint_id: "iphone-15-pro",
        steps: [],
        scores: [
          { dimension: "accessibility", score: 4, justification: "Multiple violations" },
        ],
        overall_score: 4,
        issues: [
          {
            severity: "critical",
            step_id: "a11y-scan",
            dimension: "accessibility",
            description: "Images missing alt text",
            recommendation: "Add descriptive alt attributes to all informational images",
            wcag_level: "A",
            wcag_criterion: "1.1.1",
          },
          {
            severity: "high",
            dimension: "accessibility",
            description: "Insufficient color contrast ratio",
            recommendation: "Ensure text meets 4.5:1 contrast ratio",
            wcag_level: "AA",
            wcag_criterion: "1.4.3",
          },
        ],
        artifacts: {},
        cost_usd: 0.08,
      },
    ],
    summary: {
      total: 2,
      pass: 0,
      pass_with_issues: 1,
      fail: 1,
      total_cost_usd: 0.13,
      total_issues: 5,
      critical_issues: 1,
    },
    config: {
      project_name: "TestProject",
      base_url: "https://example.com",
      default_concurrency: 1,
      default_timeout_ms: 30000,
      default_locale: "en",
      models: { default: "claude-sonnet-4-6" },
    } as AuditRun["config"],
  };
}

function makeEmptyAuditFixture(): AuditRun {
  return {
    ...makeAuditFixture(),
    run_id: "2026-05-01_120000_empty",
    results: [
      {
        scenario_id: "00-smoke",
        scenario_name: "Smoke",
        persona_id: "default",
        persona_display_name: "Default",
        started_at: "2026-05-01T12:00:00.000Z",
        finished_at: "2026-05-01T12:01:00.000Z",
        duration_ms: 60000,
        status: "pass",
        fingerprint_id: "desktop",
        steps: [],
        scores: [],
        overall_score: 10,
        issues: [],
        artifacts: {},
        cost_usd: 0,
      },
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
  };
}

// ─────────────────────────────────────────────────────────────
// Test setup
// ─────────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "explain-test-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ─────────────────────────────────────────────────────────────
// findLatestReport
// ─────────────────────────────────────────────────────────────

describe("findLatestReport", () => {
  it("returns null when no reports directory exists", () => {
    const result = findLatestReport([path.join(tmpRoot, "nonexistent")]);
    expect(result).toBeNull();
  });

  it("finds the most recent audit.json by mtime", () => {
    const reportsDir = path.join(tmpRoot, "reports");
    const run1 = path.join(reportsDir, "2026-05-01_run1");
    const run2 = path.join(reportsDir, "2026-05-02_run2");
    fs.mkdirSync(run1, { recursive: true });
    fs.mkdirSync(run2, { recursive: true });

    const audit1 = path.join(run1, "audit.json");
    const audit2 = path.join(run2, "audit.json");
    fs.writeFileSync(audit1, JSON.stringify(makeAuditFixture()));
    fs.writeFileSync(audit2, JSON.stringify(makeAuditFixture()));
    // Pin explicit, distinct mtimes so this exercises mtime ordering rather
    // than relying on wall-clock gaps between two sub-millisecond writes
    // (which collide on fast CI filesystems — the original flake).
    fs.utimesSync(audit1, new Date("2026-05-01T00:00:00Z"), new Date("2026-05-01T00:00:00Z"));
    fs.utimesSync(audit2, new Date("2026-05-02T00:00:00Z"), new Date("2026-05-02T00:00:00Z"));

    const result = findLatestReport([reportsDir]);
    expect(result).toBe(audit2);
  });

  it("breaks mtime ties by lexicographically-greater path (later timestamped run)", () => {
    const reportsDir = path.join(tmpRoot, "reports-tie");
    const run1 = path.join(reportsDir, "2026-05-01_run1");
    const run2 = path.join(reportsDir, "2026-05-02_run2");
    fs.mkdirSync(run1, { recursive: true });
    fs.mkdirSync(run2, { recursive: true });

    const audit1 = path.join(run1, "audit.json");
    const audit2 = path.join(run2, "audit.json");
    fs.writeFileSync(audit1, JSON.stringify(makeAuditFixture()));
    fs.writeFileSync(audit2, JSON.stringify(makeAuditFixture()));
    // Identical mtimes — the tie must resolve deterministically to the
    // later-named (timestamp-prefixed) directory regardless of readdir order.
    const sameTime = new Date("2026-05-01T12:00:00Z");
    fs.utimesSync(audit1, sameTime, sameTime);
    fs.utimesSync(audit2, sameTime, sameTime);

    const result = findLatestReport([reportsDir]);
    expect(result).toBe(audit2);
  });

  it("returns null for empty reports directory", () => {
    const reportsDir = path.join(tmpRoot, "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    const result = findLatestReport([reportsDir]);
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// loadAuditReport
// ─────────────────────────────────────────────────────────────

describe("loadAuditReport", () => {
  it("parses a valid audit.json", () => {
    const filePath = path.join(tmpRoot, "audit.json");
    const fixture = makeAuditFixture();
    fs.writeFileSync(filePath, JSON.stringify(fixture));

    const loaded = loadAuditReport(filePath);
    expect(loaded.run_id).toBe("2026-05-01_120000_test");
    expect(loaded.results).toHaveLength(2);
  });

  it("throws on invalid JSON", () => {
    const filePath = path.join(tmpRoot, "bad.json");
    fs.writeFileSync(filePath, "not json {{{");
    expect(() => loadAuditReport(filePath)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// runExplain — index-based lookup
// ─────────────────────────────────────────────────────────────

describe("runExplain — index lookup", () => {
  it("returns the correct issue for index 0", () => {
    const audit = makeAuditFixture();
    const result = runExplain("0", audit);

    expect(result.matched_issues).toHaveLength(1);
    expect(result.matched_issues[0]!.index).toBe(0);
    expect(result.matched_issues[0]!.description).toContain("English instead of Japanese");
    expect(result.matched_issues[0]!.severity).toBe("high");
    expect(result.matched_issues[0]!.dimension).toBe("localization");
  });

  it("returns the correct issue for the last index", () => {
    const audit = makeAuditFixture();
    const result = runExplain("4", audit);

    expect(result.matched_issues).toHaveLength(1);
    expect(result.matched_issues[0]!.index).toBe(4);
    expect(result.matched_issues[0]!.description).toContain("color contrast");
  });

  it("returns empty matched_issues for out-of-range index", () => {
    const audit = makeAuditFixture();
    const result = runExplain("99", audit);
    expect(result.matched_issues).toHaveLength(0);
  });

  it("includes related issues from same dimension and scenario", () => {
    const audit = makeAuditFixture();
    const result = runExplain("0", audit);

    // Issue 0 is localization in 01-smoke. Related should include:
    // - Issue 1 (same dimension: localization, same scenario)
    // - Issue 2 (same scenario: 01-smoke, different dimension)
    expect(result.related_issues.length).toBeGreaterThanOrEqual(2);
    const relatedIndices = result.related_issues.map((r) => r.index);
    expect(relatedIndices).toContain(1); // same dimension
    expect(relatedIndices).toContain(2); // same scenario
  });

  it("reports total_issues_in_report correctly", () => {
    const audit = makeAuditFixture();
    const result = runExplain("0", audit);
    expect(result.total_issues_in_report).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────
// runExplain — dimension-based lookup
// ─────────────────────────────────────────────────────────────

describe("runExplain — dimension lookup", () => {
  it("matches all issues in a dimension (exact match)", () => {
    const audit = makeAuditFixture();
    const result = runExplain("localization", audit);

    expect(result.matched_issues).toHaveLength(2);
    expect(result.matched_issues.every((i) => i.dimension === "localization")).toBe(true);
  });

  it("matches dimension case-insensitively", () => {
    const audit = makeAuditFixture();
    const result = runExplain("LOCALIZATION", audit);
    expect(result.matched_issues).toHaveLength(2);
  });

  it("matches dimension by partial name", () => {
    const audit = makeAuditFixture();
    const result = runExplain("local", audit);
    expect(result.matched_issues).toHaveLength(2);
  });

  it("returns empty for non-existent dimension", () => {
    const audit = makeAuditFixture();
    const result = runExplain("performance", audit);
    expect(result.matched_issues).toHaveLength(0);
  });

  it("includes related issues from same scenarios but different dimensions", () => {
    const audit = makeAuditFixture();
    const result = runExplain("localization", audit);

    // localization issues are in 01-smoke. Related should include
    // issue 2 (visual_polish in 01-smoke).
    const relatedIndices = result.related_issues.map((r) => r.index);
    expect(relatedIndices).toContain(2);
  });

  it("matches accessibility dimension", () => {
    const audit = makeAuditFixture();
    const result = runExplain("accessibility", audit);
    expect(result.matched_issues).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────
// runExplain — WCAG enrichment
// ─────────────────────────────────────────────────────────────

describe("runExplain — WCAG enrichment", () => {
  it("includes WCAG criterion, level, and URL for accessibility issues", () => {
    const audit = makeAuditFixture();
    const result = runExplain("3", audit); // index 3 = "Images missing alt text" (wcag 1.1.1)

    expect(result.matched_issues).toHaveLength(1);
    const issue = result.matched_issues[0]!;
    expect(issue.wcag_criterion).toBe("1.1.1");
    expect(issue.wcag_level).toBe("A");
    expect(issue.wcag_url).toBeDefined();
    expect(issue.wcag_url).toContain("w3.org");
  });

  it("includes WCAG info in why_it_matters text", () => {
    const audit = makeAuditFixture();
    const result = runExplain("3", audit);

    const issue = result.matched_issues[0]!;
    expect(issue.why_it_matters).toContain("WCAG");
    expect(issue.why_it_matters).toContain("1.1.1");
    expect(issue.why_it_matters).toContain("Non-text Content");
  });

  it("includes WCAG reference URL in how_to_fix for criterion issues", () => {
    const audit = makeAuditFixture();
    const result = runExplain("4", audit); // color contrast (1.4.3)

    const issue = result.matched_issues[0]!;
    expect(issue.how_to_fix).toContain("w3.org");
    expect(issue.wcag_criterion).toBe("1.4.3");
  });
});

// ─────────────────────────────────────────────────────────────
// runExplain — empty report
// ─────────────────────────────────────────────────────────────

describe("runExplain — empty report", () => {
  it("returns zero matched for any query on a report with no issues", () => {
    const audit = makeEmptyAuditFixture();
    const result = runExplain("localization", audit);
    expect(result.matched_issues).toHaveLength(0);
    expect(result.total_issues_in_report).toBe(0);
  });

  it("returns zero matched for index 0 on empty report", () => {
    const audit = makeEmptyAuditFixture();
    const result = runExplain("0", audit);
    expect(result.matched_issues).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// renderExplainText
// ─────────────────────────────────────────────────────────────

describe("renderExplainText", () => {
  it("renders matched issues with severity labels", () => {
    const audit = makeAuditFixture();
    const result = runExplain("0", audit);
    const lines = renderExplainText(result);
    const text = lines.join("\n");

    expect(text).toContain("[#0]");
    expect(text).toContain("HIGH");
    expect(text).toContain("English instead of Japanese");
    expect(text).toContain("Why it matters:");
    expect(text).toContain("How to fix:");
  });

  it("renders 'No matching issues found' for empty matches", () => {
    const audit = makeAuditFixture();
    const result = runExplain("99", audit);
    const lines = renderExplainText(result);
    const text = lines.join("\n");
    expect(text).toContain("No matching issues found");
  });

  it("renders 'No issues found' message for empty report", () => {
    const audit = makeEmptyAuditFixture();
    const result = runExplain("0", audit);
    const lines = renderExplainText(result);
    const text = lines.join("\n");
    expect(text).toContain("No issues found");
  });

  it("renders related issues section", () => {
    const audit = makeAuditFixture();
    const result = runExplain("0", audit);
    const lines = renderExplainText(result);
    const text = lines.join("\n");
    expect(text).toContain("Related");
  });

  it("sorts matched issues by severity (critical first)", () => {
    const audit = makeAuditFixture();
    const result = runExplain("accessibility", audit);
    const lines = renderExplainText(result);
    const text = lines.join("\n");

    const criticalPos = text.indexOf("CRITICAL");
    const highPos = text.indexOf("HIGH");
    expect(criticalPos).toBeLessThan(highPos);
  });

  it("respects locale for labels", () => {
    const audit = makeAuditFixture();
    const result = runExplain("localization", audit);
    const lines = renderExplainText(result, "ja");
    const text = lines.join("\n");

    // Japanese locale should use translated labels
    expect(text).toContain("\u30C7\u30A3\u30E1\u30F3\u30B7\u30E7\u30F3"); // "dimension" in ja
  });

  it("shows tip with valid index range when query misses", () => {
    const audit = makeAuditFixture();
    const result = runExplain("nonexistent_dimension", audit);
    const lines = renderExplainText(result);
    const text = lines.join("\n");
    expect(text).toContain("0\u20134"); // index range hint
  });
});

// ─────────────────────────────────────────────────────────────
// renderExplainJson
// ─────────────────────────────────────────────────────────────

describe("renderExplainJson", () => {
  it("produces valid JSON output", () => {
    const audit = makeAuditFixture();
    const result = runExplain("0", audit);
    const json = renderExplainJson(result);
    const parsed = JSON.parse(json) as ExplainResult;

    expect(parsed.run_id).toBe("2026-05-01_120000_test");
    expect(parsed.query).toBe("0");
    expect(parsed.matched_issues).toHaveLength(1);
    expect(parsed.total_issues_in_report).toBe(5);
  });

  it("includes all ExplainedIssue fields in JSON", () => {
    const audit = makeAuditFixture();
    const result = runExplain("3", audit); // WCAG issue
    const json = renderExplainJson(result);
    const parsed = JSON.parse(json) as ExplainResult;

    const issue = parsed.matched_issues[0]!;
    expect(issue).toHaveProperty("index");
    expect(issue).toHaveProperty("severity");
    expect(issue).toHaveProperty("dimension");
    expect(issue).toHaveProperty("description");
    expect(issue).toHaveProperty("why_it_matters");
    expect(issue).toHaveProperty("how_to_fix");
    expect(issue).toHaveProperty("wcag_criterion");
    expect(issue).toHaveProperty("wcag_level");
    expect(issue).toHaveProperty("wcag_url");
    expect(issue).toHaveProperty("scenario_id");
    expect(issue).toHaveProperty("persona_id");
  });

  it("serializes empty result correctly", () => {
    const audit = makeEmptyAuditFixture();
    const result = runExplain("anything", audit);
    const json = renderExplainJson(result);
    const parsed = JSON.parse(json) as ExplainResult;

    expect(parsed.matched_issues).toHaveLength(0);
    expect(parsed.related_issues).toHaveLength(0);
    expect(parsed.total_issues_in_report).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────

describe("runExplain — edge cases", () => {
  it("handles negative index as dimension search (not numeric)", () => {
    const audit = makeAuditFixture();
    // "-1" is parsed as -1 by parseInt, but String(-1) === "-1" so it IS numeric
    const result = runExplain("-1", audit);
    // -1 is out of range, should return no matches
    expect(result.matched_issues).toHaveLength(0);
  });

  it("handles whitespace in query", () => {
    const audit = makeAuditFixture();
    const result = runExplain("  localization  ", audit);
    expect(result.matched_issues).toHaveLength(2);
  });

  it("handles issue without dimension gracefully", () => {
    const audit = makeAuditFixture();
    // Modify fixture: add an issue without dimension to the end of results[1]
    audit.results[1]!.issues.push({
      severity: "low",
      description: "Generic issue without dimension",
      recommendation: "Fix it",
    });
    // results[0] has 3 issues (indices 0-2), results[1] now has 3 (indices 3-5)
    const result = runExplain("5", audit);
    expect(result.matched_issues).toHaveLength(1);
    expect(result.matched_issues[0]!.dimension).toBeUndefined();
    expect(result.matched_issues[0]!.description).toBe("Generic issue without dimension");
  });
});

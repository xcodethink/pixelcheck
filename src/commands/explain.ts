/**
 * `pixelcheck explain` — look up and explain issues from a recent audit run.
 *
 * Users run audits that produce JSON results with issues. This command
 * provides a human-readable explanation of what an issue means, why it
 * matters (with WCAG references when applicable), how to fix it, and
 * which related issues exist in the same report.
 *
 * Accepts either:
 *   - A dimension name (e.g. "localization") — shows all issues in that dimension
 *   - A zero-based issue index (e.g. "0", "3") — shows that specific issue
 *
 * Flags:
 *   --json       Machine-readable JSON output
 *   --locale     Report language (reuses i18n system)
 *   --report     Path to a specific audit.json (default: most recent in reports/)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AuditRun, Issue } from "../core/types.js";
import { WCAG_CATALOG, wcagHelpUrl, type WcagSuccessCriterion } from "../core/wcag.js";
import { t, type Locale } from "../core/i18n.js";
import { pixelcheckHome } from "../core/home-dir.js";

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

export interface ExplainOptions {
  /** Path to a specific audit.json file. When omitted, the most recent
   *  report in reports/ (or ~/.pixelcheck/) is used. */
  report?: string;
  /** Output machine-readable JSON instead of human text. */
  json?: boolean;
  /** Locale for translated labels (dimension names, severity labels). */
  locale?: Locale;
}

export interface ExplainedIssue {
  /** Zero-based index of the issue within the flattened issue list. */
  index: number;
  severity: Issue["severity"];
  dimension: string | undefined;
  description: string;
  /** Why this issue matters — WCAG reference if applicable. */
  why_it_matters: string;
  /** Concrete fix suggestion. */
  how_to_fix: string;
  /** WCAG criterion id (e.g. "1.4.3") when the issue is accessibility-related. */
  wcag_criterion?: string;
  /** WCAG conformance level (A / AA / AAA) when present. */
  wcag_level?: string;
  /** Deep link to W3C SC documentation. */
  wcag_url?: string;
  /** Scenario + persona context. */
  scenario_id: string;
  persona_id: string;
}

export interface ExplainResult {
  run_id: string;
  query: string;
  matched_issues: ExplainedIssue[];
  related_issues: ExplainedIssue[];
  total_issues_in_report: number;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Flatten all issues across all scenario results into a single list,
 * each decorated with scenario/persona context.
 */
interface FlatIssue {
  issue: Issue;
  scenario_id: string;
  persona_id: string;
}

function flattenIssues(audit: AuditRun): FlatIssue[] {
  const flat: FlatIssue[] = [];
  for (const result of audit.results) {
    for (const issue of result.issues) {
      flat.push({
        issue,
        scenario_id: result.scenario_id,
        persona_id: result.persona_id,
      });
    }
  }
  return flat;
}

/**
 * Build severity rationale text based on severity level.
 */
function severityRationale(severity: Issue["severity"]): string {
  switch (severity) {
    case "critical":
      return "This is a critical issue that blocks core user flows or causes data loss. It should be fixed before the next release.";
    case "high":
      return "This is a high-severity issue that significantly degrades the user experience. Prioritize this in the current sprint.";
    case "medium":
      return "This is a medium-severity issue that affects user experience quality. Schedule for near-term improvement.";
    case "low":
      return "This is a low-severity issue representing a minor polish opportunity. Address when bandwidth allows.";
  }
}

/**
 * Build "why it matters" text, incorporating WCAG reference when available.
 */
function buildWhyItMatters(issue: Issue): string {
  const parts: string[] = [severityRationale(issue.severity)];

  if (issue.wcag_criterion) {
    const sc = WCAG_CATALOG.find((c) => c.id === issue.wcag_criterion);
    if (sc) {
      parts.push(
        `WCAG ${sc.introducedIn} Success Criterion ${sc.id} "${sc.name}" (Level ${sc.level}): ` +
        `Failing this criterion means users with disabilities may be unable to access this content. ` +
        `Level ${sc.level} conformance is ${sc.level === "A" ? "the minimum baseline" : sc.level === "AA" ? "the standard compliance target (required by ADA / EU EAA)" : "an aspirational target"}.`,
      );
    } else {
      parts.push(`WCAG criterion ${issue.wcag_criterion} (Level ${issue.wcag_level ?? "unknown"}).`);
    }
  } else if (issue.dimension === "accessibility") {
    parts.push(
      "Accessibility issues can prevent users with disabilities from accessing your content " +
      "and may expose your organization to legal risk under ADA, Section 508, or the EU European Accessibility Act.",
    );
  } else if (issue.dimension === "localization") {
    parts.push(
      "Localization issues erode trust with international users. Untranslated strings or " +
      "culturally inappropriate content can cause users to abandon the product.",
    );
  } else if (issue.dimension === "visual_regression") {
    parts.push(
      "Visual regressions indicate unintended UI changes that may confuse users or indicate " +
      "a broken deployment. Review the diff image to determine if the change is intentional.",
    );
  }

  return parts.join(" ");
}

/**
 * Build "how to fix" text from the issue's recommendation + dimension context.
 */
function buildHowToFix(issue: Issue): string {
  const parts: string[] = [];

  if (issue.recommendation) {
    parts.push(issue.recommendation);
  }

  if (issue.wcag_criterion) {
    const sc = WCAG_CATALOG.find((c) => c.id === issue.wcag_criterion);
    if (sc) {
      parts.push(`Reference: ${wcagHelpUrl(sc)}`);
    }
  }

  if (parts.length === 0) {
    parts.push("Review the audit report for full context and apply the appropriate fix for your codebase.");
  }

  return parts.join("\n");
}

/**
 * Convert a FlatIssue + index into an ExplainedIssue.
 */
function explainIssue(fi: FlatIssue, index: number): ExplainedIssue {
  const { issue } = fi;
  const sc: WcagSuccessCriterion | undefined = issue.wcag_criterion
    ? WCAG_CATALOG.find((c) => c.id === issue.wcag_criterion)
    : undefined;

  return {
    index,
    severity: issue.severity,
    dimension: issue.dimension,
    description: issue.description,
    why_it_matters: buildWhyItMatters(issue),
    how_to_fix: buildHowToFix(issue),
    wcag_criterion: issue.wcag_criterion,
    wcag_level: issue.wcag_level ?? sc?.level,
    wcag_url: sc ? wcagHelpUrl(sc) : undefined,
    scenario_id: fi.scenario_id,
    persona_id: fi.persona_id,
  };
}

// ─────────────────────────────────────────────────────────────
// Report resolution
// ─────────────────────────────────────────────────────────────

/**
 * Find the most recent audit.json in the given search directories.
 * Scans `reports/` in cwd first, then `~/.pixelcheck/`.
 */
export function findLatestReport(searchDirs?: string[]): string | null {
  const dirs = searchDirs ?? [
    path.join(process.cwd(), "reports"),
    pixelcheckHome(),
  ];

  const candidates: { path: string; mtime: number }[] = [];
  const consider = (candidatePath: string): void => {
    try {
      candidates.push({ path: candidatePath, mtime: fs.statSync(candidatePath).mtimeMs });
    } catch {
      // skip unreadable files
    }
  };

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const auditJson = path.join(dir, entry, "audit.json");
      if (fs.existsSync(auditJson)) consider(auditJson);
      // Also check if the entry itself is an audit.json (flat layout)
      if (entry === "audit.json") consider(path.join(dir, entry));
    }
  }

  if (candidates.length === 0) return null;
  // Newest by mtime; ties broken by lexicographically-greater path. Run dirs are
  // timestamp-prefixed (e.g. `2026-05-02_run2`), so the later run wins. Without
  // this tie-break the result is non-deterministic on fast filesystems where two
  // sibling reports written in the same millisecond share an mtime.
  candidates.sort((a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path));
  return candidates[0].path;
}

/**
 * Load and parse an audit.json file.
 */
export function loadAuditReport(filePath: string): AuditRun {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as AuditRun;
}

// ─────────────────────────────────────────────────────────────
// Core explain logic
// ─────────────────────────────────────────────────────────────

/**
 * Run the explain query against an audit report.
 *
 * @param query  Issue index (e.g. "0") or dimension name (e.g. "localization")
 * @param audit  Parsed audit report
 * @returns ExplainResult with matched and related issues
 */
export function runExplain(query: string, audit: AuditRun): ExplainResult {
  const allFlat = flattenIssues(audit);

  const matched: ExplainedIssue[] = [];
  const related: ExplainedIssue[] = [];

  // Try numeric index first
  const numericIndex = parseInt(query, 10);
  const isNumeric = !isNaN(numericIndex) && String(numericIndex) === query.trim();

  if (isNumeric) {
    if (numericIndex >= 0 && numericIndex < allFlat.length) {
      const target = allFlat[numericIndex]!;
      matched.push(explainIssue(target, numericIndex));

      // Related: same dimension or same scenario
      for (let i = 0; i < allFlat.length; i++) {
        if (i === numericIndex) continue;
        const fi = allFlat[i]!;
        if (
          (target.issue.dimension && fi.issue.dimension === target.issue.dimension) ||
          fi.scenario_id === target.scenario_id
        ) {
          related.push(explainIssue(fi, i));
        }
      }
    }
    // If index out of range, matched stays empty (caller should handle)
  } else {
    // Match by dimension name (case-insensitive, partial match)
    const queryLower = query.toLowerCase().trim();
    for (let i = 0; i < allFlat.length; i++) {
      const fi = allFlat[i]!;
      const dim = fi.issue.dimension?.toLowerCase() ?? "";
      if (dim === queryLower || dim.includes(queryLower)) {
        matched.push(explainIssue(fi, i));
      }
    }

    // Related: issues in other dimensions from the same scenarios
    const matchedScenarios = new Set(matched.map((m) => m.scenario_id));
    const matchedIndices = new Set(matched.map((m) => m.index));
    for (let i = 0; i < allFlat.length; i++) {
      if (matchedIndices.has(i)) continue;
      const fi = allFlat[i]!;
      if (matchedScenarios.has(fi.scenario_id)) {
        related.push(explainIssue(fi, i));
      }
    }
  }

  return {
    run_id: audit.run_id,
    query,
    matched_issues: matched,
    related_issues: related,
    total_issues_in_report: allFlat.length,
  };
}

// ─────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<Issue["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Render an ExplainResult as human-readable text lines.
 */
export function renderExplainText(result: ExplainResult, locale: Locale = "en"): string[] {
  const lines: string[] = [];
  const severityLabel = (s: string) => t(s as "critical" | "high" | "medium" | "low", locale).toUpperCase();

  lines.push(`Run: ${result.run_id}`);
  lines.push(`Query: "${result.query}"`);
  lines.push(`Total issues in report: ${result.total_issues_in_report}`);
  lines.push("");

  if (result.matched_issues.length === 0) {
    lines.push("No matching issues found.");
    lines.push("");
    if (result.total_issues_in_report === 0) {
      lines.push(t("no_issues_found", locale));
    } else {
      lines.push(`Tip: Use an issue index (0–${result.total_issues_in_report - 1}) or a dimension name like "localization", "visual_polish", "accessibility".`);
    }
    return lines;
  }

  // Sort matched by severity
  const sorted = [...result.matched_issues].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );

  lines.push(`--- Matched ${t("issues", locale)} (${sorted.length}) ---`);
  lines.push("");

  for (const issue of sorted) {
    lines.push(`[#${issue.index}] [${severityLabel(issue.severity)}] ${issue.description}`);
    lines.push(`  ${t("dimension", locale)}: ${issue.dimension ?? "n/a"}`);
    lines.push(`  ${t("scenarios", locale)}: ${issue.scenario_id} / ${issue.persona_id}`);
    lines.push("");
    lines.push(`  Why it matters:`);
    for (const part of issue.why_it_matters.split(". ")) {
      if (part.trim()) lines.push(`    ${part.trim()}.`);
    }
    lines.push("");
    lines.push(`  How to fix:`);
    for (const fixLine of issue.how_to_fix.split("\n")) {
      lines.push(`    ${fixLine}`);
    }
    if (issue.wcag_url) {
      lines.push(`  WCAG reference: ${issue.wcag_url}`);
    }
    lines.push("");
    lines.push("  " + "-".repeat(60));
    lines.push("");
  }

  if (result.related_issues.length > 0) {
    lines.push(`--- Related ${t("issues", locale)} (${result.related_issues.length}) ---`);
    lines.push("");
    for (const issue of result.related_issues) {
      lines.push(`  [#${issue.index}] [${severityLabel(issue.severity)}] ${issue.description}`);
      lines.push(`    ${t("dimension", locale)}: ${issue.dimension ?? "n/a"} | ${issue.scenario_id}`);
    }
    lines.push("");
  }

  return lines;
}

/**
 * Render an ExplainResult as a JSON string.
 */
export function renderExplainJson(result: ExplainResult): string {
  return JSON.stringify(result, null, 2);
}

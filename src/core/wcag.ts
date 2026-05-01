/**
 * WCAG 2.1 / 2.2 catalog + axe-core tag parser + grouping utilities.
 *
 * The auditor's `assert_a11y` step (handlers/index.ts) runs axe-core
 * which tags each rule violation with WCAG metadata like
 * `["wcag2aa", "wcag143", "cat.color"]`. Today those tags get flattened
 * into the issue's `recommendation` text — useful for engineers, but
 * useless for the compliance / legal team that asks the actually
 * commercial question:
 *
 *   "Are we WCAG 2.1 AA compliant?"
 *
 * This module turns the flat string tag list into structured data so
 * downstream reports (PDF / SARIF / dashboard) can answer that
 * question by:
 *
 *   - **Conformance level** (A / AA / AAA) — what compliance teams
 *     are actually buying against. ADA case law in the US targets AA;
 *     the EU EAA (effective 2025) targets AA on consumer-facing
 *     products. AAA is aspirational.
 *   - **Principle** (P / O / U / R) — the four pillars of WCAG:
 *     Perceivable / Operable / Understandable / Robust. Helps spot
 *     systemic issues ("we're weak across the board on Perceivable").
 *   - **Success Criterion** (e.g. 1.4.3 Contrast (Minimum)) — the
 *     individual rule. Counted, listed in PDF / SARIF, and used for
 *     SARIF ruleId routing in GitHub Code Scanning.
 *
 * Also exposes:
 *   - `WCAG_CATALOG`: the 50 SC of WCAG 2.1 + the 9 net-new in WCAG 2.2,
 *     each carrying its number / name / level / principle / canonical URL
 *   - `parseAxeTags(tags)`: extract structured WCAG info from a tag list
 *   - `summarizeWcag(issues)`: aggregate per-criterion / per-level /
 *     per-principle counts across an array of Issues
 *   - `wcagSarifRuleId(criterion)`: format SARIF ruleId like `wcag/1-4-3`
 *   - `wcagHelpUrl(criterion)`: deep link to the W3C SC documentation
 */

import type { Issue } from "./types.js";

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

export type WcagLevel = "A" | "AA" | "AAA";

export type WcagPrinciple = "perceivable" | "operable" | "understandable" | "robust";

export interface WcagSuccessCriterion {
  /** Dotted SC number, e.g. "1.4.3" */
  id: string;
  /** Canonical SC name, e.g. "Contrast (Minimum)" */
  name: string;
  level: WcagLevel;
  principle: WcagPrinciple;
  /** WCAG version it was first introduced in (2.0 / 2.1 / 2.2) */
  introducedIn: "2.0" | "2.1" | "2.2";
  /** axe-core's tag for this criterion, e.g. "wcag143" */
  axeTag: string;
}

/**
 * Structured WCAG information extracted from an axe violation.
 * `criterion` is undefined when the rule isn't tied to a specific SC
 * (e.g. an axe best-practice rule).
 */
export interface WcagAttribution {
  level: WcagLevel | undefined;
  /** SC entry (when the axe rule maps to a specific clause) */
  criterion: WcagSuccessCriterion | undefined;
  /** Raw axe tags for diagnostic display (e.g. "wcag2aa", "best-practice") */
  rawTags: string[];
}

// ─────────────────────────────────────────────────────────────
// WCAG catalog
//
// Hand-curated from https://www.w3.org/TR/WCAG22/ (which supersedes
// 2.1 by adding 9 SC). axe-core's tag → SC mapping is the
// "wcag<Major><Minor><Submajor>" pattern: 1.4.3 → wcag143, 2.4.11 → wcag2411.
// Both axeTag and dotted id are kept so callers don't have to compute.
// ─────────────────────────────────────────────────────────────

const WCAG_CATALOG_DATA: ReadonlyArray<WcagSuccessCriterion> = [
  // ── Principle 1 — Perceivable ──
  { id: "1.1.1", name: "Non-text Content", level: "A", principle: "perceivable", introducedIn: "2.0", axeTag: "wcag111" },
  { id: "1.2.1", name: "Audio-only and Video-only (Prerecorded)", level: "A", principle: "perceivable", introducedIn: "2.0", axeTag: "wcag121" },
  { id: "1.2.2", name: "Captions (Prerecorded)", level: "A", principle: "perceivable", introducedIn: "2.0", axeTag: "wcag122" },
  { id: "1.2.3", name: "Audio Description or Media Alternative (Prerecorded)", level: "A", principle: "perceivable", introducedIn: "2.0", axeTag: "wcag123" },
  { id: "1.2.4", name: "Captions (Live)", level: "AA", principle: "perceivable", introducedIn: "2.0", axeTag: "wcag124" },
  { id: "1.2.5", name: "Audio Description (Prerecorded)", level: "AA", principle: "perceivable", introducedIn: "2.0", axeTag: "wcag125" },
  { id: "1.3.1", name: "Info and Relationships", level: "A", principle: "perceivable", introducedIn: "2.0", axeTag: "wcag131" },
  { id: "1.3.2", name: "Meaningful Sequence", level: "A", principle: "perceivable", introducedIn: "2.0", axeTag: "wcag132" },
  { id: "1.3.3", name: "Sensory Characteristics", level: "A", principle: "perceivable", introducedIn: "2.0", axeTag: "wcag133" },
  { id: "1.3.4", name: "Orientation", level: "AA", principle: "perceivable", introducedIn: "2.1", axeTag: "wcag134" },
  { id: "1.3.5", name: "Identify Input Purpose", level: "AA", principle: "perceivable", introducedIn: "2.1", axeTag: "wcag135" },
  { id: "1.4.1", name: "Use of Color", level: "A", principle: "perceivable", introducedIn: "2.0", axeTag: "wcag141" },
  { id: "1.4.2", name: "Audio Control", level: "A", principle: "perceivable", introducedIn: "2.0", axeTag: "wcag142" },
  { id: "1.4.3", name: "Contrast (Minimum)", level: "AA", principle: "perceivable", introducedIn: "2.0", axeTag: "wcag143" },
  { id: "1.4.4", name: "Resize Text", level: "AA", principle: "perceivable", introducedIn: "2.0", axeTag: "wcag144" },
  { id: "1.4.5", name: "Images of Text", level: "AA", principle: "perceivable", introducedIn: "2.0", axeTag: "wcag145" },
  { id: "1.4.6", name: "Contrast (Enhanced)", level: "AAA", principle: "perceivable", introducedIn: "2.0", axeTag: "wcag146" },
  { id: "1.4.10", name: "Reflow", level: "AA", principle: "perceivable", introducedIn: "2.1", axeTag: "wcag1410" },
  { id: "1.4.11", name: "Non-text Contrast", level: "AA", principle: "perceivable", introducedIn: "2.1", axeTag: "wcag1411" },
  { id: "1.4.12", name: "Text Spacing", level: "AA", principle: "perceivable", introducedIn: "2.1", axeTag: "wcag1412" },
  { id: "1.4.13", name: "Content on Hover or Focus", level: "AA", principle: "perceivable", introducedIn: "2.1", axeTag: "wcag1413" },

  // ── Principle 2 — Operable ──
  { id: "2.1.1", name: "Keyboard", level: "A", principle: "operable", introducedIn: "2.0", axeTag: "wcag211" },
  { id: "2.1.2", name: "No Keyboard Trap", level: "A", principle: "operable", introducedIn: "2.0", axeTag: "wcag212" },
  { id: "2.1.4", name: "Character Key Shortcuts", level: "A", principle: "operable", introducedIn: "2.1", axeTag: "wcag214" },
  { id: "2.2.1", name: "Timing Adjustable", level: "A", principle: "operable", introducedIn: "2.0", axeTag: "wcag221" },
  { id: "2.2.2", name: "Pause, Stop, Hide", level: "A", principle: "operable", introducedIn: "2.0", axeTag: "wcag222" },
  { id: "2.3.1", name: "Three Flashes or Below Threshold", level: "A", principle: "operable", introducedIn: "2.0", axeTag: "wcag231" },
  { id: "2.4.1", name: "Bypass Blocks", level: "A", principle: "operable", introducedIn: "2.0", axeTag: "wcag241" },
  { id: "2.4.2", name: "Page Titled", level: "A", principle: "operable", introducedIn: "2.0", axeTag: "wcag242" },
  { id: "2.4.3", name: "Focus Order", level: "A", principle: "operable", introducedIn: "2.0", axeTag: "wcag243" },
  { id: "2.4.4", name: "Link Purpose (In Context)", level: "A", principle: "operable", introducedIn: "2.0", axeTag: "wcag244" },
  { id: "2.4.5", name: "Multiple Ways", level: "AA", principle: "operable", introducedIn: "2.0", axeTag: "wcag245" },
  { id: "2.4.6", name: "Headings and Labels", level: "AA", principle: "operable", introducedIn: "2.0", axeTag: "wcag246" },
  { id: "2.4.7", name: "Focus Visible", level: "AA", principle: "operable", introducedIn: "2.0", axeTag: "wcag247" },
  { id: "2.4.11", name: "Focus Not Obscured (Minimum)", level: "AA", principle: "operable", introducedIn: "2.2", axeTag: "wcag2411" },
  { id: "2.5.1", name: "Pointer Gestures", level: "A", principle: "operable", introducedIn: "2.1", axeTag: "wcag251" },
  { id: "2.5.2", name: "Pointer Cancellation", level: "A", principle: "operable", introducedIn: "2.1", axeTag: "wcag252" },
  { id: "2.5.3", name: "Label in Name", level: "A", principle: "operable", introducedIn: "2.1", axeTag: "wcag253" },
  { id: "2.5.4", name: "Motion Actuation", level: "A", principle: "operable", introducedIn: "2.1", axeTag: "wcag254" },
  { id: "2.5.7", name: "Dragging Movements", level: "AA", principle: "operable", introducedIn: "2.2", axeTag: "wcag257" },
  { id: "2.5.8", name: "Target Size (Minimum)", level: "AA", principle: "operable", introducedIn: "2.2", axeTag: "wcag258" },

  // ── Principle 3 — Understandable ──
  { id: "3.1.1", name: "Language of Page", level: "A", principle: "understandable", introducedIn: "2.0", axeTag: "wcag311" },
  { id: "3.1.2", name: "Language of Parts", level: "AA", principle: "understandable", introducedIn: "2.0", axeTag: "wcag312" },
  { id: "3.2.1", name: "On Focus", level: "A", principle: "understandable", introducedIn: "2.0", axeTag: "wcag321" },
  { id: "3.2.2", name: "On Input", level: "A", principle: "understandable", introducedIn: "2.0", axeTag: "wcag322" },
  { id: "3.2.6", name: "Consistent Help", level: "A", principle: "understandable", introducedIn: "2.2", axeTag: "wcag326" },
  { id: "3.3.1", name: "Error Identification", level: "A", principle: "understandable", introducedIn: "2.0", axeTag: "wcag331" },
  { id: "3.3.2", name: "Labels or Instructions", level: "A", principle: "understandable", introducedIn: "2.0", axeTag: "wcag332" },
  { id: "3.3.7", name: "Redundant Entry", level: "A", principle: "understandable", introducedIn: "2.2", axeTag: "wcag337" },
  { id: "3.3.8", name: "Accessible Authentication (Minimum)", level: "AA", principle: "understandable", introducedIn: "2.2", axeTag: "wcag338" },

  // ── Principle 4 — Robust ──
  { id: "4.1.1", name: "Parsing (Obsolete and Removed)", level: "A", principle: "robust", introducedIn: "2.0", axeTag: "wcag411" },
  { id: "4.1.2", name: "Name, Role, Value", level: "A", principle: "robust", introducedIn: "2.0", axeTag: "wcag412" },
  { id: "4.1.3", name: "Status Messages", level: "AA", principle: "robust", introducedIn: "2.1", axeTag: "wcag413" },
];

/** Public read-only catalog of every supported WCAG SC. */
export const WCAG_CATALOG: ReadonlyArray<WcagSuccessCriterion> = WCAG_CATALOG_DATA;

const WCAG_BY_AXE_TAG = new Map<string, WcagSuccessCriterion>(
  WCAG_CATALOG_DATA.map((sc) => [sc.axeTag, sc]),
);

const WCAG_BY_ID = new Map<string, WcagSuccessCriterion>(
  WCAG_CATALOG_DATA.map((sc) => [sc.id, sc]),
);

/** Lookup an SC by its dotted id ("1.4.3"). */
export function findWcagCriterion(id: string): WcagSuccessCriterion | undefined {
  return WCAG_BY_ID.get(id);
}

// ─────────────────────────────────────────────────────────────
// axe tag parsing
// ─────────────────────────────────────────────────────────────

const LEVEL_TAG_MAP: Record<string, WcagLevel> = {
  wcag2a: "A",
  wcag21a: "A",
  wcag22a: "A",
  wcag2aa: "AA",
  wcag21aa: "AA",
  wcag22aa: "AA",
  wcag2aaa: "AAA",
  wcag21aaa: "AAA",
  wcag22aaa: "AAA",
};

/**
 * Parse axe-core tag list into structured WCAG attribution.
 *
 *   parseAxeTags(["wcag2aa", "wcag143", "cat.color"])
 *   → { level: "AA", criterion: <SC 1.4.3 entry>, rawTags: [...] }
 *
 * Returns `level: undefined` for best-practice / cat.* tags that don't
 * carry a WCAG level. Returns `criterion: undefined` if the tag list
 * doesn't include a recognised wcag<X><Y><Z> SC tag (this happens for
 * axe rules that span multiple criteria — currently 0 in axe 4.x but
 * defensive against future axe releases).
 */
export function parseAxeTags(tags: ReadonlyArray<string>): WcagAttribution {
  let level: WcagLevel | undefined;
  let criterion: WcagSuccessCriterion | undefined;

  for (const tag of tags) {
    const lvl = LEVEL_TAG_MAP[tag];
    if (lvl !== undefined) {
      // Pick the strictest level if multiple (A < AA < AAA in stringency
      // ordering — strict means the criterion applies even at the lower
      // levels). axe usually emits exactly one level tag per rule but
      // we defend against duplicates anyway.
      if (
        level === undefined ||
        (level === "A" && (lvl === "AA" || lvl === "AAA")) ||
        (level === "AA" && lvl === "AAA")
      ) {
        level = lvl;
      }
    }
    const sc = WCAG_BY_AXE_TAG.get(tag);
    if (sc && criterion === undefined) {
      criterion = sc;
    }
  }

  // Derive level from the criterion when only the SC tag was present.
  if (level === undefined && criterion !== undefined) {
    level = criterion.level;
  }

  return { level, criterion, rawTags: [...tags] };
}

// ─────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────

export interface WcagSummary {
  /** Total accessibility issues across all SC */
  totalIssues: number;
  /** Issues by conformance level — "unknown" for issues without a level */
  byLevel: { A: number; AA: number; AAA: number; unknown: number };
  /** Issues by principle */
  byPrinciple: {
    perceivable: number;
    operable: number;
    understandable: number;
    robust: number;
    unknown: number;
  };
  /** Per-criterion breakdown — sorted by issue count desc */
  byCriterion: ReadonlyArray<{
    criterion: WcagSuccessCriterion;
    count: number;
  }>;
  /** Issues that didn't map to any WCAG SC (e.g. axe best-practice rules) */
  unmappedCount: number;
}

/**
 * Aggregate WCAG attribution data across an array of issues.
 *
 * Each issue's `wcag_criterion` and `wcag_level` fields drive the
 * aggregation. Issues without these fields (non-accessibility issues
 * from the vision critic, or accessibility issues whose tags didn't
 * include a recognised SC) are bucketed into `unmappedCount`.
 */
export function summarizeWcag(issues: ReadonlyArray<Issue>): WcagSummary {
  const summary: WcagSummary = {
    totalIssues: 0,
    byLevel: { A: 0, AA: 0, AAA: 0, unknown: 0 },
    byPrinciple: {
      perceivable: 0,
      operable: 0,
      understandable: 0,
      robust: 0,
      unknown: 0,
    },
    byCriterion: [],
    unmappedCount: 0,
  };

  const criterionCounts = new Map<string, number>();

  for (const issue of issues) {
    if (issue.wcag_criterion === undefined && issue.wcag_level === undefined) {
      continue; // non-accessibility issue
    }
    summary.totalIssues++;

    if (issue.wcag_level === "A") summary.byLevel.A++;
    else if (issue.wcag_level === "AA") summary.byLevel.AA++;
    else if (issue.wcag_level === "AAA") summary.byLevel.AAA++;
    else summary.byLevel.unknown++;

    if (issue.wcag_criterion !== undefined) {
      const sc = WCAG_BY_ID.get(issue.wcag_criterion);
      if (sc) {
        summary.byPrinciple[sc.principle]++;
        criterionCounts.set(sc.id, (criterionCounts.get(sc.id) ?? 0) + 1);
      } else {
        summary.byPrinciple.unknown++;
        summary.unmappedCount++;
      }
    } else {
      summary.byPrinciple.unknown++;
      summary.unmappedCount++;
    }
  }

  // Build sorted byCriterion list
  const sorted: Array<{ criterion: WcagSuccessCriterion; count: number }> = [];
  for (const [id, count] of criterionCounts) {
    const sc = WCAG_BY_ID.get(id);
    if (sc) sorted.push({ criterion: sc, count });
  }
  sorted.sort((a, b) => b.count - a.count || a.criterion.id.localeCompare(b.criterion.id));
  summary.byCriterion = sorted;

  return summary;
}

// ─────────────────────────────────────────────────────────────
// Output formatting helpers
// ─────────────────────────────────────────────────────────────

/**
 * Format a WCAG SC for SARIF ruleId: "wcag/1-4-3" (dots → dashes so
 * it survives URL encoding without escaping). Used by ci-reporters.ts
 * when emitting SARIF for accessibility issues.
 */
export function wcagSarifRuleId(criterion: WcagSuccessCriterion | string): string {
  const id = typeof criterion === "string" ? criterion : criterion.id;
  return `wcag/${id.replace(/\./g, "-")}`;
}

/**
 * Canonical W3C deep-link for a WCAG 2.2 success criterion, e.g.
 * "https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum".
 *
 * Slugs are derived from the SC name in lowercase-kebab. We use the
 * 2.2 understanding URLs because they backfill 2.1 / 2.0 SCs and stay
 * stable as W3C publishes errata.
 */
export function wcagHelpUrl(criterion: WcagSuccessCriterion | string): string {
  const sc =
    typeof criterion === "string"
      ? WCAG_BY_ID.get(criterion)
      : criterion;
  if (!sc) return "https://www.w3.org/TR/WCAG22/";
  // W3C's Understanding URLs include parenthetical disambiguators in
  // the slug (e.g. "contrast-minimum", "focus-not-obscured-minimum"),
  // so keep them — just normalise punctuation/whitespace to dashes.
  const slug = sc.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `https://www.w3.org/WAI/WCAG22/Understanding/${slug}`;
}

/**
 * Convenience predicate — does this issue carry WCAG attribution?
 */
export function isWcagIssue(issue: Issue): boolean {
  return issue.wcag_criterion !== undefined || issue.wcag_level !== undefined;
}

// ─────────────────────────────────────────────────────────────
// axe-core standard → tag expansion (T-NEW-11 — closes RISK-REGISTER R-NEW-11)
// ─────────────────────────────────────────────────────────────

/**
 * Conformance levels under each WCAG version that axe-core understands as
 * tags. Axe's `runOnly: { type: "tag", values: [...] }` is **exact match** —
 * passing `["wcag2aa"]` only runs rules tagged with `wcag2aa`, NOT A-level
 * rules. To cover the cumulative meaning of "WCAG 2.x AA conformance"
 * (which includes Level A by definition), callers must pass every tag
 * up to and including the requested version × level.
 *
 * This function expands a single `standard` into the full cumulative set.
 *
 *   expandAxeStandard("wcag2aa")  → ["wcag2a", "wcag2aa"]
 *   expandAxeStandard("wcag22aa") → ["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22a","wcag22aa"]
 *
 * Pre-T-NEW-11 the production handler passed `[standard]` directly, which
 * meant a `standard: "wcag2aa"` audit silently missed Level A violations
 * (image-alt / label / button-name etc). The integration test in
 * tests/integration/playwright/wcag-axe.test.ts caught this.
 *
 * "best-practice" is axe's own opinionated rule set (e.g. duplicate-id-
 * active, region) and does not have a WCAG cumulative meaning — it
 * expands to itself.
 */
export type AxeStandard =
  | "wcag2a"
  | "wcag2aa"
  | "wcag2aaa"
  | "wcag21a"
  | "wcag21aa"
  | "wcag22a"
  | "wcag22aa"
  | "best-practice";

const STANDARD_EXPANSIONS: Record<AxeStandard, ReadonlyArray<string>> = {
  // WCAG 2.0
  wcag2a: ["wcag2a"],
  wcag2aa: ["wcag2a", "wcag2aa"],
  wcag2aaa: ["wcag2a", "wcag2aa", "wcag2aaa"],
  // WCAG 2.1 (cumulative over 2.0)
  wcag21a: ["wcag2a", "wcag21a"],
  wcag21aa: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
  // WCAG 2.2 (cumulative over 2.1)
  wcag22a: ["wcag2a", "wcag21a", "wcag22a"],
  wcag22aa: [
    "wcag2a",
    "wcag2aa",
    "wcag21a",
    "wcag21aa",
    "wcag22a",
    "wcag22aa",
  ],
  // best-practice = axe's own rules, no cumulative meaning
  "best-practice": ["best-practice"],
};

/**
 * Expand an axe-core conformance standard into the cumulative set of
 * tags that should be passed to `axe.run({ runOnly: { type: "tag", values } })`.
 * Unknown standards fall through unchanged (the caller's input is
 * preserved).
 */
export function expandAxeStandard(
  standard: AxeStandard | string,
): string[] {
  const known = STANDARD_EXPANSIONS[standard as AxeStandard];
  return known ? [...known] : [standard];
}

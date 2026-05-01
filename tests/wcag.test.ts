/**
 * Tests for src/core/wcag.ts — WCAG 2.x catalog + axe-core tag parser
 * + grouping aggregator + SARIF / help-URL helpers.
 *
 * The catalog is the source of truth for compliance-team-facing
 * reports; tests pin every level / principle / introducedIn version
 * relationship that downstream features rely on.
 */

import { describe, it, expect } from "vitest";
import {
  expandAxeStandard,
  findWcagCriterion,
  isWcagIssue,
  parseAxeTags,
  summarizeWcag,
  WCAG_CATALOG,
  wcagHelpUrl,
  wcagSarifRuleId,
} from "../src/core/wcag.js";
import type { Issue } from "../src/core/types.js";

// ─────────────────────────────────────────────────────────────
// Catalog integrity
// ─────────────────────────────────────────────────────────────

describe("WCAG_CATALOG — catalog integrity", () => {
  it("has at least 50 success criteria (WCAG 2.1) plus the 9 net-new in 2.2", () => {
    expect(WCAG_CATALOG.length).toBeGreaterThanOrEqual(50);
  });

  it("every criterion has a unique dotted id", () => {
    const ids = WCAG_CATALOG.map((sc) => sc.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every criterion has a unique axe tag", () => {
    const axeTags = WCAG_CATALOG.map((sc) => sc.axeTag);
    expect(new Set(axeTags).size).toBe(axeTags.length);
  });

  it("axe tags are all of the form wcag<digits>", () => {
    for (const sc of WCAG_CATALOG) {
      expect(sc.axeTag).toMatch(/^wcag\d{3,5}$/);
    }
  });

  it("dotted ids are all of the form X.Y or X.Y.Z (1-2-3 digits each)", () => {
    for (const sc of WCAG_CATALOG) {
      expect(sc.id).toMatch(/^\d+\.\d+(\.\d+)?$/);
    }
  });

  it("includes the well-known landmark criteria", () => {
    const ids = new Set(WCAG_CATALOG.map((sc) => sc.id));
    // The marquee criteria every commercial accessibility report cites
    expect(ids.has("1.1.1")).toBe(true); // Non-text content (alt text)
    expect(ids.has("1.4.3")).toBe(true); // Contrast (Minimum) — most-cited
    expect(ids.has("2.1.1")).toBe(true); // Keyboard
    expect(ids.has("2.4.7")).toBe(true); // Focus visible
    expect(ids.has("4.1.2")).toBe(true); // Name, Role, Value
  });

  it("levels distribute realistically (more A/AA than AAA)", () => {
    const a = WCAG_CATALOG.filter((sc) => sc.level === "A").length;
    const aa = WCAG_CATALOG.filter((sc) => sc.level === "AA").length;
    const aaa = WCAG_CATALOG.filter((sc) => sc.level === "AAA").length;
    expect(a).toBeGreaterThan(0);
    expect(aa).toBeGreaterThan(0);
    expect(aaa).toBeGreaterThanOrEqual(0);
    expect(a + aa).toBeGreaterThan(aaa); // most SC are A or AA
  });

  it("includes WCAG 2.2 net-new criteria", () => {
    const v22 = WCAG_CATALOG.filter((sc) => sc.introducedIn === "2.2");
    expect(v22.length).toBeGreaterThanOrEqual(6); // at least 6 net-new in 2.2
    const v22Ids = new Set(v22.map((sc) => sc.id));
    expect(v22Ids.has("2.4.11")).toBe(true); // Focus Not Obscured (Min)
    expect(v22Ids.has("2.5.7")).toBe(true); // Dragging Movements
    expect(v22Ids.has("2.5.8")).toBe(true); // Target Size (Min)
    expect(v22Ids.has("3.3.7")).toBe(true); // Redundant Entry
  });

  it("partitions every SC into exactly one of the four principles", () => {
    const validPrinciples = new Set([
      "perceivable",
      "operable",
      "understandable",
      "robust",
    ]);
    for (const sc of WCAG_CATALOG) {
      expect(validPrinciples.has(sc.principle)).toBe(true);
    }
  });

  it("Principle 1 SCs are perceivable, Principle 2 operable, etc", () => {
    for (const sc of WCAG_CATALOG) {
      const major = sc.id.split(".")[0];
      const expected =
        major === "1"
          ? "perceivable"
          : major === "2"
            ? "operable"
            : major === "3"
              ? "understandable"
              : "robust";
      expect(sc.principle).toBe(expected);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// findWcagCriterion
// ─────────────────────────────────────────────────────────────

describe("findWcagCriterion", () => {
  it("returns the SC for a known dotted id", () => {
    const sc = findWcagCriterion("1.4.3");
    expect(sc?.name).toBe("Contrast (Minimum)");
    expect(sc?.level).toBe("AA");
    expect(sc?.principle).toBe("perceivable");
  });

  it("returns undefined for an unknown id", () => {
    expect(findWcagCriterion("9.9.9")).toBeUndefined();
    expect(findWcagCriterion("not-a-criterion")).toBeUndefined();
  });

  it("does NOT match by axe tag (use parseAxeTags for that)", () => {
    expect(findWcagCriterion("wcag143")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// parseAxeTags
// ─────────────────────────────────────────────────────────────

describe("parseAxeTags", () => {
  it("extracts level=AA + criterion 1.4.3 from typical contrast tags", () => {
    const r = parseAxeTags(["wcag2aa", "wcag143", "cat.color"]);
    expect(r.level).toBe("AA");
    expect(r.criterion?.id).toBe("1.4.3");
    expect(r.criterion?.name).toBe("Contrast (Minimum)");
    expect(r.rawTags).toEqual(["wcag2aa", "wcag143", "cat.color"]);
  });

  it("derives level from criterion when only the SC tag is present", () => {
    // axe sometimes emits only the wcag<digits> tag without an explicit
    // level tag — the criterion's known level fills in.
    const r = parseAxeTags(["wcag1411"]);
    expect(r.level).toBe("AA");
    expect(r.criterion?.id).toBe("1.4.11");
  });

  it("returns undefined level + undefined criterion for best-practice tags", () => {
    const r = parseAxeTags(["best-practice", "cat.aria"]);
    expect(r.level).toBeUndefined();
    expect(r.criterion).toBeUndefined();
  });

  it("returns undefined criterion when no SC tag matches the catalog", () => {
    const r = parseAxeTags(["wcag2aa", "wcag999", "cat.unknown"]);
    expect(r.level).toBe("AA");
    expect(r.criterion).toBeUndefined();
  });

  it("picks the strictest level when multiple level tags are present", () => {
    expect(parseAxeTags(["wcag2a", "wcag2aa"]).level).toBe("AA");
    expect(parseAxeTags(["wcag2aa", "wcag2aaa"]).level).toBe("AAA");
    expect(parseAxeTags(["wcag2a", "wcag2aaa"]).level).toBe("AAA");
  });

  it("recognises WCAG 2.1 and 2.2 level tags", () => {
    expect(parseAxeTags(["wcag21aa"]).level).toBe("AA");
    expect(parseAxeTags(["wcag22aa"]).level).toBe("AA");
    expect(parseAxeTags(["wcag22a"]).level).toBe("A");
  });

  it("preserves the original tag list in rawTags", () => {
    const original = ["wcag2aa", "wcag143", "cat.color", "TTv5"];
    expect(parseAxeTags(original).rawTags).toEqual(original);
  });

  it("returns sensible defaults for empty tag list", () => {
    const r = parseAxeTags([]);
    expect(r.level).toBeUndefined();
    expect(r.criterion).toBeUndefined();
    expect(r.rawTags).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// summarizeWcag
// ─────────────────────────────────────────────────────────────

function makeIssue(over: Partial<Issue>): Issue {
  return {
    severity: "high",
    description: "x",
    recommendation: "y",
    ...over,
  };
}

describe("summarizeWcag", () => {
  it("returns zeroed summary for empty input", () => {
    const s = summarizeWcag([]);
    expect(s.totalIssues).toBe(0);
    expect(s.byLevel).toEqual({ A: 0, AA: 0, AAA: 0, unknown: 0 });
    expect(s.byPrinciple).toEqual({
      perceivable: 0,
      operable: 0,
      understandable: 0,
      robust: 0,
      unknown: 0,
    });
    expect(s.byCriterion).toEqual([]);
    expect(s.unmappedCount).toBe(0);
  });

  it("ignores non-WCAG issues (no wcag fields set)", () => {
    const s = summarizeWcag([
      makeIssue({ description: "vision critic finding" }),
      makeIssue({ description: "another non-a11y" }),
    ]);
    expect(s.totalIssues).toBe(0);
  });

  it("counts by level (A / AA / AAA / unknown)", () => {
    const issues: Issue[] = [
      makeIssue({ wcag_level: "A", wcag_criterion: "1.1.1" }),
      makeIssue({ wcag_level: "AA", wcag_criterion: "1.4.3" }),
      makeIssue({ wcag_level: "AA", wcag_criterion: "1.4.3" }),
      makeIssue({ wcag_level: "AAA", wcag_criterion: "1.4.6" }),
      makeIssue({ wcag_level: undefined, wcag_criterion: undefined }),
    ];
    // Last issue has both undefined — falls into `unmappedCount` and
    // doesn't bump totalIssues; Issues with neither field are skipped.
    const s = summarizeWcag(issues);
    expect(s.byLevel.A).toBe(1);
    expect(s.byLevel.AA).toBe(2);
    expect(s.byLevel.AAA).toBe(1);
    expect(s.byLevel.unknown).toBe(0);
    expect(s.totalIssues).toBe(4); // last one has neither field
  });

  it("counts unknown level when criterion is set but level isn't", () => {
    const issues: Issue[] = [
      makeIssue({ wcag_criterion: "1.4.3" }), // level absent
    ];
    const s = summarizeWcag(issues);
    expect(s.byLevel.unknown).toBe(1);
    expect(s.totalIssues).toBe(1);
    expect(s.byPrinciple.perceivable).toBe(1);
  });

  it("counts by principle (perceivable / operable / understandable / robust)", () => {
    const issues: Issue[] = [
      makeIssue({ wcag_level: "AA", wcag_criterion: "1.4.3" }), // perceivable
      makeIssue({ wcag_level: "AA", wcag_criterion: "1.4.11" }), // perceivable
      makeIssue({ wcag_level: "A", wcag_criterion: "2.1.1" }), // operable
      makeIssue({ wcag_level: "A", wcag_criterion: "3.1.1" }), // understandable
      makeIssue({ wcag_level: "A", wcag_criterion: "4.1.2" }), // robust
    ];
    const s = summarizeWcag(issues);
    expect(s.byPrinciple).toEqual({
      perceivable: 2,
      operable: 1,
      understandable: 1,
      robust: 1,
      unknown: 0,
    });
  });

  it("groups by criterion, sorted by count desc", () => {
    const issues: Issue[] = [
      makeIssue({ wcag_level: "AA", wcag_criterion: "1.4.3" }), // 3 contrast
      makeIssue({ wcag_level: "AA", wcag_criterion: "1.4.3" }),
      makeIssue({ wcag_level: "AA", wcag_criterion: "1.4.3" }),
      makeIssue({ wcag_level: "A", wcag_criterion: "2.1.1" }), // 1 keyboard
      makeIssue({ wcag_level: "A", wcag_criterion: "4.1.2" }), // 2 name-role-value
      makeIssue({ wcag_level: "A", wcag_criterion: "4.1.2" }),
    ];
    const s = summarizeWcag(issues);
    expect(s.byCriterion[0]?.criterion.id).toBe("1.4.3");
    expect(s.byCriterion[0]?.count).toBe(3);
    expect(s.byCriterion[1]?.criterion.id).toBe("4.1.2");
    expect(s.byCriterion[1]?.count).toBe(2);
    expect(s.byCriterion[2]?.criterion.id).toBe("2.1.1");
    expect(s.byCriterion[2]?.count).toBe(1);
  });

  it("ties broken alphabetically (stable across runs)", () => {
    const issues: Issue[] = [
      makeIssue({ wcag_level: "A", wcag_criterion: "2.1.1" }),
      makeIssue({ wcag_level: "AA", wcag_criterion: "1.4.3" }),
    ];
    const s = summarizeWcag(issues);
    expect(s.byCriterion[0]?.criterion.id).toBe("1.4.3");
    expect(s.byCriterion[1]?.criterion.id).toBe("2.1.1");
  });

  it("counts unmapped issues that have a level but no recognised criterion", () => {
    const issues: Issue[] = [
      makeIssue({ wcag_level: "AA", wcag_criterion: undefined }),
      makeIssue({ wcag_level: "AA", wcag_criterion: "9.9.9" }), // not in catalog
    ];
    const s = summarizeWcag(issues);
    expect(s.totalIssues).toBe(2);
    expect(s.unmappedCount).toBe(2);
    expect(s.byPrinciple.unknown).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────
// wcagSarifRuleId / wcagHelpUrl
// ─────────────────────────────────────────────────────────────

describe("wcagSarifRuleId", () => {
  it("formats SC id as wcag/X-Y-Z (dots → dashes)", () => {
    expect(wcagSarifRuleId("1.4.3")).toBe("wcag/1-4-3");
    expect(wcagSarifRuleId("2.1.1")).toBe("wcag/2-1-1");
    expect(wcagSarifRuleId("2.4.11")).toBe("wcag/2-4-11");
  });

  it("accepts a criterion object directly", () => {
    const sc = findWcagCriterion("1.4.3")!;
    expect(wcagSarifRuleId(sc)).toBe("wcag/1-4-3");
  });
});

describe("wcagHelpUrl", () => {
  it("returns the W3C 2.2 Understanding URL for a known SC", () => {
    expect(wcagHelpUrl("1.4.3")).toBe(
      "https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum",
    );
  });

  it("derives kebab-case slug from the SC name (strips parenthetical)", () => {
    // 1.4.6 = "Contrast (Enhanced)" → "contrast-enhanced"
    expect(wcagHelpUrl("1.4.6")).toBe(
      "https://www.w3.org/WAI/WCAG22/Understanding/contrast-enhanced",
    );
    // 2.4.11 = "Focus Not Obscured (Minimum)"
    expect(wcagHelpUrl("2.4.11")).toBe(
      "https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum",
    );
  });

  it("falls back to the WCAG 2.2 spec root when the id is unknown", () => {
    expect(wcagHelpUrl("99.99.99")).toBe("https://www.w3.org/TR/WCAG22/");
  });

  it("accepts a criterion object directly", () => {
    const sc = findWcagCriterion("4.1.2")!;
    expect(wcagHelpUrl(sc)).toBe(
      "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value",
    );
  });
});

// ─────────────────────────────────────────────────────────────
// isWcagIssue
// ─────────────────────────────────────────────────────────────

describe("isWcagIssue", () => {
  it("returns true when wcag_criterion is set", () => {
    expect(isWcagIssue(makeIssue({ wcag_criterion: "1.4.3" }))).toBe(true);
  });

  it("returns true when only wcag_level is set", () => {
    expect(isWcagIssue(makeIssue({ wcag_level: "AA" }))).toBe(true);
  });

  it("returns false for vision-critic-style issues with no wcag fields", () => {
    expect(isWcagIssue(makeIssue({ description: "blurry text" }))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// expandAxeStandard (T-NEW-11 — closes RISK-REGISTER R-NEW-11)
// ─────────────────────────────────────────────────────────────

describe("expandAxeStandard", () => {
  // Table-driven: every standard the AssertA11yStepSchema enum accepts →
  // expected expansion. Tags must be cumulative across version × level
  // (WCAG 2.2 AA includes Level A + 2.0/2.1 SCs by definition).
  const cases: Array<[string, ReadonlyArray<string>]> = [
    // WCAG 2.0
    ["wcag2a", ["wcag2a"]],
    ["wcag2aa", ["wcag2a", "wcag2aa"]],
    ["wcag2aaa", ["wcag2a", "wcag2aa", "wcag2aaa"]],
    // WCAG 2.1 (cumulative over 2.0)
    ["wcag21a", ["wcag2a", "wcag21a"]],
    ["wcag21aa", ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]],
    // WCAG 2.2 (cumulative over 2.1)
    ["wcag22a", ["wcag2a", "wcag21a", "wcag22a"]],
    [
      "wcag22aa",
      ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"],
    ],
    // axe's own opinionated rules — no WCAG cumulative meaning
    ["best-practice", ["best-practice"]],
  ];

  for (const [input, expected] of cases) {
    it(`expands "${input}" to ${JSON.stringify(expected)}`, () => {
      expect(expandAxeStandard(input)).toEqual([...expected]);
    });
  }

  it("returns a fresh array (caller can mutate without poisoning the table)", () => {
    const a = expandAxeStandard("wcag2aa");
    const b = expandAxeStandard("wcag2aa");
    a.push("mutated");
    expect(b).toEqual(["wcag2a", "wcag2aa"]);
  });

  it("falls through unknown standards unchanged (defensive)", () => {
    expect(expandAxeStandard("wcag3a" as never)).toEqual(["wcag3a"]);
    expect(expandAxeStandard("custom-tag" as never)).toEqual(["custom-tag"]);
  });

  it("includes Level A in every AA expansion (T-NEW-11 regression guard)", () => {
    // The R-NEW-11 bug was that wcag2aa expanded to ["wcag2aa"] only,
    // missing Level A rules like image-alt / label / button-name.
    // This test pins the cumulative semantic so the bug can't regress.
    for (const aa of ["wcag2aa", "wcag21aa", "wcag22aa"]) {
      expect(expandAxeStandard(aa)).toContain("wcag2a");
    }
  });

  it("wcag22aa expands to all 6 cumulative tags (full WCAG 2.2 AA)", () => {
    // Most common commercial standard: WCAG 2.2 AA conformance.
    expect(expandAxeStandard("wcag22aa")).toEqual([
      "wcag2a",
      "wcag2aa",
      "wcag21a",
      "wcag21aa",
      "wcag22a",
      "wcag22aa",
    ]);
  });
});

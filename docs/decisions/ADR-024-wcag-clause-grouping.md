# ADR-024 — WCAG clause grouping (M2-2)

- **Status**: Accepted
- **Date**: 2026-05-01
- **Task**: M2-2 — WCAG 条款分组
- **Builds on**: ADR-019 (CI / SARIF emission), ADR-020 (PDF stakeholder report), ADR-023 (report localisation — WCAG section is i18n-aware)

## Context

The auditor has run axe-core inside the `assert_a11y` scenario step since v0.3, capturing every accessibility rule violation tagged with WCAG metadata like `["wcag2aa", "wcag143", "cat.color"]`. Until M2-2 those tags were flattened into the `Issue.recommendation` text — useful to the engineer reading the issue, useless for the people who actually drive accessibility purchasing decisions:

- **Compliance / legal teams** asking "Are we WCAG 2.1 AA compliant?" need a structured answer broken down by conformance level (A / AA / AAA), not a flat list of issues.
- **Product / engineering leadership** asking "Where is our accessibility weakest?" need the four-principle pillars (Perceivable / Operable / Understandable / Robust) so systemic gaps surface.
- **Security / GitHub Code Scanning consumers** processing SARIF expect each violation to carry its specific WCAG ruleId (`wcag/1-4-3`, `wcag/2-1-1`) — not a generic `audit/accessibility` bucket — so they can filter, route, and triage by the actual W3C clause.

This is the difference between answering "do we have accessibility issues?" (today's flat list) and "do we comply with WCAG 2.1 AA?" (the question every enterprise SaaS procurement RFP asks). The ADA case law in the US targets AA. The EU EAA (effective 2025) targets AA on consumer-facing products. Without WCAG-structured output, the auditor stops short of the compliance-team buyer at exactly the moment they care.

## Decision

Three coordinated changes:

### 1. Structured WCAG attribution on every accessibility issue

`Issue` (in `src/core/types.ts`) gains two optional fields:

```ts
wcag_level?: "A" | "AA" | "AAA"      // conformance level the violation is graded at
wcag_criterion?: string              // dotted SC id, e.g. "1.4.3"
```

Both are absent on non-accessibility issues (vision-critic findings keep their existing shape). They're populated on every axe-core violation by the new `parseAxeTags()` helper which walks the raw tag list, picks the strictest level, and matches the `wcag<digits>` SC tag against a curated catalog.

### 2. WCAG 2.1 + 2.2 catalog (`src/core/wcag.ts`)

A hand-curated array of `WcagSuccessCriterion` entries covering:

- All 50 SC of WCAG 2.1 (the production-deployed standard most compliance frameworks reference)
- The 9 net-new SC introduced in WCAG 2.2 (2.4.11 Focus Not Obscured, 2.5.7 Dragging Movements, 2.5.8 Target Size, 3.3.7 Redundant Entry, 3.3.8 Accessible Authentication, 3.2.6 Consistent Help, plus a few re-numbered)

Each entry carries: `id` (dotted), `name`, `level`, `principle`, `introducedIn` (2.0 / 2.1 / 2.2), and the `axeTag` axe-core uses (`wcag143`).

The catalog is the source of truth for: parsing axe tags into structured attribution, looking up canonical names + W3C URLs, grouping issues by principle, and emitting compliance-team-facing summary tables.

### 3. Three reporter integrations

**SARIF (`src/core/ci-reporters.ts`)**: WCAG-attributed issues now route to a per-criterion ruleId — `wcag/1-4-3`, `wcag/2-1-1`. The corresponding `tool.driver.rules` entry carries the SC name + level + canonical W3C Understanding URL so GitHub Code Scanning's rule detail panel shows "WCAG 1.4.3 Contrast (Minimum) (Level AA)" with the W3C deep link. Non-WCAG issues fall through to the existing `audit/<dimension>` ruleId.

**PDF report (`src/core/reporter-pdf.ts`)**: a new "WCAG Compliance Summary" section emitted between Top Findings and Scenario Results when the run has any accessibility issues. Three sub-blocks:

1. By conformance level (A / AA / AAA / Unknown counts)
2. By principle (Perceivable / Operable / Understandable / Robust counts)
3. Top 8 violated criteria (each linking to its W3C Understanding doc)

Skipped entirely on runs that don't include an `assert_a11y` step.

**i18n (`src/core/i18n.ts`)**: 14 new translation keys for the WCAG section. Translated into all 5 supported locales (en / zh-CN / ja / es / de). Compliance teams reading reports in their native language see "WCAG 合规摘要 / 按一致性级别 / 可感知" etc.

## Alternatives rejected

1. **Hard-code WCAG metadata inside `handlers/index.ts`** — would have entangled axe-core specifics with type-shape concerns. Extracting `wcag.ts` as a standalone module lets reporters / external consumers / future M2-2.x extensions reuse the catalog without depending on the handler.
2. **Pull WCAG metadata from axe-core's own JSON catalog at runtime** — would couple our reports to whatever subset axe ships and miss SCs that axe doesn't have rules for (e.g. 1.2.x audio captioning — axe can't auto-detect, but a manual audit might still surface them). Hand-curated catalog is pinned to W3C TR/WCAG22 and stable across axe versions.
3. **One ruleId per axe rule (e.g. `axe/color-contrast`) instead of per-WCAG-SC** — engineering-friendly but compliance-hostile. Multiple axe rules can map to the same SC (e.g. `color-contrast` + `color-contrast-enhanced` both on 1.4.3). Compliance teams want SC-level reporting; engineers can drill into the `description` field for the specific axe rule.
4. **Separate top-level "Accessibility report" PDF instead of a section inside the main PDF** — duplicates content and forces stakeholders to know which document to open. The main PDF is the single artefact for stakeholder distribution; embedding a WCAG section keeps the contract simple.
5. **Translate the W3C SC names themselves (e.g. "1.4.3 Contrast (Minimum)" → "1.4.3 對比度（最低）")** — rejected. WCAG SC names are formal references; translating them risks ambiguity in compliance documentation. Keep the canonical English name; translate only the section headings around them.
6. **Show all 50+ criteria in the PDF, not just the top 8** — would balloon the section by 5+ pages. Compliance teams want the worst offenders surfaced; the long tail goes to `audit.json` for engineers and to the SARIF feed for tooling.
7. **Track historical WCAG conformance trend over time as a separate trends-dashboard chart** — sounds nice (M2-3.1 follow-up). Defer until we see real signal in the trend data; today most users will run a few audits before that's interesting.
8. **Auto-fail the audit on any AA violation (`--fail-on-wcag aa`)** — over-reach. The existing `--min-score` quality gate already blocks bad runs. Hardcoding "any AA = fail" is a policy decision per project; users who want it can set `--min-score 9` or build a SARIF post-processor. Add as an opt-in flag if real users ask.

## Consequences

- The auditor produces compliance-grade output: every accessibility issue carries structured WCAG attribution; SARIF emits per-criterion ruleIds; the PDF stakeholder artefact answers "are we WCAG 2.1 AA compliant?" with concrete numbers per level / principle / criterion.
- ADA / EAA compliance teams get a usable report in their native language (5 locales).
- GitHub Code Scanning + GitLab SAST users see WCAG SC-level ruleIds, can filter / triage by W3C clause directly in their security dashboards.
- Public API surface grows 60 → 67 exports: 7 new (WCAG_CATALOG, findWcagCriterion, parseAxeTags, summarizeWcag, wcagSarifRuleId, wcagHelpUrl, isWcagIssue) + 5 types.
- 1432 → 1445 tests pass net (+38 new wcag tests, +9 reporter integrations, ~ +3 misc); some sample-pair tests adjusted for the schema additions.
- The `Issue` schema gained two optional fields. Per ADR-007's SemVer policy, additive optional fields do NOT require a `RESULT_SCHEMA_VERSION` bump — version stays 1.2.0. Old consumers still parse new audit.json successfully.

## Files added / changed

- `src/core/wcag.ts` (new — ~270 LoC)
- `tests/wcag.test.ts` (new — 38 tests)
- `src/core/types.ts` — `Issue` adds `wcag_level` + `wcag_criterion`
- `src/core/result-schema.ts` — `IssueSchema` matches
- `src/handlers/index.ts` — `handleAssertA11y` populates the new fields via `parseAxeTags`
- `src/core/ci-reporters.ts` — SARIF `ruleIdForIssue` + `buildRule` wcag-aware
- `src/core/reporter-pdf.ts` — new "WCAG Compliance Summary" section
- `src/core/i18n.ts` — 14 new keys × 5 locales
- `src/index.ts` — 7 new public exports + 5 types
- `tests/reporter-pdf.test.ts` / `tests/ci-reporters.test.ts` — 9 new WCAG-specific tests
- `tests/public-api-samples.test.ts` — snapshot 60 → 67
- `docs/schemas/*.schema.json` — regenerated (additive)

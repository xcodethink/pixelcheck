# ADR-030 — Cumulative expansion of the axe-core standard tag

- **Status**: Accepted
- **Date**: 2026-05-01
- **Context**: derived from the axe + SARIF verification work

## Context

Running fixtures during the axe + SARIF verification surfaced a **production
bug**.

`handleAssertA11y` in `src/handlers/index.ts` passed the caller's
`step.standard` — default `"wcag2aa"` — straight to axe-core as a
single-element array:

```ts
runOnly: { type: "tag", values: [runOpts.standard] }
```

axe-core matches `runOnly: { type: "tag", values }` **exactly**. Passing
`["wcag2aa"]` runs only rules tagged `wcag2aa`, and therefore **excludes every
Level A rule**:

- `image-alt` (WCAG 1.1.1, Level A, axe tag `wcag2a`) — never checked
- `label` (WCAG 4.1.2, Level A) — never checked
- `button-name` (WCAG 4.1.2, Level A) — never checked
- `link-name` (WCAG 2.4.4, Level A) — never checked

while `color-contrast` (WCAG 1.4.3, Level AA, tag `wcag2aa`) was checked.

The consequence: **every audit run with `standard: "wcag2aa"` severely
under-counted accessibility violations.** Level A is a subset of AA — "AA
includes A" — so users reasonably expect an AA run to cover A, but axe does not
expand it automatically.

## Decision

Add `expandAxeStandard()` to `src/core/wcag.ts`, which expands a single standard
into its full cumulative tag list, and use it in the handler before calling axe:

```ts
const axeTags = expandAxeStandard(standard);
// "wcag2aa"       → ["wcag2a", "wcag2aa"]
// "wcag22aa"      → ["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22a","wcag22aa"]
// "best-practice" → ["best-practice"]   (axe's own rules do not accumulate)
```

Full expansion table, cumulative across version and level:

| Input | Output |
|---|---|
| `wcag2a` | `["wcag2a"]` |
| `wcag2aa` | `["wcag2a", "wcag2aa"]` |
| `wcag2aaa` | `["wcag2a", "wcag2aa", "wcag2aaa"]` |
| `wcag21a` | `["wcag2a", "wcag21a"]` |
| `wcag21aa` | `["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]` |
| `wcag22a` | `["wcag2a", "wcag21a", "wcag22a"]` |
| `wcag22aa` | `["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]` |
| `best-practice` | `["best-practice"]` |
| unknown value | returned unchanged (defensive fallback) |

### Schema change

`AssertA11yStepSchema.standard` gains `wcag22a`, which was missing even though
axe defines the tag, bringing the enum to eight values. Of the AAA levels only
`wcag2aaa` is kept: commercial audits rarely require AAA, and axe itself tags
few AAA rules in 2.1 and 2.2.

### Verification

- **12 new unit tests** (`tests/wcag.test.ts > expandAxeStandard`): table-driven
  coverage of all eight enum values, the unknown-value fallback, array
  isolation, a Level A regression guard, and the complete six-tag WCAG 2.2 AA
  expansion.
- **Integration test updated** (`tests/integration/playwright/wcag-axe.test.ts`):
  the first case previously passed `["wcag2a", "wcag2aa"]` by hand and now calls
  `expandAxeStandard("wcag2aa")`, so it exercises the production path.
- **Matches upstream guidance**: axe-core's documentation recommends exactly
  `["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]` for full
  WCAG 2.2 AA conformance.

## Alternatives rejected

1. **Leave it and require callers to pass the full array** — makes every user
   fall into the same axe trap; violates safe-by-default.
2. **Add explicit enum values such as `wcag2-all` or `wcag22-aa-cumulative`** —
   departs from axe's standard tag names and forces users to learn a second
   vocabulary.
3. **Hard-code `[standard].concat(["wcag2a"])`** — does not handle 2.1 AA or 2.2
   AA correctly.
4. **Keep the old behaviour and emit a runtime warning** — accessibility results
   are a commercial deliverable; a warning beats a silent miss but is worse than
   fixing it, and it pollutes the log.
5. **Run all rules and post-filter by tag** — slower and wasteful; `runOnly`
   exists for exactly this.
6. **Full AAA support for `wcag21aaa` / `wcag22aaa`** — out of scope for v1; one
   more table row if a user needs it.

## Consequences

- **Audit accuracy improves immediately**: every run using the default
  `wcag2aa` now detects Level A violations. **Comparing an old audit to a new
  one will show a materially higher violation count**, which the release notes
  and migration guide must state explicitly.
- **No public API break.** `AssertA11yStepSchema` gains an enum value, but that
  schema constrains *input* (producer format) rather than the output result
  schema (consumer contract). Widening input tolerance from seven to eight
  accepted values is backward-compatible and does not force a major bump.
- **Result Schema 1.2.0 is unchanged**; no `RESULT_SCHEMA_VERSION` bump.
- **`expandAxeStandard` is a candidate for the public API**; it is not exported
  in this change, pending demand.

## Files added / changed

- `src/core/wcag.ts` — adds the `AxeStandard` type, the `STANDARD_EXPANSIONS` table and `expandAxeStandard()` (~70 LoC)
- `src/core/types.ts` — `AssertA11yStepSchema.standard` gains `wcag22a`, with a comment describing the expansion
- `src/handlers/index.ts` — `handleAssertA11y` uses `expandAxeStandard(standard)` instead of `[standard]`
- `tests/wcag.test.ts` — 12 new tests
- `tests/integration/playwright/wcag-axe.test.ts` — first two cases now go through the production path
- `docs/decisions/ADR-030-axe-standard-cumulative-expansion.md` — this ADR

# ADR-028 — Defer the Stagehand v3 upgrade (v1.0 ships Stagehand v2.5.8)

- **Status**: Superseded by [ADR-035](ADR-035-stagehand-v3-migration.md) (2026-05-03; originally filed as ADR-029, renumbered 2026-05-05)
- **Date**: 2026-05-01

> **Update 2026-05-03**: the migration ran earlier than the "early v1.1" plan
> below — see ADR-035 for the actual record. The transitive vulnerability
> waiver described here is now closed, since Stagehand v3 dropped the
> vulnerable `ai` SDK and `jsondiffpatch` versions. The original reasoning is
> preserved for historical context.

## Context

`npm outdated` reports Stagehand at 2.5.8 with 3.3.0 available. Stagehand v3 is
a breaking major release.

Its surface in this project:

- Five core primitives (`act`, `extract`, `audit_url`, `explore_url`, and part
  of `judge` via the navigator).
- `src/core/stagehand-wrapper.ts`, whose `StagehandLike` interface pins the v2.5
  API shape.
- A comment in `src/cli.ts` that names Stagehand 2.5 explicitly.
- `src/agent/instruction-mutator.ts`, which calls `observe()` to discover
  selectors — renamed to `action` in v3.
- `src/benchmark/executor.ts`, which uses `createStagehandWrapper`.

## Stagehand v3 breaking changes (from the v3 migration guide)

1. **`act()` signature** — v2 takes an action object, v3 takes an instruction
   string directly.
2. **`observe()` renamed to `action`**, with the return type renamed to match.
3. **Internal Playwright dependency removed** — v3 is bring-your-own driver
   (Playwright, Puppeteer or Patchright), so the wrapper needs rewiring.
4. **New non-AI primitives** (`page`, `locator`, `frameLocator`, `deepLocator`)
   worth evaluating as replacements for some deterministic paths.
5. **CSS selector support**, plus iframe and shadow-root selector coverage.
6. **Automatic action caching**, reported at 20–40% faster — an opportunity, not
   a break.
7. **bun compatibility** — also an opportunity.

Impact of upgrading: rewrite `stagehand-wrapper.ts` (~150 LoC), change
`observe` → `action` in the instruction mutator (~20 lines), review every
`act()` call site, rewrite the mock shapes in two instruction-mutator test
files, and port the real-Stagehand smoke test to the new API. Estimated 6–8
hours against T0.5's 4, and it can only be validated properly alongside the
real-Stagehand end-to-end smoke test, which does not exist yet.

## Transitive vulnerabilities in Stagehand v2.5.8

After `npm audit fix`, three advisories remain, all reached through Stagehand's
own dependencies:

| Package | Severity | Advisory | Our exposure |
|---|---|---|---|
| `ai` (Vercel AI SDK) | moderate | GHSA-rwvc-j5jr-mgvh — file-type allowlist bypass | We do not use the SDK's file upload path; it is pulled in only as a Stagehand dependency. Not exploitable here. |
| `jsondiffpatch` | moderate | GHSA-33vc-wfww-vjfv — `HtmlFormatter::nodeBegin` XSS | We do not use `HtmlFormatter`; Stagehand uses jsondiffpatch for internal plan diffing and renders no HTML from it. Not exploitable here. |
| one low-severity advisory | low | — | — |

All three clear under Stagehand v3, which no longer depends on the vulnerable
versions — but that upgrade is its own task.

## Decision

**v1.0 ships Stagehand v2.5.8. The v3 upgrade becomes a standalone task.**

- `package.json` keeps `"@browserbasehq/stagehand": "^2.0.0"`, pinned to the v2
  major.
- The three transitive advisories are documented in `SECURITY.md` as
  non-exploitable in this usage.
- The CI gate runs at `--audit-level=high` rather than `moderate`, with the
  accepted moderates listed in `SECURITY.md`.
- The upgrade task is scheduled early in v1.1: upgrade to v3, rewrite the
  wrapper, and validate against the real end-to-end smoke test.

## Alternatives rejected

1. **Upgrade to v3 inside T0.5** — doubles the task, blocks the critical
   vulnerability fixes, and cannot be validated without a smoke test that does
   not exist yet.
2. **Force transitive dependencies up with npm overrides** — Stagehand v2 has
   never been tested against those versions, so it risks runtime breakage; it
   also papers over the root cause.
3. **Downgrade Stagehand to an older v2** — backwards: older versions carry more
   advisories and lack the bug fixes v2.5 shipped.
4. **Fork Stagehand v2** — unsustainable maintenance burden.
5. **Drop Stagehand for direct Playwright plus an LLM** — a rewrite of the
   entire act/extract semantic layer, 30+ hours.

## Consequences

- The v3 upgrade is scheduled as a P0 task for v1.1.
- v1.0's `SECURITY.md` documents the three transitive advisories with the
  non-exploitability rationale.
- The `--audit-level=high` gate does not block on those three moderates.
- Consumers upgrading v1.0 → v1.1 are insulated from the Stagehand API change:
  the wrapper hides Stagehand, and callers use our own `act` primitive.
- Performance should improve after the upgrade, given v3's automatic action
  caching.

## Trigger

A single task, scheduled as the first item of the v1.1 cycle and no later than
the v1.1 release:

1. Ship v1.0 with Stagehand v2.5.8.
2. In v1.1, upgrade to v3, rewrite the wrapper, and validate with the real
   end-to-end smoke test.
3. Re-run `npm audit`, expecting zero critical and zero moderate.

## Files changed

- `package.json` — `"@browserbasehq/stagehand": "^2.0.0"` (unchanged; compatible with the `dotenv@^16` peer dependency)
- `docs/decisions/ADR-028-stagehand-v3-deferred.md` (this file)
- `SECURITY.md` — the three transitive advisory waivers

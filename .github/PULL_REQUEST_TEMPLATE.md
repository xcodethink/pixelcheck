<!--
Thank you for contributing to PixelCheck.

Pre-flight checks before opening a PR:
- [ ] Read CONTRIBUTING.md (commit format, ADR practice, branch protection)
- [ ] `npm run typecheck && npm test && npm run lint:no-console` pass locally
- [ ] If touching coverage-floor modules, `npm run test:coverage:check` passes
- [ ] Conventional Commits format on all commits in this branch
-->

## Summary

<!--
One short paragraph: what this PR does and why. Lead with user-visible
impact, not implementation. If the PR closes an issue, link it explicitly:
"Closes #NNN" — that triggers GitHub's auto-close on merge.
-->

## Type of change

<!-- Check all that apply -->

- [ ] `feat` — new functionality (additive, no breaking change)
- [ ] `fix` — defect fix
- [ ] `docs` — documentation only
- [ ] `test` — test additions / fixes (no production code change)
- [ ] `refactor` — internal reshape, no behaviour change
- [ ] `perf` — performance improvement
- [ ] `chore` — build / dependency / tooling
- [ ] `ci` — CI workflow change
- [ ] **Breaking change** — requires major version bump + MIGRATION.md entry

## Contract impact

<!--
Touching any of these surfaces requires extra discipline. Tick what
applies and confirm the corresponding stability commitment is honoured.
See docs/SLO.md § Contract stability.
-->

- [ ] Result Schema (`src/core/types.ts`, `src/core/result-schema.ts`, `docs/schemas/`)
  - [ ] Additive change only (new optional field) — minor bump OK
  - [ ] Updated `docs/contracts/RESULT_SCHEMA.md` if version bumped
  - [ ] `npm run schemas` regenerated and committed
- [ ] CLI flags (`src/cli.ts`)
  - [ ] Additive flag — no removal
  - [ ] Removal: deprecation cycle followed (see DEPRECATION-POLICY.md)
- [ ] MCP tool surface (`src/mcp/tools/*`)
  - [ ] Additive
  - [ ] `tests/list-capabilities.test.ts` snapshot updated
- [ ] Library exports (`src/index.ts`)
  - [ ] `tests/public-api-samples.test.ts` updated
- [ ] Result schema or contracts → ADR drafted in `docs/decisions/`

If none of the above: skip this section.

## Architecture Decision Record

<!--
For non-trivial design choices (new module / cross-cutting refactor /
performance-vs-readability trade-off / 3rd-party dependency adoption),
add a new ADR in docs/decisions/ADR-NNN-title.md and link it here.
See CONTRIBUTING.md "When to write an ADR" for the criteria.
-->

- [ ] Not applicable — change is small / mechanical
- [ ] ADR drafted: `docs/decisions/ADR-NNN-...md`
- [ ] Updates an existing ADR (note `Superseded by` if relevant)

## Tests

<!--
Confirm test coverage for any added behaviour. Bug fixes should
include a regression test that fails before the fix.
-->

- [ ] Unit tests added / updated
- [ ] Integration test added (`tests/integration/`)
- [ ] Playwright real-chromium test added (`tests/integration/playwright/`)
- [ ] Coverage gate (`npm run test:coverage:check`) passes
- [ ] Bench unaffected (`npm run bench:check`)
- [ ] Not applicable — docs-only / cosmetic change

## Documentation

- [ ] CHANGELOG.md entry added under `[Unreleased]`
- [ ] User-facing change reflected in README / FAQ / TROUBLESHOOTING / INSTALLATION as appropriate
- [ ] If a new env var / flag / metric — added to docs/SLO.md or docs/architecture.md
- [ ] If a deprecation — added to MIGRATION.md and DEPRECATION-POLICY.md

## Privacy / security review

- [ ] No new outbound network calls (other than `api.anthropic.com` for explicit audit calls)
- [ ] No new data persisted to disk without explicit operator opt-in
- [ ] Sensitive-input redaction unaffected (or expanded coverage)
- [ ] Secrets-redaction layer unaffected (or expanded coverage)
- [ ] No telemetry added (or, if proposed: opt-in default + MIGRATION.md note)
- [ ] N/A — change does not touch network / disk / sensitive-input paths

## Backwards compatibility

- [ ] Backwards compatible
- [ ] Breaking change for v2.0 (major bump, MIGRATION.md updated)
- [ ] Deprecation introduced — sunset target documented in DEPRECATION-POLICY.md

## Screenshots / output samples (optional)

<!-- For UI / report changes — paste before/after screenshots here. -->

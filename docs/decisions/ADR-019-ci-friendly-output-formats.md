# ADR-019 — CI-friendly output formats (M2-6)

- **Status**: Accepted
- **Date**: 2026-05-01
- **Task**: M2-6 — CI 友好格式输出
- **Builds on**: ADR-007 (result schema is the source of truth — these are alternate serialisations, not new schemas)

## Context

By the end of M1-5 (Public API contract tests), the auditor reliably emits four artefacts per run:

- `audit.json` — the source-of-truth machine-readable report (validates against `audit-run.schema.json`)
- `audit.html` — rich HTML report with embedded video / screenshots
- `audit-explorer.html` — interactive SPA filter view
- `summary.md` — terminal-friendly markdown

**None of these is consumable by a CI/CD pipeline natively.** Every commercial deployment that wants to use the auditor in CI ends up writing its own adapter:

- Jenkins / GitLab / Azure DevOps want JUnit XML for the test-results dashboard
- GitHub Code Scanning + GitLab SAST want SARIF v2.1.0 for the Security tab inline annotations
- GitHub Actions wants `::error file=...,title=...::message` workflow commands for inline PR annotations
- Stream-processing pipelines (log aggregators, Snowflake ingest, ad-hoc `jq`) want JSON Lines

This is the single largest adoption blocker for the v1 commercial release: if a team can't drop the auditor into their existing pipeline without 50 lines of glue script, they don't try it.

## Decision

Add a single new module `src/core/ci-reporters.ts` exposing four format writers, plus a `detectCiEnvironment()` helper, and wire them into the CLI behind a `--ci-format` flag.

### Format inventory

| Format | File | Spec | Consumed by |
|---|---|---|---|
| **JUnit XML** | `junit.xml` | de-facto, no formal RFC; per-vendor extensions tolerated | Jenkins, GitLab CI, Azure DevOps, CircleCI legacy reporters |
| **SARIF 2.1.0** | `audit.sarif` | OASIS [SARIF v2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/) | GitHub Code Scanning, GitLab SAST, Sonatype Lift |
| **JSONL** | `audit.jsonl` | RFC 7464 ("JSON-Text Sequences") in spirit; one record per line | jq, log aggregators, custom dashboards, Snowflake VARIANT ingest |
| **GHA workflow commands** | `github-annotations.txt` | [GitHub Actions workflow command spec](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions) | GitHub Actions inline PR annotations |

### Default behaviour

`--ci-format auto` (the default when the flag is unset):

- **CI detected** (via `detectCiEnvironment()`): emit all four formats
- **Developer laptop** (`CI` / `GITHUB_ACTIONS` / `GITLAB_CI` / `CIRCLECI` / `TF_BUILD` / `JENKINS_URL` all unset): emit none — keeps local iteration's `/tmp/audit-runs/` clean

Explicit overrides:
- `--ci-format all` — force-emit all four regardless of environment
- `--ci-format none` — skip all CI formats
- `--ci-format junit,sarif,jsonl,gha` — comma-separated subset

When running inside GitHub Actions specifically (the only CI vendor with a live stdio annotation convention), the CLI **also** streams the annotation lines to stderr so they attach inline to PR diffs without needing a separate `actions/annotate@v1` workflow step.

### Severity mapping

A single `SEVERITY_LEVELS` table is the source of truth:

| Issue severity | SARIF level | GHA level |
|---|---|---|
| critical | error | error |
| high | error | error |
| medium | warning | warning |
| low | note | notice |

JUnit XML doesn't have a severity gradient — `status: "fail"` emits `<failure type="error">`, `pass_with_issues` emits `<failure type="warning">` so legacy pipelines that fail on any `<failure>` can still distinguish via the `type` attribute.

### Redaction

All four writers go through `redactDeep(audit, audit.redact_patterns)` (M1-4 secrets layer) so the CI formats can never leak secrets that the JSON / HTML formats already redact. Tests verify that planted-secret strings like `sk-ant-secret-9999` never appear in any of the four output files.

### Public API surface

The 4 writers + `detectCiEnvironment` + `SarifToolDriver` type are re-exported from `src/index.ts` so embedders building bespoke audit pipelines (e.g. a web service that wants to emit only SARIF) can use them directly without depending on the CLI.

## Alternatives rejected

1. **Skip JUnit XML — it's a "legacy" format.** — Rejected because *every* enterprise CI dashboard built since 2010 understands JUnit XML; SARIF is newer but only GitHub Advanced Security and GitLab SAST consume it. Dropping JUnit would lock out Jenkins (still 70%+ of enterprise CI) and Azure DevOps. Cost is ~80 LoC of one writer.
2. **Emit GitHub Annotations to stdout instead of stderr.** — Rejected because GitHub Actions parses workflow commands from *both* streams, but stdout is what user-facing logs print to. Routing annotations to stderr keeps them out of the test-output capture buffers most pipelines apply.
3. **Auto-emit all formats on developer laptop too.** — Rejected: `/tmp/audit-runs/<timestamp>/` already gets cluttered with audit.json + 3 HTML reports + screenshots + videos. Adding 4 more files per run would double the noise during iteration. The `auto` default keeps local clean while still gating on explicit `--ci-format all` or any explicit comma list.
4. **One unified format that all 4 consumers understand.** — Doesn't exist. SARIF is the closest to a "universal" code-analysis format but Jenkins still doesn't consume it; conversely JUnit XML can't carry the rule/dimension structure SARIF needs. We're paying the inherent diversity cost of the CI ecosystem.
5. **Add new schemas to `docs/schemas/` for each format.** — Rejected per `RESULT_SCHEMA.md §1`: these are *projections* of `AuditRun`, not new result types. They don't carry data the JSON envelope doesn't already carry, so versioning them under `RESULT_SCHEMA_VERSION` would be over-engineering. They're documented under their respective public specs (SARIF 2.1.0 / JUnit / GHA workflow-command spec).
6. **TAP (Test Anything Protocol) output.** — Rejected: TAP's audience overlaps fully with JUnit (both go to legacy Unix-style pipelines), but every modern CI vendor that consumes TAP also consumes JUnit XML, and JUnit gives us the per-suite/per-case structure that TAP flattens. Skip TAP, ship JUnit.
7. **Auto-detect CI by checking for `.github/workflows/*.yml` in CWD.** — Rejected: brittle (the auditor doesn't run from the repo root in many setups; mono-repos have nested workflow dirs). Environment-variable detection (the actual vendor signal) is what every other tool uses.
8. **Allow the user to set per-format paths (`--junit-out path/junit.xml`).** — Rejected for v1: every CI tool we support has a default discovery convention that walks up from `cwd` looking for `*.junit.xml` / `*.sarif` / etc. Putting them all in `runDir` next to `audit.json` is the consistent location and CI vendors can be pointed at it via their existing path-glob config. Per-format `--*-out` flags add 4 more CLI surface and are easy to add later if real users ask.

## Consequences

- The auditor now drops directly into Jenkins / GitLab / CircleCI / Azure DevOps (JUnit), GitHub Code Scanning + GitLab SAST (SARIF), GitHub PR annotations (workflow commands), and any stream-processing pipeline (JSONL) without per-project glue scripts.
- Adoption blocker for v1 commercial release removed — a "drop into your CI" tutorial now writes itself.
- Adding a 5th format is mechanical: one writer + one entry in `CI_FORMATS` + one row in `SEVERITY_LEVELS` (if the new format has a severity gradient).
- 1132 → 1186 tests pass (+54). Public surface grew 40 → 45 exports.
- File count in `runDir/` grows from 5 (audit.json + audit.html + audit-explorer.html + summary.md + screenshots/) to 9 in CI; unchanged on developer laptop (`auto` default).

## Files added / changed

- `src/core/ci-reporters.ts` (new — ~400 LoC)
- `tests/ci-reporters.test.ts` (new — 54 tests)
- `src/cli.ts` — `--ci-format` flag + writer wiring + GHA stderr stream
- `src/index.ts` — 5 new public exports
- `tests/public-api-samples.test.ts` — snapshot updated 40 → 45

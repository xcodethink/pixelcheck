# Architecture Decision Records (ADRs)

This directory captures non-trivial design decisions made during the v1.0
build-up. Each ADR follows the structure documented in
[CONTRIBUTING.md § ADRs](../../CONTRIBUTING.md#architecture-decision-records-adrs):
context → decision → alternatives rejected → consequences → files changed.

## Index

ADRs are numbered sequentially. Numbers below 005 don't exist (the project's
formal ADR practice started at v0.3 maintenance).

### Foundational (v0.3 → v1.0)

| # | Title | Task |
|---|---|---|
| 005 | Structured logging with pino | M1-3 |
| 006 | Secrets redaction in logs and CLI output | M1-4 |
| 007 | Result schema versioning + SemVer commitment | M9-2 |
| 008 | Process-wide cost guard with persistent daily ledger | M5-6 |
| 009 | Concurrency safety for shared mutable state | M9-3 |

### Architecture (M3-6 / M9-1 / Primitives)

| # | Title | Task |
|---|---|---|
| 010 | MCP server modularization + tool registry | M3-6 + M9-1 |
| 011 | `see` primitive | N-1 |
| 012 | `act` primitive | N-2 |
| 013 | `extract` primitive | N-4 |
| 014 | `judge` + `compare` primitives | N-3 + N-8 |
| 015 | Result cache | M9-4 |
| 016 | MCP self-describe (`list_capabilities`) | M9-5 |

### Quality (M1-2 / M1-5)

| # | Title | Task |
|---|---|---|
| 017 | Coverage tooling + M1-2 Phase 1 sequencing | M1-2 |
| 018 | Public API contract tests | M1-5 |

### Reporting (M2 series)

| # | Title | Task |
|---|---|---|
| 019 | CI-friendly output formats (JUnit / SARIF / JSONL / GHA) | M2-6 |
| 020 | Stakeholder-facing PDF report | M2-1 |
| 021 | Long-running trends dashboard | M2-3 |
| 022 | PR diff report renderers | M2-5 |
| 023 | Report localisation (5 locales) | M2-4 |
| 024 | WCAG clause grouping | M2-2 |

### Engineering (M5-7 / M6-7 / M9-3.2)

| # | Title | Task |
|---|---|---|
| 025 | Performance regression suite | M6-7 |
| 026 | Unified SQLite migration runner | M5-7 |
| 029 | File-lock cross-process race tests in dedicated forks-pool | M9-3.2 (T1) |
| 031 | CI bench in observation mode (5-run calibration window) | T10 |

### v1.0 release-readiness (T-NEW-11 / Wave 0)

| # | Title | Task |
|---|---|---|
| 027 | Lock Zod v3 (defer Zod v4 to v1.x) | T0.5 |
| 028 | Defer Stagehand v3 upgrade to v1.1 | T0.5 |
| 030 | axe-core standard cumulative expansion | T-NEW-11 |

---

## Audit (2026-05-01, T19)

A one-time consistency review of all 26 ADRs:

- **All Accepted, none Superseded** — no decision has been overturned in
  the v0.3 → v1.0 build-up
- **Topics partition cleanly** — no two ADRs cover the same subject with
  conflicting decisions
- **Cross-references are coherent**:
  - ADR-029 (file-lock race) cites ADR-009 (concurrency) as parent
  - ADR-030 (axe expansion) builds on ADR-024 (wcag clause grouping)
  - ADR-007 (schema versioning) is consumed by ADR-018 (contract tests),
    ADR-019 (CI formats), ADR-020-024 (reporters), ADR-026 (migrations)
  - ADR-027 (Zod 3 lock) interacts with ADR-018 (uses Ajv as a second
    validator, deliberately decoupled from Zod runtime — explicitly
    documented in ADR-018)
  - ADR-008 (cost-guard ledger) and ADR-026 (SQLite migrations) cover
    different persistence layers (ledger.json vs *.db) and don't conflict
- **No `// TODO: write ADR for this` markers in source code**
- **Public API exports listed in ADR-018 stay coherent across ADRs**

Conclusion: ADR set is **internally consistent** and **complete enough
for v1.0 ship**. Future ADRs will land as new behaviour is introduced
(Phase 3 / Phase 4 work — multi-provider LLM, Web config UI, plugin
system, etc).

---

## Status field semantics

| Status | Meaning |
|---|---|
| `Proposed` | Draft for review; behaviour not yet implemented |
| `Accepted` | Decision is binding; behaviour implemented or in-progress |
| `Superseded by ADR-NNN` | Replaced by a later decision; left here for history |

Currently all 26 ADRs are `Accepted`. When a decision is reversed, mark
the old one `Superseded by ADR-XXX` (don't delete) and write a new ADR
explaining the new direction + why the old one no longer fits.

---

## When to write an ADR (recap)

- New dependency added to `dependencies` (not devDependencies)
- Public API surface change (`src/index.ts` exports)
- Published JSON Schema shape change (any of `docs/schemas/*.json`)
- New SQLite migration or storage path
- New CI gate / threshold change

When **NOT** to write one:
- Renaming a variable
- Adding a test (unless it's a new test architecture)
- Bumping a patch version of a dep without behaviour change
- One-line bug fix

# Architecture Decision Records (ADRs)

This directory captures non-trivial design decisions made during the v1.0
build-up. Each ADR follows the structure documented in
[CONTRIBUTING.md § ADRs](../../CONTRIBUTING.md#architecture-decision-records-adrs):
context → decision → alternatives rejected → consequences → files changed.

## Index

ADRs are numbered sequentially. ADR-001..004 (Founding) were back-filled
2026-05-02 (commit `8a09023`) to capture the v1.0 founding decisions retroactively;
ADR-005 onward were written contemporaneously with the v0.3 maintenance →
v1.x work.

### Founding (v1.0 positioning, back-filled 2026-05-02)

| # | Title | Task |
|---|---|---|
| 001 | AI-first positioning | v1.0 ship-prep |
| 002 | Primitive-first architecture (`see`/`act`/`extract`/`judge`/`compare`) | v1.0 ship-prep |
| 003 | Registration as research-only | v1.0 ship-prep |
| 004 | Worktree-isolated development | v1.0 ship-prep |

### Foundational engineering (v0.3 → v1.0)

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
| 028 | Defer Stagehand v3 upgrade to v1.1 | T0.5 (superseded by 035) |
| 030 | axe-core standard cumulative expansion | T-NEW-11 |
| 032 | Vendor stealth-core into src/vendor/ for tarball-installable v1.0 | T31.5 |

### v1.x rebrand + dependency wave (post-v1.0)

| # | Title | Task |
|---|---|---|
| 033 | Rename ai-browser-auditor → PixelCheck + AI-first MCP repositioning | v1.0 brand |
| 034 | Multi-dimensional result envelope (`diagnostics` field) — Phase 0 | Phase 0 |
| 035 | Stagehand v3.3.0 migration with Playwright + CDP bridge (originally filed as ADR-029) | T-NEW-1 |

---

## Audit (refreshed 2026-05-05 — batch 1 doc reconciliation)

A consistency review of all **35 ADRs** (ADR-001..035; no gaps within 001-035
— a single number conflict on 029 was resolved by renumbering the Stagehand
v3 migration ADR to 035, see commit `ad8d71b`):

- **Almost all Accepted; ADR-028 is `Superseded by ADR-035`** — single
  reversal on the v0.3 → v1.x build-up
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
  - ADR-031 (CI bench observation) cites ADR-009 (concurrency) and
    ADR-029 (forks-pool isolation) as related precedents
  - ADR-032 (vendor stealth-core) cites ADR-018 (vendor exempt from
    public API contract tests), ADR-027 / ADR-028 (similar ship-now,
    evolve-later decisions)
- **No `// TODO: write ADR for this` markers in source code**
- **Public API exports listed in ADR-018 stay coherent across ADRs**
- **Founding ADR-001..004** (back-filled 2026-05-02) capture v1.0 positioning
  retroactively — AI-first positioning, primitive-first architecture,
  registration as research-only, and worktree-isolated dev — and are cited
  by ADR-033 (rebrand) which extends the AI-first positioning narrative.
- **ADR-034** (multi-dimensional envelope) builds on ADR-007 (schema
  versioning) and is the active Phase 0 / 1.3.0 work line.
- **ADR-035** (Stagehand v3) supersedes ADR-028 (deferred decision) and
  closes the 3 transitive vulnerabilities waived in SECURITY.md v1.0.0.

Conclusion: ADR set is **internally consistent** and **complete enough
for v1.x ship**. Future ADRs will land as new behaviour is introduced
(Phase 0 PR-B/C/D/E, Phase 3 / Phase 4 work — multi-provider LLM, Web
config UI, plugin system, etc).

---

## Status field semantics

| Status | Meaning |
|---|---|
| `Proposed` | Draft for review; behaviour not yet implemented |
| `Accepted` | Decision is binding; behaviour implemented or in-progress |
| `Superseded by ADR-NNN` | Replaced by a later decision; left here for history |

Currently 34 of 35 ADRs are `Accepted`; **ADR-028 is `Superseded by ADR-035`**
(Stagehand v3 deferral was reversed when v3.3.0 dropped the vulnerable
transitive deps). When a decision is reversed, mark the old one
`Superseded by ADR-XXX` (don't delete) and write a new ADR explaining the
new direction + why the old one no longer fits.

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

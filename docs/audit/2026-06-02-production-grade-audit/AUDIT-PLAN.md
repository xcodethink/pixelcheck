# pixelcheck — Production / Institutional-Grade Pre-Release Audit Plan

> **Created**: 2026-06-02 · **Baseline commit**: `299500e` (main, after the 6 reliability PRs)
> **Mandate (Wayne)**: full audit to engineering / commercial / institutional / production grade.
> **Discipline (locked)**: AUDIT first — find *all* problems, do **not** fix while auditing.
> Then stop → holistic root-cause grouping → one-shot comprehensive fix → local perfect
> closed-loop (CI green + self-test + real run) → **only then** update the public repo.
> **Standards referenced**: skill 04 (security/OWASP), skill 13 (full-link inspection),
> skill 22 (Go-No-Go gates), skill 20 §8 (feature-level audit), Google-style acceptance.

## Scope

Target: `~/Developer/ai-browser-auditor` (published as npm `pixelcheck` v1.2.1).
Surface: CLI + MCP server + library + scripted/autonomous browser-audit engine.
**Read-only.** No code changes in this phase.

## Dimensions (parallel deep audit)

| # | Dimension | Focus |
|---|---|---|
| D1 | Security & supply chain | browser-binary download+unpack (HTTPS/checksum/path-traversal/cmd-injection), API key + injected session-cookie handling, MCP exposed-tool abuse (arbitrary write / SSRF via target URL / exec), secret redaction completeness (reports/logs/screenshots/HAR), .env precedence, consent gating |
| D2 | Robustness & liveness | dead-loops / no-progress detection (explore agent stuck on login — observed), budget/token/time guards, retry/backoff, timeouts on browser/LLM/network, unhandled rejections, partial-failure handling, resource cleanup (browser/context leaks) |
| D3 | Correctness & completeness | core primitives (see/act/extract/judge/compare), scenario runner, scoring + result envelope, cost-ledger accuracy, logic bugs / off-by-one / swallowed errors (empty catch), unsafe casts; **test blind spots** on critical paths |
| D4 | Cross-platform / build / release | Windows/macOS/Linux path + behavior, Node 20/22, postinstall, published-package contents (files allowlist — no secrets/sources leaked, right dist), bin entrypoint, ESM/CJS |
| D5 | CLI / MCP UX + report output | CLI errors/help/exit codes, doctor honesty, HTML report (audit.html / explorer) correctness + a11y + polish, JSON/SARIF validity, stakeholder readability |
| D6 | Eng-standard acceptance | coverage adequacy + gaps, CI gate completeness, observability/logging, docs accuracy (README/CONTRIBUTING/SECURITY vs reality), ADR coverage, dependency hygiene (remaining 17 low advisories) |

## Method

- 6 read-only audit agents, one per dimension, deep code read + reasoning.
- Each returns structured findings: `{id, severity(critical/high/med/low), file:line, rootCause, evidence, whyItMatters, dimension}`.
- Synthesis: dedupe + **group by root cause** (problem-analysis 铁律), cross-dimension correlation.
- Output: `FINDINGS.md` (full inventory) — **then STOP for Wayne's holistic review + fix-plan approval**.

## Definition of Done (audit phase)

- [ ] All 6 dimensions covered, findings inventoried with evidence.
- [ ] Findings grouped by root cause (not symptom).
- [ ] Severity-ranked; no silent truncation (any coverage cap logged).
- [ ] Presented to Wayne; fix implementation **not started** until plan approved.

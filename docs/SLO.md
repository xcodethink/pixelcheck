# Service Level Objectives (SLOs)

> **Status**: v1.0 commitment. Reviewed each minor release.
>
> **Audience**: enterprise users evaluating PixelCheck for production
> integration; contributors deciding whether a regression warrants a
> patch release; downstream tooling built against PixelCheck's
> contract surfaces.

PixelCheck is a CLI tool and library that runs on the operator's own
machine. Unlike a hosted SaaS, we cannot guarantee uptime — we don't
host anything that can be down. What we *do* commit to is a set of
measurable, testable objectives across the four surfaces an operator
actually depends on:

1. **Install + cold-start UX** — does the tool work the first time?
2. **Run reliability** — when an audit runs, does it complete cleanly?
3. **Contract stability** — can downstream tooling rely on schemas /
   CLI flags / MCP surface across minor releases?
4. **Privacy + security defaults** — does the tool stay honest about
   what leaves your machine?

We list bounds we explicitly do **not** commit to at the bottom — being
honest about scope is itself a commercial-grade signal.

---

## 1. Install + cold-start UX

| SLO | Target | How measured |
|---|---|---|
| `npm install pixelcheck` exit 0 on tier-1 platforms | ≥ 99% | CI matrix: 4 OS × 3 Node = 12 configs (`.github/workflows/ci.yml` + `dogfood.yml`) |
| `pixelcheck doctor --skip-network` runs end-to-end without crash | 100% | `tests/doctor.test.ts` (36 unit tests) |
| `pixelcheck init <dir>` scaffold completes | 100% | `tests/init-interactive.test.ts` (13 tests) |
| Tarball ≤ 1 MB | Hard gate | `dogfood.yml` workflow fails the PR if exceeded |
| First-run friendly errors when API key missing | No stack trace | `src/cli.ts` ConsentDeclinedError + ANTHROPIC_API_KEY missing branches |

**Commitment**: a regression in any of the above triggers a v1.0.x
patch release within 7 days of confirmation.

---

## 2. Run reliability

PixelCheck launches a Chromium browser and calls the Anthropic API. We
cannot guarantee target-site behaviour or third-party API availability,
but we *can* control how we degrade.

| SLO | Target | How measured |
|---|---|---|
| Cost-guard correctly stops runs at the configured budget | 100% | `tests/cost-guard*.test.ts` (multi-process tests) |
| Concurrent process safety on shared state (history.db, ledger, cache) | 0 corruption | `tests/integration/file-lock-race.test.ts` (forks pool, 20× rerun verified) |
| Result schema validation passes on every emitted artifact | 100% | `tests/result-schema.test.ts` + `tests/public-api-samples.test.ts` |
| Test suite flake rate | < 1% across 20 reruns | `npm run test:integration` 20× verified locally; CI weekly cron tracks |
| Memory peak during a 5-unit audit (Apple Silicon, deterministic-only steps) | < 1 GB | `npm run measure:memory` writes `docs/perf-memory.json` |
| Performance regression on hot-path renderers | 0 regression beyond 30% per benchmark | `npm run bench:check` (M6-7) |

**Degradation we tolerate as expected behaviour** (not regression):

- LLM-graded `judge` / `compare` scores can drift up to 5% across
  model upgrades — calibrated by `npm run calibration:check` (T8).
- Anthropic API 5xx propagates as a `fail` step, not a crash.
- Target site network errors are recorded as step failures, not crashes.

---

## 3. Contract stability

PixelCheck has four contract surfaces. v1.0+ commits to SemVer on each:

| Surface | Stability commitment | Tracked by |
|---|---|---|
| `audit.json` Result Schema | Minor: additive only. Major: breaking allowed with MIGRATION.md. | `RESULT_SCHEMA_VERSION` constant, JSON Schemas in `docs/schemas/` |
| CLI flags (`pixelcheck run`, `init`, `doctor`, etc.) | Minor: additive + deprecation cycle. Removal in next major only. | [DEPRECATION-POLICY.md](./DEPRECATION-POLICY.md) — 2-version sunset |
| MCP tool surface (tool names, input/output shape) | Same as CLI | `tests/list-capabilities.test.ts` snapshots stable shape |
| Library exports (`from "pixelcheck"`) | Public API contract tests enforce the listed exports stay | `tests/public-api-samples.test.ts` (ADR-018) |

**Commitment**: a contract break ships only with a major version bump
and a populated [MIGRATION.md](../MIGRATION.md) section. The two-version
deprecation cycle ([DEPRECATION-POLICY.md](./DEPRECATION-POLICY.md))
guarantees minimum migration headroom.

---

## 4. Privacy + security defaults

| SLO | Target | How measured |
|---|---|---|
| Zero outbound telemetry | 100% | [PRIVACY.md](../PRIVACY.md) declared; only `api.anthropic.com` is contacted, and only for audit calls the operator triggered |
| `--redact-inputs` enabled by default | Always ON unless explicit opt-out | `src/core/recorder.ts > shouldRedactInputs` 4-priority resolver |
| Sensitive-input redaction coverage (12 patterns: password / secret / token / api key / OTP / PIN / recovery code / backup code / MFA / 2FA / AWS / private key / passphrase / SSN / credit card / CVV) | 100% of matched fields redacted before screenshot | `tests/integration/playwright/recorder.test.ts > fixture-with-real-tokens` |
| Reports stored at mode 0700 (POSIX) | 100% | `tests/runner.test.ts > runDir mode 0700` |
| Secrets redacted from log output | 100% | `src/core/secrets.ts` + `tests/secrets.test.ts` |
| Vendored `stealth-core` source not exposed in npm tarball | Always | `package.json files` field excludes `src/` |
| First-run consent prompt before any data leaves the machine | 100% on TTY | `src/core/consent.ts` 5-priority resolver |

**Commitment**: a privacy SLO regression is a P0 ship-blocker — fix
within 24 hours of confirmation, regardless of release calendar.

---

## 5. Issue response + release cadence

| Severity | Response (acknowledgement) | Resolution target |
|---|---|---|
| P0 (privacy regression / security vuln / install broken) | within 24 hours | within 7 days |
| P1 (functional regression with workaround / docs missing) | within 7 days | within 30 days |
| P2 (cosmetic / wishlist / non-blocking) | within 30 days | best effort |

Channels:

- Functional bugs: open a GitHub issue using the bug template
- Security: see [SECURITY.md](../SECURITY.md) (private GHSA flow)
- Code-of-conduct: see [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md)

Release cadence:

- Patch (v1.0.X): on demand for P0/P1 regressions
- Minor (v1.X.0): no fixed cadence; ship when meaningful additive
  features accumulate
- Major (v2.0.0): no current plan; would only ship for documented
  breaking changes that can't be deprecated cleanly

Every release ships a CHANGELOG entry, a tagged commit, and a GitHub
Release page with SBOM artifact (CycloneDX).

---

## What we do NOT commit to

Being explicit about scope is itself a commercial-grade signal —
operators integrating PixelCheck need to know which risks remain
on their side.

| Out of scope | Why | What you should do |
|---|---|---|
| LLM model behaviour / cost stability | Anthropic Claude is a third-party service; pricing and behaviour evolve outside our control | Use `--budget` to cap spend; pin model version in config |
| Target site availability | We audit *your* sites — if the target is down, the audit fails | Standard CI retry pattern; treat fails as transient |
| Anthropic API uptime / quota | Third-party SLO outside our control | Honour `Retry-After`; cost-guard makes failure modes predictable |
| Stealth fingerprint defeating bot-detection on every site | Anti-detection is a moving target | Treat detection as a finding, not a tool defect |
| Compliance certifications (SOC 2 / ISO 27001 / etc.) | We ship a tool, not a hosted service — these certifications apply to data processors, not local CLI tools | If you need a SOC-2-controlled audit pipeline, run PixelCheck inside your own SOC-2 environment |
| 100% test coverage | Coverage gates are at 66/60/66/66 floor (vitest config). We optimise for tested critical paths over universal coverage. | See [ADR-017](decisions/ADR-017-coverage-tooling-and-m1-2-phase-1.md) |

---

## How we audit our own SLOs

This document is part of the [release-readiness checklist](../progress/RELEASE-READINESS-CHECKLIST.md)
review. Each minor release re-validates every SLO above against the
trailing 30 days' data:

- Install + cold-start: GitHub Actions matrix run history
- Run reliability: weekly `bench.yml` cron + ad-hoc 20× flake reruns
- Contract stability: `tests/result-schema.test.ts` + git tag SemVer audit
- Privacy: schema/code review + `npm run measure:memory` + `tests/integration/playwright/recorder.test.ts`
- Issue response: GitHub Issues turnaround stats

Failure to meet a stated SLO over a release cycle results in a
documented incident note in `docs/release-notes/` and a pinned issue
declaring the corrective action plan.

---

**Last reviewed**: v1.0 ship preparation (2026-05).
**Next review**: v1.1 release readiness gate.

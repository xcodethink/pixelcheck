# ADR-031 — CI bench in observation mode (5-run calibration window)

**Status**: Accepted
**Date**: 2026-05-02
**Closes risks**: R51 / R52 / R53
**Task**: T10

## Context

`npm run bench:check` (M6-7) is the runtime regression gate for the 11
hot-path benchmarks in `tests/perf/*.bench.ts`. Locally it works well —
the maintainer's Apple Silicon dev machine produces tight, reproducible
ops/sec numbers and a 30% tolerance reliably catches real regressions
without false positives.

GitHub-hosted ubuntu runners are a different environment:

- Shared physical hardware → noisier CPU cycles
- Different microarchitecture (Intel Xeon vs Apple Silicon)
- Different libuv / V8 version on Linux vs macOS
- No baseline established on Linux

Promoting `bench:check` to a hard required status check before we know
the real run-to-run variance on the CI runner profile would either:

- **Fail constantly** if our tolerance is too tight for CI noise → blocks
  PRs on non-regressions, erodes trust in the gate
- **Pass real regressions** if we slacken tolerance to absorb noise →
  defeats the gate's purpose

## Decision

Run `npm run bench` + `npm run bench:check` on CI in **observation
mode** for 5+ scheduled runs before promoting it to a required check:

1. New workflow `.github/workflows/bench.yml`:
   - Weekly cron (Sundays 03:17 UTC, off-peak)
   - Manual trigger via `workflow_dispatch`
   - Opt-in PR trigger via `bench` label
2. `bench:check` step runs with `continue-on-error: true` — never fails
   the workflow
3. `docs/perf-current.json` uploaded as 90-day retention artifact
4. After 5 runs: review variance, set calibrated tolerance, write
   follow-up ADR promoting bench:check to a required check

## Why not gate from day one?

Because we don't know what the right tolerance is. Local Apple Silicon
ops/sec for `renderHistoryTrendsHTML` is ~340; on a free-tier ubuntu
runner under load it could be 200-400 with no real change. We need
empirical data before setting a number.

The opportunity cost of the 5-run calibration window is small (one
weekly run × 5 weeks = ~5 weeks of v1.x dev) and the alternative
(setting an arbitrary tolerance) has high cost in either direction.

## Why not skip CI bench entirely?

Two reasons it's worth running even in observation mode:

1. **Drift detection without gating** — if a PR halves an ops/sec
   number, maintainers see it in the artifact JSON and can investigate
   *before* it ships, even if CI didn't fail
2. **Calibration data** — exactly what this ADR is about

## Why weekly cron not on every PR?

`npm run bench` takes 8-10 minutes. Running it on every PR would consume
~80 PRs × 10 min = 13 hours/month of CI minutes for low marginal value
(most PRs are docs / tests / non-perf-relevant). Weekly cron + label
opt-in covers the value (catch slow drift, allow targeted measurement)
without burning the CI budget.

## Why not run on the local CI matrix (4 OS × 3 Node)?

bench is comparing **ops/sec to a baseline** — the baseline must be
collected on the same runner profile each time. Running on 12 different
configs would generate 12 incompatible baselines. Pin to ubuntu-latest +
Node 20 for now; expand if we ever need cross-platform perf data.

## Promotion criteria (when to make this gate hard)

After 5+ successful observation runs:

- Compute the empirical p95 deviation per benchmark across runs
- Set tolerance to 1.5× p95 (gives headroom for genuine outliers)
- Rewrite this ADR's status to "Superseded by ADR-XXX promoting bench:check"
- Update `bench.yml` to remove `continue-on-error: true`
- Add bench.yml to branch protection required status checks

## Consequences

- CI cost: ~10 min × 4-5 weekly runs/month = ~50 min/month (well within
  the 2000-min/month free tier for OSS repos)
- Telemetry artifact retention: 90 days × 1 file × 50 KB = trivial
- v1.0 ships with bench observed but not gated — the M6-7 doc explicitly
  says this is the v1.0-rc1 calibration plan

## Related ADRs

- [ADR-009](ADR-009-perf-bench-baseline.md) — original M6-7 design
  defining the 11 benchmarks + tolerance + storage
- [ADR-029](ADR-029-file-lock-race-isolation.md) — example of a similar
  "observe before gate" pattern for cross-process tests

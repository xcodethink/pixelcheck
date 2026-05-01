# ADR-025 — Performance regression suite (M6-7)

- **Status**: Accepted
- **Date**: 2026-05-01
- **Task**: M6-7 — Performance regression suite

## Context

The auditor has shipped 28 commits across Phase 2 — new reporters (PDF / trends / diff / SARIF / JUnit / JSONL / GHA), new modules (i18n / WCAG / 4 CI writers), and substantial refactors (M1-2 Phase 1+2 covered 16 modules with 188 tests). Every one of these had unit-test coverage but **none of them measured wall-clock performance impact**.

The classic post-shipping failure mode this leaves us exposed to:

- An engineer adds a new feature with O(N²) iteration where O(N) was sufficient. Tests pass. The feature works. But each subsequent audit run is 5 seconds slower.
- A library upgrade changes internal hot-path behaviour. We're a Playwright + Zod + Anthropic SDK consumer; their major versions periodically rewrite hot paths.
- A schema field addition forces JSON serialisation to run an extra deep-copy somewhere.

None of these break tests. None of these surface in CI. They bleed performance over the next 12 months until someone notices and bisects.

Commercial-grade products have a performance-regression gate alongside the test gate. v1 is shipping to enterprise users; this is the standard expectation.

## Decision

Three small, focused pieces:

1. **`tests/perf.bench.ts`** — vitest `bench()` benchmark file covering 9 hot paths
2. **`src/perf/compare.ts` + `scripts/check-perf.ts`** — baseline-comparison script
3. **`docs/perf-baseline.json`** — the recorded baseline (checked in)

### What's benchmarked (and what isn't)

**Benchmarked** (pure functions, deterministic, reproducible):

| Benchmark | Why |
|---|---|
| `renderPdfHtml` | Largest stakeholder artefact; regresses easily on template changes |
| `renderTrendsHtml` | 5 inline-SVG charts; regresses on data-aggregation changes |
| `renderDiffMarkdown` / `renderDiffHtml` | PR comment surface; tight latency budget when posted in CI |
| `renderJunitXml` / `renderSarif` | CI-pipeline emission; called per audit unit |
| `summarizeWcag` | 50 issues × 8 SCs aggregator; called every report |
| `computeSummary` (trends) | 100-row aggregation; trend dashboard's hot path |
| `t()` i18n lookup | Called hundreds of times per render; dictionary access shouldn't slow |

**Not benchmarked** (unstable, costly, or out-of-scope):

- Real Chromium spawn — 2+ second cold-start, flaky in CI
- Real LLM calls — costs money, response-time variance is huge
- Real SQLite write throughput — depends on disk; M9-3 has its own micro-benchmark
- `AuditRunSchema.parse` on 20-unit fixture — vitest can't fit even one sample within its 500ms per-bench budget; covered indirectly through Issue / DimensionScore round-tripping

### Tolerance: 50% default

Measured run-to-run variance on a quiet M-series MacBook with pre-built fixtures:

```
renderPdfHtml         spread 53%
renderTrendsHtml      spread 46%
renderJunitXml        spread 37%
renderDiffMarkdown    spread 29%
renderDiffHtml        spread 27%
t()                   spread 26%
computeSummary        spread 15%
renderSarif           spread 10%
summarizeWcag         spread  8%
```

This is the *natural noise floor* on warm hardware with no other load. CI runners are noisier. A 30% tolerance would produce false positives daily. A 50% tolerance catches:

- O(N²) loops (10×+ slowdown)
- Synchronous I/O slipping into hot paths (5–10× slowdown)
- Algorithm regressions (typically 2× or more)

But absorbs:

- Single-run variance from background OS processes
- GC scheduling differences
- CPU thermal throttling on laptops

Operators who want stricter enforcement pass `--tolerance 0.30`; once the project has enough run history to characterise CI runner variance, the default can ratchet down.

### Baseline shape: min-of-N

The initial `docs/perf-baseline.json` records the **minimum** ops/sec across 5 consecutive runs. This is intentionally conservative — any subsequent run faster than the slowest historical run is fine; only runs slower than the slowest baseline run get flagged.

Alternative shapes considered: median (central tendency, but doesn't anchor regressions well), average (pulled by outlier slow runs), max (would aggressively flag regression-to-mean as regression). Min wins because the comparison semantics ("did we get slower than we've ever been?") is robust to noise above the baseline.

### Workflow

```bash
# Record current performance (writes docs/perf-current.json)
npm run bench

# Compare current against baseline; exit 1 if any regression > tolerance
npm run bench:check

# Bake current as new baseline (after intentional perf change)
npm run bench:update
```

The CI integration is opt-in for now. Real CI runners' variance is likely higher than local; we want a few release cycles of "developer machine baseline" data before we put this in front of every PR. When we do, the recommended pattern is:

```yaml
# .github/workflows/perf.yml
- run: npm run bench
- run: npm run bench:check     # exit 1 fails the build
```

## Alternatives rejected

1. **Microbenchmark library (e.g. `tinybench` directly, `mitata`, `benny`)** — vitest `bench` already wraps tinybench under the hood. Direct usage would require a separate runner config and abandon vitest's familiar `describe` / file-discovery pattern. The project standardised on vitest in M1-2; using its bench API keeps tooling consistent.
2. **Use `console.time` / `process.hrtime` ad-hoc inside tests** — produces measurements, not a regression gate. Without a baseline file + tolerance comparison the data has no enforcement teeth.
3. **Run the benchmark suite on every test run (`npm test` includes bench)** — bench files take 5+ seconds because tinybench runs each benchmark for ~500ms to converge. This would 5–10× the test runtime developers wait through. vitest's separation of `*.test.ts` vs `*.bench.ts` is designed exactly to avoid that — keep `npm test` fast, run `npm run bench` deliberately.
4. **Track wall-clock time of an end-to-end audit (the highest-fidelity signal)** — would need a real Chromium, real LLM, and a stable test fixture site. We don't have a stable in-repo fixture site for that; the variance from network / LLM API would dominate. Defer until M6-3 / M6-4 (resume + retry) lands.
5. **Use percentile-based detection (p99 latency) instead of mean ops/sec** — vitest's bench already computes p99 / p995 / p999, but ops/sec is the metric that maps cleanly to "did this regress?" for a stakeholder. p99 latency is more useful when investigating an actual regression; it stays in the JSON dump for ad-hoc inspection.
6. **Auto-bump tolerance based on observed historical variance** — would require storing a window of recent baselines and computing rolling stddev. Premature; the simple min-of-N + 50% tolerance catches the failure modes we actually care about. Add adaptive tolerance only after a real false positive pattern emerges.
7. **Fail tests on any regression, not just > tolerance** — would be hostile to legitimate work where a deliberate optimisation in one place slows another by 10%. The whole point of a tolerance is to absorb tradeoffs that net out positive.
8. **Track memory footprint alongside ops/sec** — measurable via `process.memoryUsage()` but easily skewed by garbage-collection timing within the bench. We're far enough from memory pressure that ops/sec is the operational signal that matters first; revisit if the project ever runs out of memory in production.
9. **Run benchmarks on a dedicated bare-metal CI runner** — the right answer for serious sustained perf monitoring, but premature for single-maintainer v1. The current local-development workflow + checked-in baseline is enough to catch the catastrophic regressions; bare-metal infra is M6-7.1.
10. **Write a per-PR perf comparison comment via a GitHub Action bot** — depends on hosted runner availability + CI tier; out of scope for the static checked-in tool. Add when project moves to a paid CI tier.

## Consequences

- An engineer can sanity-check their change with `npm run bench:check` before pushing. Catastrophic regressions get flagged immediately with a specific benchmark name and slowdown percentage.
- The baseline JSON in `docs/perf-baseline.json` becomes a project artefact that records "this is roughly what the auditor's hot paths cost on commodity hardware". Useful when triaging "is this slow because of my change or because the codebase has gotten slower over time?".
- 33 new unit tests for the comparison logic (the script itself is unit-tested even though the bench suite is hard to test); coverage 100% statements / 82% branches.
- 1445 → 1478 tests pass (+33). Coverage gate stays green.
- Adding new reporters / aggregators in future tasks should add a benchmark for the hot path — this becomes a soft convention enforced by code review, not an automated check.

## Files added / changed

- `tests/perf.bench.ts` — new (~200 LoC, 9 benchmarks)
- `src/perf/compare.ts` — new (~140 LoC)
- `scripts/check-perf.ts` — new (~110 LoC, CLI wrapper)
- `tests/perf-compare.test.ts` — new (33 tests)
- `docs/perf-baseline.json` — new (initial baseline, min-of-5 on M3 Pro)
- `package.json` — `bench` / `bench:check` / `bench:update` scripts
- `.gitignore` — `docs/perf-current.json` (regenerated on every bench run)

# ADR-017 — Coverage tooling + M1-2 Phase 1 sequencing

- **Status**: Accepted
- **Date**: 2026-04-30
- **Task**: M1-2 — `core/` module unit tests, target ≥ 80% coverage on testable surface
- **Phase**: This ADR records the **first slice** of M1-2 (called *Phase 1*). Subsequent phases are listed under §"What stays for M1-2 Phase 2/3".

## Context

By the end of Phase 1 of the v1 plan (M9-5 / ADR-016), the project shipped 686 tests across 12 MCP tools, 5 primitives, file-lock, cost-guard, result-cache, and self-describe. But coverage was uneven and **never measured** — the `npm test` script ran only `vitest run` without instrumentation. Reviewing the codebase:

- A first-time `vitest --coverage` run reported **51.5% statements / 45.75% branches / 54.67% functions / 52.16% lines** across the public surface (`src/**/*.ts` minus entry-points and pure-type contracts).
- The legacy `core/` carried 13 zero-coverage files (`scenario.ts` / `config.ts` / `runner.ts` / `computer-use.ts` / `recorder.ts` / `reporter.ts` / `notify.ts` / `email.ts` / `throttle.ts` / `url-preflight.ts` / `page-stability.ts` / `stagehand-wrapper.ts` plus `agent/agent-loop.ts`).
- Several other files sat in the 40–60% range (`critic.ts` 3%, `llm.ts` 22%, `image.ts` 44%, `persona.ts` 45%, `secrets.ts` 57%, `visual-diff.ts` 62%).

The Phase 2 plan calls for ≥ 80% coverage on `core/` modules. That's roughly +900 covered statements over baseline. Doing it in one push has two problems:

1. **The total work is multi-conversation** — each `runner` / `computer-use` / `agent-loop` test alone needs heavy mocking of Playwright, Stagehand, Anthropic SDK, history DB, etc. We would over-run any reasonable conversation budget and end with a partial commit.
2. **Coverage without a regression gate is decorative** — without `thresholds`, the next PR can drop coverage and nobody notices. The gate has to land **before** big batches of tests so it actively guards the gain.

So Phase 1 reframes M1-2 around two deliverables:

- **A** — coverage tooling and a regression-protecting threshold gate that lives in `vitest.config.ts` and the npm scripts.
- **B** — push the *easy-win* modules (small surface, pure logic, mockable I/O — anything that doesn't need a real Playwright/Anthropic client) to ≥ 80% so the threshold gate can ratchet up against a real floor, not vapor.

## Decision

### A. Coverage tooling

- Add `@vitest/coverage-v8` ^4.1.5 as dev dep.
- `vitest.config.ts` enables `coverage` with provider `v8`, three reporters (`text-summary`, `html`, `json-summary`), and a fixed `./coverage` output dir.
- `include: ["src/**/*.ts"]` — broad by default so every file added to `src/` is automatically counted.
- `exclude:`
  - `src/cli.ts`, `src/index.ts`, `src/mcp/server.ts` — entry-points are integration-tested via the live MCP handshake check + `pixelcheck-cli --help` smoke. Counting them dilutes the statement count without telling us anything about logic correctness.
  - `src/core/types.ts`, `src/core/result-schema.ts` — pure type contracts. `schema.test.ts` and `result-schema.test.ts` exercise them through consumers with happy + reject + envelope round-trip. Counting them as separate statements double-counts the same coverage.
  - `**/*.d.ts`.
- `thresholds: { statements: 50, branches: 45, functions: 50, lines: 50 }` — set **≤ baseline** so the gate flips green on day 1 and *catches* regression instead of *blocking* the build. Each subsequent M1-2 commit ratchets the floor up after pushing it.
- Two npm scripts: `test:coverage` (writes report) and `test:coverage:check` (enforces thresholds, fails on regression).

### B. Phase 1 module coverage

Six small pure modules + five utility I/O modules + one wrapped client:

| Module | Before | After | Notes |
|---|---|---|---|
| `scenario.ts` | 0% | 100% stmt / 97% branch | YAML loader, template substitution, autonomous-mode helper, execution matrix. |
| `config.ts` | 0% | 100% stmt | Project YAML loader, env validator (incl. Stripe `pk_live_` refusal). |
| `throttle.ts` | 0% | 95% stmt | Per-origin task serialization, cross-origin parallelism, post-failure recovery. |
| `url-preflight.ts` | 0% | 100% stmt | HEAD/GET probe with retry; mocked global fetch. |
| `image.ts` | 44% | 88% stmt | sharp-driven vision compression; uses `crypto.randomBytes` to force above bypass threshold. |
| `persona.ts` | 45% | 100% stmt | YAML loader + env-placeholder resolver + `url_locale` derivation. |
| `secrets.ts` | 57% | ~100% stmt | Admin cookies, Stripe defaults, redact patterns, deep redaction. |
| `page-stability.ts` | 0% | 40% stmt (Node-side 100%) | Playwright `Page` mocked. **Inner `evaluate(callback)` bodies run only in a browser context and can't be reached from Node** — flagged for Phase 2 if we accept refactoring the callbacks into pure exported functions + jsdom. |
| `visual-diff.ts` | 62% | 79% stmt | Real odiff-bin against sharp PNGs; bootstrap branch tested elsewhere. |
| `notify.ts` | 0% | 100% stmt | Slack + Telegram dispatch with `[PASS]` / `[WARN]` / `[FAIL]` tagging. |
| `email.ts` | 0% | 100% stmt | mail.tm temp-inbox client, all three response-shape variants, fake-timer poll loop. |
| `stagehand-wrapper.ts` | 0% | 90% stmt | `@browserbasehq/stagehand` mocked via `vi.mock` + `vi.hoisted` shared capture so the wrapper runs end-to-end without Chromium. |

Net Phase 1 result: **686 → 874 tests** (+188), global coverage **51.5% → 57.5% statements** / **45.75% → 51.27% branches**. Threshold gate green at `50 / 45 / 50 / 50`.

## What stays for M1-2 Phase 2/3

| Module | LoC | Why deferred |
|---|---|---|
| ~~`core/critic.ts`~~ | ~~248~~ | **Done in Phase 2 (2026-04-30):** `tests/critic.test.ts` 24 tests, 3.33 → 100% stmt / 93% branch. `vi.hoisted` shared-capture mock of `./llm.js`; `extractJson` + `compressForVision` stay real; covers happy path / multi-image label convention / verdict.violations mapping / malformed-JSON resilience / schema validation reject / prompt construction (anti-hallucination + data-exposure + persona context) / callVision error propagation / `result.raw` preservation. Threshold ratcheted 50/45/50/50 → 55/50/55/55. |
| ~~`core/llm.ts`~~ | ~~304~~ | **Done in Phase 2 (2026-04-30):** `tests/llm.test.ts` 38 tests, 22 → 87% stmt / 87% branch / 100% func. `vi.mock("@anthropic-ai/sdk")` + `vi.mock("./cost-guard.js")` + `vi.resetModules` per-test for the singleton client. Covers `getAnthropicClient` singleton + missing-key throw, `estimateCost` for all 3 priced models + sonnet fallback for unknowns, `callVision` request shaping (legacy imageBase64 / images[] preference / per-image label / userPrompt last / systemPrompt + maxTokens forwarding) + response handling (text-block join / non-text filtering / cost-guard hooks pre/post / error propagation), `extractJson` for all paths (fenced w/ + w/o lang / bare / prose-wrapped / nested braces in string / escaped quotes / truncated array repair / trailing comma strip / no-JSON throw / missing-closing-fence fallback). Threshold ratcheted 55/50/55/55 → 58/52/58/58. |
| ~~`core/instruction-mutator.ts`~~ | ~~373~~ | **Done in Phase 2 (2026-04-30):** `tests/instruction-mutator-extended.test.ts` 37 tests complementing the original 9-test file, 41.58 → 86.13% stmt / 65% branch / 93% func / 86% line. Covers `generateMutations` orchestration (with + without cost) including LLM-rewrite ordering / no-op + empty-trim rejection / silent error fallback / DOM-truncate-to-1500 / schema_version stamping / page.evaluate single-call + throw fallback; `autoDiscoverSelectors` (stagehand observe map+filter+slice 5 / throw → []); 15 verb-swap pairs and 3 hint-appending fallbacks via `rephrase` (exercised through `mutateDecompose`'s no-pattern fallback). Remaining 14% = `getInteractiveElements` inner `page.evaluate(callback)` body (browser-only — same constraint as page-stability). Threshold ratcheted 58/52/58/58 → 59/53/59/59. |
| ~~`core/reporter-spa.ts`~~ | ~~310~~ | **Done in Phase 2 (2026-04-30):** `tests/reporter-spa.test.ts` extended 5 → 13 tests, 60 → 93.33% stmt / 100% branch / 100% func. The file is mostly a giant inline-JS template literal that runs in the browser, not Node — V8 sees only the wrapping `renderSpa` + `escapeHtml` + `writeSpaReport` (15 statements total). New tests trigger every `escapeHtml` switch case via `audit.project_name` / `audit.run_id` (the only two `escapeHtml` callsites; everything else in the body goes through the JSON `<` / `>` escape) plus the empty-/undefined-`redact_patterns` fast-path bypassing `redactDeep`. The remaining ~7% is the unreachable `default:` return in `escapeHtml`'s switch (dead defensive code). Closes M1-2 Phase 2's LLM-heavy quartet. Threshold not ratcheted — sub-1pt gain. |
| `core/runner.ts` | 565 | The audit orchestrator — scenario × persona × step matrix, retries, fallbacks. Heavy Playwright + Stagehand + history mocking. Plan B.4. |
| `core/computer-use.ts` | 449 | Claude Computer-Use beta loop — heavy SDK + screenshot mocking. Plan B.3. |
| `core/reporter.ts` | 528 | HTML/PDF report generation — large SPA template renderer. |
| `core/recorder.ts` | 300 | Chrome-extension-driven scenario recording. |
| `agent/agent-loop.ts` | 776 | Full autonomous-mode loop (planner + navigator + convergence). Highest LoC in the project. |
| `agent/dom-summary.ts` | 152 | DOM extraction inside `page.evaluate(callback)`; same browser-only constraint as `page-stability.ts`. |
| `core/primitives/{act,extract}.ts` | 718/842 | Currently 76.8% / 77.3% — push to ≥ 80% by covering the leftover Stagehand cold-start + budget-exceeded edges. |

## Alternatives rejected

1. **One big `npm test:coverage` PR aiming for 80% across the board.** — Multi-day work; would either land partial-and-broken or blow the conversation budget. Phase 1 ships a real gate now and lets Phase 2 ratchet against it.
2. **istanbul provider instead of v8.** — istanbul instruments at parse-time (slower test runs, requires a Babel-style transform). v8 uses native Node coverage hooks, runs essentially free, and matches the coverage shape Vitest's TypeScript path naturally produces. v8's lack of statement-level fidelity in some edge cases is acceptable since we report `lines` and `statements` together.
3. **Per-file thresholds.** — Tempting (e.g. force `core/scenario.ts ≥ 95%`) but creates a brittle config: every refactor that adds a few lines without their corresponding test trips the gate. Global thresholds + manual review of the per-file coverage table at PR time strikes the right balance for a single-maintainer project. Per-file thresholds are an option for Phase 3 once everything is stable.
4. **Counting `cli.ts` / `mcp/server.ts` toward coverage.** — Their logic *is* tested (CLI subcommand tests + MCP `tools/list` handshake + per-tool dispatch tests), but the entry-point glue is naturally missed by `vitest` because it doesn't import the whole CLI. Counting it would make the threshold misleading.
5. **`page-stability.ts` `evaluate(cb)` bodies via jsdom.** — Possible but requires extracting each callback into an exported function and running tests under `// @vitest-environment jsdom`. That's a real refactor with a non-trivial testing infra surface (MutationObserver polyfill / `__NEXT_DATA__` / Astro / Nuxt window stubs). Phase 2 will reconsider if the extracted callbacks make sense — for now the Node-side branches are 100% and the page-side runs in real Playwright integration tests.
6. **Run real Stagehand + real Chromium for `stagehand-wrapper` tests.** — Adds 5+ s cold-start to every CI run, requires `ANTHROPIC_API_KEY`, and tests still fail to pin behavior because real Stagehand has its own internal state. `vi.mock` + `vi.hoisted` capture object gives us deterministic verification of every config field and call sequence.
7. **Threshold gate via a custom script that diffs `coverage/json-summary` against a tracked baseline file.** — Vitest already supports `thresholds` natively. Reinventing it as a gh-actions script trades a one-line config for ~50 lines of bash, with no upside.
8. **Putting `coverage/` outside `.gitignore`.** — The HTML report is large and regenerated every test run; tracking it would just bloat the diff. Local viewing via `open coverage/index.html` is enough; CI can publish it as an artifact when needed.

## Consequences

- A regression-protecting coverage gate exists and runs alongside the existing `lint:no-console` + `vitest run` checks.
- The 12 modules listed in §B are properly tested and won't silently rot.
- The remaining big modules have a clear path: each is its own commit cluster with its own ADR section in subsequent M1-2 phases.
- Threshold ratchet — every M1-2 phase commit MUST raise the threshold by at least the floor of the gain it just produced (e.g. statements 50 → 57 after Phase 1). This makes the gate *actually* protect the gain rather than auto-deflating to whatever this week's test set produces.

## Files added

- `vitest.config.ts` (modified) — coverage block.
- `package.json` (modified) — `test:coverage` + `test:coverage:check` scripts.
- `.gitignore` (modified) — `coverage/`.
- `tests/scenario.test.ts`
- `tests/config.test.ts`
- `tests/throttle.test.ts`
- `tests/url-preflight.test.ts`
- `tests/image.test.ts`
- `tests/persona.test.ts`
- `tests/secrets.test.ts`
- `tests/page-stability.test.ts`
- `tests/visual-diff.test.ts` (complements existing `visual-diff-baseline.test.ts`)
- `tests/notify.test.ts`
- `tests/email.test.ts`
- `tests/stagehand-wrapper.test.ts`

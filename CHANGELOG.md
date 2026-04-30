# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — v1 worktree (worktree-v1-ai-first)

> Phase 1 (AI core) work-in-progress for the Big Bang v1 release. Not yet shipped.

### Added (M1-2 Phase 2 close — `core/reporter-spa.ts` HTML-escape coverage)

- `tests/reporter-spa.test.ts` extended from 5 → 13 tests. Coverage: `core/reporter-spa.ts` 60 → **93.33% statements / 100% branches / 100% functions / 93.33% lines**. The remaining ~7% is the unreachable `default:` return inside `escapeHtml`'s switch (the calling regex `[&<>"]` only passes those four chars, so the default branch is dead defensive code).
- Test surface added:
  - `escapeHtml` exercised through `audit.project_name` and `audit.run_id` (the only two `escapeHtml` call sites — every other text interpolation goes through the JSON `<` / `>` escape): `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`, plus a mixed-special-chars case and a plain-ASCII no-op case.
  - `redact_patterns` fast-path: empty array bypasses `redactDeep` (verified by checking that an unredacted secret string survives in the output) and undefined `redact_patterns` likewise bypasses.
- This commit closes M1-2 Phase 2's LLM-heavy quartet: `critic` (100%) + `llm` (87%) + `instruction-mutator` (86%) + `reporter-spa` (93%). Threshold stays at 59/53/59/59 — the sub-1pt gain (60.65 → 60.75) doesn't warrant a ratchet under ADR-017's contract.
- 980/980 tests pass (973 → 980, +7).

### Added (M1-2 Phase 2 — `core/instruction-mutator.ts` extended unit tests)

- `tests/instruction-mutator-extended.test.ts` — 37 tests complementing the existing `tests/instruction-mutator.test.ts` (which covered only `mutateSpecific` + `mutateDecompose` happy paths). The original tests stay; this file adds the orchestration / LLM / autoDiscovery / verb-swap surfaces that were previously untested.
- Coverage: `core/instruction-mutator.ts` 41.58 → **86.13% statements / 65.33% branches / 92.85% functions / 85.71% lines**. The remaining 14% is the inner `getInteractiveElements` `page.evaluate(callback)` body (browser-only — same constraint as `page-stability.ts`, deferred per ADR-017).
- Test surface added:
  - `generateMutations` orchestration (without cost): merges specific + decompose + rephrase variants in priority order; emits decompose only when input matches a "then"/"and" pattern; never duplicates rephrase when an upstream mutation already returned one; stamps `schema_version` on every result; calls `page.evaluate` exactly once for DOM context; falls back to `(unable to read DOM)` literal when `page.evaluate` throws.
  - `generateMutations` LLM path (with cost): includes LLM-rewrite as the first result when the model returns a non-empty different instruction; ignores no-op rewrites (identical to original); ignores empty-after-trim output; silently swallows LLM errors / cost-guard `checkBudget` throws and falls through to local mutations; never calls `recordUsage` on failure; never invokes the LLM when the cost accumulator is omitted; forwards original instruction + DOM context truncated to 1500 chars to Haiku 4.5 with `max_tokens=256` and the documented system prompt.
  - `autoDiscoverSelectors`: maps Stagehand observe results to selectors; filters empty/missing selectors; slices to at most 5; returns `[]` on `observe()` throw or empty result.
  - `rephrase` verb-swap matrix exercised through `mutateDecompose`'s no-pattern fallback: 15 verb-pair rewrites (click↔press, tap→click, select↔choose, navigate↔go, open, find, enter↔type, scroll-down-to, look-for) + 3 hint-appending fallbacks (button visible-area, link clickable-text, generic try-different-approach).

Coverage threshold ratcheted per ADR-017 contract: statements 58→59, branches 52→53, functions 58→59, lines 58→59. Current baseline 60.65/53.89/63.24/61.39 leaves 1-2 points headroom. 973/973 tests pass (936 → 973, +37).

### Added (M1-2 Phase 2 — `core/llm.ts` unit tests)

- `tests/llm.test.ts` — 38 tests for the Anthropic SDK wrapper. Mocks `@anthropic-ai/sdk` (FakeAnthropic class with `messages.create` capture) and `./cost-guard.js` (controllable `checkBudget` + `recordUsage`). Uses `vi.resetModules` + dynamic `await import("../src/core/llm.js")` per test so the module-level singleton `client` cache is fresh on every run — previously the singleton was untestable from the public API without an explicit reset seam.
- Coverage: `core/llm.ts` 22.22 → **87.4% statements / 87% branches / 100% functions / 86% lines**. Remaining 13% are deep edge cases inside `repairTruncatedJson` (escape handling in second walk, stack mismatch on close brace, value-char terminators) that the public `extractJson` API doesn't reach without contrived inputs.
- Test surface:
  - `getAnthropicClient`: throws without `ANTHROPIC_API_KEY`; constructs with the env key on demand; memoised (singleton — second call returns the same instance).
  - `estimateCost`: opus 4.6 ($15/$75 per 1M), sonnet 4.6 ($3/$15), haiku 4.5 ($0.80/$4); unknown model falls back to sonnet pricing; zero usage returns 0.
  - `callVision` request shaping: throws on no images; legacy `imageBase64` path defaults `media_type=image/png`; `imageMediaType` override; `images[]` wins over `imageBase64` when both set; `image.label` prepended as a `text` content block; `userPrompt` always last in content; `systemPrompt` + `maxTokens` (default 2048, custom 4096) + model name forwarded.
  - `callVision` response handling: text blocks joined with `\n`, non-`text` blocks (e.g. `tool_use`) ignored; `costUsd` computed via `estimateCost` from response usage; cost-guard `checkBudget` invoked pre-call and `recordUsage` post-call (in order); `checkBudget` throw aborts before the SDK call; SDK throw propagates without calling `recordUsage`.
  - `extractJson` paths: fenced ```json``` parse, fenced no-language parse, bare object, prose-surrounded balanced object, nested braces inside string values, escaped quotes, truncated array repair, nested truncation repair, trailing-comma strip, no-JSON throw, empty input throw, missing-closing-fence fallback to balanced extraction; truncated-string drops everything past the unterminated open-quote (documented contract); error message snippet truncated at 200 chars; generic typing.

### Added (M1-2 Phase 2 — `core/critic.ts` unit tests)

- `tests/critic.test.ts` — 24 tests for the Vision Critic. Mocks `./llm.js` so `callVision` is deterministic; keeps `extractJson` real (it's pure) and `compressForVision` real (already covered by `image.test.ts`) so the integration of compress → vision → JSON parse → schema-validate → score/issue mapping is exercised end-to-end. `vi.hoisted` shared capture object lets every test assert on the prompt that was sent to the model.
- Coverage: `core/critic.ts` 3.33 → **100% statements / 92.85% branches / 100% functions / 100% lines**. Only line uncovered is the `String(err)` defensive branch when `err instanceof Error` is false (extractJson always throws Error in practice).
- Test surface: single-image happy path / multi-image label convention (full-page thumbnail + viewport-segment N of M ordering preservation) / verdict.violations mapped to high-severity localization issues (with + without `location`) / malformed JSON returns low-severity issue (cost still recorded, schema_version still stamped) / schema-validation failure path / verdict defaults (missing scores/issues → empty arrays) / issue.dimension optionality / verdict.passed pass-through / system prompt embeds persona mental_model + country + locale + device + tier + critical_concerns (incl. `(none specified)` empty case) + scenario.goal + anti-hallucination / data-exposure rules + brand-name carve-out reflects `persona.language` / user prompt joins `scoring_dimensions` with `, ` + ends `Return JSON only.` / callVision error propagation (no swallow) / model-name forwarding / raw VisionResponse preserved in `result.raw`.
- Coverage threshold ratcheted up per ADR-017's contract: statements 50 → 55, branches 45 → 50, functions 50 → 55, lines 50 → 55. Current baseline 58.1 / 51.67 / 61.39 / 58.83 leaves 2-3 points of headroom for natural fluctuation. 898/898 tests pass (874 → 898, +24).

### Added (M1-2 Phase 1 — coverage tooling + small/utility module unit tests)

- `@vitest/coverage-v8` ^4.1.5 dev dep. `vitest.config.ts` enables coverage with provider `v8`, three reporters (`text-summary` / `html` / `json-summary`), `./coverage` output dir. Includes `src/**/*.ts` minus entry-points (`cli.ts` / `index.ts` / `mcp/server.ts`) and pure-type contracts (`core/types.ts` / `core/result-schema.ts`) — counting them dilutes the signal.
- Two new npm scripts: `test:coverage` (writes report) and `test:coverage:check` (enforces global thresholds; fails CI on regression).
- Threshold gate set at conservative entry baseline (statements 50 / branches 45 / functions 50 / lines 50). Each subsequent M1-2 phase commit ratchets the floor up. `coverage/` added to `.gitignore`.
- 12 new module-level test files added: `tests/scenario.test.ts`, `tests/config.test.ts`, `tests/throttle.test.ts`, `tests/url-preflight.test.ts`, `tests/image.test.ts`, `tests/persona.test.ts`, `tests/secrets.test.ts`, `tests/page-stability.test.ts`, `tests/visual-diff.test.ts`, `tests/notify.test.ts`, `tests/email.test.ts`, `tests/stagehand-wrapper.test.ts`. 188 new tests total.
- Per-module coverage uplift: `scenario` 0 → 100%, `config` 0 → 100%, `throttle` 0 → 95%, `url-preflight` 0 → 100%, `image` 44 → 88%, `persona` 45 → 100%, `secrets` 57 → ~100%, `page-stability` 0 → 40% (Node-side 100%, page-side `evaluate(callback)` bodies are browser-only and run in real Playwright integration tests), `visual-diff` 62 → 79%, `notify` 0 → 100%, `email` 0 → 100%, `stagehand-wrapper` 0 → 90% (via `vi.mock` + `vi.hoisted` Stagehand stub). 
- Global coverage 51.5% → 57.5% statements / 45.75% → 51.27% branches. ADR-017 records the M1-2 phase plan and lists which big modules (critic / llm / runner / computer-use / reporter / agent-loop / etc.) stay for Phase 2/3.
- `stagehand-wrapper.test.ts` mocks `@browserbasehq/stagehand` with a hoisted shared-capture object so the wrapper exercises init / addInitScript / cookies / tracing / close / video.path without launching Chromium. stealth-core stays unmocked so `resolveFingerprintForPersona` + `buildStealthLaunchOptions` are genuinely covered. Includes "Stagehand not installed" error path + addInitScript-throw resilience path.

### Added (M9-5 MCP self-describe / `list_capabilities`)

- New MCP tool `list_capabilities` (`kind: "meta"`) — twelfth shipped tool. Pure introspection: no LLM, no browser, no probe of secret presence. AI agents call it once on first connect to plan the rest of the session: every tool with kind, input schema, result schema title, **cacheability**, **static cost-estimate band**, **side-effects**, and **dependency declarations**; plus the public env-var table and live state of the M9-4 result cache.
- `ToolDefinition` (`src/mcp/registry.ts`) gained four new required fields: `cacheable: boolean`, `costEstimateUsd: { typical, min, max, unit, notes? }`, `sideEffects: ToolSideEffect[]`, `requires: { apiKeys, browser, personasDir?, scenariosDir? }`. Populated on every shipped tool. `cacheable` mirrors the M9-4 design matrix exactly (see / extract / judge cache; act state-changing; compare transparently via judge sub-calls; audit_url / explore_url heavyweight; meta tools none). `requires.apiKeys` declares static dependency on env-var names — never probes whether each is set, since that would leak secret-presence to every caller.
- New schemas in `src/core/result-schema.ts`: `ListCapabilitiesResultSchema` (top-level envelope: `server / result_schema_version / tools[] / env[] / cache`), `ToolCapabilitySchema` (per-tool descriptor), `EnvVarDocSchema` (one env var entry: name, description, scope ∈ {auth, cache, cost_guard, artifacts, logging, memory, reports}, default, required), `CostEstimateSchema` (`{typical, min, max, unit, notes?}` with `unit ∈ {per_call, per_step, per_persona_scenario}`), `CacheInfoSchema` (`{enabled, ttl_ms_default, path}`). Plus supporting building blocks: `ToolSideEffectSchema` enum (navigation / state_changing / fs_writes_artifacts / fs_writes_history / fs_reads / network_egress), `ToolRequirementsSchema`, `ServerInfoSchema`.
- `RESULT_SCHEMA_VERSION` 1.1.0 → 1.2.0 (additive minor per ADR-007 SemVer policy). No existing envelope changed shape. Schema count 25 → 30 published JSON schemas at v1.2.0 (added `list-capabilities-result`, `tool-capability`, `env-var-doc`, `cost-estimate`, `cache-info`).
- 21-row env table in `src/mcp/tools/list-capabilities.ts` covers every `AUDIT_*` / `LOG_*` / `ANTHROPIC_API_KEY` env var the codebase reads. Adding a new env var to a primitive must include adding a row here — the envelope-completeness test (`tests/list-capabilities.test.ts > env table includes every audit-prefix env var`) forces the set to stay in sync.
- Privacy: planted-secret test asserts a fake `ANTHROPIC_API_KEY` value is absent from `list_capabilities` output while the *name* `ANTHROPIC_API_KEY` is present. The result-cache file path *is* exposed (paths are not secrets) so AI agents can write diagnostic / cleanup scripts.
- 7 catalog invariants added in `tests/mcp-registry.test.ts` lock in metadata consistency: cost band well-formed (`min ≤ typical ≤ max ≥ 0`, unit ∈ enum); `sideEffects` from closed enum; `requires` record shape; `network_egress ⇔ apiKeys non-empty`; `browser ⇒ navigation`; M9-4 cacheable matrix preserved exactly.
- 81 new tests across 3 files: 45 schema cases in `tests/result-schema.test.ts` (new schemas' happy / unknown-enum / negative / missing-required-field rejections, lower-bound empty-tools / empty-env envelope shape); 7 metadata invariants in `tests/mcp-registry.test.ts`; 29 cases in new `tests/list-capabilities.test.ts` (registry projection snake_case mapping, optional `result_schema` / `personas_dir` / `scenarios_dir`, registry dispatch smoke, envelope completeness, secret-leak smoke, server identity, every scope-enum reachable, live cache reflection: `AUDIT_RESULT_CACHE_DISABLED` flips `cache.enabled`, `AUDIT_RESULT_CACHE_TTL_MS` surfaces, invalid-TTL fallback, path string non-empty).
- New ADR-016 documenting the design (static vs live fields, naming convention, privacy stance) and 8 alternatives rejected: rich fields directly on `tools/list` (strict-MCP clients reject unknown fields), runtime secret-presence probe (information leak), process-level live stats (out of scope), prose env docs only (not machine-readable), self-cache via M9-4 (circular), HTTP content negotiation (scope creep), AST-grep env discovery (filtering test fixtures), in-memory cache across calls (unmeasurable benefit).
- 628 → 686 tests pass (+58 net new). Typecheck clean. Build clean. MCP `tools/list` over stdio confirms 12 tools. `tools/call list_capabilities` returns the full `ListCapabilitiesResult` envelope with 12 tool rows + 21 env rows + live cache state.

### Added (M9-4 Result cache)

- New `src/core/result-cache.ts` — local persistent cache for primitive results. SQLite at `~/.ai-browser-auditor/result-cache.db` (override `AUDIT_RESULT_CACHE_PATH`). One indexed table `result_cache(key PK, primitive, value_json, schema_version, created_at)`. WAL transition file-locked per the M9-3 follow-up pattern; `busy_timeout = 5000`. Atomic upsert via `INSERT … ON CONFLICT(key) DO UPDATE` so concurrent writers on the same key converge cleanly.
- Cache key: `sha256(canonical-JSON({ primitive, inputs }))`. `canonicalJsonStringify` recursively sorts object keys before stringify (arrays preserve order — `steps`, `rubrics` are order-sensitive). Per-primitive `cacheKeyInputs(opts)` declares which option fields go into the key; performance-only fields (`timeout`, `headless`, `artifactsRoot`) are excluded so the same logical call hits cache regardless of how it was scheduled.
- TTL default 24h, override `AUDIT_RESULT_CACHE_TTL_MS` or per-call `cacheTtlMs`. Entries written under a different `RESULT_SCHEMA_VERSION` are misses and pruned on read. Opportunistic prune at most once per opened DB per hour.
- Bypass: `AUDIT_RESULT_CACHE_DISABLED=1` (global), per-call `cache: false` (skip read+write), per-call `cacheBust: true` (skip read, persist new result so subsequent identical calls hit cache).
- `withResultCache<T>({ primitive, cacheKeyInputs, compute })` wraps a primitive's expensive computation. On hit it returns the cached value with `cost_usd` zeroed and `cache.cost_saved_usd` populated; on miss it calls `compute(key)`, persists, and returns with `cache.hit=false`.
- Cacheable surface (v1): `judge` (always), `extract` (always), `see` (only when `goal` is set — without a goal `see` makes no LLM call and a cached snapshot could mislead callers with stale state). Not cached: `act` (state-changing imperatives), `compare` directly (its two per-side `judge` calls hit cache transparently when called repeatedly with the same A/B URLs; the synthesis call is small), `audit_url` / `explore_url` (heavyweight, deferred to a future task).
- `RESULT_SCHEMA_VERSION` 1.0.0 → 1.1.0 (additive minor per ADR-007 SemVer policy). New `ResultCacheMetaSchema { hit, age_ms, key (sha256 hex), cost_saved_usd? }` exported. Each primitive envelope (`SeeResultSchema` / `ActResultSchema` / `ExtractResultSchema` / `JudgeResultSchema` / `CompareResultSchema`) gained an optional `cache: ResultCacheMetaSchema.optional()` field. Schema count 24 → 25 published JSON schemas at v1.1.0.
- Per-primitive options: `cache: boolean`, `cacheBust: boolean`, `cacheTtlMs: number` on `SeeOptions` / `ExtractOptions` / `JudgeOptions`. MCP tools `see` / `extract` / `judge` surface them as `cache` / `cache_bust` / `cache_ttl_ms`.
- New `tests/result-cache.test.ts` (31 cases): canonical JSON sorting / cache key stability / hit-after-write / TTL expire (default + env-override) / cacheBust recompute + persist / `cache: false` bypass / env disable bypass / different inputs and primitives produce different keys / custom `costExtractor` + `applyCacheMeta` hooks / schema-version invalidation / malformed JSON resilience / prune by age / prune by version mismatch.
- New `tests/primitives/cache-integration.test.ts` (9 cases): end-to-end through `see` / `extract` / `judge` with stubbed open + vision: caches when applicable, doesn't cache when not (no goal on see), `cache: false` bypasses, `cacheBust` forces recompute, different goals / schemas / rubrics produce different keys.
- New `tests/setup.ts` + `vitest.config.ts > setupFiles`: vitest globally sets `AUDIT_RESULT_CACHE_DISABLED=1` so primitive unit tests don't accidentally hit the user's real cache. Cache integration tests opt-in by clearing the env var locally + using temp SQLite paths.
- 11 new schema tests in `tests/result-schema.test.ts`: `ResultCacheMetaSchema` accepts hit/miss / rejects bad keys + negative age_ms / negative cost_saved_usd; each of 5 primitive envelopes accepts `cache` on hit / miss / absent.
- New ADR-015 documenting the design, alternatives rejected (in-memory only / cache `audit_url` / cache `act` / sidecar `cache_meta` envelope / leave `cost_usd` un-zeroed on hit / hash screenshot path string only / per-primitive tables / honour HTTP `Cache-Control`), and reversal cost.
- 619 → 628 tests pass (+11 schema, +9 cache-integration; result-cache's own 31 land alongside; existing history test updated to track `RESULT_SCHEMA_VERSION` rather than the literal "1.0.0"). Typecheck clean. Build clean. MCP `tools/list` over stdio still returns 11 tools; `see` / `extract` / `judge` inputSchemas now include `cache` / `cache_bust` / `cache_ttl_ms`.

### Added (N-3 + N-8 `compare` + `judge` primitives)

- New `src/core/primitives/judge.ts` — fourth AI primitive in the v1 catalog. `judge(opts: JudgeOptions): Promise<JudgeResult>` runs ONE rubric-driven vision call against a single page (URL or pre-captured snapshot) and returns per-criterion verdicts (0..10 score + rationale + evidence) plus severity-graded findings with on-screen locations. Decoupled from `runCritic` (`src/core/critic.ts`) — runCritic is persona × scenario × dimension scoring tightly bound to scenario YAML; judge is rubric × URL with no scenario/persona file required.
- New `src/core/primitives/compare.ts` — fifth AI primitive. `compare(opts: CompareOptions): Promise<CompareResult>` runs an A/B comparison of two pages against the same rubric. Default mode `double_blind`: judges side A and side B independently in parallel, then runs ONE synthesis vision call seeing both screenshots side-by-side with the prior judgements as context — 3 vision calls total (wall-clock ≈ 2 calls). `fast` mode collapses to 1 vision call seeing both sides — ~3× cheaper but vulnerable to anchoring bias.
- Why double-blind by default: anchoring bias is a documented hazard in single-shot LLM comparisons (Bansal et al. 2024). When a model scores AND compares AND synthesises in one prompt, absolute scores get pulled toward the difference between the two pages. Commercial UX-review practice (Nielsen Norman, Baymard Institute) evaluates each candidate independently before comparison synthesis. The cost delta (~$0.04 per compare) is dwarfed by the judgement-quality gain. `mode: "fast"` opts out for batch use.
- New rubric modules `src/core/critics/aesthetic.ts` (8 criteria — visual_hierarchy, typography, alignment_grid, color_contrast, spacing_rhythm, polish, information_density, brand_cohesion; benchmarked against Stripe / Linear / Vercel / Notion) and `src/core/critics/dark-pattern.ts` (12 criteria — forced_continuity, hidden_costs, preselected_options, fake_urgency, confirmshaming, obstruction, misdirection, trick_questions, disguised_ads, bait_and_switch, privacy_zuckering, nagging; from Brignull's taxonomy + Norwegian Consumer Council 2018). Score direction is uniform (higher = better, even for dark-pattern criteria where 10 = no DP detected) so `overall_score` (mean) stays monotonic across mixed rubrics.
- Caller-supplied `customCriteria` for one-off rubrics (e.g. `{id: "pricing_clarity", label: "Pricing clarity", description: "Is total cost visible without scrolling?"}`). Setting any custom criterion auto-tags `rubrics` with `"custom"`. Criterion ids dedupe across rubric sources.
- New `src/mcp/tools/judge.ts` and `src/mcp/tools/compare.ts` — both `kind: "primitive"`. `judge` accepts `url` OR pre-captured `capture: { url_final, title, screenshot_path, ... }`; `compare` accepts per-side `{ url | capture, persona, viewport_width, viewport_height }`. Per-side viewport enables desktop-vs-mobile A/B testing on a single tool call.
- `ALL_TOOLS` in `src/mcp/server.ts` grows 9 → 11. Catalog order is now `audit_url` (preset) → `explore_url` (preset) → `see` (primitive) → `act` (primitive) → `extract` (primitive) → **`judge` (primitive)** → **`compare` (primitive)** → `list_personas` / `list_scenarios` / `calibrate_critic` / `get_last_report` (meta). The mcp-registry catalog test was updated to assert the new 11-tool order.
- New schemas: `JudgeResultSchema` (envelope with `rubrics`, `criteria`, `verdicts[]`, `findings[]`, `overall_score`, `summary` plus the standard see/act/extract envelope) and `CompareResultSchema` (mode + side_a / side_b carrying embedded JudgeResult + per_criterion winners + overall_winner + summary). Plus reusable building blocks: `JudgeRubricKindSchema`, `JudgeCriterionSpecSchema`, `JudgeVerdictSchema`, `JudgeFindingSchema`, `CompareModeSchema`, `CompareWinnerSchema`, `CompareCriterionVerdictSchema`, `CompareSideSchema`. JSON Schemas published as `docs/schemas/judge-result.schema.json` and `docs/schemas/compare-result.schema.json`. Schema count 22 → 24 at `RESULT_SCHEMA_VERSION` 1.0.0.
- Defensive parsing: `parseJudgeRawJson` drops verdicts referencing unknown criterion_ids, clamps scores into [0..10], coerces unknown criterion_id on findings to null (cross-cutting), drops findings with unknown severity, treats malformed input as empty-verdicts (with a diagnostic `severity: "low"` finding); `parseCompareRawJson` does the same plus falls back to `majorityWinner` when `overall_winner` is missing/invalid. Both protect the wire from producer drift without crashing the call.
- Per-call artefacts: `judge` writes `<root>/<iso>-<rand6>/judge.json` sidecar; `compare` writes `<root>/<iso>-<rand6>/{a,b}/` subdirs + `compare.json` sidecar. Env overrides: `AUDIT_JUDGES_DIR`, `AUDIT_COMPARES_DIR`.
- Cost-guard wiring: every vision call goes through `callVision` (M5-6 + M9-3 ledger + AsyncLocalStorage scope). The MCP dispatcher already wraps each tool call in `withCostRun`, so two parallel `judge` or `compare` invocations on this server process see independent per-run counters but share the persistent daily ledger.
- New tests:
  - `tests/result-schema.test.ts` — 20 new cases for the Judge / Compare schemas (minimal envelope, fully populated, rubric-kind reject, score-range reject, criterion id+label non-empty, severity reject, mode/winner reject, null per-side scores accept, embedded judge accept, negative-cost reject, unknown-status reject, schema_version optional, etc.).
  - `tests/primitives/judge.test.ts` — 33 cases covering rubric assembly (default aesthetic, dual rubric, dedupe, custom + built-in compose, cross-rubric id dedupe, standalone "custom" with no criteria errors, empty errors, id format invariant), prompt construction (system + user prompts embed every criterion id, mode-switched language, severity values), `parseJudgeRawJson` (score clamping, unknown criterion_id drop, unknown severity drop, criterion_id-on-finding null coercion, malformed-input empty, summary preservation), `computeOverallScore` (empty → null, mean rounded 2dp), primitive seam (`_see` + `_callVision`) — schema field plumbing, capture re-use, rubrics arg, custom criteria, cost propagation, upstream see error → status=error, missing url+capture throws, artefacts dir uniqueness, sidecar JSON, env override, model propagation, malformed JSON → diagnostic finding, overall_score is mean. Plus a real-Chromium integration test against the existing fixture site with stub vision (no LLM credits ever burnt).
  - `tests/primitives/compare.test.ts` — 24 cases covering prompt construction (every criterion id, SIDE A/B labels, mode-specific instructions, prior judgements rendered when judges passed), `parseCompareRawJson` (per-side score clamping, null score passthrough, unknown criterion_id drop, invalid winner drop, fallback to majority winner, malformed → empty + tie), `majorityWinner` (empty → tie, a==b → tie, strict majority wins), `double_blind` mode (2 parallel judges + 1 synthesis call, costs summed, default mode is double_blind, side-A judge failure → status=error with both judge costs retained, capture reuse, rubrics + customCriteria flow through, missing url+capture per side throws, artefacts isolation with a/ b/ subdirs, compare.json sidecar, AUDIT_COMPARES_DIR env override), `fast` mode (NO synthesis-context judge, capture proxy via judge with no-op vision, embedded judge null in result, cost = synthesis only). Plus a real-Chromium integration test (fast mode, A=B fixture URL, returns tie).
- New ADR-014 documenting double-blind-by-default rationale (anchoring bias literature + commercial UX-review practice), why two distinct tools instead of one combined `judge_and_compare` (loss of caching, cost transparency, failure isolation, replay locality), why rubric-as-data instead of hard-coded prompt (extensibility + custom criteria parity), why decouple from `runCritic` (no scenario YAML coupling), uniform score direction (monotonic aggregate), and 8 rejected alternatives in full.
- 500 → 557 tests pass (+20 schema, +33 judge, +24 compare). Typecheck clean. Build clean. MCP `tools/list` over stdio confirms 11 tools and the full `judge` + `compare` inputSchemas.

### Added (N-4 `extract` primitive)

- New `src/core/primitives/extract.ts` — third AI primitive in the v1 catalog. `extract(opts: ExtractOptions): Promise<ExtractResult>` runs Stagehand's `page.extract()` against a URL bound to a caller-supplied JSON Schema and returns matching `data` plus the same envelope as see / act (DOM summary, console errors, screenshot, persona, artifacts, cost, duration). Single-engine: Stagehand only. There is no deterministic alternative for "give me an arbitrarily-shaped object matching this schema."
- JSON Schema → Zod converter (subset whitelist): `type` ∈ {object, array, string, number, integer, boolean, null}, `type: ["T", "null"]` shorthand, `properties`, `required`, `items`, `enum` (string-only → `z.enum`, mixed → `z.union` of `z.literal`), `description` (forwarded to `.describe()`), `nullable`, plus `additionalProperties` + metadata keywords accepted-but-ignored. Rejected (precise path-locator error message): `oneOf`, `anyOf`, `allOf`, `not`, `$ref`, `patternProperties`, `dependencies`, `if/then/else`, `const`. The root must be `type: "object"` (Stagehand's `extract()` requires `T extends z.AnyZodObject`); a bare `{ properties: {…} }` is accepted as object-shorthand.
- Auto-instruction synthesis: when caller supplies a schema but no `instruction`, the primitive synthesises one from the schema's top-level field names and `description` annotations (e.g. `"Extract the following fields from the page: name, price (Monthly price in USD), features."`). Stagehand's extract performs noticeably better with a one-line hint.
- Cost-guard wiring: snapshots Stagehand's running `metrics.extractPromptTokens` / `extractCompletionTokens` before and after the call, computes USD via `estimateCost(model, deltaIn, deltaOut)`, and feeds `getCostGuard().recordUsage()` so the persistent daily ledger stays accurate. If `recordUsage` throws `BudgetExceededError`, the data is still returned but `status` flips to `"error"` with the budget message — partial-success semantics. (Closes the cost-tracking gap that `act`'s `act` step left open.)
- New `src/mcp/tools/extract.ts` — MCP wrapper, `kind: "primitive"`. Accepts snake-case args (`url`, `schema`, `instruction`, `selector`, `persona`, `viewport_width` / `viewport_height`, `full_page`, `include_dom`, `include_console`, `timeout_ms`, `wait_for`, `headless`, `model`). Persona resolution mirrors see / act (best-effort, fall back to defaults). Output stamped via `stampedTextResult("ExtractResult", ExtractResultSchema, …)`.
- `ALL_TOOLS` in `src/mcp/server.ts` grows 8 → 9. Catalog order is now `audit_url` (preset) → `explore_url` (preset) → `see` (primitive) → `act` (primitive) → **`extract` (primitive)** → `list_personas` / `list_scenarios` / `calibrate_critic` / `get_last_report` (meta). The mcp-registry catalog test was updated to assert the new 9-tool order.
- New schema: `ExtractResultSchema` in `src/core/result-schema.ts` mirrors the see / act envelope with three extract-specific fields — `data` (caller-defined; `z.unknown()`), `schema_used` (echoed JSON Schema for client-side re-validation; `z.unknown()` to avoid coupling our SemVer to JSON Schema's evolution), `instruction_used` / `selector_used` (debug aid). JSON Schema published as `docs/schemas/extract-result.schema.json`. Schema count 21 → 22 at `RESULT_SCHEMA_VERSION` 1.0.0.
- New tests:
  - `tests/result-schema.test.ts` — 7 new cases for `ExtractResultSchema` (minimal envelope, fully populated with realistic pricing-plan extraction, arbitrary `data` shape acceptance, engine rejection, status-enum rejection, negative-cost rejection, optional schema_version).
  - `tests/primitives/extract.test.ts` — 42 cases. (1) JSON Schema → Zod converter: 17 cases covering primitives / nested objects / arrays of objects / integer narrowing / string-only enum (z.enum) vs mixed enum (z.union of literals) / nullable shorthand (both `nullable: true` and `["T", "null"]`) / description preservation / `{ properties }` shorthand / ignored-keyword acceptance / all rejection paths (root non-object, oneOf/anyOf/allOf/not/$ref/const, missing items, empty enum, unknown type, with a useful path locator in the error message). (2) Primitive with `_openStagehand` / `_callExtract` test seams: schema field plumbing, persona viewport wiring, dom/console toggles, schema_used / instruction_used / selector_used echo, auto-instruction synthesis from field names, custom instruction verbatim forwarding, sub-region selector forwarding, schema-omitted fallback path (Stagehand default `{ extraction }`), `_callExtract` seam priority over opened.extract, three error paths (malformed schema fails fast before Stagehand cold-start / LLM throws / open() throws), three cost paths (tokens consumed → USD via estimateCost / no metrics movement → 0 cost / BudgetExceededError → error+data+cost all surfaced), three artefacts paths (per-call uniqueness / `AUDIT_EXTRACTS_DIR` env override / data.json artefact written for replay). (3) Real-Chromium integration test against `tests/fixtures/test-site/index.html` — exercises navigation / DOM extraction / screenshot / data.json persistence end-to-end with the LLM round-trip stubbed via the Stagehand-shaped open seam (no LLM credits ever burnt).
- New ADR-013 documenting the JSON Schema subset rationale (whitelist over permissive `json-schema-to-zod`; no Zod over the wire), why single-engine Stagehand (no deterministic alternative for shape-bound extraction), why auto-synthesised instruction beats schema-only (Stagehand performs better with a hint), why cost flows through Stagehand metrics → recordUsage (closes act's gap), partial-success budget-cap semantics, and the rejected alternatives (Zod direct; npm `json-schema-to-zod`; dual-engine; rely on free-form fallback; split into `extract_json` / `extract_text`; double-validation post-Stagehand; inline base64; enforce `pattern` / `minLength` etc.).
- Artifacts directory: `$AUDIT_EXTRACTS_DIR` env or `~/.ai-browser-auditor/extracts/<UTC-iso>-<rand6>/` (each call gets its own subdir, parallel-safe). The screenshot is always saved; the raw extracted payload is also persisted as `data.json` for replay / debug.
- 451 → 500 tests pass (+7 schema, +42 extract primitive). Typecheck clean. Build clean. MCP `tools/list` over stdio confirms 9 tools and the full `extract` inputSchema (14 properties; required = `["url"]`).

### Added (N-2 `act` primitive)

- New `src/core/primitives/act.ts` — second AI primitive in the v1 catalog. `act(opts: ActOptions): Promise<ActResult>` runs an ordered sequence of browser actions against a URL and returns a per-step trace plus the final DOM / console / screenshot. Step kinds: deterministic (`goto`, `click`, `fill`, `press`, `wait`, `wait_for`, `scroll`, `screenshot` — 0 LLM cost) and AI (`act { instruction }` via Stagehand, `note { goal }` via one `callVision` call). Engine auto-selects: `pickEngine(steps)` returns `"stagehand"` iff any step is `act`, otherwise `"playwright"` (the same fast cold-start path `see` uses, ~1 s vs Stagehand's ~5 s).
- New `src/mcp/tools/act.ts` — MCP wrapper, `kind: "primitive"`. Per-step input is a discriminated union mapped from snake-case JSON; coercion validates per-kind required fields with precise paths (`steps[2].selector must be a non-empty string`). `engine` argument exposes manual override; `stop_on_error` defaults true (subsequent steps marked `"skipped"`); `false` is opt-in for best-effort sequences.
- `ALL_TOOLS` in `src/mcp/server.ts` grows 7 → 8. Catalog order is now `audit_url` (preset) → `explore_url` (preset) → `see` (primitive) → **`act` (primitive)** → `list_personas` / `list_scenarios` / `calibrate_critic` / `get_last_report` (meta). The mcp-registry catalog test was updated to assert the new 8-tool order.
- New schemas: `ActStepSchema` (discriminated union covering all 10 step kinds), `ActStepResultSchema` (per-step record with `index` / `type` / `status` / `duration_ms` / optional `screenshot` / `note` / `output` / `error` / `cost_usd`), `ActResultSchema` (envelope with `engine`, `steps[]`, plus the same `dom` / `console` / `screenshot` / `cost_usd` / `persona_id` / `artifacts_dir` shape as `SeeResult`). JSON Schema published as `docs/schemas/act-result.schema.json`. Schema count 20 → 21 at `RESULT_SCHEMA_VERSION` 1.0.0.
- New tests:
  - `tests/result-schema.test.ts` — 12 new cases. `ActStepSchema` accepts every documented step kind, rejects unknown types and missing required fields. `ActStepResultSchema` accepts minimal/full step records and rejects negative cost. `ActResultSchema` round-trips minimal + fully-populated mixed-kind result, rejects unknown `engine` values, schema_version is optional for legacy fixtures.
  - `tests/primitives/act.test.ts` — 21 cases. Unit tests via `_open` / `_openStagehand` / `_callVision` test seams cover `pickEngine` selection, schema field plumbing (engine, persona, viewport precedence, dom/console toggles), per-step dispatch (every kind), `note` step (vision stub returns + cost accumulation, vision failure → step error), Stagehand path (action call recorded, error surfaces + skips remaining), error semantics (stop_on_error true/false, open() failure), artefacts uniqueness + `AUDIT_ACTS_DIR` env override. One real-Chromium integration test against `tests/fixtures/test-site/index.html` runs `[fill, screenshot, scroll]` end-to-end and asserts the per-step screenshot exists, final DOM is captured, and engine is `"playwright"`.
- New ADR-012 documenting why `act` ships as a mixed-kind step executor with auto-selected engine, why no inline retry stack (kept simple — `audit_url` owns the four-layer fallback), why split into deterministic + AI kinds (cheap common case, opt-in AI), why `stop_on_error: true` is the default. Rejected alternatives: pass-through to `runAudit`; single-engine Stagehand always; split into `act_deterministic` + `act_ai` tools; best-effort default; inline base64 screenshots; arbitrary Playwright surface.
- Artifacts directory: `$AUDIT_ACTS_DIR` env or `~/.ai-browser-auditor/acts/<UTC-iso>-<rand6>/`. The v1 worktree's `.env.development` should point this at `~/.ai-browser-auditor-v1/acts/` symmetric with the `sees` env (followup — the variable is honoured today via `defaultArtifactsRoot()` even without the env file entry).
- 418 → 451 tests pass (+12 schema, +21 act primitive). Typecheck clean. Build clean. MCP `tools/list` over stdio confirms 8 tools and the full `act` inputSchema (steps array with the 10-kind item shape).

### Added (N-1 `see` primitive)

- New `src/core/primitives/see.ts` — first AI primitive in the v1 catalog. `see(opts: SeeOptions): Promise<SeeResult>` opens a URL once with raw Playwright and returns a structured snapshot: DOM summary (interactive count + headings as `string[]` + element/text excerpts), captured console errors, a screenshot (always written to disk), and an optional natural-language note answering a `goal` question (one vision call). 0 LLM cost when `goal` is omitted; ~$0.005 when set.
- New `src/mcp/tools/see.ts` — MCP wrapper, `kind: "primitive"` (first one in the catalog). Accepts snake-case args (`url`, `goal`, `persona`, `wait_for`, `viewport_width`/`viewport_height`, `full_page`, `include_dom`, `include_console`, `timeout_ms`, `headless`). Persona resolution is best-effort: missing dir / id silently degrades to defaults (1280×800 / `en-US` / `UTC`). Output stamped with `schema_version` via `stampedTextResult(SeeResultSchema)`.
- `ALL_TOOLS` in `src/mcp/server.ts` grows 6 → 7. Catalog order is now `audit_url` (preset) → `explore_url` (preset) → **`see` (primitive)** → `list_personas` (meta) → `list_scenarios` (meta) → `calibrate_critic` (meta) → `get_last_report` (meta).
- New schemas: `SeeResultSchema` + `SeeDomSchema` + `SeeConsoleSchema` + `SeeScreenshotSchema` in `src/core/result-schema.ts`. JSON Schema published as `docs/schemas/see-result.schema.json`. Schema count 19 → 20 at `RESULT_SCHEMA_VERSION` 1.0.0.
- New tests:
  - `tests/result-schema.test.ts` — 5 cases for `SeeResultSchema` (minimal / full / enum reject / negative-cost reject / legacy-no-version).
  - `tests/primitives/see.test.ts` — 13 cases. Unit tests via `_open` test seam cover schema field plumbing, error path, persona/viewport precedence, note synthesis on/off, vision-failure swallowing, artefacts subdir uniqueness, `AUDIT_SEES_DIR` env override. One real-Chromium integration test loads the existing `tests/fixtures/test-site/index.html`, asserts `dom.headings`, `interactive_count`, and screenshot bytes.
  - `tests/mcp-registry.test.ts` — catalog test asserts the 7-tool order; new invariant that all three kinds (preset / primitive / meta) are represented.
- New ADR-011 documenting why `see` bypasses Stagehand and `runAudit`, why vision uses `callVision` instead of `runCritic`, and the rejected alternatives (full audit pipeline; Stagehand fingerprint parity; inline base64 screenshot; split tools).
- Artifacts directory: `$AUDIT_SEES_DIR` env or `~/.ai-browser-auditor/sees/<UTC-iso>-<rand6>/`. v1 worktree's `.env.development` already points the env at `~/.ai-browser-auditor-v1/sees/` for isolation.
- 399 → 418 tests pass (+5 schema, +13 see primitive, +1 registry catalog kinds invariant). Typecheck clean. Build clean. MCP `tools/list` over stdio confirms 7 tools with correct `see` schema.

### Changed (M3-6 + M9-1 MCP server modularization + tool registry)

- `src/mcp/server.ts` shrinks 502 → 148 lines. Tool input schemas, descriptions, and handlers all move to dedicated files under `src/mcp/tools/`. `server.ts` retains only transport lifecycle, secret bootstrap, the `ALL_TOOLS` catalog, ListTools mapping, and the CallTool dispatcher (with `withCostRun` + try/catch from M9-3).
- New `src/mcp/registry.ts` — `ToolDefinition` record (name / description / inputSchema / kind / optional resultSchema / handler) + `ToolRegistry` class (register / get / has / list / size / describe / registerAll).
- New `src/mcp/result.ts` — `ToolResult` interface, `textResult`, `errorResult`, `stampedTextResult` (M9-2 `schema_version` stamping wrapper). Extracted from `server.ts` so per-tool modules can import without dragging in transport.
- New `src/mcp/helpers.ts` — `requireString` (argument coercion), `resolvePersona` (id → persona with US-desktop fallback). Extracted from `server.ts`.
- New `src/mcp/tools/<name>.ts` — one file per tool, each exporting a `ToolDefinition`:
  - `audit-url.ts` (kind: preset)
  - `explore-url.ts` (kind: preset)
  - `list-personas.ts` (kind: meta)
  - `list-scenarios.ts` (kind: meta)
  - `calibrate-critic.ts` (kind: meta)
  - `get-last-report.ts` (kind: meta)
- `tests/mcp-server.test.ts` updated to import helpers from their new modules (`result.js` / `helpers.js`) instead of `server.js`. No dead re-export shims left behind.
- New `tests/mcp-registry.test.ts` (14 tests): `ToolRegistry` class coverage, `ALL_TOOLS` catalog invariants (every tool has non-empty name / description, object-shaped `inputSchema`, valid `kind`, unique names, `resultSchema` matches a published `docs/schemas/index.json` entry), and routing smoke (`buildDefaultRegistry().get(name).handler` returns a stamped ToolResult). Catches drift between a tool's declared result shape and the schemas committed to the repo.
- New ADR-010 documenting the file layout, the three-discriminator `kind` ("preset" / "primitive" / "meta"), why `kind`/`resultSchema` are kept off the `ListTools` payload, and the rejected alternatives (auto-glob discovery; re-export shims; MCP `_meta` field; registry-owned dispatcher).
- New README "MCP Server" section (registration JSON for Claude Code, tool table, link to ADR-010).
- New architecture.md "MCP Server" section (file layout, kind taxonomy, "adding a new tool" recipe).
- `tools/list` payload is unchanged from a client's perspective: still 6 tools, still `{ name, description, inputSchema }` only. `kind` and `resultSchema` are reserved on the registry record for the future M9-5 `list_capabilities` tool.
- 399/399 tests pass (was 385/385 on M9-3 verification; +14 from the new registry test file).

### Fixed (M9-3 follow-up — cross-process SQLite WAL init)

- All three SQLite open paths (`agent/memory.ts`, `agent/plan-cache.ts`, `core/history.ts`) now serialize the one-time WAL transition through `withFileLockSync(<dbPath>.init.lock, …)` and set `busy_timeout = 5000` per connection. Closes a race discovered while validating M3-6+M9-1: SQLite's `journal_mode = WAL` switch takes an EXCLUSIVE lock that explicitly does NOT honor `busy_timeout` (verified by setting it to 30 s and watching concurrent opens still fail in ~10 ms with "database is locked"). Three subprocesses opening the same fresh DB file would race the journal-mode switch, ~25 % of the time one would lose and exit code 1; in production this would silently drop facts / cache writes from one of two parallel audit runs.
- Inside the lock, `journal_mode` is read first and only set when not already `"wal"`. Once any process completes the transition, WAL persists in the file header — subsequent opens just observe and skip in microseconds.
- `tests/memory.test.ts` cross-process race test: 20/20 pass after fix (was 5/20 before).
- No production behaviour change beyond eliminating the SQLITE_BUSY crash path. WAL mode persists in the DB header as before; `busy_timeout` adds patient retry, never changes correctness.

### Added (M9-3 Concurrency safety)

- New `src/core/file-lock.ts` — cross-process advisory lock helper. `withFileLock(lockPath, fn)` and `withFileLockSync(lockPath, fn)` hold a critical section across processes via a write-tmp-then-`linkSync` lockfile. Stale locks self-heal when the holder pid is no longer alive or the timestamp exceeds `staleAfterMs` (default 30 s). No new dependencies.
- `CostGuard.recordUsage` ledger I/O now wraps load-prune-mutate-write in `withFileLockSync(<ledgerPath>.lock, …)`. Two parallel CLI / MCP processes hitting the same ledger file no longer lose updates last-write-wins.
- Per-run cost counters move from `CostGuard.run` (instance field) to an `AsyncLocalStorage<RunSnapshot>`. New `withCostRun(fn)` helper creates a fresh scope per audit / per MCP tool dispatch.
  - `runner.runAudit()` body wraps in `withCostRun` — every audit (CLI, benchmark, MCP-via-runAudit) gets its own scope.
  - `mcp/server.ts` dispatcher wraps every tool call in `withCostRun` — covers `calibrate_critic` and any future LLM-using tools that don't go through the runner.
  - Falls back to the instance's `fallbackRun` field when no scope is active (back-compat for unit tests and direct-class users).
- `AgentMemory.record` switched from SELECT-then-INSERT/UPDATE to one atomic `INSERT … ON CONFLICT(fact_hash) DO UPDATE`. Confidence cap (≤ 0.99) moves to SQLite's `min(0.99, confidence + 0.05)`. Closes a race where two parallel processes recording the same fact would throw `UNIQUE constraint failed`.
- Visual diff baseline bootstrap (`diffAgainstBaseline`) now copies to a per-process `.tmp` and atomically `linkSync`s into place. First writer wins; second swallows `EEXIST`. No more racy clobbering of a freshly-created baseline.
- New ADR-009 documenting the four-hazard inventory and the linkSync / ALS / atomic-upsert mitigations.
- New tests:
  - `tests/file-lock.test.ts` — 11 tests including 2 cross-process races (counter increments under lock from 2 / 3 child processes).
  - `tests/cost-guard-concurrency.test.ts` — 6 tests for ALS scope isolation, nested scopes, fallback behaviour, and a 3-process ledger race.
  - `tests/memory.test.ts` — 14th test: 3 child processes recording the same fact 12 times each → `confirmations = 36`, no exceptions.
  - `tests/visual-diff-baseline.test.ts` — 2 tests including parallel-bootstrap race.

### Added (M5-6 Cost guard)

- New `src/core/cost-guard.ts` — process-wide LLM spend cap with two layers:
  - **Per-run** in-memory token / USD counter, reset at audit-run / MCP-tool entry.
  - **Per-day** UTC-keyed JSON ledger persisted to `~/.ai-browser-auditor/cost-ledger.json` (override via `AUDIT_COST_LEDGER_PATH`); 30-day auto-prune at write time; atomic temp + rename writes; malformed-file recovery treats the ledger as empty.
- `getCostGuard()` singleton; `BudgetExceededError` carries `kind: "run-usd" | "run-tokens" | "daily-usd" | "daily-tokens"`, `current`, and `limit`.
- Every Anthropic API call site now sandwiches `guard.checkBudget()` (pre) and `guard.recordUsage(model, in, out)` (post): `core/llm.ts:callVision`, `core/computer-use.ts` beta loop, `core/instruction-mutator.ts:llmRewrite`, `agent/planner.ts:createPlan` + `microReplan`, `agent/navigator.ts:decideNextStep`. Convergence's `checkVisualCriterion` inherits via `callVision`.
- `runAudit` (CLI path) and the MCP `CallToolRequestSchema` dispatcher both call `getCostGuard().resetRun()` so each invocation starts with a clean per-run counter.
- Ledger schema is stamped with `COST_LEDGER_SCHEMA_VERSION = "1.0.0"`, following the M9-2 SemVer policy.
- New env vars: `AUDIT_COST_MAX_RUN_USD` (default `5`), `AUDIT_COST_MAX_RUN_TOKENS` (default `10_000_000`), `AUDIT_COST_MAX_DAILY_USD` (default `50`), `AUDIT_COST_MAX_DAILY_TOKENS` (default `100_000_000`), `AUDIT_COST_LEDGER_PATH`, `AUDIT_COST_GUARD_DISABLED=1` (bypass for CI / tests).
- New ADR-008 documenting hook-at-call-site, persistent ledger, symmetric pre-check / post-record enforcement.
- New `tests/cost-guard.test.ts` with 18 tests: `recordUsage` math, atomic ledger persistence, cross-instance ledger sharing, day rollover, all four tripwire kinds, error message env hint, `resetRun` semantics, snapshot reporting, disabled mode (constructor flag + env var), 30-day pruning, malformed-file recovery, singleton lifecycle. Total: 363/363 tests pass.

### Added (M9-2 Result schema 稳定承诺)

- `RESULT_SCHEMA_VERSION = "1.0.0"` — single source-of-truth SemVer string for every result the auditor emits to AI agents and external consumers.
- `src/core/result-schema.ts` — Zod schemas for the 19 public result types (`AuditRun`, `ScenarioRunResult`, `StepResult`, `Issue`, `DimensionScore`, `ConsoleError`, `CriticResult`, `GateResult`, `CalibrationReport`, `BenchmarkReport`, `BenchmarkTaskResult`, `MutationResult`, MCP tool envelopes, `HistoryEntry`, `PersonaSummary`).
- `attachSchemaVersion(value)` — idempotent helper that stamps `schema_version` at the top of plain object results without overwriting an existing value.
- `validateResult(name, schema, value)` — observe-only `safeParse` wrapper. Mismatches log a structured `warn` line via the result-schema logger; the producer's payload always flows through unchanged at v1.0.0.
- Producers stamp `schema_version` on every freshly emitted result (`runAudit`, `runCritic`, `scoreReport`, `aggregateReport`, `summarize` for benchmarks, `generateMutations`).
- MCP server's 6 tool handlers now route through `stampedTextResult(name, schema, value)`: object responses gain `schema_version` at the top; arrays pass through validated but unwrapped.
- SQLite history DB migrates `user_version` 1 → 2: adds `audit_runs.schema_version TEXT NOT NULL DEFAULT '1.0.0'` (legacy rows backfill to `'1.0.0'`); `loadHistory` returns the value as `HistoryEntry.schemaVersion`.
- New `npm run schemas` script (`scripts/export-result-schemas.ts`) emits Draft-7 JSON Schemas to `docs/schemas/*.schema.json` plus an `index.json` manifest. Each carries `$id`, `title`, `description`, and `x-result-schema-version` for consumer matching.
- `docs/contracts/RESULT_SCHEMA.md` — full SemVer policy (patch / minor / major bump rules, what may change without a bump, how to bump operationally).
- New ADR-007 documenting embed-vs-envelope, observe-then-enforce, and SQLite migration choices.
- 30 new tests across `tests/result-schema.test.ts`, `tests/history.test.ts`, `tests/mcp-server.test.ts` covering schema validation, version stamping, history round-trip, and MCP envelope behavior. Total: 345/345 tests pass.

### Dependencies

- Added (dev): `zod-to-json-schema@^3.25.2`.

### Added (M1-4 Secrets redaction)

- Logger now applies two-layer secret redaction to every log line:
  - **Path-based** — well-known field names (`apiKey`, `password`, `token`, `cookie`, `authorization`, etc.) are always censored regardless of value, both at top level and one level deep.
  - **Value-based** — concrete env-derived secret values (registered at startup via `registerSecret`) are substring-replaced anywhere they appear in payloads or in the message string.
- New `registerSecret(value)` API in `src/core/logger.ts`. Bootstrapped in `src/cli.ts` and `src/mcp/server.ts` via `buildRedactPatterns([])` after `dotenv.config()`.
- New `safePrint` / `safeError` helpers in `src/cli.ts` for `catch` blocks that print `err.message` — runs the same redaction pass on user-facing console output.
- New ADR-006 documenting the design.

### Added (M1-3 Structured logging)

- New `src/core/logger.ts`: pino-based structured logger.
  - `getLogger(module)` returns a module-scoped child logger (cached per module).
  - All output goes to **stderr** — keeps stdout clean for CLI results and the MCP stdio protocol.
  - TTY-aware default: pretty (colored, human-readable) when stderr is a TTY, JSON otherwise.
  - Env config: `LOG_LEVEL` (trace…fatal, default `info`), `LOG_PRETTY` (`auto`/`1`/`0`), `LOG_FILE` (optional tee).
- `scripts/check-no-console.sh`: regression guard wired into `npm test`. Build fails if any source file outside `src/cli.ts` reintroduces `console.{log,error,warn,info,debug}(`.
- New ADR-005 documenting the choice and trade-offs.

### Changed

- ~30 internal `console.*` call sites in `core/runner.ts`, `core/notify.ts`, `core/stagehand-wrapper.ts`, `agent/agent-loop.ts`, `agent/events.ts`, `observer/screencast.ts`, `observer/server.ts`, `mcp/server.ts` migrated to the structured logger.
- `agent/events.ts:attachConsoleLogger` now emits structured log lines (one per agent event) instead of chalk-formatted console writes. Each line carries `event`, `category`, `sessionId`, `seq`, plus event-specific fields.
- The previous `AUDIT_DEBUG=1` gate on agent-loop crash stack traces is removed; `LOG_LEVEL=debug` covers it.
- `npm test` now runs the no-console regression check before vitest.

### Dependencies

- Added: `pino@^10.3.1`, `pino-pretty@^13.1.3`.

## [0.3.0] - 2026-04-17

Released after 22 atomic commits over 6 development weeks; verified with 300
automated tests + live-API Phase-2 smoke ($0.26 / 3 bugs found and fixed
before merge). Fully additive — no breaking changes from v0.2.0.

### Fixed — Phase 2 live smoke (v0.3.0-rc.2)

- `scoreReport` no longer silently disables gate when CLI overrides are
  undefined (object-spread overwrote defaults)
- Calibration fixture labels recalibrated against observed Sonnet 4.6
  scoring — 100% agreement post-fix (was 46.7%)
- `ai-audit explore` now writes audit.json / audit.html / audit-explorer.html
  / summary.md (previously only video + console log)

### Added — Weeks 3-5: Observer + Report SPA + MCP + Memory + Persona gen + Recorder

**Observer UX (Week 3)**
- **Timeline scrubber** in the live observer — every action / plan / criterion
  rendered as a clickable step with color-coded status. Click any step to
  open a right-side drawer showing meta, related events, and reasoning.
  Auto-refresh debounced to 500ms on new events.
- **Multi-session grid** (`/grid` route) — when a run executes N units in
  parallel, each gets its own child SessionStore demultiplexed by
  `session_id`. Grid tile shows status badge, 3 metrics (cost / steps /
  fails), and the last-step label. 2-second polling; new sessions tile in
  automatically.
- **Session history API** — `GET /api/timeline`, `GET /api/events/all`,
  `GET /api/screenshot?seq=`, `GET /api/session/:id` — backing APIs that
  power the scrubber. Exposed as public HTTP so external tooling can
  consume them.

**Interactive Report (Week 3)**
- **`audit-explorer.html`** written alongside `audit.html` on every run.
  Self-contained single-file SPA with:
  - Filter bar (persona × scenario × status × dimension-score ceiling ×
    issue severity)
  - Per-unit expandable cards with 18-dim score grid, step table with
    gantt-style timing bars, issue browser
  - XSS-hardened JSON embed (`<script type=application/json>` + `<`/`>`
    escape), redaction-aware
  - No build step, no runtime deps — works on file:// protocol

**MCP Server (Week 4)**
- **`ai-audit-mcp`** — stdio MCP server exposing 6 tools:
  - `audit_url` / `explore_url` / `list_personas` / `list_scenarios`
    / `calibrate_critic` / `get_last_report`
- Registers in any MCP-aware client (Claude Code, Cursor, Cline,
  Continue, Zed) via `~/.mcp.json`. Lets agents run audits inline
  without leaving their workflow.

**Agent Memory (Week 4)**
- **Per-site playbooks** stored in `~/.ai-browser-auditor/memory.db`.
  Each fact keyed on (host, persona_class) with confidence, confirmations,
  contradictions, TTL.
- Loaded facts feed the planner prompt as hints on first plan — speeds
  convergence on repeat visits.
- `AgentMemory.record()` is idempotent on same fact; confidence grows
  +0.05 per hit (capped 0.99). Contradictions decrement by 0.2; facts
  with more contradictions than confirmations drop out of lookup.
- Shared-DB location with plan cache. 30-day TTL default.
- Disable with `AUDIT_MEMORY_DISABLED=1`.

**Persona Data Pipeline (Week 5)**
- **`ai-audit persona generate --country=BR --device=mobile`** —
  deterministic persona-YAML generator.
- Backed by `src/persona-gen/market-data.ts` — curated Country Profile
  table for 17 countries covering device split / mobile OS split /
  language / timezone / p50 latency / typical payment tier. Values
  from StatCounter + Cloudflare Radar + Ookla Q1 2026.
- Auto-derives viewport, mental_model, critical_concerns (low-bandwidth /
  RTL / GDPR / low-end Android) from country profile.
- Generated YAMLs round-trip through `PersonaSchema`.
- `ai-audit persona list-countries` prints the supported set.

**Scenario Recorder (Week 5)**
- **Chrome MV3 extension** (`extensions/scenario-recorder/`) —
  click-through recording of user interactions → scenario YAML export.
- Privacy-hardened: password fields skipped, long values truncated,
  no network calls.
- Canonical selector derivation: `data-testid` → stable id → aria-label
  → `:has-text()` → nth-child fallback.
- Auto-appends `assert_visual` step so recorded scenarios score output.
- Pure compile logic in `src/recorder-core.ts` is unit-tested (13 tests);
  round-trips through `ScenarioSchema`.

### Changed — Weeks 3-5

- `package.json` adds `@modelcontextprotocol/sdk` + bin `ai-audit-mcp`
- `src/index.ts` re-exports `writeSpaReport`
- `src/cli.ts` adds `persona generate` + `persona list-countries`
- `StepResult.signals` field is now populated on every autonomous action
- Full test suite: 299 tests (up from 226 end of Week 2)

### Added — Week 2: Benchmark harness + Critic calibration

- **WebArena-compatible benchmark runner** (`ai-audit benchmark`) —
  ingests WebArena-shaped task JSON (`task_id`, `intent`, `start_url`,
  `eval`) and runs each through the autonomous agent, emitting pass@1 +
  cost + duration metrics directly comparable with published Browser Use /
  Skyvern scores.
  - Evaluation predicates: `string_match` (must_include/exclude/exact/fuzzy),
    `url_match` (exact/prefix/substring), `exact_match`, `program_html`
  - Filters: `--difficulties easy,medium,hard`, `--tags`, `--limit`
  - Budget caps: `--per-task-budget`, `--total-budget` (stops scheduling
    new tasks when exceeded)
  - Outputs `benchmark.json` (machine-readable) + `benchmark.md` (human)
  - `benchmarks/local-mini/` ships 3 starter tasks running against the
    local fixture site — CI-stable, zero external deps
- **Critic calibration suite** (`ai-audit calibrate`) — detects drift
  when Anthropic ships a new vision model or when critic prompts change.
  - Each sample labels expected score RANGES per dimension (not point
    scores) — acknowledges LLM variance, measures directional correctness
  - CI gate thresholds (defaults): mean_agreement ≥ 0.85,
    mean_max_distance ≤ 1.5, fully_aligned_rate ≥ 0.70
  - `tests/fixtures/critic-calibration/` ships 5 labeled screenshots
    (happy home, post-signup success, broken page, CLS page, slow-LCP)
  - `tests/calibration/generate-fixtures.ts` regenerates screenshots when
    the fixture site changes

### Changed — Week 2

- `src/cli.ts` adds `benchmark` and `calibrate` subcommands (no changes
  to existing commands)
- Full test suite: 226 tests (up from 174 at end of Week 1)

### Added — Week 1: Signal-based convergence + cost-optimized agent

- **4-dimensional success criteria** — `SuccessCriterion.verification` extended with:
  - `network` — assert HTTP request(s) matching url/method/status/duration
  - `performance` — assert Core Web Vitals (LCP/CLS/INP/FCP/TTFB) thresholds
  - `error` — assert bounded console errors / pageerrors / request failures (with `ignore_patterns` for known noise)
  - `interaction` — assert an action actually changed page state (URL / title / interactive DOM / visible text / scroll / focus)

  This defeats the "optimistic success" agent failure where a click reports success but nothing happened or the backend returned 500.
- **Signal collectors** (`src/agent/signals/`) — zero-LLM-cost measurement primitives:
  - `NetworkSignalCollector` — Playwright request/response tracking, `findMatching()` query API
  - `PerformanceSignalCollector` — PerformanceObserver-injected web-vitals capture
  - `ErrorSignalCollector` — console / pageerror / 4xx-5xx static resources, ignore patterns
  - Interaction snapshot+diff functions
  - All four attached per-action in autonomous mode; `StepResult.signals` carries per-step snapshots
- **Plan cache** (`~/.ai-browser-auditor/plan-cache.db`) — SQLite store for reusable autonomous plans
  - Keyed on (scenario_id, persona_class, host, dom_skeleton) — cosmetic changes don't invalidate
  - 7-day TTL; auto-retires after ≥3 failures outweighing successes
  - Disable with `AUDIT_PLAN_CACHE_DISABLED=1`
  - Expected hit rate: 60–80% on repeated runs against the same site
- **Economy navigator tier** — Haiku primary + Sonnet escalation
  - `cost_mode: 'max' | 'balanced' | 'economy'` (default `'balanced'`) in ProjectConfig
  - `balanced`: Haiku primary, Sonnet only when confidence < 0.6 or needs_replan
  - `economy`: Haiku only
  - `max`: legacy v0.2 behavior (always Sonnet)
  - Override per-run: `AUDIT_COST_MODE=economy`
  - Expected: ~3–5× cheaper per action at comparable success rate
- **Micro-replan** — cheap single-step recovery before triggering a full Sonnet replan
  - On stuck convergence, Haiku rewrites / skips / escalates the failing step
  - ~15× cheaper than a full replan; capped at 2 attempts per plan
- **Local fixture test site** (`tests/fixtures/test-site/`) — hermetic integration testing
  - 5 static HTML fixtures + in-process HTTP server with canned JSON APIs
  - Backs `tests/integration/` — full signal + convergence validation without external network

### Changed

- `ProjectConfig.models` adds `navigator_economy` (default Haiku 4.5)
- `ProjectConfig` adds `cost_mode` field (default `'balanced'`)
- `StepResult` adds optional `signals` field for per-step snapshots
- CLI `explore` command now parses config through `ProjectConfigSchema` so defaults populate

### Tests

- 83 new tests across 7 new files (signals/*, convergence-signals, plan-cache, navigator-economy, micro-replan, signals-e2e, agent-loop-e2e)
- Full suite: **174 tests pass** (up from 87 at branch start)
- `tsc --noEmit` clean
- No breaking changes: all new fields are additive + optional

## [0.2.0] - 2026-04-12

### Added

- **4-Layer Reliability Stack** (target: 98-99% step success rate)
  - Layer 1: Page Stability Gate — waits for network idle, DOM stable, framework hydration before AI actions
  - Layer 2: Instruction Mutation — on Stagehand failure, rephrases/decomposes/specifies the instruction using DOM context
  - Layer 3: Selector Hint — optional `selector_hint` field per step for direct Playwright fallback before Computer Use
  - Layer 4: Auto Computer Use fallback — `fallback` now defaults to `"computer_use"` (lightweight Sonnet for non-critical, Opus for critical)
- **axe-core WCAG Accessibility Audit** — new `assert_a11y` step type
  - Injects axe-core into the page, runs against configurable WCAG standard (wcag2a/wcag2aa/wcag2aaa/wcag21aa/wcag22aa/best-practice)
  - Supports `exclude` patterns, `impact_filter`, and `max_violations` threshold
  - Produces structured violation reports with WCAG tag references
  - Complements Vision Critic: axe-core catches rule-based violations, Vision catches visual accessibility issues
- **Historical Trend Tracking** — SQLite-backed audit history (`reports/history.db`)
  - `ai-audit history` command shows recent runs with scores, pass rates, and costs
  - `ai-audit diff <runA> <runB>` command compares two runs with score deltas, new/resolved issues
  - HTML report now includes SVG sparkline trend chart for the last 20 runs
- **Quality Gate** — `--min-score <n>` CLI option fails the build if overall score is below threshold
- **Execution Method Tracking** — `StepResult.execution_method` field tracks which reliability layer succeeded
- **Reliability Breakdown** — CLI prints reliability stack stats on completion
- `accessibility` added to `scoring_dimensions` enum
- **Multi-project support**: `--project <dir>` flag loads config + scenarios from any directory
- **`ai-audit init` command**: scaffolds a new project audit directory with template files
- **Project layout**: `projects/scamlens/` as the first project using the new structure
- **CI multi-project dispatch**: workflow accepts project selection (built-in or external repo)
- **12 new personas** (18 total) covering global markets:
  - India (Hindi, budget Android), Korea (Korean, QHD desktop), Vietnam (Vietnamese, Android)
  - Russia (Cyrillic, Windows), Nigeria (English, budget Tecno), Mexico (Spanish LATAM, Android)
  - Indonesia (Bahasa, Android), Thailand (Thai, small iPhone SE), Taiwan (Traditional Chinese, iPad)
  - France (French, iPhone), UK enterprise (English, Power tier security analyst)
  - US elderly (72yo retired teacher, iPad — #1 scam target demographic)
- **Coverage matrix**: 15 countries, 13 languages, 5 script systems (Latin/CJK/Arabic/Cyrillic/Devanagari), 3 device classes, 3 payment tiers
- **Scenario persona expansion**: domain-check now runs all 18 personas, localization audit covers 14 non-English personas

### Changed

- `fallback` default changed from `undefined` to `"computer_use"` — all steps now auto-fallback
- `handleExtract` and `handleObserve` now include stability gate
- HTML report step trace shows `via=` tag when a non-primary execution method was used

### Dependencies

- Added `axe-core` (^4.x) — WCAG accessibility engine
- Added `better-sqlite3` (^11.x) — local audit history storage

## [0.1.1] - 2026-04-11

### Fixed

- Vision audit pipeline hardened: 3 root-cause framework bugs resolved
  - Critic scoring no longer fails silently when screenshot capture times out
  - Recorder correctly handles concurrent video + HAR streams without race condition
  - Reporter gracefully degrades when partial step data is missing

## [0.1.0] - 2026-04-11

### Added

- **Core engine**: Stagehand 2.0 + Claude vision hybrid execution pipeline
- **6 personas**: US/JP/DE/CN/BR/SA spanning mobile/desktop/tablet, Free/Pro/Power tiers
- **9 scenarios**: infra smoke, OAuth signup, domain check, admin audit, localization sweep, crypto trace, investigation v2, email opt-in, Chrome extension
- **Claude vision critic**: 5-dimension scoring (completion, localization, visual_polish, trust_signals, time_to_value)
- **Computer Use escalation**: Playwright-backed pixel-level review for critical steps
- **Recording**: video (WebM), HAR network log, console errors, SHA-256 hashed screenshots
- **Reporting**: JSON (machine) + HTML (dark theme dashboard) + Markdown (terminal)
- **Concurrency control**: parallel persona x scenario matrix with same-origin throttling via p-limit
- **Budget cap**: stops new audit units when cumulative LLM cost exceeds threshold
- **Retry strategies**: per-step exponential backoff with fingerprint rotation fallback
- **Visual regression**: odiff-bin pixel diff with baseline management
- **Email verification**: mail.tm temporary inbox integration for signup flows
- **Notifications**: Slack webhook + Telegram bot on completion
- **CI workflow**: GitHub Actions post-deploy-audit.yml (artifact upload, PR comment, exit codes)
- **Stripe safety**: refuses to start if `pk_live_` keys detected in env
- **Documentation**: architecture guide, scenario authoring guide, persona design guide, CI integration guide

[0.2.0]: https://github.com/xcodethink/ai-browser-auditor/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/xcodethink/ai-browser-auditor/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/xcodethink/ai-browser-auditor/releases/tag/v0.1.0

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — v1 worktree (worktree-v1-ai-first)

> Phase 1 (AI core) work-in-progress for the Big Bang v1 release. Not yet shipped.

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

# Architecture

## Layer cake

```
┌──────────────────────────────────────────────────────────────────┐
│  CLI (commander)  ──────────────────────────────────────────────  │
├──────────────────────────────────────────────────────────────────┤
│  Runner (concurrency, throttle, budget, lifecycle)                │
├──────────────────────────────────────────────────────────────────┤
│  Step handlers (visit / act / extract / observe / wait_for /     │
│    assert_visual / assert_dom / assert_a11y / check_email /      │
│    screenshot / computer_use / custom)                            │
├──────────────────────────────────────────────────────────────────┤
│  4-Layer Reliability Stack (act/extract/observe steps)            │
│  ├─ L1: Page Stability Gate  (network idle + DOM stable + hydration) │
│  ├─ L2: Instruction Mutation (rephrase / decompose / specify)    │
│  ├─ L3: Selector Hint        (direct Playwright fallback)        │
│  └─ L4: Auto Computer Use    (Sonnet lightweight / Opus critical)│
├──────────────────────────────────────────────────────────────────┤
│  Core services                                                    │
│  ├─ Stagehand wrapper  (Stagehand 3.x + post-init stealth)       │
│  ├─ Computer Use loop  (Playwright-backed action handlers)       │
│  ├─ Vision critic      (Claude vision + 5-dim scoring)           │
│  ├─ axe-core engine    (WCAG accessibility analysis)             │
│  ├─ Recorder           (video, HAR, console, sha256 screenshots) │
│  ├─ Visual diff        (odiff baseline regression)               │
│  ├─ History            (SQLite trend tracking + run comparison)   │
│  ├─ Email helper       (mail.tm temp inbox)                      │
│  ├─ LLM client         (Anthropic SDK + cost estimator)          │
│  ├─ Secrets            (cookie/Stripe injection + redaction)     │
│  └─ Throttle           (per-origin serial queue)                 │
├──────────────────────────────────────────────────────────────────┤
│  stealth-core          (vendored, see ADR-032)                   │
│  ├─ 9 device fingerprints (4 desktop / 2 tablet / 3 mobile)      │
│  ├─ 15 anti-detection JS patches                                 │
│  ├─ buildStealthLaunchOptions() — Stagehand-compatible           │
│  └─ withRetry() — classification-based exponential backoff       │
├──────────────────────────────────────────────────────────────────┤
│  Playwright (chromium)                                           │
└──────────────────────────────────────────────────────────────────┘
```

## Lifecycle of one (persona × scenario) unit

1. **Resolve** — load persona YAML, scenario YAML, project config
2. **Resolve fingerprint** — pick a device profile matching `persona.ua_class` or `device_class`
3. **Build launch opts** — `stealth-core.buildStealthLaunchOptions()` produces a Stagehand-compatible config (proxy, viewport, locale, timezone, recordHar, recordVideo, args including `--user-agent=...`)
4. **Construct Stagehand** — `new Stagehand({ env: "LOCAL", localBrowserLaunchOptions, modelName: "claude-sonnet-4-6", ... })`
5. **Init Stagehand** — Stagehand launches its own Chromium with our stealth args
6. **Inject 15 stealth patches** — `stagehand.context.addInitScript(buildStealthScript(fp))`
7. **Inject cookies** — admin cookies if scenario targets `/admin`
8. **Inject temp inbox** — if scenario has any `check_email` step, create a mail.tm inbox upfront
9. **Attach Recorder** — listen to `console`/`pageerror`/`requestfailed` on the page
10. **Execute steps** — for each step, dispatch to its handler with `StepContext`. Steps marked `critical_review: true` may escalate to Computer Use.
11. **Visual diff** — every screenshot is compared against the baseline (if `--baseline` is set)
12. **Critical fail** — if a critical step fails, abort the scenario early
13. **Aggregate** — collect critic scores, console errors, diff regressions
14. **Close** — stop tracing, close Stagehand (which closes the browser), save video/HAR

## Why we let Stagehand own the browser

Stagehand 3.x's `init()` does not accept a BYO `BrowserContext`. We have three options:

| Option | Pros | Cons |
|---|---|---|
| Launch our own browser, use Stagehand `cdpUrl` to attach | Full control over stealth | Requires opening a CDP port; concurrency complications |
| Let Stagehand launch via `localBrowserLaunchOptions` + post-init `addInitScript` | One process, parallel-safe, all features work | Lose access to setting raw `userAgent` (workaround: `--user-agent=...` Chromium arg) |
| Use a fork of Stagehand | Full control | Maintenance burden |

We chose option 2. The `--user-agent=...` Chromium CLI flag fully equates to Playwright's `userAgent` context option, so we lose nothing.

## How Computer Use is wired

Anthropic's Computer Use reference uses Xvfb + Linux desktop. We replace that with **Playwright-backed action handlers**:

```
Claude returns { action: "left_click", coordinate: [x, y] }
  → our handler scales [x, y] back to real viewport
  → page.mouse.click(realX, realY)
  → page.screenshot() → resize via sharp to scaled dims
  → return image to Claude
```

This means Computer Use shares the **same stealth-fingerprint browser** as Stagehand — same cookies, same localStorage, same login state. No Docker, no Xvfb, no second browser. Code is in [src/core/computer-use.ts](../src/core/computer-use.ts).

The handler covers all 16 action types from `computer_20251124`: screenshot, left/right/middle/double/triple click, drag, mouse_move, type, key, hold_key, scroll, wait, mouse down/up, zoom.

## Concurrency model

- **Global**: `pLimit(concurrency)` controls how many units run in parallel (default 3)
- **Per-origin**: `OriginThrottle` ensures units targeting the same origin are serialized within that origin (so a 6-persona × 1-scenario run against your-app.com doesn't blast 6 requests/sec at the same WAF)
- **Budget**: a global `cost.value` accumulator stops new units from starting once the cap is exceeded
- **Cross-process**: shared mutable state — `cost-ledger.json`, `memory.db`, visual-diff baselines — is protected against races between parallel CLI / MCP processes. The cost ledger uses a `withFileLock` advisory lockfile around its read-modify-write; `AgentMemory.record` is one atomic SQLite upsert; visual baselines bootstrap via `linkSync` so the first writer wins. See [ADR-009](decisions/ADR-009-concurrency-safety.md).
- **Per-call cost isolation**: per-run cost-guard counters live in an `AsyncLocalStorage` scope. Each `runAudit` call and each MCP tool dispatch gets its own scope, so two parallel tool invocations in a single MCP server process keep independent run-USD caps.

## 4-Layer Reliability Stack

The reliability stack targets 98-99% step success rate (up from ~75% with Stagehand alone). Each layer only fires when the previous one fails:

```
Request arrives at handleAct()
  │
  ��── L1: waitForPageStable()           ← network idle + DOM stable + hydration
  │     Prevents operating on pages still loading/hydrating.
  │     Cost: 0. Latency: 0-8s (typically <1s).
  │
  ├── L2: stagehand.act(instruction)    ��� primary Stagehand semantic action
  │     If success → return
  │     If fail → cascade
  │
  ├── L3a: Selector Hint                ← direct Playwright click via step.selector_hint
  │     If selector_hint exists and element is visible → click → return
  │     Cost: 0. No LLM call.
  │
  ├── L3b: Instruction Mutation         ← rephrase/decompose/specify the instruction
  │     Uses DOM context to generate targeted variants.
  │     Tries each variant with Stagehand in order.
  │     Cost: 0 (local string manipulation, no LLM call).
  │
  └── L4: Computer Use                  ← autonomous pixel-level fallback
        Non-critical: Sonnet, 3 iterations (cheap, fast)
        Critical: Opus, 8 iterations (thorough)
        Cost: $0.01-0.15 per invocation.
```

**Expected reliability uplift:**

| Layer | Mechanism | Estimated Uplift |
|-------|-----------|-----------------|
| L1    | Page stability gate | +10% (eliminates timing failures) |
| L2    | Stagehand primary | baseline 75% |
| L3a   | Selector hint | +5% (when hints provided) |
| L3b   | Instruction mutation | +5% (rephrase/decompose) |
| L4    | Computer Use | +3-4% (catches remaining edge cases) |
| **Total** | | **~98-99%** |

### Execution method tracking

Every `StepResult` now includes an `execution_method` field:
- `"stagehand"` — primary path succeeded
- `"selector_hint"` — Layer 3a direct Playwright fallback
- `"instruction_mutation"` — Layer 3b rephrased instruction succeeded
- `"computer_use"` — Layer 4 autonomous fallback

The CLI prints a reliability breakdown after each run.

## axe-core Accessibility Audit

The `assert_a11y` step type injects [axe-core](https://github.com/dequelabs/axe-core) into the page and runs WCAG analysis:

```yaml
- id: a11y-homepage
  type: assert_a11y
  standard: wcag2aa
  exclude: [".cookie-banner", ".third-party-widget"]
  max_violations: 0
  impact_filter: [critical, serious]
```

This complements the Vision Critic:
- **axe-core** catches rule-based WCAG violations (ARIA attributes, contrast ratios, form labels, keyboard navigation, alt text)
- **Vision Critic** catches visual accessibility issues (text too small, buttons too close, layout confusion, poor visual hierarchy)

Violations are converted to the auditor's Issue format with severity mapping:
- `critical` (axe) → `critical` (issue)
- `serious` (axe) → `high` (issue)
- `moderate` (axe) → `medium` (issue)
- `minor` (axe) → `low` (issue)

An accessibility dimension score is automatically computed and added to the critic results.

## Historical Trend Tracking

Every audit run is saved to `reports/history.db` (SQLite via better-sqlite3):

```
reports/
├── history.db                  ← persistent trend database
├── 2026-04-11_143022_manual/   ← individual run artifacts
└── 2026-04-12_091500_manual/
```

**Schema:** `audit_runs` (summary stats), `dimension_scores` (per-unit per-dimension), `issues_history` (all issues).

**CLI commands:**
- `pixelcheck history` — show recent runs in a table
- `pixelcheck diff <runA> <runB>` — compare two runs (score deltas, new/resolved issues)
- `pixelcheck run --min-score 7.5` — quality gate (fail build if score < threshold)

**HTML report integration:** when trend data exists, the report includes an SVG sparkline chart showing overall score across the last 20 runs, plus a history table.

## Failure handling

| Failure type | Action |
|---|---|
| `act()` throws | Cascade through 4-layer reliability stack; mark fail only if all layers exhausted |
| Network 4xx | Don't retry, mark fail |
| Network 5xx / timeout | Retry with exponential backoff (`stealth-core/retry.ts`) |
| Bot challenge page detected | Retry (caller can swap fingerprint) |
| Critical step fails | Abort the scenario |
| Scenario crashes | Add a critical issue, mark fail |
| Critic returns malformed JSON | Add a low-severity warning, don't crash |
| Computer Use loop hits max iterations | Return whatever finalText was last seen |
| axe-core critical violations | Mark step as fail |
| axe-core serious violations | Mark step as warn |

## Reports

Three formats from one source of truth, plus persistent history:

- `audit.json` — machine-readable, for CI parsers, dashboards, history
- `audit.html` — dark theme, embedded screenshots, per-scenario sections, score chips, issue lists, SVG trend chart
- `summary.md` — terminal-friendly, for git commit messages, Slack pastes
- `history.db` — SQLite database for trend tracking across runs

All report formats pass through the redaction layer (`secrets.redactDeep`) before being written. The HTML report automatically includes trend data when the history database contains >= 2 runs for the project.

## MCP Server

`src/mcp/` exposes the auditor as a Model Context Protocol server over stdio. Any MCP-aware client (Claude Code, Cursor, Cline, Continue, Zed agent) can drive audits without leaving its workflow.

**Module layout** (M3-6 + M9-1, see [ADR-010](decisions/ADR-010-mcp-tool-registry.md)):

| File | Responsibility |
|---|---|
| `server.ts` | Transport lifecycle, secret bootstrap, ALL_TOOLS catalog, ListTools mapping, CallTool dispatcher (wraps each call in `withCostRun` + try/catch). |
| `registry.ts` | `ToolDefinition` record + `ToolRegistry` class (register / get / has / list / size / describe). Side-effect-free, trivially unit-testable. |
| `result.ts` | `ToolResult` shape + `textResult` / `errorResult` / `stampedTextResult`. Last one stamps `schema_version` and runs `validateResult` per [ADR-007](decisions/ADR-007-result-schema-versioning.md). |
| `helpers.ts` | `requireString` (argument coercion) + `resolvePersona` (id → persona with sensible fallback). |
| `tools/<name>.ts` | One file per tool. Exports a `ToolDefinition` with `name` / `description` / `inputSchema` / `kind` / optional `resultSchema` / `handler`. |

**Tool kinds** (used today by the catalog, surfaced by `list_capabilities`):

- **preset** — composed pipelines. Today: `audit_url` (full audit) and `explore_url` (autonomous goal-driven run).
- **primitive** — single-capability building blocks. Today: `see` (N-1 — see [ADR-011](decisions/ADR-011-see-primitive.md)), `act` (N-2 — see [ADR-012](decisions/ADR-012-act-primitive.md)), `extract` (N-4 — see [ADR-013](decisions/ADR-013-extract-primitive.md)), `judge` + `compare` (N-8 + N-3 — see [ADR-014](decisions/ADR-014-judge-and-compare-primitives.md)).
- **meta** — introspection / discovery. Today: `list_personas`, `list_scenarios`, `list_capabilities` (M9-5 — see [ADR-016](decisions/ADR-016-mcp-self-describe.md)), `get_last_report`, `calibrate_critic`.

**Adding a new tool**:

1. Drop a file under `src/mcp/tools/<name>.ts` exporting a `ToolDefinition`.
2. Push it into `ALL_TOOLS` in `server.ts`.

That's it — `tools/list` and the dispatcher both pick it up automatically. No switch-case edit, no inline JSON Schema in `server.ts`.

The `ListTools` response only emits the spec-compliant `{ name, description, inputSchema }` subset; `kind`, `resultSchema`, `cacheable`, `costEstimateUsd`, `sideEffects` and `requires` stay on the registry. The `list_capabilities` meta tool is the proper exit for those richer fields (see [ADR-016](decisions/ADR-016-mcp-self-describe.md)). `tests/mcp-registry.test.ts` enforces that every declared `resultSchema` matches a JSON Schema in [docs/schemas/](schemas/), `network_egress ⇔ apiKeys non-empty`, `browser ⇒ navigation`, the M9-4 cacheable matrix is preserved, and the cost band is well-formed (`min ≤ typical ≤ max ≥ 0`, unit ∈ {`per_call`, `per_step`, `per_persona_scenario`}). A tool can never ship without consistent metadata.

Per-tool dynamic imports keep the cold-start path lean: heavy modules (`runner`, `reporter-spa`, `calibration/runner`, `history`) are only loaded when their tool is invoked. `list_personas` / `list_scenarios` cost a couple of milliseconds.

### Primitives

Primitives live under `src/core/primitives/<name>.ts` and are intentionally **decoupled from `runAudit` and Stagehand**. They use raw Playwright, expose simple `(opts) => Promise<Result>` signatures, and integrate with the existing cross-cutting concerns (cost guard, schema versioning, concurrency safety) without dragging in scenario YAML, persona files, or the reporter pipeline.

The shipped primitives are:

- **`see` (N-1)** — a one-shot navigation snapshot. See [ADR-011](decisions/ADR-011-see-primitive.md) for the design trade-offs (why no Stagehand, why `callVision` instead of `runCritic`, why per-call artefact subdirectories). The MCP-side wrapper in `src/mcp/tools/see.ts` translates snake-case JSON args into `SeeOptions`.
- **`act` (N-2)** — execute a sequence of actions. Step kinds split into deterministic (`goto` / `click` / `fill` / `press` / `wait` / `wait_for` / `scroll` / `screenshot`) and AI-driven (`act` for natural-language Stagehand calls, `note` for one vision call). The engine auto-selects per call: pure-deterministic step lists run on raw Playwright (~1 s cold start, no LLM key needed), Stagehand only spins up if any step is `act`. See [ADR-012](decisions/ADR-012-act-primitive.md) for rationale (mixed-kind contract, auto engine, stop-on-error semantics, why no inline retry stack).
- **`extract` (N-4)** — schema-bound structured extraction. Caller passes a JSON Schema (subset whitelist: object/array/string/number/integer/boolean/null + properties/required/items/enum/description/nullable; `oneOf`/`$ref`/`const` rejected with a precise path-locator error). The primitive converts to Zod internally, runs Stagehand's `page.extract()`, and returns matching `data` plus the same envelope as see/act. Single-engine: Stagehand only — there is no deterministic alternative for arbitrarily-shaped schema-bound extraction. Stagehand metrics are read post-call to compute USD cost via `estimateCost(model, deltaIn, deltaOut)` and feed `getCostGuard().recordUsage()` (closes the cost-tracking gap that `act`'s `act` step left open). See [ADR-013](decisions/ADR-013-extract-primitive.md) for rationale.
- **`judge` (N-8)** — single-page rubric-driven critic. Captures (or accepts) a page snapshot, then runs ONE vision call against the chosen rubric(s) and returns per-criterion verdicts (0..10 score + rationale + evidence) plus severity-graded findings with on-screen locations. Rubrics are reified data in `src/core/critics/{aesthetic.ts,dark-pattern.ts}` — 8 aesthetic criteria + 12 dark-pattern criteria, plus caller-supplied `customCriteria`. Score direction is uniform (higher = better, even for dark-pattern criteria where 10 = no DP detected) so `overall_score` stays monotonic across mixed rubrics. Decoupled from `runCritic` (which is persona × scenario × dimension scoring) so it works without project setup. See [ADR-014](decisions/ADR-014-judge-and-compare-primitives.md) for rationale.
- **`compare` (N-3)** — A/B comparison primitive built on top of `judge`. Default mode `double_blind` judges each side independently in parallel with the same rubric, then runs ONE synthesis vision call that sees both screenshots side-by-side with the prior judgements as context — 3 vision calls total (wall-clock ≈ 2 calls), free of anchoring bias (commercial UX-review practice from Nielsen Norman / Baymard). `fast` mode collapses to 1 vision call seeing both sides — cheaper but anchored. Embedded JudgeResult per side in double_blind mode enables future M9-4 result-cache reuse (judge once, compare many times). See [ADR-014](decisions/ADR-014-judge-and-compare-primitives.md).

Adding a new primitive is a four-commit recipe: schema entry in `result-schema.ts` (+ `npm run schemas`), primitive module under `src/core/primitives/`, MCP tool wrapper under `src/mcp/tools/` with `kind: "primitive"`, ADR + CHANGELOG.

### Self-describe (`list_capabilities`, M9-5)

`list_capabilities` is a `meta` tool that returns a structured snapshot of every shipped tool's capabilities plus the public env-var table and live cache state. AI agents call it once on first connect to plan the rest of the session — they get cost band, side-effect set, dependency declarations, and result-schema title for every tool, all without trial-and-error.

**Static vs live.** Per-tool fields (`cacheable`, `cost_estimate_usd`, `side_effects`, `requires`) are static metadata declared on each `ToolDefinition` literal. The 21-row env table is a hand-curated list in `src/mcp/tools/list-capabilities.ts` covering every `AUDIT_*` / `LOG_*` / `ANTHROPIC_API_KEY` env var the codebase reads — a completeness test in `tests/list-capabilities.test.ts` forces the set to stay in sync. The `cache.{enabled, ttl_ms_default, path}` block is read live from `process.env` so the report reflects the calling process's actual configuration.

**Privacy.** `requires.api_keys` declares a *static dependency* on env-var names; it does NOT probe whether each is currently set (would leak secret-presence to every caller). The env table follows the same rule: secret names appear, values never do. The result-cache file path *is* exposed because paths are not secrets — agents writing diagnostic / cleanup scripts genuinely need them. A planted-secret test in `tests/list-capabilities.test.ts` asserts that a fake `ANTHROPIC_API_KEY=sk-ant-FAKE-LEAK-SENTINEL-…` value never appears in output, while the *name* `ANTHROPIC_API_KEY` does.

**Naming.** Internal TypeScript uses camelCase (`costEstimateUsd`, `sideEffects`); the output JSON uses snake_case (`cost_estimate_usd`, `side_effects`) to match the rest of the MCP envelope conventions. The handler does the translation.

**Why not in `tools/list`.** Strict MCP clients may reject unknown fields on `Tool` records. The richer fields stay on the registry. See [ADR-016](decisions/ADR-016-mcp-self-describe.md) for the full design (including 8 alternatives rejected — runtime-presence probes, in-memory caching, HTTP content negotiation, etc.).

## Logging

All internal modules log through a structured logger built on [pino](https://github.com/pinojs/pino) (`src/core/logger.ts`).

Key properties:

- **Output stream**: stderr only — keeps stdout clean for CLI results and the MCP stdio protocol.
- **Format**: pretty-printed (colored, human-readable) when stderr is a TTY, JSON otherwise. So `pixelcheck run` in a terminal still shows readable progress, while CI pipelines and the MCP server emit machine-parseable JSON.
- **Module-scoped**: every module gets its own child logger via `getLogger("module.name")`. The `module` field is auto-attached to every log line.
- **Configurable via env**:
  - `LOG_LEVEL` — `trace|debug|info|warn|error|fatal|silent` (default `info`)
  - `LOG_PRETTY` — `1|true` force pretty, `0|false` force JSON, `auto` (default) decide by TTY
  - `LOG_FILE` — additionally tee logs to a file (created if missing)

The CLI rendering layer (`src/cli.ts`) is the **only** module that may use `console.*` directly — those calls are user-facing chalk-styled UX, not diagnostics. A regression check (`scripts/check-no-console.ts`, wired into `npm test`) fails the build if any other source file reintroduces `console.{log,error,warn,info,debug}`.

Sample log line (JSON mode):

```json
{"level":"info","time":"2026-04-26T01:23:45.678Z","pid":12345,"module":"runner","runId":"20260426_012345","units":3,"concurrency":2,"budgetUsd":3,"msg":"run started"}
```

### Redaction

Two layers protect against secret leakage in log output:

**Path-based** — well-known field names always get `[REDACTED]` regardless of value. Built into pino via the `redact.paths` option. Covers: `apiKey` / `api_key` / `password` / `token` / `secret` / `cookie` / `cookies` / `authorization` / `auth` / `anthropic_api_key` / `ANTHROPIC_API_KEY`, both at top level and one level deep (`*.apiKey`, etc.). Cheap — fast-redact under the hood.

**Value-based** — concrete secret strings registered at startup get substring-replaced anywhere they appear in any log payload, including inside the message string. Implemented as a `hooks.logMethod` interceptor that runs before pino composes the line.

Bootstrap (in `cli.ts` and `mcp/server.ts`):

```ts
import { buildRedactPatterns } from "./core/secrets.js";
import { registerSecret } from "./core/logger.js";

dotenv.config();
for (const p of buildRedactPatterns([])) registerSecret(p);
```

`buildRedactPatterns([])` collects values from `ANTHROPIC_API_KEY`, `SCAMLENS_ADMIN_COOKIE`, `STRIPE_TEST_PUBLISHABLE_KEY`, `TEST_GOOGLE_*_PASSWORD`, `SLACK_WEBHOOK`, `TELEGRAM_BOT_TOKEN`, plus any patterns the project's `config.yaml` defines. Values shorter than 8 characters are ignored to avoid blanket-redacting common words.

The same `secrets.redactDeep()` already runs over every audit report (`audit.json` / `audit.html` / `summary.md`) before disk write, so reports never contain raw secrets either.

The CLI rendering layer (`src/cli.ts`) provides `safePrint` / `safeError` helpers that run the same redaction pass on user-facing console output for error messages that may interpolate `err.message` or other fields containing secret values.

## Cost Guard

Every Anthropic API call is intercepted by a process-wide cost guard (`src/core/cost-guard.ts`) that enforces two limits:

- **Per-run** — single audit / MCP tool invocation. Reset by `runAudit()` at run start and by the MCP `CallToolRequestSchema` dispatcher at the start of every tool call.
- **Per-day** — UTC-day total persisted to a JSON ledger (default `~/.pixelcheck/cost-ledger.json`, override via `AUDIT_COST_LEDGER_PATH`). Survives process restart and is shared across concurrent processes via last-write-wins atomic temp + rename.

Hook pattern at every call site:

```ts
const guard = getCostGuard();
guard.checkBudget();                                    // pre: throw if already over
const response = await client.messages.create({ ... }); // the only thing that costs money
guard.recordUsage(model, in_tokens, out_tokens);        // post: persist + throw if this call straddled the cap
```

Six call sites are wrapped this way: `core/llm.ts:callVision`, `core/computer-use.ts` beta loop, `core/instruction-mutator.ts:llmRewrite`, `agent/planner.ts` (`createPlan` + `microReplan`), `agent/navigator.ts:decideNextStep`. Convergence's visual criterion check inherits via `callVision`.

`BudgetExceededError` carries a `kind` (`run-usd` / `run-tokens` / `daily-usd` / `daily-tokens`), the `current` total, and the `limit`. The error message includes the exact env var name to override and the `AUDIT_COST_GUARD_DISABLED=1` bypass for CI / tests.

Ledger is stamped with `COST_LEDGER_SCHEMA_VERSION = "1.0.0"` (per ADR-007's SemVer rules) and auto-prunes entries older than 30 days at every write. A malformed ledger file is treated as empty (warn-logged) so audits never get bricked by a corrupted file.

This layer is independent of the runner's `budget_usd` setting, which is a unit-scheduling hint that stops *new* units from starting; the cost guard is a hard cap at the LLM-call boundary that also catches direct MCP tool calls and computer-use loops not orchestrated by the runner.

See ADR-008 for the full design rationale.

## Result Cache

Three primitives — `judge`, `extract`, `see` (when `goal` is set) — are wrapped with a persistent local cache (`src/core/result-cache.ts`). Same logical inputs return the prior result instantly with `cost_usd` zeroed and `cache.cost_saved_usd` populated, so repeat tool calls during AI reasoning loops cost $0.

**Key derivation.** `cacheKeyFor(primitive, inputs) = sha256(canonical-JSON({ primitive, inputs }))`. `canonicalJsonStringify` recursively sorts object keys before stringify (arrays preserve order). Each primitive defines `cacheKeyInputs(opts)` listing the fields that affect output (URL, schema, rubrics, persona / viewport / locale, model). Performance-only options (timeout, headless, artifactsRoot) are excluded so the same logical call hits cache regardless of how it was scheduled.

**Storage.** SQLite at `~/.pixelcheck/result-cache.db` (override `AUDIT_RESULT_CACHE_PATH`). One table `result_cache(key PK, primitive, value_json, schema_version, created_at)` with indexes on `created_at` (TTL prune) and `primitive` (diagnostics). WAL transition is file-locked per the M9-3 follow-up pattern.

**TTL & invalidation.** Default 24h via `AUDIT_RESULT_CACHE_TTL_MS`. Entries written under a different `RESULT_SCHEMA_VERSION` are misses and pruned on read. Opportunistic prune at most once per opened DB per hour.

**Atomic writes.** `INSERT ... ON CONFLICT(key) DO UPDATE` — one statement, SQLite serialises it; concurrent writers on the same key converge cleanly.

**Cache-aware result envelope.** `RESULT_SCHEMA_VERSION` 1.0.0 → 1.1.0. Each primitive envelope (`see` / `act` / `extract` / `judge` / `compare`) gained an optional `cache?: { hit, age_ms, key, cost_saved_usd? }` field. On hit, the envelope's `cost_usd` is set to 0 and the original cost moves to `cache.cost_saved_usd` so cost aggregators (e.g. `compare` summing two `judge` calls) do not double-count cached work.

**Bypass.** `AUDIT_RESULT_CACHE_DISABLED=1` (global), per-call `cache: false` (skip read + write), per-call `cacheBust: true` (skip read, persist new result). MCP tools surface these as `cache` / `cache_bust` / `cache_ttl_ms`.

**Not cached.** `act` (state-changing imperatives), `compare` directly (its `judge` sub-calls hit cache transparently), `audit_url` / `explore_url` (heavyweight, deferred).

See ADR-015 for the full design rationale.

## Test coverage

Unit tests run with `vitest`; coverage is provided by `@vitest/coverage-v8` and gated through `vitest.config.ts > coverage.thresholds`. `npm run test:coverage` writes a `./coverage/index.html` report; `npm run test:coverage:check` enforces the thresholds (CI gate).

**What's counted.** `src/**/*.ts` minus entry-points (`cli.ts` / `index.ts` / `mcp/server.ts`) and pure-type contracts (`core/types.ts` / `core/result-schema.ts`). The exclusions are tested through consumer paths (CLI subcommand smoke + MCP `tools/list` handshake + schema round-trip tests); counting them again would dilute the signal without telling us anything about logic correctness.

**Threshold ratchet.** Floors sit at or below the current global baseline. Each M1-2 phase commit (see [ADR-017](decisions/ADR-017-coverage-tooling-and-m1-2-phase-1.md)) raises the floor by at least the gain it just produced, so the gate actively protects the gain rather than auto-deflating to whatever the latest test set produces.

**M1-2 phase scope.** Phase 1 covered all small/utility modules — `scenario` / `config` / `throttle` / `url-preflight` / `image` / `persona` / `secrets` / `page-stability` / `visual-diff` / `notify` / `email` / `stagehand-wrapper` — to ≥ 80% on the testable surface. Phase 2 covers the LLM-heavy modules (`critic` / `llm` / `instruction-mutator`) via mocked Anthropic SDK. Phase 3 covers the orchestration layer (`runner` / `computer-use` / `reporter` / `agent-loop`) — these need substantial Playwright + Stagehand + history-DB mocking.

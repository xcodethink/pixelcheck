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
│  ├─ Stagehand wrapper  (Stagehand 2.5 + post-init stealth)       │
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
│  stealth-core          (shared with playwright-screenshots)      │
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

Stagehand 2.5's `init()` does not accept a BYO `BrowserContext`. We have three options:

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
- **Per-origin**: `OriginThrottle` ensures units targeting the same origin are serialized within that origin (so a 6-persona × 1-scenario run against scamlens.org doesn't blast 6 requests/sec at the same WAF)
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
- `ai-audit history` — show recent runs in a table
- `ai-audit diff <runA> <runB>` — compare two runs (score deltas, new/resolved issues)
- `ai-audit run --min-score 7.5` — quality gate (fail build if score < threshold)

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

**Tool kinds** (used today by the catalog, surfaced by the future M9-5 `list_capabilities`):

- **preset** — composed pipelines. Today: `audit_url` (full audit) and `explore_url` (autonomous goal-driven run).
- **primitive** — single-capability building blocks. Today: `see` (N-1 — see [ADR-011](decisions/ADR-011-see-primitive.md)). Coming: N-2 `act`, N-3 `compare`, N-4 `extract`.
- **meta** — introspection / discovery. Today: `list_personas`, `list_scenarios`, `get_last_report`, `calibrate_critic`.

**Adding a new tool**:

1. Drop a file under `src/mcp/tools/<name>.ts` exporting a `ToolDefinition`.
2. Push it into `ALL_TOOLS` in `server.ts`.

That's it — `tools/list` and the dispatcher both pick it up automatically. No switch-case edit, no inline JSON Schema in `server.ts`.

The `ListTools` response only emits the spec-compliant `{ name, description, inputSchema }` subset; `kind` and `resultSchema` stay on the registry for `list_capabilities` and unit-test invariants. `tests/mcp-registry.test.ts` enforces that every declared `resultSchema` matches a JSON Schema in [docs/schemas/](schemas/), so a tool can never claim a result shape that isn't published.

Per-tool dynamic imports keep the cold-start path lean: heavy modules (`runner`, `reporter-spa`, `calibration/runner`, `history`) are only loaded when their tool is invoked. `list_personas` / `list_scenarios` cost a couple of milliseconds.

### Primitives

Primitives live under `src/core/primitives/<name>.ts` and are intentionally **decoupled from `runAudit` and Stagehand**. They use raw Playwright, expose simple `(opts) => Promise<Result>` signatures, and integrate with the existing cross-cutting concerns (cost guard, schema versioning, concurrency safety) without dragging in scenario YAML, persona files, or the reporter pipeline.

The first shipped primitive is `see` (N-1) — a one-shot navigation snapshot. See [ADR-011](decisions/ADR-011-see-primitive.md) for the design trade-offs (why no Stagehand, why `callVision` instead of `runCritic`, why per-call artefact subdirectories). The MCP-side wrapper in `src/mcp/tools/see.ts` translates snake-case JSON args into `SeeOptions`.

Adding a new primitive is a four-commit recipe: schema entry in `result-schema.ts` (+ `npm run schemas`), primitive module under `src/core/primitives/`, MCP tool wrapper under `src/mcp/tools/` with `kind: "primitive"`, ADR + CHANGELOG.

## Logging

All internal modules log through a structured logger built on [pino](https://github.com/pinojs/pino) (`src/core/logger.ts`).

Key properties:

- **Output stream**: stderr only — keeps stdout clean for CLI results and the MCP stdio protocol.
- **Format**: pretty-printed (colored, human-readable) when stderr is a TTY, JSON otherwise. So `ai-audit run` in a terminal still shows readable progress, while CI pipelines and the MCP server emit machine-parseable JSON.
- **Module-scoped**: every module gets its own child logger via `getLogger("module.name")`. The `module` field is auto-attached to every log line.
- **Configurable via env**:
  - `LOG_LEVEL` — `trace|debug|info|warn|error|fatal|silent` (default `info`)
  - `LOG_PRETTY` — `1|true` force pretty, `0|false` force JSON, `auto` (default) decide by TTY
  - `LOG_FILE` — additionally tee logs to a file (created if missing)

The CLI rendering layer (`src/cli.ts`) is the **only** module that may use `console.*` directly — those calls are user-facing chalk-styled UX, not diagnostics. A regression check (`scripts/check-no-console.sh`, wired into `npm test`) fails the build if any other source file reintroduces `console.{log,error,warn,info,debug}`.

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
- **Per-day** — UTC-day total persisted to a JSON ledger (default `~/.ai-browser-auditor/cost-ledger.json`, override via `AUDIT_COST_LEDGER_PATH`). Survives process restart and is shared across concurrent processes via last-write-wins atomic temp + rename.

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

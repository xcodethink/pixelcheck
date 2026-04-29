<p align="center">
  <h1 align="center">AI Browser Auditor</h1>
  <p align="center">
    <strong>Your AI-powered product experience reviewer. Deploys real browsers. Simulates real users. Delivers real verdicts.</strong>
  </p>
  <p align="center">
    <a href="#quick-start">Quick Start</a> &bull;
    <a href="#how-it-works">How It Works</a> &bull;
    <a href="#why-not-e2e-tests">Why Not E2E Tests</a> &bull;
    <a href="#personas">Personas</a> &bull;
    <a href="#ci-integration">CI Integration</a> &bull;
    <a href="CHANGELOG.md">Changelog</a>
  </p>
</p>

---

> **Your tests pass. Your CI is green. But what does a real user actually see?**
>
> AI Browser Auditor answers that question — automatically, after every deployment.

## The Problem

You deploy. Tests pass. CI is green. But then:

- A Japanese user opens your app and sees half-translated English strings mixed into the UI
- A user on a budget Android phone in Nigeria waits 12 seconds for your hero image to load
- Your OAuth login flow silently breaks — again — for the 6th time in 10 deployments
- The Arabic version renders left-to-right, making the entire layout unusable
- Your "Trusted" score badge shows green while the copy says "stop interacting immediately"

**No E2E test catches these.** They test whether code runs. They don't test whether the product *works* for real humans in real contexts.

## The Solution

AI Browser Auditor launches real Chromium browsers as 18 different users from 15 countries, walks through your product's core flows, and delivers a verdict — like having a senior PM, QA engineer, and UX reviewer audit every deployment, in every language, on every device class.

```bash
npx ai-audit init projects/my-app --name "My App" --url "https://myapp.com"
npx ai-audit run --project projects/my-app
```

**Output**: a structured report with per-step screenshots, video recordings, network logs, WCAG accessibility violations, and AI-scored ratings across 6 dimensions — served as JSON, HTML dashboard, or Markdown.

## How It Works

For each **(persona x scenario)** combination:

```
 1. Launch Chromium with device-accurate fingerprint
    (viewport, locale, timezone, UA, regional proxy)
                        |
 2. Execute scenario steps semantically via Stagehand 2.0
    ("click the sign-up button" not "click #btn-37")
                        |
 3. 5-Layer Reliability Stack ensures 98%+ step success
    Stability Gate -> LLM Rewrite -> Selector Discovery -> Auto Selector -> Computer Use
                        |
 4. Claude Vision Critic + axe-core score each checkpoint on 18 dimensions
    completion | localization | visual_polish | trust_signals | accessibility | ...
                        |
 5. Critical steps escalate to Computer Use for pixel-level review
                        |
 6. Generate report: JSON + HTML dashboard + Markdown + video + HAR
```

## Why Not E2E Tests?

| | Traditional E2E | AI Browser Auditor |
|---|---|---|
| **What it tests** | Code logic | Product experience |
| **Decision making** | Hardcoded selectors | AI reads the page like a human |
| **Assertion style** | `expect(text).toBe("Welcome")` | *"As a Japanese free-tier user, is this CTA clear and fully localized?"* |
| **When UI changes** | Selectors break, tests fail | Semantic instructions adapt automatically |
| **Failure output** | Stack trace | Screenshots + video + 6-dimension score + specific UX issues |
| **What it catches** | Functional bugs | i18n gaps, UX friction, visual regressions, trust issues, accessibility violations, cultural mismatches |

**AI Browser Auditor is not a replacement for E2E tests.** It's what runs *after* them — the layer between "code works" and "product is good."

## Personas

18 built-in personas covering real-world user diversity:

| Persona | Country | Language | Device | Tier |
|---|---|---|---|---|
| US college student | US | English | iPhone 14 | Free |
| Tokyo housewife | JP | Japanese | MacBook Pro | Pro |
| Berlin security analyst | DE | German | iPad Pro | Power |
| Shanghai student | CN | Chinese | Xiaomi Android | Free |
| Sao Paulo freelancer | BR | Portuguese | Desktop | Free |
| Riyadh businessman | SA | Arabic (RTL) | iPhone 15 Pro | Pro |
| Mumbai office worker | IN | Hindi | Budget Android | Free |
| Seoul designer | KR | Korean | QHD Desktop | Pro |
| Hanoi student | VN | Vietnamese | Android | Free |
| Moscow engineer | RU | Russian (Cyrillic) | Windows Desktop | Free |
| Lagos entrepreneur | NG | English | Budget Tecno | Free |
| Mexico City teacher | MX | Spanish (LATAM) | Android | Free |
| Jakarta gig worker | ID | Bahasa Indonesia | Android | Free |
| US retired teacher (72yo) | US | English | iPad | Free |
| London security analyst | UK | English | Desktop | Power |
| Paris marketing manager | FR | French | iPhone | Free |
| Bangkok student | TH | Thai | iPhone SE | Free |
| Taipei engineer | TW | Traditional Chinese | iPad | Pro |

Each persona includes a **mental model** (who they are, what they expect) and **critical concerns** (what would make them lose trust). The AI reviewer judges your product *through their eyes*.

**5 script systems**: Latin, CJK, Arabic (RTL), Cyrillic, Devanagari.

## Scenarios Are Declarative YAML

No code required. Describe what a user does, not how to click:

```yaml
id: signup-flow
name: New User Signup
priority: P0
steps:
  - id: open-home
    type: visit
    url: https://myapp.com/${persona.url_locale}

  - id: click-signup
    type: act
    instruction: Click the sign-up or get-started button

  - id: check-language
    type: assert_visual
    instruction: |
      Is all visible text in ${persona.language}?
      Flag any English strings outside of brand names.

  - id: complete-oauth
    type: act
    instruction: Sign in with Google

  - id: verify-email
    type: check_email
    subject_contains: "welcome"
    timeout: 60000

  - id: a11y-check
    type: assert_a11y
    standard: wcag2aa          # axe-core WCAG analysis
    exclude: [".cookie-banner"]

  - id: rate-onboarding
    type: assert_visual
    critical_review: true    # escalates to Computer Use
    instruction: |
      Rate the post-signup experience. Is the value proposition
      clear within 10 seconds? Is the first action obvious?
```

**12 step types**: `visit`, `act`, `extract`, `observe`, `wait_for`, `assert_visual`, `assert_dom`, `assert_a11y`, `check_email`, `screenshot`, `computer_use`, `custom`

## 5-Layer Reliability Stack

AI-driven browsers are flaky (~75% baseline). We engineered that away:

```
Layer 1: Page Stability Gate                              +10%  (zero cost)
         Wait for network idle + DOM stable + framework hydration
                            |
Layer 2: LLM Rewrite + Local Mutation                     +7%   (~$0.001/call)
         Haiku rewrites failed instructions using DOM context;
         local rules rephrase/decompose/specify as fallback
                            |
Layer 3a: Selector Hint                                   +3%   (zero cost)
          Optional CSS selector fallback (manual or YAML-defined)
                            |
Layer 3b: Auto Selector Discovery                         +3%   (zero cost)
          Stagehand observe() extracts candidate selectors automatically
                            |
Layer 4: Computer Use Fallback                            +2-4% ($0.01-0.15/call)
         Claude sees the actual pixels and operates the browser directly
         (Sonnet for non-critical steps, Opus for critical reviews)
```

Target: **98-99% step success rate** across all persona/scenario combinations.

Each step records which layer succeeded via `execution_method`, giving you a reliability breakdown per run.

## Reports

Every audit produces a full evidence package:

```
reports/2026-04-11_post-deploy/
 |-- audit.json              # Machine-readable, all scores and issues
 |-- audit.html              # Dark-theme dashboard with trend sparklines
 |-- summary.md              # Terminal-friendly overview
 |-- jp-japanese-pro-desktop__signup-flow/
      |-- 01-open_home.png          # Timestamped screenshot
      |-- 02-check_language.png     # + SHA-256 hash for each
      |-- network.har               # Full network log
      |-- console.log               # Browser console errors
      |-- video/*.webm              # Session recording
```

`audit.json` and every MCP tool response carries a top-level `schema_version` field (SemVer). The contract is documented in [docs/contracts/RESULT_SCHEMA.md](./docs/contracts/RESULT_SCHEMA.md); machine-readable JSON Schemas live in [docs/schemas/](./docs/schemas/) and can be regenerated with `npm run schemas`.

### Historical Trends

Scores are tracked in a local SQLite database. Compare any two runs:

```bash
ai-audit history                    # Recent runs with scores
ai-audit diff run_0412 run_0411     # Score deltas, new/resolved issues
```

The HTML report includes SVG sparkline charts for the last 20 runs.

### Quality Gate

Fail your CI build if the experience drops below your bar:

```bash
ai-audit run --project projects/my-app --min-score 7.5
# Exit code 1 if overall score < 7.5
```

## Quick Start

### 1. Install

```bash
npm install ai-browser-auditor
npx playwright install chromium
```

### 2. Set your API key

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Create your first audit

```bash
npx ai-audit init projects/my-app --name "My App" --url "https://myapp.com"
```

This generates a project directory with a config file and a starter scenario. Edit the scenario to match your app's flows.

### 4. Run

```bash
# Dry run — validate config, print the persona x scenario matrix
npx ai-audit run --project projects/my-app --dry-run

# Full audit
npx ai-audit run --project projects/my-app

# Debug mode — visible browser
npx ai-audit run --project projects/my-app --headed

# Single persona
npx ai-audit run --project projects/my-app --persona jp-japanese-pro-desktop
```

## CI Integration

Trigger an audit after every deployment:

```yaml
# .github/workflows/deploy.yml
audit-after-deploy:
  needs: [deploy]
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - run: npm install ai-browser-auditor && npx playwright install chromium
    - run: npx ai-audit run --project .audit --min-score 7.0
      env:
        ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    - uses: actions/upload-artifact@v4
      if: always()
      with:
        name: audit-report
        path: reports/
```

Or dispatch to a central auditor repo that audits all your projects:

```yaml
    - run: |
        gh workflow run post-deploy-audit.yml \
          --repo your-org/ai-browser-auditor \
          --field project="my-app"
      env:
        GH_TOKEN: ${{ secrets.GH_PAT }}
```

Exit codes: `0` = pass, `1` = fail, `2` = warn.

Notifications: Slack webhook and Telegram bot on completion.

## MCP Server

PixelCheck ships an MCP server that lets any Model Context Protocol client (Claude Code, Cursor, Cline, Continue, Zed agent) drive audits without leaving its workflow.

### Register with Claude Code

Add to `~/.mcp.json` (or your client's equivalent):

```json
{
  "mcpServers": {
    "ai-browser-auditor": {
      "command": "node",
      "args": ["/abs/path/to/ai-browser-auditor/dist/mcp/server.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

### Tools

| Tool | Kind | Use when |
|---|---|---|
| `audit_url` | preset | You want the full audit pipeline against one URL — agent loop, scoring, JSON + HTML report. |
| `explore_url` | preset | You want a quick autonomous run with a free-form goal; no scenario YAML needed. |
| `see` | primitive | You want to look at a URL once and get back DOM summary + screenshot + console errors + an optional natural-language note. 0 LLM cost when `goal` is omitted. |
| `act` | primitive | You want to drive an action sequence (click / fill / scroll / screenshot / natural-language `act` / vision `note`) and get back per-step status + final DOM + screenshot. |
| `extract` | primitive | You want a typed payload back from a URL — pricing tiers, feature lists, FAQ entries — shaped exactly the way you asked for. Hand the tool a JSON Schema; get back `data` matching it plus DOM / console / screenshot. |
| `list_personas` | meta | Discover which personas are installed in a project. |
| `list_scenarios` | meta | Discover which scenarios are installed in a project. |
| `calibrate_critic` | meta | Run the critic calibration gate against labeled fixtures (returns pass/fail + agreement metrics). |
| `get_last_report` | meta | Read the most recent audit's summary JSON from the local history DB. |

The N-3 `compare` primitive and M9-5 `list_capabilities` are on the v1 roadmap.

#### `see` — one-shot navigation snapshot

The lightest tool in the kit. Call it when you want to ask "what's on this page right now?" without spinning up a full audit.

```jsonc
// MCP tools/call arguments
{
  "url": "https://stripe.com/pricing",
  "goal": "Is there a free tier?",      // optional — runs one vision call, ~$0.005
  "wait_for": "networkidle",            // or "load", "domcontentloaded", or a CSS selector
  "viewport_width": 1280,
  "viewport_height": 800,
  "include_dom": true,
  "include_console": true,
  "headless": true,
  "timeout_ms": 30000
}
```

Returns a `SeeResult` (see [docs/schemas/see-result.schema.json](./docs/schemas/see-result.schema.json)) with `url_final` (post-redirect), `title`, `dom` (interactive count + headings + summary), `console.errors`, `screenshot` (path + sha256), and `note` (the goal answer when set). Artefacts land under `$AUDIT_SEES_DIR` or `~/.ai-browser-auditor/sees/<UTC-iso>-<rand6>/`. See [ADR-011](./docs/decisions/ADR-011-see-primitive.md) for design rationale.

#### `act` — execute an action sequence

Run a sequence of browser actions (deterministic + AI), get back a per-step trace, the final DOM, and a final screenshot. Engine is auto-selected: pure-deterministic step lists run on raw Playwright (~1 s cold start, no LLM key needed), Stagehand only spins up when at least one step is `{ "type": "act" }`.

```jsonc
// MCP tools/call arguments
{
  "url": "https://stripe.com/pricing",
  "steps": [
    { "type": "fill", "selector": "input[name=email]", "value": "user@example.com" },
    { "type": "click", "selector": "button[type=submit]" },
    { "type": "wait_for", "selector": ".dashboard", "state": "visible" },
    { "type": "screenshot", "label": "after-login" },
    { "type": "act", "instruction": "Click the Upgrade to Pro button" },
    { "type": "note", "goal": "Was the upgrade modal shown? Any error?" }
  ],
  "stop_on_error": true
}
```

Each step kind:

| Kind | Cost | Notes |
|---|---|---|
| `goto` | 0 | Re-navigate. Supports `wait_for` (load / domcontentloaded / networkidle / CSS selector). |
| `click` / `fill` / `press` / `wait` / `wait_for` / `scroll` | 0 | Direct Playwright. No LLM. |
| `screenshot` | 0 | Writes `<label>.png` (default `step-<index>.png`) into the per-call artefacts dir. |
| `act` | ~1 LLM call | Stagehand-resolved natural-language action. Forces the engine to Stagehand for the whole session. |
| `note` | ~$0.005 | One vision call against the current page. Works on either engine. |

Returns an `ActResult` (see [docs/schemas/act-result.schema.json](./docs/schemas/act-result.schema.json)) with `engine` (`"playwright"` | `"stagehand"`), `steps[]` (each with `status`, `duration_ms`, `cost_usd`, optional `screenshot` / `note` / `output` / `error`), final `dom` / `console` / `screenshot`, and total `cost_usd`. Failure semantics: `stop_on_error: true` (default) skips remaining steps after the first failure (recorded as `status: "skipped"`); `false` runs them all and the top-level `status` is `"error"` if any failed. Artefacts land under `$AUDIT_ACTS_DIR` or `~/.ai-browser-auditor/acts/<UTC-iso>-<rand6>/`. See [ADR-012](./docs/decisions/ADR-012-act-primitive.md) for design rationale.

#### `extract` — schema-bound structured extraction

Hand the tool a JSON Schema describing the payload you want; get back `data` matching the shape. One LLM call per invocation. Always Stagehand (extract is fundamentally LLM-driven; there is no deterministic alternative for "give me an arbitrarily-shaped object").

```jsonc
// MCP tools/call arguments
{
  "url": "https://stripe.com/pricing",
  "schema": {
    "type": "object",
    "properties": {
      "plans": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name":     { "type": "string" },
            "price":    { "type": "number", "description": "Monthly price in USD" },
            "features": { "type": "array",  "items": { "type": "string" } }
          },
          "required": ["name", "price"]
        }
      }
    },
    "required": ["plans"]
  },
  "instruction": "Extract every pricing plan card",   // optional — auto-synthesised from schema field names if omitted
  "selector": "main"                                   // optional — constrain to a sub-region
}
```

JSON Schema subset accepted (the converter rejects everything else with a precise error message naming the keyword and JSON path):

| Accepted | Rejected |
|---|---|
| `type: object \| array \| string \| number \| integer \| boolean \| null` | `oneOf`, `anyOf`, `allOf`, `not` |
| `type: ["string", "null"]` (nullable shorthand) | `$ref`, `patternProperties`, `dependencies` |
| `properties`, `required`, `items`, `enum`, `description`, `nullable` | `if` / `then` / `else`, `const` (use a single-element `enum` instead) |
| `additionalProperties` (accepted, ignored — `z.object` strips by default) | |
| `pattern`, `minLength`, `maxLength`, `minimum`, `maximum` (accepted, not enforced — the LLM does not honour them) | |

The root must be `type: "object"` because Stagehand's `extract()` requires an object schema. A bare `{ properties: {…} }` (no `type`) is accepted as object-shorthand.

Returns an `ExtractResult` (see [docs/schemas/extract-result.schema.json](./docs/schemas/extract-result.schema.json)) with `engine: "stagehand"`, `data` (matching your schema), `schema_used` / `instruction_used` / `selector_used` (echoed for client-side re-validation and debugging), `dom` / `console` / `screenshot`, and `cost_usd` derived from Stagehand's `metrics.extractPromptTokens` × `estimateCost(model, …)`. The `data.json` artefact is also persisted alongside the screenshot for replay. If a tight cost-guard cap trips during `recordUsage`, `status` flips to `"error"` but `data` and `cost_usd` are still surfaced (partial-success). Artefacts land under `$AUDIT_EXTRACTS_DIR` or `~/.ai-browser-auditor/extracts/<UTC-iso>-<rand6>/`. See [ADR-013](./docs/decisions/ADR-013-extract-primitive.md) for design rationale.

Every tool response carries a top-level `schema_version` field per [docs/contracts/RESULT_SCHEMA.md](./docs/contracts/RESULT_SCHEMA.md). Two parallel tool calls in one server process see independent run-USD cost caps (per [ADR-009](./docs/decisions/ADR-009-concurrency-safety.md)) but share the persistent daily ledger.

Adding a new tool: drop a file under `src/mcp/tools/<name>.ts` exporting a `ToolDefinition`, then push it into `ALL_TOOLS` in `src/mcp/server.ts`. See [ADR-010](./docs/decisions/ADR-010-mcp-tool-registry.md) for the registry rationale.

## Multi-Project Support

One auditor instance serves all your projects:

```
ai-browser-auditor/
 |-- personas/              # 18 shared personas (used by all projects)
 |-- projects/
      |-- my-saas/          # Project A
      |    |-- config.yaml
      |    |-- scenarios/
      |-- my-mobile-web/    # Project B
      |    |-- config.yaml
      |    |-- scenarios/
      |    |-- personas/    # Optional: project-specific persona overrides
      |-- my-docs-site/     # Project C
           |-- config.yaml
           |-- scenarios/
```

## Safety

- **Stripe live key protection** — refuses to start if `pk_live_` detected in environment
- **Credential redaction** — OAuth tokens, passwords, API keys, and webhook URLs are never written to reports OR to logs (two layers: well-known field names like `apiKey` / `password` / `token` / `cookie` are always censored, and concrete env-derived secret values are substring-replaced anywhere they appear, including inside log messages)
- **Computer Use guardrails** — Anthropic's prompt-injection classifier enabled by default
- **Budget cap** — stops spawning new audit units when cumulative API cost exceeds your threshold

## Logging

Internal events use a structured logger (pino). Output goes to **stderr**, so stdout stays clean for CLI results and the MCP stdio protocol. By default the format is human-readable when stderr is a TTY and JSON otherwise.

| Env var | Values | Default | Effect |
|---|---|---|---|
| `LOG_LEVEL` | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent` | `info` | Minimum log level |
| `LOG_PRETTY` | `1`, `true`, `0`, `false`, `auto` | `auto` | Force pretty-print or JSON; `auto` decides by TTY |
| `LOG_FILE` | `/path/to.log` | unset | Additionally tee logs to a file |

Examples:

```sh
# CI / piped: JSON to stderr automatically (no TTY)
ai-audit run --project projects/my-app 2> audit.log

# Force JSON even in a terminal
LOG_PRETTY=0 ai-audit run --project projects/my-app

# Verbose debugging
LOG_LEVEL=debug ai-audit run --project projects/my-app
```

## Cost Guard

A process-wide spend cap protects against runaway LLM bills. Every Anthropic API call is tracked against two limits:

- **Per-run** — single audit / MCP tool invocation. Reset at run start.
- **Per-day** — UTC-day total persisted across processes in a JSON ledger (default `~/.ai-browser-auditor/cost-ledger.json`, override via `AUDIT_COST_LEDGER_PATH`).

Exceeding any cap throws `BudgetExceededError` so the calling loop stops immediately. The ledger auto-prunes entries older than 30 days.

| Env var | Default | Effect |
|---|---|---|
| `AUDIT_COST_MAX_RUN_USD` | `5` | Max USD per audit run / MCP tool call |
| `AUDIT_COST_MAX_RUN_TOKENS` | `10000000` | Max input+output tokens per run |
| `AUDIT_COST_MAX_DAILY_USD` | `50` | Max USD per UTC day across all runs |
| `AUDIT_COST_MAX_DAILY_TOKENS` | `100000000` | Max input+output tokens per UTC day |
| `AUDIT_COST_LEDGER_PATH` | `~/.ai-browser-auditor/cost-ledger.json` | Path to the persistent daily ledger |
| `AUDIT_COST_GUARD_DISABLED` | unset | `1` / `true` to bypass entirely (CI / tests) |

The cost guard layers over (and is independent of) the runner's `budget_usd` cap, which only stops the runner from scheduling new units. The cost guard catches direct MCP tool calls, computer-use loops, and instruction mutations that the unit scheduler doesn't see.

Inspect the current state via the snapshot included in the `run started` log line, or:

```sh
LOG_LEVEL=debug ai-audit run --project projects/my-app
# emits one "llm usage recorded" debug line per Anthropic call with running totals
```

## Concurrency Safety

PixelCheck is safe to run from multiple processes at once — two parallel `ai-audit` terminals, an MCP server fielding two `audit_url` calls in parallel, or a CLI run alongside an MCP-served call. Specifically:

- **Cost ledger** (`cost-ledger.json`): protected by a cross-process advisory lockfile (`<ledger>.lock`). Concurrent recorders never lose updates.
- **Per-run cost counters**: each MCP tool dispatch and each `runAudit` call gets its own `AsyncLocalStorage` scope, so two parallel calls have independent run-USD caps. The persistent daily ledger is still shared.
- **Memory DB** (`memory.db`): `record(fact)` uses one atomic `INSERT … ON CONFLICT DO UPDATE`. No SELECT-then-write race.
- **Visual diff baselines**: first-run bootstrap copies to a `.tmp` path then `linkSync`s into place. Two parallel first-runs both succeed; the first writer wins.

If a process crashes while holding the cost-ledger lock, the lock auto-recovers after 30 seconds (or sooner if the holder pid is no longer alive). See [ADR-009](docs/decisions/ADR-009-concurrency-safety.md) for design.

## Built With

- [Playwright](https://playwright.dev/) — browser automation
- [Stagehand 2.0](https://github.com/browserbase/stagehand) — AI-driven semantic browser control
- [Claude](https://anthropic.com/claude) (Vision + Computer Use) — visual evaluation and pixel-level review
- [axe-core](https://github.com/dequelabs/axe-core) — WCAG accessibility auditing
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — local audit history and trend tracking

## How Is This Different?

The open-source landscape has excellent **browser automation frameworks** (browser-use 87K stars, Stagehand 22K, Skyvern 21K) and mature **accessibility rule engines** (axe-core 7K, pa11y 4.4K). But none of them answer the question *"is this product experience good?"*

| | Automation Frameworks | Rule-Based Auditors | **AI Browser Auditor** |
|---|---|---|---|
| **Question answered** | "How do I control a browser?" | "Does this pass WCAG 2.x?" | "Is this product good for a real user?" |
| **Intelligence** | LLM-driven actions | Static rules | LLM vision + rules + Computer Use |
| **User simulation** | Single anonymous session | None | 18 personas across 15 countries |
| **Anti-detection** | None | N/A | 9 fingerprints + 15 stealth patches |
| **Output** | Action results | Pass/fail checklist | 18-dimension scores + video + HAR + issues |
| **History** | None | None | SQLite trends + run-to-run diff |

No existing open-source project combines multi-persona simulation, AI vision scoring, WCAG analysis, stealth fingerprints, and historical trend tracking. This is the first tool designed specifically for **post-deployment product quality auditing**.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Areas where help is especially appreciated:
- New personas for underrepresented regions/demographics
- Scenario templates for common app patterns (e-commerce checkout, onboarding, dashboards)
- Report format improvements
- Cost optimization strategies

## License

MIT

---

<p align="center">
  <strong>E2E tests verify your code works. AI Browser Auditor verifies your product works.</strong>
  <br/>
  <a href="#quick-start">Get started in 2 minutes</a>
</p>

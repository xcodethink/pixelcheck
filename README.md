<h1 align="center">PixelCheck</h1>

<p align="center">
  <strong>Real eyes and hands for the AI agent that's writing your frontend.</strong>
</p>

<p align="center">
  Drop-in MCP server. Five browser primitives. Eighteen personas across fifteen countries.<br/>
  Local-first &middot; Vendor-agnostic &middot; MIT-licensed &middot; Yours to own.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pixelcheck"><img alt="npm" src="https://img.shields.io/npm/v/pixelcheck?color=cb3837&label=npm&logo=npm&logoColor=white"></a>
  <a href="https://www.npmjs.com/package/pixelcheck"><img alt="npm downloads" src="https://img.shields.io/npm/dm/pixelcheck?color=cb3837&logo=npm&logoColor=white"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/xcodethink/pixelcheck?color=3da639"></a>
  <a href="https://modelcontextprotocol.io"><img alt="MCP" src="https://img.shields.io/badge/MCP-compatible-4f46e5"></a>
  <a href="https://github.com/xcodethink/pixelcheck/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/xcodethink/pixelcheck/ci.yml?branch=main&label=CI&logo=github"></a>
  <img alt="node" src="https://img.shields.io/node/v/pixelcheck?color=339933&logo=node.js&logoColor=white">
  <img alt="typescript" src="https://img.shields.io/github/languages/top/xcodethink/pixelcheck?color=3178c6&logo=typescript&logoColor=white">
  <a href="https://github.com/xcodethink/pixelcheck/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/xcodethink/pixelcheck?color=3178c6&logo=github"></a>
  <a href="https://github.com/xcodethink/pixelcheck/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/xcodethink/pixelcheck?style=flat&color=ffd700"></a>
</p>

<p align="center">
  <a href="#quick-start"><b>Quick Start →</b></a>
  &nbsp;&middot;&nbsp;
  <a href="#primitives">Primitives</a>
  &nbsp;&middot;&nbsp;
  <a href="#mcp-server">MCP Server</a>
  &nbsp;&middot;&nbsp;
  <a href="#audit-preset">Audit Preset</a>
  &nbsp;&middot;&nbsp;
  <a href="#why-not-e2e-tests">Why Not E2E</a>
  &nbsp;&middot;&nbsp;
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

> **If PixelCheck helps you, [give it a star](https://github.com/xcodethink/pixelcheck/stargazers) — it helps others discover the project.**

---

## Right now, you're a screenshotting middleman.

Your AI agent is writing 80% of your frontend. It's fast. It's good at code. But it's blind.

- **It writes a button.** You open Chrome to check it rendered right. Paste a screenshot back. Ask for the fix.
- **It tweaks the OAuth flow.** You log in to verify it didn't silently break. Again. Sixth time this month.
- **It updates the Japanese strings.** A user emails: "half the page is in English." You didn't catch it.
- **It rewrites checkout.** You walk through it on iPhone, Android, iPad just to *feel* whether step 3 is confusing.
- **It changes the Arabic layout.** RTL didn't propagate. You don't notice for two days.

You become the bridge. The agent has thoughts. You have a browser. **The two never meet.** Hours of your week, every week, indefinitely.

<a id="primitives"></a>

## PixelCheck is the bridge.

A single MCP server. Five primitives. Drop it in once — your agent has eyes and hands.

```
see(url, opts)              snapshot a page (DOM + screenshot + console + network)
act(url, steps)             execute an action sequence (semantic + selector + Computer Use)
extract(url, schema)        pull structured data matching a Zod / JSON schema
judge(url, rubric)          score a page against a rubric ("is this dark-pattern free?")
compare(a, b, criteria)     A/B comparison of two URLs (incl. blind mode)
```

Now your agent navigates. Sees rendered HTML. Reads console errors. Clicks. Fills. Judges. Compares. **Without ever leaving its workflow** — drop into Claude Desktop, Cursor, Cline, Continue, Zed, or Claude Code via four lines in `~/.mcp.json`.

```bash
npm install -g pixelcheck        # browser binary auto-installs on install
pixelcheck doctor                # verify environment (--fix self-heals)
pixelcheck-mcp                   # MCP server (stdio transport)
```

```jsonc
// ~/.mcp.json
{
  "mcpServers": {
    "pixelcheck": {
      "command": "pixelcheck-mcp",
      "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
    }
  }
}
```

Restart your client. Your agent has eyes.

## Three promises that aren't going anywhere.

**Local-first.** PixelCheck runs entirely on your machine. The only outbound network destination is the LLM provider your agent already uses. Screenshots, DOMs, business flows, OAuth tokens, customer URLs — they stay yours. Zero telemetry. Zero remote storage. Zero SaaS sign-up. The audit data hits Anthropic only when the vision critic actively scores a screenshot, and you opt in once on first run.

**Vendor-agnostic.** Works with Claude today; multi-provider abstraction (OpenAI, Gemini, Ollama-local) is on the v1.x Wave 2 roadmap and your agent will switch with one config flag. The reason is simple: AI tools that lock you to a single LLM provider die in 2026. PixelCheck is the antidote.

**Yours to own.** MIT license. Source-available. No paid tier. No "Pro" upgrade path. No commercial fork waiting in the wings. The 1858-test, 29-ADR, 30-published-schema product in this repo *is* the entire product. There's no premium edition behind a sign-up wall — never was, never will be.

---

<a id="audit-preset"></a>

## The Audit Preset — when *you* want to be the user, not the bridge

The five primitives compose into something more powerful when you're the operator: PixelCheck bundles an **18-persona / 15-country audit preset** on top of the primitives — a CLI-first composition that runs "eighteen real users review your product" after every deployment.

You deploy. Tests pass. CI is green. But then:

- A Japanese user opens your app and sees half-translated English strings mixed into the UI
- A user on a budget Android phone in Nigeria waits 12 seconds for your hero image to load
- Your OAuth login flow silently breaks — again — for the 6th time in 10 deployments
- The Arabic version renders left-to-right, making the entire layout unusable
- Your "Trusted" score badge shows green while the copy says "stop interacting immediately"

**No E2E test catches these.** They test whether code runs. They don't test whether the product *works* for real humans in real contexts.

The audit preset launches real Chromium browsers as 18 different users from 17 countries, walks through your product's core flows, and delivers a verdict — like having a senior PM, QA engineer, and UX reviewer audit every deployment, in every language, on every device class.

```bash
pixelcheck init projects/my-app --name "My App" --url "https://myapp.com"
pixelcheck run --project projects/my-app
```

**Output**: a structured report with per-step screenshots, video recordings, network logs, WCAG accessibility violations, and AI-scored ratings across 6 dimensions — served as JSON, HTML dashboard, or Markdown.

## How It Works

For each **(persona x scenario)** combination:

```
 1. Launch Chromium with device-accurate fingerprint
    (viewport, locale, timezone, UA, regional proxy)
                        |
 2. Execute scenario steps semantically via Stagehand 3.x
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

| | Traditional E2E | PixelCheck (audit preset) |
|---|---|---|
| **What it tests** | Code logic | Product experience |
| **Decision making** | Hardcoded selectors | AI reads the page like a human |
| **Assertion style** | `expect(text).toBe("Welcome")` | *"As a Japanese free-tier user, is this CTA clear and fully localized?"* |
| **When UI changes** | Selectors break, tests fail | Semantic instructions adapt automatically |
| **Failure output** | Stack trace | Screenshots + video + 6-dimension score + specific UX issues |
| **What it catches** | Functional bugs | i18n gaps, UX friction, visual regressions, trust issues, accessibility violations, cultural mismatches |

**PixelCheck's audit preset is not a replacement for E2E tests.** It's what runs *after* them — the layer between "code works" and "product is good."

## Compared to existing tools

| | **PixelCheck** | Playwright | Cypress | Stagehand | Browserbase |
|---|---|---|---|---|---|
| **MCP server out of the box** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Browser primitives an AI agent can call** | 5 (see / act / extract / judge / compare) | n/a (low-level page API) | n/a | 3 (act / extract / observe) | n/a |
| **AI vision (judge / critique)** | ✅ via Anthropic | ❌ | ❌ | ❌ (action-only) | ❌ |
| **Built-in personas** | 18 across 15 countries | ❌ | ❌ | ❌ | ❌ |
| **Localised report (5 languages)** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **WCAG 2.x audit + SARIF export** | ✅ (axe-core + GitHub Code Scanning ready) | manual via plugins | manual via plugins | ❌ | ❌ |
| **Local-first by default** | ✅ (your machine, your API key) | ✅ | ✅ | ✅ (or Browserbase) | ❌ (cloud-only) |
| **Vendor lock-in** | none (MIT, no SaaS) | none | none | optional Browserbase | full (paid SaaS) |
| **LLM provider** | swap any (Anthropic default; primitives are vendor-agnostic) | n/a | n/a | swap any | n/a |
| **Open source** | ✅ MIT | ✅ Apache 2.0 | ✅ MIT | ✅ MIT | partial |

**TL;DR**: Playwright / Cypress are deterministic browser drivers — you tell them exactly what to click. Stagehand wraps Playwright with natural-language `act` / `extract` so an agent can drive a browser. PixelCheck is the next layer up: an MCP-shaped surface that gives any AI agent vision (`see` / `judge` / `compare`) on top of action (`act` / `extract`), with audit presets composed across personas. Use Playwright for unit-style tests; use Stagehand if you only need an agent to fill forms; use PixelCheck when the agent needs to *evaluate* a UI, not just operate it.

## Personas

18 built-in personas covering real-world user diversity. The **Subscriber Tier** column is the persona's subscription level *in the SaaS you're auditing* (Free user / Pro subscriber / Power-user / enterprise) — used so PixelCheck can audit your product's tiered features (paywalls, upsells, gated UI, Pro-only flows). **PixelCheck itself is MIT-licensed and 100% free with no paid tier or commercial fork.**

| Persona | Country | Language | Device | Subscriber Tier (in your app) |
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

**6 script systems**: Latin, CJK, Arabic (RTL), Cyrillic, Devanagari, Thai.

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
 |-- audit-explorer.html     # Filterable SPA view of every (scenario × persona) — open with ?lang=zh-CN/ja/es/de for localised UI chrome
 |-- audit.pdf               # Stakeholder-facing summary (A4, 12pt, vector text)
 |-- summary.md              # Terminal-friendly overview
 |-- jp-japanese-pro-desktop__signup-flow/
      |-- 01-open_home.png          # Timestamped screenshot
      |-- 02-check_language.png     # + SHA-256 hash for each
      |-- network.har               # Full network log
      |-- console.log               # Browser console errors
      |-- video/*.webm              # Session recording
```

`audit.json` and every MCP tool response carries a top-level `schema_version` field (SemVer). The contract is documented in [docs/contracts/RESULT_SCHEMA.md](./docs/contracts/RESULT_SCHEMA.md); machine-readable JSON Schemas live in [docs/schemas/](./docs/schemas/) and can be regenerated with `npm run schemas`.

### WCAG compliance reporting

The `assert_a11y` scenario step runs [axe-core](https://github.com/dequelabs/axe-core) to detect accessibility violations. As of v1, every violation carries structured WCAG attribution that flows through to all stakeholder reports:

- **PDF report** — a "WCAG Compliance Summary" section grouped by conformance level (A / AA / AAA), by the four WCAG principles (Perceivable / Operable / Understandable / Robust), and a top-violated-criteria table with deep links to the W3C Understanding documents.
- **SARIF (GitHub Code Scanning / GitLab SAST)** — per-criterion ruleIds like `wcag/1-4-3`, `wcag/2-1-1`. Filter by W3C clause directly in the Security tab. Each rule's detail panel shows "WCAG 1.4.3 Contrast (Minimum) (Level AA)" with a link to the W3C spec.
- **audit.json** — every accessibility issue gets `wcag_level` and `wcag_criterion` fields alongside the existing `description` / `recommendation`.

Catalog covers WCAG 2.1 (the production-deployed standard) plus the 9 net-new success criteria added in WCAG 2.2 (e.g. 2.4.11 Focus Not Obscured, 2.5.8 Target Size). Compliance teams reading reports in zh-CN / ja / es / de see the section headings translated; SC names and id numbers (1.4.3, 2.1.1) stay canonical for compliance-document consistency.

Use case — answering an RFP that asks "Are you WCAG 2.1 AA compliant?":

```bash
pixelcheck run --project myapp                                    # writes audit.pdf + audit.sarif
# Open audit.pdf → "WCAG Compliance Summary" section shows A / AA / AAA counts
# Or upload audit.sarif via github/codeql-action/upload-sarif → grouped under wcag/* ruleIds
```

See [ADR-024](docs/decisions/ADR-024-wcag-clause-grouping.md) for the full design.

### Localised reports

Stakeholder reports (PDF / trends dashboard / PR diff Markdown / PR diff HTML) emit in the language of your audience. v1 supports 5 locales:

| Code | Language | Used for |
|---|---|---|
| `en` | English (default) | Baseline |
| `zh-CN` | Simplified Chinese | China-market teams |
| `ja` | Japanese | Japan-market product orgs |
| `es` | Spanish | Spain + Latin America |
| `de` | German | DACH-region enterprises |

```bash
pixelcheck run --project myapp --locale ja          # Japanese PDF + reports
pixelcheck trends --project myapp --locale zh-CN     # Chinese trends dashboard
pixelcheck diff <a> <b> --format markdown --locale es  # Spanish PR comment
```

Or pin a default in `config.yaml`:
```yaml
project_name: myapp
base_url: https://myapp.com
default_locale: ja    # any audit run on this project defaults to ja
```

What's translated: report skeleton — section titles, table headers, status / severity badges, disclaimer prose. What's NOT translated: PixelCheck's findings themselves (those come from the LLM in whatever language you asked Claude for) and numeric values / dates / run IDs. See [ADR-023](docs/decisions/ADR-023-report-localisation.md) for the full design.

**Translations reviewed by**: machine-assisted draft pending native-speaker review. We track reviewer credits publicly — see [docs/translation-review-template.md](docs/translation-review-template.md) and the [translation-review issue template](.github/ISSUE_TEMPLATE/translation-review.yml). Confirmed reviewers will be listed below as the v1.x review pass completes.

| Locale | Reviewer | Date | Corrections applied |
|---|---|---|---|
| `en` | (source — no review needed) | — | — |
| `zh-CN` | _pending_ | _pending_ | _pending_ |
| `ja` | _pending_ | _pending_ | _pending_ |
| `es` | _pending_ | _pending_ | _pending_ |
| `de` | _pending_ | _pending_ | _pending_ |

### PDF report (audit.pdf)

A 4-section A4 portrait PDF aimed at the layer of decision-makers above engineering — PMs, executives, customers, sales / CS reps. The format every email client renders inline, every slide deck embeds, every phone opens.

| Section | Contents |
|---|---|
| Cover | Project + URL + run date + colour-coded overall score (green ≥ 8, amber 5–8, red < 5) + 7-counter summary card |
| Top findings | Severity-sorted (critical → high → medium → low), capped at 5; each cites scenario × persona context + recommendation |
| Scenario results | One block per (scenario × persona): status badge, score + cost, per-dimension table, all issues |
| Methodology | How the audit works, persona list, scenario list, calibration disclaimer, run id for archival |

Vector text (selectable / searchable / accessible) — not a screenshot of HTML. No screenshots embedded so the file stays under ~1 MB and emailable; for visual evidence, the recipient opens `audit-explorer.html` (cited in the methodology disclaimer).

Default: ON every run. Pass `--no-pdf` to skip during fast local iteration. See [ADR-020](docs/decisions/ADR-020-pdf-stakeholder-report.md) for the full design.

### Historical Trends

Scores are tracked in a local SQLite database. Three ways to look at history:

```bash
pixelcheck history                    # Terminal table of recent runs with scores
pixelcheck diff run_0412 run_0411     # Score deltas, new/resolved issues
pixelcheck trends                     # Full HTML dashboard with 5 charts (writes <reports>/trends.html)
```

`pixelcheck trends` reads `<reports>/history.db` and writes a standalone HTML dashboard answering "did our UX get better or worse?" Five inline-SVG charts (no Chart.js / external CDN — opens behind any firewall, emails / prints / archives cleanly):

| Chart | Answer it gives |
|---|---|
| Overall score line | Trending up or down? |
| Pass / Warn / Fail stacked bars | Consistent or flaky? |
| Issues over time (total + critical) | Where are the regression hot spots? |
| Cost over time | Is efficiency drifting? |
| Per-dimension multi-line | Which scoring dimension is the cause? |

Plus six summary cards at the top (latest score, mean last 7, mean last 30, total cost, total issues, total critical issues) and a recent-runs table for navigation. See [ADR-021](docs/decisions/ADR-021-trends-dashboard.md) for the full design.

```bash
pixelcheck trends --project myapp -n 90 --dashboard reports/trends.html
```

The per-run `audit.html` also includes inline sparkline charts for at-a-glance trends within that single report.

### Quality Gate

Fail your CI build if the experience drops below your bar:

```bash
pixelcheck run --project projects/my-app --min-score 7.5
# Exit code 1 if overall score < 7.5
```

## Quick Start

### 1. Install

```bash
npm install pixelcheck
```

The browser binary pixelcheck needs (Chrome Headless Shell) is fetched
automatically by a `postinstall` step. If that was skipped — CI,
`--ignore-scripts`, an offline box, or `PIXELCHECK_SKIP_BROWSER_DOWNLOAD=1` —
fetch it on demand with:

```bash
npx pixelcheck install            # headless audits (default)
npx pixelcheck install --headed   # also fetch full Chromium for --headed runs
```

You never need a bare `npx playwright install` — pixelcheck installs the exact
browser revision it launches (a bare install can pull a mismatched revision).
A missing browser also self-heals on the first `run`/`explore`, and
`pixelcheck doctor --fix` downloads it directly.

> For corporate proxy / Alpine Linux / Docker / air-gapped environments,
> see [docs/INSTALLATION.md](docs/INSTALLATION.md).

### 2. Verify your environment

```bash
npx pixelcheck doctor
```

Reports Node version, API key, config / scenarios / personas, network
proxy, and api.anthropic.com reachability. Exits 0 when ready, 1 when
any check fails — useful in CI scripts to fail-fast before running an audit.

Add `--verbose` for diagnostic detail, `--skip-network` for offline /
air-gapped environments.

### 3. Set up a project (interactive or scripted)

**Interactive wizard** (recommended for first-time users):

```bash
npx pixelcheck init
# Walks you through project name, base URL, sample scenario, and runs
# `doctor` at the end to confirm setup.
```

**Non-interactive** (CI / scripted):

```bash
npx pixelcheck init my-project --name acme-shop --url https://acme.example.com
```

Either path scaffolds:
- `config.yaml` (project name + base URL + model defaults + budget)
- `scenarios/00-smoke.yaml` (starter visual + a11y check)

### 4. Set your API key

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Get a key at [console.anthropic.com](https://console.anthropic.com).
The wizard above tells you when this is missing; `pixelcheck doctor`
re-checks it any time.

### 5. Create your first audit

```bash
npx pixelcheck init projects/my-app --name "My App" --url "https://myapp.com"
```

This generates a project directory with a config file and a starter scenario. Edit the scenario to match your app's flows.

### 6. Run

```bash
# Dry run — validate config, print the persona x scenario matrix
npx pixelcheck run --project projects/my-app --dry-run

# Full audit
npx pixelcheck run --project projects/my-app

# Debug mode — visible browser
npx pixelcheck run --project projects/my-app --headed

# Single persona
npx pixelcheck run --project projects/my-app --persona jp-japanese-pro-desktop
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
    # CI sets CI=true, which skips the auto browser-download; fetch it explicitly.
    - run: npm install pixelcheck && npx pixelcheck install
    - run: npx pixelcheck run --project .audit --min-score 7.0
      env:
        ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    - uses: actions/upload-artifact@v4
      if: always()
      with:
        name: audit-report
        path: reports/
```

Or dispatch to a central PixelCheck repo that audits all your projects:

```yaml
    - run: |
        gh workflow run post-deploy-audit.yml \
          --repo your-org/pixelcheck \
          --field project="my-app"
      env:
        GH_TOKEN: ${{ secrets.GH_PAT }}
```

Exit codes: `0` = pass, `1` = fail, `2` = warn.

### CI output formats

When PixelCheck detects a CI environment (`CI=true`, `GITHUB_ACTIONS=true`, `GITLAB_CI=true`, `CIRCLECI=true`, `TF_BUILD=True`, or `JENKINS_URL`), it automatically emits four standard formats alongside `audit.json`/`audit.html`:

| File | Format | Consumed by |
|---|---|---|
| `junit.xml` | JUnit XML | Jenkins, GitLab CI, Azure DevOps, CircleCI |
| `audit.sarif` | SARIF 2.1.0 | GitHub Code Scanning, GitLab SAST |
| `audit.jsonl` | JSON Lines (one record per line) | jq, log aggregators, custom dashboards |
| `github-annotations.txt` | GHA workflow commands | GitHub Actions inline PR annotations |

Inside GitHub Actions the workflow-command lines are also streamed to stderr so issues attach inline to PR diffs without a separate annotation step.

Override behaviour explicitly:
- `--ci-format auto` — default; emit all 4 in CI, none on developer laptop
- `--ci-format all` — force-emit all 4 regardless of environment
- `--ci-format none` — skip CI formats
- `--ci-format junit,sarif` — comma-separated subset

Severity mapping: `critical`/`high` → SARIF `error` / GHA `error`; `medium` → `warning`/`warning`; `low` → `note`/`notice`. See [ADR-019](docs/decisions/ADR-019-ci-friendly-output-formats.md) for the full design.

Example — upload SARIF to GitHub Code Scanning:

```yaml
- run: npx pixelcheck run --project .audit
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: reports/<run-id>/audit.sarif
```

### PR diff report

Posting a "did this PR make UX better or worse?" summary as a PR comment is two commands:

```yaml
# Audit main → audit PR → diff → post
- run: pixelcheck run --tag main && pixelcheck run --tag pr
- run: pixelcheck diff <MAIN_RUN_ID> <PR_RUN_ID> --format markdown --output diff.md
- uses: marocchino/sticky-pull-request-comment@v2
  with: { path: diff.md }
```

The Markdown contains:
- A headline metrics table (overall score / issues / critical issues / cost / duration) with ▲ / ▼ polarity arrows
- Per-dimension changes (sorted by absolute delta magnitude)
- 🆕 New issues raised by this PR (with severity tags + recommendations)
- ✅ Resolved issues fixed by this PR
- A "no meaningful UX changes" message when both lists are empty

Other output formats: `--format html` for email / Slack, `--format json` for downstream charting, `--format text` (default) for terminal. Use `--output <path>` to write directly to a file (extension auto-detects format) or omit to print to stdout. See [ADR-022](docs/decisions/ADR-022-pr-diff-report.md) for the full design.

Notifications: Slack webhook and Telegram bot on completion.

## MCP Server

PixelCheck ships an MCP server that lets any Model Context Protocol client (Claude Code, Cursor, Cline, Continue, Zed agent) drive audits without leaving its workflow.

### Register with Claude Code

Add to `~/.mcp.json` (or your client's equivalent):

```json
{
  "mcpServers": {
    "pixelcheck": {
      "command": "pixelcheck-mcp",
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
| `judge` | primitive | You want a rubric-driven critique of one URL — aesthetic polish, dark-pattern risk, or any custom rubric. Returns per-criterion scores (0..10) + severity-graded findings with on-screen locations. 1 vision call. |
| `compare` | primitive | You want an A/B comparison of two URLs against the same rubric. Default `double_blind` mode judges each side independently then synthesises a comparison (3 vision calls, free of anchoring bias). `fast` mode is 1 call (cheaper, anchored). |
| `list_personas` | meta | Discover which personas are installed in a project. |
| `list_scenarios` | meta | Discover which scenarios are installed in a project. |
| `list_capabilities` | meta | Self-describe the server: every shipped tool with kind / cacheability / static cost band / side-effects / dependency declarations, plus the public env-var table and live result-cache state. Pure introspection — call it once on first connect to plan the rest of your session. |
| `calibrate_critic` | meta | Run the critic calibration gate against labeled fixtures (returns pass/fail + agreement metrics). |
| `get_last_report` | meta | Read the most recent audit's summary JSON from the local history DB. |

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

Returns a `SeeResult` (see [docs/schemas/see-result.schema.json](./docs/schemas/see-result.schema.json)) with `url_final` (post-redirect), `title`, `dom` (interactive count + headings + summary), `console.errors`, `screenshot` (path + sha256), and `note` (the goal answer when set). Artefacts land under `$AUDIT_SEES_DIR` or `~/.pixelcheck/sees/<UTC-iso>-<rand6>/`. See [ADR-011](./docs/decisions/ADR-011-see-primitive.md) for design rationale.

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

Returns an `ActResult` (see [docs/schemas/act-result.schema.json](./docs/schemas/act-result.schema.json)) with `engine` (`"playwright"` | `"stagehand"`), `steps[]` (each with `status`, `duration_ms`, `cost_usd`, optional `screenshot` / `note` / `output` / `error`), final `dom` / `console` / `screenshot`, and total `cost_usd`. Failure semantics: `stop_on_error: true` (default) skips remaining steps after the first failure (recorded as `status: "skipped"`); `false` runs them all and the top-level `status` is `"error"` if any failed. Artefacts land under `$AUDIT_ACTS_DIR` or `~/.pixelcheck/acts/<UTC-iso>-<rand6>/`. See [ADR-012](./docs/decisions/ADR-012-act-primitive.md) for design rationale.

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

Returns an `ExtractResult` (see [docs/schemas/extract-result.schema.json](./docs/schemas/extract-result.schema.json)) with `engine: "stagehand"`, `data` (matching your schema), `schema_used` / `instruction_used` / `selector_used` (echoed for client-side re-validation and debugging), `dom` / `console` / `screenshot`, and `cost_usd` derived from Stagehand's `metrics.extractPromptTokens` × `estimateCost(model, …)`. The `data.json` artefact is also persisted alongside the screenshot for replay. If a tight cost-guard cap trips during `recordUsage`, `status` flips to `"error"` but `data` and `cost_usd` are still surfaced (partial-success). Artefacts land under `$AUDIT_EXTRACTS_DIR` or `~/.pixelcheck/extracts/<UTC-iso>-<rand6>/`. See [ADR-013](./docs/decisions/ADR-013-extract-primitive.md) for design rationale.

#### `judge` — rubric-driven page critic

Score one URL against a rubric — aesthetic polish, dark-pattern risk, or any custom criteria you supply. One vision call per invocation. Built-in rubrics are reified data in `src/core/critics/`; the criterion ids are part of the public contract so consumers can join verdicts back to the rubric across runs.

```jsonc
// MCP tools/call arguments
{
  "url": "https://stripe.com/pricing",
  "rubrics": ["aesthetic", "dark_pattern"],          // 8 + 12 built-in criteria
  "custom_criteria": [                                // optional one-off rubric
    { "id": "pricing_clarity", "label": "Pricing clarity", "description": "Is total cost visible without scrolling?" }
  ],
  "persona": "us-power-user-desktop",                  // optional — drives viewport/locale via personas/
  "wait_for": "networkidle"
}
```

Built-in rubrics:

| Rubric | Criteria | Examples |
|---|---|---|
| `aesthetic` (8) | `visual_hierarchy`, `typography`, `alignment_grid`, `color_contrast`, `spacing_rhythm`, `polish`, `information_density`, `brand_cohesion` | Benchmarked against Stripe / Linear / Vercel / Notion |
| `dark_pattern` (12) | `forced_continuity`, `hidden_costs`, `preselected_options`, `fake_urgency`, `confirmshaming`, `obstruction`, `misdirection`, `trick_questions`, `disguised_ads`, `bait_and_switch`, `privacy_zuckering`, `nagging` | Brignull taxonomy + Norwegian Consumer Council 2018 |
| `custom` | Caller-supplied | Any one-off rubric — pricing clarity, conversion path, accessibility narrative, … |

Score direction is uniform: **higher = better**, regardless of kind. Aesthetic 10 = excellent; dark-pattern 10 = no dark pattern detected. So `overall_score` (mean of all verdict scores) is monotonic across mixed rubrics.

Returns a `JudgeResult` (see [docs/schemas/judge-result.schema.json](./docs/schemas/judge-result.schema.json)) with `rubrics`, `criteria` (the full rubric list rendered into the prompt), `verdicts[]` (per-criterion `{ criterion_id, score, rationale, evidence }`), `findings[]` (severity-graded issues with `location`), `overall_score`, `summary`, plus the standard `dom` / `console` / `screenshot` / `cost_usd` envelope. Artefacts land under `$AUDIT_JUDGES_DIR` or `~/.pixelcheck/judges/<UTC-iso>-<rand6>/judge.json`. See [ADR-014](./docs/decisions/ADR-014-judge-and-compare-primitives.md) for design rationale.

#### `compare` — A/B page comparison

Run an A/B comparison of two pages against a shared rubric. Default mode is **`double_blind`**: judge each side independently (parallel) with the same rubric, then run ONE synthesis vision call that sees both screenshots side-by-side with the prior judgements as context. Three vision calls total; wall-clock ≈ two calls because the judges run in parallel. This mirrors commercial UX-review practice — Nielsen Norman, Baymard Institute — where each candidate is evaluated independently before the comparison synthesis. The reason is anchoring bias: when a model is asked to score two pages in one prompt, absolute scores get pulled toward the difference between them, not the page itself.

`fast` mode collapses to a single side-by-side vision call — cheaper (~3× cheaper) but anchored. Opt in for batch comparisons (e.g. evaluating 100 competitors overnight) where the cost ratio matters more than per-call accuracy.

```jsonc
// MCP tools/call arguments
{
  "a": { "url": "https://stripe.com/pricing" },
  "b": { "url": "https://intercom.com/pricing", "viewport_width": 375, "viewport_height": 812 },
  "rubrics": ["aesthetic", "dark_pattern"],
  "mode": "double_blind"                                // default; use "fast" for cheap batches
}
```

Per-side `viewport` lets you compare e.g. desktop A vs mobile B. Either side may be a pre-captured snapshot from a prior `see` / `extract` / `judge` call (`{ "capture": { ... } }`); the tool will skip the browser for that side.

Returns a `CompareResult` (see [docs/schemas/compare-result.schema.json](./docs/schemas/compare-result.schema.json)) with `mode`, `rubrics`, `criteria`, `side_a` / `side_b` (each carrying the embedded JudgeResult in double_blind mode + per-side screenshot + artefacts dir), `per_criterion[]` (`{ criterion_id, score_a, score_b, winner: "a"|"b"|"tie", rationale }`), `overall_winner`, `summary`, and total `cost_usd`. Artefacts land under `$AUDIT_COMPARES_DIR` or `~/.pixelcheck/compares/<UTC-iso>-<rand6>/` with `a/` and `b/` subdirs and a `compare.json` sidecar.

#### `list_capabilities` — self-describe (M9-5)

Call once on first connect to get a structured map of the whole server: every tool with its kind, input schema, result schema title, **cacheability**, **static cost-estimate band**, **side-effects**, and **dependency declarations**; plus the public env-var table and live state of the M9-4 result cache.

```jsonc
// MCP tools/call arguments — none required
{}
```

Returns a `ListCapabilitiesResult` (see [docs/schemas/list-capabilities-result.schema.json](./docs/schemas/list-capabilities-result.schema.json)):

```jsonc
{
  "schema_version": "1.2.0",
  "server": { "name": "pixelcheck", "version": "0.3.0" },
  "result_schema_version": "1.2.0",
  "tools": [
    {
      "name": "judge",
      "kind": "primitive",
      "result_schema": "JudgeResult",
      "cacheable": true,
      "cost_estimate_usd": { "typical": 0.02, "min": 0.01, "max": 0.06, "unit": "per_call", "notes": "..." },
      "side_effects": ["navigation", "network_egress", "fs_writes_artifacts"],
      "requires": { "api_keys": ["ANTHROPIC_API_KEY"], "browser": true }
      /* …plus name / description / input_schema */
    }
    /* …11 more rows */
  ],
  "env": [
    { "name": "ANTHROPIC_API_KEY", "scope": "auth", "default": "", "required": true, "description": "..." }
    /* …20 more rows across auth / cache / cost_guard / artifacts / logging / memory / reports */
  ],
  "cache": { "enabled": true, "ttl_ms_default": 86400000, "path": "~/.pixelcheck/result-cache.db" }
}
```

**Pure introspection.** No LLM, no browser, no probe of secret presence. Secret env vars are *named* (so you know what to set) but values are never returned. The cache file path *is* exposed because paths are not secrets — agents writing diagnostic / cleanup scripts genuinely need them. See [ADR-016](./docs/decisions/ADR-016-mcp-self-describe.md) for design rationale, including why `tools/list` keeps the strict-spec subset and why runtime secret-presence is deliberately not probed.

Every tool response carries a top-level `schema_version` field per [docs/contracts/RESULT_SCHEMA.md](./docs/contracts/RESULT_SCHEMA.md). Two parallel tool calls in one server process see independent run-USD cost caps (per [ADR-009](./docs/decisions/ADR-009-concurrency-safety.md)) but share the persistent daily ledger.

Adding a new tool: drop a file under `src/mcp/tools/<name>.ts` exporting a `ToolDefinition`, then push it into `ALL_TOOLS` in `src/mcp/server.ts`. See [ADR-010](./docs/decisions/ADR-010-mcp-tool-registry.md) for the registry rationale.

## Multi-Project Support

One PixelCheck install serves all your projects:

```
pixelcheck/
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
pixelcheck run --project projects/my-app 2> audit.log

# Force JSON even in a terminal
LOG_PRETTY=0 pixelcheck run --project projects/my-app

# Verbose debugging
LOG_LEVEL=debug pixelcheck run --project projects/my-app
```

## Cost Guard

A process-wide spend cap protects against runaway LLM bills. Every Anthropic API call is tracked against two limits:

- **Per-run** — single audit / MCP tool invocation. Reset at run start.
- **Per-day** — UTC-day total persisted across processes in a JSON ledger (default `~/.pixelcheck/cost-ledger.json`, override via `AUDIT_COST_LEDGER_PATH`).

Exceeding any cap throws `BudgetExceededError` so the calling loop stops immediately. The ledger auto-prunes entries older than 30 days.

| Env var | Default | Effect |
|---|---|---|
| `AUDIT_COST_MAX_RUN_USD` | `5` | Max USD per audit run / MCP tool call |
| `AUDIT_COST_MAX_RUN_TOKENS` | `10000000` | Max input+output tokens per run |
| `AUDIT_COST_MAX_DAILY_USD` | `50` | Max USD per UTC day across all runs |
| `AUDIT_COST_MAX_DAILY_TOKENS` | `100000000` | Max input+output tokens per UTC day |
| `AUDIT_COST_LEDGER_PATH` | `~/.pixelcheck/cost-ledger.json` | Path to the persistent daily ledger |
| `AUDIT_COST_GUARD_DISABLED` | unset | `1` / `true` to bypass entirely (CI / tests) |

The cost guard layers over (and is independent of) the runner's `budget_usd` cap, which only stops the runner from scheduling new units. The cost guard catches direct MCP tool calls, computer-use loops, and instruction mutations that the unit scheduler doesn't see.

Inspect the current state via the snapshot included in the `run started` log line, or:

```sh
LOG_LEVEL=debug pixelcheck run --project projects/my-app
# emits one "llm usage recorded" debug line per Anthropic call with running totals
```

## Concurrency Safety

PixelCheck is safe to run from multiple processes at once — two parallel `pixelcheck` terminals, an MCP server fielding two `audit_url` calls in parallel, or a CLI run alongside an MCP-served call. Specifically:

- **Cost ledger** (`cost-ledger.json`): protected by a cross-process advisory lockfile (`<ledger>.lock`). Concurrent recorders never lose updates.
- **Per-run cost counters**: each MCP tool dispatch and each `runAudit` call gets its own `AsyncLocalStorage` scope, so two parallel calls have independent run-USD caps. The persistent daily ledger is still shared.
- **Memory DB** (`memory.db`): `record(fact)` uses one atomic `INSERT … ON CONFLICT DO UPDATE`. No SELECT-then-write race.
- **Visual diff baselines**: first-run bootstrap copies to a `.tmp` path then `linkSync`s into place. Two parallel first-runs both succeed; the first writer wins.

If a process crashes while holding the cost-ledger lock, the lock auto-recovers after 30 seconds (or sooner if the holder pid is no longer alive). See [ADR-009](docs/decisions/ADR-009-concurrency-safety.md) for design.

### SQLite stores share a unified migration runner

PixelCheck uses four local SQLite files (`history.db` / `memory.db` / `plan-cache.db` / `result-cache.db`). They all open through `src/core/db-migrate.ts > openManagedDatabase()`, which handles the parent-directory creation, `busy_timeout` pragma, file-locked WAL transition, and a `PRAGMA user_version`-driven migration walk in one place. Each migration runs in its own `BEGIN IMMEDIATE` / `COMMIT` block so a SQL failure rolls every CREATE / ALTER / INSERT in that step back atomically — partial schema is impossible. Older binaries opening newer DBs fail loudly with `MigrationVersionError` instead of running broken queries against missing columns. See [ADR-026](docs/decisions/ADR-026-unified-db-migrations.md) for design.

## Result Cache

A persistent local cache memoises results from the deterministic primitives so repeated identical calls return instantly with `cost_usd = 0`. AI agents can plan more aggressively without burning fresh vision tokens on every tool call.

**Cached primitives:**

| Primitive | Cached | Notes |
|---|---|---|
| `judge`   | ✅ | Same URL + rubrics + custom criteria + persona/model → same verdict. |
| `extract` | ✅ | Same URL + schema + instruction + selector + persona/model → same `data`. |
| `see`     | ✅ when `goal` is set | Without a goal there is no LLM cost — caching a snapshot would risk staleness. |
| `act`     | ❌ | State-changing semantics; always runs fresh. |
| `compare` | Transparent | Its two per-side `judge` calls hit cache automatically; the synthesis call is not separately cached. |

**Hit/miss semantics:** every cache-aware result carries an optional `cache?: { hit, age_ms, key, cost_saved_usd? }` field. On hit the result's own `cost_usd` is **zeroed** and the original cost moves to `cache.cost_saved_usd` — so callers summing nested costs (e.g. `compare`) do not double-count cached work.

**Configuration:**

| Env var | Default | Effect |
|---|---|---|
| `AUDIT_RESULT_CACHE_PATH` | `~/.pixelcheck/result-cache.db` | SQLite path; isolate per environment |
| `AUDIT_RESULT_CACHE_TTL_MS` | `86400000` (24h) | Entries older than this are misses + pruned |
| `AUDIT_RESULT_CACHE_DISABLED` | unset | `1` / `true` to bypass entirely (read = miss, write = no-op) |
| `AUDIT_RESULT_CACHE_MAX_ROWS` | `10000` | LRU cap; oldest `last_used_at` rows evicted past this. `0` disables. |
| `AUDIT_RESULT_CACHE_MAX_DISK_MB` | `500` | LRU cap by DB size; same eviction order. `0` disables. |

**Per-call overrides** (also exposed on each MCP tool as `cache` / `cache_bust` / `cache_ttl_ms`):

- `cache: false` — skip read and write for this one call.
- `cacheBust: true` — skip read but persist the new result so subsequent identical calls hit cache.
- `cacheTtlMs: number` — override the TTL for this call.

**Schema-version invalidation:** entries written under a different `RESULT_SCHEMA_VERSION` are treated as misses and removed at the next prune. The cache survives additive minor bumps automatically; major bumps invalidate everything.

See [ADR-015](docs/decisions/ADR-015-result-cache.md) for design.

## Artifact retention

Each MCP primitive call (`see` / `act` / `extract` / `judge` / `compare`) writes a per-call subdirectory under `~/.pixelcheck/<kind>/` containing screenshots, DOM dumps, payload JSON, and the LLM response. Long-running MCP servers can accumulate gigabytes over a month. PixelCheck enforces a 30-day retention window by default and prunes lazily.

```bash
pixelcheck prune          # explicit cleanup; prints summary, exit 1 on errors
```

The MCP server runs the same prune at most once per 24 hours on startup
(`prune-stamp.json` records the last run; subsequent connects within the
window skip prune entirely).

| Env var | Default | Effect |
|---|---|---|
| `AUDIT_SEES_RETENTION_DAYS` | 30 | Retention window for `see` artifacts; `0` disables |
| `AUDIT_ACTS_RETENTION_DAYS` | 30 | Same, for `act` |
| `AUDIT_EXTRACTS_RETENTION_DAYS` | 30 | Same, for `extract` |
| `AUDIT_JUDGES_RETENTION_DAYS` | 30 | Same, for `judge` |
| `AUDIT_COMPARES_RETENTION_DAYS` | 30 | Same, for `compare` |
| `AUDIT_<KIND>_DIR` | `~/.pixelcheck/<kind>` | Custom storage dir per kind |

Setting a retention to `0` means **infinite retention** (skip prune for that kind), matching how every Linux retention tool behaves. To bulk-delete a kind, use `rm -rf ~/.pixelcheck/<kind>` directly.

## Built With

- [Playwright](https://playwright.dev/) — browser automation
- [Stagehand 3.x](https://github.com/browserbase/stagehand) — AI-driven semantic browser control
- [Claude](https://anthropic.com/claude) (Vision + Computer Use) — visual evaluation and pixel-level review
- [axe-core](https://github.com/dequelabs/axe-core) — WCAG accessibility auditing
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — local audit history and trend tracking

## How Is This Different?

You have four real options if you want an AI agent to operate the visual web today, and each makes a different bet:

- **OSS automation frameworks** — browser-use (91k★), Stagehand (22k★), Skyvern (21k★). Best-in-class at *executing tasks* an agent dictates. None ship a multi-persona simulation layer, none have a strict result-schema contract designed for cacheable AI workflows.
- **Rule-based auditors** — axe-core (7k★), pa11y (4.4k★), Lighthouse. Excellent at "does this pass WCAG?" Silent on "is this product actually good?"
- **Hosted agentic browsers** — Comet, Atlas, BrowserOS, Dia. Consumer products that replace Chrome. You give them a credit card and a session. They give you UI, not infrastructure.
- **PixelCheck** — the MCP server beneath your AI agent's workflow. Fully local, fully OSS, fully owned.

| | OSS Frameworks | Rule-Based Auditors | Hosted Agentic Browsers | **PixelCheck** |
|---|---|---|---|---|
| **Question answered** | How do I control a browser? | Does this pass WCAG 2.x? | Can a product look at the web for me? | How does *my AI agent* see and operate the web? |
| **Primary interface** | Library / SDK | CLI | Desktop app + cloud session | **MCP server** (+ CLI for humans) |
| **Intelligence** | LLM-driven actions | Static rules | Hosted LLM (you pay per session) | LLM vision + rules + Computer Use, your LLM key |
| **User simulation** | Single anonymous session | None | Single signed-in session | 18 personas × 17 countries × 6 script systems |
| **Anti-detection** | None | N/A | Built-in (browser identity) | 9 fingerprints + 15 stealth patches |
| **Output contract** | Action results | Pass/fail checklist | Conversational replies | **31 published JSON Schemas + 89 named API** |
| **History** | None | None | Per-session, vendor-locked | SQLite trends + run-to-run diff, yours |
| **Cost model** | Free OSS, your LLM bill | Free OSS | Subscription + per-session | Free OSS, your LLM bill, no PixelCheck markup |
| **Where your data lives** | Your machine | Your machine | Vendor cloud | **Your machine. Period.** |
| **Lock-in** | Sometimes (cloud add-ons) | None | Maximum | None — MIT, no paid tier, no commercial fork |

No existing open-source project combines MCP-first browser primitives, multi-persona simulation, AI vision scoring, WCAG analysis, stealth fingerprints, and historical trend tracking. **PixelCheck is the missing infrastructure layer between AI agents and the visual web** — and it's the only one in the table above where the answer to "what happens to my data" is "it never leaves your machine."

## Test Coverage

Run with measurement:

```bash
npm run test:coverage          # writes ./coverage/index.html
npm run test:coverage:check    # CI gate — fails on regression below thresholds
```

Coverage is enforced via `vitest.config.ts > coverage.thresholds` (provider `v8`). Entry-points (`cli.ts`, `index.ts`, `mcp/server.ts`) and pure-type contracts (`core/types.ts`, `core/result-schema.ts`) are excluded — they are tested through consumers (CLI smoke + MCP `tools/list` handshake + schema round-trip tests). Counting them would dilute the signal.

The threshold floor sits at or below the current global baseline so the gate catches regression but doesn't block the build. Each new test PR ratchets the floor up after pushing it. Per-module coverage is visible in the text-table report or `coverage/index.html`. See [docs/decisions/ADR-017-coverage-tooling-and-m1-2-phase-1.md](docs/decisions/ADR-017-coverage-tooling-and-m1-2-phase-1.md) for the M1-2 phase plan.

## Performance regression gate

Hot-path benchmarks live in `tests/perf.bench.ts` and run separately from the test suite (vitest's `*.bench.ts` discovery is independent from `*.test.ts`, so `npm test` stays fast). 9 benchmarks cover the report rendering + aggregation paths most likely to regress when someone refactors a template or adds an O(N²) loop:

- `renderPdfHtml` / `renderTrendsHtml` / `renderDiffMarkdown` / `renderDiffHtml`
- `renderJunitXml` / `renderSarif`
- `summarizeWcag` / `computeSummary` / `t() i18n lookup`

```bash
npm run bench          # measure (writes docs/perf-current.json)
npm run bench:check    # compare to docs/perf-baseline.json — exit 1 on regression > 50%
npm run bench:update   # bake current as new baseline (after intentional perf changes)
```

The default 50% tolerance is calibrated against measured run-to-run variance (8–53% on quiet hardware). Stricter local checks via `--tolerance 0.30`. Initial baseline was recorded as **min-of-5 consecutive runs** so regressions register as "slower than we've ever been" — robust to noise above the floor. See [ADR-025](docs/decisions/ADR-025-performance-regression-suite.md) for the full design.

## Stability Commitment

Starting **v1.0.0**, the following surfaces are stable per
[Semantic Versioning](https://semver.org/):

- **CLI** — flags, subcommands, exit codes, env var names
- **Config schema** — `config.yaml` / `personas/*.yaml` / `scenarios/*.yaml`
- **Result Schema** — version 1.2.0, the 31 published JSON Schemas in `docs/schemas/`
- **MCP tool surface** — 13 tool names + input/output schemas
- **Library exports** — 89 named exports from `src/index.ts`

Breaking changes only land in **major version bumps** (v2.0, v3.0, ...). Minor
and patch releases are guaranteed backward-compatible. Deprecation cycle is
documented in [docs/DEPRECATION-POLICY.md](docs/DEPRECATION-POLICY.md):
features deprecated in v1.x continue to work for **at least two minor
releases** before being removed in the next major.

Upgrading from v0.3 to v1.0? See [MIGRATION.md](MIGRATION.md).

### Performance baseline (provisional, v1.0-rc1 calibration pending)

A typical 5-unit audit (1 scenario × 5 personas, full AI pipeline) is
expected to land in:

| Metric | v1.0 target | Notes |
|---|---|---|
| Wall-clock time | ~2–5 minutes | Varies by site complexity, persona count, model. v1.0-rc1 calibration will set a hard SLA. |
| API cost | ~$0.10–$0.30 | Claude Sonnet 4.6 vision; Computer Use spikes can push to $0.50+ |
| Memory peak | < 1 GB RSS | Chromium ~500 MB + Node heap ~300 MB |

**Render hot-paths** (already tracked via `npm run bench:check` regression gate):

| Path | ops/sec on M-series | Notes |
|---|---|---|
| `renderPdfHtml` (20-unit audit) | ~12,000 | A4 portrait + WCAG section + 5 charts |
| `renderTrendsHtml` (100-row history) | ~1,000 | 5 inline-SVG charts |
| `renderDiffMarkdown` (typical PR) | ~90,000 | Sticky PR comment friendly |
| `renderSarif` (20-unit, 12 issues) | ~190,000 | Per-WCAG-SC ruleIds |

These are micro-benchmarks (single function call). Full audit pipeline
(launch chromium → navigate → score) wall-clock baseline is being
calibrated in v1.0-rc1.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
full developer guide (dev setup, commit conventions, PR process, ADR
practice, branch protection).

We adopt the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md) as our
community Code of Conduct.

Areas where help is especially appreciated:
- New personas for underrepresented regions/demographics
- Scenario templates for common app patterns (e-commerce checkout, onboarding, dashboards)
- Report format improvements
- Cost optimization strategies

For installation troubleshooting (corporate proxy, Alpine, air-gapped, etc),
see [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Privacy & Data Handling

`pixelcheck` runs entirely on your machine. The only outbound
network destination is `api.anthropic.com` for the audit calls you
explicitly trigger. **Zero telemetry.**

What leaves your machine when you run an audit:

- Page screenshots + DOM summaries → Anthropic Claude API
- Your scenario step text + persona profile fields → Claude API
- Nothing else (URLs / env vars / paths / past audits stay local)

Privacy-first defaults:

- **Password / secret / API-key inputs are redacted** to `********` before
  screenshots (`--redact-inputs`, on by default; opt out with
  `--no-redact-inputs` only for fixture audits)
- **First-run consent prompt** explicitly informs you what data goes to
  Anthropic. Persisted in `~/.pixelcheck/consent.json` so subsequent
  runs don't re-prompt. Bypass for CI / non-TTY:
  `AUDIT_AUTO_CONSENT=1` env or `--auto-consent` flag (read [PRIVACY.md](PRIVACY.md) first).
- **Per-run reports stored at mode 0700** (owner-only) under
  `<projectDir>/reports/`

For full data-flow disclosure, GDPR / CCPA position, retention controls,
and how to delete data — see [PRIVACY.md](PRIVACY.md).

## Security

Found a vulnerability? Please use GitHub Security Advisories (private
disclosure) — see [SECURITY.md](SECURITY.md). Do **not** file public
issues for security reports.

## License

MIT — see [LICENSE](LICENSE) for full text.

Third-party dependencies and their licenses are documented in
[docs/THIRD_PARTY_LICENSES.md](docs/THIRD_PARTY_LICENSES.md).

## Help & Reference

- [FAQ.md](FAQ.md) — common questions on API key + cost, scenarios + personas, reports + output, privacy, native binaries
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — runtime errors and fixes (API + auth, audit run, browser, reports, CI, performance)
- [docs/INSTALLATION.md](docs/INSTALLATION.md) — install matrix + corporate proxy + Alpine / Docker / air-gapped recipes
- **API reference** — generate locally with `npm run docs:api` → `docs/api/index.html` (TypeDoc, not committed)
- [docs/decisions/](docs/decisions/) — 28 Architecture Decision Records explaining design rationale

---

<p align="center">
  <strong>E2E tests verify your code works. PixelCheck gives AI agents real eyes and hands to verify your product works.</strong>
  <br/>
  <a href="#quick-start">Get started in 2 minutes</a>
</p>

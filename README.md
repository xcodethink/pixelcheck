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
- **Credential redaction** — OAuth tokens and passwords are never written to reports
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

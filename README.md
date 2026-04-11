# ai-browser-auditor

> AI-driven post-deployment UX audit. Real browser, real personas, real scenarios, commercial-grade evaluation.

This is **not** an E2E test framework. It is an automated **product experience auditor** that runs after every deployment, behaving like a senior PM + QA + UX reviewer rolled into one.

For the full design and rationale, read [PLAN.md](PLAN.md).

## What it does

For each combination of (persona × scenario), the tool:

1. Launches a real Chromium with a stealth fingerprint matching the persona's device
2. Configures locale, timezone, language, viewport, and (optional) regional proxy
3. Records video, HAR network log, console errors, and SHA-256-hashed screenshots
4. Drives the browser using **Stagehand 2.0** (Claude under the hood) to perform the scenario steps semantically
5. Calls a **Claude vision critic** to score the result on 5 dimensions (completion, localization, visual_polish, trust_signals, time_to_value)
6. For critical steps, escalates to **Computer Use** (Claude Opus 4.6) for a pixel-level second-pass review
7. Generates a JSON + HTML + Markdown report

## Key features

- **Hybrid AI execution**: Stagehand for the 90% common case, Computer Use for the 10% critical-review path
- **9 real device fingerprints** with 15 anti-detection patches via [stealth-core](../stealth-core)
- **6 personas** spanning US/JP/DE/CN/BR/SA — including RTL Arabic
- **8 scenarios** covering OAuth, domain check, admin audit, localization, payment, investigation, email, Chrome extension
- **Failure handling**: per-step retry with exponential backoff, fingerprint rotation, automatic Computer Use fallback
- **Concurrency control**: parallel units with same-origin throttling
- **Budget cap**: stops new units when total cost exceeds budget
- **Stripe TEST mode enforcement**: refuses to start if `pk_live_` keys detected
- **Email verification**: integrated mail.tm temporary inbox
- **Reports**: JSON (machine), HTML (human, dark theme), Markdown (terminal)
- **Notifications**: Slack + Telegram on completion
- **CI-ready**: meaningful exit codes (0 = pass, 1 = fail, 2 = warn)

## Install

```bash
# 1. Build the shared stealth-core package
cd ../stealth-core
npm install
npm run build

# 2. Install ai-browser-auditor
cd ../ai-browser-auditor
npm install

# 3. Install Playwright Chromium
npx playwright install chromium

# 4. Configure environment
cp .env.example .env
# Edit .env — at minimum set ANTHROPIC_API_KEY
```

## Usage

```bash
# Dry run — validate config and print the matrix
npm run audit -- --dry-run

# Run all personas and all scenarios
npm run audit

# Filter by scenario
npm run audit -- --scenario 01-google-oauth-signup

# Filter by persona
npm run audit -- --persona jp-japanese-pro-desktop

# Both filters
npm run audit -- --scenario 01-google-oauth-signup --persona jp-japanese-pro-desktop

# Visible browser for debugging
npm run audit -- --headed --persona jp-japanese-pro-desktop

# Custom budget
npm run audit -- --budget 1.0

# Tag the run
npm run audit -- --tag post-deploy-2026-04-11
```

## Reports

Reports land under `reports/<timestamp>_<tag>/`:

```
reports/2026-04-11_143022_post-deploy/
├── audit.json                            # primary, machine-readable
├── audit.html                            # rich HTML, dark theme
├── summary.md                            # terminal-friendly markdown
└── jp-japanese-pro-desktop__01-google-oauth-signup/
    ├── 01-open_home.png + .sha256
    ├── 02-assert_language.png + .sha256
    ├── ...
    ├── network.har
    ├── console.log
    └── video/
        └── *.webm
```

Open `audit.html` in any browser to see all results in one dashboard.

## Architecture

```
                  stealth-core (shared)
                         │
   ┌─────────────────────┼─────────────────────┐
   ▼                     ▼                     ▼
playwright-screenshots  ai-browser-auditor  scamlens-sandbox
(visual regression)     (AI audit — this)   (investigation)
```

Three tools share one stealth foundation. Any future upgrade (e.g. switching to patchright for CDP-leak fixes) instantly benefits all three.

## Writing personas

See [docs/writing-personas.md](docs/writing-personas.md). TL;DR: each persona is a YAML file describing identity + device + language + tier + mental model + critical concerns.

## Writing scenarios

See [docs/writing-scenarios.md](docs/writing-scenarios.md). Scenarios are declarative YAML with semantic steps:

- `visit` — open a URL
- `act` — Stagehand natural-language action
- `extract` — Stagehand structured data extraction (Zod schema)
- `observe` — Stagehand "what's on screen" query
- `wait_for` — wait for selector / text / time
- `assert_visual` — Claude vision critic with optional Computer Use escalation
- `assert_dom` — deterministic DOM assertion
- `check_email` — wait for an email in a temp inbox
- `screenshot` — explicit checkpoint
- `computer_use` — full Computer Use task
- `custom` — TS file with default-exported handler

## Safety

- **Stripe LIVE keys are refused** at startup if `pk_live_` detected in env
- **OAuth credentials never logged**, redacted from reports via `redact_patterns`
- **Computer Use** uses Anthropic's prompt-injection classifier (default on)
- **Self-product disclaimer**: ScamLens itself MUST NEVER use stealth — it's a fraud-detection tool. Stealth is only for the auditor's browser.

## License

MIT

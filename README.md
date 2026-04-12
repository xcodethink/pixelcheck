# ai-browser-auditor

> AI-driven post-deployment UX audit. Real browser, real personas, real scenarios, commercial-grade evaluation.

This is **not** an E2E test framework. It is an automated **product experience auditor** that runs after every deployment, behaving like a senior PM + QA + UX reviewer rolled into one.

For the full design and rationale, read [PLAN.md](PLAN.md).

## What it does

For each combination of (persona x scenario), the tool:

1. Launches a real Chromium with a stealth fingerprint matching the persona's device
2. Configures locale, timezone, language, viewport, and (optional) regional proxy
3. Records video, HAR network log, console errors, and SHA-256-hashed screenshots
4. Drives the browser using **Stagehand 2.0** (Claude under the hood) to perform the scenario steps semantically
5. Calls a **Claude vision critic** to score the result on 5 dimensions (completion, localization, visual_polish, trust_signals, time_to_value)
6. For critical steps, escalates to **Computer Use** (Claude Opus 4.6) for a pixel-level second-pass review
7. Generates a JSON + HTML + Markdown report

## Key features

- **Multi-project**: one tool audits all your projects. Each project provides its own `config.yaml` + `scenarios/`
- **Hybrid AI execution**: Stagehand for the 90% common case, Computer Use for the 10% critical-review path
- **9 real device fingerprints** with 15 anti-detection patches via [stealth-core](../stealth-core)
- **18 shared personas** spanning 15 countries, 13 languages, 3 device classes, 3 payment tiers — including RTL Arabic, Indic scripts, CJK, Cyrillic, and accessibility-focused elderly user
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

## Quick start: Add your project

```bash
# Create a project audit config for your app
npx ai-audit init projects/my-app --name "My App" --url "https://myapp.com"

# This creates:
#   projects/my-app/config.yaml     — project settings
#   projects/my-app/scenarios/      — your test scenarios
#
# Built-in personas (6) are used automatically.
# To customize, add a personas/ dir inside your project.

# Edit the generated scenario to match your app, then run:
npx ai-audit run --project projects/my-app --dry-run
npx ai-audit run --project projects/my-app
```

## Usage

```bash
# Run a specific project (recommended)
npm run audit -- --project projects/scamlens
npm run audit -- --project projects/my-app

# Filter by scenario or persona
npm run audit -- --project projects/scamlens --scenario 01-google-oauth-signup
npm run audit -- --project projects/scamlens --persona jp-japanese-pro-desktop

# Visible browser for debugging
npm run audit -- --project projects/scamlens --headed

# Custom budget
npm run audit -- --project projects/scamlens --budget 1.0

# Dry run — validate config and print the matrix
npm run audit -- --project projects/scamlens --dry-run

# Legacy: direct paths (still supported)
npm run audit -- --config config/scamlens.yaml --scenarios scenarios --personas personas
```

## Multi-project CI integration

Any project can trigger an audit after deployment. Add this to your project's CI:

```yaml
# In your project's .github/workflows/ci.yml
trigger-ai-audit:
  needs: [deploy]
  runs-on: ubuntu-latest
  steps:
    - name: Trigger AI audit
      run: |
        gh workflow run post-deploy-audit.yml \
          --repo xcodethink/ai-browser-auditor \
          --field project="scamlens" \
          --field trigger_source="my-project-deploy"
      env:
        GH_TOKEN: ${{ secrets.GH_PAT }}
```

For projects that keep audit configs in their own repo:

```yaml
    - name: Trigger AI audit (external config)
      run: |
        gh workflow run post-deploy-audit.yml \
          --repo xcodethink/ai-browser-auditor \
          --field project="external" \
          --field external_repo="xcodethink/my-other-project" \
          --field external_path=".audit" \
          --field trigger_source="my-other-project-deploy"
      env:
        GH_TOKEN: ${{ secrets.GH_PAT }}
```

## Project structure

```
ai-browser-auditor/
├── personas/               # Shared personas (6 archetypes)
├── projects/
│   ├── scamlens/           # ScamLens audit config
│   │   ├── config.yaml
│   │   └── scenarios/
│   └── my-app/             # Your project (ai-audit init)
│       ├── config.yaml
│       ├── scenarios/
│       └── personas/       # Optional: override shared personas
├── src/                    # Tool source code
├── reports/                # Generated reports
└── baselines/              # Visual regression baselines
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
                         |
   +-----------+---------+---------+
   v                     v                     v
playwright-screenshots  ai-browser-auditor  scamlens-sandbox
(visual regression)     (AI audit -- this)  (investigation)
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

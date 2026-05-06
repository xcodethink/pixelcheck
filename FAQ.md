# Frequently Asked Questions

Quick answers organised by topic. For installation issues, see
[docs/INSTALLATION.md](docs/INSTALLATION.md). For runtime errors, see
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Table of contents

- [API key + cost](#api-key--cost)
- [Scenarios + personas](#scenarios--personas)
- [Reports + output formats](#reports--output-formats)
- [Privacy + data handling](#privacy--data-handling)
- [Native binaries + cross-platform](#native-binaries--cross-platform)

---

## API key + cost

### Q: Where do I get an Anthropic API key?

[console.anthropic.com](https://console.anthropic.com) → Settings → API
Keys → Create. The key starts with `sk-ant-...`. Set it as an env var:

```bash
export ANTHROPIC_API_KEY=sk-ant-api03-...
# Verify with:
ai-audit doctor
```

### Q: How much does a typical audit cost?

Provisional v1.0 estimate: **$0.10–$0.30 per 5-unit audit** (1 scenario × 5
personas, full AI pipeline) on Claude Sonnet 4.6. Computer Use steps can
push this to $0.50+. Hard SLA pending v1.0-rc1 calibration — see the
[Performance baseline section in README](README.md#performance-baseline-provisional-v10-rc1-calibration-pending).

To cap spending:

```bash
ai-audit run --budget 5.0     # stops audits at $5 USD spent
```

Daily/per-run caps are also enforceable via `AUDIT_COST_MAX_RUN_USD` /
`AUDIT_COST_MAX_DAILY_USD` env vars. See [ADR-008](docs/decisions/ADR-008-cost-guard.md).

### Q: My audit failed mid-run with `BudgetExceededError`. What now?

The cost guard intentionally stops further LLM calls when your run / daily
budget is exhausted. You'll see partial results — already-completed units
are saved. To continue:

1. Increase `--budget` flag or env caps
2. Or wait until next day (daily cap rolls over UTC midnight)
3. Or run `ai-audit run --scenario <id> --persona <id>` to resume specific units only

### Q: Can I use a different LLM (OpenAI / Gemini / local)?

Not in v1.0 — v1.0 is locked to Anthropic Claude. The Computer Use feature
in particular is Claude-exclusive (no equivalent OpenAI API as of Q2 2026).
Multi-provider is on the v1.x / v2.0 roadmap; see [ADR-028](docs/decisions/ADR-028-stagehand-v3-deferred.md)
for context.

### Q: How do I run without burning API tokens?

For deterministic audits (no AI evaluation):

```yaml
# scenarios/deterministic-only.yaml
steps:
  - type: visit
    url: https://example.com
  - type: assert_a11y       # axe-core, no LLM
    standard: wcag22aa
  - type: assert_visual_diff # odiff, no LLM
    baseline: baselines/home.png
```

Skip vision / autonomous steps (`see` / `judge` / `compare` / `act` /
`audit_url`) which all call Claude. The result cache also helps —
identical inputs hit cache for 24h ([ADR-015](docs/decisions/ADR-015-result-cache.md)).

---

## Scenarios + personas

### Q: What's the difference between a scenario and a persona?

- **Scenario** = "what user journey to test" (visit page → click checkout
  → fill form → see error). Lives in `scenarios/*.yaml`. Same scenario
  runs across multiple personas.
- **Persona** = "who is testing" (US English mobile user with screen
  reader / Spanish desktop tier-1 customer / etc). Lives in
  `personas/*.yaml`, or use the 6 built-in personas. Same persona runs
  multiple scenarios.

A "unit" = scenario × persona pair. A 3-scenario × 5-persona audit = 15
units.

### Q: How do I write my first scenario?

Run `ai-audit init` (interactive) — it creates a starter
`scenarios/homepage-smoke.yaml` with `visit` + `assert_a11y` + `see` steps.
Edit it for your URL + persona of interest, then `ai-audit run`.

For scenario syntax: see [docs/writing-scenarios.md](docs/writing-scenarios.md).

### Q: How do I add custom personas?

Create `personas/my-persona.yaml` next to `personas/` directory. Built-in
personas come from `node_modules/pixelcheck/dist/personas/` and
auto-merge with custom — custom takes precedence on id collision.

For persona syntax: see [docs/writing-personas.md](docs/writing-personas.md).

### Q: Can I run only specific scenarios / personas?

Yes — repeatable filters:

```bash
ai-audit run --scenario login-flow --scenario signup-flow \
             --persona us-mobile --persona jp-desktop
```

---

## Reports + output formats

### Q: Where are reports written?

Default: `reports/<runId>/` next to your `cwd`. Each run gets a directory:

```
reports/
  20260502_120000_my-tag/
    audit.json              ← machine-readable, schema_version 1.2.0
    audit.html              ← static HTML report
    audit.pdf               ← stakeholder PDF (default ON; --no-pdf to skip)
    audit-explorer.html     ← interactive SPA
    audit.sarif             ← (CI mode) SARIF 2.1.0 for GitHub Code Scanning
    audit.junit.xml         ← (CI mode) JUnit XML for Jenkins / GitLab
    audit.jsonl             ← (CI mode) line-delimited JSON for `jq`
    <persona>__<scenario>/  ← per-unit artifacts (screenshots, console.log, etc)
```

Override with `--out <dir>`. Reports are mode `0700` (owner-only) per [PRIVACY.md](PRIVACY.md).

### Q: How do I integrate with my CI?

See [docs/ci-integration.md](docs/ci-integration.md). Quick patterns:

- **GitHub Code Scanning**: `--ci-format sarif` + upload via `github/codeql-action/upload-sarif`
- **Jenkins / GitLab CI**: `--ci-format junit` + standard test publisher
- **PR diff comment**: `ai-audit diff <baseline> <pr-run> --format markdown` + `marocchino/sticky-pull-request-comment`

`--ci-format auto` (default in CI) emits all four formats. Locally it's `none`.

### Q: Can I customize the PDF output?

Yes — see [reporter-pdf](docs/decisions/ADR-020-pdf-stakeholder-report.md) for the layout. PDF generation is on by default (`--pdf` is implied); turn off with `--no-pdf` for headless / CI scenarios that don't need PDFs.

### Q: How do I view trends across runs?

```bash
ai-audit trends                    # auto-discovers history.db in reports/
ai-audit trends --out ./reports    # explicit
```

Generates `reports/trends.html` with 5 inline-SVG charts (overall score,
pass/warn/fail, issues, cost, per-dimension). See [ADR-021](docs/decisions/ADR-021-trends-dashboard.md).

---

## Privacy + data handling

### Q: What data leaves my machine?

Only what's sent to the Anthropic Claude API for the audit calls you
trigger:

- Page screenshots (with password / secret fields redacted by default)
- DOM summaries (tag tree + visible text)
- Your scenario step text + persona profile fields
- Model name + max_tokens

**Nothing else.** Zero telemetry. No "phone home". The full data-flow
disclosure is in [PRIVACY.md](PRIVACY.md).

### Q: Why am I being prompted for "consent" on first run?

`pixelcheck` is honest about sending page content to a third-party
LLM (Anthropic Claude). The first-run prompt is informed consent — see
[PRIVACY.md § User consent](PRIVACY.md#user-consent). Subsequent runs
don't re-prompt unless the consent version bumps.

For CI / non-interactive: `AUDIT_AUTO_CONSENT=1` env var or `--auto-consent`
flag (read PRIVACY.md first, then add it to your runbook).

### Q: How do I delete data from a past audit?

```bash
# A specific run
rm -rf reports/<runId>

# All runs older than 30 days
find reports/ -maxdepth 1 -type d -mtime +30 -exec rm -rf {} \;

# Wipe ALL local cache state (forces rebuild)
rm -rf ~/.pixelcheck/
# (also wipe legacy backward-compat path if you upgraded from v0.x)
rm -rf ~/.ai-browser-auditor/
```

Anthropic's data-deletion process: https://www.anthropic.com/privacy#user-rights

### Q: Are passwords / API keys in screenshots a leak risk?

Passwords / secrets / tokens / API-key inputs are **redacted to
`********` by default** before screenshots. The redaction is a DOM
mutation (`input.value = '********'`), so the bytes sent to Claude
literally don't contain your secret. Disable only for fixture audits
where redaction interferes:

```bash
ai-audit run --no-redact-inputs
```

### Q: GDPR / CCPA compliance — what's my position?

**You** (the operator running `ai-audit`) are the **data controller**.
**Anthropic** is your **subprocessor** for the Claude API calls. **We**
(the maintainers) are not in your data path — the tool runs on your
infrastructure.

Detailed position + DPA / sub-processor disclosure / Article 17 deletion
flow: [PRIVACY.md § GDPR / CCPA position](PRIVACY.md#gdpr--ccpa-position).

---

## Native binaries + cross-platform

### Q: Install fails on Alpine Linux. How do I fix it?

Alpine uses musl libc; most prebuilt binaries are glibc-only. Two paths:

- **Easier (recommended)**: switch to `node:20-bookworm-slim` Docker image
- **If you must stay on Alpine**: `apk add --no-cache python3 make g++ chromium nss freetype harfbuzz ca-certificates ttf-freefont` + `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` + `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser`

Full Alpine recipe: [docs/INSTALLATION.md § Alpine](docs/INSTALLATION.md#linux-alpine-including-docker-nodealpine).

### Q: `Failed to launch chromium` after install. What's wrong?

Linux: missing system libraries. Run:

```bash
npx playwright install-deps chromium
```

This installs libnss3 / libgbm1 / libxshmfence1 / etc. See [docs/INSTALLATION.md § Linux](docs/INSTALLATION.md#linux-ubuntu--debian).

### Q: Windows — should I use Git Bash, PowerShell, or WSL?

Recommended: **WSL2** for the smoothest experience (treats it as
Linux — `npx playwright install-deps` works directly). Otherwise:

- **Git Bash**: works without modification
- **PowerShell**: env var syntax differs (`$env:ANTHROPIC_API_KEY = "sk-ant-..."`)

For native Windows: install [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022) → "Desktop development with C++" workload. This gives node-gyp the MSVC compiler for `better-sqlite3` fallback compile.

### Q: Why does `npm install` take forever?

The bulk is Playwright's Chromium binary download (~150 MB). On slow
links / CI:

- Use a regional npm mirror (`npm config set registry https://your-region.mirror`)
- Pre-cache Chromium and `PLAYWRIGHT_BROWSERS_PATH=/cache/path` skip per-CI download
- Air-gapped / restricted: bundle Chromium ahead of time per [docs/INSTALLATION.md § Air-gapped install](docs/INSTALLATION.md#air-gapped-install)

### Q: ARM64 (Apple Silicon / Raspberry Pi / Docker buildx) — supported?

- **Apple Silicon**: yes — tier-1 platform, CI matrix runs `macos-14` (M-series). Works out of the box.
- **Linux ARM64**: tier-2; prebuilt binaries exist for major deps but coverage varies by glibc version. Try `node:20-bookworm-slim` arm64 image.
- **Windows ARM64**: skipped by `package.json os: ["darwin","linux","win32"]` cpu filter — npm refuses to install. Use Windows x64 + emulation if absolutely required.

---

## See also

- [README — Quick Start](README.md#quick-start)
- [docs/INSTALLATION.md](docs/INSTALLATION.md) — install + cross-platform
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — runtime errors
- [PRIVACY.md](PRIVACY.md) — data handling
- [SECURITY.md](SECURITY.md) — security disclosures
- [CONTRIBUTING.md](CONTRIBUTING.md) — dev guide
- [docs/decisions/](docs/decisions/) — Architecture Decision Records (26 ADRs)

---

**Last updated**: 2026-05-02 (T24 — Wave 3 close)

# Troubleshooting Guide

Runtime errors that hit you **after** install — i.e., the install
succeeded but something fails when you actually run `pixelcheck run` or
similar commands. For install errors, see
[docs/INSTALLATION.md § Common install errors](INSTALLATION.md#common-install-errors--fixes).

For configuration / philosophy questions, see [FAQ.md](../FAQ.md).
For security-sensitive disclosures, see [SECURITY.md](../SECURITY.md).

---

## First step: run `pixelcheck doctor`

Before reading further, run the bundled diagnostic:

```bash
pixelcheck doctor --verbose
```

It checks Node version / API key / config / scenarios / personas /
network proxy / Anthropic API reachability and tells you exactly what's
wrong with a specific remedy. Most issues below are pre-detected by
`doctor`.

---

## Table of contents

- [API + auth errors](#api--auth-errors)
- [Audit run errors](#audit-run-errors)
- [Browser + Playwright errors](#browser--playwright-errors)
- [Reports + output errors](#reports--output-errors)
- [CI integration errors](#ci-integration-errors)
- [Performance + cost issues](#performance--cost-issues)
- [Still stuck?](#still-stuck)

---

## API + auth errors

### `Missing required environment variables: ANTHROPIC_API_KEY`

The auditor needs an Anthropic API key for every step that calls Claude
(see / judge / compare / extract / act / audit_url). v1.0 friendly catch
already prints the remedy:

```
[pixelcheck] ANTHROPIC_API_KEY not set.
  Get a key at https://console.anthropic.com → set ANTHROPIC_API_KEY=sk-ant-...
  Run `pixelcheck doctor` to verify your environment.
```

Set the key in your shell:

```bash
export ANTHROPIC_API_KEY=sk-ant-api03-...
pixelcheck run
```

For a project-local override, create `.env` (gitignored — see [.gitignore](../.gitignore)):

```
ANTHROPIC_API_KEY=sk-ant-api03-...
```

`dotenv` is loaded automatically; per-project keys win over the shell.

### `401 Unauthorized` from Anthropic API

Your API key is set but rejected. Causes:

| Cause | Fix |
|---|---|
| Key is for a different Anthropic account / org | Verify at [console.anthropic.com → API Keys](https://console.anthropic.com/settings/keys) |
| Key was revoked | Generate a new key |
| Key is correct but billing issue | Check console for "payment failed" banner |
| Key is correct but the `claude-sonnet-4-6` / `claude-opus-4-6` model not enabled on your tier | Try `--model claude-haiku-4-5-20251001` (cheaper, more accessible) |

### `429 Rate limit exceeded`

Hit your tier's RPM / TPM cap. Two paths:

1. **Reduce concurrency**: `pixelcheck run --concurrency 1`
2. **Use a slower model**: `--model claude-haiku-4-5-20251001` has higher rate limits

The auditor doesn't auto-retry on 429 (avoids billing surprises). Re-run after a few minutes.

### `request to api.anthropic.com failed, reason: self-signed certificate in certificate chain`

Corporate proxy is doing TLS interception. Add the corp CA to Node's trust store:

```bash
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/corp-ca.pem
pixelcheck run
```

See [docs/INSTALLATION.md § Corporate proxy](INSTALLATION.md#corporate-proxy--firewall-environments) for details.

---

## Audit run errors

### `Consent declined`

You answered "n" / "no" / empty at the first-run consent prompt. Either:

- Re-run and answer "y" if you accept that data goes to Anthropic
  Claude API (read [PRIVACY.md](../PRIVACY.md) first if unsure)
- Or use `AUDIT_AUTO_CONSENT=1` in non-interactive contexts (CI / MCP)
- Or stop using vision-based steps — pure deterministic audits (`assert_a11y` /
  `assert_visual_diff`) don't trigger the prompt

### `Project directory not found: <path>`

`--project <dir>` resolves config / scenarios / personas from a project
directory. The path must exist + contain `config.yaml` + `scenarios/`.
Run `pixelcheck doctor --projectDir <path>` to diagnose.

### `Scenario file failed validation: ...`

Your scenario YAML has a schema error. The error message points to the
specific field. Common ones:

| Error | Fix |
|---|---|
| `Invalid enum value. Expected '...', received '<bad>'` | Check the field's allowed values in `docs/writing-scenarios.md` |
| `Required` (e.g., `applies_to.personas`) | Field is mandatory — add it |
| `Expected number, received string` | Wrap numeric values without quotes (or remove quotes) |
| `Expected array, received string` | YAML `- foo` for arrays, not bare strings |

`pixelcheck run --dry-run` validates without executing — useful for
iterating scenario YAML quickly.

### `BudgetExceededError: run-usd $X.XX exceeds limit $Y.YY`

Cost guard (M5-6 / [ADR-008](decisions/ADR-008-cost-guard.md)) intentionally stopped further LLM calls. Already-completed
units are saved. To continue:

```bash
pixelcheck run --budget 10.0      # bump per-run budget cap
```

Or set env caps (`AUDIT_COST_MAX_RUN_USD` / `AUDIT_COST_MAX_DAILY_USD`).

The daily ledger is at `~/.pixelcheck/cost-ledger.json` — see
your spending: `cat ~/.pixelcheck/cost-ledger.json`.

### `axe-core not available after injection`

Playwright failed to inject axe-core into the page (CSP issue, page
already navigated away, etc). The `assert_a11y` step gracefully returns
with status `warn` instead of crashing the audit. To diagnose:

1. Check the per-step `output` field in `audit.json` for the underlying error
2. If site has strict CSP, see if `addScriptTag` is permitted; some sites need a
   different injection path (open an issue if you hit this)
3. Try `--headed` to watch what the browser does

---

## Browser + Playwright errors

### `Target page closed` mid-step

The page navigated away or was closed before the step completed. Causes:

- Site redirects after a delay (e.g., login → dashboard)
- A modal / popup intercepted focus and the test clicked outside
- Network failure broke navigation

The auditor's recorder catches these as `pageerror` events visible in
`<unitDir>/console.log`. Inspect that log + the `--trace` output (Playwright
trace viewer):

```bash
pixelcheck run --trace
npx playwright show-trace reports/<runId>/<unit>/trace.zip
```

### `Timeout 30000ms exceeded` waiting for an element

Page is slower than the step's timeout, or the selector is wrong:

```yaml
# Increase per-step timeout
- type: click
  selector: "[data-testid=submit]"
  timeout_ms: 60000
```

For semantic / NL steps that resolve to a selector at runtime (`act`),
the timeout governs the entire AI + click cycle.

### Screenshots are all-white / all-black

Page took a screenshot before render finished. Two fixes:

```yaml
- type: visit
  url: https://example.com
  wait_until: networkidle    # default is 'load'; networkidle waits longer

- type: wait
  ms: 2000                   # explicit wait

- type: screenshot
```

Or use `assert_a11y` / `see` which include built-in stability gates ([ADR-009](decisions/ADR-009-concurrency-safety.md)).

### `M9-3.2: file-lock cross-process race` flake

Pre-T1 known flake. **Fixed in v1.0** via `vitest.integration.config.ts`
(forks pool). If you see this in v1.0 output, file an issue with the
full `--trace` output.

---

## Reports + output errors

### `audit.pdf` is missing

PDF generation needs Chromium spawn — slower than HTML / JSON. Default
is ON; if you skipped it via `--no-pdf` and want it back:

```bash
pixelcheck run --pdf
```

If `--pdf` is set but PDF still missing, check:

1. Run logs for `[reporter-pdf] failed: ...`
2. Available disk space (PDFs are ~500KB each)
3. Whether Chromium spawned successfully (`pixelcheck doctor`)

### `audit.html` opens but is blank / broken

Likely a SPA-mode bug — open `audit-explorer.html` instead (interactive
report). If both are broken, check browser console for JS errors (open
`audit.html` in Chrome DevTools).

### History trends say "no runs found"

`pixelcheck trends` reads `reports/history.db`. The DB is created on first
audit; if you're running trends before any successful audit, you'll see
this message.

To verify:

```bash
ls reports/history.db
sqlite3 reports/history.db "SELECT COUNT(*) FROM audit_runs;"
```

### Schema regen produces uncommitted changes in CI

The CI gate (`npm run schemas` then `git diff --quiet docs/schemas/`)
fails if the published JSON schemas drift from your Zod source. Locally:

```bash
npm run schemas
git add docs/schemas/
git commit -m "schemas: regen after <change>"
```

---

## CI integration errors

### GitHub Code Scanning rejects our SARIF

Common SARIF upload errors:

| Error | Fix |
|---|---|
| `Schema validation: 'helpUri' must be valid URL` | Already fixed in v1.0 — pin to v1.0.0+ |
| `category` mismatch with prior upload | The upload action's `category` must match across runs; pin it explicitly |
| File too large | SARIF can grow with 1000+ issues; split via `assert_a11y` exclusions |

See [docs/integration/sarif-upload-verified.md](integration/sarif-upload-verified.md) for the full SOP.

### `audit.junit.xml` rejected by Jenkins / GitLab

JUnit format is permissive across consumers, but some require:

- A `<testsuite>` wrapper element (we emit one)
- Exit code 1 if any `<failure>` (we honor `--min-score`)
- Filename `*.junit.xml` (we use this; rename if your CI expects `TEST-*.xml`)

### Sticky PR comment gets duplicated on each run

`marocchino/sticky-pull-request-comment` requires a stable `header:`
field across runs. If you change the header, it posts a new comment.
Pin it:

```yaml
- uses: marocchino/sticky-pull-request-comment@v2
  with:
    header: pixelcheck-diff   # exact same string every run
    path: diff.md
```

### CI matrix runs out of disk space

Playwright's Chromium binary cache + node_modules can hit ubuntu-latest's
14 GB limit on heavy parallelism. Mitigations:

- `actions/setup-node` `cache: npm` (already used in our `ci.yml`)
- `concurrency: cancel-in-progress` to free aborted-run space
- Skip integration on PRs unless workflow files changed

---

## Performance + cost issues

### Audit runs take 10+ minutes for a small site

Possible causes:

| Cause | Fix |
|---|---|
| Many vision calls (every step has `screenshot` + `see`) | Reduce screenshot frequency; use `see` only on key pages |
| Computer Use loops without escape | Set `--budget 2.0` to force termination |
| Slow target site (3-5s per page load) | Pre-warm via `wait_until: load` instead of `networkidle` |
| Stagehand cold-start (~5s) | One per audit run; multi-step audits amortize this |

`pixelcheck run --observe --observe-port 9999` opens a live dashboard
showing per-step timing — useful for diagnosing where time goes.

### Daily costs higher than expected

Check the ledger:

```bash
cat ~/.pixelcheck/cost-ledger.json | jq
```

`days[<date>].usd` shows the actual daily total. If higher than expected:

1. Result cache might be disabled — verify `AUDIT_RESULT_CACHE_DISABLED` is unset
2. You're running `audit_url` / `explore_url` (high-cost) when `assert_a11y` would suffice
3. Computer Use steps loop more iterations than expected — set `max_iterations`

The cost-aware design is in [ADR-008](decisions/ADR-008-cost-guard.md) +
[ADR-015](decisions/ADR-015-result-cache.md).

### Memory peaks above 1 GB during audit

Chromium + Stagehand + multiple parallel units can spike. Mitigations:

- `--concurrency 1` runs units serially
- Skip 5-segment vision capture (currently no flag — open issue if you need this)
- Run on a larger CI runner (8 GB RAM standard for ubuntu-latest)

---

## Still stuck?

1. **Re-run with `--observe`** — opens a live dashboard at port 4000 (`--observe-port`) showing per-step state, screenshots, errors
2. **Check `pixelcheck doctor --verbose`** — second-look diagnostic
3. **Read the per-step `output` in audit.json** — every step records why it succeeded / failed
4. **Open a GitHub issue** with:
   - `pixelcheck doctor --verbose` output (redact your API key in the
     posted version — the verbose output already redacts it via
     [ADR-006](decisions/ADR-006-secrets-redaction.md))
   - Full error message + stack trace
   - Minimal scenario YAML to reproduce
   - `node --version`, `npm --version`, OS
5. **For security-sensitive issues**: don't open a public issue — see [SECURITY.md](../SECURITY.md)

---

**Last updated**: 2026-05-02 (T24 — Wave 3 close)

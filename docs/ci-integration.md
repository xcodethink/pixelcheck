# CI integration

## Goal

After every successful production deployment, run the auditor automatically and post the results to your team. Catch the things traditional CI cannot:

- OAuth chain breakage
- 12-language mixin regressions
- Visual polish regressions vs. baseline
- Stripe webhook misconfigurations
- Admin tab empty-state bugs
- Email deliverability

## GitHub Actions

A ready-to-copy template workflow is at [docs/integration/post-deploy-audit.example.yml](integration/post-deploy-audit.example.yml). Copy it into your app's `.github/workflows/post-deploy-audit.yml` and adjust the trigger / secrets for your environment. The template triggers:

- After a successful deploy workflow on `main` (replace `YOUR-DEPLOY-WORKFLOW` with your actual workflow name)
- Manually via "Run workflow"

### Required secrets

Set these in your GitHub repo Settings → Secrets and variables → Actions:

| Secret | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | LLM access for Stagehand, critic, Computer Use |
| `TEST_GOOGLE_US`, `TEST_GOOGLE_US_PASSWORD` | Dedicated Google OAuth test account for `01-google-oauth-signup` (US persona) |
| `TEST_GOOGLE_JP`, `TEST_GOOGLE_JP_PASSWORD` | Same for JP persona |
| `AUDIT_SLACK_WEBHOOK` | Optional, for completion notifications |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Optional Telegram alerts |

If your scenarios depend on app-specific secrets (admin session cookies, Stripe test keys, etc.), add them to the secret list and reference them in your scenario YAMLs.

### How to set Stripe test secrets safely

1. Stripe Dashboard → toggle "Test mode" (top right)
2. Developers → API keys → copy the **Publishable key** (starts with `pk_test_`)
3. Add as repo secret `STRIPE_TEST_PUBLISHABLE_KEY`
4. Never copy the **Secret key** (`sk_test_`) — the auditor doesn't need it; it only fills the public checkout form

The auditor's startup check explicitly **refuses** any key starting with `pk_live_`.

### How to set up the Google OAuth test account

1. Create a brand-new Google account dedicated to audits (e.g. `audit-us-myapp@gmail.com`)
2. Enable 2FA-free recovery email
3. Pre-authorize your OAuth app once manually (otherwise consent screen blocks automation)
4. Add to repo secrets

**Risk**: Google may eventually challenge automation. If you see CAPTCHA or "verify it's you" pages in audit reports, rotate to a new account or run the OAuth scenario less frequently (e.g. weekly instead of per-deploy).

## Exit codes

The CLI emits CI-friendly exit codes:

| Code | Meaning |
|---|---|
| 0 | All scenarios pass |
| 1 | One or more scenarios failed (critical issues or critical step failures) |
| 2 | All scenarios passed but with warn-level issues |
| 3 | Quality-gate regression: overall score below `--min-score` (no hard failure) |

A hard scenario failure (1) takes precedence over a gate regression (3), which
takes precedence over warnings (2). Code 3 lets CI distinguish a score
regression from a functional failure.

GitHub Actions will mark the job as failed for non-zero codes. You may want to allow exit code 2 to pass (warning-only) in your workflow:

```yaml
continue-on-error: true   # only if you want warn-only runs to not block the pipeline
```

## Artifact structure

After each run, the workflow uploads:

- `audit-report-<run_id>` — full `reports/<run_id>/` directory including JSON, HTML, screenshots, video, HAR, console logs
- `visual-baselines` — only on `main`, the snapshotted baseline directory for next-run diffing

To inspect a failure: download the artifact, open `audit.html` in a browser, click any screenshot to enlarge, watch the video for the failed unit.

## Per-PR audit (optional)

For preview deployments, you can run a smaller subset on every PR. Add a job that runs only your smoke scenario with one persona, with a tighter budget:

```yaml
- name: Quick audit (PR)
  if: github.event_name == 'pull_request'
  run: |
    npx pixelcheck run \
      --scenario 00-infra-smoke \
      --persona us-english-free-mobile \
      --budget 0.50 \
      --tag pr-${{ github.event.pull_request.number }}
```

## Cost management

Default `budget_usd: 3.0` covers a full 27-unit run with several Computer Use escalations. Override with `--budget` per run.

To predict cost without running: each unit averages ~$0.08 (Sonnet 4.6 only) to ~$0.40 (with Opus 4.6 critical_review escalations). Multiply by matrix size.

## Slack / Telegram notifications

Set `SLACK_WEBHOOK` or `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` env. The runner posts a summary at the end of every run:

```
[FAIL] AI Audit 2026-04-11_143022_post-deploy
Project: YourApp
Pass: 24 | Warn: 2 | Fail: 1
Critical issues: 1
Total cost: $1.342
Duration: 487.2s
```

Failure summaries include the minimum repro command for each failing unit so on-call can rerun locally.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| All units fail with "Stagehand not installed" | npm install didn't run, or `--with-deps` flag missing on `playwright install` |
| OAuth scenarios fail with "captcha" | Google challenged the test account; rotate or rerun later |
| Localization scenario reports false English mixins | Brand names like your product name should be in the critic's exempt list — verify the prompt template |
| Budget exhausted before all units run | Increase `--budget` or use `--scenario` to filter |
| Same scenario flaky across runs | Increase `retry` on the unstable step, or add `wait_for` before it |
| Console errors flood the report | The auditor records ALL console errors; if your app is noisy, set per-step `expected_console_noise` (TODO) |

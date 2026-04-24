# TalkBuddy audit project

Scaffold so `ai-browser-auditor` can run UX audits against
`talkbuddy.wayjet.io` with personas + scenarios targeted at the
30-commit audit batch that landed 2026-04-23 to 2026-04-24.

## Quick start (after Claude session restart)

```bash
cd ~/Developer/ai-browser-auditor

# First time only — installs Chromium if needed
npm run build

# Cheapest sanity check: $0 (no LLM calls)
npx ai-audit run --project projects/talkbuddy --scenario 00-infra-smoke

# Full audit — estimated ~$1.50
npx ai-audit run --project projects/talkbuddy

# Single scenario against one persona
npx ai-audit run --project projects/talkbuddy \
  --scenario 03-paywall-enforcement \
  --persona cn-chinese-free-mobile
```

From inside Claude Code (once the MCP tool is injected):

```
audit_url(
  url: "https://talkbuddy.wayjet.io",
  persona: "cn-chinese-free-mobile",
  scenario: "projects/talkbuddy/scenarios/03-paywall-enforcement.yaml",
  budget_usd: 0.8
)
```

## Scenarios

| # | Scenario | Priority | Target commits |
|---|---|---|---|
| 00 | Infra smoke (no LLM, $0) | P0 | — |
| 01 | Landing first impression + a11y | P0 | 27809a12, 4af7f66 |
| 02 | Email signup + Google OAuth | P0 | 4af7f66 |
| 03 | Free-tier paywall (scene 4+) | P0 | 1e57dd9, e2e82f0 |
| 04 | 8-step onboarding with destination | P1 | 0860359 |
| 05 | Plan Tab trip-timeline | P1 | 0860359 |
| 06 | Site-wide zh/en localization | P1 | (all i18n-adjacent) |

## Personas in rotation

| id | Who | Why this project |
|---|---|---|
| `cn-chinese-free-mobile` | 王伟 (28, 深圳) | **Core target market** — free, mobile, CN |
| `tw-chinese-pro-tablet` | 台湾 pro, tablet | Paid zh user (different CN variant) |
| `us-english-free-mobile` | US free | Tests native EN + paywall UX |
| `jp-japanese-pro-desktop` | 日本 pro | i18n fallback (ZH/EN), paid |
| `in-hindi-free-android` | 印度 Android low-end | Perf edge case — slowest network/CPU |
| `uk-english-power-desktop` | UK desktop pro | UK-destination scene coverage |

## What this does NOT cover

- **Subscription checkout UI**: requires Stripe test-mode key. See
  `docs/ops/stripe-webhook-local.md` in the TalkBuddy repo. The
  Playwright spec `e2e/payment-flow.spec.ts` handles this.
- **Mobile native apps**: Capacitor iOS/Android builds are out of
  scope for a browser auditor.
- **Admin panel**: requires `ADMIN_SECRET` auth. Add a dedicated
  scenario once an audit persona is provisioned with a session
  token. For now, Playwright audit-regressions.spec.ts covers the
  API-level CSRF + tier-management assertions.

## Updating when new commits land

Each scenario file's `goal:` header calls out the commit SHA it
validates. Whenever you ship a UX-relevant commit:

1. Append the commit SHA to the relevant scenario's `goal:`.
2. Bump `config.yaml::budget_usd` if you add a long scenario.
3. Re-run: `npx ai-audit run --project projects/talkbuddy` and diff
   the new report against the last one under `reports/`.

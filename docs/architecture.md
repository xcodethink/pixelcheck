# Architecture

## Layer cake

```
┌──────────────────────────────────────────────────────────────────┐
│  CLI (commander)  ──────────────────────────────────────────────  │
├──────────────────────────────────────────────────────────────────┤
│  Runner (concurrency, throttle, budget, lifecycle)                │
├──────────────────────────────────────────────────────────────────┤
│  Step handlers (visit / act / extract / observe / wait_for /     │
│    assert_visual / assert_dom / check_email / screenshot /       │
│    computer_use / custom)                                         │
├──────────────────────────────────────────────────────────────────┤
│  Core services                                                    │
│  ├─ Stagehand wrapper  (Stagehand 2.5 + post-init stealth)       │
│  ├─ Computer Use loop  (Playwright-backed action handlers)       │
│  ├─ Vision critic      (Claude vision + 5-dim scoring)           │
│  ├─ Recorder           (video, HAR, console, sha256 screenshots) │
│  ├─ Visual diff        (odiff baseline regression)               │
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

## Failure handling

| Failure type | Action |
|---|---|
| `act()` throws after retries | If step has `fallback: computer_use`, escalate to a Computer Use task to recover; otherwise mark step as fail |
| Network 4xx | Don't retry, mark fail |
| Network 5xx / timeout | Retry with exponential backoff (`stealth-core/retry.ts`) |
| Bot challenge page detected | Retry (caller can swap fingerprint) |
| Critical step fails | Abort the scenario |
| Scenario crashes | Add a critical issue, mark fail |
| Critic returns malformed JSON | Add a low-severity warning, don't crash |
| Computer Use loop hits max iterations | Return whatever finalText was last seen |

## Reports

Three formats from one source of truth:

- `audit.json` — machine-readable, for CI parsers, dashboards, history
- `audit.html` — dark theme, embedded screenshots, per-scenario sections, score chips, issue lists
- `summary.md` — terminal-friendly, for git commit messages, Slack pastes

All three pass through the redaction layer (`secrets.redactDeep`) before being written.

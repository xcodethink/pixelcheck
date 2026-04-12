# Architecture

## Layer cake

```
┌──────────────────────────────────────────────────────────────────┐
│  CLI (commander)  ──────────────────────────────────────────────  │
├──────────────────────────────────────────────────────────────────┤
│  Runner (concurrency, throttle, budget, lifecycle)                │
├──────────────────────────────────────────────────────────────────┤
│  Step handlers (visit / act / extract / observe / wait_for /     │
│    assert_visual / assert_dom / assert_a11y / check_email /      │
│    screenshot / computer_use / custom)                            │
├──────────────────────────────────────────────────────────────────┤
│  4-Layer Reliability Stack (act/extract/observe steps)            │
│  ├─ L1: Page Stability Gate  (network idle + DOM stable + hydration) │
│  ├─ L2: Instruction Mutation (rephrase / decompose / specify)    │
│  ├─ L3: Selector Hint        (direct Playwright fallback)        │
│  └─ L4: Auto Computer Use    (Sonnet lightweight / Opus critical)│
├──────────────────────────────────────────────────────────────────┤
│  Core services                                                    │
│  ├─ Stagehand wrapper  (Stagehand 2.5 + post-init stealth)       │
│  ├─ Computer Use loop  (Playwright-backed action handlers)       │
│  ├─ Vision critic      (Claude vision + 5-dim scoring)           │
│  ├─ axe-core engine    (WCAG accessibility analysis)             │
│  ├─ Recorder           (video, HAR, console, sha256 screenshots) │
│  ├─ Visual diff        (odiff baseline regression)               │
│  ├─ History            (SQLite trend tracking + run comparison)   │
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

## 4-Layer Reliability Stack

The reliability stack targets 98-99% step success rate (up from ~75% with Stagehand alone). Each layer only fires when the previous one fails:

```
Request arrives at handleAct()
  │
  ��── L1: waitForPageStable()           ← network idle + DOM stable + hydration
  │     Prevents operating on pages still loading/hydrating.
  │     Cost: 0. Latency: 0-8s (typically <1s).
  │
  ├── L2: stagehand.act(instruction)    ��� primary Stagehand semantic action
  │     If success → return
  │     If fail → cascade
  │
  ├── L3a: Selector Hint                ← direct Playwright click via step.selector_hint
  │     If selector_hint exists and element is visible → click → return
  │     Cost: 0. No LLM call.
  │
  ├── L3b: Instruction Mutation         ← rephrase/decompose/specify the instruction
  │     Uses DOM context to generate targeted variants.
  │     Tries each variant with Stagehand in order.
  │     Cost: 0 (local string manipulation, no LLM call).
  │
  └── L4: Computer Use                  ← autonomous pixel-level fallback
        Non-critical: Sonnet, 3 iterations (cheap, fast)
        Critical: Opus, 8 iterations (thorough)
        Cost: $0.01-0.15 per invocation.
```

**Expected reliability uplift:**

| Layer | Mechanism | Estimated Uplift |
|-------|-----------|-----------------|
| L1    | Page stability gate | +10% (eliminates timing failures) |
| L2    | Stagehand primary | baseline 75% |
| L3a   | Selector hint | +5% (when hints provided) |
| L3b   | Instruction mutation | +5% (rephrase/decompose) |
| L4    | Computer Use | +3-4% (catches remaining edge cases) |
| **Total** | | **~98-99%** |

### Execution method tracking

Every `StepResult` now includes an `execution_method` field:
- `"stagehand"` — primary path succeeded
- `"selector_hint"` — Layer 3a direct Playwright fallback
- `"instruction_mutation"` — Layer 3b rephrased instruction succeeded
- `"computer_use"` — Layer 4 autonomous fallback

The CLI prints a reliability breakdown after each run.

## axe-core Accessibility Audit

The `assert_a11y` step type injects [axe-core](https://github.com/dequelabs/axe-core) into the page and runs WCAG analysis:

```yaml
- id: a11y-homepage
  type: assert_a11y
  standard: wcag2aa
  exclude: [".cookie-banner", ".third-party-widget"]
  max_violations: 0
  impact_filter: [critical, serious]
```

This complements the Vision Critic:
- **axe-core** catches rule-based WCAG violations (ARIA attributes, contrast ratios, form labels, keyboard navigation, alt text)
- **Vision Critic** catches visual accessibility issues (text too small, buttons too close, layout confusion, poor visual hierarchy)

Violations are converted to the auditor's Issue format with severity mapping:
- `critical` (axe) → `critical` (issue)
- `serious` (axe) → `high` (issue)
- `moderate` (axe) → `medium` (issue)
- `minor` (axe) → `low` (issue)

An accessibility dimension score is automatically computed and added to the critic results.

## Historical Trend Tracking

Every audit run is saved to `reports/history.db` (SQLite via better-sqlite3):

```
reports/
├── history.db                  ← persistent trend database
├── 2026-04-11_143022_manual/   ← individual run artifacts
└── 2026-04-12_091500_manual/
```

**Schema:** `audit_runs` (summary stats), `dimension_scores` (per-unit per-dimension), `issues_history` (all issues).

**CLI commands:**
- `ai-audit history` — show recent runs in a table
- `ai-audit diff <runA> <runB>` — compare two runs (score deltas, new/resolved issues)
- `ai-audit run --min-score 7.5` — quality gate (fail build if score < threshold)

**HTML report integration:** when trend data exists, the report includes an SVG sparkline chart showing overall score across the last 20 runs, plus a history table.

## Failure handling

| Failure type | Action |
|---|---|
| `act()` throws | Cascade through 4-layer reliability stack; mark fail only if all layers exhausted |
| Network 4xx | Don't retry, mark fail |
| Network 5xx / timeout | Retry with exponential backoff (`stealth-core/retry.ts`) |
| Bot challenge page detected | Retry (caller can swap fingerprint) |
| Critical step fails | Abort the scenario |
| Scenario crashes | Add a critical issue, mark fail |
| Critic returns malformed JSON | Add a low-severity warning, don't crash |
| Computer Use loop hits max iterations | Return whatever finalText was last seen |
| axe-core critical violations | Mark step as fail |
| axe-core serious violations | Mark step as warn |

## Reports

Three formats from one source of truth, plus persistent history:

- `audit.json` — machine-readable, for CI parsers, dashboards, history
- `audit.html` — dark theme, embedded screenshots, per-scenario sections, score chips, issue lists, SVG trend chart
- `summary.md` — terminal-friendly, for git commit messages, Slack pastes
- `history.db` — SQLite database for trend tracking across runs

All report formats pass through the redaction layer (`secrets.redactDeep`) before being written. The HTML report automatically includes trend data when the history database contains >= 2 runs for the project.

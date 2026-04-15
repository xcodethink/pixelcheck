# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — v0.3 development

### Added — Week 1: Signal-based convergence + cost-optimized agent

- **4-dimensional success criteria** — `SuccessCriterion.verification` extended with:
  - `network` — assert HTTP request(s) matching url/method/status/duration
  - `performance` — assert Core Web Vitals (LCP/CLS/INP/FCP/TTFB) thresholds
  - `error` — assert bounded console errors / pageerrors / request failures (with `ignore_patterns` for known noise)
  - `interaction` — assert an action actually changed page state (URL / title / interactive DOM / visible text / scroll / focus)

  This defeats the "optimistic success" agent failure where a click reports success but nothing happened or the backend returned 500.
- **Signal collectors** (`src/agent/signals/`) — zero-LLM-cost measurement primitives:
  - `NetworkSignalCollector` — Playwright request/response tracking, `findMatching()` query API
  - `PerformanceSignalCollector` — PerformanceObserver-injected web-vitals capture
  - `ErrorSignalCollector` — console / pageerror / 4xx-5xx static resources, ignore patterns
  - Interaction snapshot+diff functions
  - All four attached per-action in autonomous mode; `StepResult.signals` carries per-step snapshots
- **Plan cache** (`~/.ai-browser-auditor/plan-cache.db`) — SQLite store for reusable autonomous plans
  - Keyed on (scenario_id, persona_class, host, dom_skeleton) — cosmetic changes don't invalidate
  - 7-day TTL; auto-retires after ≥3 failures outweighing successes
  - Disable with `AUDIT_PLAN_CACHE_DISABLED=1`
  - Expected hit rate: 60–80% on repeated runs against the same site
- **Economy navigator tier** — Haiku primary + Sonnet escalation
  - `cost_mode: 'max' | 'balanced' | 'economy'` (default `'balanced'`) in ProjectConfig
  - `balanced`: Haiku primary, Sonnet only when confidence < 0.6 or needs_replan
  - `economy`: Haiku only
  - `max`: legacy v0.2 behavior (always Sonnet)
  - Override per-run: `AUDIT_COST_MODE=economy`
  - Expected: ~3–5× cheaper per action at comparable success rate
- **Micro-replan** — cheap single-step recovery before triggering a full Sonnet replan
  - On stuck convergence, Haiku rewrites / skips / escalates the failing step
  - ~15× cheaper than a full replan; capped at 2 attempts per plan
- **Local fixture test site** (`tests/fixtures/test-site/`) — hermetic integration testing
  - 5 static HTML fixtures + in-process HTTP server with canned JSON APIs
  - Backs `tests/integration/` — full signal + convergence validation without external network

### Changed

- `ProjectConfig.models` adds `navigator_economy` (default Haiku 4.5)
- `ProjectConfig` adds `cost_mode` field (default `'balanced'`)
- `StepResult` adds optional `signals` field for per-step snapshots
- CLI `explore` command now parses config through `ProjectConfigSchema` so defaults populate

### Tests

- 83 new tests across 7 new files (signals/*, convergence-signals, plan-cache, navigator-economy, micro-replan, signals-e2e, agent-loop-e2e)
- Full suite: **174 tests pass** (up from 87 at branch start)
- `tsc --noEmit` clean
- No breaking changes: all new fields are additive + optional

## [0.2.0] - 2026-04-12

### Added

- **4-Layer Reliability Stack** (target: 98-99% step success rate)
  - Layer 1: Page Stability Gate — waits for network idle, DOM stable, framework hydration before AI actions
  - Layer 2: Instruction Mutation — on Stagehand failure, rephrases/decomposes/specifies the instruction using DOM context
  - Layer 3: Selector Hint — optional `selector_hint` field per step for direct Playwright fallback before Computer Use
  - Layer 4: Auto Computer Use fallback — `fallback` now defaults to `"computer_use"` (lightweight Sonnet for non-critical, Opus for critical)
- **axe-core WCAG Accessibility Audit** — new `assert_a11y` step type
  - Injects axe-core into the page, runs against configurable WCAG standard (wcag2a/wcag2aa/wcag2aaa/wcag21aa/wcag22aa/best-practice)
  - Supports `exclude` patterns, `impact_filter`, and `max_violations` threshold
  - Produces structured violation reports with WCAG tag references
  - Complements Vision Critic: axe-core catches rule-based violations, Vision catches visual accessibility issues
- **Historical Trend Tracking** — SQLite-backed audit history (`reports/history.db`)
  - `ai-audit history` command shows recent runs with scores, pass rates, and costs
  - `ai-audit diff <runA> <runB>` command compares two runs with score deltas, new/resolved issues
  - HTML report now includes SVG sparkline trend chart for the last 20 runs
- **Quality Gate** — `--min-score <n>` CLI option fails the build if overall score is below threshold
- **Execution Method Tracking** — `StepResult.execution_method` field tracks which reliability layer succeeded
- **Reliability Breakdown** — CLI prints reliability stack stats on completion
- `accessibility` added to `scoring_dimensions` enum
- **Multi-project support**: `--project <dir>` flag loads config + scenarios from any directory
- **`ai-audit init` command**: scaffolds a new project audit directory with template files
- **Project layout**: `projects/scamlens/` as the first project using the new structure
- **CI multi-project dispatch**: workflow accepts project selection (built-in or external repo)
- **12 new personas** (18 total) covering global markets:
  - India (Hindi, budget Android), Korea (Korean, QHD desktop), Vietnam (Vietnamese, Android)
  - Russia (Cyrillic, Windows), Nigeria (English, budget Tecno), Mexico (Spanish LATAM, Android)
  - Indonesia (Bahasa, Android), Thailand (Thai, small iPhone SE), Taiwan (Traditional Chinese, iPad)
  - France (French, iPhone), UK enterprise (English, Power tier security analyst)
  - US elderly (72yo retired teacher, iPad — #1 scam target demographic)
- **Coverage matrix**: 15 countries, 13 languages, 5 script systems (Latin/CJK/Arabic/Cyrillic/Devanagari), 3 device classes, 3 payment tiers
- **Scenario persona expansion**: domain-check now runs all 18 personas, localization audit covers 14 non-English personas

### Changed

- `fallback` default changed from `undefined` to `"computer_use"` — all steps now auto-fallback
- `handleExtract` and `handleObserve` now include stability gate
- HTML report step trace shows `via=` tag when a non-primary execution method was used

### Dependencies

- Added `axe-core` (^4.x) — WCAG accessibility engine
- Added `better-sqlite3` (^11.x) — local audit history storage

## [0.1.1] - 2026-04-11

### Fixed

- Vision audit pipeline hardened: 3 root-cause framework bugs resolved
  - Critic scoring no longer fails silently when screenshot capture times out
  - Recorder correctly handles concurrent video + HAR streams without race condition
  - Reporter gracefully degrades when partial step data is missing

## [0.1.0] - 2026-04-11

### Added

- **Core engine**: Stagehand 2.0 + Claude vision hybrid execution pipeline
- **6 personas**: US/JP/DE/CN/BR/SA spanning mobile/desktop/tablet, Free/Pro/Power tiers
- **9 scenarios**: infra smoke, OAuth signup, domain check, admin audit, localization sweep, crypto trace, investigation v2, email opt-in, Chrome extension
- **Claude vision critic**: 5-dimension scoring (completion, localization, visual_polish, trust_signals, time_to_value)
- **Computer Use escalation**: Playwright-backed pixel-level review for critical steps
- **Recording**: video (WebM), HAR network log, console errors, SHA-256 hashed screenshots
- **Reporting**: JSON (machine) + HTML (dark theme dashboard) + Markdown (terminal)
- **Concurrency control**: parallel persona x scenario matrix with same-origin throttling via p-limit
- **Budget cap**: stops new audit units when cumulative LLM cost exceeds threshold
- **Retry strategies**: per-step exponential backoff with fingerprint rotation fallback
- **Visual regression**: odiff-bin pixel diff with baseline management
- **Email verification**: mail.tm temporary inbox integration for signup flows
- **Notifications**: Slack webhook + Telegram bot on completion
- **CI workflow**: GitHub Actions post-deploy-audit.yml (artifact upload, PR comment, exit codes)
- **Stripe safety**: refuses to start if `pk_live_` keys detected in env
- **Documentation**: architecture guide, scenario authoring guide, persona design guide, CI integration guide

[0.2.0]: https://github.com/xcodethink/ai-browser-auditor/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/xcodethink/ai-browser-auditor/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/xcodethink/ai-browser-auditor/releases/tag/v0.1.0

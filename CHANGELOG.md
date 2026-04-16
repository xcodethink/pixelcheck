# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — v0.3 development

### Added — Weeks 3-5: Observer + Report SPA + MCP + Memory + Persona gen + Recorder

**Observer UX (Week 3)**
- **Timeline scrubber** in the live observer — every action / plan / criterion
  rendered as a clickable step with color-coded status. Click any step to
  open a right-side drawer showing meta, related events, and reasoning.
  Auto-refresh debounced to 500ms on new events.
- **Multi-session grid** (`/grid` route) — when a run executes N units in
  parallel, each gets its own child SessionStore demultiplexed by
  `session_id`. Grid tile shows status badge, 3 metrics (cost / steps /
  fails), and the last-step label. 2-second polling; new sessions tile in
  automatically.
- **Session history API** — `GET /api/timeline`, `GET /api/events/all`,
  `GET /api/screenshot?seq=`, `GET /api/session/:id` — backing APIs that
  power the scrubber. Exposed as public HTTP so external tooling can
  consume them.

**Interactive Report (Week 3)**
- **`audit-explorer.html`** written alongside `audit.html` on every run.
  Self-contained single-file SPA with:
  - Filter bar (persona × scenario × status × dimension-score ceiling ×
    issue severity)
  - Per-unit expandable cards with 18-dim score grid, step table with
    gantt-style timing bars, issue browser
  - XSS-hardened JSON embed (`<script type=application/json>` + `<`/`>`
    escape), redaction-aware
  - No build step, no runtime deps — works on file:// protocol

**MCP Server (Week 4)**
- **`ai-audit-mcp`** — stdio MCP server exposing 6 tools:
  - `audit_url` / `explore_url` / `list_personas` / `list_scenarios`
    / `calibrate_critic` / `get_last_report`
- Registers in any MCP-aware client (Claude Code, Cursor, Cline,
  Continue, Zed) via `~/.mcp.json`. Lets agents run audits inline
  without leaving their workflow.

**Agent Memory (Week 4)**
- **Per-site playbooks** stored in `~/.ai-browser-auditor/memory.db`.
  Each fact keyed on (host, persona_class) with confidence, confirmations,
  contradictions, TTL.
- Loaded facts feed the planner prompt as hints on first plan — speeds
  convergence on repeat visits.
- `AgentMemory.record()` is idempotent on same fact; confidence grows
  +0.05 per hit (capped 0.99). Contradictions decrement by 0.2; facts
  with more contradictions than confirmations drop out of lookup.
- Shared-DB location with plan cache. 30-day TTL default.
- Disable with `AUDIT_MEMORY_DISABLED=1`.

**Persona Data Pipeline (Week 5)**
- **`ai-audit persona generate --country=BR --device=mobile`** —
  deterministic persona-YAML generator.
- Backed by `src/persona-gen/market-data.ts` — curated Country Profile
  table for 17 countries covering device split / mobile OS split /
  language / timezone / p50 latency / typical payment tier. Values
  from StatCounter + Cloudflare Radar + Ookla Q1 2026.
- Auto-derives viewport, mental_model, critical_concerns (low-bandwidth /
  RTL / GDPR / low-end Android) from country profile.
- Generated YAMLs round-trip through `PersonaSchema`.
- `ai-audit persona list-countries` prints the supported set.

**Scenario Recorder (Week 5)**
- **Chrome MV3 extension** (`extensions/scenario-recorder/`) —
  click-through recording of user interactions → scenario YAML export.
- Privacy-hardened: password fields skipped, long values truncated,
  no network calls.
- Canonical selector derivation: `data-testid` → stable id → aria-label
  → `:has-text()` → nth-child fallback.
- Auto-appends `assert_visual` step so recorded scenarios score output.
- Pure compile logic in `src/recorder-core.ts` is unit-tested (13 tests);
  round-trips through `ScenarioSchema`.

### Changed — Weeks 3-5

- `package.json` adds `@modelcontextprotocol/sdk` + bin `ai-audit-mcp`
- `src/index.ts` re-exports `writeSpaReport`
- `src/cli.ts` adds `persona generate` + `persona list-countries`
- `StepResult.signals` field is now populated on every autonomous action
- Full test suite: 299 tests (up from 226 end of Week 2)

### Added — Week 2: Benchmark harness + Critic calibration

- **WebArena-compatible benchmark runner** (`ai-audit benchmark`) —
  ingests WebArena-shaped task JSON (`task_id`, `intent`, `start_url`,
  `eval`) and runs each through the autonomous agent, emitting pass@1 +
  cost + duration metrics directly comparable with published Browser Use /
  Skyvern scores.
  - Evaluation predicates: `string_match` (must_include/exclude/exact/fuzzy),
    `url_match` (exact/prefix/substring), `exact_match`, `program_html`
  - Filters: `--difficulties easy,medium,hard`, `--tags`, `--limit`
  - Budget caps: `--per-task-budget`, `--total-budget` (stops scheduling
    new tasks when exceeded)
  - Outputs `benchmark.json` (machine-readable) + `benchmark.md` (human)
  - `benchmarks/local-mini/` ships 3 starter tasks running against the
    local fixture site — CI-stable, zero external deps
- **Critic calibration suite** (`ai-audit calibrate`) — detects drift
  when Anthropic ships a new vision model or when critic prompts change.
  - Each sample labels expected score RANGES per dimension (not point
    scores) — acknowledges LLM variance, measures directional correctness
  - CI gate thresholds (defaults): mean_agreement ≥ 0.85,
    mean_max_distance ≤ 1.5, fully_aligned_rate ≥ 0.70
  - `tests/fixtures/critic-calibration/` ships 5 labeled screenshots
    (happy home, post-signup success, broken page, CLS page, slow-LCP)
  - `tests/calibration/generate-fixtures.ts` regenerates screenshots when
    the fixture site changes

### Changed — Week 2

- `src/cli.ts` adds `benchmark` and `calibrate` subcommands (no changes
  to existing commands)
- Full test suite: 226 tests (up from 174 at end of Week 1)

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

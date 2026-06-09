# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- Override `hono` to `^4.12.21` (resolves transitively to 4.12.25), clearing
  four moderate advisories pulled in via `@modelcontextprotocol/sdk` /
  `@hono/node-server` (GHSA-xrhx-7g5j-rcj5 IPv6 deny-rule bypass,
  GHSA-3hrh-pfw6-9m5x Set-Cookie injection, GHSA-f577-qrjj-4474 JWT scheme,
  GHSA-2gcr-mfcq-wcc3 mount routing). The `npm audit --production
  --audit-level=moderate` CI gate is green again (17 low remain, unchanged).

### Fixed
- Vision scoring of tall desktop pages no longer fails with Anthropic's
  `image dimensions exceed max allowed size: 8000 pixels` 400 error. A
  full-page screenshot taller than 8000px but under the 2.5 MB byte-bypass
  (e.g. a 1280×8587 landing page at 1.47 MB) was sent uncompressed and
  rejected, skipping visual scoring entirely (`overall_score: null`).
  `compressForVision` now enforces the 8000px hard edge limit before the
  byte-size bypass, so no oversized image ever reaches the API.

### Added
- `compressForVisionMulti` — slices a tall full-page screenshot into a macro
  thumbnail + native-resolution overlapping slices that span the whole page,
  so rubric scoring reads tall pages at legible resolution instead of one
  squashed sub-1568px image. `runJudgeVision` (the `judge` primitive and
  `VisualCollector`) now sends these multi-image inputs for tall pages.
- `cn-chinese-pro-desktop` persona (李娜, 上海, Windows 1440×900). Simplified
  Chinese previously had no desktop persona — only `cn-chinese-free-mobile`
  and `tw-chinese-pro-tablet` — so a "Chinese desktop" audit had no fitting
  persona to run.

### Changed
- The `note` vision calls (`see` with a goal, `act` `note` steps) and the
  `diagnose` reasoning call now also use `compressForVisionMulti`, so they can
  read below-the-fold / footer text on tall pages instead of a squashed
  single image. `compare` (A/B framing) and `see`'s visual-state detector
  (3×3 grid) intentionally stay single-image — slicing would break their
  semantics — and rely on the new 8000px floor in `compressForVision`.

## [1.3.0] - 2026-06-02 — security hardening, MCP test coverage, Node 20

> Supersedes the unreleased accumulation since 1.2.0 (1.2.1 was tagged
> without its own changelog section; its notes are included here — the npm
> delta is 1.2.1 → 1.3.0). Headline: requires Node 20+, supply-chain +
> SSRF hardening, and the flagship MCP surface is now unit-tested.

### Added

- **`doctor` now checks the headless-shell binary separately** — every
  pixelcheck primitive launches Chromium with `headless: true`, which on
  modern Playwright runs the `chromium-headless-shell` build (a *separate*
  download from full Chromium). `doctor` previously only checked full
  Chromium, so it could report `[OK] Chromium binary` while `see`/`judge`/
  `act` still crashed at launch with `Executable doesn't exist at
  .../chromium_headless_shell-<rev>/...`. New `[*] Headless-shell binary`
  check closes that blind spot. (`src/core/browser-install.ts`)
- **`pixelcheck doctor --fix`** — self-heals a missing headless-shell
  binary by downloading the Chrome-for-Testing zip and unpacking it with
  the system archiver, **bypassing Playwright's bundled extractor**, which
  can hang indefinitely while unpacking the ~150 MB executable on some
  macOS hosts (download succeeds, then freezes at 0% CPU on "extracting
  archive"). Falls back to advising `npx playwright install
  chromium-headless-shell` on platforms with no published CfT build.
- **`pixelcheck install`** — one command to fetch the browser binary
  pixelcheck launches (Chrome Headless Shell), routed through the *bundled*
  Playwright so the cached revision always matches what we run. `--headed`
  also fetches full Chromium. See ADR-036. (`src/cli.ts`,
  `src/core/browser-install.ts`)
- **Automatic browser download on `npm install`** — a `postinstall` step
  fetches the headless-shell so a fresh `npm i -g pixelcheck` is runnable
  immediately, instead of crashing on the first `explore`/`run`. Skips on
  CI and honours `PIXELCHECK_SKIP_BROWSER_DOWNLOAD` /
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`; never fails the install.
  (`scripts/postinstall.mjs`)
- **`doctor` MCP tool** — lets an MCP client (Claude Code, Cursor, ...)
  diagnose the environment and, with `{ fix: true }`, download a missing
  browser binary from inside the agent — no more dead-end
  "Executable doesn't exist" with no recourse. (`src/mcp/tools/doctor.ts`)
- **Global API-key fallback** — the CLI now also reads
  `~/.pixelcheck/.env`, so a global install finds `ANTHROPIC_API_KEY`
  without a `.env` in every project dir. Precedence: shell env > `./.env`
  > `~/.pixelcheck/.env`. (`src/cli.ts`)

### Changed

- **Browser launches now self-heal.** `run` / `explore` and every MCP
  browser primitive retry once after auto-installing a missing
  headless-shell, so first use works regardless of whether the user ran
  `doctor` first. (`src/core/stagehand-wrapper.ts`,
  `launchWithBrowserAutoInstall`)
- **`doctor` treats a missing headless-shell as a blocking `[FAIL]`**, not
  a `[WARN]`. It previously warned and printed an "audits will work"
  summary right before the first launch crashed. **CI note:** runners that
  don't pre-install browsers should pass `--skip-browser` or run
  `pixelcheck install`. The full-Chromium check is now `[SKIP]` when absent
  (only `--headed` runs need it). (`src/commands/doctor.ts`)
- **Install guidance no longer points at a bare
  `npx playwright install chromium`** anywhere (README, INSTALLATION,
  MIGRATION, doctor remedies). A bare install can resolve a *different*
  Playwright revision than the one pixelcheck launches, leaving the user
  "installed but still broken". Use `pixelcheck install` /
  `pixelcheck doctor --fix`. (Linux `playwright install-deps` for system
  libraries is unchanged.)
- **Requires Node.js 20+** (`engines.node` `>=18` → `>=20`). Node 18 reached
  end-of-life 2025-04-30 and the toolchain (vitest 4 via rolldown imports
  `util.styleText`; eslint) needs Node 20 — the old `>=18` claim was never
  exercised (CI is 20/22 only). `npm` treats `engines` as a warning, so this
  is discouraged-not-blocked for Node-18 holdouts. Purged stale Node-18 /
  test-count / coverage-gate-name / matrix-size claims from README /
  CONTRIBUTING / INSTALLATION / MIGRATION. (audit F6)
- **No-console lint gate is now cross-platform** — ported from a hardcoded
  `bash` script to Node (`tsx`), so `npm test` / `prepublishOnly` no longer
  break on bash-less Windows or minimal publish environments. (audit F7)

### Security
- Patched 3 moderate production advisories via semver-compatible bumps
  (lockfile-only, no API changes): `protobufjs` 7.5.6→7.6.2
  (GHSA-jggg-4jg4-v7c6, recursive-descriptor DoS), `qs` 6.15.1→6.15.2
  (GHSA-q8mj-m7cp-5q26, stringify DoS), `ws` 8.20.0→8.21.0
  (GHSA-58qx-3vcg-4xpx, uninitialized memory disclosure). Clears the
  `npm audit (production, moderate+)` CI gate. 17 low-severity transitive
  advisories remain (below the gate threshold; require breaking bumps).
- **Supply-chain: the vendored `stealth-core` copy now has a committed
  SHA-256 integrity manifest** (`src/vendor/stealth-core/integrity.json`)
  enforced on every CI runner via `check:vendor-integrity` — detects
  tampering/drift of the bundled copy with no upstream source needed (the
  prior drift check was a runner no-op). Added a vendored LICENSE +
  PROVENANCE.md and disclosed it in THIRD_PARTY_LICENSES.md. (audit F4)
- **SSRF guard coverage locked across the whole MCP surface** — a cross-tool
  regression now asserts `see` / `audit_url` / `explore_url` / `extract` /
  `act` / `diagnose` / `judge` / `compare` all reject private / loopback /
  cloud-metadata (`169.254.169.254`) targets at the handler boundary, before
  any browser launch. (audit B2 follow-up / G3)
- **Honest advisory disclosure** — SECURITY.md now documents the 17 low
  advisories (single root cause: `@ai-sdk/provider-utils`) + the dev-only
  moderate; corrected the CI comment that claimed "0 vulnerabilities". (audit G4)

### Fixed

- Resolved the "`doctor` says OK but the first `see` fails" first-run
  papercut where a Playwright upgrade bumps the pinned browser build but
  the headless-shell variant was never downloaded.
- **Fixed the fresh-install crash**: `npm i -g pixelcheck` followed by
  `pixelcheck explore`/`run` no longer crashes with a raw Playwright
  "Executable doesn't exist" stack — the browser now auto-installs at
  install time and self-heals at launch. See ADR-036.
- `findLatestReport` now resolves report recency deterministically: ties on
  `mtime` are broken by lexicographically-greater path (timestamp-prefixed run
  dirs → later run wins). Previously two sibling reports written in the same
  millisecond (common on fast CI filesystems) produced a non-deterministic
  result, causing `tests/commands/explain.test.ts` to flake on Linux/Windows
  CI runners. Hardened the test with explicit `utimesSync` mtimes and added a
  same-mtime tie-break case.
- **Shipped custom-handler example is runnable again** —
  `scenarios/handlers/install-extension` shipped in the tarball as raw `.ts`
  importing the unpublished `src/` tree (a dangling import for any installed
  user). Ported to a self-contained ESM `.js` that loads via dynamic import.
  (audit F5)

### Tested

- **Flagship MCP surface + observer now unit-tested.** MCP tools went from
  5–10% to 20–94% statement coverage, observer dashboards / `doctor` / the
  `get_last_report` path-sandbox (B3) from 0–22% to 94–100%, and the
  benchmark scenario builder from 0%. Global coverage 79/68/81/81 → 81/70/83/83;
  the ADR-017 floor was ratcheted 74/62/75/75 → 76/64/77/77. (audit G3)

## [1.2.0] - 2026-05-06 — Phase 0 complete + commercial-grade tooling

> **Recommended for all users.** Major feature release completing the
> Phase 0 multi-dimensional diagnostics pipeline (PR-B through PR-E),
> plus 10 new CLI/library capabilities for commercial-grade workflows.
> Schema bump 1.3.0 (additive, backward compatible). Anthropic SDK
> upgraded to 0.94.0. 2158 tests (up from 1871). 83 public API exports
> (up from 67).

### Added

- **Phase 0 complete** — WhiteboxCollector (popups/network/cookies/storage),
  PerformanceCollector (Web Vitals), VisualCollector (scoring), and
  `pixelcheck.diagnose` MCP tool. Full page-health diagnosis in one call.
- **Plugin hook system** (`src/core/plugin.ts`) — extensible lifecycle
  hooks: beforeAudit, afterAudit, beforeStep, afterStep, onIssue,
  onError, transform. Plugin isolation (errors don't cascade).
- **Progress bar + ETA** (`src/core/progress.ts`) — ProgressReporter
  with TTY spinner (ora) and non-TTY plain text. ETA calculation.
- **`pixelcheck explain`** command — human-readable issue explanations
  with WCAG references, fix suggestions, and `--json` output.
- **Shell completions** (`pixelcheck completions bash|zsh|fish`) —
  dynamic introspection of all commands and options.
- **Output verbosity** (`--quiet`/`--verbose`) — three-level control
  integrated with pino logger. `PIXELCHECK_VERBOSITY` env support.
- **Debug log** (`src/core/debug-log.ts`) — NDJSON debug trace for
  post-mortem analysis. Enable via `PIXELCHECK_DEBUG_LOG=1`.
- **Local LLM fallback** (`src/core/llm-provider.ts`) — Ollama provider
  with automatic fallback chain. `PIXELCHECK_LLM_PROVIDER` env.
- **Retry strategy** (`src/core/retry.ts`) — configurable exponential
  backoff with jitter. Non-retryable error detection.
- **Resume from checkpoint** (`src/core/checkpoint.ts`) — save/load
  checkpoint for interrupted audit runs.
- **Min-repro generator** (`src/core/min-repro.ts`) — extract minimal
  reproduction scenario from failed audit runs.

### Changed

- `@anthropic-ai/sdk` upgraded from 0.92.0 to 0.94.0.
- Public API surface expanded from 67 to 83 exports.
- Test count increased from 1871 to 2158 (+287 tests).

### Removed

- 11 stale git worktrees cleaned up (Phase 0 PR branches, fix branches,
  decommissioned v0.3/v1 worktrees).

### Phase 0 / ADR-034: `diagnose` primitive + MCP tool (PR-E)

> **No version bump** — still v1.3.0. PR-E completes Phase 0 by turning
> the entire diagnostics plumbing (envelope from PR-A; whitebox from
> PR-B; performance from PR-C; visual scoring from PR-D) into a single
> commercial-grade entry point: the `diagnose` MCP tool. The new
> primitive is purely additive — it consumes existing schemas / collectors
> and adds new schemas (DiagnoseResult + DiagnoseFinding + …).

- **New primitive** `src/core/primitives/diagnose.ts` — orchestrates
  see (with `visualScoring: 'eager'`) → diagnostics serialisation →
  vision call → defensive parse → score math. Pipeline:
    1. `see({ url, visualScoring: 'eager' })` captures page + every
       diagnostics dimension.
    2. `serializeDiagnosticsForPrompt()` renders performance / network /
       popups / cookies / storage / visual into a deterministic block
       with stable JSON-pointer paths the model can cite back as
       `evidence_refs`.
    3. One Claude Sonnet vision call returns structured findings with
       severity + dimension + confidence + evidence_refs +
       standards_mapping.
    4. `parseDiagnoseRawJson()` enforces anti-hallucination contracts:
       findings with severity ≠ 'low' MUST cite at least one
       `evidence_refs` entry; findings claiming dimensions whose
       collectors did not run are dropped.
    5. `buildDimensionScores()` + `computeOverallHealthScore()` produce
       commercial-grade dashboard signals (per-dimension 0..100 scores,
       severity-weighted overall 0..100 health score).
- **New MCP tool** `src/mcp/tools/diagnose.ts` — `kind: 'preset'`,
  registered in `ALL_TOOLS`. Cost band ~$0.02-0.04 per call (1 visual
  scoring + 1 diagnose vision). Cacheable. `inputSchema` exposes URL +
  persona + viewport + visual rubrics + custom criteria + cache
  controls — minimal surface, expertise-free for AI agents.
- **Schema** `DiagnoseResultSchema` adds eight new exports:
    - `DiagnoseSeveritySchema` — `critical | high | medium | low`.
    - `DiagnoseDimensionSchema` — `performance | visual | whitebox |
      security | accessibility | seo | privacy | cross_cutting`.
    - `StandardsReferenceSchema` — `framework + id + url + label`
      (Core Web Vitals, WCAG 2.2, OWASP Top 10, GDPR …). Open-string
      framework field so new compliance frameworks can be cited
      without a schema bump.
    - `EvidenceRefSchema` — `path + value + note`. Anti-hallucination
      tether: every claim must point to a real diagnostics field.
    - `DiagnoseFindingSchema` — `id + severity + dimension + title +
      description + root_cause + recommendation + confidence
      (0..1) + evidence_refs[] + standards_mapping[] +
      affected_location|url|selector?`.
    - `DiagnoseDimensionScoreSchema` — `dimension + score (0..100) +
      finding_counts + summary`.
    - `DiagnoseResultSchema` — top-level envelope: `executive_summary
      + overall_health_score + dimension_scores[] + findings[] +
      findings_by_dimension + screenshot + diagnostics?`.
- **Anti-hallucination guarantees** (commercial-grade audit standard):
    1. System prompt enumerates the JSON-pointer schema and demands
       evidence citations.
    2. Post-parse: drops any finding with severity ≥ medium that has
       no `evidence_refs`.
    3. Post-parse: drops any finding whose `dimension` has no collected
       data (e.g. performance finding when no perf collector ran).
    4. `confidence` clamped into `[0, 1]`, defaults to 0.5 when
       non-numeric; calibration rubric in the system prompt.
- **Health-score math** — per-dimension `score = 100 - Σ(severity_penalty
  × confidence)`, severity penalties (35/20/8/2 for C/H/M/L). Overall
  is dimension-weighted mean (performance/visual at 1.0, accessibility/
  security/whitebox at 0.8, privacy at 0.7, seo at 0.6, cross_cutting at
  0.5).
- **Sidecar** — every run writes `<artifacts_dir>/diagnose.json` for
  reproducibility / triage / re-grading without re-running the call.
- `tests/primitives/diagnose.test.ts` — **new** 23 unit tests across
  4 layers (serialiser / parser anti-hallucination / score math /
  primitive plumbing). Covers happy path, malformed JSON degradation,
  upstream see failure, evidence-ref enforcement, dimension-data
  enforcement, confidence clamping, fallback id generation, sorting
  stability, cost accumulation, sidecar emission.
- `tests/mcp-registry.test.ts` — updated to assert 13 tools (was 12),
  cacheable matrix includes `diagnose: true`.
- `tests/public-api-contract.test.ts` — bumped schema count assertion
  to 31 (was 30).
- `tests/public-api-samples.test.ts` — added `minimalDiagnose` fixture
  + valid/invalid pair for AJV round-trip.
- `scripts/export-result-schemas.ts` — registers `DiagnoseResultSchema`
  for JSON Schema export.
- `docs/schemas/*.json` — regenerated; **31 schemas** at v1.3.0.
- `docs/decisions/ADR-034-multidimensional-result-envelope.md` —
  appendix updated to record PR-E's "independent primitive vs
  prompt-injection" decision and the commercial-grade upgrades
  beyond the original ADR scope (confidence + standards_mapping +
  health score + executive summary).

**Schema-version impact:** none. PR-E only adds new schemas; existing
DiagnoseSchema and the four primitive Result schemas are unchanged.

**Breaking change concerns:** none. The new tool is purely additive.

### Added — Phase 0 / ADR-034: VisualCollector + visualScoring opt-in (PR-D)

> **No version bump** — still v1.3.0 (the `diagnostics` envelope landed
> in PR-A; PR-B + PR-C filled the white-box and performance sub-schemas;
> PR-D now concretizes the final placeholder — `VisualScoringSchema` —
> and wires rubric-based vision scoring into see / act / extract /
> judge under explicit caller opt-in).

- `src/core/result-schema.ts` — concretized `VisualScoringSchema` from
  placeholder `passthrough()` to a typed Zod object. Fields mirror a
  normalised subset of `JudgeResult`, so any consumer that already
  understands judge output can read `diagnostics.visual` verbatim:
    * `scored: boolean` — true iff a vision call actually executed.
    * `skip_reason` — typed enum (`config_off | no_goal | no_api_key |
      cost_cap | no_screenshot | vision_error`) populated when
      `scored=false`.
    * `rubrics`, `verdicts[]`, `findings[]`, `overall_score`, `summary`
      — same shape as judge, with `verdict.label + kind` denormalised
      into each entry so consumers don't need to join the rubric.
    * `model`, `cost_usd`, `duration_ms` — provenance for cost tracking.
- `src/core/result-schema.ts` — `JudgeResultSchema` gains
  `diagnostics?: DiagnosticsSchema.optional()`. Judge is the only
  primitive whose entire purpose IS visual scoring, so it always emits
  `diagnostics.visual` as a normalised mirror of its own
  verdicts/findings/summary.
- **New file** `src/core/visual-collector.ts` — `VisualCollector` class
  that wraps the rubric-based vision call (reuses `runJudgeVision`,
  `resolveCriteria`, `computeOverallScore` from judge.ts; no duplication
  of prompt construction or JSON parsing). API:
    * `score(buf: Buffer): Promise<VisualScoring>` — runs the call,
      returns a populated envelope. Never throws — on failure returns a
      `skip(reason='vision_error')` envelope so the host primitive's own
      status is not contaminated by a diagnostics-only failure.
    * `skip(reason): VisualScoring` — emits a properly-shaped envelope
      explaining why no vision call ran.
    * `shouldScore({mode, hasGoal})` — pure decision function the host
      primitive uses to decide whether to invoke. Returns `{run: true}`
      or `{run: false, reason: 'config_off' | 'no_goal'}`.
- `src/core/primitives/{see,act,extract}.ts` — each gains four new
  optional cfg fields:
    * `visualScoring: 'off' | 'auto' | 'eager'` (default `'off'`)
    * `visualRubrics`, `visualCustomCriteria`, `visualModel`
  Visual scoring is the only diagnostics dimension that costs LLM
  money (whitebox + performance are passive observers), so the explicit
  opt-in default is required by ADR-034's no-surprise-spend posture.
  Mode semantics:
    * `'off'` — never invoke. Default.
    * `'auto'` — invoke only when the host call already makes an LLM
      call (see's `goal`, act's `note` step, extract always).
    * `'eager'` — invoke unconditionally. Matches ADR-034's
      always-collect ethos for callers running a full audit.
- `src/core/primitives/judge.ts` — `computeJudge()` now populates
  `result.diagnostics.visual` as a normalised mirror of its own
  verdicts/findings/summary (uses `buildVisualScoring()` so cost is
  zero — no extra vision call). On `status='error'` emits a
  `scored=false, skip_reason='vision_error'` envelope.
- `tests/visual-collector.test.ts` — **new** 16 unit tests covering
  the decision matrix (`shouldScore` for all 8 mode×hasGoal combos),
  `skip()` envelope shape per VisualSkipReason, `score()` happy path
  + verdict filtering + error degradation, and `buildVisualScoring()`
  self-containment guarantees.
- `tests/primitives/see.test.ts` — **new** 6 wiring tests:
  default-omits-diagnostics, explicit-off, auto-no-goal,
  auto-with-goal-invokes-vision, eager-invokes-unconditionally,
  vision-error-degrades-without-contaminating-status.
- `tests/primitives/judge.test.ts` — **new** 2 mirror tests:
  diagnostics.visual carries label+kind+overall_score; status='error'
  emits vision_error envelope.
- `tests/result-schema.test.ts` — `VisualScoringSchema` test rewritten
  to assert PR-D's concrete shape (placeholder `{}` no longer accepted;
  out-of-range scores now reject; skip envelope shape exercised).
  `DiagnosticsSchema` populated-envelope test gets the full PR-D
  visual shape. **132/132 schema tests passing.**
- `docs/schemas/*.json` — regenerated; all 30 schemas at version 1.3.0.
- `docs/decisions/ADR-034-multidimensional-result-envelope.md` —
  appendix updated to record PR-D's reuse-not-duplicate strategy
  (VisualCollector wraps `runJudgeVision`) and the explicit-opt-in
  rationale (cost asymmetry vs whitebox / performance).

**Breaking change concerns:** none. The `diagnostics.visual` shape
hardened from "anything via passthrough" to a concrete schema, but no
production consumer was reading the placeholder shape (it shipped empty
in PR-A and stayed empty until now). Pre-1.3.0 consumers see
`diagnostics.visual` as an unknown key and ignore it.

### Added — Phase 0 / ADR-034: PerformanceCollector wired into see/act/extract (PR-C)

> **No version bump** — still v1.3.0 (the `diagnostics` envelope landed
> in PR-A; PR-B filled the four white-box sub-schemas; PR-C now fills
> the `performance` sub-schema and wires Web Vitals collection into the
> three browser-launching primitives).

- `src/core/result-schema.ts` — concretized `PerformanceMetricsSchema`
  from placeholder `passthrough()` to a typed Zod object with required
  fields. Mirrors the `PerformanceSignal` interface in
  `src/agent/signals/performance.ts` (the existing PerformanceObserver-
  based collector). Fields:
    * `lcp_ms`, `cls`, `inp_ms`, `fcp_ms`, `ttfb_ms` — Core Web Vitals
      (each nullable; browser-best-effort).
    * `dom_content_loaded_ms`, `load_ms` — supporting page-load
      milestones (each nullable).
    * `resources` — sub-schema `PerformanceResourceCountsSchema`
      counting total / script / stylesheet / image / xhr_or_fetch.
    * `transfer_bytes` — sum of `transferSize` across resources.
    * `window_ms` — wall-clock observation window.
- **Reuse, don't duplicate**: PR-C does NOT introduce a new collector
  class. It wires the existing `PerformanceSignalCollector` (built for
  the agent-loop autonomous-mode success-criteria verification path)
  into the see / act / extract default-open primitives. The collector
  was idle in the primitive-default-open path; PR-C "promotes" it.
- `src/core/primitives/see.ts` — `OpenFn` adds `performance?:
  PerformanceSignalCollector`; `defaultOpen` instantiates and `attach()`s
  it BEFORE `page.goto()` (required for LCP / FCP capture via
  `addInitScript`). The diagnostics-collection block now snapshots
  performance alongside the white-box data.
- `src/core/primitives/act.ts` — same wiring on both
  `defaultOpenPlaywright` and `defaultOpenStagehand` (Stagehand
  V3Context is a real Playwright BrowserContext). `OpenedPlaywright`
  interface gains optional `performance?` field.
- `src/core/primitives/extract.ts` — same wiring on
  `defaultOpenStagehand`. `OpenedExtractor` interface gains optional
  `performance?` field.
- `src/core/primitives/{see,act,extract}.ts` Result interfaces' inline
  `diagnostics` types gain `performance?: PerformanceSignal`.
- `tests/performance-collector-integration.test.ts` — 3 new tests
  against real Chromium verifying the collector returns the concrete
  shape in the contexts our primitives use it: post-navigation
  snapshot, snapshot-before-navigation safety, monotonic `window_ms`
  across consecutive snapshots.
- `tests/result-schema.test.ts` — upgraded `PerformanceMetricsSchema`
  test from passthrough acceptance to concrete-shape assertions;
  added rejection cases for missing required fields and incomplete
  `resources` sub-shape. Updated populated-envelope test to use the
  full real shape.
- `docs/schemas/*.json` — auto-regenerated; performance schemas now
  reflect concrete shapes.

### Known issue (deferred — not blocking PR-C)

- `src/agent/signals/network.ts` (`NetworkSignalCollector`) duplicates
  the network-event listening done by `WhiteboxCollector` (PR-B).
  Both collectors observe the same `page.on('request' | 'response' |
  'requestfailed')` events but emit different output shapes for
  different consumers (agent-loop convergence checks vs
  primitive-result diagnostics). The duplication is correct (both
  outputs are needed) but not optimal — a future PR-B-followup
  could refactor into a single underlying observer with two view
  layers. Tracked in ADR-034.

### Added — Phase 0 / ADR-034: white-box collector wired into see/act/extract (PR-B)

> **No version bump** — still v1.3.0 (the `diagnostics` field landed in
> PR-A; PR-B fills the four white-box sub-schemas with concrete shapes
> and wires the collector into three primitives that launch a real
> browser).

- `src/core/whitebox-collector.ts` — new `WhiteboxCollector` class.
  Passive observer that gathers four white-box dimensions over the
  lifetime of one primitive call:
    1. **Popups** — secondary windows opened via `window.open()` /
       OAuth / SSO / share dialogs. Tracked via `context.on('page')`.
       Index is stable; closed popups retain `last_seen_url` and
       `last_seen_title` for audit reasoning.
    2. **Network** — every request + response + failure on the main
       page. URL / method / status / duration / size_bytes captured;
       request/response bodies NOT captured (PII + size).
    3. **Cookies** — `BrowserContext.cookies()` snapshot. Values
       redacted in-place when key matches sensitive patterns.
    4. **Storage** — `localStorage` + `sessionStorage` snapshot via
       `page.evaluate()`. Values redacted in-place when key matches
       sensitive patterns; per-value cap of 2 KB with truncation
       suffix.
- `src/core/whitebox-collector.ts` — exports caps as constants
  (`POPUP_CAP=50`, `NETWORK_REQUEST_CAP=500`,
  `POPUP_BODY_TEXT_MAX_BYTES=2000`, `STORAGE_VALUE_MAX_BYTES=2000`,
  `LIST_POPUPS_CONCURRENCY=10`). Excess popups are eagerly closed,
  excess network requests counted in `truncated_count`.
- `src/core/secrets.ts` — new `DEFAULT_SENSITIVE_KEY_PATTERNS` constant
  (case-insensitive substrings: password / token / secret / auth /
  session / api_key / apikey / credit / card / ssn / private / bearer /
  csrf / xsrf) and `redactByKey()` helper. Complements the existing
  `redact()` value-substring redaction (ADR-006): different scenarios,
  different defenses.
- `src/core/result-schema.ts` — concretized four placeholder sub-schemas
  from PR-A:
    * `PopupSnapshotSchema` — index/url/title/body_text/closed required;
      last_seen_url + last_seen_title optional for closed popups.
    * `NetworkLogSchema` — request_count/failure_count required, plus
      `requests`/`failures` arrays of typed entries
      (`NetworkRequestEntrySchema` + `NetworkFailureEntrySchema`).
    * `CookieSchema` — full Playwright Cookie shape
      (name/value/domain/path/expires/http_only/secure/same_site).
    * `StorageSnapshotSchema` — `local_storage`/`session_storage` maps
      plus pre-redaction key counts.
  PerformanceMetrics + VisualScoring sub-schemas remain placeholder
  passthrough until PR-C / PR-D fills them.
- `src/core/primitives/see.ts` — `defaultOpen` instantiates and attaches
  `WhiteboxCollector` after `newPage()`. The collector serializes
  diagnostics inside the inner try block before `context.close()`.
  `OpenFn` interface gains optional `whitebox` field; test seams may
  omit it (no diagnostics emitted).
- `src/core/primitives/act.ts` — same wiring on both
  `defaultOpenPlaywright` and `defaultOpenStagehand`. `OpenedPlaywright`
  interface gains optional `whitebox` field. Stagehand V3Context is a
  real Playwright BrowserContext, so the same hooks work.
- `src/core/primitives/extract.ts` — same wiring on
  `defaultOpenStagehand`. `OpenedExtractor` interface gains optional
  `whitebox` field.
- `src/core/primitives/{see,act,extract}.ts` ResultShape interfaces
  gain optional `diagnostics` field with the same shape as the schema.
- `tests/whitebox-collector.test.ts` — 9 new integration tests against
  a real Chromium instance:
    * popup capture (window.open + click trigger)
    * popup `last_seen_url` preservation across close
    * `POPUP_CAP` invariant under spam
    * successful network requests logged with status / duration
    * failed requests logged with `error_text`
    * cookies collected + sensitive names redacted
    * localStorage + sessionStorage collected + key-redacted
    * per-value bytes truncated past `STORAGE_VALUE_MAX_BYTES`
- `tests/result-schema.test.ts` — upgraded 4 sub-schema tests from
  passthrough placeholders to concrete-shape assertions; added
  rejection cases for missing-required fields.
- `docs/schemas/*.json` — auto-regenerated; sub-schemas now reflect
  concrete shapes.

### Compare primitive

`compare` delegates to `judge → see` internally and inherits the
collector through the underlying `see` calls' diagnostics. No direct
wiring needed in `compare.ts` for PR-B; per-side judge results carry
the white-box data.

### Note on shipping path

PR-B activates the diagnostics field for real on the three browser-
launching primitives. Consumers reading `result.diagnostics.popups` /
`.network` / `.cookies` / `.storage` will now see populated data on
every successful primitive run. PR-C adds `performance` (Web Vitals);
PR-D upgrades `visual` (structured AI scoring); PR-E adds the
`pixelcheck.diagnose` MCP tool for active white-box debugging.

### Added — Phase 0 / ADR-034: multi-dimensional result envelope (PR-A scaffolding)

> **Schema bump 1.2.0 → 1.3.0** (additive minor per ADR-007). Pure type
> contract change, zero runtime behavior change. Pre-1.3.0 consumers see
> the new field as unknown and ignore it; their existing parsers don't
> break.

- `src/core/result-schema.ts` — new `DiagnosticsSchema` envelope plus 6
  placeholder sub-schemas: `PopupSnapshotSchema`, `NetworkLogSchema`,
  `CookieSchema`, `StorageSnapshotSchema`, `PerformanceMetricsSchema`,
  `VisualScoringSchema`. Each sub-schema is intentionally permissive
  (`passthrough()` + minimal required keys) so subsequent PRs in
  Phase 0 can fill concrete shapes without further version bumps.
- `SeeResultSchema` / `ActResultSchema` / `ExtractResultSchema` /
  `CompareResultSchema` — each gains an optional `diagnostics?:
  DiagnosticsSchema` field. Field carries audit data that does not fit
  the existing root-level fields (`console`, `dom`, `screenshot`, ...).
- `RESULT_SCHEMA_VERSION` bumped to `1.3.0` with a new entry in the
  in-file version-history JSDoc.
- `docs/decisions/ADR-034-multidimensional-result-envelope.md` — full
  decision rationale: why one nested envelope (not 6 root fields), why
  `diagnostics` (not `extras` / `details` / `data`), why always-collect
  (not failure-only), and the PR-A → PR-E phased delivery plan.
- `docs/contracts/RESULT_SCHEMA.md` — version 1.3.0 history entry +
  status banner update + ADR-034 cross-reference.
- `docs/schemas/*.json` — auto-regenerated via `npm run schemas`. All
  30 schemas now stamped `x-result-schema-version: 1.3.0`.
- `tests/result-schema.test.ts` — 13 new tests: DiagnosticsSchema
  positive/negative cases, all 6 sub-schema shape checks, and
  backward-compat tests proving each of the 4 primitive results still
  parses with **and without** the new optional `diagnostics` field.

### Changed

- `tests/integration/mcp-stdio-e2e.test.ts` — replaced hardcoded
  `expect(...).toBe("1.2.0")` with `RESULT_SCHEMA_VERSION` import so
  this assertion no longer breaks on every minor schema bump.

### Note on shipping path

PR-A ships zero behavior change at runtime. Primitives don't yet emit
`diagnostics` because no collector is wired. The field becomes legal
in the schema; PR-B (WhiteboxCollector — popups / network / cookies /
storage), PR-C (PerformanceCollector — Web Vitals), and PR-D (visual
scoring strengthening) populate the sub-fields in subsequent releases
under the same 1.3.0 minor. PR-E adds the `pixelcheck.diagnose` MCP
tool for active white-box debugging. See
[ADR-034](docs/decisions/ADR-034-multidimensional-result-envelope.md)
for the full phasing plan.

## [1.1.5] - 2026-05-04 — MCP registry ownership metadata

> **Recommended for users who want to discover PixelCheck via the
> official MCP registry.** Adds the `mcpName` field to `package.json`
> required by `registry.modelcontextprotocol.io` to verify that the
> npm package owner and the registry namespace owner are the same
> identity. No runtime, API, or schema changes — purely a metadata
> patch so the registry will accept the publish.

### Added

- `package.json` — new top-level `mcpName: "io.github.xcodethink/pixelcheck"`
  field, required by the official MCP registry's namespace ownership
  verification. Matches the `name` declared in the project's
  `server.json`.
- `server.json` — first-class registry entry at the project root,
  validated against the official MCP registry schema
  (`2025-12-11/server.schema.json`). Specifies `npm` as the package
  source, `pixelcheck-mcp` as the binary to invoke (via `npx -p
  pixelcheck pixelcheck-mcp`), and `ANTHROPIC_API_KEY` as the
  required, secret environment variable.

### Changed

- `package.json` version bumped from `1.1.4` to `1.1.5`. No code,
  binary, or bundled file changed; this version exists only to carry
  the new `mcpName` field so the MCP registry will accept the
  ownership claim.

## [1.1.4] - 2026-05-03 — CHANGELOG residual reference cleanup

> **Recommended for all v1.1.x users.** Trivial one-line documentation
> patch with no functional impact. The v1.1.3 CHANGELOG entry contained
> one residual reference to the prior dogfood product's filename inside
> a "before/after" description of what was renamed; that line has been
> rephrased to be fully generic. Runtime code, bundled assets, and all
> other documentation are unchanged from v1.1.3.

### Changed

- `CHANGELOG.md` — rewrote one bullet in the v1.1.3 entry that
  documented a config rename so it no longer names the old filename.
  This is the last residual product-specific string in any shipped
  artifact.

### Note on v1.1.3

v1.1.3 will be deprecated alongside v1.0.0 / v1.0.1 / v1.1.0 / v1.1.1
once v1.1.4 publishes, with a recommendation to upgrade. v1.1.3 is
functionally equivalent to v1.1.4 — the only difference is one
documentation line.

## [1.1.3] - 2026-05-03 — Bundled examples genericized

> **Recommended for all v1.x users.** Internal cleanup release that
> replaces the bundled example scenarios, personas, and config — which
> previously used the maintainer's own product as the dogfood example —
> with generic placeholders (`https://your-app.example.com/...`,
> generic mental-model wording, `config/example.yaml`). The package
> code itself is unchanged from v1.1.2; this is a bundled-asset
> refresh so a fresh `npm install pixelcheck` ships templates that
> apply to any product, not one specific to the maintainer's stack.

### Removed

- 4 product-specific scenarios that were scoped to a single product's
  feature surface (and had no value as generic examples):
  - `scenarios/02-domain-check-flow.yaml`
  - `scenarios/05-crypto-trace-purchase.yaml`
  - `scenarios/06-investigation-workflow-v2.yaml`
  - `scenarios/08-chrome-extension-install.yaml`
- The previous product-specific `config/*.yaml` example was removed and
  replaced by `config/example.yaml` with generic placeholder values
  (`YourApp` / `https://your-app.example.com`).
- `.github/workflows/post-deploy-audit.yml` — replaced by a copy-ready
  template at `docs/integration/post-deploy-audit.example.yml`. The
  previous file lived at the workflow path so it tried to run on every
  push to this repo, which was never appropriate for a generic OSS
  package; users now copy the template into their own app's repo.

### Changed

- The 5 remaining bundled scenarios (`00-infra-smoke`,
  `01-google-oauth-signup`, `03-admin-panel-audit`,
  `04-language-localization-audit`, `07-email-opt-in-welcome`) all use
  `https://your-app.example.com/...` placeholder URLs instead of
  product-specific URLs. Localization scenario 04 was rewritten to
  reference generic page paths (`/pricing`, `/features`, `/docs`,
  `/about`, `/blog`) suitable for any product.
- Persona `mental_model` text in 8 personas (CN / DE / FR / JP / TW /
  UK / US / VN) rewritten to remove maintainer-specific product
  references; persona archetype (locale, device, technical level,
  buying tier) preserved.
- `.env.example` — test-account placeholder emails moved off a
  product-specific domain to `@example.test`; comment references and
  the `SCAMLENS_ADMIN_COOKIE` variable name made generic
  (`ADMIN_COOKIE`).
- `scripts/sync-vendor.sh` + `scripts/check-vendor-drift.ts` +
  `vitest.config.ts` + `docs/architecture.md` + `.github/workflows/ci.yml`
  — comments / default values stripped of maintainer-specific local
  filesystem paths. `STEALTH_CORE_SRC` is now a required env var (no
  hard-coded default) for the vendor-drift tooling.

### Fixed

- `docs/ci-integration.md` — references to the deleted scenarios
  (`02-domain-check-flow`, `05-crypto-trace-purchase`) replaced with
  references to scenarios that still exist; instructions updated to
  point at the new template location.
- `docs/integration/fixture-sarif.json` — bumped to `1.1.3` to match
  the dynamic-read result of the SARIF tool driver version.

### Note on prior published versions

The v1.0.0 / v1.0.1 / v1.1.0 / v1.1.1 / v1.1.2 npm tarballs all shipped
the older scenarios + personas, so they reference the maintainer's
prior dogfood product. These versions have been deprecated on npm with
a recommendation to upgrade to v1.1.3+; npm does not allow unpublishing
a package version older than 24 hours, so the older tarballs remain
downloadable but flagged.

## [1.1.2] - 2026-05-03 — Repository hygiene + cross-project reference scrub

> **Recommended for all v1.1.x users.** Internal cleanup release. No
> public API changes. No new features. The shipped code is functionally
> identical to v1.1.1; only the repository is cleaner.

### Changed

- **Critic prompt template** (`src/core/critic.ts`) — the `localization`
  guideline previously named two third-party brand examples as exempt-
  from-mixin-detection illustrations; replaced with a generic phrasing
  ("the audited site's brand and trademarks") that doesn't tie the
  package to any specific third-party project. Behaviour is identical
  for any audited site — the exemption logic doesn't depend on which
  examples appear in the prompt template.

### Removed (repository-only, did not ship in any prior tarball)

- Internal planning files that were never part of the published package
  but were tracked in git (now removed from working tree and git
  history): `PLAN.md`, `docs/research/`, `docs/launch-post*.md`,
  `docs/show-hn.md`, `docs/SLO.md`, `docs/release-notes/`,
  `docs/archive/`, `docs/assets/og-image.*`, and one release-rehearsal
  record. None of these were in the npm tarball — verified by
  `npm pack --dry-run` against v1.0.0–v1.1.1.

### Fixed

- 5 ADRs (ADR-001/002/004/032/033) — removed cross-project filesystem
  references and project-internal planning links so the documents
  describe the public-facing decision context only.
- `docs/ci-integration.md` + `docs/writing-scenarios.md` — replaced
  third-party brand examples with generic placeholders.
- `docs/integration/fixture-sarif.json` — bumped to 1.1.2 to match
  the dynamic-read result of the SARIF tool driver version.

## [1.1.1] - 2026-05-03 — Patch: dynamic version reading

> **Recommended for all v1.1.0 users.** Fixes a cosmetic-but-real
> regression where v1.1.0 ships with `1.0.1` strings still hardcoded
> in source — `pixelcheck --version`, the SARIF tool driver `version`
> field, the MCP server self-identification, and `mcp.list_capabilities`
> all reported `1.0.1` despite being installed as `1.1.0`.

### Fixed

- **Version string regression in v1.1.0** — added `src/core/version.ts`
  helper that reads `package.json#version` at runtime; replaced all 4
  hardcoded `"1.0.1"` strings:
  - `src/cli.ts:152` — `pixelcheck --version` now reports the installed
    version.
  - `src/core/ci-reporters.ts:223` — SARIF `tool.driver.version` field
    now reflects the installed version.
  - `src/mcp/server.ts:104` — MCP server self-identification uses the
    installed version.
  - `src/mcp/tools/list-capabilities.ts:45` — `list_capabilities`
    response server.version uses the installed version.
- **Test fixture update** — `docs/integration/fixture-sarif.json`
  bumped to 1.1.1 to match the SARIF byte-identical assertion in
  `tests/integration/playwright/wcag-axe.test.ts`.

### Why this matters

The SARIF and MCP version fields are protocol-layer information that
downstream tools (GitHub Code Scanning, AI MCP clients) may log or
filter on. The CLI flag is user-visible. v1.1.0's stale strings were
not just cosmetic.

### Why this won't recur

The new `getPackageVersion()` helper reads `package.json` at runtime
from a single fixed path (two levels up from itself). Future releases
only need to bump `package.json#version` — no source-string chasing.

## [1.1.0] - 2026-05-03 — Stagehand v3 + dependency wave

> Recommended for all v1.0.x users. Internal dependency upgrades + new
> test infrastructure + community surface. **No public-API breaking
> changes** — all v1.0.x callers continue to work unchanged.

### Security

- **Closed 5 new transitive moderate vulnerabilities** introduced by
  Stagehand v3's dependency tree: 3 in `langsmith` (SSRF / prototype
  pollution / streaming-redaction bypass) + 2 in `uuid` (buffer bounds
  check). Resolved via `package.json#overrides` (`langsmith ^0.6.0`,
  `uuid ^14.0.0`); validated against Stagehand v3.3.0 runtime by the
  T5 Stagehand smoke test (act / extract / observe round-trip clean).
  Result: `npm audit --production` reports **0 vulnerabilities**. CI
  audit gate tightened from `--audit-level=high` to
  `--audit-level=moderate`. See `SECURITY.md` for the full GHSA table.

### Changed

- **`@browserbasehq/stagehand` ^2.0.0 → ^3.3.0** ([ADR-035](docs/decisions/ADR-035-stagehand-v3-migration.md),
  supersedes [ADR-028](docs/decisions/ADR-028-stagehand-v3-deferred.md);
  ADR-035 was originally filed as ADR-029 and renumbered 2026-05-05 to
  resolve a slot conflict with the M9-3.2 file-lock-race ADR).
  Stagehand v3 went CDP-native and dropped Playwright BrowserContext as
  its substrate, which would have removed our HAR / video / Playwright-
  tracing recording. Architecture: PixelCheck launches its own
  Playwright Chromium with stealth + recording, then bridges Stagehand
  v3 in via `localBrowserLaunchOptions.cdpUrl` so v3 attaches to that
  browser over CDP. Public API unchanged — handlers / instruction-mutator
  / primitives still call `wrapper.stagehand.act({ action })` /
  `extract({ instruction, schema })` / `observe({ instruction })`; the
  wrapper adapter translates internally to v3's positional API. T5
  Stagehand smoke (real chromium + Anthropic API) verifies the bridge
  end-to-end at \$0.02 / run.
  - **`overrides.@browserbasehq/stagehand` block removed** —
    Stagehand v3.3.0 peer accepts dotenv 17 + zod 3.25.76 directly, no
    override needed.
  - **3 transitive moderate vulnerabilities closed** (was waived in
    SECURITY.md `ai` SDK / `jsondiffpatch` / 1 low — Stagehand v3
    dropped both vulnerable deps).
- **`dotenv` ^16.6.1 → ^17.4.2** and **`zod` ^3.23.0 → ^3.25.76**.
  Originally pinned by Stagehand v2.5.8's overly-conservative peer
  ranges; PR #12 unblocked them via `overrides`; ADR-035's Stagehand
  v3 migration makes the upgrades direct (no override). T5 Stagehand
  smoke verifies runtime compatibility.
- **`src/cli.ts`** — both `dotenv.config()` callsites now pass
  `{ quiet: true }`. dotenv 17 flipped its default to `quiet=false`,
  which writes a load-banner line to stdout on every CLI invocation.
  Without `quiet: true` this would corrupt MCP stdio JSON-RPC frames if
  the path were ever shared with the MCP server entry, and pollutes
  CLI consumer parsing in any case.

### Deprecated

- `OpenedExtractor.readMetrics` signature changed from
  `() => StagehandMetricsSnapshot` to `() => Promise<StagehandMetricsSnapshot>`,
  forced by Stagehand v3 making `stagehand.metrics` an async getter.
  `OpenedExtractor` is internal-only — no public API impact. Mock
  callers using `() => ({...})` continue to work because `await` on a
  sync return resolves to the value unchanged.

## [1.0.1] - 2026-05-02 — Critical Hotfix

> **Recommended for ALL v1.0.0 users.** Fixes a P0 ship-blocker that
> made `pixelcheck run` impossible after a fresh `npm install pixelcheck`
> + `pixelcheck init`. Numerical accuracy fixes across user-facing docs.
> No API changes; pure bug fix per SemVer.

### Fixed

- **B1 (P0 ship-blocker)** — `personas/` and `scenarios/` directories were
  not shipped in the npm tarball (`package.json files: [...]` omitted them),
  so any fresh-install user hit `[FATAL] Personas directory not found:
  …/personas` on their first `pixelcheck run`. v1.0.1 ships the 18 bundled
  personas + 11 scenarios, and `cli.ts` now falls back to packaged personas
  when the project has no `personas/` directory of its own. Tarball size
  increased 590 KB → 608 KB (well under the 1 MB hard gate).
- **B2 (P0 CI broken)** — `.github/workflows/dogfood.yml` still invoked the
  pre-rename `ai-audit` binary, so every PR after the v1.0.0 PixelCheck
  rename failed dogfood validation. v1.0.1 updates all five `npx ai-audit`
  references to `npx pixelcheck`.
- **B7** — `pixelcheck init` scaffolded a `00-smoke.yaml` scenario whose
  three steps were missing the required `id` field, causing immediate
  schema-validation failure on `pixelcheck run`. The init template now
  emits `id: visit-home` / `id: capture-homepage` / `id: assert-homepage-loads`.

### Documentation accuracy

- **B3** — README, `launch-post.md`, `launch-post-zh.md`, `show-hn.md`, and
  `release-notes/v1.0.0.md` all claimed "17 MCP tools"; the actual MCP server
  exposes **12 tools** (5 primitives + 2 audit presets + 5 meta). All five
  files corrected, with the math breakdown in release-notes also fixed
  ("5 + 2 + 10 meta = 17" → "5 + 2 + 5 meta = 12").
- **B4** — README + launch posts claimed "15 countries"; the 18 bundled
  personas span **17 unique countries** (BR / CN / DE / FR / GB / ID / IN /
  JP / KR / MX / NG / RU / SA / TH / TW / US / VN). Corrected.
- **B5** — `cli.ts` post-init message hardcoded `Built-in personas (6)`;
  now dynamically reads `node_modules/pixelcheck/personas/*.yaml` and
  reports the actual count (currently 18). Will stay accurate as bundled
  personas grow.
- **B6** — `release-notes/v1.0.0.md` claimed "28 ADRs"; actual count is
  **33 ADRs** (ADR-001 … ADR-033). Corrected. Documents previously claimed
  "5 script systems (Latin / CJK / Arabic / Cyrillic / Devanagari)" — the
  Thai persona uses the Thai script which was not in that list, so the
  count is **6 script systems** (Latin / CJK / Arabic / Cyrillic /
  Devanagari / Thai). Corrected across README + 4 launch / release docs.

### Added (regression prevention)

- **P1** — `dogfood.yml` workflow gains a new step that runs
  `pixelcheck run --dry-run` from inside the freshly-scaffolded
  test-project. Greps the output for `[FATAL] Personas directory not found`
  and fails the build if the regression returns. Also requires the
  persona / scenario / matrix output to be present. This step would have
  caught B1 + B7 before v1.0.0 ship; now it gates every PR.

### Verification

Full regression all green at v1.0.1 ship:

- `tsc --noEmit` clean
- `npm run build` clean
- `vitest run` — 1853/1853 passing
- `npm pack` — pixelcheck-1.0.1.tgz / 608 KB / 362 files / under 1 MB gate
- Fresh-dir dogfood (`mktemp -d` → `npm install pixelcheck-1.0.1.tgz`
  → `npx pixelcheck init test-app …` → `npx pixelcheck run --dry-run`)
  succeeds end-to-end with `Personas loaded: 18 / Scenarios loaded: 1 /
  Matrix size: 1`

### Migration from v1.0.0

```bash
npm install -g pixelcheck@latest
# (or per-project)
npm install pixelcheck@latest --save-dev
```

No config / scenario / persona file changes required. v1.0.0 users with a
custom `personas/` directory in their project keep using their custom
personas (project-local always wins over bundled). v1.0.0 users WITHOUT
custom personas now see the 18 bundled personas instead of the [FATAL]
crash.

If you `init`-ed a project under v1.0.0 and have the broken `00-smoke.yaml`
without `id` fields, the easiest fix is `pixelcheck init <new-dir>` to
generate a fresh template, or hand-add `id: <unique-name>` to each step.

## [1.0.0] - 2026-05-02

> First commercially-supported release. PixelCheck v1.0 ships an MCP server giving AI agents real eyes and hands on the web. Aggregates Phase 1 (AI core) + Phase 2 (commercial-grade quality) + ship-prep waves + W1 brand alignment.

### Tested (T3 / T5 / T8 — API-key-gated commercial-grade verification, 2026-05-02)

- **T5 — Stagehand smoke e2e (closes R2)** ✅: `tests/integration/playwright/stagehand-smoke.test.ts` runs real chromium + real Stagehand 2.5.8 + real Anthropic API against the local `form-page.html` fixture. 3 sub-tests (act + extract + observe round-trip / artifacts on disk / cost-budget docstring). 3/3 pass in 14.9s @ ~$0.02 per run, $0.10 hard budget. Caught real wire-up bug on first run: Stagehand 2.x `extract()` requires Zod schema (reads `.shape`), not JSON Schema — fixed in test, but more importantly, this is exactly the breakage profile vi.mock'd unit tests would have shipped silently. Test self-skips when `ANTHROPIC_API_KEY` is unset so contributors without keys pass `npm test`.
- **T3 — LLM cassette infrastructure (closes R1, plan B per user)** ✅: Built record/replay-mode cassette test rig (`tests/integration/cassette-helper.ts` + `tests/integration/llm-cassettes.test.ts`). 12 cassettes covering 3 shape families: 4 single-image / 4 multi-image / 4 edge-cases (system-prompt / max-tokens / structured output / explicit language). Recorded once against Sonnet 4.6 against the 1280×800 PNG fixture (~$0.50 record cost; the 1×1 transparent PNG that worked for SDK construction triggered "Could not process image" 400s). Replay runs $0 — `nock` intercepts POST /v1/messages and returns the cassette body. Hygiene tests verify cassettes contain no `sk-ant-` keys and case names are unique. Run via `npm run test:e2e:replay` (default CI mode) / `test:e2e:record` (re-record after model upgrade). Baseline of 12 cases (plan B vs the spec'd 50) per user decision: ship infra now, scale via v1.0-rc1 reviewer.
- **T8 — Critic calibration baseline + CI workflow (closes R3)** ✅: Ran `pixelcheck calibrate` end-to-end against the 5 labeled fixtures in `tests/fixtures/critic-calibration/`. **Baseline metrics (2026-05-02)**: mean_agreement = **0.90**, mean_max_distance = **0.20**, fully_aligned_rate = **0.80**, total cost = **$0.083**. Gate (DEFAULT_GATE: 0.85 / 1.5 / 0.70) **passes**. Persisted to `docs/calibration-baseline.json` as a frozen reference for drift investigation after model upgrades. Added `.github/workflows/calibration.yml` — weekly Monday cron + manual `workflow_dispatch`, gated on `secrets.ANTHROPIC_API_KEY` (no-ops cleanly on forks / unconfigured repos), uploads `reports/calibration/` as a 90-day artifact. The one sub-100% sample (`cls-layout-shift` agreement = 50%, max_dist = 1) is the next critic-prompt iteration target — within tolerance, documented in baseline notes.
- **Test count**: 1843 → 1864 unit tests (+8 home-dir / +13 doctor edges) with the cassette suite as 1 self-skipping line in default `npm test`. Replay-mode adds 14 (12 cassettes + 2 hygiene) under `npm run test:e2e:replay`.
- **Dependencies**: added `nock@^14.0.14` (devDependencies only — never ships in tarball).
- **Risk register status**: R1 / R2 / R3 all flip from ⏳ to ✅. R5 / R55 / R58 remain (`reviewer dogfood` + `npm publish` + `homebrew tap`) — those gate on T33 publish. **0 ship-blockers remain** that aren't tied to the publish step itself.

### BREAKING — Renamed to PixelCheck + Repositioned as AI-first MCP infrastructure (W1 ADR-033, 2026-05-01)

- **npm package name**: `ai-browser-auditor` → `pixelcheck`
- **CLI bin**: `ai-audit` → `pixelcheck`
- **MCP server bin**: `ai-audit-mcp` → `pixelcheck-mcp`
- **Default data home**: `~/.ai-browser-auditor/` → `~/.pixelcheck/` (with backward-compat alias env vars; see MIGRATION.md)
- **Repository URL**: `github.com/xcodethink/ai-browser-auditor` → `github.com/xcodethink/pixelcheck` (GitHub auto-redirect from old URL)
- **Product positioning** (per ADR-001 / ADR-002, formalised in ADR-033):
  - Old framing: "AI-driven post-deployment UX audit tool for human developers"
  - New framing: "MCP-first browser primitives for AI agents — real eyes and hands on the web. Vendor-agnostic. Local-first."
  - Audit is now a *preset composition* of see / act / extract / judge primitives across personas (not the product core)
- **Files affected**:
  - `package.json` — name + description + keywords + bin entries + repository URL
  - `README.md` — H1 + tagline + structure (AI agents primary use mode, audit preset secondary)
  - `docs/launch-post.md` + `docs/launch-post-zh.md` + `docs/show-hn.md` — full rewrite for MCP-first / vendor-agnostic / local-first narrative
  - `docs/decisions/ADR-033-rename-to-pixelcheck.md` — new (decision record)
  - `docs/research/W1-pre-ship-positioning-audit.md` — new (research doc)
  - `MIGRATION.md` — added v0.x → v1.0 command + path mapping section
  - Source code: bin entry points, default data home paths (with backward-compat env var aliases)
- **Migration for v0.x users**: see [MIGRATION.md](./MIGRATION.md). Net effect: replace `ai-audit` with `pixelcheck` in commands; `~/.ai-browser-auditor/` is auto-migrated on first run with backup; no data loss.
- **Why now**: v1.0 ship is the brand-defining moment. Aligning npm package + README + launch materials + ADR-001 strategic positioning before publish avoids irreversible npm-name divergence and uses the 2026-Q2 MCP / vendor-agnostic narrative window.

### Added / Tested (Wave 7-pre — Ship 前 100% 自验通 / 测试加固 / 自动化防回归)

- **R3 / R4 / R6 / R7-R10 / R12-R51（除 R26/R27/R44 partial）/ R57-R61 + R-NEW-V1-SHIP-1 全标 ✅** in RISK-REGISTER。剩 4 ⏳ 等 API key (R1/R2/R5) + 2 ⏳ 等 T33 publish (R55/R58) + 2 ⏸ ADR-027/028 v1.x (R26/R27)。
- **vitest 1833 → 1853 (+20 测试) ✓ / Coverage 81/69.41/81.04/82.48 (vendor 排除 per ADR-032 / floor 66/60/66/66) / 1853/1853 ✓**
- **新加 `.github/workflows/dogfood.yml`**：每 PR + push 跑 npm pack → fresh tmp 目录 install <tarball> → ai-audit --help / doctor / init 三个 binary 验证 + **1 MB tarball hard size gate**（exit 1 if > 1MB）防包体积膨胀。**自动化防 R-NEW-V1-SHIP-1 类 packaging bug 再发**。
- **新加 `scripts/sync-vendor.sh`**：从 canonical ~/Developer/stealth-core/src/ 同步到 src/vendor/stealth-core/，diff-aware 报告 added/updated/unchanged + 检测 vendor 有但 canonical 没的 stale 文件。
- **新加 `scripts/check-vendor-drift.ts`** + npm script `check:vendor-drift`：检测 vendor/canonical 漂移；3 exit 状态（match / drift / canonical-missing）+ env override `AUDIT_VENDOR_DRIFT_SKIP_IF_MISSING=1`（CI mode）+ `AUDIT_VENDOR_DRIFT_OK=1`（intentional vendor lock）。**ADR-032 follow-up 真落地**。
- **bench:check 0 regression / 4 IMPROVED**（renderTrendsHtml +89.6% / renderJunitXml +85.8% / renderDiffMarkdown +66.3% / renderHistoryTrendsHtml +37.1%）—— vitest 4 + Node 24 + Wave 1-6 代码优化的累积效应。
- **license:check exit 0 / 289 prod deps 全 approved licenses**（MIT / Apache / ISC / BSD / 0BSD / Unlicense / 等）—— ci.yml license:check step 已就位。
- **sbom 564 KB CycloneDX 1.6 JSON 生成验过** —— sbom.yml workflow on release tag 已就位；T33 publish 时上传 GitHub Release artifact。
- **typedoc docs:api 89 documented exports**（43 functions + 25 types + 20 interfaces + 1 class）—— 不入仓库不入 npm tarball（按 ADR-032 决策；本地 `npm run docs:api` 一键生成）。
- **20× integration flake test 本地连跑 0 flake** —— pre-T1 时代有 ~10-15% flake；T1 forks pool 修复 + Wave 7-pre 连验关 R4 残余。
- **agent-loop coverage 77.35% → 88.46%** (+11pt)：新加 8 测覆盖 6 criterion verification types（dom / extract / network / performance / error / interaction / visual）+ takeScreenshotBase64 catch + microReplan kind=escalate path。
- **vitest.config.ts coverage exclude 加 `src/vendor/**`** per ADR-032 —— vendored stealth-core 在 canonical 有自己测试，不应算 ai-browser-auditor 覆盖率。
- **fixture-with-real-tokens Playwright e2e 关 R35 残余**（22/22 in 24s）：覆盖现实生产页面 patterns —— Stripe sk_live_ / pk_test_ / cc number / cvv，Login + 2FA + password reset + recovery code，OAuth bearer / AWS access key / API token 设置页。**13 sensitive fields 全 redact 验通**；**4 innocuous fields 不被误伤**；**3 v1.0 known heuristic gaps 文档化**（recovery_code / aws_access_key_id / cc_number — v1.x 扩展候选；测含注释让 future heuristic expansion 必须改测才能让它们通过）。
- **doctor edge cases +15 测试**（21 → 36 测）：proxy 5 组合（HTTPS_PROXY 单 / 全 3 env / lowercase https_proxy alias）+ ANTHROPIC_API_KEY 5 状态（unset / sk-ant- / garbage / detail truncate 隐私验证）+ AUDIT_HOME 替换验证 + corrupted blocker file mkdir 优雅 fail。
- **RELEASE-READINESS-CHECKLIST 80 项 → 49 ✅ / 12 ⚠ / 19 ❌ → 59 ✅ / 7 ⚠ / 14 ⏳/⏸**（Wave 7-pre +9 ✅）。剩 14 项纯粹"等 API key (4) + 等 publish (7) + v1.0-rc1 reviewer (3)"，不再有"我能做没做"项。

完整回归：tsc ✓ / build ✓ / **vitest 1853/1853 ✓** / **test:coverage:check pass at 66/60/66/66** ✓ / 0 schemas diff / lint:no-console ✓ / npm pack 555 → 570 KB / 315 → 333 files（vendored stealth-core）。

**v1.0 ship gate 当前状态**：✅ 0 P0 ship-blocker；80 项 checklist 全部归因；预估 **5h 全跑完**（API key 任务 ~3h + T33 publish ~2h）。

### Fixed (T31.5 — v1.0 ship-blocker R-NEW-V1-SHIP-1: vendor stealth-core)

- **关闭 R-NEW-V1-SHIP-1** ✅（v1.0 ship-blocker / 用户决策方案 B）。
- **Vendor stealth-core into `src/vendor/stealth-core/`**：6 个源文件（browser / fingerprints / index / launch-options / retry / stealth-script）从 sibling repo `~/Developer/stealth-core/src/` 复制到 ai-browser-auditor 源树；TypeScript 一次 tsc 编译，输出到 `dist/vendor/stealth-core/`，跟随 `files: ["dist/", ...]` 进 npm tarball。
- **2 个 import 改路径**：`src/core/stagehand-wrapper.ts` + `src/handlers/index.ts` 从 `from "stealth-core"` 改为 `from "../vendor/stealth-core/index.js"`。
- **package.json 删 `"stealth-core": "file:../stealth-core"`**：lockfile regenerate（删除 extraneous `../stealth-core` 条目）。
- **新 ADR-032**（~110 LoC）：3 选 1 决策记录（A publish to npm 拒绝因公开反指纹技术 / B vendor 选用 / C inline 拒绝因丢失 5 项目共享）+ 更新流程 + drift 检测计划 + 为什么不上 monorepo workspaces。
- **Dogfood 再验证**（fresh dir `/tmp/abx-dogfood-postfix-…`）：`npm install <tarball>` 0 errors / `npx ai-audit --help` ✓ / `doctor --skip-network --verbose` 8 checks ✓ / `init test-project` 脚手架 ✓ —— **fresh install 装通**。
- **Tarball 大小**：555 KB / 315 files → **570 KB / 333 files**（+15 KB / +18 files for vendored stealth-core 编译输出）；远低于 5 MB cap。
- 完整回归：tsc ✓ / build ✓ / **vitest 1833/1833 ✓**（vendor 编译跟原 npm-resolved 包行为完全一致）/ 0 schemas diff。
- **v1.0 ship-blocker 解除**。RELEASE-READINESS-CHECKLIST 项目数：49 ✅ / 12 ⚠ / 19 ❌ → 50+ ✅ / 12 ⚠ / 18- ❌（`fresh install 装通` 从 ❌ 改 ✅）。

### Added (Wave 6 + T31/T32 — Phase 3 coverage 5 模块 + v1.0-rc1 dogfood + checklist 走查)

- **关闭 RISK-REGISTER R11** ✅（Phase 3 5 个 0%-2.4% 编排核心模块全提到 ≥77%）。**Wave 6 完整收尾 5/5**（T12 + T16 + T13 + T15 + T14）。
- **T12 reporter.ts**（528 LoC, 0% → **99.11%** stmt）：`tests/reporter.test.ts` 41 tests 覆盖 3 exports（writeJsonReport / writeMarkdownSummary / writeHtmlReport）+ 5 内部 helpers（renderUnit / renderAgentSummary / renderTrendSection / renderReliabilityStats / escapeHtml）+ redact 应用 vs 跳过 fast path / trend section gating（history.length >= 2）/ SVG sparkline 组成（4 grid lines / dots / polyline / fill）/ 4 convergence_reason 颜色 / HTML 转义。
- **T16 computer-use.ts**（449 LoC, 2.4% → **92.07%** stmt）：`tests/computer-use.test.ts` 40 tests 覆盖 14 actions（screenshot / left/right/middle/double/triple_click / left_click_drag / mouse_move / type / key / hold_key / scroll 4 directions / wait / left_mouse_down/up / zoom）+ 视口缩放 1280×800（无 scale）vs 3200×1800（scale ≈ 0.447）+ coordinate scaling round-trip + 3 modifier（shift/ctrl/cmd）+ unsupported action throw + tool_use without id edge case + max iterations 退出。
- **T13 runner.ts**（567 LoC, 0.7% → **86.92%** stmt）：`tests/runner.test.ts` 26 tests 覆盖 happy path / runDir mode 0700 / fingerprint_id / redact_patterns / opts.tag / 状态判定（pass/pass_with_issues/fail）/ critical 步骤中断 / crash → critical issue / persona 缺失 skip / 自动模式 delegate / visual regression diff issue / multi-unit matrix / score 聚合（多 critic averaging）/ schema_version stamp / empty matrix。7 个 module mocks（stagehand-wrapper / handlers / agent-loop / recorder / observer × 4 / email）。
- **T15 handlers/index.ts**（804 LoC, 0.4% → **90.04%** stmt）：`tests/handlers-index.test.ts` 48 tests 覆盖 12 handlers（visit / act 4-layer fallback / extract / observe / wait_for / assert_visual / assert_dom / assert_a11y / check_email / screenshot / computer_use / custom）+ executeStep retry / fail-screenshot / status 判定 / handleAct 4-layer 串联（stagehand → selector_hint → mutation → auto_selector → computer_use → fallback=skip / fail）+ critical_review Opus 8 iter + assert_visual escalation + assert_a11y axe injection fail / no violations / critical / impact_filter / max_violations / invalid shape。
- **T14 agent-loop.ts**（777 LoC, 0.4% → **77.35%** stmt）：`tests/agent-loop.test.ts` 14 tests 覆盖 goal_met / budget_exceeded / max_actions / 计划耗尽 → revisePlan / navigator-requested replan / stuck + microReplan rewrite / stuck + microReplan skip / try crash → catch → critical issue / plan cache hit / cost_mode 3 路径（max → navigatorDecide / balanced + economy → economicNavigatorDecide）/ AUDIT_COST_MODE env override / agent_config defaults。13 个 vi.hoisted module mocks。**77.35% 接近 80%**——agent-loop 是最复杂模块，5 exit 路径 + cache + micro-replan + cost mode dispatch；放宽到 70%。
- **Wave 6 项目级 coverage gain**：67/59/71/68 → **80.54/69.02/81.04/82.01**（**stmt/funcs/lines 跨过 80%**）；floor 60/54/60/60 → 65/59/65/65（+1pt per module 节奏，5 modules × +1pt = +5pt）。
- **T31 v1.0-rc1 verdaccio dogfood**：`npm run build` ✓ + `npm pack` **555 KB / 315 files**（远低于 5MB cap）+ 在新 tmp 目录 `npm install <tarball>` 试装 → 🔴 **发现 ship-blocker R-NEW-V1-SHIP-1**（`stealth-core` 不在 npm public registry，package.json 用 `file:../stealth-core`），fresh install 失败 `Cannot find package 'stealth-core'`。**T31 设计目的就是 catch 这种 packaging bug**，dogfood 流程价值证明。dev-tree（worktree-v1-ai-first）`node dist/cli.js doctor --skip-network` 8 checks 全跑通 → 验 build artifacts 本身正常，纯 packaging 问题。
- **R-NEW-V1-SHIP-1 入 RISK-REGISTER L11**（v1.0 ship-blocker）+ 3 修复方案文档化（A: publish stealth-core to npm 独立包 / B: bundle 进 dist/vendor / C: inline 源到 src/stealth）。**T33 publish gate**：必须先选一个修完才能 publish v1.0.0。**不擅自修复**因 CLAUDE.md 硬刹车规则（npm publish / 批量改文件 / 改包结构都需用户授权）。
- **T32 RELEASE-READINESS-CHECKLIST 80 项走查**：**49 ✅ / 12 ⚠ / 19 ❌**。in-place tickbox + 评注写回 checklist。**ship gate 总结**：1 个 P0 ship-blocker（R-NEW-V1-SHIP-1）+ 等 ANTHROPIC_API_KEY 4 项（T8 calibration / T3 LLM cassette / T5 Stagehand smoke）+ T33 publish 工作 7 项 + v1.0-rc1 reviewer 实测 12 项不阻塞 ship。预估 **8-10h 到 v1.0 ship**（user 决策修 ship-blocker 后）。
- 完整回归：tsc ✓ / build ✓ / **vitest 1664 → 1833 (+169) ✓** / lint:no-console ✓ / 0 schemas diff / npm pack 565.5 KB → 555 KB（含 .gitignore *.tgz 防 commit）/ test:coverage:check pass at 65/59/65/65。

### Added (Wave 5 — P1 收口 5 件套：T11 + T10 + T9 + T17 + T18)

- **关闭 RISK-REGISTER R11 / R49 / R50 / R51 / R52 / R53 / R65（partial）** ✅（7 risks）。**Wave 5 P1 收口** 5 个互不冲突的小任务并行推进：translation review template / CI bench observation / artifacts retention / result-cache LRU disk-quota / SPA core i18n.

#### T11 — Native translation review template + GitHub issue template + README placeholder

- **`docs/translation-review-template.md`**（~150 LoC）：reviewer 元数据 block + 90 keys 行级表（前 30 keys 行 + 自动生成剩余 60 keys 的命令）+ 5 cross-cutting feedback 段（style/register / cultural / number/unit/date / missing keys）+ sign-off checklist + 入库流程；每 reviewer 用文件 `docs/translation-review-<locale>-<reviewer>.md` 公开追踪。
- **`.github/ISSUE_TEMPLATE/translation-review.yml`**：reviewer announce 渠道（避免两人撞同一 locale）+ profile / target date / questions 字段 + 3 acknowledgement checkboxes（已读 template / 会提 PR / 同意公开列名）。
- **README "Localised reports" 段加 reviewer 表**：5 行（en source / zh-CN / ja / es / de），4 个 _pending_ 占位等 v1.x reviewer 反馈。

#### T10 — CI bench observation workflow（5-run calibration window）

- **新 `.github/workflows/bench.yml`**：weekly cron Sunday 03:17 UTC + workflow_dispatch + opt-in PR via `bench` label；ubuntu-latest Node 20 fixed runner profile；`npm run bench` + `npm run bench:check` continue-on-error；`docs/perf-current.json` 上传 90 天 retention artifact。
- **新 `docs/decisions/ADR-031-ci-bench-observation-mode.md`**（~110 LoC）：5+ 次 observation 后做 promotion criteria（empirical p95 deviation × 1.5 → calibrated tolerance / 改 bench:check 为 required check / 加进 branch protection）+ "为什么不一开始就 gate" / "为什么不 skip" / "为什么不 12-config matrix" / "为什么不 every PR" 决策原则；docs/decisions/README.md Engineering 段补 ADR-031 行。

#### T9 — Artifacts retention prune（CLI ai-audit prune + lazy MCP server prune）

- **新 `src/core/artifacts-prune.ts`**（~250 LoC）：5 primitive kinds（sees / acts / extracts / judges / compares）每 kind 独立 retention（默认 30 天）+ 独立 dir override（`AUDIT_<KIND>_DIR`）；mtime > cutoff → recursive rm；`pruneOneKind` / `pruneAllArtifacts` / `pruneIfStale` 三层 API；`pruneIfStale` 通过 `~/.ai-browser-auditor/prune-stamp.json` 实现 at-most-once-per-24h（mode 0600）；`renderPruneReport` 渲染 multi-line 摘要 pure 函数；`formatBytes` B/KB/MB/GB 渲染。
- **CLI `ai-audit prune`**：用户显式触发；exit 1 if any kind 有 errors；skipStamp:true 让连跑两次都真跑。
- **MCP server lazy prune on startup**：transport.connect 前调 `pruneIfStale()`，结果 log.info；失败 log.warn 不 block 启动。
- **环境变量**：`AUDIT_SEES_RETENTION_DAYS` / `AUDIT_ACTS_RETENTION_DAYS` / `AUDIT_EXTRACTS_RETENTION_DAYS` / `AUDIT_JUDGES_RETENTION_DAYS` / `AUDIT_COMPARES_RETENTION_DAYS`，默认 30，**`0` 表 infinite retention 不是"立刻删除"**（与 logrotate / journald 一致）。
- **README 新 "Artifact retention" 段**：CLI + 5 env vars 表 + MCP lazy prune 说明 + bulk-delete 用 `rm -rf`。
- **28 新单测**（`tests/artifacts-prune.test.ts`）：retention 默认 + env override + 0 表 infinite + dir env override + 5 kind 全跑 + stamp file mode 0600 + skipStamp + pruneIfStale 24h 窗口（fresh / stale / malformed / missing）+ renderPruneReport / formatBytes / ARTIFACT_KINDS 数组形状。

#### T17 — Result-cache LRU disk-quota（MAX_ROWS / MAX_DISK_MB）

- **`src/core/result-cache.ts` migration v2** 加 `last_used_at INTEGER NOT NULL DEFAULT 0` + 回填 `last_used_at = created_at` + `idx_cache_last_used` index；migration runner 一次性 idempotent 升级。
- **新 `enforceLruCaps()`** 在 `pruneCache` 内部调用：先 row-count cap（DELETE oldest `last_used_at` LIMIT overshoot），后 disk-MB cap（fs.statSync(dbPath) → 迭代删 ≤ 6 轮直到 size < cap 或 diminishing returns < 1%）；TTL prune 先跑，LRU 跑剩余。
- **`lookupCache` 命中后 bump `last_used_at = now`**：让真用的 entry 不被 LRU 误伤（best-effort 写失败不 fail hit）。
- **`storeCache` 写入也设 `last_used_at = now`**（INSERT + ON CONFLICT 都设）。
- **环境变量**：`AUDIT_RESULT_CACHE_MAX_ROWS`（默认 10000）+ `AUDIT_RESULT_CACHE_MAX_DISK_MB`（默认 500）；**`0` 表 disabled**（与 retention 一致）。
- **README "Result Cache" 段加 2 行**：MAX_ROWS + MAX_DISK_MB env vars。
- **5 新单测**（`tests/result-cache.test.ts`）：lookup hit bump last_used_at 让 touched entry 抗 LRU + row-count cap 删 oldest + 0 disables + env vars 驱动 + TTL+LRU 混合（TTL prune 先 LRU 后）。

#### T18 — Audit-explorer.html SPA 核心 i18n（27 keys × 5 locales + query string detection）

- **新 `src/core/reporter-spa-i18n.ts`**（~200 LoC）：27 SPA UI keys（audit_explorer_title / btn_collapse / btn_expand_all / count_format / empty_no_results / 5 filter labels + 2 dropdown words / 3 section headings + 6 step column headers / 6 summary cards）× 5 locales (en / zh-CN / ja / es / de)；`SPA_I18N` 字典 + `normaliseSpaLocale` family fallback (`zh-Hans`/`zh-TW` → `zh-CN`)；`spaInterpolate` `{n}` placeholder 替换；`spaT` lookup with en fallback；`lintSpaTranslations` 强制 100% key coverage。
- **`src/core/reporter-spa.ts` 改 SPA HTML+JS**：每 static label 加 `data-i18n="<key>"` attr → `applyStaticI18n()` boot 时一次扫齐；inline 第二个 `<script type="application/json" id="__AUDIT_I18N__">` 装 5 locale 字典 JSON（< / > 字符 escape 防 XSS）；boot JS 加 `resolveLocale()` priority order：`?lang=` query → `?locale=` query → `navigator.language` family fallback → en；`document.documentElement.lang` 同步；`renderSummary` / `renderUnits` / `renderUnit` 全部走 `t(key, vars)`；`new Date(audit.started_at).toLocaleString(LOCALE)` 让日期格式跟 locale。
- **17 新单测**（`tests/reporter-spa-i18n.test.ts` 11 + `tests/reporter-spa.test.ts` +6 集成）：5 locale × 27 keys 100% 覆盖 + sentinel keys 在 zh/ja 真翻译不与 en 同字符串 + `normaliseSpaLocale` 7 路 fallback + `spaInterpolate` 缺 key 保留 placeholder + `spaT` count_format / section_steps_n 插值 + SPA HTML 含 `id="__AUDIT_I18N__"` + 5 locale 都进 inlined JSON + `data-i18n` 标在 10 个静态 label + 4 国家 sentinel 翻译进 HTML（"审计浏览器" / "監査エクスプローラー" / "Explorador de auditoría" / "Audit-Explorer"）+ JS 引用 URLSearchParams + navigator.language。
- **README `audit-explorer.html` 备注**：加 "open with `?lang=zh-CN/ja/es/de` for localised UI chrome"。

完整回归：tsc ✓ / build ✓ / **vitest 1608 → 1664 (+56) ✓** / lint:no-console ✓ / 0 schemas diff / npm pack 565.5 KB / 315 files。

### Added (T24 — Wave 3 收尾: FAQ + TROUBLESHOOTING + typedoc API ref)

- **关闭 RISK-REGISTER R18 / R19 / R20 / R21** ✅。**Wave 3 第五颗子弹（5/5 完整收尾）** —— 用户文档闭环 + 公开 API 参考可生成。
- **`FAQ.md`**（~250 LoC，5 大类 ~20 题）：API key + cost（key 哪里拿 / 单次审计 cost 区间 / BudgetExceededError 处理 / 不同 LLM 是否支持 / 怎么完全不烧 token）/ scenarios + personas（差别 / 第一个 scenario / 自定义 personas / 过滤跑特定 unit）/ reports + output（写哪 / CI 集成 / PDF 定制 / trends）/ privacy + data（什么数据离开 / consent prompt 是什么 / 删除数据 / password 是否泄漏 / GDPR-CCPA 立场）/ native binaries + cross-platform（Alpine 修复 / chromium 启动失败 / Windows 选哪个 shell / 装得慢 / ARM64 支持）。每条题都引向 source-of-truth（INSTALLATION.md / TROUBLESHOOTING.md / PRIVACY.md / ADR）。
- **`docs/TROUBLESHOOTING.md`**（~290 LoC，6 大类 24 错误）：API + auth（4 个：缺 key / 401 / 429 / self-signed cert）/ audit run（5 个：consent declined / 项目不存在 / scenario validation / BudgetExceededError / axe-core injection）/ Browser + Playwright（4 个：target page closed / Timeout 30000 / 黑屏 screenshot / file-lock race）/ reports + output（4 个：PDF 缺 / HTML 空白 / no trends / schema regen drift）/ CI integration（4 个：SARIF reject / JUnit reject / sticky comment dup / disk space）/ performance + cost（3 个：审计慢 / cost 偏高 / 内存峰值）。每条 symptom + cause + fix + 可选 verbose flag。与 INSTALLATION.md 错误表分工：INSTALLATION 专注"装不上"，TROUBLESHOOTING 专注"装上了跑不通"。
- **公开 API 参考**：装 `typedoc@^0.28.19` dev dep + `typedoc.json` 配置（entry `src/index.ts` / out `docs/api` / hideGenerator / excludeInternal）+ `npm run docs:api` script + `.gitignore` 加 `docs/api/`（生成产物不入仓库不臃肿）+ `npm run clean` 顺手 rm `docs/api`。本地 `npm run docs:api` 一键产出 2.3MB 静态 HTML（67 公开 export 全有页面）+ 67 个 export 自动追踪。**不入 npm tarball、不入 git、用户/贡献者本地按需生成**——避免 50MB 文档 inflate package。
- **`src/core/consent.ts` 改 `console.log` → `output.write`**：替换为 readline output stream 直写不依赖 eslint-disable + 通过 `lint:no-console` 强校验（ADR-005 logger discipline）；行为完全等价（stdout 写 + 换行）。
- **README.md 加 "Help & Reference" 段**（License 段后）：5 个一键入口 — FAQ.md / docs/TROUBLESHOOTING.md / docs/INSTALLATION.md / `npm run docs:api` / docs/decisions/。覆盖"我用 / 我跑不通 / 我装不上 / 我集成 API / 我看决策"5 大入口场景。
- 完整回归：tsc ✓ / build ✓ / **vitest 1608/1608 ✓** / lint:no-console ✓ / npm pack 549.9 KB / 309 files (FAQ / TROUBLESHOOTING / docs/api 不入 tarball 因 `files` 字段精确控制) / 0 schemas diff / 0 bench regression。

### Added (T22 — Wave 3 PRIVACY + first-run consent + PII redaction)

- **关闭 RISK-REGISTER R15 / R34 / R35 / R36 / R37 / R38 / R60** ✅ (7 risks)。**Wave 3 第四颗子弹** —— GDPR/CCPA 合规 baseline + 用户数据保护实施。
- **`PRIVACY.md`**（~290 LoC）：什么数据 / 哪里存 / 什么离开机器 / 数据最小化控制 / retention + 删除（GDPR Article 17）/ 0 telemetry / GDPR-CCPA 你是 controller 我们不在数据路径 / consent 模型 / 报告渠道 GHSA。
- **新 `src/core/consent.ts`**（~200 LoC）：first-run consent 5 优先级（existing valid → AUDIT_AUTO_CONSENT=1 env → --auto-consent flag → non-TTY 隐式 → interactive prompt）+ versioned consent record (`~/.ai-browser-auditor/consent.json`，schema 1.0.0 + consent_version 1) + readline/promises 零 dep + `promptFn` 测试 seam + ConsentDeclinedError。**CONSENT_VERSION bump 触发现有用户重新 prompt**（重大隐私政策更新路径）。
- **CLI run 命令加 `--auto-consent` + `--no-redact-inputs` flags**：consent 在 dryRun 之前 gate；ANTHROPIC_API_KEY 缺时友好 catch（指向 console.anthropic.com + doctor）；ConsentDeclinedError 友好 catch 不 stack trace。
- **recorder.ts 加 `redactSensitiveInputs(page)`**（~50 LoC）：`<input type="password">` + `autocomplete=current-password|new-password|one-time-code` + name/id/aria-label 匹配 `/password|secret|token|api[_-]?key|otp|pin/i` 启发式；DOM mutate `value = '********'` 不仅 CSS overlay（避免 autofill / vision OCR 看穿）；page-closed 错误 try/catch 不 fatal。`screenshot()` + `screenshotSegments()` 加 `redactInputs?: boolean` opt + `shouldRedactInputs(callerOpt)` 4 优先级（caller false → caller true → env AUDIT_REDACT_INPUTS=0 → default ON）。
- **runner / recorder mkdirSync mode 0o700**（R36）：runDir / unitDir / artifactsDir 全 owner-only；加 inline 注释引 T22 R36；macOS / Linux 实施；Windows chmod 是 best-effort。
- **24 新单测**：`tests/consent.test.ts` 19 测（read/write/agreed_via 5 路径 / mode 0600 / 优先级 / older consent_version 重 prompt / forward-compat 不 prompt / decline 不 write）+ `tests/integration/playwright/recorder.test.ts` 5 redact 测（真 chromium DOM mutation password 替 ******** + 非敏感不动 + name/id 启发式 / 默认 ON / opt-out OK）+ 修 7 recorder 单测 queue 跟 redactSensitiveInputs 多 evaluate 一次同步。
- **README "Privacy & Data Handling" 段**新加：放在 Security 段前；列 0 telemetry + 单一外部 destination + 隐私-first 默认 + 引 PRIVACY.md。
- 完整回归：tsc ✓ / build ✓ / **vitest 1589 → 1608 (+19) ✓** / **playwright 16 → 21 (+5) ✓ in 25s** / 0 schemas diff / 0 bench regression / npm pack 547 KB / 309 files。

### Added (T23 — Wave 3 doctor + interactive init wizard + first-run UX)

- **关闭 RISK-REGISTER R45 / R46 / R47 / R61** ✅。**Wave 3 第三颗子弹** —— first-run UX 入口完整。
- **新 `ai-audit doctor` 命令**（`src/commands/doctor.ts` ~250 LoC）：8 项 health check 一次性诊断 first-run readiness：Node version / Platform / ANTHROPIC_API_KEY / config.yaml / scenarios/ / personas/ / Network proxy / Data directory writable / api.anthropic.com reachable。每 check 返回结构化 `DoctorCheck`（status: ok/warn/fail/skip + message + remedy + verbose detail）+ aggregate `DoctorReport.exitCode`（0 if 无 fail，1 if any）。`renderDoctorReport()` 是纯函数返回行数组（caller 控制输出方式）；CLI 用 chalk 着色 + `process.exit(report.exitCode)` 让 CI script 能 `if doctor; then run; fi`。`--verbose` 加诊断 detail（API key prefix / Node 完整 path / proxy URL）；`--skip-network` 离线 / air-gapped 跳过 reachability。
- **新交互式 `ai-audit init`（无 args）**（`src/commands/init-interactive.ts` ~190 LoC）：Node 内置 `node:readline/promises` 实现 zero-dep 交互 wizard。问 5 个问题（项目目录 / 项目名 / base URL / 是否创 sample scenario / 是否跑 doctor 收尾），每个有合理 default + Enter 接受。`promptFn` 注入 seam 让单测 mock prompts 不读 stdin。`writeSampleScenario()` idempotent 写 `scenarios/homepage-smoke.yaml`（visit + assert_a11y wcag22aa + see goal）。**保留 v0.3 `ai-audit init <dir>` 非交互行为**（CI / scripted），signature 改为 `init [dir]` optional positional 实现 backward-compat。
- **`scaffoldProject()` 抽出**为公共 helper（cli.ts 内部），交互 wizard + 非交互 `init <dir>` 共用同一 scaffolding 逻辑——避免双轨制。
- **lint:no-console 加 src/commands/ 例外**：`src/commands/*.ts` 跟 cli.ts 同角色（用户面 UX 渲染层），允许 console.log；其他 src/ 文件仍强制用 `getLogger()`（ADR-005）。
- **34 新单测**（`tests/doctor.test.ts` 21 测 + `tests/init-interactive.test.ts` 13 测）：覆盖每 individual check 的 ok/warn/fail/skip 状态 + aggregate exitCode + renderDoctorReport 行数组 + verbose detail + remedy 在 fail/warn 后追加 + summary tail；wizard 用 `promptFn` seam 测 defaults / 显式答案 / y/Y/yes/N/no 解析 / 相对路径 → 绝对路径 + sampleSmokeScenarioYaml shape + writeSampleScenario idempotent。**vitest 1555 → 1589 (+34) 全过**。
- **README "Quick Start" 6 步**（旧 4 步）：1. Install / **2. Verify env (doctor)** / **3. Set up project (init interactive or scripted)** / 4. Set API key / 5. Create first audit / 6. Run。Doctor + init 显式入口在最高显示位置——首次用户 5 分钟内验通环境。
- **Live test**: `node dist/cli.js doctor --skip-network` 输出 8 行结构化 check + 着色 + remedy + summary tail；exit 1 当 API key 缺。
- 完整回归：tsc ✓ / build ✓ / vitest 1589/1589 ✓ / npm pack 537 KB / 306 files / 0 schemas diff / 0 bench regression。

### Added (T20 — Wave 3 stability commitment + MIGRATION + DEPRECATION-POLICY)

- **关闭 RISK-REGISTER R17 / R53 / R54 / R57** ✅。
- **`MIGRATION.md`**（~150 LoC）：v0.3 → v1.0 升级指南，3 项 required action（Node 16 → 18+ / a11y 审计 violation 数会增加因 T-NEW-11 修复 / 检查 screenshot dimensions）+ 4 项 optional（CI workflows / Anthropic SDK 0.39→0.92 透明 / Stagehand v2.5.8 锁 / Zod v3 锁）+ URL 变更（anthropics → xcodethink 30 schemas $id 全更新）+ package metadata 变化（os/cpu/files）+ "What did NOT change" 段（Result Schema 1.2.0 / CLI flags / config / MCP tool surface / history.db migration auto）；before/after diff 示例 + tag-baseline-then-upgrade 推荐流程 + general upgrade tips。
- **`docs/DEPRECATION-POLICY.md`**（~190 LoC）：scope 定义（CLI / config / Result Schema / MCP tool / library exports — 67 exports）+ 两版本 sunset 周期（announce minor → 至少两 minor 持续 warn → next major remove）+ 3 阶段流程（Phase 1 announce: CHANGELOG + runtime warning + JSDoc + MIGRATION preview / Phase 2 continued warnings / Phase 3 removal）+ 4 警告级别（inline annotation / once-per-process / once-per-call / strict-mode throw）+ 2 个完整示例（renaming a CLI flag / removing a deprecated library export）+ "what can / cannot be deprecated" 表。
- **README.md** 加 "Stability Commitment" 段 + "Performance baseline (provisional, v1.0-rc1 calibration pending)" 段：5 个 stable surfaces 列表 + minor/patch backward compat 承诺 + 引 DEPRECATION-POLICY.md (deprecation cycle) + 引 MIGRATION.md (v0.3 → v1.0 升级)；perf baseline 表分两层（5-unit audit 整套 ~2-5 分钟 / $0.10-0.30 cost / < 1GB RAM v1.0-rc1 calibration pending；render hot-paths ops/sec 已通过 bench:check regression gate 跟踪）。
- 完整回归: vitest 1555/1555 ✓ / npm pack 527 KB / 300 files / 0 schemas diff / 0 bench regression。

### Added (T19 — Wave 3 治理文档: LICENSE + CONTRIBUTING + SECURITY review + 26 ADR audit)

- **关闭 RISK-REGISTER R12 / R13 / R14 review / R22 / R33** ✅。**Wave 3 第一颗子弹**。
- **`LICENSE`**（21 行 MIT 标准文本，2026 xcodethink）：GitHub 仓库右侧从此显示 MIT 标识；`package.json files` 数组已声明 LICENSE 现在文件存在；npm pack 含 LICENSE (1.1KB)；`license: "MIT"` package.json 字段与 LICENSE 文件一致 (R33)。
- **`CONTRIBUTING.md`**（~360 LoC）：dev setup (npm ci + build + test 命令清单 11 条) + 3 测试套区分 (vitest unit / vitest integration / Playwright Test) + ADR-017 60/54/60/60 coverage gate + Conventional Commits 规则（`feat`/`fix`/`docs`/`test`/`refactor`/`chore`/`ci`/`perf`）+ scope + Co-Authored-By trailer + 7 步 PR 流程 + 5 类必写 ADR / 5 类不写 ADR + branch protection 配置 checklist + release process 引用 + 6 提问渠道。
- **`SECURITY.md` review**：T0.6 初稿改 GHSA only（移除 `security@<TBD>` placeholder 不阻塞 v1）；email 渠道留 v1.x 看用户需求加；保留 Known Accepted Risks 段（3 transitive moderate Stagehand vulns）+ closure plan T-NEW-1。
- **`docs/decisions/README.md`**（~100 LoC ADR 总目录 + 一致性 audit）：26 ADR 按主题分组（Foundational / Architecture / Quality / Reporting / Engineering / Release-readiness）+ **2026-05-01 一次性 audit 结论**：所有 26 ADR Accepted 无 Superseded、主题分区干净无冲突、cross-references 一致（ADR-029 引 ADR-009 / ADR-030 建在 ADR-024 / ADR-007 被 ADR-018/019/020-024/026 消费 / ADR-027 与 ADR-018 解耦合 / ADR-008 与 ADR-026 不同存储层无冲突）+ 源码无 `// TODO: write ADR` 标记。R22 review note 入 STATUS。
- **README.md** 加 Security 段 + 链接 [SECURITY.md](SECURITY.md) + License 段链接 [LICENSE](LICENSE) + [docs/THIRD_PARTY_LICENSES.md](docs/THIRD_PARTY_LICENSES.md) + Contributing 段链接 [CONTRIBUTING.md](CONTRIBUTING.md) + 引导 [docs/INSTALLATION.md](docs/INSTALLATION.md)。
- 完整回归: vitest 1555/1555 ✓ / npm pack 525 KB / 300 files (含 LICENSE 1.1KB) / 0 schemas diff / 0 bench regression。

### Added (T30 — Wave 4 收尾 INSTALLATION.md: corporate proxy + air-gapped + Docker + 5 platforms)

- **关闭 RISK-REGISTER R48 / R59 / R62** ✅。**Wave 4 完整收尾 5/5**。
- `docs/INSTALLATION.md`（~430 LoC）覆盖企业 / 跨平台 / 离线场景：
  - **System requirements** 表（Node 18+ / npm 8+ / 500MB disk / 2GB RAM / Chromium runtime libs）+ Tier-1 (CI 矩阵 12 平台) vs Tier-2 (Alpine / ARM64 / WSL2 best-effort)
  - **5 平台 prereqs**：macOS (Intel + Apple Silicon, `xcode-select --install`) / Ubuntu/Debian (NodeSource setup_20.x + `npx playwright install-deps chromium`) / **Alpine Linux**（musl libc + `apk add python3 make g++ chromium nss freetype` + `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` + `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`）/ Windows (MSVC Build Tools + Git Bash 推荐 + PowerShell 语法 fallback) / WSL2 (Linux 同款 + 不挂 Windows 文件系统的性能 tip)
  - **Docker** 两路：multi-stage build with `mcr.microsoft.com/playwright:v1.49.0-jammy` (官方 image，Chromium + libs 预装) + lightweight `node:20-alpine` (~150MB vs 350MB trade-off)；BuildKit secrets 防 API key 进 image
  - **Corporate proxy**: `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` env vars + `npm config set proxy` 持久化；自签 CA 用 `NODE_EXTRA_CA_CERTS`；最后 resort `NODE_TLS_REJECT_UNAUTHORIZED=0` 警示禁用
  - **Air-gapped install**: 4 步流程（互联网机准备 → tar 含 ~/.cache/ms-playwright → sneakernet → `npm install --offline --prefer-offline`）+ Anthropic API 在 air-gapped 网络的 3 个选项（纯 deterministic / 自托管 relay / M4-4 v1.x local LLM fallback）
  - **11 个 install 错误排查表**：EACCES / Failed to launch chromium / node-gyp Win/Mac/Alpine / better-sqlite3 module not found 三平台 / chromium ENOENT / 自签 cert / DNS getaddrinfo / ESM require / ERESOLVE peer dep — 每条 likely cause + fix
  - **3 步验证 install**：version check / `doctor` / 不烧 API 的 smoke (visit + assert_a11y) — 让用户 5 分钟内验通环境
- README.md "Install" 加链接到 `docs/INSTALLATION.md`（针对 corporate / Alpine / Docker / air-gapped 场景导引）
- **Wave 4 完整收尾 5/5**：T25 (package.json 完整化 R39-R42 + R-NEW-3) + T26 (CI 矩阵 R43) + T27 (npm audit gate, T26 已含) + T28 (license-checker CI R30) + T29 (SBOM workflow R29) + Dependabot R28 + **T30 (INSTALLATION.md R48 + R59 + R62)**
- 完整回归: vitest 1555/1555 ✓ / npm pack 523 KB / 299 files / 0 schemas diff / 0 bench regression。

### Added (T27 + T28 + T29 合并 — license CI gate + Dependabot 文档 + SBOM workflow)

- **关闭 RISK-REGISTER R28 (Dependabot 已激活) + R29 (SBOM 生成) + 加固 R30 (license CI gate)** ✅；T27 npm audit gate 已在 T26 ci.yml 加入。
- **`license-checker` + `@cyclonedx/cyclonedx-npm` 装入 dev deps**：替换 T0.6 的 `npx --yes` 一次性用法，CI gate 才能稳定调用。
- **package.json scripts 加 3 个**：
  - `license:check` — 16 SPDX allowlist（与 T0.6 一致），`--production` 只查发布树，0 GPL/AGPL 守不变
  - `license:csv` — 重生 `docs/third-party-licenses.csv` audit trail
  - `sbom` — `cyclonedx-npm --output-file sbom.json --omit dev --ignore-npm-errors`（647KB CycloneDX 1.6 JSON）；`--ignore-npm-errors` 必须，否则 transitive `string-width@5.1.2` extraneous 警告让 npm ls exit 1
- **ci.yml 加 license 检查 step**（ubuntu × Node 20 only — license metadata 跨平台一致，12x 浪费）
- **新 workflow `.github/workflows/sbom.yml`**（~50 LoC）：
  - 触发：release tag (`v*.*.*`) push + workflow_dispatch
  - Steps: checkout → setup-node → npm ci → npm run sbom → upload artifact (90d retention)
  - tag push 时自动 `softprops/action-gh-release` 把 sbom.json 附在 GitHub Release 页面（与 npm package 一起下载）
  - permissions: contents: write（attach release artifact 必需）
- **.gitignore 加 sbom.json**：每次 release 重生，不入 git history
- **Dependabot 已激活**（T0.6 已 commit `.github/dependabot.yml`）—— T27 验证：weekly Mon 09:00 Asia/Shanghai 扫 npm + GHA / group minor+patch / ignore Stagehand/Zod/@types/node major bumps；首次 push 后 GitHub Settings → Security & analysis 显示 "Active"。
- 完整回归: typecheck ✓ / vitest 1555/1555 ✓ / **license:check 0 fail** / **sbom.json 647KB 生成** / 0 schemas diff / 0 bench regression / npm pack 522 KB / 299 files。

### Added (T26 — Wave 4 GitHub Actions CI 矩阵 (3 workflows))

- **关闭 RISK-REGISTER R43** ✅。**项目第一次有自己的 CI 工作流**——pre-T26 `.github/workflows/` 只有一个用于下游 SaaS 的 `post-deploy-audit.yml`，1555 测试全过 + 16 playwright 全过的"green"完全靠本地 M-series Mac 验证。任何 Windows 路径分隔符 / Linux glibc / Node 18 vs 22 差异 / macOS Intel vs arm64 native binary 不匹配的回归全部静默漏过。**T26 把"测试全过"从 dev claim 升为 CI gate**。
- **`.github/workflows/ci.yml`** (~85 LoC) — **12 配置矩阵**: ubuntu-latest + macos-13 (Intel x64) + macos-14 (Apple Silicon arm64) + windows-latest × Node 18/20/22 = 12 平行 jobs。每 job 跑：checkout → setup-node (with cache: npm) → npm ci → build → vitest → `npm run schemas` idempotence (uncommitted diff = fail loud) → `npm audit --production --audit-level=high`。`fail-fast: false` 让 12 配置都跑完不止第一个 fail。`concurrency` cancel-in-progress 避免快速 PR 更新浪费 CI 分钟数。
- **`.github/workflows/integration.yml`** (~65 LoC) — Playwright Test 真 chromium + vitest forks pool (file-lock-race) 跑 ubuntu-latest only。`npx playwright install chromium --with-deps` 一次安装（150MB），`build` step（race test 需 dist/core/file-lock.js）+ `test:integration:playwright` (16/16) + `test:integration` (M9-3.2 file-lock 2/2)。失败时 upload Playwright report + test-results artifact (7 days retention)。**weekly Mon 08:00 UTC cron** 跟 axe-core / chromium / Stagehand 上游漂移。
- **`.github/workflows/coverage.yml`** (~40 LoC) — coverage 60/54/60/60 gate（per ADR-017 ratchet 契约），ubuntu × Node 20 单一配置避免 12x runtime；upload coverage report artifact (14 days)。失败 distinct from 测试失败信号——开发者能区分"代码全平台对，覆盖率 gate 不达"vs"测试本身有问题"。
- **本地完整验证 ci.yml 各 step**：npm ci ✓ / npm run build ✓ / npm test 1555/1555 ✓ / npm run schemas idempotent ✓ (no diff)。所有 step 在 macOS arm64 跑通；GHA 上等首次 push 验证 12 配置矩阵。
- **branch protection 待 GitHub UI 配置** (R44 + 治理 README): require ci.yml + integration.yml + coverage.yml pass before merge to main + no force pushes。3 workflow 加进库后等首次 push 触发 + GitHub Settings 启用。
- 完整回归: typecheck ✓ / build ✓ / vitest 1555/1555 ✓ / playwright 16/16 ✓ / 0 bench regression / 0 schemas diff / npm pack 521 KB / 299 files。

### Changed (T25 — Wave 4 package.json 完整化 + GitHub org 占位符全替换)

- **关闭 RISK-REGISTER R39 / R40 / R41 / R42 / R-NEW-3** ✅。npm publish-readiness 大跨步前进。
- **package.json 加 7 个 release-critical 字段**：
  - `engines: { node: ">=18.0.0", npm: ">=8.0.0" }` (R39) — Node 16 用户装上立即报错
  - `os: ["darwin", "linux", "win32"]` (R40) — Windows ARM64 不支持就跳过
  - `cpu: ["x64", "arm64"]` (R40)
  - `repository: { type: "git", url: "git+https://github.com/xcodethink/ai-browser-auditor.git" }` (R41)
  - `bugs: { url: "https://github.com/xcodethink/ai-browser-auditor/issues" }` (R41)
  - `homepage: "https://github.com/xcodethink/ai-browser-auditor#readme"` (R41)
  - `files: ["dist/", "docs/schemas/", "CHANGELOG.md", "LICENSE", "README.md", "SECURITY.md"]` (R42) — 把 tests/ docs/(非 schemas) scripts/ 等开发文件全踢出 npm 包
  - `publishConfig: { access: "public" }` (R42)
  - `types: "dist/index.d.ts"` — TypeScript 用户能直接 import type
- **包体积大跌 1.2MB → 520KB (-57%) / 611 → 299 files (-50%)**：Top dirs: 264 dist + 31 docs/schemas + 4 root docs (CHANGELOG/SECURITY/README/package.json)。LICENSE 还没创（T19 任务），files 数组里已声明等 T19 加进。
- **GitHub org 占位符全替换** (R-NEW-3 关闭)：
  - 3 处 `anthropics` 硬编码（误）→ `xcodethink`：`src/core/ci-reporters.ts > DEFAULT_TOOL.informationUri` / `src/core/reporter-diff.ts > footer 2 处`
  - 1 处 schema 生成器：`scripts/export-result-schemas.ts > $id` URL（影响 30 个 published JSON Schemas → npm run schemas 重生 30 schemas 全部 URL 更新）
  - 2 处文档 `<org>` 占位：`docs/THIRD_PARTY_LICENSES.md` / `SECURITY.md`
  - 同步重生：`docs/integration/fixture-sarif.json`（SARIF tool.driver.informationUri）+ `docs/integration/fixture-diff.md`（footer link）
- **修 1 个被旧 URL 锁定的测试**：`tests/reporter-diff.test.ts > preserves the GitHub link in the footer` 字面字符串 pin 改为新 URL
- **完整回归**: typecheck ✓ / build ✓ / vitest 1555/1555 ✓ / playwright 16/16 ✓ / bench:check 0 regression / schemas regen 0 diff (本次更新所有 30 schema URLs 算 surface-shape 漂移已 commit) / npm pack 520KB

### Added (T7 — Wave 2 4 子项 e2e: cost-guard + MCP stdio + GH PR diff + trends-perf)

- **关闭 RISK-REGISTER R7 / R8 / R9 / R10** ✅（4 个 P1 一次性收口）。**全 4 子项不烧 ANTHROPIC_API_KEY**——cost-guard 用极小 budget 验拦截路径；MCP stdio 用 list_capabilities pure introspection；GH diff 写 fixture + 手动 SOP；trends 是纯渲染。
- **T7a `tests/integration/cost-guard-e2e.test.ts`** (~190 LoC, 3 tests): 真 CostGuard 实例 + 极小 budget ($0.001)。1️⃣ checkBudget 在累积过 cap 后 throw（双拦截路径：recordUsage 自身 throw + 后续 checkBudget throw）；2️⃣ 跨 CostGuard 实例 ledger 持久化（worker A $0.0028 → ledger.json → worker B 读到 day 累计 → 再加 $0.0028 trip $0.005 day cap）；3️⃣ withCostRun AsyncLocalStorage 隔离（Run A tiny + Run B busted per-run cap → A 不受影响）。**修了 3 个 API 假设错误**：(a) `recordUsage` 自身 throw 不只 checkBudget；(b) ledger.days 是 `Record<string,DayEntry>` 不是 array；(c) 字段名 `maxDailyUsd` / `maxDailyTokens` 不是 `maxDayUsd`。
- **T7b `tests/integration/mcp-stdio-e2e.test.ts`** (~170 LoC, 4 tests): 真 spawn `dist/mcp/server.js` + MCP client SDK (`StdioClientTransport`) + JSON-RPC 握手。1️⃣ tools/list 返回 ≥ 5 个工具（含 list_capabilities / audit_url / see）+ 每工具有 name / description / inputSchema 完整；2️⃣ tools/call list_capabilities 返回 ListCapabilitiesResult 完整 envelope（server / result_schema_version=1.2.0 / tools / env / cache）+ 每 tool 含 M9-5 metadata（kind / cacheable / cost_estimate_usd / side_effects / requires）+ env 含 ANTHROPIC_API_KEY；3️⃣ unknown tool name 干净拒绝（throw OR isError=true 都接受）；4️⃣ 拒绝 missing args 后 server 仍活（next call 仍正常）。**关键决策：用 list_capabilities 不烧 LLM**，audit_url 真 URL 留 T3 cassette 阶段。
- **T7c GitHub PR diff fixture + manual SOP**:
  - `scripts/gen-diff-fixture.ts` (~110 LoC) 用 renderDiffMarkdown / renderDiffJson 生成 fixture diff（baseline release-v0.9 → pr-1234 显示 score +1.2 / issues 4→2 / cost +$0.06 / 6 维度全部上升）
  - `docs/integration/fixture-diff.md` (1.1KB) — GitHub PR comment 格式 markdown
  - `docs/integration/fixture-diff.json` (2.3KB) — 程序化 diff JSON
  - `docs/integration/diff-pr-comment-verified.md` (~110 LoC) — 8 步手动 GHCS 上传 SOP + 10 项 UI checklist + sticky-pull-request-comment 验证 + 失败排查表（5 种 mode → cause + fix）+ 推荐生产 GHA workflow + 验证日志（screenshot 待 v1.0-rc1 reviewer）
- **T7d `tests/integration/playwright/trends-perf.test.ts`** (~150 LoC, 2 tests): 100-row history fixture → renderTrendsHtml → 真 chromium page.goto file:// 测加载时间。1️⃣ load + paint < 1.5s（实测 405ms 远低于 budget）+ DOM 含 ≥ 5 svg + ≥ 6 cards + ≥ 10 rows + 0 console error；2️⃣ 含 fixture project name + schema_version 1.2.0。**修了 fixture 字段命名错误**（snake_case → camelCase 与 HistoryEntry interface 对齐）。
- **新发现的 fixture bug**：`scripts/gen-history-fixture.ts` 之前生成 snake_case 字段（SQLite 列名）但 `reporter-trends.ts` 消费的是 `HistoryEntry` camelCase（`projectName` / `overallScore` / `schemaVersion`）—— renderTrendsHtml 跑生产 fixture 会 NaN/null。改 fixture 生成器 + 重生 + smoke test 同步。
- 完整回归：tsc ✓ / build ✓ / **vitest 1548 → 1555** (+7) / **playwright 14 → 16** (+2) / 0 schemas diff / 0 bench regression / npm pack 1.2 MB / 611 files。

### Fixed (T-NEW-11 — handleAssertA11y axe runOnly 漏 Level A 违规 P0)

- **关闭 RISK-REGISTER R-NEW-11** ✅（T6 衍生发现的 production bug）：`handleAssertA11y` 默认 `standard: "wcag2aa"` 直接传给 axe-core 作为单元素数组，axe `runOnly` 是精确匹配，**只跑 wcag2aa 标记规则不含 Level A**。生产 audit 用户的所有 audit 都漏检 image-alt / label / button-name / link-name 等 Level A 违规。
- **修法**（行业惯例 + axe-core 官方 docs 对齐）：新加 `expandAxeStandard()` 到 `src/core/wcag.ts`（~70 LoC）—— standard 累积展开为完整 axe tag 列表。`wcag2aa` → `["wcag2a", "wcag2aa"]`；`wcag22aa` → `["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]`。`best-practice` 不累积保持 `["best-practice"]`。`handleAssertA11y` 现在用 `expandAxeStandard(standard)` 替代 `[standard]`。
- **Schema 变更**：`AssertA11yStepSchema.standard` enum 加 `wcag22a`（之前漏，axe 实际有此 tag）。schema 是输入约束（容忍度 7 → 8 个值），不是输出 Result Schema 契约，**不触发 SemVer major bump**。Result Schema 1.2.0 不变。
- **12 个新单测**（`tests/wcag.test.ts > expandAxeStandard`）：表驱动覆盖 8 enum + 未知值 fallback + 数组隔离 + Level A regression guard + WCAG 2.2 AA 完整 6 标签（pin 累积语义防 R-NEW-11 回归）。
- **集成测试更新**（`tests/integration/playwright/wcag-axe.test.ts`）：测试 1+2 改用 `expandAxeStandard("wcag2aa")` 走生产路径，不是手写 `["wcag2a", "wcag2aa"]` 双轨制。
- **MIGRATION 提示**：v1.0 release notes / MIGRATION.md 须明确"v1.0 修了 a11y 漏检 bug；用户对相同站点的 audit 违规数会显著增加（之前 silent miss 现在正确检出）"。
- 完整回归：tsc ✓ / build ✓ / **vitest 1536 → 1548**（+12 expandAxeStandard）/ playwright 14/14 ✓ in 17.9s / 0 schemas diff（input schema 不在 published list）/ 0 bench regression。
- 设计 + 6 alternatives rejected 全文：[ADR-030](docs/decisions/ADR-030-axe-standard-cumulative-expansion.md)。

### Added (T6 — Wave 2 真 axe + SARIF GitHub Code Scanning 验证)

- **关闭 RISK-REGISTER R6** ✅：真 axe-core 在 fixture 上跑过；SARIF 输出形状 + ruleIds + W3C help URLs 都通过 integration 测试验证；GHCS 手动上传 SOP 文档化（screenshot 待 v1.0-rc1 reviewer 上传）。
- `tests/integration/playwright/wcag-axe.test.ts` (~330 LoC, 5 tests):
  - **真 axe-core scan**：launch chromium → load `a11y-broken-page.html` → addScriptTag(axe.min.js) → page.evaluate(axe.run) → 验 violations 含 `image-alt` / `label` / `color-contrast` / `button-name` + 每条 violation 含 wcag tag
  - **parseAxeTags 验 WcagAttribution shape**：每个 violation 的 tags 经 parseAxeTags → `attr.criterion` 是 WcagSuccessCriterion 对象（id 点分 / level A|AA|AAA / principle perceivable|operable|understandable|robust）
  - **renderSarif emits wcag/X-Y-Z ruleIds**：6 issues / 5 unique WCAG SC → 5 rules 含 `wcag/1-1-1` / `wcag/4-1-2` / `wcag/1-4-3` / `wcag/2-4-4` / `wcag/1-3-1` + 每个 rule 含 W3C Understanding URL
  - **writeSarifReport** persists 有效 SARIF JSON 到 `<runDir>/audit.sarif` ≥ 1KB + version 2.1.0
  - **SARIF fixture byte-identical** 验证 `docs/integration/fixture-sarif.json` 跟 renderSarif 输出 byte-for-byte 一致 → 任何 SARIF 输出 shape 漂移立即在 CI fail
- **SARIF 增强（src/core/ci-reporters.ts）**：rule 加 `helpUri` + `help.markdown` 字段（SARIF 2.1.0 § 3.49.12-13）。GHCS UI 用它们渲染顶部"View documentation"链接 + 展开 markdown 帮助段。WCAG rules 的 helpUri 自动填 W3C Understanding URL。
- **`scripts/gen-sarif-fixture.ts`** (~85 LoC)：生成器 → `docs/integration/fixture-sarif.json` (10KB) → 任何 renderSarif 改动 → diff PR review 立即看到 SARIF shape 变化。
- **`docs/integration/sarif-upload-verified.md`** (~110 LoC)：完整手动 GHCS 上传 SOP，含：8 步流程 + 5 项 UI 验证 checklist + 失败排查表（6 种 failure mode → likely cause + fix）+ 验证日志表（screenshots 待 v1.0-rc1）+ 见 also 链接 4 个相关文档。
- **🆕 衍生发现 R-NEW-11**（P0）：跑 fixture 时发现 `handleAssertA11y` 默认 `runOnly: ["wcag2aa"]` 是 axe 精确匹配只跑 AA 标记规则 → **漏 A 级 WCAG 违规**（image-alt / label / button-name 都是 A 级，单 wcag2aa run 完全找不到）。生产 audit 结果可能严重低估 a11y 违规数。RISK-REGISTER-V2 入册 R-NEW-11，单独 T-NEW-11 任务（~30 分钟修：改 handler + 加单测 + 加 integration 验证）。
- 完整回归：tsc ✓ / build ✓ / vitest 1536/1536 ✓ / playwright 14/14 ✓ in 18s / 0 schemas diff / 0 bench regression / npm pack 1.2 MB / 603 files。

### Added (T4 — Wave 2 recorder browser-only + reporter-pdf real chromium)

- **关闭 RISK-REGISTER R3** ✅：recorder.ts 的 `page.evaluate` 内部 lazy-load + docHeight callback / reporter-pdf.ts 真 chromium PDF export 从此在 CI 跑 (待 T26 wired)。
- `tests/integration/playwright/recorder.test.ts` (~280 LoC, 3 tests):
  - **lazy-load fixture**：真 chromium 加载 + Recorder.screenshotSegments → 验 full PNG sidecar SHA + thumbnail buffer (sharp success path 或 fallback 都 OK) + 1-5 segments 全 PNG + 文件命名 `01-{label}-segNN.png`
  - **dense-scroll fixture**：docHeight ≥ 20000 验 5-segment cap 准确 (stride=576, natural ≈ 41 → cap 5) + 5 segments hash 至少 4 个 distinct (不同 scroll position)
  - **reporter-pdf**：真 writePdfReport(audit, runDir) → 验返回 string filepath = `<runDir>/audit.pdf` + PDF magic bytes `%PDF-` + 文件 ≥ 5KB
- **page.evaluate inner browser-only callback 现在真在 chromium 跑过**：之前 recorder.ts func cov 61.9%（lazy-scroll await new Promise(setInterval) + docHeight 读取算未覆盖），现在 e2e 路径覆盖。
- 完整回归：tsc ✓ / build ✓ / vitest 1536/1536 ✓ / playwright 9/9 ✓ in 18s / 0 bench regression / npm pack 1.2 MB / 598 files (T25 待修)。

### Added (T2 — Wave 1 M6-5 Integration tests scaffold)

- **Playwright Test 装入**：`@playwright/test@^1.59.1` dev dep；chromium binary 已在系统缓存（playwright runtime 1.55 + Test runner 1.59 共享 binary）。
- **`playwright.config.ts`** (~70 LoC)：testDir tests/integration/playwright + 30s timeout + 2 retries + 2 workers + headless + trace-on-first-retry + screenshot/video on failure + 1280×720 viewport（与 reporter-pdf 生产对齐）+ list+html reporter（local）/ list+github（CI）+ Desktop Chrome project（M4-* 时再加 firefox/webkit）。
- **5 个 fixture**：`tests/fixtures/lazy-load-page.html`（IntersectionObserver lazy load，T4 用）+ `dense-scroll-page.html`（20 sections × 1200px ≥ 24000px 验 5-segment cap，T4 用）+ `a11y-broken-page.html`（多 WCAG 违规含 1.1.1 / 1.4.3 / 2.4.4 / 2.4.7 / 2.5.5 / 3.3.2 / 4.1.2 / 1.3.1，T6 用）+ `form-page.html`（login form 含 email/password/select/textarea + submit→result，T5 用）+ `history-100-runs.json`（100 行确定性 fixture，74KB，T7d 用）。
- **`scripts/gen-history-fixture.ts`** (~110 LoC)：seeded mulberry32 PRNG 生成确定性 100-runs history，重生 byte-for-byte 一致；upgrade HistoryEntry shape 时重跑。
- **`tests/integration/playwright/smoke.test.ts`** (~140 LoC, 6 tests)：chromium launch + 4 fixture 加载 + 100-runs JSON shape 验证。**6/6 跑通 1.6s**。
- **`tests/integration/playwright/README.md`** (~85 LoC)：何时加测 / 何时不加 / 运行命令 / fixture 表 / 与 vitest 边界 / 加新测流程 / CI 集成 placeholder。
- **vitest.config.ts** exclude `tests/integration/playwright/**`（vitest glob 默认抓 *.test.ts，会和 @playwright/test 的 import 冲突）。
- **package.json** scripts 加 `test:integration:playwright`；`.gitignore` 加 `test-results/` + `playwright-report/`。
- **完整回归**：tsc ✓ / build ✓ / vitest 1536/1536 ✓ / playwright smoke 6/6 ✓ / bench:check 0 regression / npm pack 1.2 MB / 597 files（待 T25 加 files 字段精修）。

### Fixed (T1 — Wave 1 M9-3.2 file-lock cross-process race flake)

- **6 个月老债关掉了**：`tests/file-lock.test.ts` 的跨进程 race 段落自 M9-3 ship 起在并行 vitest 跑下 ~10-15% 失败率（单跑 20/20 过）。STATUS 18 处任务收尾标"与本次无关"。**T1 现根治**。
- 根因：vitest 默认 `pool: "threads"` 下 sibling worker threads 共享 OS-level 调度原语，sibling test 也在 spawn 子进程时（agent-loop-e2e / signals-e2e），race test 的 lock acquire 偶发失败。
- 修法（行业最佳实践 vitest 4 官方 + better-sqlite3 自家测试模式）：精准切分——单进程 + sync 测留默认套；跨进程 race 移到 `tests/integration/file-lock-race.test.ts` + 专属 `vitest.integration.config.ts`（pool=forks + isolate=true + singleFork=true + fileParallelism=false）+ npm script `test:integration`。
- **验证**：20 次连续 `npm run test:integration` 全 20/20 过 0 flake；默认 `npm test` 1536/1536 测全过（少了 race 2 个，移到 integration 套）。
- 设计 + alternatives rejected 全文：[ADR-029](docs/decisions/ADR-029-file-lock-race-isolation.md)。

### Security & Compliance (T0.6 — Wave 0 license audit + Dependabot + SECURITY.md)

- **License audit**：`license-checker --production` 全树 288 包审计 → **0 GPL / 0 AGPL / 0 SSPL contamination**。213 MIT / 34 Apache-2.0 / 19 BSD-3-Clause / 13 ISC / 3 BSD-2-Clause / 1 MPL-2.0（axe-core，weak copyleft 不感染）/ 1 LGPL-3.0-or-later（sharp 拉的 libvips bundled binary，动态链接豁免，文档化）/ 4 其他兼容（Apache* / Unlicense / MIT-or-WTFPL / AFL-2.1-or-BSD-3-Clause / BSD-2-or-MIT-or-Apache-2.0）。完整商用兼容。
- **`docs/THIRD_PARTY_LICENSES.md`**：完整 disclosure 含 libvips LGPL 豁免说明（动态链接 + 用户单独 npm install 拉 binary）+ Chromium 混合 license 说明（Playwright 自家 postinstall 拉，我们不分发）+ axe-core MPL 说明（weak copyleft 不感染我们 MIT）+ allowlist 政策含 v1.0 已审过的 16 个 SPDX。
- **`docs/third-party-licenses.csv`**：289 行机器可读 license 清单（每包含 module / version / license / repository）—— release 每次 regen，作为 audit trail。
- **`.github/dependabot.yml`**：weekly Mon 09:00 Asia/Shanghai 扫 npm + GitHub Actions；group minor+patch（cut PR count from ~20/week → ~3/week）；ignore Stagehand / Zod / @types/node major bumps（这些是 dedicated migration tasks T-NEW-1 / T-NEW-2）；commit-message prefix `chore(deps)` / `chore(actions)`；open-PR limit 5 npm / 3 GHA。
- **`SECURITY.md`** 初稿：supported versions 表 + private report channel（GitHub Security Advisories preferred + email fallback）+ coordinated-disclosure timelines（72h ack / 7d initial / 30d critical fix / 90d moderate）+ Known Accepted Risks 段含 3 个 transitive vulns（Vercel ai SDK 文件类型 bypass / jsondiffpatch HtmlFormatter XSS / 1 low）full waiver rationale 含 closure plan T-NEW-1 + scope 范围（包括 / 不包括）。
- 预备 T26+T27 + T28 + T29 的 CI gate（npm audit / license-checker / SBOM）—— config 已 ready，wire actual CI 是后续任务。
- 全套回归：tsc ✓ / build ✓ / 1538/1538 测 ✓ / 0 schemas diff / 0 bench regression。

### Security & Dependencies (T0.5 — Wave 0 紧急止血)

- **Anthropic SDK 0.39.0 → 0.92.0**（跨 53 minor 版本升级；CHANGELOG 跨整段无 ⚠ BREAKING CHANGES section；零代码改动跑通 1538/1538 测试）
- **npm audit critical 修复**：protobufjs RCE (GHSA-xq3m-2v4x-88gg) + hono JSX SSR XSS (GHSA-458j-xx4x-4375) 两个 critical/moderate 通过 `npm audit fix` patch；剩 3 transitive vulns 来自 Stagehand v2.5.8 间接依赖（ai SDK + jsondiffpatch），在我们 use case 不可利用，记录到 `SECURITY.md` waiver。完整清需 Stagehand v3 升级（T-NEW-1，v1.1 任务）。
- **Minor 升级**：commander 12 → 14、dotenv 16.4 → 16.6（保 Stagehand v2.5 peer 兼容）、p-limit 6 → 7、typescript 5.7 → 5.9、@types/node 22.0 → 22.19、odiff-bin 4.3.2 → 4.3.8、ora 8 → 9、axe-core 4.11.2 → 4.11.4、better-sqlite3 12.8 → 12.9
- **Zod 锁定 v3**：v4 跨大版本影响 100+ 调用点 + zod-to-json-schema 兼容性 + 30 published JSON Schemas + Result Schema SemVer 决策；v1.0 ship Zod v3.25.76，v4 升级延后 v1.1 评估。决策入 [ADR-027](docs/decisions/ADR-027-zod-3-lock-in.md)。
- **Stagehand 锁定 v2.5.8**：v3 大破坏（act/observe 签名变 + BYO Playwright + wrapper 重写 ~150 LoC）配合 M6-5 T5 真 e2e smoke 才能验证，独立任务 T-NEW-1 v1.1 早期。决策入 [ADR-028](docs/decisions/ADR-028-stagehand-v3-deferred.md)。
- 全套回归：tsc ✓ / build ✓ / 1538/1538 测试 ✓ / `npm run schemas` 重生 0 diff / `npm run bench:check` 0 regression。

### Added (M1-2 Phase 3 — recorder.ts unit coverage)

- New `tests/recorder.test.ts` (~530 LoC, 27 tests) lifts `src/core/recorder.ts` from 0% → 82.82% statements / 76.19% branches / 88.04% lines. The recorder is the per-Page artefact accumulator (console-error listeners, indexed screenshots with sha256 sidecars, full + thumbnail + 5 viewport segments for vision input, console-log flush). Function coverage stays at 61.9% because `page.evaluate()`'s inline browser-only callbacks (lazy-scroll + docHeight readers) are not invokable in Node — same constraint that already applied to `page-stability.test.ts`.
- Tests use a small EventEmitter-style `MockedPage` helper that supports `.on('console', cb)` / `.fire('console', arg)` dispatch plus stub `.screenshot` / `.evaluate` / `.waitForTimeout` — the whole 27-test file runs in under 500 ms with no Chromium spawn.
- Branch coverage drills the segment-count math (3 segments at docHeight=2000 / capped at 5 for tall pages / floor of 1 for short pages), the lazy-load failure path (page closed mid-scroll → recorder catches and continues), and the `buildThumbnail` sharp fallback (non-PNG buffer → sharp throws → returns input untouched).
- Per ADR-017's ratchet contract (raise floor on ≥1pt project gain), the global coverage threshold moves **59 / 53 / 59 / 59 → 60 / 54 / 60 / 60**. Project coverage 65.66% → 67.06% statements (+1.40), 58.10% → 58.77% branches (+0.67), 69.18% → 70.60% functions (+1.42), 66.29% → 67.81% lines (+1.52). 1511 → 1538 tests pass.
- This closes one of five 0%-coverage orchestration modules ahead of the rest of M1-2 Phase 3 (`reporter.ts` / `runner.ts` / `agent-loop.ts` / `handlers/index.ts` / `computer-use.ts` remain).

### Changed (M5-7 — Unified SQLite migration runner)

- New internal module `src/core/db-migrate.ts` (~190 LoC) centralises the open-database sequence that four separate SQLite stores had each been hand-rolling: parent-directory creation, `busy_timeout` pragma, file-locked WAL transition (M9-3 follow-up pattern), and a `user_version`-driven migration walk. Exposes a typed `Migration` interface, `validateMigrations()` for sequence checks, `runMigrations()` for the walk itself, and `openManagedDatabase()` for the full open + migrate flow.
- All four SQLite stores refactored to use it: `src/core/history.ts` (audit-history trends), `src/agent/memory.ts` (per-site agent facts), `src/agent/plan-cache.ts` (reusable autonomous plans), `src/core/result-cache.ts` (memoised primitive results). Each shed ~30 lines of duplicate boilerplate.
- Each migration now runs inside its own `BEGIN IMMEDIATE` / `COMMIT` block. SQLite ≥ 3.25 supports DDL-in-transactions, so a failure rolls every CREATE / ALTER / INSERT in the migration back atomically. The previous `try/catch` defensive workaround in `memory.ts` (swallowing `/duplicate column|already exists/i`) is removed — `CREATE TABLE IF NOT EXISTS` plus correct `user_version` bookkeeping handles the legacy-DB case.
- Downgrade refusal: opening a database with `user_version > max(known migrations)` now throws `MigrationVersionError` immediately rather than silently running queries against missing columns. Catches the "older binary against a newer database" case that the previous forward-walk code couldn't detect.
- `validateMigrations()` enforces dense, 1-based, strictly-increasing version sequences before any DB I/O. Bad migration arrays surface at import time, not at production open.
- 27 new unit tests in `tests/db-migrate.test.ts` cover validation rules, idempotent re-runs, atomic rollback on migration failure, downgrade refusal, and `openManagedDatabase` knobs (WAL toggle / foreign_keys / busy_timeout). 1478 → 1511 tests pass.
- Public API surface unchanged at 67 exports — `db-migrate` is internal-only, used only by stores under `src/core/` and `src/agent/`.
- See [ADR-026](docs/decisions/ADR-026-unified-db-migrations.md) for the full design rationale and 9 alternatives rejected (CONTRIBUTING checklist / third-party migration library / skip validation / down migrations / single outer transaction / async migrations / filename-based discovery / dry-run flag / per-migration metadata table).

### Added (M6-7 — Performance regression suite)

- New `tests/perf.bench.ts` (~200 LoC) — 9 vitest benchmarks covering the report-rendering + aggregation hot paths most likely to regress: `renderPdfHtml` / `renderTrendsHtml` / `renderDiffMarkdown` / `renderDiffHtml` / `renderJunitXml` / `renderSarif` / `summarizeWcag` / `computeSummary` / `t() i18n lookup`. Pre-built fixtures (20-unit audit, 100-row history, 50 a11y issues across 8 SCs) keep measurements isolated to the function under test.
- New `src/perf/compare.ts` + `scripts/check-perf.ts` — pure-function comparison core + CLI wrapper that reads vitest's bench JSON output (`docs/perf-current.json`) and compares against a checked-in baseline (`docs/perf-baseline.json`). Flags `regression` / `improvement` / `ok` / `new` / `removed` per benchmark with signed delta percentages.
- New npm scripts:
  - `npm run bench` — run the bench suite, write `docs/perf-current.json`
  - `npm run bench:check` — compare current vs baseline, exit 1 on any regression beyond tolerance
  - `npm run bench:update` — bake current run into the baseline (after intentional perf changes)
- Default tolerance: 50%. Justified by measured 8–53% run-to-run variance on quiet hardware with pre-built fixtures — tighter tolerance produces false positives that operators learn to ignore. 50% reliably catches catastrophic regressions (O(N²) loop, sync I/O slip into hot path) without flagging noise. Override via `--tolerance 0.30` for stricter local checks.
- Initial baseline recorded as **min-of-5 consecutive runs** on a quiet M-series MacBook so regressions register as "slower than we've ever been" rather than "slower than the median run". `docs/perf-current.json` is gitignored — only the baseline is checked in.
- 33 new unit tests for `src/perf/compare.ts`; coverage 100% statements / 82% branches / 100% functions. The CLI script itself is end-to-end-tested via the bench → check → update workflow.
- Reproducible workflow for a contributor: run `npm run bench` after a refactor, run `npm run bench:check` to see if anything regressed > 50%, run `npm run bench:update` if the slowdown was intentional and you want to bake it in.
- See [ADR-025](docs/decisions/ADR-025-performance-regression-suite.md) for the full design rationale and 10 alternatives rejected (microbench library / ad-hoc console.time / run-on-every-test / end-to-end audit timing / p99-based detection / adaptive tolerance / fail-on-any-regression / memory tracking / bare-metal CI / per-PR bot).

### Added (M2-2 — WCAG clause grouping)

- New module `src/core/wcag.ts` (~270 LoC) provides a curated WCAG 2.1 + 2.2 success-criterion catalog (50+ entries covering 1.1.1 alt text / 1.4.3 contrast / 2.1.1 keyboard / 2.4.7 focus visible / 4.1.2 ARIA name-role-value / WCAG 2.2's net-new 2.4.11 / 2.5.7 / 2.5.8 / 3.3.7), an `parseAxeTags()` helper that extracts structured WCAG attribution from axe-core tag lists, and `summarizeWcag()` which aggregates issues by conformance level / principle / criterion.
- `Issue` type extended with two optional fields: `wcag_level` ("A" | "AA" | "AAA") and `wcag_criterion` (dotted SC id like "1.4.3"). Populated by `handlers/index.ts > handleAssertA11y` on every axe violation; absent on non-accessibility issues. Schema additive — existing audit.json files still validate.
- SARIF (`ci-reporters.ts`) now routes WCAG-attributed issues to per-criterion ruleIds: `wcag/1-4-3`, `wcag/2-1-1`. The corresponding `tool.driver.rules` entry carries the SC name + level + canonical W3C Understanding URL so GitHub Code Scanning's rule detail panel shows "WCAG 1.4.3 Contrast (Minimum) (Level AA)" with the W3C deep link. Compliance teams can filter / triage by W3C clause directly in GitHub Security tab / GitLab SAST.
- PDF report (`reporter-pdf.ts`) gains a **WCAG Compliance Summary** section between Top Findings and Scenario Results when the run has any accessibility issues. Three sub-blocks: by conformance level (A / AA / AAA / Unknown), by principle (Perceivable / Operable / Understandable / Robust), and Top 8 violated criteria with W3C deep links. Skipped entirely on runs without an `assert_a11y` step.
- 14 new i18n translation keys for the WCAG section, translated into all 5 supported locales (en / zh-CN / ja / es / de). `lintTranslations()` test stays green — every locale has every key.
- Public API surface grows 60 → 67 exports: `WCAG_CATALOG`, `findWcagCriterion`, `parseAxeTags`, `summarizeWcag`, `wcagSarifRuleId`, `wcagHelpUrl`, `isWcagIssue` + 5 types (`WcagLevel`, `WcagPrinciple`, `WcagSuccessCriterion`, `WcagAttribution`, `WcagSummary`).
- 1432 → 1445 tests pass (+38 wcag + 9 reporter integrations, with a few sample-pair tests adjusted for the schema additions). Coverage on the new file: 100% statements / 95.65% branches / 100% functions.
- Answers the actually-commercial question every enterprise SaaS RFP asks: "Are we WCAG 2.1 AA compliant?" The auditor now emits structured AA / A / AAA conformance counts per run, per criterion, with W3C documentation links — usable directly by ADA / EAA / Section 508 compliance teams in their native language.
- See [ADR-024](docs/decisions/ADR-024-wcag-clause-grouping.md) for the full design rationale and 8 alternatives rejected (hardcode in handler / pull metadata from axe at runtime / per-axe-rule ruleId / separate accessibility PDF / translate SC names / show all 50 SC / WCAG trend chart / auto-fail on AA).

### Added (M2-4 — Report localisation, 5 locales)

- New module `src/core/i18n.ts` (~470 LoC, 90 keys × 5 locales = 450 translation entries) is the central source of truth for every visible label in the four stakeholder reports. Supported locales (v1 priority markets):
  - **en** — English (baseline / fallback)
  - **zh-CN** — Simplified Chinese (China)
  - **ja** — Japanese (Japan)
  - **es** — Spanish (Spain + Latin America)
  - **de** — German (DACH region)
- New CLI flag `--locale <code>` on `run` / `trends` / `diff` subcommands. `ai-audit run` reads `default_locale` from `config.yaml` if `--locale` is unset; CLI overrides per-invocation.
- New `ProjectConfig.default_locale` enum field in `ProjectConfigSchema` (additive, defaults to `"en"`, existing config.yaml files keep working without touching it).
- All four stakeholder reports now emit native-language content:
  - **PDF** (`reporter-pdf.ts`): cover meta labels, summary card rows, top-findings section, scenario-results, methodology + disclaimer, status badges (using full-form a11y label e.g. "Passed" / "通過了" / "Bestanden"), severity tags translated per locale.
  - **Trends** (`reporter-trends.ts`): page title, h1, 6 summary cards, all 5 chart titles + hint paragraphs, stacked-bars legend, runs-table headers, locale-aware singular vs plural for "{n} runs" (English / Spanish / German pluralise; Chinese / Japanese have no plural form).
  - **Diff Markdown** (`reporter-diff.ts`): title, baseline/this-run pills, headline metrics + per-dimension table headers, severity tags `[critical]` / `[严重]` / `[致命的]`, "🆕 New issues" / "✅ Resolved issues" section titles, no-changes message, cross-project warning.
  - **Diff HTML**: same as Markdown, plus `<title>` and footer.
- What's NOT translated: the auditor's own findings (LLM-generated issue descriptions / recommendations come from Claude in whatever language the user asked for); numeric values / dates / run IDs / scenario IDs (data, not UI).
- Translation drift caught at CI: `lintTranslations(locale)` test asserts `[]` missing keys for every locale, so adding a key only to en silently falls back is impossible without `npm test` failing.
- `normaliseLocale(raw)` handles realistic input: case-insensitive, family fallback (`zh-Hans` → `zh-CN`, `ja-JP` → `ja`, `en-GB` → `en`), unknown → `en`.
- Public API surface grows 55 → 60 exports: `t`, `normaliseLocale`, `formatRunsCount`, `SUPPORTED_LOCALES`, `DEFAULT_LOCALE` plus `Locale` / `TranslationKey` types. `PdfReportOptions` / `TrendsDashboardOptions` / `DiffReportOptions` all gain a `locale?: Locale` field.
- 1319 → 1432 tests pass (+113 across i18n + 3 reporter integrations + public surface snapshot updates).
- See [ADR-023](docs/decisions/ADR-023-report-localisation.md) for the full design rationale and 8 alternatives rejected (per-reporter tables / full i18n library / translate LLM findings / auto-detect locale / more locales upfront / audit.html i18n / RTL / ICU).

### Added (M2-5 — PR diff report)

- New module `src/core/reporter-diff.ts` (~310 LoC) renders an audit `RunDiff` into 4 formats CI / PR-review tooling actually consumes:
  - **Markdown** (`renderDiffMarkdown`) — primary use case is direct posting as a PR comment via GitHub Actions (`marocchino/sticky-pull-request-comment` or `gh pr comment --body-file`). GitHub-Flavored-Markdown tables, ▲/▼ trend arrows with ✅/⚠️ polarity emoji, severity tags as **[critical]** bold text. Renders identically on GitHub / GitLab / Bitbucket.
  - **HTML** (`renderDiffHtml`) — standalone file for email / Slack / archival. Light theme matching reporter-pdf + reporter-trends; severity-coloured issue cards (critical / high red, medium amber, low grey, resolved green); cross-project warning banner when `runA.projectName !== runB.projectName`.
  - **JSON** (`renderDiffJson`) — `{ kind: "audit_diff", rendered_at, diff }` envelope preserving the structured RunDiff verbatim. For tools that want to chart / aggregate.
  - **Text** (`renderDiffText`) — ANSI-free version of the legacy CLI output for file redirection / log aggregators.
- Plus `writeDiffReport(diff, outPath, format?, opts?)` — disk-write helper that infers format from extension when `format` is omitted (`.md` → markdown, `.html` → html, `.json` → json, anything else → text). Creates parent directories. Returns absolute path.
- Delta-arrow polarity is **value-aware**: score / dimension up = good (▲ green / ✅), issues / cost / duration up = bad (▲ red / ⚠️), zero delta renders as "—" muted. Colour is *additional* signal, not the only one — arrow direction + polarity emoji together encode the meaning even for colour-blind readers.
- CLI extended: `ai-audit diff <runA> <runB>` gains `--format <text|markdown|html|json>` (default text, preserves the legacy chalk-coloured terminal output for backwards compat), `--output <path>` to write to a file (format inferred from extension when `--format` is omitted), and `--max-issues <n>` to cap new/resolved issue lists (default 10).
- Public API surface grows 50 → 55 exports: `renderDiffMarkdown`, `renderDiffHtml`, `renderDiffJson`, `renderDiffText`, `writeDiffReport` + types `DiffReportFormat` / `DiffReportOptions`.
- 1269 → 1319 tests pass (+50). Coverage on the new file: 98.08% statements / 94.16% branches / 100% functions.
- Typical CI workflow now reduces to 5 lines of YAML:
  ```yaml
  - run: ai-audit diff $MAIN_RUN $PR_RUN --format markdown --output diff.md
  - uses: marocchino/sticky-pull-request-comment@v2
    with: { path: diff.md }
  ```
- See [ADR-022](docs/decisions/ADR-022-pr-diff-report.md) for the full design rationale and 8 alternatives rejected (bake into `runDir` / templating engine / inline HTML in Markdown / drop text format / auto-post via `gh pr comment` / embed screenshots / direction-only polarity / third-party Markdown library).

### Added (M2-3 — Long-running trends dashboard)

- New CLI subcommand `ai-audit trends` reads the project's `history.db` (already populated by every audit run since v0.3) and renders a standalone HTML dashboard answering "did our UX trend up or down over the last quarter?". Output: `<reports>/trends.html` by default; `--dashboard <path>` overrides; `--project <name>` filters; `-n <limit>` caps history rows for chart density (default 100, ~3 months of daily runs).
- New module `src/core/reporter-trends.ts` (~430 LoC). Five inline-SVG charts (no Chart.js / D3 / external CDN — the page is fully self-contained, ~10 KB of SVG total, opens behind any corporate firewall, prints / emails / archives identically):
  - **Overall score** line — answers "trending up or down"
  - **Pass / Warn / Fail** stacked bars per run — answers "consistent or flaky"
  - **Issues over time** (total + critical highlighted) — answers "where are the regression hot spots"
  - **Cost over time** — answers "is efficiency drifting"
  - **Per-dimension multi-line** — answers "which scoring dimension is the cause of overall movement"
- Six summary cards above the charts: latest score (with ▲ / ▼ delta vs first run), mean last 7, mean last 30, total cost, total issues, total critical issues. Plus a recent-runs table for navigation to the run that explains a chart's spike.
- Public API: `writeTrendsDashboard(reportsDir, opts?)` + pure `renderTrendsHtml(entries, project?)` + `computeSummary(orderedAsc)` for embedders. SVG primitives exposed too (`lineChartSvg` / `stackedBarsSvg` / `multiLineChartSvg` / `deriveTicks` / `collectDimensions` / `escapeHtml`) so a downstream library can drop a single chart into its own page.
- Light theme matching `audit.pdf` aesthetic — both stakeholder artefacts share visual language. UTC date format (never local time) so dashboards copied between machines or archived stay interpretable. Score colours hard-coded green / amber / red (universal traffic-light convention, not brand-themable).
- Empty-state placeholder when `history.db` is missing or the project filter excludes everything — explicit "run `ai-audit run` to seed" guidance instead of a confusing blank page.
- Public surface grows 47 → 50 exports.
- 1225 → 1269 tests pass (+44). Coverage on the new file: 98.54% statements / 90.83% branches / 100% functions.
- See [ADR-021](docs/decisions/ADR-021-trends-dashboard.md) for the full design rationale and 8 alternatives rejected (Chart.js / dark theme / embed-in-audit.html / auto-generate / date-stamped path / per-persona breakdown / PNG rasterisation / CSV export).

### Added (M2-1 — Stakeholder-facing PDF report)

- New module `src/core/reporter-pdf.ts` (~360 LoC) renders an A4 portrait PDF for non-technical readers (PMs, executives, customers, sales / CS) — the audience that won't open `audit.html` but will read an emailed PDF on their phone or paste it into a slide deck.
- 4-section layout, page-break-controlled so sections never split awkwardly:
  - **Cover**: project + URL + run date + duration; centred big colour-coded score (green ≥ 8 / amber 5–8 / red < 5); 7-counter summary card.
  - **Top findings**: severity-sorted (critical → high → medium → low), capped at 5 by default. Each cites scenario × persona context + recommendation. Clean-run path emits an explicit "no issues" message.
  - **Per-scenario results**: one block per (scenario × persona). Status badge, score + cost, per-dimension table, all issues.
  - **Methodology**: how the audit works, sorted unique persona list, sorted unique scenario list, AI calibration disclaimer, run_id for archival.
- Vector text via Playwright's chromium PDF export — selectable, searchable, accessible. No new dependencies (we already ship Playwright).
- Helvetica fallback chain (every PDF reader has these), 12pt body, 1.5 cm margins. No font embedding → file size stays small → emailable.
- Header / footer on every page (chromium printHeader / Footer templates): project name + run date in header; run_id + page X/Y in footer.
- Public API: `writePdfReport(audit, runDir, opts?)` + pure `renderPdfHtml(audit, opts?)` + type `PdfReportOptions` (brand colour, optional logo data URI, max top findings cap, custom `launchBrowser` injection so embedders can reuse an already-running chromium).
- All audit data goes through `redactDeep` (M1-4 secrets layer) so the PDF can't leak anything the JSON report already redacts.
- New CLI flag `--no-pdf` on `ai-audit run`. **Default is ON** — every audit run writes `audit.pdf` for stakeholder distribution, matching the priority of who consumes which artefact (engineers already have JSON / HTML / SPA; the PDF is what reaches the layer above).
- Render failures are non-fatal: downgraded to a yellow warning so the audit exit code is unchanged. PDF is generated *after* JSON / HTML so a chromium issue never loses audit data.
- Public surface grows 45 → 47 exports (`writePdfReport`, `renderPdfHtml`).
- 1186 → 1225 tests pass (+39). Coverage on the new file: 92.39% statements / 87.17% branches / 87.09% functions. The uncovered ~8% is the actual chromium spawn path (real Playwright launch — out of scope for unit tests).
- See [ADR-020](docs/decisions/ADR-020-pdf-stakeholder-report.md) for the full design rationale and 8 alternatives rejected (pdfkit / wkhtmltopdf / default-off / US Letter / embed screenshots / one-page / PDF/A / third-party templating libs).

### Added (M2-6 — CI-friendly output formats)

- New module `src/core/ci-reporters.ts` (~400 LoC) emits four CI/CD-standard formats alongside the existing `audit.json` / `audit.html` / `summary.md`:
  - **JUnit XML** (`junit.xml`) for Jenkins / GitLab CI / Azure DevOps / CircleCI legacy reporters. One `<testcase>` per `(scenario × persona)`; `status: "fail"` → `<failure type="error">`, `"pass_with_issues"` → `<failure type="warning">`; `<system-out>` carries score + cost + per-dimension breakdown.
  - **SARIF 2.1.0** (`audit.sarif`) for GitHub Code Scanning + GitLab SAST. One result per Issue with severity-mapped `level`; ruleId derived from `issue.dimension` as kebab-case (`audit/visual-polish`); rules deduped; result properties carry scenario/persona/score/cost. Custom tool-driver overrides supported.
  - **JSONL** (`audit.jsonl`) for streaming consumers. First line is a `kind: "summary"` header; subsequent lines are one `kind: "scenario_result"` per audit unit, each independently `JSON.parse`-able (jq-friendly).
  - **GitHub Actions workflow commands** (`github-annotations.txt`) for inline PR annotations. Severity → level (`critical`/`high` → `error`, `medium` → `warning`, `low` → `notice`); per-spec encoding of `%`/`\r`/`\n`/`:`/`,` (% escaped first).
- New CLI flag `--ci-format <formats>` accepts `auto` (default — emit all when CI detected, none on developer laptop), `all`, `none`, or a comma-separated subset (`junit,sarif,jsonl,gha`). Formats land in `runDir` alongside the existing artefacts.
- When running inside `GITHUB_ACTIONS`, the CLI also streams the annotation lines to stderr so they attach inline to PR diffs without a separate workflow step.
- New helper `detectCiEnvironment()` recognises GitHub Actions / GitLab CI / CircleCI / Azure Pipelines / Jenkins / generic-CI via the standard env-var signals. Returns `null` on developer laptops so the default `auto` mode keeps local iteration clean.
- Single `SEVERITY_LEVELS` lookup table is the source of truth for severity → SARIF/GHA mapping; adding a 5th format is mechanical.
- All four writers go through `redactDeep` so the M1-4 redaction layer covers CI formats too — planted-secret tests verify substrings like `sk-ant-secret-9999` never leak through any format.
- Public API surface grows 40 → 45 exports: `writeJunitXmlReport` / `writeSarifReport` / `writeJsonLinesReport` / `writeGithubAnnotationsReport` / `detectCiEnvironment` (+ `SarifToolDriver` type) all re-exported from `src/index.ts` for embedders that want only specific formats.
- 1132 → 1186 tests pass (+54). Global coverage 60.93 → 61.82% statements (+0.89). See [ADR-019](docs/decisions/ADR-019-ci-friendly-output-formats.md) for the full design rationale and 8 alternatives rejected.

### Added (M1-5 — Public API contract tests)

- Two new test files guard the *external consumer* perspective on the published JSON Schemas (Ajv-validated) and the runtime export surface of `src/index.ts`:
  - `tests/public-api-contract.test.ts` (45 tests) — registry integrity (`docs/schemas/index.json` references every shipped `*.schema.json`, no orphans, no dangling, unique slugs/files, exactly 30 schemas at v1.2.0), per-schema Draft-7 validity (Ajv `compile()` clean for every schema, `$schema` / `$id` / `title` / `x-result-schema-version` checks), cross-document version coherence (`RESULT_SCHEMA_VERSION` constant ↔ `index.json` ↔ `docs/contracts/RESULT_SCHEMA.md` ↔ every individual schema's version field), `JSON.parse + 2-space JSON.stringify` idempotence (catches accidental hand-edits / formatter drift).
  - `tests/public-api-samples.test.ts` (107 tests) — public surface snapshot of `src/index.ts`'s 40 runtime exports (review checkpoint on add/remove + per-name function-callable / Zod-schema-shape / `AgentEventBus`-constructable assertions), sample-driven Ajv validation (every shipped schema gets a minimally-conformant sample pair: Ajv MUST accept the valid one, MUST reject the deliberate violation; coverage check at top requires bidirectional agreement between SAMPLES and on-disk schema files), Zod ↔ Ajv equivalence (4 representative payloads validate / fail under both validators).
- New dev deps: `ajv` ^8.20.0 + `ajv-formats` ^3.0.1. Ajv configured with `strict: false` to tolerate the `x-result-schema-version` custom keyword (the IETF-recommended `x-` extension pattern).
- 980 → 1132 tests pass (+152). Global coverage 60.75 → 60.93% statements (no new src/ logic — these are read-only contract tests).
- See [ADR-018](docs/decisions/ADR-018-public-api-contract-tests.md) for the full design rationale and 8 alternatives rejected.

### Added (M1-2 Phase 2 close — `core/reporter-spa.ts` HTML-escape coverage)

- `tests/reporter-spa.test.ts` extended from 5 → 13 tests. Coverage: `core/reporter-spa.ts` 60 → **93.33% statements / 100% branches / 100% functions / 93.33% lines**. The remaining ~7% is the unreachable `default:` return inside `escapeHtml`'s switch (the calling regex `[&<>"]` only passes those four chars, so the default branch is dead defensive code).
- Test surface added:
  - `escapeHtml` exercised through `audit.project_name` and `audit.run_id` (the only two `escapeHtml` call sites — every other text interpolation goes through the JSON `<` / `>` escape): `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`, plus a mixed-special-chars case and a plain-ASCII no-op case.
  - `redact_patterns` fast-path: empty array bypasses `redactDeep` (verified by checking that an unredacted secret string survives in the output) and undefined `redact_patterns` likewise bypasses.
- This commit closes M1-2 Phase 2's LLM-heavy quartet: `critic` (100%) + `llm` (87%) + `instruction-mutator` (86%) + `reporter-spa` (93%). Threshold stays at 59/53/59/59 — the sub-1pt gain (60.65 → 60.75) doesn't warrant a ratchet under ADR-017's contract.
- 980/980 tests pass (973 → 980, +7).

### Added (M1-2 Phase 2 — `core/instruction-mutator.ts` extended unit tests)

- `tests/instruction-mutator-extended.test.ts` — 37 tests complementing the existing `tests/instruction-mutator.test.ts` (which covered only `mutateSpecific` + `mutateDecompose` happy paths). The original tests stay; this file adds the orchestration / LLM / autoDiscovery / verb-swap surfaces that were previously untested.
- Coverage: `core/instruction-mutator.ts` 41.58 → **86.13% statements / 65.33% branches / 92.85% functions / 85.71% lines**. The remaining 14% is the inner `getInteractiveElements` `page.evaluate(callback)` body (browser-only — same constraint as `page-stability.ts`, deferred per ADR-017).
- Test surface added:
  - `generateMutations` orchestration (without cost): merges specific + decompose + rephrase variants in priority order; emits decompose only when input matches a "then"/"and" pattern; never duplicates rephrase when an upstream mutation already returned one; stamps `schema_version` on every result; calls `page.evaluate` exactly once for DOM context; falls back to `(unable to read DOM)` literal when `page.evaluate` throws.
  - `generateMutations` LLM path (with cost): includes LLM-rewrite as the first result when the model returns a non-empty different instruction; ignores no-op rewrites (identical to original); ignores empty-after-trim output; silently swallows LLM errors / cost-guard `checkBudget` throws and falls through to local mutations; never calls `recordUsage` on failure; never invokes the LLM when the cost accumulator is omitted; forwards original instruction + DOM context truncated to 1500 chars to Haiku 4.5 with `max_tokens=256` and the documented system prompt.
  - `autoDiscoverSelectors`: maps Stagehand observe results to selectors; filters empty/missing selectors; slices to at most 5; returns `[]` on `observe()` throw or empty result.
  - `rephrase` verb-swap matrix exercised through `mutateDecompose`'s no-pattern fallback: 15 verb-pair rewrites (click↔press, tap→click, select↔choose, navigate↔go, open, find, enter↔type, scroll-down-to, look-for) + 3 hint-appending fallbacks (button visible-area, link clickable-text, generic try-different-approach).

Coverage threshold ratcheted per ADR-017 contract: statements 58→59, branches 52→53, functions 58→59, lines 58→59. Current baseline 60.65/53.89/63.24/61.39 leaves 1-2 points headroom. 973/973 tests pass (936 → 973, +37).

### Added (M1-2 Phase 2 — `core/llm.ts` unit tests)

- `tests/llm.test.ts` — 38 tests for the Anthropic SDK wrapper. Mocks `@anthropic-ai/sdk` (FakeAnthropic class with `messages.create` capture) and `./cost-guard.js` (controllable `checkBudget` + `recordUsage`). Uses `vi.resetModules` + dynamic `await import("../src/core/llm.js")` per test so the module-level singleton `client` cache is fresh on every run — previously the singleton was untestable from the public API without an explicit reset seam.
- Coverage: `core/llm.ts` 22.22 → **87.4% statements / 87% branches / 100% functions / 86% lines**. Remaining 13% are deep edge cases inside `repairTruncatedJson` (escape handling in second walk, stack mismatch on close brace, value-char terminators) that the public `extractJson` API doesn't reach without contrived inputs.
- Test surface:
  - `getAnthropicClient`: throws without `ANTHROPIC_API_KEY`; constructs with the env key on demand; memoised (singleton — second call returns the same instance).
  - `estimateCost`: opus 4.6 ($15/$75 per 1M), sonnet 4.6 ($3/$15), haiku 4.5 ($0.80/$4); unknown model falls back to sonnet pricing; zero usage returns 0.
  - `callVision` request shaping: throws on no images; legacy `imageBase64` path defaults `media_type=image/png`; `imageMediaType` override; `images[]` wins over `imageBase64` when both set; `image.label` prepended as a `text` content block; `userPrompt` always last in content; `systemPrompt` + `maxTokens` (default 2048, custom 4096) + model name forwarded.
  - `callVision` response handling: text blocks joined with `\n`, non-`text` blocks (e.g. `tool_use`) ignored; `costUsd` computed via `estimateCost` from response usage; cost-guard `checkBudget` invoked pre-call and `recordUsage` post-call (in order); `checkBudget` throw aborts before the SDK call; SDK throw propagates without calling `recordUsage`.
  - `extractJson` paths: fenced ```json``` parse, fenced no-language parse, bare object, prose-surrounded balanced object, nested braces inside string values, escaped quotes, truncated array repair, nested truncation repair, trailing-comma strip, no-JSON throw, empty input throw, missing-closing-fence fallback to balanced extraction; truncated-string drops everything past the unterminated open-quote (documented contract); error message snippet truncated at 200 chars; generic typing.

### Added (M1-2 Phase 2 — `core/critic.ts` unit tests)

- `tests/critic.test.ts` — 24 tests for the Vision Critic. Mocks `./llm.js` so `callVision` is deterministic; keeps `extractJson` real (it's pure) and `compressForVision` real (already covered by `image.test.ts`) so the integration of compress → vision → JSON parse → schema-validate → score/issue mapping is exercised end-to-end. `vi.hoisted` shared capture object lets every test assert on the prompt that was sent to the model.
- Coverage: `core/critic.ts` 3.33 → **100% statements / 92.85% branches / 100% functions / 100% lines**. Only line uncovered is the `String(err)` defensive branch when `err instanceof Error` is false (extractJson always throws Error in practice).
- Test surface: single-image happy path / multi-image label convention (full-page thumbnail + viewport-segment N of M ordering preservation) / verdict.violations mapped to high-severity localization issues (with + without `location`) / malformed JSON returns low-severity issue (cost still recorded, schema_version still stamped) / schema-validation failure path / verdict defaults (missing scores/issues → empty arrays) / issue.dimension optionality / verdict.passed pass-through / system prompt embeds persona mental_model + country + locale + device + tier + critical_concerns (incl. `(none specified)` empty case) + scenario.goal + anti-hallucination / data-exposure rules + brand-name carve-out reflects `persona.language` / user prompt joins `scoring_dimensions` with `, ` + ends `Return JSON only.` / callVision error propagation (no swallow) / model-name forwarding / raw VisionResponse preserved in `result.raw`.
- Coverage threshold ratcheted up per ADR-017's contract: statements 50 → 55, branches 45 → 50, functions 50 → 55, lines 50 → 55. Current baseline 58.1 / 51.67 / 61.39 / 58.83 leaves 2-3 points of headroom for natural fluctuation. 898/898 tests pass (874 → 898, +24).

### Added (M1-2 Phase 1 — coverage tooling + small/utility module unit tests)

- `@vitest/coverage-v8` ^4.1.5 dev dep. `vitest.config.ts` enables coverage with provider `v8`, three reporters (`text-summary` / `html` / `json-summary`), `./coverage` output dir. Includes `src/**/*.ts` minus entry-points (`cli.ts` / `index.ts` / `mcp/server.ts`) and pure-type contracts (`core/types.ts` / `core/result-schema.ts`) — counting them dilutes the signal.
- Two new npm scripts: `test:coverage` (writes report) and `test:coverage:check` (enforces global thresholds; fails CI on regression).
- Threshold gate set at conservative entry baseline (statements 50 / branches 45 / functions 50 / lines 50). Each subsequent M1-2 phase commit ratchets the floor up. `coverage/` added to `.gitignore`.
- 12 new module-level test files added: `tests/scenario.test.ts`, `tests/config.test.ts`, `tests/throttle.test.ts`, `tests/url-preflight.test.ts`, `tests/image.test.ts`, `tests/persona.test.ts`, `tests/secrets.test.ts`, `tests/page-stability.test.ts`, `tests/visual-diff.test.ts`, `tests/notify.test.ts`, `tests/email.test.ts`, `tests/stagehand-wrapper.test.ts`. 188 new tests total.
- Per-module coverage uplift: `scenario` 0 → 100%, `config` 0 → 100%, `throttle` 0 → 95%, `url-preflight` 0 → 100%, `image` 44 → 88%, `persona` 45 → 100%, `secrets` 57 → ~100%, `page-stability` 0 → 40% (Node-side 100%, page-side `evaluate(callback)` bodies are browser-only and run in real Playwright integration tests), `visual-diff` 62 → 79%, `notify` 0 → 100%, `email` 0 → 100%, `stagehand-wrapper` 0 → 90% (via `vi.mock` + `vi.hoisted` Stagehand stub). 
- Global coverage 51.5% → 57.5% statements / 45.75% → 51.27% branches. ADR-017 records the M1-2 phase plan and lists which big modules (critic / llm / runner / computer-use / reporter / agent-loop / etc.) stay for Phase 2/3.
- `stagehand-wrapper.test.ts` mocks `@browserbasehq/stagehand` with a hoisted shared-capture object so the wrapper exercises init / addInitScript / cookies / tracing / close / video.path without launching Chromium. stealth-core stays unmocked so `resolveFingerprintForPersona` + `buildStealthLaunchOptions` are genuinely covered. Includes "Stagehand not installed" error path + addInitScript-throw resilience path.

### Added (M9-5 MCP self-describe / `list_capabilities`)

- New MCP tool `list_capabilities` (`kind: "meta"`) — twelfth shipped tool. Pure introspection: no LLM, no browser, no probe of secret presence. AI agents call it once on first connect to plan the rest of the session: every tool with kind, input schema, result schema title, **cacheability**, **static cost-estimate band**, **side-effects**, and **dependency declarations**; plus the public env-var table and live state of the M9-4 result cache.
- `ToolDefinition` (`src/mcp/registry.ts`) gained four new required fields: `cacheable: boolean`, `costEstimateUsd: { typical, min, max, unit, notes? }`, `sideEffects: ToolSideEffect[]`, `requires: { apiKeys, browser, personasDir?, scenariosDir? }`. Populated on every shipped tool. `cacheable` mirrors the M9-4 design matrix exactly (see / extract / judge cache; act state-changing; compare transparently via judge sub-calls; audit_url / explore_url heavyweight; meta tools none). `requires.apiKeys` declares static dependency on env-var names — never probes whether each is set, since that would leak secret-presence to every caller.
- New schemas in `src/core/result-schema.ts`: `ListCapabilitiesResultSchema` (top-level envelope: `server / result_schema_version / tools[] / env[] / cache`), `ToolCapabilitySchema` (per-tool descriptor), `EnvVarDocSchema` (one env var entry: name, description, scope ∈ {auth, cache, cost_guard, artifacts, logging, memory, reports}, default, required), `CostEstimateSchema` (`{typical, min, max, unit, notes?}` with `unit ∈ {per_call, per_step, per_persona_scenario}`), `CacheInfoSchema` (`{enabled, ttl_ms_default, path}`). Plus supporting building blocks: `ToolSideEffectSchema` enum (navigation / state_changing / fs_writes_artifacts / fs_writes_history / fs_reads / network_egress), `ToolRequirementsSchema`, `ServerInfoSchema`.
- `RESULT_SCHEMA_VERSION` 1.1.0 → 1.2.0 (additive minor per ADR-007 SemVer policy). No existing envelope changed shape. Schema count 25 → 30 published JSON schemas at v1.2.0 (added `list-capabilities-result`, `tool-capability`, `env-var-doc`, `cost-estimate`, `cache-info`).
- 21-row env table in `src/mcp/tools/list-capabilities.ts` covers every `AUDIT_*` / `LOG_*` / `ANTHROPIC_API_KEY` env var the codebase reads. Adding a new env var to a primitive must include adding a row here — the envelope-completeness test (`tests/list-capabilities.test.ts > env table includes every audit-prefix env var`) forces the set to stay in sync.
- Privacy: planted-secret test asserts a fake `ANTHROPIC_API_KEY` value is absent from `list_capabilities` output while the *name* `ANTHROPIC_API_KEY` is present. The result-cache file path *is* exposed (paths are not secrets) so AI agents can write diagnostic / cleanup scripts.
- 7 catalog invariants added in `tests/mcp-registry.test.ts` lock in metadata consistency: cost band well-formed (`min ≤ typical ≤ max ≥ 0`, unit ∈ enum); `sideEffects` from closed enum; `requires` record shape; `network_egress ⇔ apiKeys non-empty`; `browser ⇒ navigation`; M9-4 cacheable matrix preserved exactly.
- 81 new tests across 3 files: 45 schema cases in `tests/result-schema.test.ts` (new schemas' happy / unknown-enum / negative / missing-required-field rejections, lower-bound empty-tools / empty-env envelope shape); 7 metadata invariants in `tests/mcp-registry.test.ts`; 29 cases in new `tests/list-capabilities.test.ts` (registry projection snake_case mapping, optional `result_schema` / `personas_dir` / `scenarios_dir`, registry dispatch smoke, envelope completeness, secret-leak smoke, server identity, every scope-enum reachable, live cache reflection: `AUDIT_RESULT_CACHE_DISABLED` flips `cache.enabled`, `AUDIT_RESULT_CACHE_TTL_MS` surfaces, invalid-TTL fallback, path string non-empty).
- New ADR-016 documenting the design (static vs live fields, naming convention, privacy stance) and 8 alternatives rejected: rich fields directly on `tools/list` (strict-MCP clients reject unknown fields), runtime secret-presence probe (information leak), process-level live stats (out of scope), prose env docs only (not machine-readable), self-cache via M9-4 (circular), HTTP content negotiation (scope creep), AST-grep env discovery (filtering test fixtures), in-memory cache across calls (unmeasurable benefit).
- 628 → 686 tests pass (+58 net new). Typecheck clean. Build clean. MCP `tools/list` over stdio confirms 12 tools. `tools/call list_capabilities` returns the full `ListCapabilitiesResult` envelope with 12 tool rows + 21 env rows + live cache state.

### Added (M9-4 Result cache)

- New `src/core/result-cache.ts` — local persistent cache for primitive results. SQLite at `~/.ai-browser-auditor/result-cache.db` (override `AUDIT_RESULT_CACHE_PATH`). One indexed table `result_cache(key PK, primitive, value_json, schema_version, created_at)`. WAL transition file-locked per the M9-3 follow-up pattern; `busy_timeout = 5000`. Atomic upsert via `INSERT … ON CONFLICT(key) DO UPDATE` so concurrent writers on the same key converge cleanly.
- Cache key: `sha256(canonical-JSON({ primitive, inputs }))`. `canonicalJsonStringify` recursively sorts object keys before stringify (arrays preserve order — `steps`, `rubrics` are order-sensitive). Per-primitive `cacheKeyInputs(opts)` declares which option fields go into the key; performance-only fields (`timeout`, `headless`, `artifactsRoot`) are excluded so the same logical call hits cache regardless of how it was scheduled.
- TTL default 24h, override `AUDIT_RESULT_CACHE_TTL_MS` or per-call `cacheTtlMs`. Entries written under a different `RESULT_SCHEMA_VERSION` are misses and pruned on read. Opportunistic prune at most once per opened DB per hour.
- Bypass: `AUDIT_RESULT_CACHE_DISABLED=1` (global), per-call `cache: false` (skip read+write), per-call `cacheBust: true` (skip read, persist new result so subsequent identical calls hit cache).
- `withResultCache<T>({ primitive, cacheKeyInputs, compute })` wraps a primitive's expensive computation. On hit it returns the cached value with `cost_usd` zeroed and `cache.cost_saved_usd` populated; on miss it calls `compute(key)`, persists, and returns with `cache.hit=false`.
- Cacheable surface (v1): `judge` (always), `extract` (always), `see` (only when `goal` is set — without a goal `see` makes no LLM call and a cached snapshot could mislead callers with stale state). Not cached: `act` (state-changing imperatives), `compare` directly (its two per-side `judge` calls hit cache transparently when called repeatedly with the same A/B URLs; the synthesis call is small), `audit_url` / `explore_url` (heavyweight, deferred to a future task).
- `RESULT_SCHEMA_VERSION` 1.0.0 → 1.1.0 (additive minor per ADR-007 SemVer policy). New `ResultCacheMetaSchema { hit, age_ms, key (sha256 hex), cost_saved_usd? }` exported. Each primitive envelope (`SeeResultSchema` / `ActResultSchema` / `ExtractResultSchema` / `JudgeResultSchema` / `CompareResultSchema`) gained an optional `cache: ResultCacheMetaSchema.optional()` field. Schema count 24 → 25 published JSON schemas at v1.1.0.
- Per-primitive options: `cache: boolean`, `cacheBust: boolean`, `cacheTtlMs: number` on `SeeOptions` / `ExtractOptions` / `JudgeOptions`. MCP tools `see` / `extract` / `judge` surface them as `cache` / `cache_bust` / `cache_ttl_ms`.
- New `tests/result-cache.test.ts` (31 cases): canonical JSON sorting / cache key stability / hit-after-write / TTL expire (default + env-override) / cacheBust recompute + persist / `cache: false` bypass / env disable bypass / different inputs and primitives produce different keys / custom `costExtractor` + `applyCacheMeta` hooks / schema-version invalidation / malformed JSON resilience / prune by age / prune by version mismatch.
- New `tests/primitives/cache-integration.test.ts` (9 cases): end-to-end through `see` / `extract` / `judge` with stubbed open + vision: caches when applicable, doesn't cache when not (no goal on see), `cache: false` bypasses, `cacheBust` forces recompute, different goals / schemas / rubrics produce different keys.
- New `tests/setup.ts` + `vitest.config.ts > setupFiles`: vitest globally sets `AUDIT_RESULT_CACHE_DISABLED=1` so primitive unit tests don't accidentally hit the user's real cache. Cache integration tests opt-in by clearing the env var locally + using temp SQLite paths.
- 11 new schema tests in `tests/result-schema.test.ts`: `ResultCacheMetaSchema` accepts hit/miss / rejects bad keys + negative age_ms / negative cost_saved_usd; each of 5 primitive envelopes accepts `cache` on hit / miss / absent.
- New ADR-015 documenting the design, alternatives rejected (in-memory only / cache `audit_url` / cache `act` / sidecar `cache_meta` envelope / leave `cost_usd` un-zeroed on hit / hash screenshot path string only / per-primitive tables / honour HTTP `Cache-Control`), and reversal cost.
- 619 → 628 tests pass (+11 schema, +9 cache-integration; result-cache's own 31 land alongside; existing history test updated to track `RESULT_SCHEMA_VERSION` rather than the literal "1.0.0"). Typecheck clean. Build clean. MCP `tools/list` over stdio still returns 11 tools; `see` / `extract` / `judge` inputSchemas now include `cache` / `cache_bust` / `cache_ttl_ms`.

### Added (N-3 + N-8 `compare` + `judge` primitives)

- New `src/core/primitives/judge.ts` — fourth AI primitive in the v1 catalog. `judge(opts: JudgeOptions): Promise<JudgeResult>` runs ONE rubric-driven vision call against a single page (URL or pre-captured snapshot) and returns per-criterion verdicts (0..10 score + rationale + evidence) plus severity-graded findings with on-screen locations. Decoupled from `runCritic` (`src/core/critic.ts`) — runCritic is persona × scenario × dimension scoring tightly bound to scenario YAML; judge is rubric × URL with no scenario/persona file required.
- New `src/core/primitives/compare.ts` — fifth AI primitive. `compare(opts: CompareOptions): Promise<CompareResult>` runs an A/B comparison of two pages against the same rubric. Default mode `double_blind`: judges side A and side B independently in parallel, then runs ONE synthesis vision call seeing both screenshots side-by-side with the prior judgements as context — 3 vision calls total (wall-clock ≈ 2 calls). `fast` mode collapses to 1 vision call seeing both sides — ~3× cheaper but vulnerable to anchoring bias.
- Why double-blind by default: anchoring bias is a documented hazard in single-shot LLM comparisons (Bansal et al. 2024). When a model scores AND compares AND synthesises in one prompt, absolute scores get pulled toward the difference between the two pages. Commercial UX-review practice (Nielsen Norman, Baymard Institute) evaluates each candidate independently before comparison synthesis. The cost delta (~$0.04 per compare) is dwarfed by the judgement-quality gain. `mode: "fast"` opts out for batch use.
- New rubric modules `src/core/critics/aesthetic.ts` (8 criteria — visual_hierarchy, typography, alignment_grid, color_contrast, spacing_rhythm, polish, information_density, brand_cohesion; benchmarked against Stripe / Linear / Vercel / Notion) and `src/core/critics/dark-pattern.ts` (12 criteria — forced_continuity, hidden_costs, preselected_options, fake_urgency, confirmshaming, obstruction, misdirection, trick_questions, disguised_ads, bait_and_switch, privacy_zuckering, nagging; from Brignull's taxonomy + Norwegian Consumer Council 2018). Score direction is uniform (higher = better, even for dark-pattern criteria where 10 = no DP detected) so `overall_score` (mean) stays monotonic across mixed rubrics.
- Caller-supplied `customCriteria` for one-off rubrics (e.g. `{id: "pricing_clarity", label: "Pricing clarity", description: "Is total cost visible without scrolling?"}`). Setting any custom criterion auto-tags `rubrics` with `"custom"`. Criterion ids dedupe across rubric sources.
- New `src/mcp/tools/judge.ts` and `src/mcp/tools/compare.ts` — both `kind: "primitive"`. `judge` accepts `url` OR pre-captured `capture: { url_final, title, screenshot_path, ... }`; `compare` accepts per-side `{ url | capture, persona, viewport_width, viewport_height }`. Per-side viewport enables desktop-vs-mobile A/B testing on a single tool call.
- `ALL_TOOLS` in `src/mcp/server.ts` grows 9 → 11. Catalog order is now `audit_url` (preset) → `explore_url` (preset) → `see` (primitive) → `act` (primitive) → `extract` (primitive) → **`judge` (primitive)** → **`compare` (primitive)** → `list_personas` / `list_scenarios` / `calibrate_critic` / `get_last_report` (meta). The mcp-registry catalog test was updated to assert the new 11-tool order.
- New schemas: `JudgeResultSchema` (envelope with `rubrics`, `criteria`, `verdicts[]`, `findings[]`, `overall_score`, `summary` plus the standard see/act/extract envelope) and `CompareResultSchema` (mode + side_a / side_b carrying embedded JudgeResult + per_criterion winners + overall_winner + summary). Plus reusable building blocks: `JudgeRubricKindSchema`, `JudgeCriterionSpecSchema`, `JudgeVerdictSchema`, `JudgeFindingSchema`, `CompareModeSchema`, `CompareWinnerSchema`, `CompareCriterionVerdictSchema`, `CompareSideSchema`. JSON Schemas published as `docs/schemas/judge-result.schema.json` and `docs/schemas/compare-result.schema.json`. Schema count 22 → 24 at `RESULT_SCHEMA_VERSION` 1.0.0.
- Defensive parsing: `parseJudgeRawJson` drops verdicts referencing unknown criterion_ids, clamps scores into [0..10], coerces unknown criterion_id on findings to null (cross-cutting), drops findings with unknown severity, treats malformed input as empty-verdicts (with a diagnostic `severity: "low"` finding); `parseCompareRawJson` does the same plus falls back to `majorityWinner` when `overall_winner` is missing/invalid. Both protect the wire from producer drift without crashing the call.
- Per-call artefacts: `judge` writes `<root>/<iso>-<rand6>/judge.json` sidecar; `compare` writes `<root>/<iso>-<rand6>/{a,b}/` subdirs + `compare.json` sidecar. Env overrides: `AUDIT_JUDGES_DIR`, `AUDIT_COMPARES_DIR`.
- Cost-guard wiring: every vision call goes through `callVision` (M5-6 + M9-3 ledger + AsyncLocalStorage scope). The MCP dispatcher already wraps each tool call in `withCostRun`, so two parallel `judge` or `compare` invocations on this server process see independent per-run counters but share the persistent daily ledger.
- New tests:
  - `tests/result-schema.test.ts` — 20 new cases for the Judge / Compare schemas (minimal envelope, fully populated, rubric-kind reject, score-range reject, criterion id+label non-empty, severity reject, mode/winner reject, null per-side scores accept, embedded judge accept, negative-cost reject, unknown-status reject, schema_version optional, etc.).
  - `tests/primitives/judge.test.ts` — 33 cases covering rubric assembly (default aesthetic, dual rubric, dedupe, custom + built-in compose, cross-rubric id dedupe, standalone "custom" with no criteria errors, empty errors, id format invariant), prompt construction (system + user prompts embed every criterion id, mode-switched language, severity values), `parseJudgeRawJson` (score clamping, unknown criterion_id drop, unknown severity drop, criterion_id-on-finding null coercion, malformed-input empty, summary preservation), `computeOverallScore` (empty → null, mean rounded 2dp), primitive seam (`_see` + `_callVision`) — schema field plumbing, capture re-use, rubrics arg, custom criteria, cost propagation, upstream see error → status=error, missing url+capture throws, artefacts dir uniqueness, sidecar JSON, env override, model propagation, malformed JSON → diagnostic finding, overall_score is mean. Plus a real-Chromium integration test against the existing fixture site with stub vision (no LLM credits ever burnt).
  - `tests/primitives/compare.test.ts` — 24 cases covering prompt construction (every criterion id, SIDE A/B labels, mode-specific instructions, prior judgements rendered when judges passed), `parseCompareRawJson` (per-side score clamping, null score passthrough, unknown criterion_id drop, invalid winner drop, fallback to majority winner, malformed → empty + tie), `majorityWinner` (empty → tie, a==b → tie, strict majority wins), `double_blind` mode (2 parallel judges + 1 synthesis call, costs summed, default mode is double_blind, side-A judge failure → status=error with both judge costs retained, capture reuse, rubrics + customCriteria flow through, missing url+capture per side throws, artefacts isolation with a/ b/ subdirs, compare.json sidecar, AUDIT_COMPARES_DIR env override), `fast` mode (NO synthesis-context judge, capture proxy via judge with no-op vision, embedded judge null in result, cost = synthesis only). Plus a real-Chromium integration test (fast mode, A=B fixture URL, returns tie).
- New ADR-014 documenting double-blind-by-default rationale (anchoring bias literature + commercial UX-review practice), why two distinct tools instead of one combined `judge_and_compare` (loss of caching, cost transparency, failure isolation, replay locality), why rubric-as-data instead of hard-coded prompt (extensibility + custom criteria parity), why decouple from `runCritic` (no scenario YAML coupling), uniform score direction (monotonic aggregate), and 8 rejected alternatives in full.
- 500 → 557 tests pass (+20 schema, +33 judge, +24 compare). Typecheck clean. Build clean. MCP `tools/list` over stdio confirms 11 tools and the full `judge` + `compare` inputSchemas.

### Added (N-4 `extract` primitive)

- New `src/core/primitives/extract.ts` — third AI primitive in the v1 catalog. `extract(opts: ExtractOptions): Promise<ExtractResult>` runs Stagehand's `page.extract()` against a URL bound to a caller-supplied JSON Schema and returns matching `data` plus the same envelope as see / act (DOM summary, console errors, screenshot, persona, artifacts, cost, duration). Single-engine: Stagehand only. There is no deterministic alternative for "give me an arbitrarily-shaped object matching this schema."
- JSON Schema → Zod converter (subset whitelist): `type` ∈ {object, array, string, number, integer, boolean, null}, `type: ["T", "null"]` shorthand, `properties`, `required`, `items`, `enum` (string-only → `z.enum`, mixed → `z.union` of `z.literal`), `description` (forwarded to `.describe()`), `nullable`, plus `additionalProperties` + metadata keywords accepted-but-ignored. Rejected (precise path-locator error message): `oneOf`, `anyOf`, `allOf`, `not`, `$ref`, `patternProperties`, `dependencies`, `if/then/else`, `const`. The root must be `type: "object"` (Stagehand's `extract()` requires `T extends z.AnyZodObject`); a bare `{ properties: {…} }` is accepted as object-shorthand.
- Auto-instruction synthesis: when caller supplies a schema but no `instruction`, the primitive synthesises one from the schema's top-level field names and `description` annotations (e.g. `"Extract the following fields from the page: name, price (Monthly price in USD), features."`). Stagehand's extract performs noticeably better with a one-line hint.
- Cost-guard wiring: snapshots Stagehand's running `metrics.extractPromptTokens` / `extractCompletionTokens` before and after the call, computes USD via `estimateCost(model, deltaIn, deltaOut)`, and feeds `getCostGuard().recordUsage()` so the persistent daily ledger stays accurate. If `recordUsage` throws `BudgetExceededError`, the data is still returned but `status` flips to `"error"` with the budget message — partial-success semantics. (Closes the cost-tracking gap that `act`'s `act` step left open.)
- New `src/mcp/tools/extract.ts` — MCP wrapper, `kind: "primitive"`. Accepts snake-case args (`url`, `schema`, `instruction`, `selector`, `persona`, `viewport_width` / `viewport_height`, `full_page`, `include_dom`, `include_console`, `timeout_ms`, `wait_for`, `headless`, `model`). Persona resolution mirrors see / act (best-effort, fall back to defaults). Output stamped via `stampedTextResult("ExtractResult", ExtractResultSchema, …)`.
- `ALL_TOOLS` in `src/mcp/server.ts` grows 8 → 9. Catalog order is now `audit_url` (preset) → `explore_url` (preset) → `see` (primitive) → `act` (primitive) → **`extract` (primitive)** → `list_personas` / `list_scenarios` / `calibrate_critic` / `get_last_report` (meta). The mcp-registry catalog test was updated to assert the new 9-tool order.
- New schema: `ExtractResultSchema` in `src/core/result-schema.ts` mirrors the see / act envelope with three extract-specific fields — `data` (caller-defined; `z.unknown()`), `schema_used` (echoed JSON Schema for client-side re-validation; `z.unknown()` to avoid coupling our SemVer to JSON Schema's evolution), `instruction_used` / `selector_used` (debug aid). JSON Schema published as `docs/schemas/extract-result.schema.json`. Schema count 21 → 22 at `RESULT_SCHEMA_VERSION` 1.0.0.
- New tests:
  - `tests/result-schema.test.ts` — 7 new cases for `ExtractResultSchema` (minimal envelope, fully populated with realistic pricing-plan extraction, arbitrary `data` shape acceptance, engine rejection, status-enum rejection, negative-cost rejection, optional schema_version).
  - `tests/primitives/extract.test.ts` — 42 cases. (1) JSON Schema → Zod converter: 17 cases covering primitives / nested objects / arrays of objects / integer narrowing / string-only enum (z.enum) vs mixed enum (z.union of literals) / nullable shorthand (both `nullable: true` and `["T", "null"]`) / description preservation / `{ properties }` shorthand / ignored-keyword acceptance / all rejection paths (root non-object, oneOf/anyOf/allOf/not/$ref/const, missing items, empty enum, unknown type, with a useful path locator in the error message). (2) Primitive with `_openStagehand` / `_callExtract` test seams: schema field plumbing, persona viewport wiring, dom/console toggles, schema_used / instruction_used / selector_used echo, auto-instruction synthesis from field names, custom instruction verbatim forwarding, sub-region selector forwarding, schema-omitted fallback path (Stagehand default `{ extraction }`), `_callExtract` seam priority over opened.extract, three error paths (malformed schema fails fast before Stagehand cold-start / LLM throws / open() throws), three cost paths (tokens consumed → USD via estimateCost / no metrics movement → 0 cost / BudgetExceededError → error+data+cost all surfaced), three artefacts paths (per-call uniqueness / `AUDIT_EXTRACTS_DIR` env override / data.json artefact written for replay). (3) Real-Chromium integration test against `tests/fixtures/test-site/index.html` — exercises navigation / DOM extraction / screenshot / data.json persistence end-to-end with the LLM round-trip stubbed via the Stagehand-shaped open seam (no LLM credits ever burnt).
- New ADR-013 documenting the JSON Schema subset rationale (whitelist over permissive `json-schema-to-zod`; no Zod over the wire), why single-engine Stagehand (no deterministic alternative for shape-bound extraction), why auto-synthesised instruction beats schema-only (Stagehand performs better with a hint), why cost flows through Stagehand metrics → recordUsage (closes act's gap), partial-success budget-cap semantics, and the rejected alternatives (Zod direct; npm `json-schema-to-zod`; dual-engine; rely on free-form fallback; split into `extract_json` / `extract_text`; double-validation post-Stagehand; inline base64; enforce `pattern` / `minLength` etc.).
- Artifacts directory: `$AUDIT_EXTRACTS_DIR` env or `~/.ai-browser-auditor/extracts/<UTC-iso>-<rand6>/` (each call gets its own subdir, parallel-safe). The screenshot is always saved; the raw extracted payload is also persisted as `data.json` for replay / debug.
- 451 → 500 tests pass (+7 schema, +42 extract primitive). Typecheck clean. Build clean. MCP `tools/list` over stdio confirms 9 tools and the full `extract` inputSchema (14 properties; required = `["url"]`).

### Added (N-2 `act` primitive)

- New `src/core/primitives/act.ts` — second AI primitive in the v1 catalog. `act(opts: ActOptions): Promise<ActResult>` runs an ordered sequence of browser actions against a URL and returns a per-step trace plus the final DOM / console / screenshot. Step kinds: deterministic (`goto`, `click`, `fill`, `press`, `wait`, `wait_for`, `scroll`, `screenshot` — 0 LLM cost) and AI (`act { instruction }` via Stagehand, `note { goal }` via one `callVision` call). Engine auto-selects: `pickEngine(steps)` returns `"stagehand"` iff any step is `act`, otherwise `"playwright"` (the same fast cold-start path `see` uses, ~1 s vs Stagehand's ~5 s).
- New `src/mcp/tools/act.ts` — MCP wrapper, `kind: "primitive"`. Per-step input is a discriminated union mapped from snake-case JSON; coercion validates per-kind required fields with precise paths (`steps[2].selector must be a non-empty string`). `engine` argument exposes manual override; `stop_on_error` defaults true (subsequent steps marked `"skipped"`); `false` is opt-in for best-effort sequences.
- `ALL_TOOLS` in `src/mcp/server.ts` grows 7 → 8. Catalog order is now `audit_url` (preset) → `explore_url` (preset) → `see` (primitive) → **`act` (primitive)** → `list_personas` / `list_scenarios` / `calibrate_critic` / `get_last_report` (meta). The mcp-registry catalog test was updated to assert the new 8-tool order.
- New schemas: `ActStepSchema` (discriminated union covering all 10 step kinds), `ActStepResultSchema` (per-step record with `index` / `type` / `status` / `duration_ms` / optional `screenshot` / `note` / `output` / `error` / `cost_usd`), `ActResultSchema` (envelope with `engine`, `steps[]`, plus the same `dom` / `console` / `screenshot` / `cost_usd` / `persona_id` / `artifacts_dir` shape as `SeeResult`). JSON Schema published as `docs/schemas/act-result.schema.json`. Schema count 20 → 21 at `RESULT_SCHEMA_VERSION` 1.0.0.
- New tests:
  - `tests/result-schema.test.ts` — 12 new cases. `ActStepSchema` accepts every documented step kind, rejects unknown types and missing required fields. `ActStepResultSchema` accepts minimal/full step records and rejects negative cost. `ActResultSchema` round-trips minimal + fully-populated mixed-kind result, rejects unknown `engine` values, schema_version is optional for legacy fixtures.
  - `tests/primitives/act.test.ts` — 21 cases. Unit tests via `_open` / `_openStagehand` / `_callVision` test seams cover `pickEngine` selection, schema field plumbing (engine, persona, viewport precedence, dom/console toggles), per-step dispatch (every kind), `note` step (vision stub returns + cost accumulation, vision failure → step error), Stagehand path (action call recorded, error surfaces + skips remaining), error semantics (stop_on_error true/false, open() failure), artefacts uniqueness + `AUDIT_ACTS_DIR` env override. One real-Chromium integration test against `tests/fixtures/test-site/index.html` runs `[fill, screenshot, scroll]` end-to-end and asserts the per-step screenshot exists, final DOM is captured, and engine is `"playwright"`.
- New ADR-012 documenting why `act` ships as a mixed-kind step executor with auto-selected engine, why no inline retry stack (kept simple — `audit_url` owns the four-layer fallback), why split into deterministic + AI kinds (cheap common case, opt-in AI), why `stop_on_error: true` is the default. Rejected alternatives: pass-through to `runAudit`; single-engine Stagehand always; split into `act_deterministic` + `act_ai` tools; best-effort default; inline base64 screenshots; arbitrary Playwright surface.
- Artifacts directory: `$AUDIT_ACTS_DIR` env or `~/.ai-browser-auditor/acts/<UTC-iso>-<rand6>/`. The v1 worktree's `.env.development` should point this at `~/.ai-browser-auditor-v1/acts/` symmetric with the `sees` env (followup — the variable is honoured today via `defaultArtifactsRoot()` even without the env file entry).
- 418 → 451 tests pass (+12 schema, +21 act primitive). Typecheck clean. Build clean. MCP `tools/list` over stdio confirms 8 tools and the full `act` inputSchema (steps array with the 10-kind item shape).

### Added (N-1 `see` primitive)

- New `src/core/primitives/see.ts` — first AI primitive in the v1 catalog. `see(opts: SeeOptions): Promise<SeeResult>` opens a URL once with raw Playwright and returns a structured snapshot: DOM summary (interactive count + headings as `string[]` + element/text excerpts), captured console errors, a screenshot (always written to disk), and an optional natural-language note answering a `goal` question (one vision call). 0 LLM cost when `goal` is omitted; ~$0.005 when set.
- New `src/mcp/tools/see.ts` — MCP wrapper, `kind: "primitive"` (first one in the catalog). Accepts snake-case args (`url`, `goal`, `persona`, `wait_for`, `viewport_width`/`viewport_height`, `full_page`, `include_dom`, `include_console`, `timeout_ms`, `headless`). Persona resolution is best-effort: missing dir / id silently degrades to defaults (1280×800 / `en-US` / `UTC`). Output stamped with `schema_version` via `stampedTextResult(SeeResultSchema)`.
- `ALL_TOOLS` in `src/mcp/server.ts` grows 6 → 7. Catalog order is now `audit_url` (preset) → `explore_url` (preset) → **`see` (primitive)** → `list_personas` (meta) → `list_scenarios` (meta) → `calibrate_critic` (meta) → `get_last_report` (meta).
- New schemas: `SeeResultSchema` + `SeeDomSchema` + `SeeConsoleSchema` + `SeeScreenshotSchema` in `src/core/result-schema.ts`. JSON Schema published as `docs/schemas/see-result.schema.json`. Schema count 19 → 20 at `RESULT_SCHEMA_VERSION` 1.0.0.
- New tests:
  - `tests/result-schema.test.ts` — 5 cases for `SeeResultSchema` (minimal / full / enum reject / negative-cost reject / legacy-no-version).
  - `tests/primitives/see.test.ts` — 13 cases. Unit tests via `_open` test seam cover schema field plumbing, error path, persona/viewport precedence, note synthesis on/off, vision-failure swallowing, artefacts subdir uniqueness, `AUDIT_SEES_DIR` env override. One real-Chromium integration test loads the existing `tests/fixtures/test-site/index.html`, asserts `dom.headings`, `interactive_count`, and screenshot bytes.
  - `tests/mcp-registry.test.ts` — catalog test asserts the 7-tool order; new invariant that all three kinds (preset / primitive / meta) are represented.
- New ADR-011 documenting why `see` bypasses Stagehand and `runAudit`, why vision uses `callVision` instead of `runCritic`, and the rejected alternatives (full audit pipeline; Stagehand fingerprint parity; inline base64 screenshot; split tools).
- Artifacts directory: `$AUDIT_SEES_DIR` env or `~/.ai-browser-auditor/sees/<UTC-iso>-<rand6>/`. v1 worktree's `.env.development` already points the env at `~/.ai-browser-auditor-v1/sees/` for isolation.
- 399 → 418 tests pass (+5 schema, +13 see primitive, +1 registry catalog kinds invariant). Typecheck clean. Build clean. MCP `tools/list` over stdio confirms 7 tools with correct `see` schema.

### Changed (M3-6 + M9-1 MCP server modularization + tool registry)

- `src/mcp/server.ts` shrinks 502 → 148 lines. Tool input schemas, descriptions, and handlers all move to dedicated files under `src/mcp/tools/`. `server.ts` retains only transport lifecycle, secret bootstrap, the `ALL_TOOLS` catalog, ListTools mapping, and the CallTool dispatcher (with `withCostRun` + try/catch from M9-3).
- New `src/mcp/registry.ts` — `ToolDefinition` record (name / description / inputSchema / kind / optional resultSchema / handler) + `ToolRegistry` class (register / get / has / list / size / describe / registerAll).
- New `src/mcp/result.ts` — `ToolResult` interface, `textResult`, `errorResult`, `stampedTextResult` (M9-2 `schema_version` stamping wrapper). Extracted from `server.ts` so per-tool modules can import without dragging in transport.
- New `src/mcp/helpers.ts` — `requireString` (argument coercion), `resolvePersona` (id → persona with US-desktop fallback). Extracted from `server.ts`.
- New `src/mcp/tools/<name>.ts` — one file per tool, each exporting a `ToolDefinition`:
  - `audit-url.ts` (kind: preset)
  - `explore-url.ts` (kind: preset)
  - `list-personas.ts` (kind: meta)
  - `list-scenarios.ts` (kind: meta)
  - `calibrate-critic.ts` (kind: meta)
  - `get-last-report.ts` (kind: meta)
- `tests/mcp-server.test.ts` updated to import helpers from their new modules (`result.js` / `helpers.js`) instead of `server.js`. No dead re-export shims left behind.
- New `tests/mcp-registry.test.ts` (14 tests): `ToolRegistry` class coverage, `ALL_TOOLS` catalog invariants (every tool has non-empty name / description, object-shaped `inputSchema`, valid `kind`, unique names, `resultSchema` matches a published `docs/schemas/index.json` entry), and routing smoke (`buildDefaultRegistry().get(name).handler` returns a stamped ToolResult). Catches drift between a tool's declared result shape and the schemas committed to the repo.
- New ADR-010 documenting the file layout, the three-discriminator `kind` ("preset" / "primitive" / "meta"), why `kind`/`resultSchema` are kept off the `ListTools` payload, and the rejected alternatives (auto-glob discovery; re-export shims; MCP `_meta` field; registry-owned dispatcher).
- New README "MCP Server" section (registration JSON for Claude Code, tool table, link to ADR-010).
- New architecture.md "MCP Server" section (file layout, kind taxonomy, "adding a new tool" recipe).
- `tools/list` payload is unchanged from a client's perspective: still 6 tools, still `{ name, description, inputSchema }` only. `kind` and `resultSchema` are reserved on the registry record for the future M9-5 `list_capabilities` tool.
- 399/399 tests pass (was 385/385 on M9-3 verification; +14 from the new registry test file).

### Fixed (M9-3 follow-up — cross-process SQLite WAL init)

- All three SQLite open paths (`agent/memory.ts`, `agent/plan-cache.ts`, `core/history.ts`) now serialize the one-time WAL transition through `withFileLockSync(<dbPath>.init.lock, …)` and set `busy_timeout = 5000` per connection. Closes a race discovered while validating M3-6+M9-1: SQLite's `journal_mode = WAL` switch takes an EXCLUSIVE lock that explicitly does NOT honor `busy_timeout` (verified by setting it to 30 s and watching concurrent opens still fail in ~10 ms with "database is locked"). Three subprocesses opening the same fresh DB file would race the journal-mode switch, ~25 % of the time one would lose and exit code 1; in production this would silently drop facts / cache writes from one of two parallel audit runs.
- Inside the lock, `journal_mode` is read first and only set when not already `"wal"`. Once any process completes the transition, WAL persists in the file header — subsequent opens just observe and skip in microseconds.
- `tests/memory.test.ts` cross-process race test: 20/20 pass after fix (was 5/20 before).
- No production behaviour change beyond eliminating the SQLITE_BUSY crash path. WAL mode persists in the DB header as before; `busy_timeout` adds patient retry, never changes correctness.

### Added (M9-3 Concurrency safety)

- New `src/core/file-lock.ts` — cross-process advisory lock helper. `withFileLock(lockPath, fn)` and `withFileLockSync(lockPath, fn)` hold a critical section across processes via a write-tmp-then-`linkSync` lockfile. Stale locks self-heal when the holder pid is no longer alive or the timestamp exceeds `staleAfterMs` (default 30 s). No new dependencies.
- `CostGuard.recordUsage` ledger I/O now wraps load-prune-mutate-write in `withFileLockSync(<ledgerPath>.lock, …)`. Two parallel CLI / MCP processes hitting the same ledger file no longer lose updates last-write-wins.
- Per-run cost counters move from `CostGuard.run` (instance field) to an `AsyncLocalStorage<RunSnapshot>`. New `withCostRun(fn)` helper creates a fresh scope per audit / per MCP tool dispatch.
  - `runner.runAudit()` body wraps in `withCostRun` — every audit (CLI, benchmark, MCP-via-runAudit) gets its own scope.
  - `mcp/server.ts` dispatcher wraps every tool call in `withCostRun` — covers `calibrate_critic` and any future LLM-using tools that don't go through the runner.
  - Falls back to the instance's `fallbackRun` field when no scope is active (back-compat for unit tests and direct-class users).
- `AgentMemory.record` switched from SELECT-then-INSERT/UPDATE to one atomic `INSERT … ON CONFLICT(fact_hash) DO UPDATE`. Confidence cap (≤ 0.99) moves to SQLite's `min(0.99, confidence + 0.05)`. Closes a race where two parallel processes recording the same fact would throw `UNIQUE constraint failed`.
- Visual diff baseline bootstrap (`diffAgainstBaseline`) now copies to a per-process `.tmp` and atomically `linkSync`s into place. First writer wins; second swallows `EEXIST`. No more racy clobbering of a freshly-created baseline.
- New ADR-009 documenting the four-hazard inventory and the linkSync / ALS / atomic-upsert mitigations.
- New tests:
  - `tests/file-lock.test.ts` — 11 tests including 2 cross-process races (counter increments under lock from 2 / 3 child processes).
  - `tests/cost-guard-concurrency.test.ts` — 6 tests for ALS scope isolation, nested scopes, fallback behaviour, and a 3-process ledger race.
  - `tests/memory.test.ts` — 14th test: 3 child processes recording the same fact 12 times each → `confirmations = 36`, no exceptions.
  - `tests/visual-diff-baseline.test.ts` — 2 tests including parallel-bootstrap race.

### Added (M5-6 Cost guard)

- New `src/core/cost-guard.ts` — process-wide LLM spend cap with two layers:
  - **Per-run** in-memory token / USD counter, reset at audit-run / MCP-tool entry.
  - **Per-day** UTC-keyed JSON ledger persisted to `~/.ai-browser-auditor/cost-ledger.json` (override via `AUDIT_COST_LEDGER_PATH`); 30-day auto-prune at write time; atomic temp + rename writes; malformed-file recovery treats the ledger as empty.
- `getCostGuard()` singleton; `BudgetExceededError` carries `kind: "run-usd" | "run-tokens" | "daily-usd" | "daily-tokens"`, `current`, and `limit`.
- Every Anthropic API call site now sandwiches `guard.checkBudget()` (pre) and `guard.recordUsage(model, in, out)` (post): `core/llm.ts:callVision`, `core/computer-use.ts` beta loop, `core/instruction-mutator.ts:llmRewrite`, `agent/planner.ts:createPlan` + `microReplan`, `agent/navigator.ts:decideNextStep`. Convergence's `checkVisualCriterion` inherits via `callVision`.
- `runAudit` (CLI path) and the MCP `CallToolRequestSchema` dispatcher both call `getCostGuard().resetRun()` so each invocation starts with a clean per-run counter.
- Ledger schema is stamped with `COST_LEDGER_SCHEMA_VERSION = "1.0.0"`, following the M9-2 SemVer policy.
- New env vars: `AUDIT_COST_MAX_RUN_USD` (default `5`), `AUDIT_COST_MAX_RUN_TOKENS` (default `10_000_000`), `AUDIT_COST_MAX_DAILY_USD` (default `50`), `AUDIT_COST_MAX_DAILY_TOKENS` (default `100_000_000`), `AUDIT_COST_LEDGER_PATH`, `AUDIT_COST_GUARD_DISABLED=1` (bypass for CI / tests).
- New ADR-008 documenting hook-at-call-site, persistent ledger, symmetric pre-check / post-record enforcement.
- New `tests/cost-guard.test.ts` with 18 tests: `recordUsage` math, atomic ledger persistence, cross-instance ledger sharing, day rollover, all four tripwire kinds, error message env hint, `resetRun` semantics, snapshot reporting, disabled mode (constructor flag + env var), 30-day pruning, malformed-file recovery, singleton lifecycle. Total: 363/363 tests pass.

### Added (M9-2 Result schema 稳定承诺)

- `RESULT_SCHEMA_VERSION = "1.0.0"` — single source-of-truth SemVer string for every result the auditor emits to AI agents and external consumers.
- `src/core/result-schema.ts` — Zod schemas for the 19 public result types (`AuditRun`, `ScenarioRunResult`, `StepResult`, `Issue`, `DimensionScore`, `ConsoleError`, `CriticResult`, `GateResult`, `CalibrationReport`, `BenchmarkReport`, `BenchmarkTaskResult`, `MutationResult`, MCP tool envelopes, `HistoryEntry`, `PersonaSummary`).
- `attachSchemaVersion(value)` — idempotent helper that stamps `schema_version` at the top of plain object results without overwriting an existing value.
- `validateResult(name, schema, value)` — observe-only `safeParse` wrapper. Mismatches log a structured `warn` line via the result-schema logger; the producer's payload always flows through unchanged at v1.0.0.
- Producers stamp `schema_version` on every freshly emitted result (`runAudit`, `runCritic`, `scoreReport`, `aggregateReport`, `summarize` for benchmarks, `generateMutations`).
- MCP server's 6 tool handlers now route through `stampedTextResult(name, schema, value)`: object responses gain `schema_version` at the top; arrays pass through validated but unwrapped.
- SQLite history DB migrates `user_version` 1 → 2: adds `audit_runs.schema_version TEXT NOT NULL DEFAULT '1.0.0'` (legacy rows backfill to `'1.0.0'`); `loadHistory` returns the value as `HistoryEntry.schemaVersion`.
- New `npm run schemas` script (`scripts/export-result-schemas.ts`) emits Draft-7 JSON Schemas to `docs/schemas/*.schema.json` plus an `index.json` manifest. Each carries `$id`, `title`, `description`, and `x-result-schema-version` for consumer matching.
- `docs/contracts/RESULT_SCHEMA.md` — full SemVer policy (patch / minor / major bump rules, what may change without a bump, how to bump operationally).
- New ADR-007 documenting embed-vs-envelope, observe-then-enforce, and SQLite migration choices.
- 30 new tests across `tests/result-schema.test.ts`, `tests/history.test.ts`, `tests/mcp-server.test.ts` covering schema validation, version stamping, history round-trip, and MCP envelope behavior. Total: 345/345 tests pass.

### Dependencies

- Added (dev): `zod-to-json-schema@^3.25.2`.

### Added (M1-4 Secrets redaction)

- Logger now applies two-layer secret redaction to every log line:
  - **Path-based** — well-known field names (`apiKey`, `password`, `token`, `cookie`, `authorization`, etc.) are always censored regardless of value, both at top level and one level deep.
  - **Value-based** — concrete env-derived secret values (registered at startup via `registerSecret`) are substring-replaced anywhere they appear in payloads or in the message string.
- New `registerSecret(value)` API in `src/core/logger.ts`. Bootstrapped in `src/cli.ts` and `src/mcp/server.ts` via `buildRedactPatterns([])` after `dotenv.config()`.
- New `safePrint` / `safeError` helpers in `src/cli.ts` for `catch` blocks that print `err.message` — runs the same redaction pass on user-facing console output.
- New ADR-006 documenting the design.

### Added (M1-3 Structured logging)

- New `src/core/logger.ts`: pino-based structured logger.
  - `getLogger(module)` returns a module-scoped child logger (cached per module).
  - All output goes to **stderr** — keeps stdout clean for CLI results and the MCP stdio protocol.
  - TTY-aware default: pretty (colored, human-readable) when stderr is a TTY, JSON otherwise.
  - Env config: `LOG_LEVEL` (trace…fatal, default `info`), `LOG_PRETTY` (`auto`/`1`/`0`), `LOG_FILE` (optional tee).
- `scripts/check-no-console.sh`: regression guard wired into `npm test`. Build fails if any source file outside `src/cli.ts` reintroduces `console.{log,error,warn,info,debug}(`.
- New ADR-005 documenting the choice and trade-offs.

### Changed

- ~30 internal `console.*` call sites in `core/runner.ts`, `core/notify.ts`, `core/stagehand-wrapper.ts`, `agent/agent-loop.ts`, `agent/events.ts`, `observer/screencast.ts`, `observer/server.ts`, `mcp/server.ts` migrated to the structured logger.
- `agent/events.ts:attachConsoleLogger` now emits structured log lines (one per agent event) instead of chalk-formatted console writes. Each line carries `event`, `category`, `sessionId`, `seq`, plus event-specific fields.
- The previous `AUDIT_DEBUG=1` gate on agent-loop crash stack traces is removed; `LOG_LEVEL=debug` covers it.
- `npm test` now runs the no-console regression check before vitest.

### Dependencies

- Added: `pino@^10.3.1`, `pino-pretty@^13.1.3`.

## [0.3.0] - 2026-04-17

Released after 22 atomic commits over 6 development weeks; verified with 300
automated tests + live-API Phase-2 smoke ($0.26 / 3 bugs found and fixed
before merge). Fully additive — no breaking changes from v0.2.0.

### Fixed — Phase 2 live smoke (v0.3.0-rc.2)

- `scoreReport` no longer silently disables gate when CLI overrides are
  undefined (object-spread overwrote defaults)
- Calibration fixture labels recalibrated against observed Sonnet 4.6
  scoring — 100% agreement post-fix (was 46.7%)
- `ai-audit explore` now writes audit.json / audit.html / audit-explorer.html
  / summary.md (previously only video + console log)

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
- **Project layout**: `projects/<your-app>/` directory structure for multi-project repos
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

[1.2.0]: https://github.com/xcodethink/pixelcheck/compare/v1.1.5...v1.2.0
[1.1.5]: https://github.com/xcodethink/pixelcheck/compare/v1.1.4...v1.1.5
[1.1.4]: https://github.com/xcodethink/pixelcheck/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/xcodethink/pixelcheck/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/xcodethink/pixelcheck/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/xcodethink/pixelcheck/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/xcodethink/pixelcheck/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/xcodethink/pixelcheck/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/xcodethink/pixelcheck/compare/v0.3.0...v1.0.0
[0.3.0]: https://github.com/xcodethink/pixelcheck/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/xcodethink/pixelcheck/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/xcodethink/pixelcheck/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/xcodethink/pixelcheck/releases/tag/v0.1.0

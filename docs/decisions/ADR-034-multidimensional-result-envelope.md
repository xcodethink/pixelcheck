# ADR-034 — Multi-dimensional result envelope (`diagnostics`)

- **Status**: Accepted
- **Date**: 2026-05-04
- **Decider**: Wayne
- **Builds on**: [ADR-002](./ADR-002-primitive-first-architecture.md) (primitive-first), [ADR-007](./ADR-007-result-schema-versioning.md) (result schema versioning)
- **Phase**: Phase 0 of "AI 自动化测试 + 审计平台" upgrade

## Context

Today's `see` / `act` / `extract` / `compare` primitive results carry pass/fail
status, a final screenshot, console errors, DOM snapshot, and the URL trail.
That is enough for "did the page load and did the click work" — i.e. **black-box
functional verification**. It is not enough for the standard a professional
testing-and-auditing platform must hit:

- **Visual** — was the layout intact, the brand consistent, was anything
  truncated or off-color?
- **White-box** — what popups opened (OAuth/SSO/share dialogs), what network
  requests fired, what cookies / localStorage / sessionStorage were touched?
- **Performance** — Core Web Vitals (LCP / CLS / INP), Time-to-Interactive,
  network waterfall.
- **Accessibility** — axe-core scan results (already collected separately
  via `assert_a11y` step).
- **Security / Privacy / SEO / Content** — additional dimensions in later
  phases.

The product owner's call is unambiguous: **a professional audit never
short-circuits**. Functional pass does NOT mean we skip the visual check; visual
pass does NOT mean we skip white-box; etc. Every dimension is checked,
collected, and reported independently. Selectively suppressing dimensions
("only emit white-box on failure") is the wrong default — it converts a
audit tool into a debug tool.

The four primitive results need a place to put these new dimensions without:

1. Breaking the existing root-level fields (`url_input`, `console`,
   `screenshot`, `dom`, ...) that downstream reporters and the SPA HTML
   renderer walk by name.
2. Polluting the root namespace by adding 6+ sibling fields per primitive
   (`popups`, `network`, `cookies`, `storage`, `performance`, `visual`).
3. Forcing every consumer to learn about every dimension at once.

## Decision

### One envelope sub-object: `diagnostics`

Each primitive result schema gains a single optional `diagnostics` field:

```ts
SeeResult / ActResult / ExtractResult / CompareResult {
  // ... existing root fields unchanged ...
  diagnostics?: DiagnosticsSchema
}

DiagnosticsSchema = {
  collected_at: 'always' | 'on_failure'    // default 'always'
  popups?: PopupSnapshotSchema[]            // PR-B
  network?: NetworkLogSchema                // PR-B
  cookies?: CookieSchema[]                  // PR-B
  storage?: StorageSnapshotSchema           // PR-B
  performance?: PerformanceMetricsSchema    // PR-C
  visual?: VisualScoringSchema              // PR-D
}
```

Default behavior: every primitive call collects every dimension (see
"Always-collect, never-skip"). `collected_at: 'always'` is the canonical
value. The `'on_failure'` value is reserved for future opt-in performance
optimization where a caller explicitly accepts "less data on pass" —
not used in v1.3.0.

### Always-collect, never-skip

Per the product owner's call: PixelCheck is a professional testing +
auditing platform, not a debug-when-broken tool. Each dimension's collector
runs unconditionally. The two ways a sub-field is absent on a result:

1. The primitive ran in a v1.2.x build that didn't know about the field.
2. The collector for that dimension wasn't shipped yet (PR-B/C/D pending).

There is no "pass case skipped collection to save tokens" path. Tokens spent
on full diagnostics are the deliberate cost of audit-completeness; consumers
who don't care can ignore the field.

### Why `diagnostics`, not `extras` / `details` / `data`

- "diagnostics" carries the medical / engineering connotation of "data you
  read to understand what happened" — exactly the audit semantic.
- "extras" / "details" suggest optional / tertiary, opposite of the intent.
- "data" is too generic and conflicts with `extract`'s `data` field.
- Future audit-specific fields with different semantics (e.g.
  `compliance: WcagComplianceSchema` for a formal WCAG-conformance
  declaration) get their own top-level field, not a sub-key of
  diagnostics. Diagnostics is for raw signal; compliance is for
  judgment.

### Schema version: 1.2.0 → 1.3.0

Per ADR-007 SemVer policy, adding an optional sub-object to existing
schemas is a **minor** bump:

- `RESULT_SCHEMA_VERSION = "1.3.0"`
- v1.3.0 history note added in `result-schema.ts`
- JSON schema artifacts in `docs/schemas/` regenerated
- Validation policy stays observe-only (per ADR-007); a v1.2.x consumer
  reading a v1.3.x payload sees the unknown `diagnostics` key and either
  ignores it (Zod `passthrough`) or warns (consumer's choice).

### Phased delivery

This ADR governs PR-A through PR-E:

| PR | Scope | Schema impact |
|---|---|---|
| **PR-A** (this) | ADR + DiagnosticsSchema **scaffolding** + 6 placeholder sub-schemas + `diagnostics?` threaded into 4 primitive results + tests | Bump to 1.3.0; sub-schemas are placeholders (object with `TODO` marker) |
| **PR-B** | WhiteboxCollector — fill `popups` / `network` / `cookies` / `storage` sub-schemas + 4 primitives wire it on | No version bump (already 1.3.0; sub-schema fields fill in) |
| **PR-C** | PerformanceCollector — fill `performance` sub-schema | No version bump |
| **PR-D** | VisualCollector (reuses `runJudgeVision`) — fill `visual` sub-schema; `cfg.visualScoring: 'off'\|'auto'\|'eager'` in see/act/extract; judge always mirrors its own data into `diagnostics.visual`; `JudgeResultSchema` gains `diagnostics?` | No version bump |
| **PR-E** | New `diagnose` primitive + `pixelcheck.diagnose` MCP tool with commercial-grade output (confidence, standards_mapping, evidence_refs, overall_health_score, executive_summary). Critic / judge prompts intentionally NOT modified — see PR-E appendix. | New schemas (DiagnoseResult + sub-schemas), no impact on existing primitive results |

PR-A ships zero behavior change at runtime — primitives don't yet emit
`diagnostics` because no collector is wired. Pure type contract: the field
becomes legal in the schema. PR-B is the first PR that actually populates
data. This phasing is intentional so each PR is independently shippable
and reviewable under PixelCheck's <300 LoC PR convention.

## Consequences

### Positive

- Adds a single, predictable place for every future audit dimension.
- Backward-compatible: pre-1.3.0 consumers see the field as unknown and
  ignore it; their existing parsers don't break.
- Lets PR-B/C/D/E ship independently without further schema-version bumps.
- Critic AI in PR-E gets a single nested object to inject into prompts
  instead of 6 sibling fields.
- Aligns with how Stripe / GitHub / Anthropic SDK structure response
  envelopes (root field for primary data, optional nested object for
  metadata-rich extras).

### Negative

- A consumer reading `result.popups` directly (instead of
  `result.diagnostics.popups`) gets `undefined` — but no such consumer
  exists today, so the only risk is in future code we haven't written yet.
- Every primitive result now has a parsing path that may walk into the
  diagnostics sub-tree, which adds nominal CPU. Negligible in practice
  (Zod schemas are pre-compiled).

### Neutral

- No consumer is forced to use the new field. Reporters that want to render
  popups / network / cookies opt in in PR-B+; everything else continues
  reading root-level fields as before.

## Alternatives considered

### A. Embed each dimension at top-level

```ts
SeeResult { ..., popups?, network?, cookies?, storage?, performance?, visual? }
```

Pollutes the root namespace, makes the result shape "everything is at the
top level and you have to know which fields are status vs which are
diagnostic". Rejected.

### B. One `inspections` array of typed entries

```ts
SeeResult { ..., inspections?: Array<{type: 'popup'|'network'|..., data: unknown}> }
```

Makes consumers pay for runtime type narrowing on every read. Rejected.

### C. Failure-only diagnostics

Collect everything but only serialize when status === "error". Saves
tokens on the happy path.

Wayne's product judgment: rejected. A professional audit never says "you
passed so I won't tell you anything." Visual / performance / accessibility
checks must produce data even when functional check passed, so a
downstream WCAG audit / Lighthouse report can roll the data up.
Conversion of audit tool into debug tool is the wrong direction.

### D. Two parallel envelopes (`diagnostics` + `metrics`)

```ts
SeeResult { ..., diagnostics?: { popups, network, cookies, storage }, metrics?: { performance, visual } }
```

Cleaner separation but two top-level fields to discover and version
independently. PixelCheck's existing schema already mixes raw signal
(`console`) with derived metrics (no equivalent today, but
`AssertA11yResult.violation_count`-style fields belong with their data).
Single `diagnostics` envelope keeps the convention. Rejected.

## References

- `src/core/result-schema.ts` — schema implementation
- `tests/result-schema.test.ts` — schema tests (new cases for 1.3.0)
- ADR-007 — SemVer policy this minor bump complies with
- ADR-002 — primitive-first architecture this preserves
- `docs/schemas/*.json` — JSON Schema artifacts auto-regenerated by
  `npm run schemas`

## Appendix: Relationship to `src/agent/signals/`

PixelCheck already had a `signals/` collector layer (`network.ts`,
`performance.ts`, `errors.ts`, `interaction.ts`) before ADR-034. Those
collectors were built for the **agent-loop autonomous-mode
success-criteria verification** path: when a scenario in autonomous
mode declares a success criterion like `verification: "performance"`
with thresholds `{ lcp_max_ms: 2500 }`, the agent's convergence loop
calls `signals.performance.snapshot()` and `matchPerformance()` to
decide whether to stop or keep iterating.

Those collectors were **not integrated into the primitive-default-open
path**. PR-A through PR-E use them differently:

- **PR-C** (this round): wires the existing `PerformanceSignalCollector`
  directly into see / act / extract `defaultOpen` paths so every
  primitive call surfaces `result.diagnostics.performance` regardless
  of whether the caller is using autonomous mode. Pure reuse, no
  duplication.

- **PR-B** (already shipped): introduced `WhiteboxCollector` for the
  four white-box dimensions (popups / network / cookies / storage).
  This **partially duplicates** `signals/network.ts`'s event
  listening — both observe the same `page.on('request' | 'response' |
  'requestfailed')` events. The duplication is correct (the two
  collectors emit different output shapes for different consumers)
  but not optimal.

  A future **PR-B-followup** can refactor into a single underlying
  observer with two view layers:

  ```
  LowLevelNetworkObserver (one set of listeners, one event buffer)
    ├─ AgentSignalView   → existing { status_counts, slow_requests, ... }
    └─ DiagnosticsView   → PR-B { request_count, requests[], failures[], ... }
  ```

  The refactor is deferred because (1) both collectors work
  correctly today, (2) the shared listener cost is small (microseconds
  per event), (3) touching `signals/network.ts` requires re-validating
  the agent convergence path which is its own audit surface, and (4)
  ADR-034 phasing (PR-C → PR-D → PR-E) is on the critical path; the
  followup is engineering hygiene, not user-visible feature work.

## Appendix: PR-D — VisualCollector reuse-not-duplicate strategy

PR-D introduces visual scoring (`diagnostics.visual`) by reusing the
existing `judge` primitive's vision-call internals. Specifically:

- The new `src/core/visual-collector.ts` exposes a `VisualCollector`
  class whose `score(buf)` method calls `runJudgeVision()` from
  `src/core/primitives/judge.ts` directly, sharing prompt construction
  (`buildJudgeSystemPrompt` + `buildJudgeUserPrompt`), JSON parsing
  (`parseJudgeRawJson` defensive coercion), criterion resolution
  (`resolveCriteria`), and overall-score math (`computeOverallScore`).
  This is a single shared code path — there is no second prompt or
  second JSON parser to keep in sync.

- The collector adds only the envelope-shaping layer:
  `buildVisualScoring()` denormalises `verdict.label + kind` from the
  rubric onto each verdict so downstream consumers don't need the
  rubric to render the result, and produces a `VisualScoring` object
  shaped for embedding inside `DiagnosticsSchema`.

- The `judge` primitive itself uses the same `buildVisualScoring()`
  helper from inside `computeJudge()` to populate its own
  `result.diagnostics.visual` mirror **without** re-running the vision
  call. Cost is zero — the data is already in hand from judge's
  existing call.

### Why visual scoring is opt-in (vs always-collect for whitebox / performance)

ADR-034's body argues for "always-collect, never-skip" as the
audit-completeness default. PR-D introduces the only carve-out: visual
scoring must be opt-in via `cfg.visualScoring: 'off' | 'auto' | 'eager'`,
defaulting to `'off'`.

The asymmetry is grounded in cost:

| Dimension | Collection cost | Default mode |
|---|---|---|
| popups / network / cookies / storage (PR-B) | passive observers; ~µs per event | always |
| performance / Web Vitals (PR-C) | passive observers; one `evaluate()` to flush | always |
| visual scoring (PR-D) | **one Anthropic vision call** (~$0.005-0.02 each) | **off** |

A caller who runs `see({url})` on 1000 URLs with always-on visual
scoring would silently spend $5-20 of LLM budget. That violates
ADR-034's "no surprise spend" posture, which is the same reason
`see({url})` without a `goal` makes zero LLM calls today.

The three-mode opt-in is the minimum surface that lets a caller
recover the always-collect ethos when they want it (`'eager'`),
bundle the cost into work that's already paying for vision (`'auto'`,
which fires only when the host call already had a `goal` / `note` /
extract LLM call), or stay completely silent (`'off'`).

### Why no `assertVisual` step-handler mirror in PR-D

The `handleAssertVisual` step handler in `src/handlers/index.ts`
already produces visual scoring under a different shape
(`runCritic` from `src/core/critic.ts`, persona × scenario × dimension
scoring with `VisionVerdictSchema`). A symmetric `step.diagnostics.visual`
mirror would be valuable but requires touching `StepResult` (every
step type, not just `assert_visual`) and would add a second normalised
shape that overlaps `step.output.scores` / `step.output.issues`
emitted today.

The mirror is deferred to a future refactor where `StepResult` inherits
a unified diagnostics envelope across all step types — out of scope for
PR-D's <300 LoC convention.

## Appendix: PR-E — `diagnose` primitive, NOT critic-prompt injection

The original ADR-034 plan listed PR-E as "Critic prompt + new
`pixelcheck.diagnose` MCP tool". On reaching PR-E we split the two
proposed actions and kept only the second.

### Why a fresh primitive, not critic / judge prompt injection

The body of ADR-034 was conservative about the critic and judge
prompts because both already had a different audited semantic:

- `judge` is rubric × URL → 0..10 per-criterion verdicts.
- `runCritic` is persona × scenario × dimension scoring used by
  `audit_url`'s pipeline.

Augmenting either prompt with the diagnostics envelope would have
been a Trojan-horse change: the model would shift from "score against
this rubric" to "score against this rubric AND also flag network /
performance / privacy issues you happened to read", which:

1. Pollutes audit_url's scoring stability — a downstream critic
   regression would be hard to attribute to "rubric drift" vs
   "newly leaked diagnostics into the prompt".
2. Forces every existing rubric to silently inherit dimensions it
   wasn't designed for (aesthetic rubric scoring "popups: 1 OAuth
   open" is meaningless).
3. Loses the new tool's target audience — `diagnose` is for the
   "what's wrong with this page" question, not "score this against
   a UX rubric"; the system prompt for those two tasks should
   diverge, not converge.

So PR-E builds a dedicated primitive whose system prompt is purpose-
built for "read structured diagnostics + screenshot → emit findings
with anti-hallucination evidence citations", and leaves judge / critic
untouched.

### Commercial-grade fields beyond the original ADR scope

When PR-E's design was reviewed against published commercial audit
tools (Lighthouse Enterprise, Sentry, Datadog Synthetics, Snyk,
axe-core enterprise reporting), five fields appeared in every one
that the ADR's "what's wrong" framing alone did not capture:

1. `confidence: 0..1` per finding (enterprise triage signal).
2. `standards_mapping[]` per finding mapping to industry frameworks
   (Core Web Vitals, WCAG 2.2, OWASP Top 10 2021, GDPR, …) — the
   exact data shape compliance reports / SOC 2 audits / VPATs
   consume verbatim.
3. `evidence_refs[]` citing JSON-pointer paths into the diagnostics
   envelope — anti-hallucination tether enforced post-parse (drop
   findings without citations at severity ≥ medium).
4. `overall_health_score: 0..100` plus per-dimension drill-down —
   single dashboard signal + drill-down for engineering teams.
5. `executive_summary` (≤ 3 sentences) + `findings_by_dimension`
   index — PM / CTO layer separated from the engineering layer.

These five raised PR-E from ~450 LoC to ~900 LoC, exceeding the
"<300 LoC per PR" convention the earlier PRs followed. The trade-off
is acceptable because PR-E is the Phase 0 capstone — capping the
investment at "first 80% commercial parity" was the right call.

### Anti-hallucination contract (post-parse enforcement)

The `parseDiagnoseRawJson()` validator drops findings the model
emits but cannot substantiate, instead of returning them with a
warning:

- Severity `critical | high | medium` MUST include ≥ 1 evidence_ref.
- Findings whose `dimension` has no collected data are dropped (e.g.
  performance finding when no perf collector ran; an LLM that
  hallucinates a "network latency issue" while the network collector
  was not attached cannot survive the validator).
- `low` severity is exempt from the evidence-ref requirement (used
  for polish / nit findings the model can articulate from the
  screenshot alone).

This converts "model said X" into "model said X AND we have a real
data point supporting X" before the finding leaves the primitive.
The dropped count is logged at `warn` level so operators can detect
prompt drift over time.

### Why `diagnose` is a `preset`, not a `primitive`

The MCP `kind` taxonomy (`primitive | preset | meta`) describes
caller-facing UX, not internal composition. `diagnose` orchestrates
existing primitives (`see` with eager visual scoring + the underlying
collectors), then layers structured analysis on top. By the
audit_url / explore_url precedent, that's a `preset`. Listing it as
a `primitive` would mislead callers into thinking it's a single-call
building block (it's two LLM calls + per-collector evaluation).

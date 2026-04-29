# ADR-014 — `judge` + `compare` primitives (N-3 + N-8)

- **Status**: Accepted
- **Date**: 2026-04-30
- **Task**: N-3 (`compare(a, b, criteria)` MCP tool) + N-8 (Aesthetic / dark-pattern critic)
- **Builds on**: ADR-002 (primitive-first), ADR-007 (result schema versioning), ADR-008 (cost guard), ADR-009 (concurrency safety), ADR-010 (MCP tool registry), ADR-011 (`see` primitive), ADR-012 (`act` primitive), ADR-013 (`extract` primitive)

## Context

`see` lets the AI client look at a page; `act` lets it execute a sequence; `extract` lets it pull structured data. The remaining gap in the v1 primitive kit is **judgement** — answering questions like:

- "Is this landing page aesthetically polished or cluttered?"
- "Is this checkout flow using dark patterns?"
- "Which of these two pricing pages converts better at first glance?"

These are LLM-judgement workloads, not capture or extraction workloads. Two distinct user-facing tools fall out:

1. **Single-page judgement** (N-8) — apply a rubric (aesthetic, dark-pattern, custom) to one URL and emit per-criterion scores + findings.
2. **A/B comparison** (N-3) — apply the same rubric to two pages and emit per-criterion winners + an overall winner.

These pair naturally: comparison needs a rubric engine, and the rubric engine is independently useful for solo evaluations. Bundling them into a single multi-mode tool would lose the ability to cache single-page judgements (M9-4) and would blur cost transparency.

## Decision

Ship two new primitives:

- `src/core/primitives/judge.ts` — single-page rubric-driven critic.
- `src/core/primitives/compare.ts` — A/B comparison built on top of judge.

Plus rubric modules:

- `src/core/critics/aesthetic.ts` — 8 criteria (visual hierarchy, typography, alignment, contrast, spacing, polish, density, brand cohesion).
- `src/core/critics/dark-pattern.ts` — 12 criteria (forced continuity, hidden costs, pre-selected options, fake urgency, confirmshaming, obstruction, misdirection, trick questions, disguised ads, bait & switch, privacy zuckering, nagging).

Plus two MCP tools (`judge`, `compare`), bringing the catalog to 11 (4 primitives, 2 presets, 5 meta).

### `judge` API

```ts
judge({
  url? | capture?,             // URL to capture, or pre-existing snapshot
  rubrics?,                    // ["aesthetic"] (default) | ["dark_pattern"] | ["aesthetic","dark_pattern"]
  customCriteria?,             // optional caller-supplied criteria
  persona?, viewport?, waitFor?, fullPage?, includeDom?, includeConsole?,
  timeoutMs?, headless?, artifactsRoot?, model?,
})
→ JudgeResult { ..., rubrics, criteria, verdicts[], findings[], overall_score,
                summary, dom, console, screenshot, cost_usd, ... }
```

One vision call per invocation. Cost-guarded via `callVision`.

### `compare` API

```ts
compare({
  a: { url? | capture?, persona?, viewport? },
  b: { url? | capture?, persona?, viewport? },
  mode?,                       // "double_blind" (default) | "fast"
  rubrics?, customCriteria?,
  waitFor?, fullPage?, includeDom?, includeConsole?, timeoutMs?, headless?,
  artifactsRoot?, model?,
})
→ CompareResult { ..., mode, rubrics, criteria, side_a, side_b,
                  per_criterion[], overall_winner, summary, cost_usd, ... }
```

In `double_blind` mode (default): 3 vision calls — judge A in parallel with judge B, then 1 synthesis call. Wall-clock ≈ 2 calls.

In `fast` mode: 1 vision call — captures both pages, sends both screenshots to a single synthesis vision call. Cheaper, anchored.

### Rubric philosophy

Every criterion is reified data: `{ id, label, description, kind }`. The id is stable snake_case so consumers can join verdicts back to the rubric across runs and across compare sides without prompt fragility. The description is rendered into the system prompt verbatim — to add or revise a criterion, edit data, not prompts.

Score direction is uniform: **higher is better, regardless of kind**. Aesthetic 10 = excellent; dark-pattern 10 = no dark pattern detected. This keeps `overall_score` (mean) monotonic when rubrics mix.

## Why double-blind by default

The single biggest design call in this ADR. Anchoring bias is well-documented in behavioural economics and observed in LLM evaluations (Bansal et al., "On the Effects of Anchoring on Side-by-Side Evaluation", 2024; Anthropic's own evaluation guides note the same hazard).

When a vision model is asked to score *and* compare *and* synthesise *and* summarise from one prompt with two images, the cognitive load forces the model to optimise for one of those four jobs at the expense of the others. In practice the synthesis dominates: absolute scores get dragged toward the difference, not the page itself.

**Industry parallels**:

- **Nielsen Norman Group / Baymard Institute** UX comparison reports independently evaluate each candidate before a comparison synthesis.
- **Code review** doesn't have one reviewer compare two PRs in one pass; each PR is reviewed independently.
- **Scientific peer review** uses double-blind comparisons specifically to neutralise reviewer-side anchoring.

**Cost trade-off**: double-blind is 3× the LLM calls vs fast. At Sonnet 4.6 input pricing the absolute difference is ~$0.04 per comparison. Commercial users prioritise judgement quality; the cost difference is dwarfed by the engineering value of an unbiased baseline. We expose `mode: "fast"` for cost-sensitive batch use cases (compare 100 pricing pages overnight) but make users opt out, not opt in.

## Alternatives rejected

### 1. Single combined `judge_and_compare` tool

A multi-mode tool that takes 1 or 2 URLs and switches behaviour internally. Rejected because:

- Loss of fine-grained caching: `judge` results for a single URL can be cached and reused by future `compare` calls (M9-4 result cache); a combined tool can't.
- Loss of cost transparency: AI agents can't tell at planning time whether a tool call costs 1 LLM invocation or 3.
- Failure-isolation regression: a synthesis failure in compare would kick out the per-side judgements, even though they succeeded.
- Replay debugging: each tool's artifacts dir is the natural unit of replay; combining them loses that locality.

### 2. Fast mode as default; deep mode opt-in

The "cheap by default" framing. Rejected because:

- Anchoring bias is silent — users don't know they got worse data unless they bother to A/B test the modes themselves. Defaulting to the worse mode is a footgun.
- Commercial users prioritise quality over cost; the absolute cost delta is small.
- Easier to opt out of a quality default ("I'm running 100 of these, switch to fast") than to opt into it after a misleading comparison shipped.

### 3. Reuse `runCritic` from `src/core/critic.ts`

`runCritic` already takes a screenshot and a persona/scenario and emits `VisionVerdict`. Reusing it would save code. Rejected because:

- `runCritic` is persona × scenario × dimension-list scoring — its dimensions come from `scenario.scoring_dimensions`, which is a runtime YAML. Judge wants rubrics defined as **data**, not parsed from scenario YAML.
- `runCritic`'s prompt enumerates persona "critical concerns" in the system message, which contaminates rubric scoring with persona narrative.
- Decoupling judge from scenarios means it can be invoked without project setup (no `personas/` dir, no `scenarios/`), which is the whole point of a primitive.

We *did* borrow runCritic's anti-hallucination rules verbatim — they're the part of the prompt that has been calibrated against real outputs and shouldn't be reinvented.

### 4. Hard-coded rubrics in the prompt (no rubric modules)

We could put the aesthetic + dark-pattern rubric text directly into `judge.ts`. Rejected because:

- Rubric ids are part of the public contract: consumers cite them in CompareResult.per_criterion. Putting them in prompt strings makes them prone to drift.
- Custom criteria *must* be reified data (caller passes `{id, label, description}`), so we already need the data shape; the built-ins should match.
- Future v1.x rubrics (accessibility-first, mobile-first, e-commerce conversion, …) are pure data additions when rubrics are modules; would be a prompt rewrite otherwise.

### 5. Inline base64 screenshots in CompareResult

For wire convenience. Rejected because:

- 33% size inflation per screenshot (M9-2 design principle).
- Two screenshots per compare result × maxTokens limits causes truncation.
- File-on-disk is the natural replay unit.

### 6. JSON-Schema-coercion for `customCriteria` on the wire

Same path as `extract`'s schema input. Rejected because:

- Custom criteria are 3 strings (`id`, `label`, `description`); the validation surface is trivial. A full JSON Schema parse would be over-engineering.
- Keeping the input flat means `judge`'s inputSchema is straightforward to read in tools/list.

### 7. Reject the model's `overall_winner` if it doesn't match majority of `per_criterion` winners

The strict-consistency rule. Rejected because:

- The synthesis prompt explicitly tells the model to break ties using qualitative judgement (depth of an A win vs B win). Forcing strict majority would punish nuanced verdicts (e.g. A wins on 5 minor criteria, B wins on 1 critical safety criterion).
- We *do* fall back to majority winner when `overall_winner` is missing or invalid; that's enough defensive parsing.

### 8. Per-side custom criteria

Different criteria for side A vs side B. Rejected because:

- Comparison only makes sense when both sides are scored on the same axes. Per-side criteria turn `compare` into "two solo judgements stitched together", which is what calling `judge` twice already gives you.
- Enables a bad UX where the AI silently drops criteria not present in one side's rubric.

## Consequences

### Good

- **Closes the v1 primitive kit's judgement gap** — aesthetic and dark-pattern are the two most common questions Wayne (and AI agents) want to ask about a page.
- **Anchoring-bias-free comparisons** — by default, score absolutes are clean. Users who hit the cost bound can opt out.
- **Cacheable per-side judgements** — a future M9-4 result cache can reuse a `judge` result across many `compare` calls (e.g. compare URL X against 10 alternatives → 1+10 judges, not 11×2).
- **Rubric extensibility** — adding a new built-in rubric (e.g. accessibility-first) is a pure data addition, no prompt rewriting.
- **Custom criteria** — callers can compose ad-hoc rubrics for one-off questions ("How well does this page explain the upgrade path?") without fork-modifying the codebase.
- **Composability** — `judge` and `compare` chain with `see` (capture once, judge many times) and `extract` (use extracted data as context for a custom criterion).

### Trade-offs

- **More LLM cost in default mode** — 3 vision calls per compare. Mitigated by per-side judge caching (M9-4) and `mode: "fast"` opt-out.
- **No partial-success in compare** — if either judge fails in double-blind mode, the whole compare returns `status="error"`. We explicitly chose this over a "compare ran but with one missing side" semi-failure that AI agents would have to special-case.
- **Defensive coercion** drops malformed model output silently (with logger warnings). Net cost: an LLM that gets the schema slightly wrong loses information; net gain: never a malformed CompareResult on the wire.

### Carry-forward

- **M9-4 result cache** should treat `judge(url, rubrics, customCriteria)` as a cacheable triple. `compare` would then re-use cache hits transparently.
- **M8-3 AI critic reasoning visible** is a natural extension — surface the rubric description in the verdict's UI (already in `result.criteria`).
- **Rubric pluralism** — future v1.x can add `accessibility`, `mobile_first`, `e_commerce_conversion` rubrics as new modules with no API change.

## References

- Brignull, H., "Deceptive design taxonomy", https://www.deceptive.design/types
- Norwegian Consumer Council, "Deceived by Design" (2018)
- Bansal et al., "On the Effects of Anchoring on Side-by-Side Evaluation", 2024
- Nielsen Norman Group, "Comparison-Based UX Evaluation" methodology guides
- Baymard Institute, e-commerce UX benchmarks

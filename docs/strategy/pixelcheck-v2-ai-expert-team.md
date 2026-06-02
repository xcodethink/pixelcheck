# PixelCheck v2 — AI Expert Team Infrastructure

> From "real eyes and hands for your AI agent" to "real eyes, hands, **and a senior expert team** for your AI agent."

| | |
|---|---|
| **Status** | Strategy anchor — v0.1 draft (pre-PRD) |
| **Date** | 2026-05-24 |
| **Author** | Wayne (@WayLimX) with Claude Opus 4.7 |
| **Document type** | Strategy anchor — locks v2 direction; precedes ADRs, PRDs, and Phase 1 validation work |
| **Current product version** | PixelCheck v1.2.1 (npm) — frozen baseline this document references |
| **Related docs** | [`README.md`](../../README.md) · [`docs/architecture.md`](../architecture.md) · [`docs/commercial-audit-2026-05-11.md`](../commercial-audit-2026-05-11.md) · [`docs/writing-personas.md`](../writing-personas.md) · [`docs/writing-scenarios.md`](../writing-scenarios.md) · [`docs/decisions/`](../decisions/) · [`docs/releases/`](../releases/) |

---

## Table of Contents

1. [Vision — From AI UX Auditor to AI Expert Team](#1-vision)
2. [Current State Audit — PixelCheck v1.2.1 Capability Map](#2-current-state-audit)
3. [v2 Architecture — The Five-Layer Expert Team Model](#3-v2-architecture)
4. [Five Components Detailed Design](#4-five-components-detailed-design)
5. [Four-Phase Roadmap](#5-four-phase-roadmap) *(written in second half)*
6. [Strategic Alignment](#6-strategic-alignment) *(written in second half)*
7. [Risks & Decision Points](#7-risks--decision-points) *(written in second half)*
8. [Appendix — Inventory + 5 Expert Persona Drafts + finance_terminal Rubric Draft](#8-appendix) *(written in second half)*

---

<a id="1-vision"></a>

## 1. Vision — From "AI UX Auditor" to "AI Expert Team Infrastructure"

### 1.1 The current frame (PixelCheck v1)

PixelCheck v1 owns a sharp, defensible frame:

> **"Real eyes and hands for the AI agent that's writing your frontend."**

Five primitives (`see` / `act` / `extract` / `judge` / `compare`) + 2 presets (`diagnose` / `audit_url` / `explore_url`) + 18 user-perspective personas across 15 countries. Ships as a drop-in MCP server. Local-first, vendor-agnostic, MIT-licensed, $0 telemetry. v1.2.1 is in npm with 2158 tests, 30 published schemas, 29 ADRs.

The v1 narrative answers one question: **"Your AI agent is blind. We give it eyes."**

### 1.2 The bigger frame this product has stumbled into

A real workflow story Wayne has lived dozens of times:

> Wayne is building ShineFIN, a personal investing platform with hundreds of dashboard sections. Claude Code (local) opens ShineFIN, writes a "Sector Overview" page, ships it. It looks demo-grade — every font size identical, washed-out colors, no professional indicators.
>
> Wayne screenshots the page, opens claude.ai in a browser tab, and pastes the image. Claude responds with a senior-grade review: *"A 30-year Wall Street trader expects zero-axis-centered diverging bars, an A/D ratio column, sector-relative-to-SPY percentage, data-freshness badges with explicit timestamp and source, market-status pill, an equal-weight vs cap-weight toggle, and 4 levels of typographic hierarchy. Yours has none of these. Here is a rebuild."*
>
> Wayne forwards the response back to Claude Code. Same model, different output: a professional-grade rebuild ships.

**Why did the same model produce two dramatically different qualities?**

Same weights. Same training. Different **framing**:

- Call 1 was *"make a page."* The model defaulted to generic SaaS dashboard conventions.
- Call 2 was *"evaluate this page as a 30-year Wall Street trader."* The model conditioned on a domain expert role and surfaced standards that don't appear in generic UX libraries.

**The lesson**: Role-conditioned evaluation produces dramatically better output than role-naive generation, *even from the same model with the same weights*. The bottleneck is not model capability; it is the lack of a persistent, opinionated, peer-reviewed **expert role layer** in the workflow.

The screenshot → browser → paste loop is unscalable. Wayne has hundreds of sections across multiple projects. Each one deserves a senior-grade review. He cannot be the messenger.

### 1.3 The v2 frame

```
v1: Give your AI agent eyes.
v2: Give your AI agent eyes — and a senior expert team to review what it sees.
```

The product evolution, side by side:

| | **PixelCheck v1.2.1** | **PixelCheck v2** |
|---|---|---|
| **Positioning** | AI UX auditor for any URL | AI Expert Team Infrastructure for any project |
| **Persona library** | 18 user-perspective personas | + N expert-perspective personas per domain (finance / health / anti-scam / e-commerce / SaaS …) |
| **Rubric library** | Generic (aesthetic, dark_pattern) + custom escape hatch | + Curated, versioned domain rubrics (`finance_terminal`, `medical_clinical`, `anti_scam_ux` …) |
| **Comparison primitive** | `compare` — A vs B URLs | + `judge_panel` — one URL judged by N expert personas, adversarial synthesis |
| **Learning loop** | `calibrate_critic` from labeled fixtures (input-side) | + Reverse learning: production-issue → backfill rubric criterion → re-calibrate (output-side) |
| **Trigger model** | MCP available, operator-invoked | + Hook integration: AI-agent code-change events auto-trigger expert panel review |
| **Workflow position** | After "I want to audit X" | Before, during, and after every AI-driven UI change |

**v2 is not a feature pivot. It is a layer-up.** Every v1 capability stays. v2 builds an "expert team" abstraction layer **on top of** v1's primitives. Backwards compatibility is total.

### 1.4 Why now (the 2026 timing)

Three forces converging:

1. **AI agent generation is the default.** Claude Code, Cursor, Cline, Windsurf, Continue, Zed — every major IDE-coupled agent ships frontend code. The bottleneck has shifted from "can it generate" to "can it generate at professional quality." The market has moved past speed to quality.

2. **Domain quality is the gap nobody is filling.** Generic UX auditing exists (Lighthouse, axe, WAVE). Generic design systems exist (shadcn, MUI, Mantine). What does *not* exist: **on-demand domain expert review as a developer primitive.** No-one offers "a 30-year Wall Street trader as a service" you can drop into a CI step. That is the v2 opening.

3. **Anthropic's Agent SDK and subagent ecosystem is opening up.** "Configure a local expert team for your project" lands directly inside Anthropic's thesis about composable agents. PixelCheck v2 becomes a textbook reference implementation — strengthening Wayne's stated narrative goal (*"used by Claude Code, built by Claude Code"*, see [`memory/feedback_pixelcheck_positioning.md`](../../../../.claude/projects/-Users-wayne-Developer-OpenTools/memory/feedback_pixelcheck_positioning.md)).

### 1.5 Scope of this document

**This document IS** a *strategy anchor*: it locks the v2 direction, names the 5 components, sequences the 4 phases, identifies the decision points the team must resolve before building. Once approved, all subsequent v2 work — ADRs, PRDs, schemas, Phase 1 validation — derives from this anchor and cites it.

**This document is NOT** a PRD (no API specs, no acceptance criteria, no tests), nor a technical design doc (no code, no schema diffs, no SQL). Both come **after** Phase 1 validation confirms the direction holds against real ShineFIN pages.

**This document does NOT bind** the team to a specific Phase 2+ implementation. Phases 2–4 may pivot based on Phase 1 findings.

---

<a id="2-current-state-audit"></a>

## 2. Current State Audit — PixelCheck v1.2.1 Capability Map

Snapshot date: 2026-05-24. Source: `list_capabilities` MCP introspection + filesystem inventory + existing docs.

### 2.1 Primitives & Presets (the v1 toolkit)

| Tool | Kind | Cost (typical) | Cacheable | One-line | v2 disposition |
|---|---|---|---|---|---|
| `see` | primitive | $0–0.005 | yes | DOM + screenshot + console + optional vision note | **Reuse as-is** |
| `act` | primitive | $0.01 / step | no | Multi-step navigation; auto-selects Playwright vs Stagehand | **Reuse as-is** |
| `extract` | primitive | $0.02 | yes | JSON-schema-bound structured extraction via Stagehand | **Reuse as-is** |
| `judge` | primitive | $0.02 | yes | Single-page rubric review (aesthetic 8 + dark_pattern 12 + custom) | **Core v2 primitive — rubric library extends** |
| `compare` | primitive | $0.06 | partial | A/B URL comparison; double-blind 3-vision-call (anti-anchoring) | **Methodology reused for `judge_panel`** |
| `diagnose` | preset | $0.03 | yes | Holistic health: Core Web Vitals + WCAG + OWASP + GDPR + 0-100 score | **Reuse + composes into Phase 1 expert reports** |
| `audit_url` | preset | $0.30 | no | Full pipeline: navigation + scenario + critic + reporter | **Reuse — persona library extends** |
| `explore_url` | preset | $0.15 | no | Autonomous agent with free-form goal + replanning | **Reuse as-is** |

**Conclusion**: All 8 user-facing tools are kept. v2 adds **one** new tool (`judge_panel`) and **extends** two libraries (`personas/`, `rubrics/`).

### 2.2 Meta & Infrastructure (the v2 leverage)

| Component | What it is | Why it matters for v2 |
|---|---|---|
| `list_personas` | Persona registry meta tool | v2 extends to surface a `kind` field (user / expert) |
| `list_scenarios` | Scenario registry meta tool | v2 extends to surface expert-review scenarios |
| `calibrate_critic` | Critic calibration from labeled fixtures (input-side) | v2 pairs with output-side reverse learning |
| `get_last_report` | Reads `reports/history.db` | Reverse-learning backfill reads from here |
| **Reports history DB** | Persistent SQLite (`AUDIT_REPORTS_DIR/history.db`) | Foundation for cross-time learning |
| **Agent memory store** | Persistent SQLite (`AUDIT_MEMORY_PATH`) | Foundation for per-persona long-memory |
| **Plan cache** | Persistent SQLite (`AUDIT_PLAN_CACHE_PATH`) | Foundation for scenario reuse |
| **Result cache (M9-4)** | 24h cache, key-aware (`AUDIT_RESULT_CACHE_PATH`) | Cost control — essential for panel mode |
| **Cost guard** | Per-run $5, per-day $50 caps + JSON ledger | Cost control — essential for panel mode |
| **MCP server** | stdio transport, 30 published schemas | v2 inherits cross-tool reach for free |

**Conclusion**: PixelCheck has already built the persistence, calibration, and cost-control infrastructure v2 needs. **v2 is mostly a library + composition layer, not a platform rewrite.**

### 2.3 Persona library (the v1 voice cast)

18 personas covering 15 countries, 18 languages/locales, 7 device classes, 4 payment tiers — **all user-perspective** (i.e., the people the audited product is built for):

| Persona ID | Display | Country | Lang | Device | Tier |
|---|---|---|---|---|---|
| `us-english-free-mobile` | Sarah, 32, NYC paralegal | US | English | iPhone 15 Pro | free |
| `us-english-senior-tablet` | Dorothy, 72, retired teacher | US | English | iPad 10 | free |
| `jp-japanese-pro-desktop` | 田中花子, 35, Tokyo housewife | JP | 日本語 | MBP | pro |
| `de-german-power-tablet` | Klaus, 48, Munich compliance officer | DE | Deutsch | iPad Pro | power |
| `sa-arabic-pro-mobile` | Ahmed, 38, Riyadh business owner | SA | العربية | iPhone 15 | pro |
| `cn-chinese-free-mobile` | 王伟, 28, 深圳 程序员 | CN | 简体中文 | Galaxy S24 | free |
| `tw-chinese-pro-tablet` | 林雅婷, 39, Taipei compliance manager | TW | 繁體中文 | iPad Air M2 | pro |
| `uk-english-power-desktop` | James, 36, London security analyst | UK | English | ThinkPad X1 | power |
| `kr-korean-pro-desktop` | 김지수, 31, Seoul crypto trader | KR | 한국어 | Samsung+Win | pro |
| *(9 more)* | | | | | |

**Persona schema** (from [`docs/writing-personas.md`](../writing-personas.md)): `id` · `display_name` · `country` · `language` · `locale` · `timezone` · `device_class` · `ua_class` · `viewport` · `payment_tier` · `mental_model` · `critical_concerns` · `test_credentials`.

**Critical observation for v2**: Every field encodes *"what kind of user will encounter this product."* No field encodes *"what kind of expert will evaluate this product."* `mental_model` describes user goals and fears; it does not describe professional standards or industry conventions. `critical_concerns` lists user pain points; it does not list reviewer red flags.

**This is the precise gap v2 closes.** v2 introduces a parallel persona kind — `expert` — with its own field set (see §4.1).

### 2.4 Rubric library (the v1 evaluation criteria)

Two built-in rubrics shipped with `judge`:

- **`aesthetic`** (8 criteria) — visual hierarchy · typography · alignment · contrast · spacing · polish · density · brand cohesion
- **`dark_pattern`** (12 criteria) — forced continuity · hidden costs · pre-selected options · fake urgency · confirmshaming · obstruction · misdirection · trick questions · disguised ads · bait & switch · privacy zuckering · nagging

Plus `custom_criteria[]` — per-call ad-hoc rubric escape hatch.

**Critical observation for v2**: Both built-in rubrics are deliberately **domain-agnostic**. There is no `finance_terminal` rubric checking for data-source badges, freshness timestamps, zero-axis bars, sector grouping conventions, A/D ratio columns. There is no `medical_clinical` rubric checking for HIPAA-aligned UX, dosage formatting, contraindication warnings. There is no `anti_scam_ux` rubric for trust signal placement, red-flag highlighting, escape-path clarity.

`custom_criteria` is the escape hatch — but every adopter has to invent their own. There is no curated, versioned, peer-reviewed **domain rubric library**.

**This is the second gap v2 closes.** v2 ships `rubrics/domain/<vertical>.yaml` with explicit versioning and changelog (see §4.2).

### 2.5 Baselines & scenarios

- `baselines/` — 59 entries (reference snapshots, likely visual-regression fixtures)
- `scenarios/` — present but `list_scenarios` failed during this audit due to a permission stream issue; not blocking the strategy anchor

### 2.6 Engineering & governance (from `commercial-audit-2026-05-11.md`)

- TypeScript strict mode, 2158 tests passing, statements coverage 80.89%
- 30 published JSON schemas under [`docs/schemas/`](../schemas/)
- 29 ADRs under [`docs/decisions/`](../decisions/), latest being ADR-034 (Phase 0 entrypoint pattern, used by `diagnose`)
- SBOM workflow, license allowlist, Dependabot, Renovate-style hygiene
- Privacy-first: 100% local, no telemetry, opt-in consent, MIT
- A pre-existing v1.x Wave 2 roadmap (multi-provider abstraction: OpenAI / Gemini / Ollama-local) — **v2 does not conflict with it; v2 runs in parallel and benefits from it (more model choices = more expert-persona deployment surface)**
- Outstanding commercial-readiness gaps identified in the May 11 audit (non-TTY consent, `audit_url`/`explore_url` URL-guard, Node 18 + Windows CI gates, SBOM `--ignore-npm-errors`) — **v2 work must not regress any of these; ideally v2 ADRs close some of them**

**Conclusion**: PixelCheck has the ADR discipline, schema discipline, test discipline, and privacy posture to support v2 without an engineering rewrite. The v2 work is mostly **data** (personas, rubrics, baselines) and **composition** (judge_panel, hook integration, reverse learning), not platform.

### 2.7 v1.2.1 capability summary in one sentence

PixelCheck v1.2.1 is a production-grade local-first MCP server with 8 vision-aware browser tools, 18 user-perspective personas across 15 countries, 2 built-in domain-agnostic rubrics + custom escape hatch, calibration tooling, hard cost guards, persistent memory/cache/reports, and full observability — but its persona and rubric libraries are deliberately generic, and review is operator-triggered rather than workflow-embedded. **v2 closes both gaps without rewriting any of the above.**

---

<a id="3-v2-architecture"></a>

## 3. v2 Architecture — The Five-Layer Expert Team Model

v2 introduces a vertical 5-layer abstraction on top of v1's primitives. Each layer corresponds to **one** of the five new components (detailed in §4). Each layer is independently shippable and independently valuable.

```
                            ┌─────────────────────────────────────────────────┐
   Layer 5  Reverse          │  L5 — Reverse-Learning Automation              │
            learning         │  Prod issues → backfill rubric → re-calibrate  │
                            └────────────────────┬────────────────────────────┘
                                                 │ feeds                          
                            ┌────────────────────▼────────────────────────────┐
   Layer 4  Workflow         │  L4 — Hook Integration                          │
            embedding        │  AI-agent code-change events trigger panel review│
                            └────────────────────┬────────────────────────────┘
                                                 │ invokes                        
                            ┌────────────────────▼────────────────────────────┐
   Layer 3  Adversarial      │  L3 — judge_panel (multi-expert review)         │
            review           │  One URL × N experts × M rubrics → synthesis    │
                            └────────────────────┬────────────────────────────┘
                                                 │ composes                       
                            ┌────────────────────▼────────────────────────────┐
   Layer 2  Domain           │  L2 — Domain Rubric Library                     │
            knowledge        │  finance_terminal, medical_clinical, anti_scam_ux│
                            └────────────────────┬────────────────────────────┘
                                                 │ scores against               
                            ┌────────────────────▼────────────────────────────┐
   Layer 1  Expert           │  L1 — Expert-Perspective Persona Library        │
            voice            │  wallstreet-trader-30y, sell-side-analyst, …   │
                            └────────────────────┬────────────────────────────┘
                                                 │ extends                        
                            ┌────────────────────▼────────────────────────────┐
   v1.2.1   Foundation       │  PixelCheck v1.2.1 — see/act/extract/judge/    │
                            │  compare/diagnose/audit_url/explore_url +       │
                            │  18 user personas + cost guard + caches + ADRs  │
                            └─────────────────────────────────────────────────┘
```

### 3.1 Layer design principles

1. **Backwards compatible from L1 to L5.** Nothing in v1.2.1 changes semantics. All v2 additions are pure additions or extensions of existing meta surfaces (e.g., `kind` field on persona schema with default `"user"`).
2. **Each layer ships independently.** L1 (expert personas) is valuable even without L2. L2 (domain rubrics) is valuable even without L3. The dependency order is build-time only — at runtime, an adopter can mix v1 personas with v2 rubrics, or v2 personas with v1 rubrics.
3. **Each layer is data-first, code-second.** L1 and L2 are pure YAML expansions. L3 is one new tool. L4 is one Hook integration recipe. L5 is one script that closes the loop. **The total new TypeScript surface in v2 is small.**
4. **Domain neutrality preserved at the framework level.** v2 does not bake "finance" into the core. Finance is the *first* curated vertical because Wayne's day-1 use case (ShineFIN) is finance. The framework supports arbitrary verticals; the library starts with five (finance, anti-scam, medical, e-commerce, SaaS).
5. **Cost-aware by default.** Every L3 panel call honors v1's cost guard. Default panel size capped at 4 experts. L4 Hook triggers default to "preview-mode" — local small-model pre-screen before any Claude vision call (see §7.1 decision points).
6. **Privacy & local-first preserved.** v2 adds no telemetry, no remote storage, no SaaS sign-up. Expert personas, domain rubrics, baselines all live in the adopter's repo.

### 3.2 How the layers map to existing PixelCheck files

| Layer | New paths added under PixelCheck repo | Existing paths extended |
|---|---|---|
| L1 | `personas/professional/<vertical>/<persona-id>.yaml` | `docs/writing-personas.md` (add `kind: expert` section); `list_personas` (return `kind`) |
| L2 | `rubrics/domain/<vertical>.yaml` + `rubrics/domain/<vertical>.changelog.md` | `judge` tool input schema (accept `rubrics: ['finance_terminal']` etc.); new doc `docs/writing-rubrics.md` |
| L3 | `src/mcp/tools/judge-panel.ts` + `src/core/panel-synthesis.ts` + tests + `docs/schemas/JudgePanelResult.json` | `list_capabilities` (one new tool entry) |
| L4 | `integration/claude-code-hook/` (recipe + example settings + small-model pre-screen) | none |
| L5 | `scripts/reverse-learn/` (CLI) + `src/core/rubric-backfill.ts` | `calibrate_critic` (compose with backfill output); `reports/history.db` (read-only consumer) |

**Net new source files**: ~10 (one tool, one core module, one CLI, plus tests + schemas + docs). **Net new YAML data files (initial)**: ~25 (5 expert personas × 5 verticals, plus 5 domain rubrics). **Net new infra**: 0 (reuses cost guard, caches, memory, reports DB, MCP transport).

### 3.3 What v2 does NOT do

- v2 does **not** introduce a new LLM provider. (v1.x Wave 2 — multi-provider abstraction — is independent and parallel.)
- v2 does **not** require a backend service. PixelCheck remains 100% local-first.
- v2 does **not** modify any existing tool's input schema in a breaking way. `judge` gains accepted rubric IDs; `audit_url` gains accepted persona kinds. Old calls continue to work.
- v2 does **not** ship a SaaS-style "expert marketplace." The expert library is a curated MIT-licensed YAML collection in the repo; community contribution is via standard PR.
- v2 does **not** depend on Anthropic-specific features. Every v2 component works against any vision-capable model the underlying `judge` / `compare` toolchain supports.

---

<a id="4-five-components-detailed-design"></a>

## 4. Five Components Detailed Design

Each component is sized to one ADR + one PRD + one Phase milestone. Order is build-dependency order, not necessarily ship order (L1 + L2 can ship as v1.3.0; L3 as v1.4.0; L4 + L5 as v2.0.0).

### 4.1 Component 1 — Expert-Perspective Persona Library (L1)

**Purpose**: Introduce a parallel persona class whose `mental_model` and `critical_concerns` encode *professional review standards*, not user goals.

**Schema extension** (additive, non-breaking):

```yaml
# Existing user persona keeps all current fields; gains optional `kind: user` (default).
# New expert persona:
kind: expert                                # NEW — required; "user" (default) or "expert"
id: wallstreet-trader-30y                   # existing — kebab-case, unique
display_name: "Marcus Chen, 30y Wall St trader (sell-side equity)"
                                           # existing
expertise_domain: finance                   # NEW — vertical key, must match a rubrics/domain/<vertical>.yaml
expertise_years: 30                         # NEW — integer
background: |                               # NEW — free-text career summary fed to the critic
  Started at Salomon Brothers cash equities desk 1996; moved to Goldman Sachs
  equity prop 2004; ran a long/short equities pod at Citadel 2011–2021. Now
  semi-retired, consults for fintechs on professional-trader UX standards.
                                            # The critic uses this verbatim when conditioning.
evaluation_lens: |                          # NEW — replaces user persona's mental_model field for experts
  Reads dashboards the way a trading-desk professional reads a Bloomberg
  terminal: information density first, hierarchy second, aesthetics third.
  Will instantly flag missing data-freshness timestamps, missing data-source
  attribution, washed-out diverging-bar contrast, and ambiguous units.
red_flags:                                  # NEW — array of professional violations; drive issue severity
  - "No 'as-of' timestamp on any time-series view"
  - "Diverging bars not centered on zero axis"
  - "Sector or factor exposure shown without a comparison benchmark"
  - "Currency or unit not labeled on any numeric column"
  - "Color used as the only encoding for up/down (accessibility + colorblind violation)"
preferred_baselines:                        # NEW — references baselines/ entries the critic may cite
  - bloomberg-terminal-equity-des
  - tradingview-pro-watchlist
  - factset-portfolio-attribution
cite_standards:                             # NEW — optional list of industry standards the persona authoritatively cites
  - SIFMA market-data display conventions
  - CFA Institute presentation standards (GIPS)
# Fields explicitly NOT used by expert personas (so the runtime can skip them):
# country, language, locale, timezone, viewport, payment_tier, ua_class, mental_model,
# critical_concerns, test_credentials, proxy_env.
```

**Runtime behavior**:
- `judge` / `audit_url` / `judge_panel` accept either `kind`. When persona is `kind: expert`, the critic prompt is conditioned on `background` + `evaluation_lens` + `red_flags` instead of `mental_model` + `critical_concerns`.
- The browser-fingerprint layer ignores expert personas (no viewport / locale / timezone needed — the expert is the *reviewer*, not the simulated user). Default 1440×900 desktop capture is used.
- Cost identical to user-persona `judge` call: $0.02 per criterion-set.

**Initial library shipped with v2.0.0** (full drafts in §8.2): 5 personas × 5 verticals = 25 personas.

**Open question deferred to PRD**: Should expert personas be in `personas/professional/` (subdir under existing) or `experts/` (sibling)? Anchor stance: **subdir** (`personas/professional/<vertical>/<id>.yaml`), to keep `list_personas` as a single source of truth and let `kind` filter at the API surface. Final call in ADR-035.

### 4.2 Component 2 — Domain Rubric Library (L2)

**Purpose**: Ship curated, versioned, peer-reviewed rubric YAMLs for high-value verticals, so adopters get senior-grade evaluation without inventing `custom_criteria` from scratch.

**Schema**:

```yaml
# rubrics/domain/finance_terminal.yaml
id: finance_terminal
version: 0.1.0                              # SemVer — rubric changes are tracked
label: "Professional Finance Terminal UX"
applies_to:                                 # Hints; not enforced
  - sector dashboards
  - equity / fund / ETF detail pages
  - watchlists / portfolios / heatmaps
  - factor / attribution / risk views
authoritative_baselines:                    # baselines/ entries the rubric leans on
  - bloomberg-terminal-equity-des
  - tradingview-pro-watchlist
  - factset-portfolio-attribution
  - snowball-pro-cn-equity
criteria:
  - id: data_freshness_visible
    label: "Data-freshness timestamp visible on every time-series view"
    description: |
      Every view that displays time-series or quote data must show an explicit
      "as of <timestamp> <timezone>" indicator, plus a market-status pill
      (Open / Closed / Pre / Post). Pages may not display data without this
      attribution. WCAG-compliant text-equivalent required for any iconography.
    severity_on_violation: critical          # critical | major | minor
    evidence_required: true                  # critic must cite a screen location
  - id: data_source_attribution
    label: "Each data point carries a source citation"
    severity_on_violation: major
    description: "..."
  - id: zero_axis_diverging_bars
    label: "Diverging (up/down) bars are centered on the zero axis"
    severity_on_violation: major
    description: "..."
  # ... 8–14 more criteria per rubric (full draft in §8.3) ...
changelog_file: finance_terminal.changelog.md
```

**Library shipped with v2.0.0** (rubric drafts in §8.3 for finance; others sketched):

| Rubric ID | Vertical | Approx. criteria count | First-author persona |
|---|---|---|---|
| `finance_terminal` | Finance investing terminal | 12 | `wallstreet-trader-30y` |
| `finance_research_report` | Sell-side research report | 10 | `sell-side-research-analyst` |
| `anti_scam_ux` | Anti-scam consumer UX | 11 | `anti-scam-investigator` (reuses [`ScamLens`](https://github.com/wayne/scamlens) standards) |
| `medical_clinical` | Clinical decision support | 13 | `er-physician-evidence-based` |
| `ecommerce_checkout` | E-commerce checkout flow | 9 | `cro-checkout-specialist` |

**Versioning rule**: Adding a criterion is a minor bump. Removing or tightening a criterion is a major bump. Each rubric carries a `changelog.md` sibling file.

**Reverse-learning ingest path (L5)** writes new criteria as `proposed: true` with a comment block referencing the production issue ID — they require human review (a PR merge) before they become `proposed: false` and count.

### 4.3 Component 3 — `judge_panel` (L3, multi-expert adversarial review)

**Purpose**: Run one URL through N expert personas + M rubrics in parallel, then synthesize a single adversarial verdict that surfaces consensus, splits, and dissent. The same anti-anchoring methodology PixelCheck v1's `compare` uses for double-blind A/B, applied to multi-perspective single-URL review.

**Input schema** (sketch — final in ADR-036):

```yaml
url: https://shinefin.app/sector-overview
panel:                                      # 2–4 experts; >4 needs --override flag
  - persona: wallstreet-trader-30y
    rubrics: [finance_terminal]
  - persona: sell-side-research-analyst
    rubrics: [finance_terminal, finance_research_report]
  - persona: financial-ui-designer-bloomberg
    rubrics: [finance_terminal]
mode: double_blind                          # double_blind (default) | fast
budget_usd: 0.50                            # honored by cost guard
synthesis_model: claude-sonnet-4-6          # synthesis call model (independent of per-expert critic)
```

**Output schema** (sketch):

```yaml
overall_verdict: needs_work                 # ship | needs_work | red
overall_score: 0.62                         # weighted across experts × rubrics
per_expert:
  - persona: wallstreet-trader-30y
    score: 0.58
    findings: [...]                         # severity-graded, with evidence
  - persona: sell-side-research-analyst
    score: 0.65
    findings: [...]
  - ...
consensus_findings:                         # ≥ 2 experts flagged same issue
  - finding: "No data-freshness timestamp anywhere on the page"
    flagged_by: [wallstreet-trader-30y, sell-side-research-analyst, financial-ui-designer-bloomberg]
    severity: critical
disputed_findings:                          # only 1 expert flagged it; included for transparency
  - finding: "Sector ETF ticker prefix could be smaller"
    flagged_by: [financial-ui-designer-bloomberg]
    severity: minor
synthesis_note: |                           # one-paragraph adversarial summary
  All three reviewers converge on missing data freshness/source attribution
  as the critical gap. The trader and the analyst additionally flag absence
  of A/D and sector-vs-SPY comparison columns. UI designer is alone in
  flagging tiny micro-typography issues. Recommend addressing the consensus
  findings before ship; defer disputed findings to v-next.
```

**Cost model**: N experts × judge cost + 1 synthesis call. For N=3 and double_blind: 3 × $0.02 + 1 × $0.03 = $0.09 per panel. Hard-capped by `budget_usd`.

**Caching**: per-expert `judge` calls reuse v1's M9-4 cache. Synthesis call is NOT cached (cheap, and panel composition changes invalidate it).

### 4.4 Component 4 — Hook Integration (L4, workflow embedding)

**Purpose**: Make the expert panel run **automatically** at the right moments in an AI-agent-driven workflow, so quality is enforced rather than remembered.

**Integration target**: Claude Code Hooks (`settings.json` `hooks` block; see [Claude Code docs](https://docs.claude.com/en/docs/claude-code/hooks)). Cursor / Cline / Continue have analogous extension points — recipe ships for Claude Code first, others added as the ecosystem matures.

**Trigger pattern**:

```
PostToolUse  on  Edit | Write | MultiEdit  
              where  changed_file matches *.tsx | *.jsx | *.vue | *.svelte | *.html
              and    project has .pixelcheck-team.yaml
            → run  pixelcheck-team-screen <changed_files>
```

**`pixelcheck-team-screen` script flow**:

```
1. Read project-local .pixelcheck-team.yaml (which panel for this project)
2. Local-small-model pre-screen (free):
   - Did this edit even change rendered output? (AST/CSS diff)
   - Does it touch a route surfaced in the project's review map?
   - If both no → exit 0 silently
3. Spin up local dev server (or reuse if running)
4. Playwright-snapshot affected route(s) via see (free, no LLM)
5. Diff vs last baseline snapshot stored in .pixelcheck/baselines/
   - If pixel diff < threshold AND no DOM-tree-shape change → exit 0
6. Invoke judge_panel with project's configured panel
7. Write findings to .pixelcheck/findings/<route>.md
8. Print one-line summary + path to Claude Code's stdout (visible to the agent)
9. If consensus severity == critical → exit non-zero (blocks the next Edit until reviewed)
```

**`.pixelcheck-team.yaml`** lives at the adopter's project root:

```yaml
project: shinefin
verticals: [finance]
panel_default:
  - persona: wallstreet-trader-30y
    rubrics: [finance_terminal]
  - persona: financial-ui-designer-bloomberg
    rubrics: [finance_terminal]
panel_overrides:                            # per-route customization
  - route_glob: /research/*
    panel:
      - persona: sell-side-research-analyst
        rubrics: [finance_research_report]
budget_per_screen_usd: 0.20
block_on_critical: true                     # exit non-zero when consensus = critical
```

**Cost discipline**: The pre-screen + diff steps are free. A panel only fires when the route truly changed visually. For a typical AI-agent session editing 5 files affecting 1 route, expected cost is one panel call (~$0.10) per save-cycle. Daily $50 cost-guard limit unchanged.

**Failure modes & escape hatches**:
- Dev server not running → script exits 0 with a "skip: dev server unreachable" note (no false-block).
- LLM provider down → script exits 0 with a "skip: panel unavailable" note. The agent is informed; the developer is not blocked.
- Budget exhausted → script exits 0 with a "skip: budget cap reached" note.
- Adopter wants to silence panels for an edit → environment variable `PIXELCHECK_TEAM_SKIP=1` for the next invocation.

### 4.5 Component 5 — Reverse-Learning Automation (L5)

**Purpose**: When a production issue is found that the expert panel *should have* flagged but didn't, close the loop automatically — propose a rubric criterion that would have caught it, run `calibrate_critic` against historical fixtures to verify it doesn't introduce false positives, then queue a PR for human merge.

**Input**: A production issue reference. Three accepted shapes (script auto-detects):
- A failing test in CI ("here is the screenshot, here is what was wrong")
- A user-reported issue with a screenshot + description
- A Claude Code conversation transcript where the developer overrode a panel verdict

**Flow**:

```
1. Take input → ingest into reverse-learn/issues/<id>/
   - screenshot.png
   - description.md (the "what was wrong" text)
   - url, route, edit_sha if available
2. Find the matching panel run (if any) in reports/history.db
   - If panel was run and missed it: this is a true reverse-learning case
   - If panel was never run: this is a "expand coverage" case (different handling)
3. LLM-driven criterion proposal:
   - Given (screenshot, description, current rubric YAML, miss case),
     propose a new criterion (id, label, description, severity, evidence_required)
   - LLM call: ~$0.02
4. Write proposed criterion to rubrics/domain/<vertical>.yaml as `proposed: true`,
   add provenance block citing the issue id
5. Run calibrate_critic against existing labeled fixtures
   - If new criterion fires on any "known-good" fixture above threshold → FALSE POSITIVE; flag for human review
   - If new criterion fires only on issue-matching fixtures → CONVERGENT; ready for PR
6. Open a PR (gh CLI) with:
   - The rubric YAML diff
   - The issue evidence
   - calibrate_critic before/after metrics
   - A pre-filled review checklist for the human approver
7. On PR merge, criterion flips from `proposed: true` to `proposed: false` and counts in production
```

**Why this is the highest-ROI loop**: It is the *output-side* feedback that `calibrate_critic` alone (input-side) cannot provide. It turns production incidents from cost into a permanent capability upgrade.

**Cost discipline**: Reverse-learning is operator-triggered (not auto), runs as a CLI command, and each invocation is a single low-cost LLM call + cached calibration. Daily cap honors v1 cost guard.

**Privacy**: The script never sends production data anywhere PixelCheck did not already send data. Screenshots are stored locally; the only outbound is the LLM call for criterion proposal, which is identical in privacy posture to a normal `judge` invocation.

---

<a id="5-four-phase-roadmap"></a>

## 5. Four-Phase Roadmap

| Phase | Goal | Ships as | Effort | Validation gate |
|---|---|---|---|---|
| 0 | Strategy anchor (this doc) | — | done | User approval on Ch1-8 |
| 1 | L1 + L2 minimum — 3 finance personas + `finance_terminal` rubric, run on one ShineFIN page | internal spike | 2-3 evenings | v2 surfaces ≥ 3 professional issues v1 `aesthetic` rubric misses; Wayne confirms each is a real pro gap |
| 2 | Full L1 (25 personas × 5 verticals) + full L2 (5 rubrics) + `judge_panel` MCP tool | v1.4.0 | 2-3 weeks | All 5 rubrics pass `calibrate_critic`; panel double-blind beats fast in inter-rater agreement on labeled set; npm size delta < 100 KB |
| 3 | L4 Hook integration + local small-model pre-screen | v2.0.0-rc | 2 weeks | ShineFIN dev loop: typical save → 1 panel call per affected route, < $0.20/screen; pre-screen catches ≥ 80% no-op edits; 0 false-block escalations over 2 weeks |
| 4 | L5 reverse-learning + close `commercial-audit-2026-05-11` outstanding gaps | v2.0.0 GA | 2-3 weeks | Reverse-learn round-trip works on synthetic issue; coverage stays ≥ 80%; commercial-audit gaps closed or deferred via ADR; case-study draft ready |

### 5.1 Critical path

- **Phase 1 is the only critical gate.** If v2 doesn't visibly beat v1 on one real ShineFIN page, the v2 spec needs revision *before* committing engineering hours to Phase 2.
- **Phases 2 / 3 / 4 are mostly independent** and can each ship as a minor/major version. v1.4.0 (library + panel) is independently valuable without Hook integration — adopters can invoke `judge_panel` via MCP directly.
- **Phase 4 doubles as v1 commercial-audit cleanup**, bundling the two avoids a separate release cycle.

### 5.2 What ships when (developer-visible)

| Release | Phase | New surface |
|---|---|---|
| v1.3.x (current line) | — | nothing changes |
| v1.4.0 | 2 | 25 expert personas + 5 domain rubrics + `judge_panel` |
| v2.0.0-rc | 3 | Hook integration recipe + small-model pre-screen |
| v2.0.0 GA | 4 | `reverse-learn` CLI + closed commercial-audit gaps + case-study published |

### 5.3 Out of scope for v2 (v3+ discussion)

- Cursor / Cline / Continue / Zed Hook recipes (Claude Code first; others on demand once API surface stabilizes)
- Browser-extension form factor (MCP transport is sufficient)
- Expert persona marketplace / paid tier (PixelCheck stays MIT free per README promise)
- Live human-expert in-the-loop ("a real reviewer is online")
- Non-English expert personas (English-only for v2; locale variants for v3)

---

<a id="6-strategic-alignment"></a>

## 6. Strategic Alignment

### 6.1 Why this advances PixelCheck's stated narrative

PixelCheck v1 sells *"real eyes and hands for the AI agent that's writing your frontend."* The screenshot-and-paste pain Wayne lived (§1.2) is exactly the v1 use case — yet v1 still requires the operator to know *what to ask the auditor for*. v2 removes that residual burden:

- `.pixelcheck-team.yaml` knows **which experts** to convene
- the Hook knows **when** to convene them
- the rubric knows **what** to check for

The product moves from *"give your AI agent eyes"* to *"give your AI agent eyes + a senior team that pages itself in when needed."*

### 6.2 Why this is a natural Anthropic case-study

(References [`memory/feedback_pixelcheck_positioning.md`](../../../../.claude/projects/-Users-wayne-Developer-OpenTools/memory/feedback_pixelcheck_positioning.md): narrative locked to *"built by Claude Code, used by Claude Code."*)

- **Composable-agent story**: L1 + L2 + L3 is a textbook composable-agent pattern — discoverable persona/rubric data + one orchestration tool (`judge_panel`) + standard MCP transport. Inside Anthropic's Agent-SDK / subagent thesis.
- **Real production validation**: ShineFIN + ScamLens + OpenJET use it live. Wayne's @WayLimX brand carries the story (marketing background, learned code 2026 Jan, ships production OSS using Claude Code).
- **Distribution**: v2.0.0 GA + case-study blog post + X thread → Anthropic discovery → potential official case-study slot.

### 6.3 Portfolio fit

| Project | v2 role |
|---|---|
| **ShineFIN** | Primary Phase 1 validation; first adopter of `finance_terminal` rubric |
| **ScamLens** | Source of authoritative `anti_scam_ux` rubric; cross-promo target |
| **OpenJET** | Eventual SaaS-dashboard adopter |
| **PixelCheck** | The infrastructure itself |
| **OpenTools** (this workspace) | Strategy + governance home |

Cross-pollination is real: ScamLens-trained anti-scam expertise → contributed to PixelCheck → reused by every adopter.

### 6.4 Differentiation moat

| Closest category | Example | What they ship | What they don't ship |
|---|---|---|---|
| Generic UX/a11y audits | Lighthouse, axe, WAVE | Standards-based checks | No expert persona; no domain rubric |
| Visual regression | Chromatic, Percy | Pixel-diff baselines | No semantic / expert judgment |
| AI code generators | v0, Lovable, Bolt | Generate UI from prompts | No review layer; no domain expertise |
| IDE-coupled agents | Claude Code, Cursor, Continue | Author code in editor | No opinionated rubric library; no panel |
| Storybook + addons | Storybook + a11y addon | Component cataloging | Not URL-level; no domain review |

**PixelCheck v2's defensible niche**: on-demand domain-expert review as a developer primitive — local-first, MCP-native, MIT-licensed.

---

<a id="7-risks--decision-points"></a>

## 7. Risks & Decision Points

The following must be resolved **before Phase 1 starts** (blocking) or **during Phase 2** (blocking GA but not validation).

### 7.1 Cost governance (blocking Phase 3)

- **Default panel size cap** — proposed: 4 experts; overrides require flag. *Pending Phase 1 cost data.*
- **Default per-screen budget** — proposed: $0.20 USD; tunable in `.pixelcheck-team.yaml`. *Pending Phase 1.*
- **Pre-screen on by default?** — proposed: yes (saves ~80% of LLM calls on trivial edits). Risk: skips edits the dev wanted reviewed. Mitigate via `PIXELCHECK_TEAM_FORCE=1` escape hatch.

### 7.2 Authority & override (blocking Phase 3)

- **Expert disagreement** — proposed: consensus (≥ 2 experts) drives blocking severity; single-expert findings always logged but never block.
- **Developer override of panel verdict** — proposed: yes, logged to `reports/history.db` with override reason; feeds L5 reverse-learning input.
- **`block_on_critical` default** — proposed: `true`. Friction risk in fast-prototyping mitigated by per-project setting.

### 7.3 OSS scope (blocking Phase 2 — the most consequential decision)

| Tier | Components | Status | Rationale |
|---|---|---|---|
| **Framework** | `judge_panel`, persona schema, rubric schema, Hook recipe, reverse-learn CLI | **OSS (MIT) — non-negotiable** | Preserves "yours to own" promise |
| **Library, low-sensitivity verticals** | `finance_terminal`, `anti_scam_ux`, `ecommerce_checkout` rubrics + personas | **OSS recommended** | Proof-of-concept; ScamLens cross-promo; community PR target |
| **Library, high-sensitivity verticals** | `medical_clinical`, `legal_review`, `compliance_aml` | **Decision pending** | Real business value; but "no paid tier ever" in README means going proprietary breaks brand promise |

**Anchored recommendation: all OSS** to preserve the brand promise; moat is execution + brand + first-mover, not data. Final call: Wayne. Tracked as ADR-039 at Phase 2 start.

### 7.4 Persona naming convention (blocking Phase 1)

Role-IDs only, **no real first names** — proposed: `wallstreet-trader-30y`, not `marcus-chen-trader`. Prevents accidental real-person impersonation and depersonalizes the rubric. Tracked as ADR-035 before Phase 1 ships personas to repo.

### 7.5 Rubric versioning & breakage (blocking Phase 2)

- Every `judge` / `judge_panel` report records rubric version in output.
- `.pixelcheck-team.yaml` may pin (`finance_terminal@0.1.0`) or float (`finance_terminal@^0.1`).
- Major version bumps emit `WARN: rubric major bump; review .pixelcheck-team.yaml` on first run after upgrade.

### 7.6 Vertical-addition gate (blocking Phase 2)

PR merge requires: ≥ 5 labeled calibration fixtures · ≥ 1 reference baseline in `baselines/<vertical>/` · one practicing-domain reviewer credit in PR description · `calibrate_critic` passes before merge. Codified in `CONTRIBUTING.md` update during Phase 2.

### 7.7 Known failure modes

| Failure | Likelihood | Mitigation |
|---|---|---|
| Vision-model judgment drift on retrain | Medium | Pin model version per-rubric; calibration suite re-runs in CI |
| Reverse-learn hallucinates a bad criterion | Medium | Never auto-merge; PR-gated + calibration |
| Adopter mis-configures `.pixelcheck-team.yaml` → cost runaway | Low | v1 cost guard ($50/day hard cap) unchanged + per-screen budget |
| Expert persona culturally biased (e.g., US-finance assumed) | Medium | Document cultural scope per persona; add e.g. `cn-stock-trader` variant in v2.1 |
| Hook race conditions in fast-typing workflow | Low | Debounce; pre-screen short-circuits trivial edits |

### 7.8 Decisions required before Phase 1 starts (action list for Wayne)

1. **§7.3 OSS scope** — confirm at minimum: `finance_terminal v0.1`, `anti_scam_ux v0.1`, `ecommerce_checkout v0.1` ship OSS
2. **§7.4 Persona naming** — confirm role-ID-only convention
3. **§7.1 Phase 1 budget** — confirm: $5 USD cap for the full Phase 1 spike (excluding calibration)
4. **§5 Phase 1 success threshold** — confirm exact wording: *"v2 surfaces ≥ 3 professional issues v1 `aesthetic` rubric misses on the ShineFIN sector-overview page, and Wayne agrees each is a real pro gap"*

---

<a id="8-appendix"></a>

## 8. Appendix

### 8.1 v1.2.1 inventory pointer (full content in Ch2)

- Tools: 8 (5 primitives + 3 presets, see §2.1)
- User personas: 18 (see §2.3 or `list_personas`)
- Built-in rubrics: 2 (`aesthetic`, `dark_pattern`) + `custom_criteria` (§2.4)
- Baselines: 59 entries (`baselines/`)
- Schemas: 30 (`docs/schemas/`)
- ADRs: 29 (latest ADR-034)
- Tests: 2158 passing, coverage 80.89% (per `commercial-audit-2026-05-11.md`)
- Env vars: 23 (see `list_capabilities`)

### 8.2 Five expert persona drafts (compact spec; full YAML produced in Phase 1)

Format: `id` · vertical · `expertise_years` · `evaluation_lens` (one sentence) · top-3 `red_flags` · seed `preferred_baselines`.

#### 8.2.1 `wallstreet-trader-30y` — finance

- **vertical**: finance · **years**: 30
- **lens**: Reads dashboards like a trading-desk professional reads a Bloomberg terminal — density first, hierarchy second, aesthetics third.
- **red flags**: missing as-of timestamp · diverging bars not zero-centered · sector exposure shown without comparison benchmark
- **baselines**: `bloomberg-terminal-equity-des`, `tradingview-pro-watchlist`, `factset-portfolio-attribution`

#### 8.2.2 `sell-side-research-analyst` — finance

- **vertical**: finance · **years**: 18
- **lens**: Reads research outputs the way a fund manager reads a sell-side note — thesis up top, evidence underneath, valuation last, every claim sourced.
- **red flags**: thesis buried below charts · valuation methodology not stated · no citation for any forward estimate
- **baselines**: `goldman-research-equity-template`, `morgan-stanley-blue-paper`

#### 8.2.3 `financial-ui-designer-bloomberg` — finance

- **vertical**: finance · **years**: 12
- **lens**: Designs terminals for paying professionals — every pixel earns its place; colorblind-safe; keyboard-first; no decorative chrome.
- **red flags**: color as only encoding for up/down · keyboard shortcuts unsupported on data tables · decorative gradients inside data area
- **baselines**: `bloomberg-terminal-equity-des`, `eikon-refinitiv-quote-monitor`

#### 8.2.4 `anti-scam-investigator` — anti-scam

- **vertical**: anti-scam · **years**: 15
- **lens**: Reads consumer trust UX the way a fraud investigator reads a phishing landing page — trust-signal authenticity, escape-path clarity, undo affordances.
- **red flags**: trust badges without verifiable source link · no clear escape from upgrade flow · CTA dominates over warning copy
- **baselines**: `scamlens-canonical-warning-screen`, `gov-uk-scam-advice-page`

#### 8.2.5 `er-physician-evidence-based` — medical *(deferred sketch, Phase 4+)*

- **vertical**: medical · **years**: 14
- **lens**: Reads clinical decision-support UX like an ER physician reads a chart — urgency-first, units always explicit, contraindications surfaced before recommendations.
- **red flags**: dosage shown without units · contraindication shown after recommendation · timestamp ambiguous (chart-time vs current-time)
- **baselines**: `epic-er-dashboard-2023`, `nhs-decision-support-uk`

### 8.3 `finance_terminal` rubric — 12 criteria (full YAML in Phase 1)

| # | id | severity | one-line |
|---|---|---|---|
| 1 | `data_freshness_visible` | critical | Every time-series view shows explicit "as of `<ts>` `<tz>`" + market-status pill |
| 2 | `data_source_attribution` | major | Every data point names its source (exchange / vendor / model output) |
| 3 | `zero_axis_diverging_bars` | major | Up/down diverging bars centered on the zero axis |
| 4 | `unit_currency_explicit` | major | Every numeric column labels unit + currency (no implied USD) |
| 5 | `not_color_only_encoding` | critical | Up/down direction encoded by shape/symbol/text, not color alone |
| 6 | `benchmark_comparison_present` | major | Sector / factor / single-name exposure shown with ≥ 1 benchmark |
| 7 | `info_density_dense` | minor | Data area meets professional density (rubric defines threshold per view type) |
| 8 | `four_level_typographic_hierarchy` | minor | ≥ 4 distinguishable size levels: section title / table header / data / micro-meta |
| 9 | `interactive_keyboard_supported` | major | Tables/lists support arrow-key navigation; chart timeframe switches via 1/W/M/Y keys |
| 10 | `time_window_toggle_present` | minor | Every time-series view exposes 1D / 1W / 1M / 3M / YTD / 1Y minimum |
| 11 | `weighting_method_disclosed` | major | Index / aggregate views state weighting (cap-weight / equal-weight / custom) |
| 12 | `delayed_data_marked` | critical | If data is non-realtime, "delayed N min" banner visible above the fold |

Severity legend — `critical`: blocks ship under default Hook config · `major`: warning requiring ack · `minor`: logged only.

### 8.4 Baselines plan (finance vertical, Phase 2 deliverable)

```
baselines/finance/
├── bloomberg-terminal-equity-des/         (DES <Equity> snapshot + annotations)
├── tradingview-pro-watchlist/
├── factset-portfolio-attribution/
├── snowball-pro-cn-equity/
└── eikon-refinitiv-quote-monitor/
```

Each baseline directory: `screenshot.png` + `annotations.md` (which criteria this baseline demonstrates).

### 8.5 ADRs planned for v2

| ADR | Topic | Phase |
|---|---|---|
| ADR-035 | Persona `kind: expert` extension + `personas/professional/` layout | 1 |
| ADR-036 | `judge_panel` tool + synthesis methodology | 2 |
| ADR-037 | Hook integration architecture for Claude Code | 3 |
| ADR-038 | Local small-model pre-screen design | 3 |
| ADR-039 | OSS scope decision for domain rubric library | 2 |
| ADR-040 | Reverse-learning loop + PR-emission pattern | 4 |

### 8.6 Cost projection (typical adopter, ShineFIN-scale)

Assumptions: 50 UI edits/day, ~30% trigger visual change after pre-screen, 3-expert panel default, `finance_terminal` rubric.

| Item | Per day | Per month |
|---|---|---|
| Pre-screen (free, local small model) | 50 × $0 | $0 |
| `judge_panel` invocations | 15 × $0.09 = $1.35 | ~$40 |
| `calibrate_critic` (weekly) | — | ~$2 |
| `reverse-learn` (on-demand) | — | ~$1 |
| **Total** | **~$1.35** | **~$43** |

Within default $50/day hard cap (~10% utilization).

### 8.7 Glossary (v2-specific terms)

| Term | Meaning |
|---|---|
| **persona (expert)** | NEW v2. YAML profile describing a reviewer perspective with professional standards (kind: expert) |
| **domain rubric** | NEW v2. Curated, versioned rubric for a specific vertical |
| **`judge_panel`** | NEW v2. One URL judged by N expert personas in parallel + synthesis |
| **panel** | A set of (expert persona, rubrics) tuples invoked together for one URL |
| **reverse-learn** | NEW v2. Output-side feedback loop: production issue → rubric criterion proposal |
| **Hook integration** | NEW v2. Recipe to auto-invoke `judge_panel` from a Claude Code `PostToolUse` event |
| **vertical** | A coherent domain bucket (`finance`, `medical`, `anti-scam`, `e-commerce`, `saas`) |
| **double-blind** | (v1 method, reused) Each side judged independently before synthesis sees both (anti-anchoring) |

---

**End of strategy anchor v0.1.**

*Next step on approval: Wayne signs off → ADR-035 drafted → Phase 1 spike scheduled (target: within 1 week of approval). This document is then frozen as the v2 reference; subsequent changes go through ADR amendments, not edits to this anchor.*

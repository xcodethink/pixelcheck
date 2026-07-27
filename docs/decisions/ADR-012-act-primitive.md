# ADR-012 — `act` primitive (N-2)

- **Status**: Accepted
- **Date**: 2026-04-29
- **Task**: N-2 (`act(url, steps)` MCP tool)
- **Builds on**: ADR-002 (primitive-first), ADR-007 (result schema versioning), ADR-008 (cost guard), ADR-009 (concurrency safety), ADR-010 (MCP tool registry), ADR-011 (`see` primitive)

## Context

`see` (N-1) lets an AI client take one snapshot of a page. The natural next primitive is the ability to *do* something — fill a form, click through a navigation, scroll to a section, ask a follow-up question — and get back a structured per-step trace plus a final observation.

The product question is what shape of action sequence to expose:

1. **Pure natural language** — every step is "click the X", "type Y in the email field". Easy to call but every step pays an LLM round-trip.
2. **Pure CSS-selector / Playwright API** — every step is `{ click, selector }`, `{ fill, selector, value }`. Cheap and deterministic but the AI client has to know selectors, which it generally doesn't.
3. **Mixed** — deterministic kinds (`click`, `fill`, `goto`, …) for steps the AI knows by markup, plus a natural-language `act` step backed by Stagehand for the cases where the AI only knows what the button *says*.

We also need to decide how to integrate with Stagehand without paying its ~5 s cold-start cost when the caller doesn't actually need an AI step.

## Decision

Ship `act` as a **mixed-kind step executor with auto-selected engine**, in the same primitive-first style as `see`. Two new files:

- `src/core/primitives/act.ts` — the TypeScript API.
- `src/mcp/tools/act.ts` — the MCP wrapper.

### Step kinds

```ts
type ActStep =
  | { type: "goto";       url: string; wait_for?: WaitFor; timeout_ms?: number }
  | { type: "click";      selector: string; timeout_ms?: number }
  | { type: "fill";       selector: string; value: string; timeout_ms?: number }
  | { type: "press";      key: string; selector?: string }
  | { type: "wait";       ms: number }
  | { type: "wait_for";   selector: string; state?: "visible" | "attached" | "hidden"; timeout_ms?: number }
  | { type: "scroll";     selector?: string; delta_y?: number; to_bottom?: boolean }
  | { type: "screenshot"; label?: string; full_page?: boolean }
  | { type: "act";        instruction: string }
  | { type: "note";       goal: string };
```

Eight deterministic kinds + two AI kinds. The AI kinds are deliberately the only ones that can spend tokens.

### Engine selection (auto)

`pickEngine(steps)` returns `"stagehand"` iff any step is `{ type: "act" }`, otherwise `"playwright"`. The `playwright` engine reuses the same fast cold-start path `see` uses (~1 s warm, no Stagehand init, no LLM key required). The `stagehand` engine lazy-imports `@browserbasehq/stagehand` and runs `init()` (~5 s) — paid only when the caller actually needs natural-language action resolution. Callers can override with `engine: "stagehand" | "playwright"` if they want predictability.

### `note` works with both engines

`note { goal }` snapshots the active page and calls `callVision` directly. It does not need Stagehand. So a sequence like `[goto, click, note]` stays on the fast Playwright engine and pays only the one vision call.

### Stop-on-error semantics

Default `stop_on_error: true` — first failing step ends the loop and subsequent steps are recorded with `status: "skipped"`. The result `status` becomes `"error"` and `error` carries the first failure's index + type + message. Callers can flip to `false` for best-effort exploratory sequences (every step runs; result `status` still becomes `"error"` if any failed).

### Result envelope

`ActResult` extends the `SeeResult` shape with `engine` and `steps[]`. Every step record carries `index`, `type`, `status`, `duration_ms`, optional `error` / `screenshot` / `note` / `output`, and `cost_usd`. The full Zod schema is `ActResultSchema` and the JSON Schema is `docs/schemas/act-result.schema.json`. `ActStepSchema` exports the public step contract for clients that want to validate input ahead of time.

### Cross-cutting concern alignment

| Concern | How `act` complies |
|---|---|
| Result schema (ADR-007) | `ActResultSchema` checked in. MCP wrapper stamps `RESULT_SCHEMA_VERSION` via `stampedTextResult("ActResult", ActResultSchema, value)`. |
| Cost guard (ADR-008) | `note` steps go through `callVision`; Stagehand-internal LLM calls go through its own Anthropic client, which honours the same per-process key. The MCP dispatcher wraps every tool call in `withCostRun` so per-run snapshots stay isolated. |
| Concurrency safety (ADR-009) | Per-call artefacts directory `<root>/<iso>-<rand6>/`. Two parallel `act` invocations get independent run scopes from the dispatcher and independent on-disk subdirs. |
| MCP tool registry (ADR-010) | New file `src/mcp/tools/act.ts` exports a `ToolDefinition` with `kind: "primitive"`. Catalog grows 7 → 8 with `act` placed between `see` and `list_personas`, preserving the preset → primitive → meta band. |

### Persona handling

Identical to `see`. `SeePersonaHints` (subset of `Persona`) covers `viewport / locale / timezone / user_agent / id`. The MCP wrapper reads `./personas/<id>.yaml` if present and projects it down. Missing persona, missing dir, or no persona at all all collapse to defaults (1280×800, `en-US`, `UTC`, `act-default-desktop`).

### Artifacts

`<root>/<iso>-<rand6>/` is created per call. `screenshot` step writes `<label>.png` (default `step-<index>.png`); the final pass after all steps writes `screenshot.png`. The default root is `~/.ai-browser-auditor/acts/` for production and `~/.ai-browser-auditor-v1/acts/` in the v1 worktree (via `AUDIT_ACTS_DIR` in `.env.development`).

## Alternatives considered

### A: build `act` on top of `runAudit` with a synthesised scenario

Rejected for the same reasons as `see` — the runner brings Stagehand init, scenario validation, persona file requirement, history DB writes, reporter SPA generation. None of that belongs in a primitive that's supposed to be a thin step executor.

### B: always use Stagehand (single engine)

Rejected — punishes the common case. A caller that only needs `[goto, fill, click, screenshot]` would pay the full Stagehand cold-start (~5 s) plus require an LLM key, even though the action sequence is fully deterministic. Auto-selection means the caller pays Stagehand only when the caller actually asks for AI semantics.

### C: separate `act_deterministic` + `act_ai` MCP tools

Rejected — splits a contract that is conceptually "execute this sequence". The natural use case is a mixed sequence; forcing the caller to pre-classify and route through two tools forfeits the engine auto-selection win and complicates pipelines like "log in (deterministic) then click whatever the next CTA is (NL act)".

### D: support "best-effort" mode by default (no stop-on-error)

Rejected — silent partial success is a footgun for AI agents. The default must be that an apparent failure aborts the rest of the sequence so the caller can read the trace and react. Best-effort is opt-in via `stop_on_error: false`.

### E: return inline base64 for per-step screenshots

Rejected for the same reasons `see` rejected it (ADR-011 §C): 33 % JSON inflation, clients have to decode before they can render, and on-disk artefacts are clean and replayable.

### F: support arbitrary Playwright API surface (e.g. `evaluate`, network mocks)

Rejected for v1 — the eight deterministic kinds + `act` + `note` cover the realistic UX-flow execution pattern. Anything more capable belongs in a "scripting" primitive (out of scope for v1) or in `audit_url` which already runs the full Playwright surface inside a scenario.

## Consequences

- **The "primitive recipe" template is now validated twice** (see + act). N-3 (`compare`), N-4 (`extract`) follow the same 4-commit shape: schema entry → primitive module → MCP tool wrapper → docs.
- **Stagehand becomes a soft dependency.** A caller with no LLM key and no `act` step can still use `act`. We keep the dynamic import for resilience.
- **Stagehand cold-start dominates Stagehand-engine sessions.** ~5 s is the floor; users who chain dozens of NL steps amortise it well, users with one NL step pay it once. There is no cheaper alternative without forking Stagehand.
- **Artefacts grow on disk** — same trade-off as `see`. A future task can add `AUDIT_ACTS_RETENTION_DAYS` prune symmetric to the cost-ledger 30-day prune.
- **No `act` step retry/fallback chain inside the primitive.** `audit_url` ships the four-layer retry stack (selector hint → instruction mutation → auto-selector discovery → computer use). The primitive deliberately stays simple: an act step either succeeds via Stagehand or fails. Callers who want fallbacks should use `audit_url`.

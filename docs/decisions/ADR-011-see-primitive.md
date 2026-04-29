# ADR-011 — `see` primitive (N-1)

- **Status**: Accepted
- **Date**: 2026-04-29
- **Task**: N-1 (`see(url, opts)` MCP tool)
- **Builds on**: ADR-002 (primitive-first), ADR-007 (result schema versioning), ADR-008 (cost guard), ADR-009 (concurrency safety), ADR-010 (MCP tool registry)

## Context

`see` is the first AI primitive in the v1 catalog — the smallest unit of "look at a URL and tell me what's there" that an external AI client can compose into bigger workflows. Unlike `audit_url` (which is the full UX-audit pipeline) and `explore_url` (which is the autonomous-agent loop), `see` is a one-shot navigational observer with no scenario, no persona requirement, and zero LLM cost when the caller doesn't ask for a vision summary.

The primitive must answer three open questions:

1. **What's the public surface?** Inputs and outputs need to be small enough that an AI agent can plan a `see` call from natural-language reasoning, but rich enough that the result is actionable on its own.
2. **How is it executed?** The audit pipeline launches Stagehand and runs through `runAudit`, both of which carry significant cold-start cost and require an LLM key. A primitive cannot pay that cost.
3. **How does it integrate with the cross-cutting concerns?** ADR-007 (schema versioning), ADR-008 (cost guard), ADR-009 (concurrency safety), ADR-010 (MCP tool registry) all impose contracts that `see` must respect.

## Decision

Ship `see` as a **stand-alone primitive that bypasses Stagehand and `runAudit`**, exposed both as a TypeScript API (`src/core/primitives/see.ts`) and as an MCP tool (`src/mcp/tools/see.ts`).

### Public surface

```ts
see(opts: SeeOptions): Promise<SeeResult>
```

`SeeOptions`:

| Field | Default | Notes |
|---|---|---|
| `url` (required) | — | Target URL |
| `goal` | — | Natural-language question; when set, runs **one** vision call |
| `persona` | — | Hint object (`viewport`, `locale`, `timezone`, `user_agent`); persona files are not required |
| `waitFor` | `"networkidle"` | `'load'` / `'domcontentloaded'` / `'networkidle'` / `{ type: 'selector', selector }` |
| `viewport` | persona's, else 1280×800 | Explicit override |
| `fullPage` | `true` | Full-page vs viewport-only screenshot |
| `includeDom` | `true` | Toggle DOM summary |
| `includeConsole` | `true` | Toggle captured console errors |
| `timeoutMs` | `30000` | Per-navigation timeout |
| `headless` | `true` | Browser headless flag |
| `artifactsRoot` | `$AUDIT_SEES_DIR` or `~/.ai-browser-auditor/sees/` | Per-call subdir is created here |
| `criticModel` | `"claude-sonnet-4-6"` | Model for the optional vision note |
| `_open` / `_callVision` | — | Test seams (same pattern as cost-guard's `testInjector`) |

`SeeResult`: `schema_version` + `url_input` + `url_final` + `title` + `loaded_at` + `status` + `error?` + `dom | null` + `console | null` + `screenshot | null` + `note | null` + `persona_id` + `artifacts_dir` + `cost_usd` + `duration_ms`. The full Zod schema is `SeeResultSchema` and the JSON Schema is `docs/schemas/see-result.schema.json`.

### Execution: raw Playwright, not Stagehand

`see` calls `chromium.launch` + `browser.newContext` + `page.goto` directly. Concretely:

- Cold-start ~1 s on a warm Chromium install vs ~5 s for Stagehand init.
- No LLM key required to fulfil the no-`goal` happy path.
- The screenshot is always taken (it is the cheapest, most useful artefact and is needed for the optional vision call anyway).
- The DOM summary reuses `extractDomSummary` from `src/agent/dom-summary.ts` plus a tiny inline `page.evaluate` to surface headings as a structured `string[]` (the existing helper only joins them into `summary.elements`).

### Vision note: `callVision`, not `runCritic`

When `goal` is set, `see` issues exactly one `callVision` call with a tiny system prompt ("careful UI observer, 1-3 sentences, cite only what you can see, do not speculate") + the `goal` as user prompt + the compressed screenshot. The result text is returned in `note`.

`runCritic` was rejected because:
- It requires a `Persona` and a `Scenario` (those are heavyweight inputs not appropriate for a primitive).
- It returns a structured verdict (scores, issues, recommendations) that doesn't match the "answer one question in natural language" use case.
- Its prompt is calibrated for full audits and would over-weight non-pertinent dimensions.

### Cross-cutting concern alignment

| Concern | How `see` complies |
|---|---|
| Result schema (ADR-007) | `SeeResultSchema` + `docs/schemas/see-result.schema.json` checked in. `MCP` tool wraps the return through `stampedTextResult(SeeResult, SeeResultSchema, value)`. |
| Cost guard (ADR-008) | Vision call goes through `callVision`, which is already wired to `getCostGuard().checkBudget()` + `recordUsage()`. No new hook required. |
| Concurrency safety (ADR-009) | The MCP dispatcher wraps every tool call in `withCostRun`, so two parallel `see` invocations get independent per-run snapshots. The persistent ledger remains shared via the file lock inside `recordUsage`. The artifacts directory is per-call (`<iso>-<rand6>`), eliminating cross-call file collisions. |
| MCP tool registry (ADR-010) | New file `src/mcp/tools/see.ts` exports a `ToolDefinition` with `kind: "primitive"`. The catalog grows from 6 → 7 with `see` placed between `explore_url` and `list_personas`, preserving the preset → primitive → meta visual band. |

### Persona handling

`see` accepts persona hints as a small structural type (`SeePersonaHints`), not the full `Persona`. The MCP wrapper reads `./personas/<id>.yaml` if it exists and projects it down. Missing persona id, missing personas dir, or no persona at all all collapse to the same defaults (1280×800, `en-US`, `UTC`). This makes `see` callable on a fresh checkout with zero config.

### Artifacts: per-call subdirectory

Each `see` call creates `<artifactsRoot>/<UTC-iso>-<rand6>/` and writes `screenshot.png` + `screenshot.png.sha256` into it. The default root is `~/.ai-browser-auditor/sees/` for production and `~/.ai-browser-auditor-v1/sees/` in the v1 worktree (via `AUDIT_SEES_DIR` in `.env.development`). This keeps `see` artefacts isolated from the `reports/` tree that `audit_url` writes to — `see` is a primitive, not an audit.

## Alternatives considered

### A: pass through to `runAudit` with a synthetic 1-step scenario

Rejected — `runAudit` brings Stagehand init, scenario validation, persona resolution, history DB writes, reporter SPA generation, baseline diff. None of that belongs in a primitive that's supposed to be cheap.

### B: build `see` on top of Stagehand for fingerprint parity with `audit_url`

Rejected for v1 — Stagehand's value-add is `act/observe/extract` AI primitives, none of which `see` uses. The fingerprint stealth patches matter for sites that block bots (high-stakes audits), but `see` is for AI inspection, not adversarial testing. If a target requires stealth, the caller should reach for `audit_url` / `explore_url`. We can revisit if real usage shows `see` being blocked at a meaningful rate.

### C: return base64 screenshot inline instead of writing to disk

Rejected — base64 in JSON balloons the result by ~33 %, MCP clients have to decode it before they can show it, and disk artefacts make replay / debugging trivial. Path + sha256 is a clean reference; callers who really want the bytes can read the file or rerun.

### D: combine `see` + `note` into separate MCP tools

Rejected — two tools means two round-trips. The natural use case is "go look at this URL **and** tell me X about it" in one shot. Making the vision step optional via `goal` keeps the contract small while serving both modes.

### E: synchronously block on full-page network quiescence (no timeout)

Rejected — the default `waitFor: "networkidle"` matches Playwright's existing semantics, but if the page never goes idle the tool would hang. `timeoutMs` (default 30 s) caps it. Pages that stream forever now return `status: "error"` with the timeout message; callers who expect those should pass `waitFor: "load"` or a CSS selector.

## Consequences

- **Adding more primitives is now a 4-commit recipe**: schema entry → primitive module → MCP tool wrapper → docs. N-2 (`act`), N-3 (`compare`), N-4 (`extract`) all follow this template.
- **`see` is the first tool in the catalog with `kind: "primitive"`**. Going forward, M9-5 `list_capabilities` will use this discriminator to group primitives apart from presets in client UX.
- **Artifacts grow on disk**. A heavy user running `see` thousands of times will accumulate per-call subdirectories in `~/.ai-browser-auditor/sees/`. We accept this in v1.0 — a future task can add an `AUDIT_SEES_RETENTION_DAYS` prune similar to the cost-ledger 30-day prune.
- **Stagehand fingerprinting is not applied**. Sites that aggressively block headless Chromium will fail with `see`. Document this in the README and make the workaround (`audit_url` / `explore_url`) discoverable.
- **No test seam in production code path**. The `_open` / `_callVision` injection points are runtime-checked but undocumented in the public README; they exist solely so unit tests can run without launching real Chromium or burning vision tokens.

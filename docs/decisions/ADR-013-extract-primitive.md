# ADR-013 — `extract` primitive (N-4)

- **Status**: Accepted
- **Date**: 2026-04-29
- **Task**: N-4 (`extract(url, schema)` MCP tool)
- **Builds on**: ADR-002 (primitive-first), ADR-007 (result schema versioning), ADR-008 (cost guard), ADR-009 (concurrency safety), ADR-010 (MCP tool registry), ADR-011 (`see` primitive), ADR-012 (`act` primitive)

## Context

`see` lets the AI client *look at* a page; `act` lets it *do* things on a page. The natural completion of the trio is the ability to *take* something away — a typed payload shaped exactly the way the caller asked for. Pricing tiers, feature lists, plan comparisons, FAQ entries, headline + CTA pairs: in every case the AI client knows the shape it wants but can't write a CSS scrape, and free-form `note` text takes another LLM round-trip to re-parse.

Stagehand v2's `page.extract({ instruction, schema })` already solves the underlying problem: hand it a Zod schema, get back `z.infer<T>` matching that shape. Two things make the integration non-trivial:

1. The MCP wire is JSON. AI clients do not have a runtime Zod available. Anything we accept as a schema must be JSON-serialisable.
2. The product question is which JSON-Schema dialect we accept, how we map it to Zod, and how we surface mismatches.

## Decision

Ship `extract` as the third v1 primitive. Two new files mirror the see/act pattern:

- `src/core/primitives/extract.ts` — TypeScript API + JSON Schema → Zod converter.
- `src/mcp/tools/extract.ts` — MCP wrapper.

### API shape

```ts
extract({
  url,
  schema?,         // JSON Schema describing the desired payload
  instruction?,    // optional NL hint passed to Stagehand
  selector?,       // optional CSS sub-region
  // standard envelope opts: persona, viewport, waitFor, timeoutMs,
  // headless, fullPage, includeDom, includeConsole, artifactsRoot,
  // model
})
  → ExtractResult { ..., engine: "stagehand", data, schema_used,
                    instruction_used, selector_used, dom, console,
                    screenshot, cost_usd, ... }
```

Single-engine: Stagehand only. Unlike `act` (auto-picked between Playwright and Stagehand), `extract` is by nature LLM-driven schema-bound extraction — there is no deterministic alternative for "give me an arbitrarily-shaped object matching this schema." If Stagehand isn't installed, the open path raises a clear error with an install hint.

### JSON Schema subset (whitelist)

Accepted keywords:

- `type`: `"object" | "array" | "string" | "number" | "integer" | "boolean" | "null"`
- `type: ["string", "null"]` shorthand for nullable
- `properties`, `required` (object members + which are mandatory)
- `items` (array element schema; required for `type: "array"`)
- `enum` (string-only → `z.enum`; mixed → `z.union` of `z.literal`)
- `description` (forwarded to `.describe()` — improves Stagehand's prompt quality)
- `nullable: true` (OpenAPI shorthand)
- `additionalProperties` (accepted but ignored — `z.object` strips by default)
- `pattern` / `minLength` / `maxLength` / `minimum` / `maximum` (accepted but not enforced; the LLM does not honour them)
- `title` / `default` / `examples` / `$schema` / `$id` (metadata, no-op)

Rejected (precise error message naming the keyword and JSON path):

- `oneOf` / `anyOf` / `allOf` / `not`
- `$ref`
- `patternProperties` / `dependencies` / `if` / `then` / `else`
- `const` (use a single-element `enum` instead)

The root must be `type: "object"` because Stagehand's `page.extract()` requires `T extends z.AnyZodObject`. A bare `{ properties: {…} }` (no `type`) is accepted as object-shorthand to be friendly to common shorthand.

### Auto-instruction synthesis

When the caller supplies a schema but no `instruction`, the primitive synthesises one from the schema's top-level field names and `description` annotations: `"Extract the following fields from the page: name, price (Monthly price in USD), features."` Stagehand's extract performs noticeably better with a one-line hint, even when the schema makes intent obvious.

### Cost-guard wiring

Stagehand exposes a running `metrics` snapshot (`extractPromptTokens`, `extractCompletionTokens`). The primitive snapshots metrics before and after the extract call, computes USD via `estimateCost(model, deltaIn, deltaOut)`, and feeds `getCostGuard().recordUsage()` so the persistent daily ledger stays accurate.

If `recordUsage` throws `BudgetExceededError`, the data is still returned but `status` flips to `"error"` with the budget message — *partial-success* semantics so the caller can still consume what they paid for. (Closes the gap that `act` left open for Stagehand-internal LLM cost accounting.)

### Result envelope

`ExtractResult` mirrors the `see` / `act` shape with three extract-specific fields:

- `data` — `unknown` (caller-defined shape; cannot be narrowed in our schema without copying the user's schema across the wire — out of scope for v1).
- `schema_used` — echoes the JSON Schema the caller passed, for client-side re-validation against the same contract. `unknown` to avoid coupling our SemVer to JSON Schema's evolution.
- `instruction_used` / `selector_used` — debugging aid: what we actually handed to Stagehand under the hood.

The full Zod schema is `ExtractResultSchema` and the JSON Schema is `docs/schemas/extract-result.schema.json` (22 schemas total at `RESULT_SCHEMA_VERSION 1.0.0`).

### Cross-cutting concern alignment

| Concern | How `extract` complies |
|---|---|
| Result schema (ADR-007) | `ExtractResultSchema` checked in. MCP wrapper stamps `RESULT_SCHEMA_VERSION` via `stampedTextResult("ExtractResult", …)`. |
| Cost guard (ADR-008) | Stagehand metrics → `estimateCost` → `recordUsage`. Daily ledger updated even though Stagehand owns the LLM client. |
| Concurrency safety (ADR-009) | Per-call artefacts directory `<root>/<iso>-<rand6>/`. Two parallel `extract` invocations get independent on-disk subdirs and independent run scopes from the MCP dispatcher. |
| MCP tool registry (ADR-010) | New file `src/mcp/tools/extract.ts` exports a `ToolDefinition` with `kind: "primitive"`. Catalog grows 8 → 9 with `extract` placed between `act` and `list_personas`, preserving the preset → primitive → meta band. |

### Test seams

`_openStagehand` replaces the Stagehand init+open path; `_callExtract` replaces the extract method on the opened session, so unit tests stub the LLM round-trip without ever spinning Stagehand. The integration test uses real Chromium against the existing fixture site with a Stagehand-shaped open seam that stubs `extract()` — exercises navigation / DOM extraction / screenshot / data.json persistence end-to-end without any LLM credits.

## Alternatives considered

### A: accept Zod schemas directly

Rejected. The MCP wire is JSON; AI clients have no runtime Zod available and cannot serialise a Zod object. JSON Schema is the standard inter-system shape for "describe data structure" and is what every AI tool surface should accept.

### B: depend on `json-schema-to-zod` npm package

Rejected. It implements the full JSON Schema spec including the keywords we want to refuse (`oneOf`, `$ref`, `patternProperties`, etc.). For our purposes the conversion is trivial — a 60-line `switch` statement — and a whitelist subset is *safer* than a permissive converter that silently coerces unsupported keywords. Also avoids a new dependency and the SemVer coupling that comes with it.

### C: dual-engine (raw Playwright as a "deterministic" fallback)

Rejected. There is no sensible "raw Playwright extract" — extract is by nature LLM-driven shape-bound reasoning over page content. A caller who wants a deterministic CSS scrape should use `act`'s `screenshot` step plus their own DOM logic, or `see`'s `dom.summary`. Forcing a fake dual-engine shape would invite confusion.

### D: rely on Stagehand's free-form fallback (no schema input at all)

Rejected. Without a schema, Stagehand returns `{ extraction: string }` (free-form prose). That gives the AI client another LLM round-trip to re-parse, which is exactly what `extract` exists to eliminate. The schema-omitted path is kept as a fallback (so `extract` can answer "what's on this page in 1-3 sentences") but it is not the primary shape.

### E: split `extract_json` and `extract_text` MCP tools

Rejected. One tool with an optional `schema` covers both modes. Splitting would force callers to know in advance which mode they want; the unified tool lets them iterate (start with no schema, then add one once they know the shape).

### F: validate `data` against the user's schema post-Stagehand on our side

Rejected for v1. Stagehand already validates internally — the schema we pass it *is* the validation. Adding a second validation pass on our side would just duplicate the failure mode without catching anything new (and would couple `ExtractResultSchema` to whatever JSON Schema dialect we accept). If Stagehand returns data that doesn't match, that's a Stagehand bug; we surface it as `status: "error"`.

### G: inline base64 for the screenshot

Rejected for the same reasons as `see` (ADR-011 §C) and `act` (ADR-012 §E): 33 % JSON inflation, clients have to decode, on-disk artefacts are clean and replayable.

### H: enforce `pattern` / `minLength` / `maximum` etc.

Rejected for v1. Stagehand's LLM does not enforce those constraints during extraction, and Zod-side post-validation would just produce false-positive rejections of LLM output that "almost" matches. Caller-side enforcement is cleaner — they have the full JSON Schema and can re-validate locally.

## Consequences

- **All four "primitive recipe" tasks now share the same 4-commit shape** (schema entry → primitive module → MCP tool wrapper → docs). N-3 (`compare`) is the next one in line and follows the same template.
- **Stagehand cold-start (~5 s) dominates every `extract` call.** Repeated extracts against the same page would be wasteful; the right pattern is `[see → extract]` or `[act → extract]` chained inside a single composite primitive. That composite is N-9 (multi-step research workflow); for v1 the cost is per call.
- **The JSON Schema subset is documented in the tool description and the input-schema property `description`.** Callers who supply an unsupported keyword get a clear error pointing at the path. That said, the subset is not yet exposed as a discoverable JSON-Schema-of-JSON-Schemas; if N-4 grows users it may be worth exposing one via M9-5 `list_capabilities`.
- **Artefacts grow on disk** — same trade-off as `see` and `act`. A future task can add `AUDIT_EXTRACTS_RETENTION_DAYS` prune symmetric to the cost-ledger 30-day prune.
- **Stagehand metrics are now read by `extract`.** This is the first primitive to thread Stagehand's running token counters into our cost ledger. The same pattern can retroactively close the cost-tracking gap that `act`'s `act` step left open (ActStep result currently records `cost_usd: 0` for Stagehand-internal acts).

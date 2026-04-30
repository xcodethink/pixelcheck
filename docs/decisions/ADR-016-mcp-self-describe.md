# ADR-016 — MCP self-describe (`list_capabilities`) (M9-5)

- **Status**: Accepted
- **Date**: 2026-04-30
- **Task**: M9-5 MCP self-describe / `list_capabilities` — the final Phase 1 deliverable
- **Builds on**: ADR-007 (result schema versioning), ADR-010 (MCP tool registry / kind discriminator), ADR-015 (result cache / cacheable matrix)

## Context

By the end of M9-4, the MCP server exposes 11 tools across three kinds (`preset`, `primitive`, `meta`) with a stable `ToolDefinition` registry, a versioned result schema, a result cache, and a cost guard. The catalog is rich, but the spec-level MCP `tools/list` request only returns the strict spec subset (`name` / `description` / `inputSchema`). Critical operational facts are scattered:

- **Cacheability** — encoded in M9-4's design matrix in `ADR-015` and at-runtime behavior in `withResultCache`, but *not* surfaced to a caller deciding whether to budget for a fresh call.
- **Cost band** — only documented prose in `README.md` ("`judge`: ~1 vision call (~$0.012)"). Real cost is reported per-call in `cost_usd`, but a planner can't read that *before* it spends.
- **Side effects** — implicit ("`act` mutates state, `audit_url` writes to history.db"). A new agent has to read source / docs to know which tools are safe to retry / parallelise.
- **Required env vars** — partially in `.env.development`, partially in module docstrings, partially only obvious from a `process.env.X` grep.

An AI agent that sees only the spec-level `tools/list` has to brute-force discover all of this. In commercial deployments this means agents either over-spend (don't realise a result was cached) or under-use (refuse to call something they don't know how to budget for).

`list_capabilities` is the proper exit for the richer fields the registry already carries — exactly per the M9-1 design intent (see ADR-010 §"Why ListTools doesn't emit kind/resultSchema": *strict MCP clients may reject unknown fields; M9-5 list_capabilities is the richer-field exit*).

## Decision

Add one new `meta` MCP tool, `list_capabilities`, that returns a structured, versioned snapshot of every shipped tool's capabilities plus the public env-var table and live cache state. Pure introspection: no LLM, no browser, no probe of secret presence.

### Output shape

A new `ListCapabilitiesResultSchema` (versioned envelope, additive minor `1.1.0` → `1.2.0` per ADR-007):

```jsonc
{
  "schema_version": "1.2.0",
  "server": { "name": "ai-browser-auditor", "version": "0.3.0" },
  "result_schema_version": "1.2.0",
  "tools": [
    {
      "name": "judge",
      "description": "Single-page rubric-driven critic …",
      "kind": "primitive",
      "input_schema": { /* the same JSON Schema tools/list publishes */ },
      "result_schema": "JudgeResult",
      "cacheable": true,
      "cost_estimate_usd": {
        "typical": 0.02,
        "min": 0.01,
        "max": 0.06,
        "unit": "per_call",
        "notes": "1 vision call regardless of rubric count …"
      },
      "side_effects": ["navigation", "network_egress", "fs_writes_artifacts"],
      "requires": { "api_keys": ["ANTHROPIC_API_KEY"], "browser": true }
    }
    /* … 11 more tools */
  ],
  "env": [
    {
      "name": "ANTHROPIC_API_KEY",
      "description": "Anthropic API key. Required by every LLM-using tool …",
      "scope": "auth",
      "default": "",
      "required": true
    }
    /* … 20 more env vars across auth/cache/cost_guard/artifacts/logging/memory/reports */
  ],
  "cache": {
    "enabled": true,
    "ttl_ms_default": 86400000,
    "path": "/Users/.../.ai-browser-auditor/result-cache.db"
  }
}
```

### What's static vs live

| Field | Source | Type |
|---|---|---|
| `tools[].cacheable` / `.cost_estimate_usd` / `.side_effects` / `.requires` | `ToolDefinition` literal in `src/mcp/tools/<name>.ts` | static |
| `env[]` | hand-curated table in `src/mcp/tools/list-capabilities.ts` | static |
| `cache.enabled` | `process.env.AUDIT_RESULT_CACHE_DISABLED` parsed | live |
| `cache.ttl_ms_default` | `process.env.AUDIT_RESULT_CACHE_TTL_MS` parsed (with fallback) | live |
| `cache.path` | `defaultDbPath()` from `result-cache.ts` | live |
| `server.{name,version}` / `result_schema_version` | hard-coded constant + imported `RESULT_SCHEMA_VERSION` | static |

### Privacy / secrets

Static `requires.api_keys` declares a *dependency* on an env var name (e.g. `"ANTHROPIC_API_KEY"`). It does NOT probe whether the var is currently set — that would leak secret-presence to every caller (and via the M9-3 cost-isolation rules, to every tenant of a hypothetical multi-process deployment). A caller hitting a missing dependency gets a normal error from the tool body, identical to the pre-M9-5 behaviour.

The env table follows the same rule: secret names appear (so callers know what to set), values never do. The result-cache file path *is* exposed because paths are not secrets — agents writing diagnostic / cleanup scripts genuinely need them.

A test (`tests/list-capabilities.test.ts`) plants a fake `ANTHROPIC_API_KEY` value and asserts it is absent from the entire `list_capabilities` output, while the *name* `ANTHROPIC_API_KEY` is present.

### Cost-estimate semantics

`cost_estimate_usd` is a static band, NOT a measurement:

- `typical` — what most calls actually cost in production.
- `min` — best-case (e.g. cache-cold + small page).
- `max` — worst case under default settings; for `audit_url`/`explore_url` the per-call `budget_usd` cap (default $2) hard-limits this.
- `unit` — `per_call` | `per_step` | `per_persona_scenario`. Tells the caller what they're multiplying by.
- `notes` — one-line hints for non-obvious cases (e.g. "see is free without `goal`").

Agents read this at *plan* time. Real spend is reported on every result envelope's `cost_usd` field — that's the source of truth for actuals. The two are explicitly separated so we don't conflate "what we charge" with "what to plan around".

### Naming convention

Internal TypeScript uses camelCase (`costEstimateUsd`, `sideEffects`, `requires.apiKeys`). The output JSON uses snake_case (`cost_estimate_usd`, `side_effects`, `requires.api_keys`) to match the rest of the MCP envelope conventions (`schema_version`, `cost_usd`, `report_json`, etc.). The handler does the translation inside `describeTool()`.

## Consequences

- AI agents calling `list_capabilities` on first connect get a full plan-time map of cost / cacheability / side effects / dependencies. They can budget without trial-and-error and avoid redundant LLM spend on things the cache will serve free.
- Adding a new tool now requires populating four metadata fields (`cacheable`, `costEstimateUsd`, `sideEffects`, `requires`) on its `ToolDefinition`. The catalog invariants test will fail loudly if any are missing — this is by design.
- Adding a new env var to a primitive requires adding a row to `envTable()` in `list-capabilities.ts`. The envelope-completeness test asserts the set stays in sync with the env-var grep against `src/`.
- `RESULT_SCHEMA_VERSION` is now `1.2.0`. Nothing existing changed shape; only the new self-describe envelope and its building blocks were added.
- 30 schemas are now exported (was 25): `list-capabilities-result`, `tool-capability`, `env-var-doc`, `cost-estimate`, `cache-info` joined the public catalog.

## Alternatives rejected

### 1. Add the rich fields directly to `tools/list`

We could have just put `kind` / `cacheable` / `cost_estimate_usd` etc. on each `Tool` record returned by the spec-level `tools/list` request. **Rejected** because strict MCP clients (e.g. clients that locally validate the `Tool` schema before rendering) MAY reject unknown fields. The M9-1 design (ADR-010) deliberately split the spec subset from the richer fields for exactly this reason. `list_capabilities` is the proper exit.

### 2. Probe runtime state ("is `ANTHROPIC_API_KEY` set?")

Tempting because it would let agents distinguish "key missing → tell user to run `export`" from "key set but invalid → call and see error". **Rejected** because:

- It leaks secret-*presence* state to every caller. Even if values aren't returned, "this server has a key configured" is itself a fact some operators won't want exposed.
- It conflates static contract (what the tool needs) with runtime state (what's currently set). The contract is stable; runtime state changes per process. Mixing them invites cache-staleness bugs.
- An MCP transport already returns a clean error from the tool body if the key is missing. Callers can treat that as the live signal.

### 3. Return process-level live stats (cost burned this run, cache hit rate, last error)

Useful for an "ops dashboard" use case. **Rejected** as out of scope for v1:

- It's a meaningfully different concern (observability, not capabilities). M9-5 is about static introspection.
- Per-run cost lives in `withCostRun()` AsyncLocalStorage (M9-3). Exposing it would require routing through scope-aware code paths, which would change `list_capabilities` from a pure registry projection into a stateful tool.
- Cache hit rate would require either keeping a counter (state in the cache module) or a query against `result-cache.db` (cost on every list_capabilities call). Neither is justified for v1.
- A future "browser observability" task (N-10, Phase 2) is the proper home for this.

### 4. Don't reify env vars into a structured table; just point at README

`README.md` already documents env vars in prose. Why duplicate? **Rejected** because:

- Prose isn't machine-readable. AI agents writing diagnostic / setup scripts need structured data.
- Drift: README lists env vars in module-by-module order; `.env.development` repeats them; module docstrings repeat them again. Three sources, three drift surfaces. The M9-5 envelope is the *fourth* — but it's the only one that can be statically asserted to cover every env var the codebase actually reads (the `tests/list-capabilities.test.ts > env table includes every audit-prefix env var` test forces this).

### 5. Make `list_capabilities` cacheable via M9-4

The output is mostly static; in-memory caching seems free. **Rejected** because:

- The cache state itself is *part* of the output (`cache.enabled`, `cache.path`). Caching a cache-state report would require invalidating on cache config changes — circular.
- The handler is ~5 µs of JS. Caching adds complexity for no measurable benefit.
- `cacheable: false` is the right declaration both for the M9-4 matrix invariants and for the output's own self-consistency.

### 6. Use HTTP-style content negotiation (return prose for human consumers, JSON for agents)

Some MCP servers do this. **Rejected** as scope-creep. MCP's transport already implies JSON; humans inspecting via `tools/call` get the JSON pretty-printed by `stampedTextResult`. Adding a second format adds 2× test surface for no deliverable benefit.

### 7. Auto-discover env vars by AST-grepping `process.env.X`

Could turn `envTable()` into a generated artifact. **Rejected** because:

- The interesting fields aren't grep-able: `description`, `scope`, `default`, `required`. Those still have to be hand-curated.
- A grep would catch test-fixture env vars (`STRIPE_TEST_CARD_*`, `MAIL_TM_BASE`, `TELEGRAM_*`) that aren't part of the public capability surface. Filtering them out would require a deny-list, defeating the point.
- The completeness test (planted required-list compared to `envTable()`) gives us drift safety without the complexity of code-generation.

### 8. Cache `list_capabilities` output across calls (in-memory, no M9-4)

Keep a module-level cached envelope; rebuild only when `process.env` changes. **Rejected** because the build cost is microseconds and detecting `process.env` changes is non-trivial (env can be mutated mid-process by other tools). Static rebuild every call is simpler and observably free.

## Schema impact

- `RESULT_SCHEMA_VERSION` 1.1.0 → 1.2.0 (additive minor per ADR-007).
- Five new public schemas (`ListCapabilitiesResult` + `ToolCapability` + `EnvVarDoc` + `CostEstimate` + `CacheInfo`) plus three internal building blocks (`ToolSideEffect` enum, `ToolRequirements`, `ServerInfo`).
- No existing envelope changed shape.

## Test strategy

- `tests/result-schema.test.ts` (+45 tests) — every new schema's happy path, unknown-enum / negative-number / missing-required-field rejections, the lower-bound (empty `tools` / empty `env`) `ListCapabilitiesResult` shape.
- `tests/mcp-registry.test.ts` (+7 tests) — every shipped tool has the four new metadata fields with valid values; cost band is well-formed; `network_egress ⇔ apiKeys non-empty`; `browser ⇒ navigation`; the cacheable matrix matches M9-4 design exactly.
- `tests/list-capabilities.test.ts` (29 tests) — registry projection (snake_case mapping, optional fields, schema validation); registry dispatch smoke (full MCP-side ToolResult parses against `ListCapabilitiesResultSchema`); envelope completeness (every env var the codebase reads has a row); secret-leak smoke (planted fake `ANTHROPIC_API_KEY` value never appears in output, while the *name* does); live cache reflection (toggling env var flips state).

## Files touched

- `src/core/result-schema.ts` — five new schemas, `RESULT_SCHEMA_VERSION` bump.
- `src/mcp/registry.ts` — four new fields on `ToolDefinition`.
- `src/mcp/tools/<name>.ts` × 11 — populate metadata.
- `src/mcp/tools/list-capabilities.ts` (new) — handler + `buildCapabilities` + `envTable`.
- `src/mcp/server.ts` — register in `ALL_TOOLS`.
- `scripts/export-result-schemas.ts` — wire new schemas; `npm run schemas` regen yields 30 schemas at 1.2.0.
- `tests/result-schema.test.ts` (+45) / `tests/mcp-registry.test.ts` (+7) / `tests/list-capabilities.test.ts` (new, 29).
- `docs/contracts/RESULT_SCHEMA.md` — version history line.
- `docs/architecture.md` — "MCP self-describe" section.
- `README.md` — "MCP server" section adds a `list_capabilities` row + use-case.
- `CHANGELOG.md` — Unreleased: "Added (M9-5)".

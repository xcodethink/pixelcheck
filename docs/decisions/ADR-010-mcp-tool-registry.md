# ADR-010 — MCP server modularization + tool registry

- **Status**: Accepted
- **Date**: 2026-04-28
- **Task**: M3-6 + M9-1 (MCP server 完整化 + tool surface 拆细)
- **Builds on**: ADR-002 (primitive-first architecture), ADR-007 (result schema versioning), ADR-009 (concurrency safety)

## Context

`src/mcp/server.ts` started life as a single 502-line file holding:

- The MCP transport lifecycle (Server, StdioServerTransport, secret bootstrap).
- The `ListTools` handler with the JSON Schema for every tool inlined.
- The `CallTool` dispatcher as a `switch (name)` over six handler functions.
- All six tool handlers themselves (`handleAuditUrl`, `handleExploreUrl`, `handleListPersonas`, `handleListScenarios`, `handleCalibrate`, `handleGetLastReport`).
- Shared helpers (`textResult`, `errorResult`, `stampedTextResult`, `requireString`, `resolvePersona`).

That layout shipped fine for v0.3 and let M9-2 / M5-6 / M9-3 land cleanly. But the v1 plan requires *more* MCP tools, not fewer:

- N-1 `see(url, opts)` — stand-alone observation primitive.
- N-2 `act(url, steps)` — stand-alone action primitive.
- N-3 `compare(a, b, criteria)` — A/B + critic primitive.
- N-4 `extract(url, schema)` — structured extraction primitive.
- M9-5 `list_capabilities` — self-describe meta tool.

Stuffing five more tools into the same `switch` and inlining five more JSON Schemas into the same file would push it past 1 000 lines and make it the kind of file no contributor wants to touch first. ADR-002's primitive-first vision *requires* that adding a new tool be a one-file change.

We also need a clean place to record information *about* each tool (its `kind` — preset / primitive / meta — and its result schema name) so that M9-5's `list_capabilities` can publish it to AI clients without the per-tool handlers having to know how that surfacing happens.

## Decision

Split `mcp/` into five files with sharply scoped responsibilities, plus one file per tool under `mcp/tools/`.

### File layout

```
src/mcp/
  server.ts          — transport lifecycle, dispatcher, ALL_TOOLS catalog
  registry.ts        — ToolDefinition + ToolRegistry class
  result.ts          — ToolResult, textResult, errorResult, stampedTextResult
  helpers.ts         — requireString, resolvePersona
  tools/
    audit-url.ts        (kind: preset)
    explore-url.ts      (kind: preset)
    list-personas.ts    (kind: meta)
    list-scenarios.ts   (kind: meta)
    calibrate-critic.ts (kind: meta)
    get-last-report.ts  (kind: meta)
```

`server.ts` shrinks from 502 lines to 148, holding only the bits that genuinely belong to "the MCP server process": secret bootstrap, registry assembly, ListTools mapping, CallTool dispatch (with `withCostRun` wrap from ADR-009 + try/catch), and the binary entry point.

### `ToolDefinition` shape

Each tool exports one `ToolDefinition` record:

```ts
interface ToolDefinition {
  name: string;                          // exposed over MCP tools/list
  description: string;
  inputSchema: Record<string, unknown>;  // raw JSON Schema
  kind: "preset" | "primitive" | "meta";
  resultSchema?: string;                 // matches docs/schemas/<slug>.schema.json
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}
```

The three `kind` discriminators are:

- **preset** — composed pipelines that wire several primitives together (today: `audit_url`, `explore_url`).
- **primitive** — single-capability building blocks (reserved for N-1~N-4).
- **meta** — introspection / discovery tools (today: `list_personas`, `list_scenarios`, `get_last_report`, `calibrate_critic`; future: `list_capabilities`).

### Adding a new tool

```
1. Write src/mcp/tools/<name>.ts that exports a ToolDefinition.
2. Push it into the ALL_TOOLS array in server.ts.
3. Done — ListTools and CallTool both pick it up automatically.
```

No switch-case edit, no inline schema in server.ts, no one-off plumbing. The reviewer can validate "this new tool is correct" by reading exactly one file.

### `ListTools` deliberately does NOT leak `kind` / `resultSchema`

The MCP spec's `Tool` shape is `{ name, description, inputSchema }`. Strict-validating clients may reject responses with unknown top-level fields. We keep `kind` and `resultSchema` on the registry record (where future M9-5 `list_capabilities` will read them) but the `ListTools` handler maps down to the spec subset:

```ts
tools: registry.list().map((d) => ({
  name: d.name,
  description: d.description,
  inputSchema: d.inputSchema,
})),
```

When M9-5 lands, `list_capabilities` will return the richer view via its own dedicated tool — no risk to existing clients.

### Registry is side-effect-free

`ToolRegistry` deliberately does NOT wrap handlers in `withCostRun` or try/catch. Those are transport-level concerns owned by `server.ts`. Keeping the registry pure means:

- Unit tests can iterate the catalog and call handlers without spinning up cost-guard scopes.
- `tests/mcp-registry.test.ts` asserts catalog invariants (every tool has a non-empty name + description, every `inputSchema` is object-shaped, every `kind` is legal, names are globally unique, every declared `resultSchema` matches a published JSON Schema in `docs/schemas/index.json`) — purely structural, no transport setup.

## Consequences

### Positive

- Adding the next tool (N-1 `see`, etc.) is a one-file change. ADR-002's primitive-first vision is now *physically* enforceable in code review.
- M9-5 `list_capabilities` becomes trivial: iterate `registry.list()` and emit the richer record (with `kind` + `resultSchema`).
- Catalog invariants are now machine-checked in CI — drift between a tool's declared `resultSchema` and the schemas committed to `docs/schemas/` will fail the test suite.
- `server.ts` is small enough that the cost-guard / dispatcher / lifecycle wiring is reviewable at a glance.
- Per-tool dynamic imports (heavy modules like `runner.js`, `reporter-spa.js`, `calibration/runner.js`, `history.js`) are preserved — `list_personas` / `list_scenarios` still have a fast cold start.

### Negative / accepted

- Six new files where there was one. Fragmentation cost is real but bounded (each file is < 130 lines and self-contained).
- Tests that previously imported helpers from `server.js` now import from `result.js` / `helpers.js`. We chose to update `tests/mcp-server.test.ts` rather than leave dead re-exports on `server.ts`, per the CLAUDE.md "no backwards-compatibility hacks" rule.
- The MCP `tools/list` payload omits `kind` / `resultSchema`, so until M9-5 ships there is no client-facing way to discover a tool's discriminator. That's acceptable — `list_capabilities` is the proper home for that info.

## Rejected alternatives

- **Auto-discover tools by globbing `mcp/tools/*.ts`** — would shave one line per new tool but breaks tree-shaking, hides the catalog ordering, and makes `ALL_TOOLS` un-grep-able. The explicit array in `server.ts` is the source of truth and serves as a doc of what's shipped.
- **Re-export all helpers from `server.ts` for backward compatibility** — would have let `tests/mcp-server.test.ts` keep its old import. Rejected: dead re-exports rot, and CLAUDE.md prohibits backwards-compatibility shims for unused indirection.
- **Embed `kind` / `resultSchema` as MCP `_meta`** — MCP supports a `_meta` extension field. We chose the safer "don't emit at all" path; M9-5 will surface them via `list_capabilities` instead. Avoids any chance of a strict-validating client tripping on unknown fields.
- **Have the registry own the `withCostRun` wrap** — would have let `server.ts` shrink further but mixed transport concerns into the registry. Kept the registry pure and side-effect-free for testability.

## Verification

- `tests/mcp-registry.test.ts` — 14 new tests covering registry class + ALL_TOOLS catalog invariants + smoke routing.
- `tests/mcp-server.test.ts` — 12 existing tests for the helpers (unchanged content, updated imports).
- `tests/mcp-concurrency-e2e.test.ts` — 2 existing tests for ALS + real stdio dispatch (unchanged, still green).
- Full suite: 399/399 pass. typecheck + build clean.
- Real stdio handshake: `node dist/mcp/server.js` returns 6 tools via `tools/list`.

## References

- [ADR-002](./ADR-002-primitive-first.md) — primitive-first architecture (this is the file-layout enforcement).
- [ADR-007](./ADR-007-result-schema-versioning.md) — `resultSchema` field points at schemas defined here.
- [ADR-009](./ADR-009-concurrency-safety.md) — `withCostRun` ALS scope wrapped around every dispatch.
- [src/mcp/server.ts](../../src/mcp/server.ts), [src/mcp/registry.ts](../../src/mcp/registry.ts), [src/mcp/tools/](../../src/mcp/tools/)

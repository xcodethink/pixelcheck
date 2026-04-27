# ADR-007 — Result schema versioning and the SemVer commitment

- **Status**: Accepted
- **Date**: 2026-04-27
- **Task**: M9-2 (Result schema 稳定承诺)
- **Builds on**: ADR-005 (structured logging), ADR-006 (secrets redaction)

## Context

The v3.0 plan makes the auditor an AI-first tool — primitives exposed via MCP, consumed by Claude Code / Cursor / Cline / external agents. Those consumers need a stable contract on the *output* shape of every tool call and library function, otherwise:

- An agent that worked yesterday silently miscomprehends today's responses.
- Internal refactors that look harmless (rename a field, move a sub-object) break consumers without anyone noticing until a bug report drifts in days later.
- The 19 result types currently in the codebase have zero version metadata; nothing tells a consumer whether the JSON it just parsed is "the shape it expected".

The 7.1 engineering discipline list explicitly requires "Public API SemVer (result schema 字段不能 breaking)" and the M9-2 task description requires "Zod / JSON Schema 定义所有 result 结构 + schema_version 字段 + breaking change 走 SemVer".

There were two design axes to settle:

1. **Embed vs envelope**: stamp `schema_version` directly onto each result, or wrap every payload in `{schema_version, kind, data}`?
2. **Observe vs enforce**: validate at output boundaries with `safeParse` (warn on drift) or `parse` (throw)?

## Decision

### Embed, don't envelope

`schema_version` is a top-level string field on every result *object*. Lists are not wrapped (they remain plain JSON arrays).

Reasons:

- Existing reporters, the SPA report, the SQLite history table, the Markdown summary all walk known top-level fields. Adding one more optional sibling is a non-event.
- An envelope changes the wire shape and would have rippled into every reader (CLI summary, HTML renderer, etc.). The point of M9-2 is to add a contract, not to break the world.
- Stripe / Anthropic SDK / GitHub all embed metadata flat; `data` envelopes are a GraphQL pattern we don't need.

### Single source of truth: `RESULT_SCHEMA_VERSION`

One SemVer string in one file (`src/core/result-schema.ts`) is stamped onto every emission. SQLite stores the per-row value in `audit_runs.schema_version`. JSON Schema artefacts in `docs/schemas/` carry it as `x-result-schema-version`. The constant in code is authoritative; everything else is derivable.

### SemVer policy (full text in `docs/contracts/RESULT_SCHEMA.md`)

- patch — type tightening / clarifications
- minor — additive only (new optional field, new enum tail, new schema)
- major — anything else (rename / remove / narrow / restructure)

### Observe-only validation at v1.0.0

`validateResult(name, schema, value)` runs `safeParse` and emits a structured `warn` line on mismatch. The producer's payload always flows through unchanged.

Reasons:

- The user asked for "不要边变更新边破坏". Flipping every output to `.parse()` on day one would mean: any minor field-shape divergence between the existing 11 result interfaces and the new Zod schemas (which were transcribed by hand) immediately throws inside production runs.
- Observe-then-enforce is the path Stripe / Anthropic / OpenAPI ecosystems take: ship the contract, watch for drift in real workloads, then escalate.
- A later patch release can tighten selected call sites to `.parse()` once the warn-line backlog is clean. Doing so doesn't itself require a major bump because conformant producers are already passing.

### MCP wire format unchanged

`ToolResult.content[0].text` still holds a JSON-stringified body. The body now opens with `schema_version` (for object responses; arrays are unchanged). No MCP client needs an upgrade — they were already parsing the body as JSON, and JSON is order-insensitive.

### SQLite migration v1 → v2

Adds one column: `audit_runs.schema_version TEXT NOT NULL DEFAULT '1.0.0'`. Legacy rows backfill to `'1.0.0'`. New inserts pass `audit.schema_version ?? RESULT_SCHEMA_VERSION`. The migration runs once on `openDb`, gated by `user_version`. No data is rewritten.

A more general migration framework is M5-7 in Wave G; we deliberately did not depend on it here. One ALTER, one default, one place — total 5 lines of SQL.

### JSON Schema artefacts are committed

`scripts/export-result-schemas.ts` (run via `npm run schemas`) emits 19 JSON Schemas + an `index.json` manifest under `docs/schemas/`. We commit the output so:

- External AI agents can fetch the contract directly via GitHub raw URL without cloning or running the package.
- Drift between source and artefacts is a CI-checkable property: if `npm run schemas` produces a diff, someone forgot to regenerate.

## Constraints applied

- All `schema_version` fields are optional in the Zod schemas (`SchemaVersionField` accepts `string | undefined`). Producers always set it; consumers must tolerate its absence in legacy fixtures and v0.x audit.json files on disk.
- `attachSchemaVersion(...)` is idempotent and never downgrades — if a producer already stamped a version, that wins. This makes it safe to call at multiple layers.
- `validateResult(...)` never throws. Even on totally malformed input (`null`, a string, a Buffer) it logs and returns the input unchanged. There is no path through the schema layer that can crash a running audit.
- The 19 schemas cover only the *public* result surface (audit, MCP tool envelopes, calibration / benchmark / mutation outputs, history entry). Internal-only types (`AutonomousRunResult`, `PlannerResult`, `MicroReplanResult`, `DiffResult`) are explicitly out of scope for v1.0.0; the N-* primitive work in Phase 1 will revisit them.

## Consequences

- The auditor now ships a versioned, machine-readable contract that AI agents can target. Adding a new MCP tool means: add the Zod schema, stamp version, run `npm run schemas`, write a CHANGELOG entry under "minor".
- Any consumer parsing `audit.json` or an MCP body can branch on `schema_version`. We make no breaking changes within `1.x.y`.
- The observe-only mode means schema bugs surface as warn lines, not failed audits. We accept that the first month or two of v1 traffic may produce a steady stream of warn lines as we close the gap between the hand-written interfaces and the schemas; that is the point.
- The SQLite column is small (`TEXT` defaulting to `'1.0.0'`) and the migration is a no-op on schemas already at user_version ≥ 2. The cost is negligible.
- The 19 committed JSON Schema files add ~30 KB to the repo and a tiny ongoing maintenance cost (regenerate after each schema edit). In return: external consumers can fetch the contract via GitHub raw URL with zero npm install. Net positive.

## Alternatives considered

- **Envelope every result** (`{schema_version, kind, data}`). Rejected — every existing reader assumes flat shape, and an envelope adds a layer of indirection without materially helping AI consumers.
- **Throw on schema drift at v1.0.0** (`schema.parse()` everywhere). Rejected — would risk breaking running audits the first time an interface and its hand-transcribed schema disagree by even a single optional field. observe-then-enforce is industry-standard for exactly this reason.
- **Defer JSON Schema export** (only Zod, no `docs/schemas/`). Rejected — AI consumers are not part of this codebase; they need the contract in a portable format, and JSON Schema is the lingua franca.
- **Wait for M5-7 migration framework** before adding the SQLite column. Rejected — this is one ALTER and one default; introducing a framework dependency for a 5-line migration would be over-engineering.
- **Bump existing `history.ts` SCHEMA_VERSION to overload it as the result version**. Rejected — that constant is a SQLite `user_version` integer, semantically distinct from the result schema's SemVer string. Conflating them would force lockstep evolution between DB shape and result shape.

## Notes

- The hand-transcribed Zod schemas are a v1.0.0 starting point. As validate-warn lines surface real divergences in production traffic, expect a series of patch releases that tighten the schemas — each with a CHANGELOG note but no SemVer bump unless the *consumer-visible* shape changes.
- When the first major bump arrives, we will freeze the v1 schemas under `docs/schemas/v1.x/` and start emitting v2 from `RESULT_SCHEMA_VERSION = "2.0.0"`. The `index.json` will gain a `previous_versions` field. None of that is needed today.

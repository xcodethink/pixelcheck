# ADR-018 — Public API contract tests (M1-5)

- **Status**: Accepted
- **Date**: 2026-05-01
- **Task**: M1-5 — Public API contract tests
- **Builds on**: ADR-007 (result schema versioning + SemVer policy), ADR-010 (MCP tool registry — `tests/mcp-registry.test.ts` already enforces per-tool resultSchema cross-reference)

## Context

By the end of M1-2 Phase 2, the codebase has:

- 30 published JSON Schemas at `docs/schemas/*.schema.json`, generated from `src/core/result-schema.ts` via `npm run schemas` (M9-2)
- A SemVer-stamped `RESULT_SCHEMA_VERSION = "1.2.0"` constant cited in 4 places: the source file, every individual schema's `x-result-schema-version`, the registry index `docs/schemas/index.json`, and `docs/contracts/RESULT_SCHEMA.md`
- A `src/index.ts` re-export of 40 names that downstream consumers compile and import against
- `tests/result-schema.test.ts` with ~120 Zod-based unit tests verifying *in-process* schema correctness
- `tests/mcp-registry.test.ts` with one cross-reference test (every MCP tool's `resultSchema` name appears in `index.json`)

What's missing is the *external consumer* perspective. An agent or SDK using the published schemas validates with **Ajv** (the standard JSON-Schema-Draft-7 validator), not Zod. A Zod schema can pass but its derived JSON Schema can be lossy or wrong; the registry index can drift from the schema files; the version stamps can fall out of sync; an accidental rename in `src/index.ts` can ship without anyone noticing.

These are precisely the failure modes that bite a `@public` API after the third or fourth contributor lands a "small refactor".

## Decision

Add two test files that guard the external contract surface, plus the `ajv` and `ajv-formats` dev deps to enable Draft-7 validation:

### `tests/public-api-contract.test.ts` — registry / structural integrity (45 tests)

Four sections:

1. **`docs/schemas/index.json` registry integrity** (6 tests) — valid `SchemaIndex` shape, references every shipped `*.schema.json` (no orphans), no dangling entries (every referenced file exists), unique slugs and unique file references, exactly **30 schemas at v1.2.0** (review checkpoint), every entry has non-empty slug/title/description/file.

2. **Per-schema Draft-7 validity** (34 tests = 30 compile + 4 metadata) — Ajv `compile()` cleanly for every shipped schema (catches structurally invalid Draft-7), every schema declares `$schema = "http://json-schema.org/draft-07/schema#"`, every schema has a `$id` pointing at its `docs/schemas/<file>` location, every schema has a non-empty `title`, every schema's `x-result-schema-version` equals `RESULT_SCHEMA_VERSION` (Ajv's `strict: false` tolerates this `x-` extension).

3. **Cross-document version coherence** (4 tests) — `RESULT_SCHEMA_VERSION` matches `index.json`'s `x-result-schema-version`, is a valid `X.Y.Z` SemVer string, matches the version cited in `docs/contracts/RESULT_SCHEMA.md`, and every individual published schema's version field agrees.

4. **Schema regeneration idempotence** (1 test) — every on-disk schema file matches a fresh `JSON.parse + 2-space JSON.stringify` of itself. Catches accidental hand-edits, missing trailing newlines, or formatter drift between contributors.

### `tests/public-api-samples.test.ts` — sample-driven validation + surface snapshot (107 tests)

Three sections:

1. **Public surface snapshot** (40 tests) — pin the runtime export set of `src/index.ts`. The 40 names are listed explicitly so add/remove trips a review checkpoint. Each function export verified callable; each Zod-schema export has `.parse` + `.safeParse`; `AgentEventBus` verified constructable.

2. **Sample-driven Ajv validation** (61 tests = 30 valid + 30 invalid + 1 coverage check) — every shipped schema gets a minimally-conformant sample (Ajv MUST accept) and a deliberate violation (Ajv MUST reject). Catches the failure mode where a schema compiles but doesn't constrain anything. The samples are copied from `tests/result-schema.test.ts` where they exist (so "what Zod accepts, Ajv accepts too") or constructed from the schema's required-field list otherwise. A coverage assertion at the top requires `SAMPLES` and the on-disk `*.schema.json` files to agree bidirectionally.

3. **Zod ↔ Ajv equivalence** (4 tests) — same payload validates (or fails) under both validators on representative payloads, closing the "in-process Zod producer ⇒ external Ajv consumer" pipeline end-to-end.

### Dependency

- `ajv` ^8.20.0 — Draft-7 validator. Configured with `strict: false` to tolerate the `x-result-schema-version` custom keyword (the recommended escape hatch for non-standard JSON Schema metadata per IETF Internet-Draft).
- `ajv-formats` ^3.0.1 — wires the standard string formats (`date-time`, `email`, `uri`, etc) so schemas using `format: "uri"` compile without warnings.

Both dev-only.

## Alternatives rejected

1. **Reuse Zod for external validation** — `result-schema.test.ts` already does this. But Zod is what the producer uses; the contract under test here is what an *external* consumer (e.g. a Python SDK reading the JSON Schemas) sees. They'll use Ajv-equivalent validators. Reusing Zod would never catch derivation bugs in `zod-to-json-schema` — and we've already shipped two minor versions through it.
2. **Skip the sample-driven half — Draft-7 compile is enough** — A schema can compile cleanly and still constrain *nothing* if `required` is empty and `additionalProperties` defaults to `true`. The "deliberately invalid" half of each sample pair is what catches that. Without it the test suite would let a regression like "deleted the `enum` constraint" through.
3. **Auto-derive samples from Zod via `z.parse(z.faker(...))`** — Tempting, but fakers default to "anything that satisfies the type" which produces samples that are *technically* valid but not minimally-conformant. We want the smallest passing object so future contributors can see the contract floor at a glance. Hand-curated samples are 200 lines once; auto-faker would be a 20-line generator with weeks of debugging "why did the faker produce a 1568-character UUID".
4. **Per-tool API contract tests for the MCP `tools/call` envelope** — Already covered by `mcp-registry.test.ts > "every declared resultSchema matches a published JSON Schema"` plus `tests/list-capabilities.test.ts > "stamped envelope parses back into the schema"` from M9-5. Adding a third pass would duplicate.
5. **CLI `--help` snapshot tests** — Tempting (regression catches accidental flag drops), but the CLI surface isn't part of the published API contract — it's a UI. The MCP tool list is the structured surface; CLI gets human review on each PR.
6. **Strict Ajv mode (no unknown keywords)** — Would force us to choose between dropping `x-result-schema-version` (loss of in-band version stamp) or registering it as a custom keyword (scope creep into Ajv plugin land). `strict: false` is the documented pattern from the Ajv docs for `x-` extension keywords.
7. **Snapshot the entire JSON Schema files into `tests/snapshots/`** — Brittle (whitespace / property order), and `git diff` already does this on PR review. The `JSON.parse + 2-space JSON.stringify` idempotence test catches the same drift signal at a fraction of the maintenance cost.
8. **Track historical schemas under `docs/schemas/v1.0.0/`, `v1.1.0/`** — Spec'd in `RESULT_SCHEMA.md §9` as out-of-scope until the first major bump. Adding it now is premature; deferred until v2.0.0 lands.

## Consequences

- External SDK consumers (and ourselves writing one in the future) have a binding contract: every schema in `docs/schemas/` validates the producer's output, has a stable `$id`, and agrees with the version constant.
- `npm run test:coverage:check` now catches: schema deletion without index update, version stamp drift, accidental relaxation of an `enum` or `required`, accidental tightening of a numeric range, and renames/removals from `src/index.ts`.
- Adding a new schema requires three coordinated edits: (a) the Zod schema in `result-schema.ts`, (b) `npm run schemas` to regenerate the file + index, (c) a sample pair in `public-api-samples.test.ts`. The test suite enforces all three.
- 1132 tests total, +152 over M1-2 Phase 2 close. No new src/ logic — these are read-only contract tests.

## Files added / changed

- `tests/public-api-contract.test.ts` (new — 45 tests)
- `tests/public-api-samples.test.ts` (new — 107 tests)
- `package.json` / `package-lock.json` — `ajv` ^8.20.0, `ajv-formats` ^3.0.1 dev deps

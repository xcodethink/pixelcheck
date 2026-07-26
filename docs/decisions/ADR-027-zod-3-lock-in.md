# ADR-027 — Lock to Zod v3 for v1.0 (defer the Zod v4 upgrade)

- **Status**: Accepted
- **Date**: 2026-05-01
- **Task**: T0.5 (Wave 0 dependency upgrade)

## Context

`npm outdated` reports Zod at 3.25.76 with 4.4.1 available. Zod v4 is a major
release.

Zod's surface inside this project is unusually wide:

- All 30 published JSON Schemas are generated from Zod schemas via
  `zod-to-json-schema`.
- `RESULT_SCHEMA_VERSION = "1.2.0"` is a public commitment (ADR-007).
- Every `safeParse` / `parse` call site — runner, handlers, MCP tools,
  reporters, config, personas, scenarios — over 100 by grep.
- `tests/public-api-contract.test.ts` locks Ajv ↔ Zod equivalence.
- 67 public API exports include schema types (`AuditRunSchema`, `IssueSchema`,
  and so on).

## Zod v4 breaking changes (survey)

1. `.parse()` error object shape changes (`ZodError.issues` is restructured).
2. `z.record()` signature changes.
3. Some validator APIs, such as `z.string().email()`, change signature.
4. Chained `transform` / `refine` behaviour shifts in detail.
5. `zod-to-json-schema`, a third-party package, is not guaranteed to be
   v4-compatible immediately.
6. Type inference is rewritten, so some edge-case inferred types differ.

Upgrading would require reviewing 100+ call sites, verifying or replacing
`zod-to-json-schema`, regenerating all 30 published JSON Schemas and
re-confirming Ajv ↔ Zod equivalence, and making a SemVer call on whether the
result schema goes 1.2 → 2.0. Estimated 8–12 hours, against the 4 hours budgeted
for T0.5.

## Decision

**v1.0 locks to the latest Zod 3.25.x minor. The v4 upgrade is deferred to a
v1.1.x evaluation.**

- `package.json` keeps `"zod": "^3.25.76"`, so 3.x patches are still picked up
  automatically.
- The v4 upgrade is tracked as its own task in the risk register.
- Re-evaluate when any of these hold: (a) Zod v3 goes maintenance-only or gets a
  critical CVE; (b) there is a concrete need for a v4-only feature; (c)
  `zod-to-json-schema` ships a stable v4-compatible release.
- The release notes and migration guide state plainly that v1.0 ships with Zod
  v3.

## Alternatives rejected

1. **Upgrade to Zod v4 now** — blows up the T0.5 scope from 4 to 12+ hours,
   blocks the critical vulnerability fixes v1 needs, and introduces a large
   under-tested change.
2. **Pin an exact version** (`"zod": "3.25.76"`, no caret) — loses automatic 3.x
   patches, including security-relevant ones. Over-conservative.
3. **Fork Zod and pin a known-good fork** — an unsustainable maintenance burden
   for a single-maintainer project.
4. **Drop the Zod runtime and use Ajv only** — a larger rewrite, and it gives up
   TypeScript inference that has no equivalent.

## Consequences

- Every Zod schema in v1.0 has v3 runtime and type behaviour.
- Consumers importing `{ AuditRunSchema, type AuditRun }` get Zod v3 types, and
  that stays true across v1.x.
- The Result Schema 1.2.0 SemVer commitment is unaffected: it is anchored to the
  published JSON Schemas and field semantics, not to the Zod library version.
- When the v4 upgrade is evaluated in v1.1, it carries its own SemVer decision:
  if `parse(input)` behaviour is unchanged for existing consumers it is a v1.x
  minor; if it breaks, it forces v2.0.

## Signals that should trigger a re-review

- Zod v4 stable *and* a v4-compatible `zod-to-json-schema` release, together.
- A CVE in Zod v3 with no v3 patch forthcoming.
- Demand for a v4-only feature, such as the new metaprogramming API.
- Enough other accumulated v1.x changes to justify doing the upgrade alongside
  them.

## Files changed

- `package.json` — `"zod": "^3.25.76"` (unchanged)
- `docs/decisions/ADR-027-zod-3-lock-in.md` (this file)
- Risk register — added the Zod v4 upgrade evaluation task

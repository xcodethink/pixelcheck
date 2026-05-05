# Result Schema — Stability Contract

> **Status**: stable (v1.3.0) — applies to every result the auditor emits to AI agents and external consumers.
> **Source of truth**: [`src/core/result-schema.ts`](../../src/core/result-schema.ts)
> **Generated artefacts**: [`docs/schemas/`](../schemas/) (Draft-7 JSON Schema files, regenerable via `npm run schemas`)
> **Related ADRs**: [ADR-007](../decisions/ADR-007-result-schema-versioning.md), [ADR-015](../decisions/ADR-015-result-cache.md), [ADR-034](../decisions/ADR-034-multidimensional-result-envelope.md)
> **Tasks**: M9-2 (initial), M9-4 (1.1.0 — added optional `cache` field on primitive envelopes), M9-5 (1.2.0 — added `list_capabilities` envelope and supporting schemas), Phase 0 / ADR-034 (1.3.0 — added `diagnostics` envelope on primitive results)

This document is the long-form spec for the `RESULT_SCHEMA_VERSION` SemVer string and the rules for evolving it. The TL;DR lives in `result-schema.ts`; everything below is binding.

---

## 1. What is a "result"?

A result is any structured payload the auditor emits to a consumer who is *not* the producer. Concretely:

- The `audit.json` written by the JSON reporter (and its in-memory `AuditRun`)
- Every MCP tool's response body (the JSON inside `ToolResult.content[0].text`)
- The `BenchmarkReport` / `BenchmarkTaskResult` JSON that benchmark runs leave in `reports/benchmark/<tag>/`
- The `CalibrationReport` and `GateResult` from the calibration runner
- The `MutationResult` returned from `generateMutations`
- `HistoryEntry` rows surfaced through `loadHistory` and the `get_last_report` MCP tool

Internal-to-internal data structures (e.g. `AutonomousRunResult`, `PlannerResult`, `MicroReplanResult`, `DiffResult`) are **not** part of the contract for v1.0.0. They may change without bumping `RESULT_SCHEMA_VERSION`.

## 2. The version

```ts
export const RESULT_SCHEMA_VERSION = "1.3.0";
```

### Version history

- **1.0.0** — initial release (M9-2). 19 schemas covering audit / critic / gate / benchmark / mutation / MCP envelopes / history.
- **1.1.0** (additive minor) — added optional `cache?: ResultCacheMeta` field on the five primitive result envelopes (`SeeResult`, `ActResult`, `ExtractResult`, `JudgeResult`, `CompareResult`) so the M9-4 result cache can annotate hits/misses without breaking 1.0.0 consumers. Schema count 19 → 25 (cumulative incl. primitive envelopes added in N-1/2/3/4/8 plus the new `ResultCacheMeta`). See [ADR-015](../decisions/ADR-015-result-cache.md).
- **1.2.0** (additive minor) — added the M9-5 self-describe envelope and its building blocks: `ListCapabilitiesResult` + `ToolCapability` + `EnvVarDoc` + `CostEstimate` + `CacheInfo`. The new `list_capabilities` MCP tool is the proper exit for fields kept off the spec-level `tools/list` (kind, cacheable, cost band, side-effects, dependencies). No existing envelope changed shape. Schema count 25 → 30. See [ADR-016](../decisions/ADR-016-mcp-self-describe.md).
- **1.3.0** (additive minor) — added optional `diagnostics?: DiagnosticsSchema` field on four primitive result envelopes (`SeeResult`, `ActResult`, `ExtractResult`, `CompareResult`). Carries multi-dimensional audit data: `popups`, `network`, `cookies`, `storage` (PR-B fills), `performance` (PR-C), `visual` (PR-D). Sub-schemas in this release are intentionally permissive placeholders (`passthrough()`); subsequent PRs in Phase 0 fill concrete fields without further version bumps. No existing envelope or field changed shape. See [ADR-034](../decisions/ADR-034-multidimensional-result-envelope.md).


Stamped at the top of every emitted result object via `attachSchemaVersion(...)` and validated against the corresponding Zod schema by `validateResult(...)`. The constant is the **single source of truth** — every emitted artefact (audit.json, MCP responses, benchmark/calibration JSON, generated JSON Schemas, the SQLite `audit_runs.schema_version` column) reflects this value.

## 3. SemVer policy

| Bump  | When                                                                                       | Examples                                                                                          |
| ----- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| patch | Type tightening / clarifications that any conformant payload still satisfies               | Tighter regex on a string field; documenting a previously-undocumented invariant                  |
| minor | Pure additions — new optional field, new enum value at the end, new schema for a new tool   | Add `agent_summary.replan_count`; add a new MCP tool envelope; add `step_type: "wait_for_idle"`   |
| major | Anything else: rename, remove, type narrowing, restructuring, semantics change             | Rename `costUsd` → `cost_usd` on `CriticResult`; require a previously-optional field; flip a list to an object |

A consumer reading version `X.Y.Z` MUST tolerate any later `X.Y'.Z'` where `Y' ≥ Y`, with the understanding that:

- New fields may appear and SHOULD be ignored if unused.
- Existing fields keep their meaning and type.
- Existing enum values keep their meaning; new values may appear at the end of the list.

A consumer reading version `X.Y.Z` MUST NOT assume forward compatibility across a major boundary (`X+1.*.*`); it should refuse or down-grade gracefully.

## 4. What MAY change without a bump

These can change at any time without bumping `RESULT_SCHEMA_VERSION`:

- Internal pipeline behavior, log lines, or telemetry
- Wording in `description`, `recommendation`, `justification`, error strings
- The exact ordering of array elements (consumers must not rely on order beyond what the schema documents)
- Internal-only types listed in §1
- Generated JSON Schema phrasing in `docs/schemas/` so long as the structural contract is unchanged

## 5. What MUST trigger a bump

| Change                                                        | Bump  |
| ------------------------------------------------------------- | ----- |
| Add a new optional field                                      | minor |
| Add a new required field on a freshly introduced result type  | minor |
| Add a new enum value                                          | minor |
| Make an optional field required                               | major |
| Rename a field                                                | major |
| Remove a field                                                | major |
| Narrow a field's type (e.g. number → integer)                  | major |
| Replace an enum with a different one                          | major |
| Restructure a sub-object                                      | major |
| Drop a result type                                            | major |

When in doubt, treat it as major. The cost of a major bump is paid once; the cost of breaking a downstream agent silently is paid forever.

## 6. Validation modes

`result-schema.ts` exposes `validateResult(name, schema, value)`. At v1.0.0 this is **observe-only**:

- Every output boundary calls it (`stampedTextResult` in MCP, future call sites in CLI / library / DB read).
- A mismatch logs a structured `warn` line carrying the offending path / code / message and the version stamp.
- The producer's payload still flows through unchanged. The auditor never refuses to return a result because of schema drift.

This mirrors the Stripe / Anthropic SDK pattern: ship the contract, watch for drift, then escalate to enforcement once the calibration period proves zero false positives. A future minor or patch release MAY flip selected call sites to `.parse()` (throw on mismatch); doing so does not itself require a major bump because conformant producers are already passing.

## 7. Ground truth

When the spec on this page disagrees with `src/core/result-schema.ts`, the code wins and this doc is wrong — please open a PR.

When the generated `docs/schemas/*.json` files disagree with `src/core/result-schema.ts`, the source wins and the artefacts are stale — run `npm run schemas` to regenerate.

## 8. How to bump (operational checklist)

1. Edit the affected schema in `src/core/result-schema.ts`.
2. Bump `RESULT_SCHEMA_VERSION` per the table in §3.
3. Update producer tests / fixtures that depend on the new shape.
4. Run `npm run schemas` to regenerate `docs/schemas/*.json` and `docs/schemas/index.json`.
5. Run `npm test` — must be all green.
6. Add an entry to `CHANGELOG.md` under the upcoming release section, citing the old → new version and the change category (patch / minor / major).
7. For a major bump only: write a short migration note that names every field that moved or disappeared and what the consumer should do instead.

## 9. Out of scope (for v1.0.0)

- A registry of historical schemas (`schemas/v1.0.0/`, `schemas/v0.x/`). When the first major bump lands we will keep the previous version's frozen JSON Schemas in a sibling directory.
- Per-tool schema negotiation (consumer asks the MCP server for a specific version). MCP `list_capabilities` will surface `RESULT_SCHEMA_VERSION` in M9-5; richer negotiation can come later if the need is real.
- Auto-migration of historical `audit.json` from v0.x to v1.0.0. The SQLite migration backfills `schema_version = '1.0.0'` for existing rows; on-disk JSON files are left as-is.

## 10. The current contract surface

Generated JSON Schemas live at [`docs/schemas/`](../schemas/). Index: [`docs/schemas/index.json`](../schemas/index.json).

| Schema                    | File                                       | Producer                                          |
| ------------------------- | ------------------------------------------ | ------------------------------------------------- |
| AuditRun                  | `audit-run.schema.json`                    | `runAudit` (`src/core/runner.ts`)                  |
| ScenarioRunResult         | `scenario-run-result.schema.json`          | runner (nested under AuditRun)                    |
| StepResult                | `step-result.schema.json`                  | step handlers + agent-loop                        |
| Issue / DimensionScore    | `issue.schema.json`, `dimension-score.schema.json` | runner / critic                          |
| ConsoleError              | `console-error.schema.json`                | Playwright capture                                |
| CriticResult              | `critic-result.schema.json`                | `runCritic` (`src/core/critic.ts`)                 |
| GateResult                | `gate-result.schema.json`                  | `scoreReport` (`src/calibration/runner.ts`)        |
| CalibrationReport         | `calibration-report.schema.json`           | `aggregateReport` (`src/calibration/runner.ts`)    |
| BenchmarkReport           | `benchmark-report.schema.json`             | `summarize` (`src/benchmark/runner.ts`)            |
| BenchmarkTaskResult       | `benchmark-task-result.schema.json`        | benchmark runner                                  |
| MutationResult            | `mutation-result.schema.json`              | `generateMutations` (`src/core/instruction-mutator.ts`) |
| AuditUrlResult            | `audit-url-result.schema.json`             | MCP `audit_url`                                   |
| ExploreUrlResult          | `explore-url-result.schema.json`           | MCP `explore_url`                                 |
| CalibrateCriticResult     | `calibrate-critic-result.schema.json`      | MCP `calibrate_critic`                            |
| ListPersonasResult        | `list-personas-result.schema.json`         | MCP `list_personas`                               |
| ListScenariosResult       | `list-scenarios-result.schema.json`        | MCP `list_scenarios`                              |
| HistoryEntry              | `history-entry.schema.json`                | `loadHistory` / MCP `get_last_report`             |
| PersonaSummary            | `persona-summary.schema.json`              | nested under ListPersonasResult                   |

When the next schema lands, add a row here.

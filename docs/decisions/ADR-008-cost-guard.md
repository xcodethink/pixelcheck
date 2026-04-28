# ADR-008 — Process-wide cost guard with persistent daily ledger

- **Status**: Accepted
- **Date**: 2026-04-28
- **Task**: M5-6 (Cost guard, redefined for single-tool use)
- **Builds on**: ADR-005 (structured logging), ADR-007 (result schema versioning)

## Context

The v0.3 runner already had a `budget_usd` setting that stops the unit scheduler from spawning new audit units once cumulative cost exceeds a threshold. Two gaps in that design forced a broader cost cap:

1. **Scheduler-only**. The `budget_usd` check fires *between* units. A single computer-use loop or instruction-mutator path inside one unit can burn an unbounded amount of tokens before the next scheduling decision is made. Unit-level enforcement is too coarse for interactive AI workflows.

2. **Audit-only**. The MCP server exposes six tools (and v1 will add primitives `see` / `act` / `extract` / `compare`); none of them go through the runner's scheduler. A Claude Code session that calls `audit_url` six times in a row is six independent audits — each capped, but with no across-call protection. Forgotten loops in calibration runs or copy-paste mistakes have already cost real money.

The redefined M5-6 in v3.0 (`本地 cost guard：单次 / 单日 token + USD 上限，超限自动停`) explicitly asks for both layers — a single-run cap *and* a persistent daily cap that survives process restarts.

There were three design axes to settle:

1. **Where to hook**: at every `messages.create` call site, or only at one wrapper?
2. **In-memory only vs persistent ledger**: how do "per-day" totals survive a restart or a second concurrent process?
3. **Pre-check vs post-record**: throw before the request, or after the response?

## Decision

### Hook at every call site, not just the wrapper

The `callVision` helper covers some paths but not all. Three modules call `client.messages.create()` (or `c.beta.messages.create()`) directly: `core/computer-use.ts`, `core/instruction-mutator.ts`, `agent/planner.ts`, `agent/navigator.ts`. Routing all of those through `callVision` was considered and rejected — they have legitimately different shapes (tools, streaming, beta headers, no-image variants). Forcing a single signature would either bloat the wrapper or push the divergence into option-parsing.

Instead, every site that today calls `estimateCost(...)` to update a cost counter now also calls `getCostGuard().checkBudget()` before the request and `getCostGuard().recordUsage(...)` after. This is mechanical (six edits) and makes the contract obvious at the call site rather than hiding it in a wrapper. Convergence's `checkVisualCriterion` is unmodified because it goes through `callVision`, which is wrapped.

### Persistent JSON ledger keyed by UTC day

Per-day totals live in `~/.ai-browser-auditor/cost-ledger.json` (override via `AUDIT_COST_LEDGER_PATH`). Schema:

```json
{
  "schema_version": "1.0.0",
  "days": {
    "2026-04-28": { "input_tokens": 12345, "output_tokens": 6789, "usd": 0.123 }
  }
}
```

Considered and rejected:

- **SQLite**: heavier dependency than needed for a single counter per day. The existing `~/.ai-browser-auditor/plan-cache.db` is already in use; cost data being separate makes it trivial to clear without losing planner cache.
- **In-memory + file flush at exit**: lost data on crash, doesn't share across concurrent processes (a Claude Code window calling `audit_url` while a CLI run is going).
- **Process-shared mmap / lockfile**: overkill for a single-developer tool; the ledger uses last-write-wins with atomic temp + rename. If two writes race, we may lose a few tokens of recording — acceptable for a soft budget cap, not a billing system.

Atomic write: `writeFileSync(<path>.<pid>.tmp)` then `renameSync` ensures the visible file is always either pre-write or post-write — never half-written. A malformed file (manual edit gone wrong, partial flush in a previous tool version) is logged at warn and treated as empty so audits don't get bricked by a corrupted ledger.

The ledger auto-prunes entries older than 30 days at the next write — the file is bounded.

### Stamp the ledger with `schema_version`, follow M9-2 SemVer policy

`COST_LEDGER_SCHEMA_VERSION = "1.0.0"`. If we ever change the ledger shape (e.g. add per-model breakdown), it bumps following the same SemVer rules as result schemas (additive optional → minor; rename / remove → major). The version is distinct from `RESULT_SCHEMA_VERSION` because the ledger is internal state, not a result the auditor emits.

### Both pre-check and post-record can throw

Symmetric enforcement:

- `checkBudget()` *before* the request reads the current state and throws `BudgetExceededError` if any cap is already met. Cheap (only reads ledger when called).
- `recordUsage()` *after* the response updates run + day counters and throws if this single response straddled the cap. Returning the response was kept (it's already paid for) and only the next iteration is blocked.

This catches both the "second call would push us over" case and the "single huge call blew the cap by itself" case, without baking the request size into the pre-check (input tokens aren't known until the response).

`recordUsage` returns `{ usd, runUsd, dailyUsd }` so callers that want to surface cost in their own UI (the existing `cost.value += ...` pattern in agent/planner.ts) keep working without reading the snapshot.

### Reset semantics

- **`resetRun()`** is called at exactly two entry points: `runAudit()` at the start of an audit run (covers `pixelcheck audit ...` CLI), and the MCP `CallToolRequestSchema` dispatcher at the start of every tool call (covers `audit_url`, `explore_url`, `calibrate_critic`, and the upcoming v1 primitives `see` / `act` / `extract` / `compare`).
- **Daily totals never reset programmatically** — they roll over at UTC midnight when the day key changes. Tests use a `now` injection seam to verify rollover.
- **Singleton lifetime is process-wide.** A second `runAudit` call in the same process inherits zero run-cost (resetRun) but the same daily ledger.

### Disable switch for tests / CI

`AUDIT_COST_GUARD_DISABLED=1` makes every method a no-op. Used by:

- `npm test` — test fixtures should never write to the real `~/.ai-browser-auditor` directory. (Unit tests inject explicit `ledgerPath` to a tmpdir; the env var is a belt-and-braces cover for tests that exercise paths without explicit injection.)
- CI runs that want to assert success without budget enforcement.
- One-off intentional bursts ("I know I'm spending $100 on calibration").

## Consequences

**Positive**

- Six call sites are now self-evidently cost-guarded — a code reviewer sees `guard.checkBudget()` and `guard.recordUsage(...)` next to every `messages.create()`. No hidden indirection.
- Daily ledger is shared across CLI, MCP server, and any concurrent Claude Code window — three Claude Code tabs can't independently spend $5 each and walk away $15 lighter.
- Future v1 primitives (`see` / `act` / `extract`) inherit the guard for free as long as they go through `callVision` or call the singleton.
- Auto-prune means the file never grows unbounded.

**Negative**

- Six edits, not one. Adding a new LLM call site requires remembering to add the two guard calls. Mitigation: the existing `estimateCost` import is the smoke signal — every place that imports `estimateCost` should also have `getCostGuard` next to it. (Future task: a lint rule could enforce this.)
- The atomic-write strategy is single-pass; a parallel writer could overwrite the just-written file with a slightly older copy. Acceptable trade-off for a budget cap, not for accounting.
- Per-day rollover happens at UTC midnight, not local midnight. Documented in README and the env-var table; not adjustable.

**Reversible**

- Setting `AUDIT_COST_GUARD_DISABLED=1` opts out completely without code changes.
- The ledger file can be deleted by the user at any time; it will be recreated on the next run.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Per-call estimated-cost pre-check | Input tokens unknown before the response; would have to estimate from prompt length (lossy and SDK-specific). |
| Hard-cap by killing the process | Throws an error the caller can catch — not the same as `process.exit`. The error type (`BudgetExceededError`) lets reporters surface cost trips as a normal "stopped" status instead of a crash. |
| Track cost per scenario / per persona | Out of scope for M5-6; the current `cost.value` per-unit accounting in runner.ts already provides this for reporting. |
| Hybrid in-memory + sync to disk every N records | Optimization for a non-bottleneck. JSON write per LLM call is in the noise compared to the API round-trip. |
| Use a hosted billing tracker (LangSmith / Helicone) | The redefined M5-6 explicitly says *local* cost guard — no SaaS dependency. |

## Related

- ADR-005 (structured logging): cost guard logs every record at `debug` and every trip at `warn`.
- ADR-007 (result schema versioning): ledger is stamped with `schema_version: "1.0.0"` following the same SemVer rules.
- Existing `runner.budgetUsd`: complementary, not replaced.

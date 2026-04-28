# ADR-009 — Concurrency safety for shared mutable state

- **Status**: Accepted
- **Date**: 2026-04-28
- **Task**: M9-3 (Concurrent run safety)
- **Builds on**: ADR-008 (cost guard daily ledger)

## Context

PixelCheck is now used in two modes that can both touch shared state at the same time:

1. **Multiple CLI processes** — Wayne sometimes runs an audit in one terminal, then kicks off a second `pixelcheck audit` in a parallel terminal while the first is still running. Both processes write the same JSON cost ledger and SQLite memory DB.
2. **Single MCP server, multiple tool calls** — when an MCP server hosts the project's tools, an MCP client (Claude Code) may issue two `audit_url` calls back-to-back without waiting for the first to return. Both calls share one Node.js process, and any module-level singleton state (like the cost guard's per-run counters) is shared between them.

ADR-008 explicitly punted on this with a *"last-write-wins, soft cap"* note. With the v1 push to AI-first usage and concurrent MCP fan-out, that's no longer enough — we now need real isolation, not "acceptable for a single-developer tool."

After auditing the codebase, four hazards mattered:

| # | Resource | Hazard |
|---|---|---|
| H1 | `cost-ledger.json` | Read-modify-write race across processes drops daily-spend updates. Atomic temp+rename prevented torn writes but not lost ones. |
| H2 | `CostGuard.run` field (singleton) | Two parallel MCP tool calls in one server process clobber each other's per-run counters. The first call's run-USD cap effectively disappears. |
| H3 | `memory.db` `record()` | SELECT-then-INSERT/UPDATE pattern. Two concurrent processes inserting the same fact_hash both pass the existence check, both INSERT, second throws on the UNIQUE constraint. |
| H4 | Visual diff baseline first-run | Both processes pass `!fs.existsSync(baseline)`, both `copyFileSync` to the same path, last write wins. Baseline contents become non-deterministic. |

Two further hazards were investigated and decided "no fix needed":

- **Plan-cache `recordOutcome` increment** — the original Explore-agent report flagged this as a race, but `UPDATE plan_cache SET col = col + 1 WHERE key = ?` is one SQLite statement and is atomic via the implicit transaction. No fix.
- **Report `runDir`** — `runId` is `<timestamp>_<projectName>` with millisecond precision. Two parallel runs in the same process have monotonic timestamps and collide only if started in the same millisecond, in which case they share `outputRoot/runDir` *intentionally*. Documented; no code change.

## Decision

Four targeted fixes, each with its own commit:

### H1 — Cross-process file lock (`src/core/file-lock.ts`)

A new `withFileLock(lockPath, fn)` / `withFileLockSync` helper holds a critical section across processes. Acquired by writing identity to a per-process temp file, then `fs.linkSync(tmp, lockPath)` — `linkSync` is atomic and fails with `EEXIST` if any process already holds the lock. That two-step pattern guarantees the lockfile is *fully written* before any other process can observe it (the naive `O_EXCL`-then-`writeSync` pattern leaves a window where the file exists empty).

Stale-lock self-healing: a holder is treated as abandoned if its pid is dead (`process.kill(pid, 0)` throws ESRCH) or its `acquiredAt` timestamp is older than `staleAfterMs` (default 30 s). That prevents a crashed process from blocking the lock forever.

CostGuard.recordUsage now wraps the load-prune-mutate-write of the ledger in `withFileLockSync(<ledgerPath>.lock, …)`. Three child processes hammering the ledger 15 times each converge to exactly 45 entries — verified in `tests/cost-guard-concurrency.test.ts`.

Rejected alternatives:

- **`proper-lockfile`** — well-known package; would have done the job. Skipped to keep the dep tree small and avoid adding a runtime dep for a 200-line helper.
- **fcntl `flock`** — POSIX advisory lock, requires native bindings on Mac. The `linkSync`-based atomic pattern works on every fs that supports hard links (which all of macOS / Linux / WSL do).
- **OS-level `flock(1)` shell** — ergonomic for shell scripts, fragile from Node.

### H2 — `AsyncLocalStorage` cost-guard run scope

Per-run counters move out of the `CostGuard` instance field and into an `AsyncLocalStorage<RunSnapshot>`. A new `withCostRun(fn)` helper pushes a fresh snapshot for the duration of `fn`. Wired at two entry points:

- `runner.runAudit()` body — each audit (CLI, benchmark, or MCP-via-runAudit) gets its own scope.
- `mcp/server.ts` dispatcher — every tool call (including `calibrate_critic`, which doesn't go through the runner) gets its own scope.

`CostGuard.run` is now a getter that prefers the active ALS scope and falls back to a per-instance `fallbackRun` field when none is set. That preserves the pre-M9-3 API for unit tests and any direct-class user.

`resetRun()` mutates the active scope in place rather than reassigning, so other refs that captured the scope object before the reset still see the zero'd counters.

Rejected alternatives:

- **Pass `RunScope` explicitly through every LLM call site** — would have touched `agent/planner.ts`, `agent/navigator.ts`, `core/computer-use.ts`, `core/instruction-mutator.ts`, `core/llm.ts` and ripple downward. ALS keeps the call sites unchanged.
- **One CostGuard instance per scope** — fights the singleton accessor; would have forced every `getCostGuard()` caller to also know which scope they're in.
- **Per-MCP-server-instance state map** — possible but pushes wallet bookkeeping into the MCP layer, leaking.

### H3 — Atomic upsert in `AgentMemory.record`

Replace the SELECT-then-INSERT/UPDATE pattern with one `INSERT … ON CONFLICT(fact_hash) DO UPDATE` statement. Confidence cap (≤ 0.99) moves to SQLite's `min(0.99, confidence + 0.05)`. Now:

- No SELECT-then-write window; conflict resolution and increment are one atomic SQLite statement.
- Concurrent recorders converge to one row.
- Confirmations counter is incremented atomically by SQLite.

Verified by spawning 3 child processes recording the same fact 12 times each — `confirmations` lands at exactly 36, no exceptions.

### H4 — Atomic baseline bootstrap in `visual-diff.ts`

Same pattern as H1: copy the current screenshot to `<baseline>.<pid>.<ts>.tmp`, then `fs.linkSync(tmp, baseline)`. The first writer wins; the second swallows `EEXIST` and accepts the winning baseline rather than clobbering it. Tmp files are removed in a `finally` block.

Rejected alternatives:

- **Use the new file-lock helper** — overkill for "first writer wins, second is fine with whichever screenshot landed first." `linkSync` gives the same guarantee in one atomic syscall.
- **Hash-based dedup** — only relevant when the two screenshots truly differ (different DOM, different timing). The "winner" in this case is arbitrary anyway, since neither captures the canonical state better than the other.

## Consequences

**Positive**

- Two concurrent CLI runs share the daily ledger correctly; nothing is lost.
- Two parallel MCP tool calls have independent per-run caps.
- `record()` is now safe to call from concurrent processes (Wayne ran into a UNIQUE-constraint exception in the wild last week — that path is closed).
- New `file-lock.ts` is reusable for any future shared JSON state (the persona registry, the calibration cache, etc.).

**Negative**

- File lock adds disk I/O on every `recordUsage`. Measured overhead: ~1 ms per call uncontended, ~5–20 ms under contention. Acceptable given LLM calls are ≥ hundreds of ms.
- Stale-lock self-healing can theoretically reclaim a *very* slow process's lock if the holder takes longer than 30 s for one critical section. We don't currently have any 30-second-long ledger writes; if that changes, bump `staleAfterMs` at the call site.
- `AsyncLocalStorage` has a non-zero overhead per async hop (a few µs); not measurable in our context.

**Operational**

- New env var: none. The lockfile lives next to the ledger (`<ledgerPath>.lock`) and inherits its directory permissions.
- Existing ledger files migrate transparently — no schema bump needed; the JSON shape is unchanged.

## References

- `src/core/file-lock.ts` — lock helper
- `src/core/cost-guard.ts` — ledger lock + ALS scope
- `src/agent/memory.ts` — atomic upsert
- `src/core/visual-diff.ts` — atomic baseline bootstrap
- `tests/file-lock.test.ts` — 11 tests including 2 cross-process races
- `tests/cost-guard-concurrency.test.ts` — 6 tests including 3-process ledger race
- `tests/memory.test.ts` — 14th test: 3-process fact-recording race
- `tests/visual-diff-baseline.test.ts` — 2 tests including parallel-bootstrap race

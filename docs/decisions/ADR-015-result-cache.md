# ADR-015 — Result cache (M9-4)

- **Status**: Accepted
- **Date**: 2026-04-30
- **Task**: M9-4 Result cache — same-input hits return instantly so AI agents stop burning fresh vision tokens on repeat calls
- **Builds on**: ADR-007 (result schema versioning), ADR-008 (cost guard), ADR-009 (concurrency safety), ADR-011 (`see` primitive), ADR-013 (`extract` primitive), ADR-014 (`judge` + `compare` primitives)

## Context

AI agents (Claude Code, custom agents) repeatedly hit the same URLs with the same options during reasoning loops. Common patterns:

- A planner runs `judge(url, rubrics: ["aesthetic"])` while plotting an audit, then reruns it during execution. Both calls produce identical verdicts — and both burn ~$0.012 of vision tokens.
- A `compare(A, B, double_blind)` invocation runs `judge(A)` and `judge(B)`. If the user re-runs the same compare a second time, every cent and every second is wasted.
- An agent extracting pricing from a SaaS landing page may decide to re-extract during a follow-up question to verify a specific tier. Stagehand's extract is the most expensive call in the kit (~$0.05).

Without a cache, these idiomatic patterns get expensive fast and add noticeable latency. The bigger problem is that AI agents *don't know* when they've already paid for a result — they just plan around the assumption that each tool call is fresh, leading to unnecessarily conservative reasoning loops.

The v0.3 codebase already has caches scoped to specific subsystems:

- `agent/plan-cache.ts` — caches generated audit plans keyed by `(url + scenario_hash)`. Persistent SQLite, used by `agent/planner.ts`.
- Stagehand internal LLM cache — opaque, applies only to repeated identical Stagehand `act()` calls within a single session.

Neither covers the `judge` / `extract` / `see` primitive surface. M9-4 adds a primitive-level result cache.

## Decision

Add a generic, primitive-level **result cache** at `src/core/result-cache.ts` and wire it into `judge` / `extract` / `see`.

### Storage

- **SQLite** at `~/.ai-browser-auditor/result-cache.db` (override via `AUDIT_RESULT_CACHE_PATH`).
- WAL transition wrapped in a file-lock per the M9-3 follow-up pattern (see `agent/memory.ts`, `core/history.ts`); `busy_timeout = 5000`.
- One table:
  ```sql
  CREATE TABLE result_cache (
    key            TEXT PRIMARY KEY,
    primitive      TEXT NOT NULL,
    value_json     TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    created_at     INTEGER NOT NULL
  );
  ```
- Indexes: `idx_cache_created` (for TTL prune) + `idx_cache_primitive` (for diagnostic queries).

### Cache-key derivation

```
key = sha256(canonical-JSON({ primitive, inputs }))
```

`canonicalJsonStringify` recursively sorts object keys before stringify so semantically equivalent inputs produce identical strings; arrays preserve order (steps / rubrics are order-sensitive); functions and `undefined` are dropped from object members; non-finite numbers become `null`.

Per-primitive `cacheKeyInputs(opts)` declares exactly which option fields go into the key. Inputs that affect performance only (timeout, headless, artifactsRoot) are excluded so the same logical call hits cache regardless of how it was scheduled.

### TTL & invalidation

- Default 24h, override via `AUDIT_RESULT_CACHE_TTL_MS` or per-call `cacheTtlMs`.
- Entries written under a different `RESULT_SCHEMA_VERSION` (major or minor) are treated as misses and deleted at next prune (and on direct read).
- Opportunistic prune at most once per opened DB per hour.

### Bypass paths

- **Global**: `AUDIT_RESULT_CACHE_DISABLED=1` makes every read miss and every write a no-op.
- **Per-call**: `cache: false` disables read + write for one invocation.
- **Per-call refresh**: `cacheBust: true` skips the read but still persists the new result, so subsequent identical calls hit cache.

### Cache annotation in result envelopes

Bumped `RESULT_SCHEMA_VERSION` from `1.0.0` → `1.1.0` (additive minor per ADR-007 SemVer policy). All five primitive result envelopes (`see` / `act` / `extract` / `judge` / `compare`) gained an optional `cache?: ResultCacheMeta` field:

```ts
{
  hit: boolean;
  age_ms: number;          // milliseconds since the cached entry was written
  key: string;             // 64-char sha256 hex
  cost_saved_usd?: number; // present on hits; the original computation's cost
}
```

On hit the primitive's `cost_usd` is **zeroed** and the original cost moves to `cache.cost_saved_usd` so callers aggregating cost (e.g. `compare` summing two judge calls) do not double-count cached work.

### Cacheable surface (v1)

| Primitive | Cached | Why |
|---|---|---|
| `judge`   | ✅ | Pure rubric × URL evaluation; same inputs → same verdict. |
| `extract` | ✅ | Stagehand-bound LLM extraction is the most expensive call in the kit; pages don't usually change between repeat calls. |
| `see`     | ✅ when `goal` set | Without a goal there is no LLM cost — caching a page snapshot would risk serving stale state to the caller. |
| `act`     | ❌ | State-changing semantics: `act { instruction }` and the deterministic mutators (`fill` / `click` / `press` / etc.) are imperative; re-running may produce different downstream state. The `cache?` field exists in the envelope for uniformity but is never set by `act`. |
| `compare` | ❌ direct, ✅ transparent | Compare's two per-side judge calls hit cache automatically when called repeatedly with the same A/B URLs. The synthesis call is small (~30% of total compare cost) and not separately cached. The `cache?` field exists for future expansion. |
| `audit_url` / `explore_url` | ❌ | Heavyweight, many-variable; deferred to a future task. |

### Concurrency

- `INSERT ... ON CONFLICT(key) DO UPDATE` — atomic upsert so two writers on the same key converge cleanly without partial state.
- WAL means readers and writers across processes share the journal log; `busy_timeout = 5000` covers brief lock waits.
- WAL transition itself is file-locked (M9-3 follow-up pattern).

### Test strategy

- `tests/result-cache.test.ts` (31 tests) — canonical key derivation, hit/miss/expire, TTL override, cacheBust, cacheEnabled=false, env disable, primitive isolation, custom cost extractor + applyCacheMeta, schema-version invalidation, malformed JSON resilience, prune by age + version mismatch.
- `tests/primitives/cache-integration.test.ts` (9 tests) — end-to-end through `see` / `extract` / `judge` with stubbed open / vision: caches when applicable, doesn't cache when not, `cache: false` bypasses, `cacheBust` forces recompute, different inputs produce different keys.
- `tests/setup.ts` — flips `AUDIT_RESULT_CACHE_DISABLED=1` globally for vitest so unrelated tests don't pollute the user's real cache. Cache integration tests opt-in with a tmpdir SQLite path.
- `tests/result-schema.test.ts` (+11 tests) — `ResultCacheMetaSchema` accepts hit/miss / rejects bad keys & negatives; each of 5 primitive envelopes accepts `cache` on hit / miss / absent.

## Alternatives rejected

### 1. In-memory cache only (no persistence)

A simple `Map<string, { value, ts }>` would have zero schema impact and simpler tests. **Rejected** because:

- AI agents are typically single-process but their reasoning loops span many tool invocations across many MCP server lifetimes (MCP server restart, IDE relaunch, CI run-to-run). In-memory cache evaporates between runs and the per-run cost savings would be minor.
- Cross-process concurrency is exactly the case the persistent cache exists to defend against: two Claude Code instances on the same project both running `judge(landing-page)` concurrently should converge to one paid call.

### 2. Cache `audit_url` / `explore_url` envelopes

These are the most expensive calls in the kit (multi-second navigation, multi-step LLM reasoning, full report generation). Caching them would yield the biggest savings. **Deferred** because:

- Result envelope is large (full `AuditRun` with embedded scenarios / results / issues). SQLite TEXT-blob storage is fine but the value-JSON serialisation footprint deserves dedicated thought.
- Many invariants depend on a fresh run (history.db row, on-disk report SPA, baseline diffs). Skipping all of those by serving from cache would silently break those side-effects.
- A future task can revisit this with the right side-effect-aware design. v1 ships the simpler, safer subset.

### 3. Cache `act` results

**Rejected** as semantically wrong. `act { instruction: "click the buy button" }` mutates state. A cached result is meaningless because the next caller's page state is different.

### 4. Schema impact: keep `cache` outside the result envelope

We could have returned a separate envelope `{ result, cache_meta }` from MCP tools. **Rejected** because:

- Two-level envelopes complicate consumer code: every caller has to unwrap `result.result`.
- Mixing modes (some primitives cached, some not) means consumers can't write `r.url_final` without first knowing whether `r` is the result or the wrapper.
- Adding an optional field on the result envelope is a clean additive minor bump per ADR-007 SemVer policy. Old consumers ignore it; new consumers read it directly.

### 5. Don't zero `cost_usd` on hit

We could have left the original cost in `cost_usd` on hit and added `cache.hit` so consumers know it's cached. **Rejected** because:

- `compare` sums `judgeA.cost_usd + judgeB.cost_usd + synthesis_cost`. If `judge` calls return cached, the sum would over-count by 2× and any cost dashboard would lie.
- Reading the `cost_saved_usd` annotation is a one-line extra check; reading `cache.hit ? 0 : cost_usd` everywhere would not be.

### 6. Don't include `screenshot` SHA in `judge`'s cache key for the `capture` path

Naive option: just hash the screenshot path string. **Rejected** because two callers feeding *different* screenshots with the same path (e.g. tmpdir reuse) would collide. Hashing the file contents costs a single SHA-256 read and is the only way to guarantee correctness when the `capture` path is fed an arbitrary file.

### 7. Per-primitive cache tables

Splitting into `see_cache`, `extract_cache`, `judge_cache` tables would let queries target a primitive without filtering. **Rejected** as over-engineering for v1: a single keyed table with a `primitive` column + index is simpler, easier to schema-migrate, and the query patterns are all "look up by key" anyway.

### 8. Honour `Cache-Control` / `ETag` HTTP headers

The page being inspected may emit caching headers that hint at staleness. **Rejected** because:

- The cache key is about the *request* (URL + options), not the *response*. The response we cache is our LLM verdict, not the raw page.
- The visual / DOM state of a SPA may change without HTTP cache headers reflecting it (client-side rendering).
- A 24h TTL is a coarse but predictable knob; AI agents and users can tune it via env or per-call. HTTP-aware staleness adds opacity for marginal benefit.

## Consequences

### Positive

- **Repeat calls are free.** AI agents can plan more aggressively — calling `judge` to weigh options without worrying about token cost.
- **Compare amortises automatically.** A user comparing one URL against five alternatives gets the canonical URL judged once, not five times.
- **Cost ledger transparency.** `cache.cost_saved_usd` lets callers and dashboards report savings without inferring them.
- **Cross-process safe.** Two Claude Code instances on the same project share the cache.
- **No new dependencies.** Uses the already-vendored `better-sqlite3`.

### Negative

- **Schema bump.** `RESULT_SCHEMA_VERSION` 1.0.0 → 1.1.0. Tooling that pins to 1.0.0 needs to re-pin to 1.1.0 (the new field is additive optional, so no real consumer should break).
- **First-call latency unchanged.** Cache only helps on the second-and-later calls; first-call burns full cost as before.
- **Stale data risk.** A 24h TTL means a redesigned landing page won't be re-judged for up to 24h unless the caller passes `cacheBust: true`. The README documents this. Power users can shorten TTL via env.
- **Disk usage.** SQLite file grows with cache entries. Auto-prune at TTL boundary keeps it bounded; long-running daemons see a steady-state size proportional to (active workload × TTL).

## Reversal cost

- Drop the cache wiring from `judge` / `extract` / `see`: ~10 LoC reverts each.
- Optional `cache` field stays in the schema (additive minor; safe to ignore).
- Cache module + tests stay in repo as a tool the next task can reuse.
- No data migration: deleting `~/.ai-browser-auditor/result-cache.db` is safe.
- `RESULT_SCHEMA_VERSION` cannot be bumped down per SemVer; the next change is the next minor or major.

## Notes for future tasks

- M9-5 (`list_capabilities`) should expose cache-aware metadata in the per-tool spec (e.g. `"cacheable": true` on judge / extract / see, plus the env vars).
- A future task may extend caching to `audit_url` once the side-effect-aware design is settled.
- Cache hit-rate metrics (`cache.hit` over total calls) could feed into a cost-savings dashboard. Cost guard's daily ledger already records the realised cost; adding a `saved_usd` aggregate sibling is straightforward.
- For very large result envelopes (multi-MB extractions), consider gzip on `value_json` if the SQLite file grows uncomfortably.

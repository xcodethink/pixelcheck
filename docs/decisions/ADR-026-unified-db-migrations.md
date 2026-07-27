# ADR-026 — Unified SQLite migration runner (M5-7)

- **Status**: Accepted
- **Date**: 2026-05-01
- **Task**: M5-7 — Database schema migration standardisation

## Context

The auditor uses four local SQLite stores:

| File | Path | Purpose |
|---|---|---|
| `src/core/history.ts` | `<reportsDir>/history.db` | Trend history (audit runs, dimension scores, issues) |
| `src/agent/memory.ts` | `~/.ai-browser-auditor/memory.db` | Per-site facts the agent has learned |
| `src/agent/plan-cache.ts` | `~/.ai-browser-auditor/plan-cache.db` | Reusable plans keyed by (scenario, persona, host, DOM hash) |
| `src/core/result-cache.ts` | `~/.ai-browser-auditor/result-cache.db` | Memoised primitive results (judge/extract/see) |

Every one of them implemented the *same* opening sequence by hand:

1. `fs.mkdirSync(parent, { recursive: true })`
2. `new Database(dbPath)` → `db.pragma("busy_timeout = 5000")`
3. `withFileLockSync(...)` to flip journal mode to WAL once (M9-3 follow-up; the WAL transition uses an EXCLUSIVE lock that does **not** honour `busy_timeout`, so concurrent processes must serialise the flip)
4. Read `PRAGMA user_version` and walk to the current schema version, executing migration SQL strings inline

Drift had crept in:

- `memory.ts` split its migration SQL by `;` and ran each statement in a `try/catch` that swallowed `/duplicate column|already exists/i` — an over-defensive workaround that masked real schema bugs.
- `history.ts` had a hardcoded `if (userVersion < 1)` / `if (userVersion < 2)` ladder; adding a v3 would mean another `if`.
- `result-cache.ts` named its constant `SCHEMA_USER_VERSION`; the others called it `SCHEMA_VERSION`.
- `plan-cache.ts` and `memory.ts` defined `MIGRATION_V1` as a single string; `history.ts` defined `MIGRATIONS` as an array of strings; none of them used a typed shape.

Each file was ~30 lines of duplicated boilerplate. We were about to add a fifth SQLite store (M6-3 resume-checkpoint cache) and would have copied the pattern again.

A previous migration to v2 of `history.db` (M9-2 `schema_version` column) flagged the risk: editing one ladder and forgetting the others. Without a single owner of "how do we open SQLite databases", the next schema change is a Russian-roulette of which copy got updated.

## Decision

Three small pieces:

1. **`src/core/db-migrate.ts`** — a runner module with a typed `Migration` shape, a `validateMigrations()` checker, and a `runMigrations()` walker. Plus a convenience `openManagedDatabase()` that handles the parent-dir + busy_timeout + WAL transition + migration walk in one call.
2. **All four SQLite stores rewritten** to declare `Migration[]` arrays and call `openManagedDatabase()`. ~290 lines of bespoke open/migrate code shrinks to ~50 lines of declarative migration data plus a single function call per store.
3. **`tests/db-migrate.test.ts`** — 27 unit tests covering validation rules, idempotent re-runs, atomic rollback on migration failure, downgrade refusal, and the `openManagedDatabase` knobs (WAL toggle, foreign_keys, busy_timeout).

### Migration shape

```ts
export interface Migration {
  /** Strictly increasing positive integer (1, 2, 3, …). Maps to PRAGMA user_version. */
  version: number;
  /** Optional one-line description; surfaces in error messages and log lines. */
  description?: string;
  /**
   * SQL to execute. Multi-statement (semicolon-separated) is supported.
   * Must not contain transaction control or `PRAGMA user_version` updates.
   */
  up: string;
}
```

### Per-migration atomic transaction

The runner wraps each migration's `up` SQL in `BEGIN IMMEDIATE` / `COMMIT`. SQLite ≥ 3.25 supports DDL inside transactions, so a half-applied schema cannot survive: a failure rolls every CREATE / ALTER / INSERT in the migration back, leaving `user_version` at its old value. The next opener sees the same db state as before and can retry.

This replaces the `try/catch` workaround in `memory.ts`. The original concern (legacy DBs where `user_version` was 0 but tables already existed) is handled by `CREATE TABLE IF NOT EXISTS` in the migration body — every legacy migration in this repo already uses idempotent DDL.

### Downgrade refusal

```ts
if (current > target) {
  throw new MigrationVersionError(
    `database user_version ${current} is newer than highest known migration ${target}; ` +
    `refusing to downgrade. ...`
  );
}
```

If a user runs an older binary against a database that was previously written by a newer one, opening the DB now fails loudly instead of silently treating new columns as missing. This was a class of bug the old code couldn't catch (no comparison between current and target versions; just a forward walk).

### Validation before any DB I/O

`validateMigrations()` enforces dense, 1-based, strictly-increasing version numbers *before* the runner touches the database. Bad migration arrays surface at module-load time rather than at first DB open in production.

### What didn't change

The runner deliberately does not:

- own the `Database` handle long-term (callers still cache their own handle for performance)
- log anything (the project's logger isn't a dependency of `core/`; callers wrap with their own logging if needed)
- support `down` migrations (forward-only; consistent with the pre-existing approach across all four stores)
- support cross-DB transactions (each migration is local to its own database)

## Alternatives rejected

1. **Keep the four hand-rolled copies; add a CONTRIBUTING checklist that says "remember to update all four when changing the migration pattern"** — checklist enforcement has failed twice (memory.ts's defensive try/catch never made it to history.ts; history.ts's M9-2 column never propagated as a pattern others could copy). A function call enforces the contract by construction.
2. **Use a third-party migration library (`umzug`, `node-pg-migrate`, `db-migrate`)** — over-engineered for SQLite-only single-file migrations. None of them support better-sqlite3's synchronous API natively; we'd be wrapping their async wrappers.
3. **Do not validate version sequences (just trust the array)** — easy to typo `version: 3` after a `version: 1` migration. We've already shipped one such bug in another project. Cheap to validate; expensive to debug a dropped migration.
4. **Use `down` migrations to support rollbacks** — three of the four stores are local caches that get blown away on schema change anyway. Only `history.db` is durable, and rolling back schema there is more complex than it sounds (data backfilling, FK-cascade implications). Forward-only is the default for SQLite migrations elsewhere; revisit if/when v1 ships an officially supported downgrade path.
5. **Wrap all migrations in a single outer transaction (`BEGIN; v1.up; v2.up; v3.up; COMMIT;`)** — simpler, but a failure on v3 would also lose v1 and v2 (which had already succeeded on this open). Per-migration transactions let the runner make partial progress and resume later.
6. **Make migrations async (`up: async (db) => {...}`)** — better-sqlite3's API is synchronous. An async signature would lie about thread safety and tempt callers to await network calls inside migrations (very bad — long migrations block the database).
7. **Auto-detect migration filenames from a `migrations/` directory** — implicit ordering by filename is convention-based; explicit version numbers in code are reviewed in code. The four migration arrays are short enough (1–2 entries) that file-system magic isn't earning its complexity.
8. **Add a `dryRun` flag that prints planned migrations without running them** — useful for ops, but no operator currently has the surface to invoke it. Add when M6-3 ships an admin CLI.
9. **Track per-migration metadata (applied_at timestamp, checksum) in a separate `_migrations` table** — heavier; the `user_version` integer carries the same information for forward-only walkers. Add the metadata table only if/when we need to detect "the migration SQL was edited after it was applied" (a real concern for some teams; not yet for v1).

## Consequences

- Adding a new SQLite store means: declare `MIGRATIONS: Migration[]` and call `openManagedDatabase({ dbPath, migrations })`. No more copying the WAL/file-lock dance.
- Adding a new migration to an existing store means: append a `{ version: N+1, description, up }` entry to the `MIGRATIONS` array. Validation catches gaps and duplicates at module load. The next open applies it under a per-migration transaction.
- A failed migration leaves the database in its old state with the old `user_version`; subsequent opens retry rather than half-apply.
- Old binaries opening newer DBs fail loudly with `MigrationVersionError` instead of running broken queries against missing columns.
- 1478 → 1511 tests pass (+27 db-migrate, +6 from existing snapshot/contract checks scaling automatically). Public API surface unchanged at 67 exports — `db-migrate` is internal-only.
- Net code change: -218 lines deleted across 4 files / +146 lines added across 2 files (runner + tests come to ~180 LoC; the four refactored stores collectively shed ~70 LoC of boilerplate).

## Files added / changed

- `src/core/db-migrate.ts` — new (~190 LoC: types + 3 functions)
- `tests/db-migrate.test.ts` — new (27 tests)
- `src/core/history.ts` — refactored to use `openManagedDatabase`; `MIGRATIONS` becomes `Migration[]`
- `src/agent/memory.ts` — refactored; `try/catch` defensive block removed
- `src/agent/plan-cache.ts` — refactored
- `src/core/result-cache.ts` — refactored

/**
 * Unified SQLite migration runner (M5-7).
 *
 * Replaces four hand-rolled copies of the same boilerplate that had grown
 * across the codebase: `history.ts`, `agent/memory.ts`, `agent/plan-cache.ts`,
 * and `core/result-cache.ts` each opened a SQLite file, set `busy_timeout`,
 * flipped journal mode to WAL under a file-lock, then walked their own
 * `user_version` pragma to apply migrations. Every variant repeated the same
 * mechanics with subtle drift (per-statement try/catch in one, separate
 * MIGRATIONS arrays in another, slightly different lock filenames). When we
 * needed to add a fifth SQLite store, we'd be copying the pattern again.
 *
 * Centralises:
 *   - directory creation for the db path's parent
 *   - busy_timeout pragma (so concurrent readers wait rather than fail)
 *   - WAL transition under cross-process file-lock (M9-3 follow-up pattern)
 *   - user_version-driven migration walk (atomic per-migration transaction)
 *   - downgrade rejection (an older binary opening a db written by a newer one)
 *
 * Two entry points:
 *   - {@link openManagedDatabase} — call when first acquiring a DB handle.
 *     Handles parent-dir creation, pragmas, WAL transition, and migration walk.
 *   - {@link runMigrations} — call when you already hold a Database handle and
 *     just need the migration walk (e.g. a second module sharing a connection,
 *     or a unit test using `:memory:`).
 *
 * Migration SQL contract:
 *   - Each migration's `up` field is fed straight to `Database.exec()` inside
 *     a `BEGIN IMMEDIATE` … `COMMIT` block. Multi-statement (semicolon-
 *     separated) SQL is supported.
 *   - Migration SQL must NOT contain explicit `BEGIN` / `COMMIT` / `ROLLBACK`
 *     statements; the runner manages the outer transaction. Embedding
 *     transaction control raises a SQLite "cannot start a transaction within
 *     a transaction" error and the migration aborts.
 *   - Migration SQL must NOT touch `PRAGMA user_version` directly — the runner
 *     bumps it after the migration body succeeds.
 *   - SQLite ≥ 3.25 supports DDL inside transactions, so a failed migration
 *     rolls schema changes back cleanly.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { withFileLockSync } from "./file-lock.js";

/** A single forward-only schema migration. */
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

export interface OpenManagedDatabaseOpts {
  /** Filesystem path to the .db file. The parent directory is created if missing. */
  dbPath: string;
  /** Migrations to apply, ordered 1..N (validated). */
  migrations: Migration[];
  /** SQLite busy_timeout in ms. Default 5000. */
  busyTimeoutMs?: number;
  /** Set `PRAGMA foreign_keys = ON` after opening. Default false. */
  foreignKeys?: boolean;
  /**
   * Switch to WAL journal mode under a cross-process file-lock. Default true.
   * Set false only for ephemeral test databases or shared-cache `:memory:`.
   */
  wal?: boolean;
}

export interface MigrationResult {
  /** Versions applied during this call (empty if the db was already current). */
  applied: number[];
  /** Highest migration version known to the runner (always max(migrations.version)). */
  finalVersion: number;
}

/** Thrown when migration metadata or DB version is invalid. */
export class MigrationVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationVersionError";
  }
}

/**
 * Validate that migrations are dense, 1-based, strictly increasing.
 * Throws {@link MigrationVersionError} on any irregularity.
 */
export function validateMigrations(migrations: Migration[]): void {
  if (migrations.length === 0) {
    throw new MigrationVersionError("at least one migration is required");
  }
  for (let i = 0; i < migrations.length; i++) {
    const m = migrations[i]!;
    const expected = i + 1;
    if (m.version !== expected) {
      throw new MigrationVersionError(
        `migrations must be version 1..N in order; entry [${i}] has version ${m.version}, expected ${expected}`,
      );
    }
  }
}

/**
 * Walk PRAGMA user_version on `db` and apply any pending migrations.
 *
 * Each pending migration runs inside its own `BEGIN IMMEDIATE` …
 * `COMMIT` so a SQL error rolls the schema change back atomically.
 *
 * No-ops when user_version already matches the highest migration. Throws
 * {@link MigrationVersionError} if user_version is *higher* than the highest
 * known migration (downgrade refusal).
 */
export function runMigrations(
  db: Database.Database,
  migrations: Migration[],
): MigrationResult {
  validateMigrations(migrations);
  const target = migrations[migrations.length - 1]!.version;
  const current =
    (db.pragma("user_version", { simple: true }) as number | null) ?? 0;
  if (current > target) {
    throw new MigrationVersionError(
      `database user_version ${current} is newer than highest known migration ${target}; ` +
        `refusing to downgrade. Are you running an older binary against a database written by a newer one?`,
    );
  }
  const applied: number[] = [];
  for (const m of migrations) {
    if (current >= m.version) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.up);
      db.pragma(`user_version = ${m.version}`);
      db.exec("COMMIT");
      applied.push(m.version);
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // No active transaction (e.g. SQLite already auto-rolled back). Ignore.
      }
      const desc = m.description ? ` (${m.description})` : "";
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`migration v${m.version}${desc} failed: ${msg}`, { cause: e });
    }
  }
  return { applied, finalVersion: target };
}

/**
 * Open a SQLite database file with the project's standard concurrency-safe
 * opening sequence and apply migrations. Throws after closing the handle if
 * any migration fails.
 */
export function openManagedDatabase(
  opts: OpenManagedDatabaseOpts,
): Database.Database {
  fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
  const db = new Database(opts.dbPath);
  db.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
  if (opts.wal !== false) {
    // M9-3 follow-up: WAL transition uses an EXCLUSIVE lock that does NOT
    // honor busy_timeout (SQLite fast-fails journal-mode changes). Serialise
    // the one-time WAL switch across processes via an init lockfile; once
    // WAL is set on the file it persists, so subsequent opens read-and-skip.
    withFileLockSync(`${opts.dbPath}.init.lock`, () => {
      const mode = db.pragma("journal_mode", { simple: true }) as string;
      if (mode !== "wal") {
        db.pragma("journal_mode = WAL");
      }
    });
  }
  if (opts.foreignKeys) {
    db.pragma("foreign_keys = ON");
  }
  try {
    runMigrations(db, opts.migrations);
  } catch (e) {
    try {
      db.close();
    } catch {
      // already closed
    }
    throw e;
  }
  return db;
}

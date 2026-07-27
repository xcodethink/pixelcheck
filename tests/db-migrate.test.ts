import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";

import {
  Migration,
  MigrationVersionError,
  openManagedDatabase,
  runMigrations,
  validateMigrations,
} from "../src/core/db-migrate.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "db-migrate-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function tmpDb(name = "test.db"): string {
  return path.join(tmpRoot, name);
}

const initialMigration: Migration = {
  version: 1,
  description: "initial schema",
  up: `
    CREATE TABLE foo (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );
    CREATE INDEX idx_foo_name ON foo(name);
  `,
};

const v2Migration: Migration = {
  version: 2,
  description: "add foo.created_at",
  up: `
    ALTER TABLE foo ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01';
  `,
};

const v3Migration: Migration = {
  version: 3,
  description: "add bar table",
  up: `
    CREATE TABLE bar (id INTEGER PRIMARY KEY, foo_id INTEGER NOT NULL);
  `,
};

describe("validateMigrations", () => {
  it("accepts a single v1 migration", () => {
    expect(() => validateMigrations([initialMigration])).not.toThrow();
  });

  it("accepts a strictly increasing 1..N sequence", () => {
    expect(() =>
      validateMigrations([initialMigration, v2Migration, v3Migration]),
    ).not.toThrow();
  });

  it("rejects an empty array", () => {
    expect(() => validateMigrations([])).toThrow(MigrationVersionError);
    expect(() => validateMigrations([])).toThrow(/at least one migration/);
  });

  it("rejects a sequence that doesn't start at 1", () => {
    expect(() => validateMigrations([{ version: 2, up: "" }])).toThrow(
      MigrationVersionError,
    );
    expect(() => validateMigrations([{ version: 2, up: "" }])).toThrow(
      /entry \[0\] has version 2, expected 1/,
    );
  });

  it("rejects a sequence with a gap", () => {
    expect(() =>
      validateMigrations([initialMigration, v3Migration]),
    ).toThrow(/entry \[1\] has version 3, expected 2/);
  });

  it("rejects duplicate versions", () => {
    expect(() =>
      validateMigrations([initialMigration, { version: 1, up: "" }]),
    ).toThrow(/expected 2/);
  });

  it("rejects out-of-order versions", () => {
    expect(() =>
      validateMigrations([v2Migration, initialMigration]),
    ).toThrow(/entry \[0\] has version 2, expected 1/);
  });
});

describe("runMigrations", () => {
  it("applies every migration on a fresh in-memory db", () => {
    const db = new Database(":memory:");
    const result = runMigrations(db, [initialMigration, v2Migration, v3Migration]);
    expect(result.applied).toEqual([1, 2, 3]);
    expect(result.finalVersion).toBe(3);
    expect(db.pragma("user_version", { simple: true })).toBe(3);

    db.prepare("INSERT INTO foo (name) VALUES (?)").run("hi");
    const row = db
      .prepare("SELECT id, name, created_at FROM foo")
      .get() as { id: number; name: string; created_at: string };
    expect(row.name).toBe("hi");
    expect(row.created_at).toBe("1970-01-01");

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("foo");
    expect(tables).toContain("bar");
    db.close();
  });

  it("is idempotent: a second call applies nothing", () => {
    const db = new Database(":memory:");
    runMigrations(db, [initialMigration, v2Migration]);
    const second = runMigrations(db, [initialMigration, v2Migration]);
    expect(second.applied).toEqual([]);
    expect(second.finalVersion).toBe(2);
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    db.close();
  });

  it("only applies pending migrations on a partially-migrated db", () => {
    const db = new Database(":memory:");
    runMigrations(db, [initialMigration]);
    expect(db.pragma("user_version", { simple: true })).toBe(1);

    const result = runMigrations(db, [initialMigration, v2Migration, v3Migration]);
    expect(result.applied).toEqual([2, 3]);
    expect(db.pragma("user_version", { simple: true })).toBe(3);
    db.close();
  });

  it("refuses to downgrade when user_version is newer than known migrations", () => {
    const db = new Database(":memory:");
    db.pragma("user_version = 5");
    expect(() => runMigrations(db, [initialMigration])).toThrow(
      MigrationVersionError,
    );
    expect(() => runMigrations(db, [initialMigration])).toThrow(
      /user_version 5 is newer than highest known migration 1/,
    );
    db.close();
  });

  it("rolls schema changes back atomically when a migration fails", () => {
    const db = new Database(":memory:");
    runMigrations(db, [initialMigration]);

    const broken: Migration = {
      version: 2,
      description: "intentionally broken",
      // First statement valid, second references a missing table → SQL error.
      up: `
        CREATE TABLE will_not_exist (id INTEGER PRIMARY KEY);
        INSERT INTO not_a_real_table VALUES (1);
      `,
    };

    expect(() => runMigrations(db, [initialMigration, broken])).toThrow(
      /migration v2 \(intentionally broken\) failed/,
    );

    // user_version stayed at 1
    expect(db.pragma("user_version", { simple: true })).toBe(1);

    // The CREATE TABLE inside the failed migration must have been rolled back.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).not.toContain("will_not_exist");
    db.close();
  });

  it("includes migration description in error messages when provided", () => {
    const db = new Database(":memory:");
    const broken: Migration = {
      version: 1,
      description: "broken initial",
      up: "CREATE TABLE BAD SYNTAX HERE",
    };
    expect(() => runMigrations(db, [broken])).toThrow(
      /migration v1 \(broken initial\) failed/,
    );
    db.close();
  });

  it("omits the description segment when none is supplied", () => {
    const db = new Database(":memory:");
    const broken: Migration = {
      version: 1,
      up: "CREATE TABLE BAD SYNTAX HERE",
    };
    expect(() => runMigrations(db, [broken])).toThrow(/migration v1 failed/);
    expect(() => runMigrations(db, [broken])).not.toThrow(/v1 \(/);
    db.close();
  });

  it("propagates validation errors for malformed migration arrays", () => {
    const db = new Database(":memory:");
    expect(() => runMigrations(db, [])).toThrow(MigrationVersionError);
    expect(() =>
      runMigrations(db, [{ version: 5, up: "" }]),
    ).toThrow(/expected 1/);
    db.close();
  });

  it("treats a fresh db (user_version = 0) as needing every migration", () => {
    const db = new Database(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    const result = runMigrations(db, [initialMigration, v2Migration]);
    expect(result.applied).toEqual([1, 2]);
    db.close();
  });

  it("works on a real on-disk db too", () => {
    const dbPath = tmpDb();
    const db = new Database(dbPath);
    runMigrations(db, [initialMigration, v2Migration]);
    db.close();

    const reopened = new Database(dbPath);
    expect(reopened.pragma("user_version", { simple: true })).toBe(2);
    // Subsequent runMigrations is a no-op.
    const second = runMigrations(reopened, [initialMigration, v2Migration]);
    expect(second.applied).toEqual([]);
    reopened.close();
  });
});

describe("openManagedDatabase", () => {
  it("creates the parent directory if missing", () => {
    const dbPath = path.join(tmpRoot, "nested", "deep", "test.db");
    expect(fs.existsSync(path.dirname(dbPath))).toBe(false);
    const db = openManagedDatabase({
      dbPath,
      migrations: [initialMigration],
    });
    expect(fs.existsSync(dbPath)).toBe(true);
    db.close();
  });

  it("applies migrations and stamps user_version", () => {
    const dbPath = tmpDb();
    const db = openManagedDatabase({
      dbPath,
      migrations: [initialMigration, v2Migration],
    });
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    db.close();
  });

  it("sets WAL journal mode by default", () => {
    const dbPath = tmpDb();
    const db = openManagedDatabase({
      dbPath,
      migrations: [initialMigration],
    });
    const mode = db.pragma("journal_mode", { simple: true });
    expect(mode).toBe("wal");
    db.close();
  });

  it("skips WAL transition when wal: false", () => {
    const dbPath = tmpDb();
    const db = openManagedDatabase({
      dbPath,
      migrations: [initialMigration],
      wal: false,
    });
    const mode = db.pragma("journal_mode", { simple: true });
    // Default journal mode for a fresh on-disk db is "delete".
    expect(mode).not.toBe("wal");
    db.close();
  });

  it("enables foreign_keys when foreignKeys: true", () => {
    const dbPath = tmpDb();
    const db = openManagedDatabase({
      dbPath,
      migrations: [initialMigration],
      foreignKeys: true,
    });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });

  it("respects a custom busyTimeoutMs", () => {
    const dbPath = tmpDb();
    const db = openManagedDatabase({
      dbPath,
      migrations: [initialMigration],
      busyTimeoutMs: 1234,
    });
    expect(db.pragma("busy_timeout", { simple: true })).toBe(1234);
    db.close();
  });

  it("applies the default busyTimeoutMs of 5000 when not specified", () => {
    const dbPath = tmpDb();
    const db = openManagedDatabase({
      dbPath,
      migrations: [initialMigration],
    });
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    db.close();
  });

  it("closes the handle before re-throwing on migration failure", () => {
    const dbPath = tmpDb();
    const broken: Migration = {
      version: 1,
      up: "CREATE TABLE BAD SYNTAX",
    };
    expect(() =>
      openManagedDatabase({ dbPath, migrations: [broken] }),
    ).toThrow(/migration v1 failed/);

    // Re-opening is allowed because the previous handle was closed.
    const db = new Database(dbPath);
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    db.close();
  });

  it("re-opens an existing db without re-running migrations", () => {
    const dbPath = tmpDb();
    const first = openManagedDatabase({
      dbPath,
      migrations: [initialMigration, v2Migration],
    });
    first.prepare("INSERT INTO foo (name) VALUES (?)").run("persisted");
    first.close();

    const second = openManagedDatabase({
      dbPath,
      migrations: [initialMigration, v2Migration],
    });
    const row = second
      .prepare("SELECT name FROM foo WHERE name = ?")
      .get("persisted") as { name: string } | undefined;
    expect(row?.name).toBe("persisted");
    expect(second.pragma("user_version", { simple: true })).toBe(2);
    second.close();
  });

  it("upgrades an existing db when new migrations are added", () => {
    const dbPath = tmpDb();
    const first = openManagedDatabase({
      dbPath,
      migrations: [initialMigration],
    });
    first.close();

    const second = openManagedDatabase({
      dbPath,
      migrations: [initialMigration, v2Migration, v3Migration],
    });
    expect(second.pragma("user_version", { simple: true })).toBe(3);
    // Both new tables / columns visible.
    second.prepare("SELECT created_at FROM foo").all();
    second.prepare("SELECT id FROM bar").all();
    second.close();
  });
});

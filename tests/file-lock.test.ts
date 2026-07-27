/**
 * Single-process file-lock tests.
 *
 * Cross-process race tests (which spawn child Node processes) live in
 * tests/integration/file-lock-race.test.ts. They run under a stricter
 * vitest config (pool: forks + singleFork) because they were ~10-15%
 * flaky under the default threads pool — see ADR-029 for the M9-3.2
 * resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  withFileLock,
  withFileLockSync,
  FileLockTimeout,
  _setClockForTests,
} from "../src/core/file-lock.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-"));
}

describe("withFileLock — single process", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = tmpDir();
    lockPath = path.join(dir, "resource.lock");
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    _setClockForTests(null);
  });

  it("acquires, runs fn, and removes the lockfile", async () => {
    const got = await withFileLock(lockPath, async () => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return 42;
    });
    expect(got).toBe(42);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("releases lock even when fn throws", async () => {
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("serializes contended in-process callers", async () => {
    const events: string[] = [];
    const a = withFileLock(lockPath, async () => {
      events.push("a-start");
      await new Promise((r) => setTimeout(r, 50));
      events.push("a-end");
    });
    // Wait one tick so a starts first.
    await new Promise((r) => setTimeout(r, 5));
    const b = withFileLock(
      lockPath,
      async () => {
        events.push("b-start");
        events.push("b-end");
      },
      { timeoutMs: 2000 },
    );
    await Promise.all([a, b]);
    expect(events).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("times out if the lock is held longer than timeoutMs", async () => {
    // Hand-craft a non-stale lock held by ourselves (alive pid + fresh ts).
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }),
    );
    await expect(
      withFileLock(lockPath, async () => 1, {
        timeoutMs: 100,
        maxBackoffMs: 30,
        // staleAfterMs deliberately huge so we don't reclaim.
        staleAfterMs: 1_000_000,
      }),
    ).rejects.toBeInstanceOf(FileLockTimeout);
    // After timeout the leftover lockfile is still there (we didn't own it).
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("reclaims a lock whose holder pid is dead", async () => {
    // PID 0 / negative is treated as dead; use a syntactically valid but
    // never-existing pid (very large number).
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999_999_999,
        acquiredAt: new Date().toISOString(),
      }),
    );
    const got = await withFileLock(
      lockPath,
      async () => "ok",
      { timeoutMs: 1000, staleAfterMs: 1_000_000 },
    );
    expect(got).toBe("ok");
  });

  it("reclaims a lock whose timestamp is older than staleAfterMs", async () => {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid, // alive but ancient
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    const got = await withFileLock(
      lockPath,
      async () => "ok",
      { timeoutMs: 1000, staleAfterMs: 100 },
    );
    expect(got).toBe("ok");
  });

  it("reclaims a lock with corrupted contents", async () => {
    fs.writeFileSync(lockPath, "not json {{{");
    const got = await withFileLock(
      lockPath,
      async () => "ok",
      { timeoutMs: 1000 },
    );
    expect(got).toBe("ok");
  });
});

describe("withFileLockSync", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = tmpDir();
    lockPath = path.join(dir, "resource.lock");
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("acquires + releases in synchronous flow", () => {
    const got = withFileLockSync(lockPath, () => 7);
    expect(got).toBe(7);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("times out if held by a live foreign process", () => {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }),
    );
    expect(() =>
      withFileLockSync(lockPath, () => 1, {
        timeoutMs: 50,
        staleAfterMs: 1_000_000,
      }),
    ).toThrow(FileLockTimeout);
  });
});

// Cross-process race tests moved to tests/integration/file-lock-race.test.ts
// (M9-3.2 — see ADR-029).

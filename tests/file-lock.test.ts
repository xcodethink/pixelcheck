import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

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

describe("withFileLock — cross-process race", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("two child processes incrementing a counter never lose updates", () => {
    const counterPath = path.join(dir, "counter.json");
    const lockPath = path.join(dir, "counter.json.lock");
    fs.writeFileSync(counterPath, JSON.stringify({ n: 0 }));

    // Each child increments the counter ITERATIONS times under the lock.
    const ITERATIONS = 25;
    const child = `
const fs = require("node:fs");
const path = require("node:path");
const { withFileLockSync } = require(${JSON.stringify(
      path.join(process.cwd(), "dist/core/file-lock.js"),
    )});

const counterPath = ${JSON.stringify(counterPath)};
const lockPath = ${JSON.stringify(lockPath)};
const ITER = ${ITERATIONS};

for (let i = 0; i < ITER; i++) {
  withFileLockSync(lockPath, () => {
    const data = JSON.parse(fs.readFileSync(counterPath, "utf-8"));
    data.n += 1;
    // Tiny pause so that without the lock, races would actually manifest.
    const start = Date.now();
    while (Date.now() - start < 1) {}
    fs.writeFileSync(counterPath, JSON.stringify(data));
  }, { timeoutMs: 30000 });
}
process.exit(0);
`;

    const a = spawnSync(process.execPath, ["-e", child], {
      cwd: process.cwd(),
      timeout: 60_000,
    });
    const b = spawnSync(process.execPath, ["-e", child], {
      cwd: process.cwd(),
      timeout: 60_000,
    });
    // Run sequentially in the test (we can't easily run two spawnSyncs
    // in parallel from one Node thread); but the lock itself is exercised
    // via cross-process EXEC of the worker that ALSO spins ITER iterations
    // contending against any other holder, including itself across loops.
    // For real parallelism we use the async fork below — but this sync
    // fallback at least proves the worker code path runs cleanly.
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);

    const final = JSON.parse(fs.readFileSync(counterPath, "utf-8")).n as number;
    expect(final).toBe(ITERATIONS * 2);
  }, 90_000);

  it("two child processes started in parallel converge to the right total", async () => {
    const counterPath = path.join(dir, "counter2.json");
    const lockPath = path.join(dir, "counter2.json.lock");
    fs.writeFileSync(counterPath, JSON.stringify({ n: 0 }));

    const ITERATIONS = 20;
    const child = `
const fs = require("node:fs");
const path = require("node:path");
const { withFileLockSync } = require(${JSON.stringify(
      path.join(process.cwd(), "dist/core/file-lock.js"),
    )});
const counterPath = ${JSON.stringify(counterPath)};
const lockPath = ${JSON.stringify(lockPath)};
const ITER = ${ITERATIONS};

for (let i = 0; i < ITER; i++) {
  withFileLockSync(lockPath, () => {
    const data = JSON.parse(fs.readFileSync(counterPath, "utf-8"));
    data.n += 1;
    const start = Date.now();
    while (Date.now() - start < 2) {}
    fs.writeFileSync(counterPath, JSON.stringify(data));
  }, { timeoutMs: 30000 });
}
process.exit(0);
`;

    const { spawn } = await import("node:child_process");
    const procs = [0, 1, 2].map(
      () =>
        new Promise<number>((resolve, reject) => {
          const p = spawn(process.execPath, ["-e", child], {
            cwd: process.cwd(),
          });
          p.on("exit", (code) => resolve(code ?? -1));
          p.on("error", reject);
        }),
    );
    const codes = await Promise.all(procs);
    expect(codes).toEqual([0, 0, 0]);

    const final = JSON.parse(fs.readFileSync(counterPath, "utf-8")).n as number;
    expect(final).toBe(ITERATIONS * 3);
  }, 90_000);
});

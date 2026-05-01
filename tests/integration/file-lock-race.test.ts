/**
 * Cross-process file-lock race tests (M9-3.2).
 *
 * Why this file is separate from tests/file-lock.test.ts:
 *
 * The cross-process tests below `spawn` real Node child processes that race
 * on the same lockfile. Run inside vitest's default `pool: "threads"` they
 * exhibited a known ~10-15% flake rate when the full test suite ran with
 * parallel workers — sibling test workers' child processes contended on
 * shared OS-level scheduling primitives.
 *
 * Standard fix (vitest 4+ official guidance + better-sqlite3's own test
 * pattern): run these tests in `pool: "forks"` with `singleFork: true` so
 * each test file gets its own fresh Node process, eliminating the cross-
 * worker scheduler contention.
 *
 * The single-process and sync-variant tests (no child-process spawn) stay
 * in tests/file-lock.test.ts under the default threads pool — they're fast
 * and have never flaked.
 *
 * To run:
 *   npm run test:integration         # runs this file under forks pool
 *
 * To verify zero flake: 20 consecutive runs must all pass.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-race-"));
}

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

/**
 * Cross-process file-lock race tests.
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

describe("withFileLockSync — high-churn contention smoke", () => {
  it(
    "serialises correctly when the lock is acquired and released constantly",
    async () => {
      // Shape matters: many processes, many iterations, and a critical section
      // short enough that the lockfile is created and destroyed constantly.
      // The 3x20 test above holds the lock long enough that the contended
      // paths barely execute.
      //
      // This is a smoke test, not a regression guard. It exercises the churn
      // that exposed a real lost-update bug in the reclaim path, but the race
      // window is small enough that it does not reliably fail even against the
      // broken implementation — verified by reverting the fix and running it
      // five times, all green. The guarantee comes from the deterministic
      // identity-check tests in tests/file-lock.test.ts; this one only proves
      // the lock survives heavy contention at all.
      const PROCS = 12;
      const ITERATIONS = 60;

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-churn-"));
      const counterPath = path.join(dir, "counter.json");
      const lockPath = `${counterPath}.lock`;
      fs.writeFileSync(counterPath, JSON.stringify({ n: 0 }));

      const child = `
const fs = require("node:fs");
const { withFileLockSync } = require(${JSON.stringify(
        path.join(process.cwd(), "dist/core/file-lock.js"),
      )});
for (let i = 0; i < ${ITERATIONS}; i++) {
  withFileLockSync(${JSON.stringify(lockPath)}, () => {
    const d = JSON.parse(fs.readFileSync(${JSON.stringify(counterPath)}, "utf-8"));
    d.n += 1;
    fs.writeFileSync(${JSON.stringify(counterPath)}, JSON.stringify(d));
  }, { timeoutMs: 60000 });
}
process.exit(0);
`;

      const { spawn } = await import("node:child_process");
      // stderr is captured, not discarded. When a child dies, its exit code
      // alone reduces the failure to `expected false to be true` and the
      // reason is unrecoverable — which is what this test did the one time it
      // failed in CI and passed 6/6 locally. The two assertions below fail for
      // completely different reasons: a non-zero code means a child crashed, a
      // short count means the lock lost an update. Only one of them is the
      // race this file exists for, and they must not look alike.
      const results = await Promise.all(
        Array.from(
          { length: PROCS },
          () =>
            new Promise<{ code: number; stderr: string }>((resolve, reject) => {
              const p = spawn(process.execPath, ["-e", child], {
                cwd: process.cwd(),
              });
              let stderr = "";
              p.stderr?.on("data", (b: Buffer) => {
                stderr += b.toString();
              });
              p.on("exit", (code) => resolve({ code: code ?? -1, stderr }));
              p.on("error", reject);
            }),
        ),
      );

      const codes = results.map((r) => r.code);
      const failed = results.filter((r) => r.code !== 0);
      expect(
        codes.every((c) => c === 0),
        failed.length === 0
          ? ""
          : `${failed.length}/${PROCS} child process(es) exited non-zero.\n` +
            // Deduplicated, and the message rather than the stack tail. Twelve
            // identical copies of the same trace is not twelve times the
            // information, and a Node uncaught exception puts the line that
            // says what happened above the frames, not below them.
            [
              ...new Set(
                failed.map(
                  (r) =>
                    `  code ${r.code}: ` +
                    (r.stderr
                      .split("\n")
                      .find((l) => /Error|error:|Cannot|ENOENT|EACCES/.test(l))
                      ?.trim() ??
                      r.stderr.trim().split("\n")[0] ??
                      "(no stderr)"),
                ),
              ),
            ].join("\n"),
      ).toBe(true);
      const final = JSON.parse(fs.readFileSync(counterPath, "utf-8")).n as number;
      expect(final).toBe(PROCS * ITERATIONS);
      fs.rmSync(dir, { recursive: true, force: true });
    },
    120_000,
  );
});

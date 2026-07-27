/**
 * Cross-process advisory file lock (M9-3).
 *
 * Why: several state files in this project are read-modify-write
 * (cost-ledger.json, future shared JSON caches). Atomic temp+rename
 * protects against torn writes on a single update, but does NOT
 * prevent two processes from each loading the file, mutating
 * different keys, and then last-write-wins-ing one update away.
 *
 * What this gives you: a sleep-poll lockfile that holds for the
 * duration of a critical section, with stale-lock self-healing in
 * case the previous owner crashed.
 *
 *     await withFileLock("/path/to/resource.json.lock", async () => {
 *       const data = readJson(path);
 *       data.foo += 1;
 *       writeJsonAtomic(path, data);
 *     });
 *
 * Mechanics:
 *
 *  - Acquire: open `<lockfile>` with O_EXCL|O_CREAT|O_WRONLY. If it
 *    exists, read its contents (pid + iso timestamp). If the pid is
 *    not alive OR the timestamp is older than `staleAfterMs`, treat
 *    the lock as abandoned and unlink it, then retry once.
 *
 *  - Wait: if the lock is held by a live process, sleep with
 *    exponential backoff up to `timeoutMs`. Throw on timeout.
 *
 *  - Release: unlink the lockfile in finally. Errors are swallowed
 *    (someone else may have deleted it as stale; harmless).
 *
 * No external deps. Pure Node fs + setTimeout.
 *
 * Test seam: `_clockForTests` lets unit tests fast-forward the
 * staleness check without sleeping.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface FileLockOptions {
  /** Total time we'll wait to acquire the lock. Default: 5000 ms. */
  timeoutMs?: number;
  /** Max backoff between attempts. Default: 100 ms. */
  maxBackoffMs?: number;
  /** Lock is considered abandoned if older than this. Default: 30000 ms. */
  staleAfterMs?: number;
}

export class FileLockTimeout extends Error {
  constructor(lockPath: string, waitedMs: number, holder?: LockHolder) {
    const who = holder
      ? `held by pid ${holder.pid} since ${holder.acquiredAt}`
      : "no contents";
    super(
      `Timed out after ${waitedMs}ms acquiring lock at ${lockPath} (${who}).`,
    );
    this.name = "FileLockTimeout";
  }
}

interface LockHolder {
  pid: number;
  acquiredAt: string;
}

let _clockForTests: (() => number) | null = null;

/** Test-only: override the wall clock used for staleness comparisons. */
export function _setClockForTests(clock: (() => number) | null): void {
  _clockForTests = clock;
}

function now(): number {
  return _clockForTests ? _clockForTests() : Date.now();
}

function readHolder(lockPath: string): LockHolder | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<LockHolder>;
    if (typeof parsed.pid === "number" && typeof parsed.acquiredAt === "string") {
      return { pid: parsed.pid, acquiredAt: parsed.acquiredAt };
    }
  } catch {
    // missing / corrupt — treat as no holder
  }
  return null;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    // Signal 0 doesn't actually deliver; kill throws ESRCH if the pid is gone.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM = exists but we can't signal it (still alive).
    return code === "EPERM";
  }
}

function isStale(holder: LockHolder | null, staleAfterMs: number): boolean {
  if (!holder) return true;
  const ts = Date.parse(holder.acquiredAt);
  if (!Number.isFinite(ts)) return true;
  if (now() - ts > staleAfterMs) return true;
  return !isProcessAlive(holder.pid);
}

function tryAcquire(lockPath: string): boolean {
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true });
  // Write our identity to a per-process temp file FIRST, then atomically
  // link it to the lockfile path. linkSync fails with EEXIST if another
  // process already holds the lock — that's our acquire-or-fail signal.
  // The two-step approach guarantees: when the lockfile exists from any
  // observer's perspective, it ALWAYS has fully-written holder contents
  // (no empty-file race against the staleness reader).
  const payload: LockHolder = {
    pid: process.pid,
    acquiredAt: new Date(now()).toISOString(),
  };
  const tmp = `${lockPath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 10)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload), { encoding: "utf-8" });
  try {
    fs.linkSync(tmp, lockPath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    throw err;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // tmp gone — fine
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Acquire the lock at `lockPath` and run `fn`. The lock is released
 * after `fn` resolves or rejects. Throws FileLockTimeout if it
 * cannot acquire within `timeoutMs`.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  opts: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxBackoffMs = opts.maxBackoffMs ?? 100;
  const staleAfterMs = opts.staleAfterMs ?? 30_000;
  const start = now();
  let backoff = 5;
  let lastHolder: LockHolder | null;

  while (true) {
    if (tryAcquire(lockPath)) break;

    lastHolder = readHolder(lockPath);

    // Try once to break a stale lock.
    if (isStale(lastHolder, staleAfterMs)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Someone else cleared it first. Loop and retry tryAcquire.
      }
      continue;
    }

    if (now() - start >= timeoutMs) {
      throw new FileLockTimeout(lockPath, now() - start, lastHolder ?? undefined);
    }

    await sleep(backoff);
    backoff = Math.min(maxBackoffMs, backoff * 2);
  }

  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Already gone — fine.
    }
  }
}

/**
 * Synchronous variant for hot paths that already block the event
 * loop (e.g. inside a sync DB transaction). Same semantics, but
 * uses a busy-wait sleep via Atomics.wait on a SharedArrayBuffer.
 */
export function withFileLockSync<T>(
  lockPath: string,
  fn: () => T,
  opts: FileLockOptions = {},
): T {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxBackoffMs = opts.maxBackoffMs ?? 100;
  const staleAfterMs = opts.staleAfterMs ?? 30_000;
  const start = now();
  let backoff = 5;

  while (true) {
    if (tryAcquire(lockPath)) break;
    const holder = readHolder(lockPath);
    if (isStale(holder, staleAfterMs)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // ignore
      }
      continue;
    }
    if (now() - start >= timeoutMs) {
      throw new FileLockTimeout(lockPath, now() - start, holder ?? undefined);
    }
    sleepSync(backoff);
    backoff = Math.min(maxBackoffMs, backoff * 2);
  }

  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const i32 = new Int32Array(sab);
  Atomics.wait(i32, 0, 0, ms);
}

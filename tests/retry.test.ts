/**
 * Tests for src/core/retry.ts — configurable retry with exponential backoff + jitter.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  withRetry,
  computeBackoff,
  DEFAULT_RETRY_STRATEGY,
  type RetryStrategy,
} from "../src/core/retry.js";
import { BudgetExceededError } from "../src/core/cost-guard.js";
import { ConsentDeclinedError } from "../src/core/consent.js";

// Stub sleep so tests run instantly.
const sleepFn = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

// Deterministic jitter: always returns 0.5 => jitter factor = 0 (center).
const noJitter = () => 0.5;

beforeEach(() => {
  sleepFn.mockClear();
  delete process.env.PIXELCHECK_MAX_RETRIES;
});

afterEach(() => {
  delete process.env.PIXELCHECK_MAX_RETRIES;
});

// ───────────────────────────────────────────────────────
// withRetry — success paths
// ───────────────────────────────────────────────────────

describe("withRetry", () => {
  it("resolves on first try without retries", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await withRetry(fn, {}, "test-op", { sleepFn });
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("retries and succeeds on second attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, {}, "test-op", { sleepFn, randFn: noJitter });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
  });

  it("retries and succeeds on the last allowed attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockRejectedValueOnce(new Error("fail-2"))
      .mockRejectedValueOnce(new Error("fail-3"))
      .mockResolvedValue("finally");
    const result = await withRetry(fn, { maxRetries: 3 }, "test-op", {
      sleepFn,
      randFn: noJitter,
    });
    expect(result).toBe("finally");
    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    expect(sleepFn).toHaveBeenCalledTimes(3);
  });

  it("fires onRetry once per actual retry with a 1-based retry number (D2-H1)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockRejectedValueOnce(new Error("fail-2"))
      .mockResolvedValue("ok");
    const seen: Array<{ n: number; msg: string }> = [];
    const result = await withRetry(fn, { maxRetries: 3 }, "test-op", {
      sleepFn,
      randFn: noJitter,
      onRetry: (err, retryNumber) => {
        seen.push({ n: retryNumber, msg: (err as Error).message });
      },
    });
    expect(result).toBe("ok");
    // Two failures → two retries → onRetry fired twice, numbered 1 then 2.
    expect(seen).toEqual([
      { n: 1, msg: "fail-1" },
      { n: 2, msg: "fail-2" },
    ]);
  });

  it("does not fire onRetry when the first attempt succeeds", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const onRetry = vi.fn();
    await withRetry(fn, {}, "test-op", { sleepFn, onRetry });
    expect(onRetry).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────
  // withRetry — exhaustion
  // ───────────────────────────────────────────────────────

  it("throws last error after exhausting all retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("persistent"));
    await expect(
      withRetry(fn, { maxRetries: 2 }, "exhaust", { sleepFn, randFn: noJitter }),
    ).rejects.toThrow("persistent");
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("throws the exact last error instance", async () => {
    const err1 = new Error("first");
    const err2 = new Error("second");
    const err3 = new Error("third");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err1)
      .mockRejectedValueOnce(err2)
      .mockRejectedValueOnce(err3);
    await expect(
      withRetry(fn, { maxRetries: 2 }, "exact-err", { sleepFn }),
    ).rejects.toBe(err3);
  });

  // ───────────────────────────────────────────────────────
  // Non-retryable errors
  // ───────────────────────────────────────────────────────

  it("does not retry BudgetExceededError", async () => {
    const err = new BudgetExceededError("run-usd", 5.5, 5.0);
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, {}, "budget", { sleepFn }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("does not retry ConsentDeclinedError", async () => {
    const err = new ConsentDeclinedError();
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, {}, "consent", { sleepFn }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("does not retry errors with non-retryable name even if not instanceof", async () => {
    const err = new Error("fake budget");
    err.name = "BudgetExceededError";
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, {}, "name-check", { sleepFn }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ───────────────────────────────────────────────────────
  // Retryable error patterns
  // ───────────────────────────────────────────────────────

  it("retries when error matches retryableErrors pattern", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue("ok");
    const result = await withRetry(
      fn,
      { retryableErrors: [/ECONNRESET/, /ETIMEDOUT/] },
      "pattern-match",
      { sleepFn, randFn: noJitter },
    );
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry when error does not match any retryableErrors pattern", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("SyntaxError: unexpected token"));
    await expect(
      withRetry(
        fn,
        { retryableErrors: [/ECONNRESET/, /ETIMEDOUT/] },
        "no-match",
        { sleepFn },
      ),
    ).rejects.toThrow("SyntaxError");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("treats all errors as retryable when retryableErrors is empty", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("anything"))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, { retryableErrors: [] }, "empty-patterns", {
      sleepFn,
      randFn: noJitter,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // ───────────────────────────────────────────────────────
  // Backoff timing
  // ───────────────────────────────────────────────────────

  it("increases backoff delay between retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    await expect(
      withRetry(
        fn,
        { maxRetries: 3, backoffMs: 100, backoffMultiplier: 2, maxBackoffMs: 10_000 },
        "backoff-check",
        { sleepFn, randFn: noJitter },
      ),
    ).rejects.toThrow("fail");

    // With noJitter (0.5 => factor 0), delays are exactly: 100, 200, 400
    expect(sleepFn).toHaveBeenCalledTimes(3);
    const delays = sleepFn.mock.calls.map((c) => c[0]);
    expect(delays[0]).toBe(100);
    expect(delays[1]).toBe(200);
    expect(delays[2]).toBe(400);
  });

  it("caps backoff at maxBackoffMs", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    await expect(
      withRetry(
        fn,
        { maxRetries: 3, backoffMs: 500, backoffMultiplier: 10, maxBackoffMs: 2000 },
        "cap-check",
        { sleepFn, randFn: noJitter },
      ),
    ).rejects.toThrow("fail");

    const delays = sleepFn.mock.calls.map((c) => c[0]);
    // 500, min(5000,2000)=2000, min(50000,2000)=2000
    expect(delays[0]).toBe(500);
    expect(delays[1]).toBe(2000);
    expect(delays[2]).toBe(2000);
  });

  // ───────────────────────────────────────────────────────
  // Custom strategy overrides
  // ───────────────────────────────────────────────────────

  it("accepts partial strategy overrides merged with defaults", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    await expect(
      withRetry(fn, { maxRetries: 1 }, "partial", { sleepFn, randFn: noJitter }),
    ).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
  });

  it("works with maxRetries = 0 (no retries)", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    await expect(
      withRetry(fn, { maxRetries: 0 }, "no-retries", { sleepFn }),
    ).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────
  // PIXELCHECK_MAX_RETRIES env override
  // ───────────────────────────────────────────────────────

  it("respects PIXELCHECK_MAX_RETRIES env var", async () => {
    process.env.PIXELCHECK_MAX_RETRIES = "1";
    const fn = vi.fn().mockRejectedValue(new Error("env-override"));
    await expect(
      withRetry(fn, { maxRetries: 5 }, "env-test", { sleepFn, randFn: noJitter }),
    ).rejects.toThrow("env-override");
    // Env says 1 retry, not 5
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("ignores invalid PIXELCHECK_MAX_RETRIES values", async () => {
    process.env.PIXELCHECK_MAX_RETRIES = "banana";
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    await expect(
      withRetry(fn, { maxRetries: 2 }, "bad-env", { sleepFn, randFn: noJitter }),
    ).rejects.toThrow("fail");
    // Falls back to strategy maxRetries = 2
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("supports PIXELCHECK_MAX_RETRIES=0 to disable retries", async () => {
    process.env.PIXELCHECK_MAX_RETRIES = "0";
    const fn = vi.fn().mockRejectedValue(new Error("no-retry"));
    await expect(
      withRetry(fn, { maxRetries: 3 }, "env-zero", { sleepFn }),
    ).rejects.toThrow("no-retry");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ───────────────────────────────────────────────────────
  // Label in logs (structural check)
  // ───────────────────────────────────────────────────────

  it("includes label in retry logging context", async () => {
    // We verify this indirectly: the function runs without error and
    // uses the label in the retry path. Since pino goes to stderr,
    // we just confirm the retry path executes with a custom label.
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("done");
    const result = await withRetry(fn, {}, "my-custom-label", {
      sleepFn,
      randFn: noJitter,
    });
    expect(result).toBe("done");
    // If label caused any issue, the above would have thrown.
  });
});

// ───────────────────────────────────────────────────────
// computeBackoff — pure function tests
// ───────────────────────────────────────────────────────

describe("computeBackoff", () => {
  const base = { backoffMs: 1000, backoffMultiplier: 2, maxBackoffMs: 30_000 };

  it("returns base delay for attempt 1 with zero jitter", () => {
    expect(computeBackoff(1, base, () => 0.5)).toBe(1000);
  });

  it("doubles delay for attempt 2", () => {
    expect(computeBackoff(2, base, () => 0.5)).toBe(2000);
  });

  it("quadruples delay for attempt 3", () => {
    expect(computeBackoff(3, base, () => 0.5)).toBe(4000);
  });

  it("applies positive jitter when rand > 0.5", () => {
    const delay = computeBackoff(1, base, () => 1.0);
    // rand=1.0 => jitter = 1000 * 0.2 * (2*1-1) = +200
    expect(delay).toBe(1200);
  });

  it("applies negative jitter when rand < 0.5", () => {
    const delay = computeBackoff(1, base, () => 0.0);
    // rand=0.0 => jitter = 1000 * 0.2 * (2*0-1) = -200
    expect(delay).toBe(800);
  });

  it("caps at maxBackoffMs before applying jitter", () => {
    const capped = { backoffMs: 10_000, backoffMultiplier: 10, maxBackoffMs: 5000 };
    // attempt 2: raw = 100_000, capped = 5000, jitter = 0 => 5000
    expect(computeBackoff(2, capped, () => 0.5)).toBe(5000);
  });

  it("never returns negative", () => {
    // Edge case: very small base, max negative jitter
    const tiny = { backoffMs: 1, backoffMultiplier: 1, maxBackoffMs: 1 };
    const result = computeBackoff(1, tiny, () => 0.0);
    expect(result).toBeGreaterThanOrEqual(0);
  });
});

// ───────────────────────────────────────────────────────
// DEFAULT_RETRY_STRATEGY shape
// ───────────────────────────────────────────────────────

describe("DEFAULT_RETRY_STRATEGY", () => {
  it("has expected default values", () => {
    expect(DEFAULT_RETRY_STRATEGY).toEqual({
      maxRetries: 3,
      backoffMs: 1000,
      backoffMultiplier: 2,
      maxBackoffMs: 30_000,
      retryableErrors: [],
    });
  });

  it("is frozen (read-only)", () => {
    expect(Object.isFrozen(DEFAULT_RETRY_STRATEGY)).toBe(true);
  });
});

/**
 * Configurable retry strategy for PixelCheck operations (M6-4).
 *
 * Wraps any async function with exponential backoff + jitter. Integrates
 * with pino structured logging and respects PIXELCHECK_MAX_RETRIES env
 * override. Non-retryable errors (BudgetExceededError, ConsentDeclinedError)
 * are re-thrown immediately without retry.
 */

import { getLogger } from "./logger.js";
import { BudgetExceededError } from "./cost-guard.js";
import { ConsentDeclinedError } from "./consent.js";

const log = getLogger("retry");

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface RetryStrategy {
  /** Maximum number of retry attempts (not counting the initial call). */
  maxRetries: number;
  /** Initial backoff delay in milliseconds. */
  backoffMs: number;
  /** Multiplier applied to backoff after each retry. */
  backoffMultiplier: number;
  /** Upper bound on any single backoff delay (ms). */
  maxBackoffMs: number;
  /** Regex patterns — errors matching any pattern are retryable. When empty, all errors are retryable (unless non-retryable). */
  retryableErrors: RegExp[];
}

export const DEFAULT_RETRY_STRATEGY: Readonly<RetryStrategy> = Object.freeze({
  maxRetries: 3,
  backoffMs: 1000,
  backoffMultiplier: 2,
  maxBackoffMs: 30_000,
  retryableErrors: [],
});

/**
 * Error classes that must never be retried, regardless of strategy config.
 * Checked by constructor name so callers don't need to import these classes.
 */
const NON_RETRYABLE_NAMES = new Set([
  "BudgetExceededError",
  "ConsentDeclinedError",
]);

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function resolveMaxRetries(strategy: RetryStrategy): number {
  const envVal = process.env.PIXELCHECK_MAX_RETRIES;
  if (envVal !== undefined && envVal !== "") {
    const n = Number(envVal);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return strategy.maxRetries;
}

function isNonRetryable(err: unknown): boolean {
  if (err instanceof BudgetExceededError) return true;
  if (err instanceof ConsentDeclinedError) return true;
  if (err instanceof Error && NON_RETRYABLE_NAMES.has(err.name)) return true;
  return false;
}

function isRetryable(err: unknown, patterns: RegExp[]): boolean {
  if (isNonRetryable(err)) return false;
  // If no patterns configured, all non-blocked errors are retryable.
  if (patterns.length === 0) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return patterns.some((re) => re.test(msg));
}

/**
 * Compute backoff delay with +/-20% jitter.
 *
 * @param attempt   1-based retry number (1 = first retry)
 * @param strategy  retry strategy config
 * @param randFn    test seam for deterministic jitter
 */
export function computeBackoff(
  attempt: number,
  strategy: Pick<RetryStrategy, "backoffMs" | "backoffMultiplier" | "maxBackoffMs">,
  randFn: () => number = Math.random,
): number {
  const raw = strategy.backoffMs * Math.pow(strategy.backoffMultiplier, attempt - 1);
  const capped = Math.min(raw, strategy.maxBackoffMs);
  // Jitter: uniform in [-0.2, +0.2] of capped value
  const jitter = capped * 0.2 * (2 * randFn() - 1);
  return Math.max(0, Math.round(capped + jitter));
}

// ─────────────────────────────────────────────────────────────
// Main API
// ─────────────────────────────────────────────────────────────

export interface WithRetryOptions {
  /** Test seam: replace setTimeout-based sleep. Receives ms, returns when "waited". */
  sleepFn?: (ms: number) => Promise<void>;
  /** Test seam: deterministic jitter source (returns 0..1). */
  randFn?: () => number;
  /**
   * Fired just before each backoff sleep, i.e. once per retry that will
   * actually happen. `retryNumber` is 1-based (1 = first retry). Lets a
   * caller surface how many retries were spent (e.g. StepResult.retries_used)
   * without re-implementing retry counting.
   */
  onRetry?: (err: unknown, retryNumber: number, delayMs: number) => void;
}

/**
 * Execute `fn` with retry logic governed by `strategy`.
 *
 * @param fn        The async operation to wrap.
 * @param strategy  Retry configuration (defaults to DEFAULT_RETRY_STRATEGY).
 * @param label     Human-readable label for structured log messages.
 * @param opts      Test seams for sleep / randomness.
 * @returns         The resolved value of `fn`.
 * @throws          The last error if all retries are exhausted, or a
 *                  non-retryable error immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  strategy: Partial<RetryStrategy> = {},
  label = "operation",
  opts: WithRetryOptions = {},
): Promise<T> {
  const merged: RetryStrategy = { ...DEFAULT_RETRY_STRATEGY, ...strategy };
  const maxRetries = resolveMaxRetries(merged);
  const sleep = opts.sleepFn ?? defaultSleep;
  const randFn = opts.randFn ?? Math.random;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Non-retryable errors are thrown immediately.
      if (isNonRetryable(err)) {
        log.warn(
          {
            label,
            attempt: attempt + 1,
            error: err instanceof Error ? err.message : String(err),
            errorName: err instanceof Error ? err.name : undefined,
          },
          "non-retryable error — aborting immediately",
        );
        throw err;
      }

      // If patterns are configured and error doesn't match, don't retry.
      if (!isRetryable(err, merged.retryableErrors)) {
        log.warn(
          {
            label,
            attempt: attempt + 1,
            error: err instanceof Error ? err.message : String(err),
          },
          "error does not match retryable patterns — aborting",
        );
        throw err;
      }

      // If this was the last attempt, we'll fall through and throw.
      if (attempt === maxRetries) {
        log.error(
          {
            label,
            totalAttempts: attempt + 1,
            error: err instanceof Error ? err.message : String(err),
          },
          "all retry attempts exhausted",
        );
        break;
      }

      const delayMs = computeBackoff(attempt + 1, merged, randFn);
      log.info(
        {
          label,
          attempt: attempt + 1,
          maxRetries,
          delayMs,
          error: err instanceof Error ? err.message : String(err),
        },
        "retrying after transient failure",
      );

      if (opts.onRetry) opts.onRetry(err, attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

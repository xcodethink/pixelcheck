/**
 * Exponential backoff retry with classification-based decision.
 */

export type RetryDecision = "retry" | "abort";

export interface RetryOptions {
  /** Maximum number of attempts (including the first one) */
  maxAttempts?: number;
  /** Base delay in ms (default 1000) */
  baseDelay?: number;
  /** Multiplier for exponential backoff (default 3) */
  factor?: number;
  /** Maximum delay cap in ms (default 30000) */
  maxDelay?: number;
  /** Classify an error: should we retry it? */
  classify?: (err: unknown, attempt: number) => RetryDecision;
  /** Hook called before each retry */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export class RetryError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly lastError: unknown,
  ) {
    super(
      `Failed after ${attempts} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
    this.name = "RetryError";
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelay = opts.baseDelay ?? 1000;
  const factor = opts.factor ?? 3;
  const maxDelay = opts.maxDelay ?? 30_000;
  const classify = opts.classify ?? defaultClassifier;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const decision = classify(err, attempt);
      if (decision === "abort" || attempt === maxAttempts) {
        throw new RetryError(attempt, err);
      }
      const delay = Math.min(baseDelay * Math.pow(factor, attempt - 1), maxDelay);
      if (opts.onRetry) opts.onRetry(err, attempt, delay);
      await sleep(delay);
    }
  }
  // unreachable but TS needs it
  throw new RetryError(maxAttempts, lastError);
}

/**
 * Default retry classifier — retries on common transient errors.
 */
export function defaultClassifier(err: unknown): RetryDecision {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  // Network transient
  if (
    msg.includes("net::err_") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("socket hang up")
  ) {
    return "retry";
  }

  // HTTP 5xx via Playwright response check
  if (msg.match(/\b5\d{2}\b/)) {
    return "retry";
  }

  // HTTP 4xx — don't retry
  if (msg.match(/\b4\d{2}\b/)) {
    return "abort";
  }

  // Bot challenge — retry (caller should swap fingerprint)
  if (
    msg.includes("just a moment") ||
    msg.includes("cloudflare") ||
    msg.includes("captcha") ||
    msg.includes("access denied") ||
    msg.includes("blocked")
  ) {
    return "retry";
  }

  // Default: retry once for unknown
  return "retry";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

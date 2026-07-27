import pino, { type Logger, type LoggerOptions } from "pino";

/**
 * Structured logger built on pino.
 *
 * Output goes to stderr, keeping stdout clean for CLI results and MCP stdio
 * protocol frames.
 *
 * Format defaults to pretty (colored, human-readable) when stderr is a TTY,
 * and to JSON otherwise (so CI, piped output, and MCP stdio all stay JSON).
 * Override with LOG_PRETTY=1 (force pretty) or LOG_PRETTY=0 (force JSON).
 *
 * Env config:
 *   LOG_LEVEL    trace|debug|info|warn|error|fatal|silent  (default: info)
 *   LOG_PRETTY   1|true|0|false|auto                       (default: auto)
 *   LOG_FILE     /path/to.log                              additionally tee to file
 *
 * Usage:
 *   import { getLogger } from "./logger.js";
 *   const log = getLogger("runner");
 *   log.info({ unitId, durationMs }, "unit completed");
 *
 * Redaction (M1-4): two layers of protection against secret leakage —
 *   1. Path-based: well-known field names (apiKey, password, token, cookie,
 *      authorization, etc.) get [REDACTED] regardless of value.
 *   2. Value-based: callers register concrete secret strings via
 *      registerSecret(value) at startup; any occurrence of those strings
 *      in any log payload is replaced with [REDACTED] before write.
 */

export type { Logger } from "pino";

const VALID_LEVELS = new Set([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
]);

function resolveLevel(): string {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return VALID_LEVELS.has(raw) ? raw : "info";
}

function isPretty(): boolean {
  const v = (process.env.LOG_PRETTY ?? "auto").toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  // auto: pretty when stderr is a TTY
  return Boolean((process.stderr as NodeJS.WriteStream).isTTY);
}

// ─────────────────────────────────────────────────────────────
// Redaction (M1-4)
// ─────────────────────────────────────────────────────────────

const CENSOR = "[REDACTED]";

/**
 * Path-based redact paths handed to pino.redact.
 *
 * Catches well-named fields regardless of their value — useful when callers
 * accidentally log structured payloads like `{ apiKey: "sk-..." }`.
 *
 * Matches both top-level (`apiKey`) and nested under any single parent
 * (`*.apiKey`, `**.apiKey`). pino's redact uses fast-redact under the hood;
 * single-segment wildcards are cheap, deeper wildcards a bit less so.
 */
const REDACT_PATHS: string[] = [
  // Top-level
  "apiKey",
  "api_key",
  "password",
  "token",
  "secret",
  "cookie",
  "cookies",
  "authorization",
  "auth",
  "anthropic_api_key",
  "ANTHROPIC_API_KEY",
  // One level deep
  "*.apiKey",
  "*.api_key",
  "*.password",
  "*.token",
  "*.secret",
  "*.cookie",
  "*.cookies",
  "*.authorization",
  "*.auth",
];

/** Concrete secret values registered via registerSecret(). */
const registeredSecrets = new Set<string>();

/**
 * Replace every registered secret string occurrence in `value` with [REDACTED].
 * No-op if the registry is empty.
 */
function redactValueString(input: string): string {
  if (registeredSecrets.size === 0) return input;
  let out = input;
  for (const s of registeredSecrets) {
    if (!s) continue;
    if (out.includes(s)) out = out.split(s).join(CENSOR);
  }
  return out;
}

/**
 * Walk a JSON-ish payload and substring-redact every string against the
 * registered-secret list. Cheap when the list is empty.
 */
function redactValuesDeep(value: unknown, depth = 0): unknown {
  if (registeredSecrets.size === 0) return value;
  if (depth > 8) return value; // hard cap on recursion
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactValueString(value);
  if (Array.isArray(value)) return value.map((v) => redactValuesDeep(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValuesDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Register a concrete secret value. Any subsequent log call whose payload
 * contains this string (anywhere — keys excluded, values only) will have
 * the occurrence replaced with [REDACTED].
 *
 * No-op for empty / very short values (< 8 chars) so common words don't
 * accidentally get blanket-redacted.
 *
 * Call at process startup, after `dotenv.config()`, before any log emission.
 */
export function registerSecret(value: string | undefined | null): void {
  if (!value || value.length < 8) return;
  registeredSecrets.add(value);
}

/** Test-only: clear the registered-secret list. */
export function _resetRegisteredSecretsForTests(): void {
  registeredSecrets.clear();
}

/** Test-only: read the current registered-secret count. */
export function _registeredSecretCountForTests(): number {
  return registeredSecrets.size;
}

function buildOptions(): LoggerOptions {
  const opts: LoggerOptions = {
    level: resolveLevel(),
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACT_PATHS,
      censor: CENSOR,
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    hooks: {
      // Intercept every log call and substring-redact registered secrets
      // across all args (both payload objects and message strings). pino's
      // built-in `redact` only handles paths, not value substrings — and
      // pino's formatters.log can't see the message string. logMethod is
      // the only hook that sees both, so it's the only place that catches
      // a secret accidentally interpolated into the message.
      logMethod(inputArgs, method) {
        if (registeredSecrets.size === 0) {
          return method.apply(this, inputArgs);
        }
        const safe = inputArgs.map((arg) => {
          if (typeof arg === "string") return redactValueString(arg);
          if (arg && typeof arg === "object") return redactValuesDeep(arg);
          return arg;
        }) as Parameters<typeof method>;
        return method.apply(this, safe);
      },
    },
  };

  if (isPretty()) {
    opts.transport = {
      target: "pino-pretty",
      options: {
        destination: 2,
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
      },
    };
  }

  return opts;
}

/** Active LOG_FILE pino destinations we may need to close on test cleanup
 *  (Windows: SonicBoom keeps the LOG_FILE handle open, blocking the
 *  parent directory's rmSync with ENOTEMPTY). Only file destinations are
 *  tracked here — stderr destinations are NEVER tracked because closing
 *  them would break pre-cached logger references in other modules
 *  (e.g., `const log = getLogger("cost-guard")` at module load). */
type PinoDest = ReturnType<typeof pino.destination>;
let activeFileDestinations: PinoDest[] = [];

function buildDestination() {
  if (isPretty()) return undefined;
  const file = process.env.LOG_FILE;
  if (file && file.length > 0) {
    const stderrDest = pino.destination({ dest: 2, sync: false });
    const fileDest = pino.destination({ dest: file, sync: false, mkdir: true });
    activeFileDestinations.push(fileDest);
    return pino.multistream([
      { stream: stderrDest },
      { stream: fileDest },
    ]);
  }
  return pino.destination({ dest: 2, sync: false });
}

let rootLogger: Logger | null = null;

function getRoot(): Logger {
  if (!rootLogger) {
    const opts = buildOptions();
    const dest = buildDestination();
    rootLogger = dest ? pino(opts, dest) : pino(opts);
  }
  return rootLogger;
}

const childCache = new Map<string, Logger>();

/**
 * Return a logger bound to a module name. Child loggers are cached by name so
 * repeated calls in the same module reuse the same instance.
 */
export function getLogger(module: string): Logger {
  const cached = childCache.get(module);
  if (cached) return cached;
  const child = getRoot().child({ module });
  childCache.set(module, child);
  return child;
}

/**
 * Reset cached loggers — used in tests so env changes between cases take effect.
 * Not exported via index.ts; intended for test-only use.
 *
 * Synchronous path. On macOS / Linux this is sufficient because rm of a
 * parent directory does not block on open descendant FDs. On Windows the
 * test cleanup MUST instead use `_closeLoggerStreamsForTests()` which
 * awaits the 'close' event before returning — otherwise the file handle
 * is still open when rmSync runs and the platform throws ENOTEMPTY.
 */
export function _resetLoggerForTests(): void {
  rootLogger = null;
  childCache.clear();
  // Note: deliberately does NOT close stderr destination — see
  // activeFileDestinations comment above.
  for (const dest of activeFileDestinations) {
    try {
      dest.flushSync();
    } catch {
      // best effort
    }
    try {
      dest.end();
    } catch {
      // best effort
    }
  }
  activeFileDestinations = [];
}

/**
 * Async test-only reset that WAITS for SonicBoom's underlying file
 * descriptor to close before resolving. Required on Windows where
 * rmSync of the parent directory throws ENOTEMPTY while any descendant
 * FD is still open. SonicBoom's `end()` is asynchronous — it queues a
 * flush + close; the FD remains open until the 'close' event fires.
 *
 * Use in test `afterEach` / `finally` cleanup blocks that delete the
 * LOG_FILE's parent dir. Tests not touching disk can keep using the
 * sync `_resetLoggerForTests()`.
 */
export function _closeLoggerStreamsForTests(): Promise<void> {
  rootLogger = null;
  childCache.clear();
  const dests = activeFileDestinations;
  activeFileDestinations = [];
  return new Promise<void>((resolve) => {
    if (dests.length === 0) {
      resolve();
      return;
    }
    let remaining = dests.length;
    const done = () => {
      remaining--;
      if (remaining <= 0) resolve();
    };
    for (const dest of dests) {
      try {
        dest.flushSync();
      } catch {
        // best effort
      }
      // SonicBoom emits 'close' after the FD is actually released. If
      // anything goes wrong (already destroyed / never opened), still
      // count it as done to avoid hanging the test.
      let settled = false;
      const tick = () => {
        if (settled) return;
        settled = true;
        done();
      };
      try {
        // Cast: pino's exported type is structural; SonicBoom's `on` is
        // present at runtime but not in pino's published .d.ts.
        const eventTarget = dest as unknown as {
          on: (event: string, handler: () => void) => void;
        };
        eventTarget.on("close", tick);
        eventTarget.on("error", tick);
        dest.end();
      } catch {
        tick();
      }
      // Hard timeout: never wait more than 5s for one stream to close.
      setTimeout(tick, 5000).unref?.();
    }
  });
}

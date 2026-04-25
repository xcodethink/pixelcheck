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

function buildOptions(): LoggerOptions {
  const opts: LoggerOptions = {
    level: resolveLevel(),
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
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

function buildDestination() {
  if (isPretty()) return undefined;
  const file = process.env.LOG_FILE;
  if (file && file.length > 0) {
    return pino.multistream([
      { stream: pino.destination({ dest: 2, sync: false }) },
      { stream: pino.destination({ dest: file, sync: false, mkdir: true }) },
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
 */
export function _resetLoggerForTests(): void {
  rootLogger = null;
  childCache.clear();
}

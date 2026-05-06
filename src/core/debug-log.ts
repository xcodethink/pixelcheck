/**
 * Local debug log writer for PixelCheck.
 *
 * Writes detailed debug information to a local file for post-mortem
 * analysis of audit runs. Separate from the pino logger (which goes
 * to stderr for real-time monitoring). The debug log captures:
 *
 *   - Full LLM request/response pairs (with cost)
 *   - Browser navigation events
 *   - Step timing breakdowns
 *   - Plugin hook invocations
 *   - Error stack traces
 *
 * Enable via: PIXELCHECK_DEBUG_LOG=1 or --debug-log flag.
 * Output location: <outputRoot>/<runId>/debug.log (NDJSON format).
 *
 * The file is append-only NDJSON — each line is a self-contained JSON
 * object with `timestamp`, `category`, `event`, and `data` fields.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getLogger } from "./logger.js";

const log = getLogger("debug-log");

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type DebugCategory =
  | "llm"
  | "browser"
  | "step"
  | "plugin"
  | "error"
  | "config"
  | "network"
  | "performance"
  | "lifecycle";

export interface DebugEntry {
  timestamp: string;
  category: DebugCategory;
  event: string;
  data: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────
// DebugLogger
// ─────────────────────────────────────────────────────────────

export class DebugLogger {
  private fd: number | null = null;
  private entryCount = 0;
  private readonly filePath: string;
  private closed = false;

  constructor(
    private readonly outputDir: string,
    private readonly runId: string,
  ) {
    this.filePath = path.join(outputDir, "debug.log");
  }

  /**
   * Open the debug log file for writing. Creates the directory if needed.
   */
  open(): void {
    if (this.fd !== null) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    this.fd = fs.openSync(this.filePath, "a");
    this.write("lifecycle", "debug_log_opened", {
      runId: this.runId,
      pid: process.pid,
      nodeVersion: process.version,
    });
    log.debug({ path: this.filePath }, "debug log opened");
  }

  /**
   * Write a debug entry. No-op if the log is not open.
   */
  write(category: DebugCategory, event: string, data: Record<string, unknown> = {}): void {
    if (this.fd === null || this.closed) return;

    const entry: DebugEntry = {
      timestamp: new Date().toISOString(),
      category,
      event,
      data,
    };

    try {
      fs.writeSync(this.fd, JSON.stringify(entry) + "\n");
      this.entryCount++;
    } catch (err) {
      // Best-effort — don't crash the audit for debug logging
      log.warn({ err: (err as Error).message }, "debug log write failed");
    }
  }

  /**
   * Log an LLM request/response pair with cost information.
   */
  llm(event: string, data: {
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number;
    durationMs?: number;
    [key: string]: unknown;
  }): void {
    this.write("llm", event, data);
  }

  /**
   * Log a browser navigation or interaction event.
   */
  browser(event: string, data: {
    url?: string;
    action?: string;
    selector?: string;
    durationMs?: number;
    [key: string]: unknown;
  }): void {
    this.write("browser", event, data);
  }

  /**
   * Log step execution timing.
   */
  step(event: string, data: {
    stepIndex?: number;
    stepType?: string;
    durationMs?: number;
    status?: string;
    [key: string]: unknown;
  }): void {
    this.write("step", event, data);
  }

  /**
   * Log an error with full stack trace.
   */
  error(event: string, error: Error, extra: Record<string, unknown> = {}): void {
    this.write("error", event, {
      ...extra,
      message: error.message,
      stack: error.stack,
      name: error.name,
    });
  }

  /**
   * Close the debug log file.
   */
  close(): void {
    if (this.fd === null || this.closed) return;
    this.write("lifecycle", "debug_log_closed", {
      entryCount: this.entryCount,
    });
    try {
      fs.closeSync(this.fd);
    } catch {
      // ignore close errors
    }
    this.fd = null;
    this.closed = true;
    log.debug({ path: this.filePath, entries: this.entryCount }, "debug log closed");
  }

  /**
   * Get the file path of the debug log.
   */
  getPath(): string {
    return this.filePath;
  }

  /**
   * Get the number of entries written.
   */
  getEntryCount(): number {
    return this.entryCount;
  }

  /**
   * Check if the log is currently open.
   */
  isOpen(): boolean {
    return this.fd !== null && !this.closed;
  }
}

// ─────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────

/**
 * Check if debug logging is enabled via env or flag.
 */
export function isDebugLogEnabled(): boolean {
  const envVal = process.env.PIXELCHECK_DEBUG_LOG ?? process.env.AUDIT_DEBUG_LOG ?? "";
  return envVal === "1" || envVal.toLowerCase() === "true";
}

/**
 * Create a DebugLogger if debug logging is enabled, otherwise return
 * a no-op proxy that silently discards all writes.
 */
export function createDebugLogger(outputDir: string, runId: string): DebugLogger {
  const logger = new DebugLogger(outputDir, runId);
  if (isDebugLogEnabled()) {
    logger.open();
  }
  return logger;
}

// ─────────────────────────────────────────────────────────────
// Reader (for post-mortem analysis)
// ─────────────────────────────────────────────────────────────

/**
 * Read and parse a debug log file. Returns parsed entries.
 */
export function readDebugLog(filePath: string): DebugEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as DebugEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is DebugEntry => entry !== null);
}

/**
 * Filter debug log entries by category.
 */
export function filterDebugLog(entries: DebugEntry[], category: DebugCategory): DebugEntry[] {
  return entries.filter((e) => e.category === category);
}

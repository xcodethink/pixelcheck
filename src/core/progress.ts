/**
 * Progress reporter for CLI audit runs.
 *
 * Shows a spinner + progress bar in TTY environments (via `ora`) and
 * emits plain-text status lines in non-TTY / CI environments. Calculates
 * ETA based on elapsed time and completed steps.
 *
 * Designed to be wired into the runner as an observer — the runner calls
 * `start()`, `tick()`, `update()`, and `finish()` / `fail()` at the
 * appropriate lifecycle points. The reporter owns all user-visible
 * output; the runner stays output-free.
 *
 * Structured log events are emitted via pino so CI pipelines can
 * consume progress as JSON without parsing human-readable text.
 *
 * Usage:
 *   import { ProgressReporter } from "./progress.js";
 *   const progress = new ProgressReporter();
 *   progress.start(10);
 *   progress.tick("Auditing homepage");
 *   progress.update("Waiting for page load...");
 *   progress.finish({ pass: 8, fail: 2, duration_ms: 45000 });
 */

import ora, { type Ora } from "ora";
import { getLogger } from "./logger.js";

const log = getLogger("progress");

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

/** Summary object passed to `finish()`. */
export interface ProgressSummary {
  pass: number;
  fail: number;
  duration_ms: number;
  [key: string]: unknown;
}

/** Structured event emitted via the pino logger on every state change. */
export interface ProgressEvent {
  kind: "progress";
  phase: "start" | "tick" | "update" | "finish" | "fail";
  completed: number;
  total: number;
  pct: number;
  eta_ms: number | null;
  label: string;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Detect whether stderr is a TTY (spinner-capable). */
export function isTTY(): boolean {
  return Boolean((process.stderr as NodeJS.WriteStream).isTTY);
}

/** Format milliseconds as `Xm Ys` or `Ys`. */
function formatDuration(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return "--";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

/**
 * Render a text-based progress bar.
 *
 * Example: `[=========>          ] 45%`
 */
function renderBar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const arrow = filled > 0 && filled < width ? ">" : "";
  const filledStr = "=".repeat(Math.max(0, filled - (arrow ? 1 : 0)));
  const emptyStr = " ".repeat(Math.max(0, empty));
  return `[${filledStr}${arrow}${emptyStr}]`;
}

// ─────────────────────────────────────────────────────────────
// ProgressReporter
// ─────────────────────────────────────────────────────────────

export class ProgressReporter {
  private total = 0;
  private completed = 0;
  private startTime = 0;
  private spinner: Ora | null = null;
  private tty: boolean;
  private lastLabel = "";

  constructor(opts?: { forceTTY?: boolean }) {
    this.tty = opts?.forceTTY ?? isTTY();
  }

  // ── Lifecycle ────────────────────────────────────────────

  /**
   * Begin tracking progress for `total` steps. Pass 0 or omit for an
   * indeterminate progress indicator (no percentage / ETA).
   */
  start(total: number): void {
    this.total = Math.max(0, Math.floor(total));
    this.completed = 0;
    this.startTime = Date.now();
    this.lastLabel = "Starting audit...";

    const event = this.buildEvent("start", this.lastLabel);
    log.info(event, this.lastLabel);

    if (this.tty) {
      this.spinner = ora({
        text: this.formatSpinnerText(this.lastLabel),
        stream: process.stderr,
      }).start();
    } else {
      this.writeLineNonTTY(this.lastLabel, event);
    }
  }

  /**
   * Mark one step as completed. `label` describes the step just
   * finished (e.g. "Audited homepage — desktop").
   */
  tick(label: string): void {
    this.completed = Math.min(this.completed + 1, Math.max(this.total, this.completed + 1));
    this.lastLabel = label;

    const event = this.buildEvent("tick", label);
    log.info(event, label);

    if (this.tty && this.spinner) {
      this.spinner.text = this.formatSpinnerText(label);
    } else if (!this.tty) {
      this.writeLineNonTTY(label, event);
    }
  }

  /**
   * Update the status message without advancing the step counter.
   * Use for sub-step activity like "Waiting for page load...".
   */
  update(message: string): void {
    this.lastLabel = message;

    const event = this.buildEvent("update", message);
    log.debug(event, message);

    if (this.tty && this.spinner) {
      this.spinner.text = this.formatSpinnerText(message);
    }
    // Non-TTY: update() is silent to avoid flooding CI logs.
    // Sub-step detail goes to pino at debug level only.
  }

  /**
   * Signal successful completion. `summary` carries final stats
   * that are included in the structured log event.
   */
  finish(summary: ProgressSummary): void {
    const event = this.buildEvent("finish", "Audit complete");
    log.info({ ...event, summary }, "Audit complete");

    const msg = `Audit complete: ${summary.pass} passed, ${summary.fail} failed (${formatDuration(summary.duration_ms)})`;

    if (this.tty && this.spinner) {
      this.spinner.succeed(msg);
      this.spinner = null;
    } else if (!this.tty) {
      this.writeLineNonTTY(msg, event);
    }
  }

  /**
   * Signal a fatal error that stopped the run. The spinner shows
   * a failure indicator; the error message is logged at error level.
   */
  fail(error: string): void {
    const event = this.buildEvent("fail", error);
    log.error(event, error);

    if (this.tty && this.spinner) {
      this.spinner.fail(error);
      this.spinner = null;
    } else if (!this.tty) {
      this.writeLineNonTTY(`[FAIL] ${error}`, event);
    }
  }

  // ── Computed state ───────────────────────────────────────

  /** Current completion percentage (0-100). 0 when total is unknown. */
  get pct(): number {
    if (this.total <= 0) return 0;
    return Math.min(100, Math.round((this.completed / this.total) * 100));
  }

  /** Estimated milliseconds remaining, or null if incalculable. */
  get etaMs(): number | null {
    if (this.total <= 0 || this.completed <= 0) return null;
    const elapsed = Date.now() - this.startTime;
    const msPerStep = elapsed / this.completed;
    const remaining = this.total - this.completed;
    return Math.round(msPerStep * remaining);
  }

  /** Number of steps completed so far. */
  get stepsCompleted(): number {
    return this.completed;
  }

  /** Total number of steps, or 0 for indeterminate. */
  get stepsTotal(): number {
    return this.total;
  }

  // ── Internal ─────────────────────────────────────────────

  private buildEvent(phase: ProgressEvent["phase"], label: string): ProgressEvent {
    return {
      kind: "progress",
      phase,
      completed: this.completed,
      total: this.total,
      pct: this.pct,
      eta_ms: this.etaMs,
      label,
    };
  }

  private formatSpinnerText(label: string): string {
    if (this.total <= 0) {
      return label;
    }
    const eta = this.etaMs;
    const etaStr = eta !== null ? ` | ETA ${formatDuration(eta)}` : "";
    return `${renderBar(this.pct)} ${this.pct}% (${this.completed}/${this.total})${etaStr} | ${label}`;
  }

  private writeLineNonTTY(label: string, event: ProgressEvent): void {
    const prefix = this.total > 0
      ? `[${this.completed}/${this.total}]`
      : `[${this.completed}/?]`;
    const eta = event.eta_ms !== null ? ` ETA ${formatDuration(event.eta_ms)}` : "";
    // Write to stderr so stdout stays clean for piped JSON / MCP frames.
    process.stderr.write(`${prefix}${eta} ${label}\n`);
  }
}

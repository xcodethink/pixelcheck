/**
 * Error Signal Collector — Captures client-side errors during a step.
 *
 * Sources:
 * - console.error / console.warn
 * - Uncaught exceptions (pageerror)
 * - Failed resource loads (4xx/5xx on non-XHR resources — CSS/JS/img)
 * - Unhandled promise rejections (surfaced as pageerror by Playwright)
 *
 * Zero LLM cost.
 *
 * Note: we intentionally keep this separate from NetworkSignalCollector so a
 * consumer can enable error tracking without paying the full request log cost.
 */

import type { Page, ConsoleMessage, Request } from "playwright";

export interface ErrorRecord {
  type: "console" | "pageerror" | "requestfailed" | "resource_4xx_5xx";
  severity: "error" | "warning";
  message: string;
  url?: string;
  location?: string;
  timestamp: number;
}

export interface ErrorSignal {
  total: number;
  console_errors: number;
  console_warnings: number;
  pageerrors: number;
  request_failures: number;
  records: ErrorRecord[];
  window_ms: number;
}

export interface ErrorExpectation {
  console_error_max?: number;
  console_warning_max?: number;
  pageerror_max?: number;
  request_failure_max?: number;
  /** Regex of allowed-to-ignore error message patterns (e.g., known third-party noise) */
  ignore_patterns?: string[];
}

export interface ErrorMatchResult {
  met: boolean;
  violations: string[];
}

export class ErrorSignalCollector {
  private _records: ErrorRecord[] = [];
  private _started = 0;
  private _listening = false;
  private _ignorePatterns: RegExp[] = [];

  private _onConsole = (msg: ConsoleMessage): void => {
    const t = msg.type();
    if (t !== "error" && t !== "warning") return;
    const text = safeText(msg);
    if (this._isIgnored(text)) return;
    this._records.push({
      type: "console",
      severity: t === "error" ? "error" : "warning",
      message: text,
      location: `${msg.location().url}:${msg.location().lineNumber}`,
      timestamp: Date.now(),
    });
  };
  private _onPageError = (err: Error): void => {
    const text = err.message || String(err);
    if (this._isIgnored(text)) return;
    this._records.push({
      type: "pageerror",
      severity: "error",
      message: text,
      location: err.stack?.split("\n")[1]?.trim(),
      timestamp: Date.now(),
    });
  };
  private _onRequestFailed = (req: Request): void => {
    const text = `${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "failed"}`;
    if (this._isIgnored(text)) return;
    this._records.push({
      type: "requestfailed",
      severity: "error",
      message: text,
      url: req.url(),
      timestamp: Date.now(),
    });
  };
  private _onResponse = async (res: { status(): number; url(): string; request(): Request }): Promise<void> => {
    const status = res.status();
    if (status < 400) return;
    const req = res.request();
    // Skip XHR/fetch — those are handled by application code and tracked in NetworkSignal.
    const rtype = req.resourceType();
    if (rtype === "xhr" || rtype === "fetch") return;
    const text = `${status} on ${rtype} ${res.url()}`;
    if (this._isIgnored(text)) return;
    this._records.push({
      type: "resource_4xx_5xx",
      severity: "error",
      message: text,
      url: res.url(),
      timestamp: Date.now(),
    });
  };

  constructor(private _page: Page) {}

  setIgnorePatterns(patterns: string[]): void {
    this._ignorePatterns = patterns.map((p) => new RegExp(p));
  }

  start(): void {
    if (this._listening) return;
    this._listening = true;
    this._started = Date.now();
    this._page.on("console", this._onConsole);
    this._page.on("pageerror", this._onPageError);
    this._page.on("requestfailed", this._onRequestFailed);
    this._page.on("response", this._onResponse as any);
  }

  stop(): void {
    if (!this._listening) return;
    this._listening = false;
    this._page.off("console", this._onConsole);
    this._page.off("pageerror", this._onPageError);
    this._page.off("requestfailed", this._onRequestFailed);
    this._page.off("response", this._onResponse as any);
  }

  reset(): void {
    this._records = [];
    this._started = Date.now();
  }

  snapshot(): ErrorSignal {
    let consoleErrors = 0;
    let consoleWarnings = 0;
    let pageerrors = 0;
    let requestFailures = 0;
    for (const r of this._records) {
      if (r.type === "console" && r.severity === "error") consoleErrors++;
      else if (r.type === "console" && r.severity === "warning") consoleWarnings++;
      else if (r.type === "pageerror") pageerrors++;
      else if (r.type === "requestfailed" || r.type === "resource_4xx_5xx") requestFailures++;
    }
    return {
      total: this._records.length,
      console_errors: consoleErrors,
      console_warnings: consoleWarnings,
      pageerrors,
      request_failures: requestFailures,
      records: [...this._records],
      window_ms: Date.now() - this._started,
    };
  }

  private _isIgnored(text: string): boolean {
    return this._ignorePatterns.some((re) => re.test(text));
  }
}

function safeText(msg: ConsoleMessage): string {
  try {
    return msg.text();
  } catch {
    return "(unreadable console message)";
  }
}

export function matchErrors(signal: ErrorSignal, expected: ErrorExpectation): ErrorMatchResult {
  const violations: string[] = [];
  const check = (actual: number, max: number | undefined, label: string): void => {
    if (max === undefined) return;
    if (actual > max) violations.push(`${label}: ${actual} > ${max}`);
  };
  check(signal.console_errors, expected.console_error_max, "console_errors");
  check(signal.console_warnings, expected.console_warning_max, "console_warnings");
  check(signal.pageerrors, expected.pageerror_max, "pageerrors");
  check(signal.request_failures, expected.request_failure_max, "request_failures");
  return { met: violations.length === 0, violations };
}

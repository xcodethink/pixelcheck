/**
 * Network Signal Collector — Records HTTP requests/responses during a step.
 *
 * Captures:
 * - URL, method, status, duration, size
 * - Failed requests (4xx / 5xx / network errors)
 * - Time-windowed snapshots (start → end of a step)
 *
 * Zero LLM cost; pure Playwright event-based.
 *
 * Usage:
 *   const collector = new NetworkSignalCollector(page);
 *   collector.start();
 *   // ... run step ...
 *   const signal = collector.snapshot();
 *   collector.reset();
 */

import type { Page, Request, Response } from "playwright";

export interface NetworkRequest {
  url: string;
  method: string;
  status: number | null;
  duration_ms: number | null;
  resource_type: string;
  failed: boolean;
  failure_reason?: string;
  started_at: number; // epoch ms
}

export interface NetworkSignal {
  total_requests: number;
  failed_requests: number;
  status_counts: Record<string, number>; // "2xx" | "3xx" | "4xx" | "5xx" | "err"
  slow_requests: NetworkRequest[]; // > slowThresholdMs
  failures: NetworkRequest[];
  all: NetworkRequest[];
  window_ms: number;
}

export interface NetworkMatcher {
  url_pattern?: string; // substring or regex if prefixed with 're:'
  method?: string;
  status_range?: [number, number];
  max_duration_ms?: number;
}

export class NetworkSignalCollector {
  private _records = new Map<Request, NetworkRequest>();
  private _started = 0;
  private _listening = false;
  private _onRequest = (req: Request): void => {
    this._records.set(req, {
      url: req.url(),
      method: req.method(),
      status: null,
      duration_ms: null,
      resource_type: req.resourceType(),
      failed: false,
      started_at: Date.now(),
    });
  };
  private _onResponse = (res: Response): void => {
    const rec = this._records.get(res.request());
    if (!rec) return;
    rec.status = res.status();
    rec.duration_ms = Date.now() - rec.started_at;
  };
  private _onRequestFailed = (req: Request): void => {
    const rec = this._records.get(req);
    if (!rec) return;
    rec.failed = true;
    rec.failure_reason = req.failure()?.errorText ?? "unknown";
    rec.duration_ms = Date.now() - rec.started_at;
  };

  constructor(
    private _page: Page,
    private _slowThresholdMs: number = 3000,
  ) {}

  /**
   * Start listening. Idempotent — calling twice is a no-op.
   */
  start(): void {
    if (this._listening) return;
    this._listening = true;
    this._started = Date.now();
    this._page.on("request", this._onRequest);
    this._page.on("response", this._onResponse);
    this._page.on("requestfailed", this._onRequestFailed);
  }

  /**
   * Stop listening and release handlers. Idempotent.
   */
  stop(): void {
    if (!this._listening) return;
    this._listening = false;
    this._page.off("request", this._onRequest);
    this._page.off("response", this._onResponse);
    this._page.off("requestfailed", this._onRequestFailed);
  }

  /**
   * Clear all records but keep listening.
   */
  reset(): void {
    this._records.clear();
    this._started = Date.now();
  }

  /**
   * Produce a signal snapshot without stopping collection.
   */
  snapshot(): NetworkSignal {
    const all = Array.from(this._records.values());
    const failures: NetworkRequest[] = [];
    const slow: NetworkRequest[] = [];
    const statusCounts: Record<string, number> = {};

    for (const r of all) {
      if (r.failed) {
        failures.push(r);
        statusCounts.err = (statusCounts.err ?? 0) + 1;
        continue;
      }
      if (r.status === null) continue; // in-flight
      const bucket = `${Math.floor(r.status / 100)}xx`;
      statusCounts[bucket] = (statusCounts[bucket] ?? 0) + 1;
      if (r.status >= 400) failures.push(r);
      if (r.duration_ms !== null && r.duration_ms > this._slowThresholdMs) {
        slow.push(r);
      }
    }

    return {
      total_requests: all.length,
      failed_requests: failures.length,
      status_counts: statusCounts,
      slow_requests: slow,
      failures,
      all,
      window_ms: Date.now() - this._started,
    };
  }

  /**
   * Find requests matching a criterion (used for network criterion checking).
   */
  findMatching(matcher: NetworkMatcher): NetworkRequest[] {
    return Array.from(this._records.values()).filter((r) => {
      if (matcher.url_pattern) {
        if (matcher.url_pattern.startsWith("re:")) {
          const re = new RegExp(matcher.url_pattern.slice(3));
          if (!re.test(r.url)) return false;
        } else if (!r.url.includes(matcher.url_pattern)) {
          return false;
        }
      }
      if (matcher.method && r.method.toUpperCase() !== matcher.method.toUpperCase()) {
        return false;
      }
      if (matcher.status_range && r.status !== null) {
        const [min, max] = matcher.status_range;
        if (r.status < min || r.status > max) return false;
      }
      if (
        matcher.max_duration_ms !== undefined &&
        r.duration_ms !== null &&
        r.duration_ms > matcher.max_duration_ms
      ) {
        return false;
      }
      return true;
    });
  }
}

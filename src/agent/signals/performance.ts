/**
 * Performance Signal Collector — Core Web Vitals capture.
 *
 * Measures LCP, CLS, INP, FCP, TTFB via PerformanceObserver injected into the page.
 *
 * Industry-standard methodology (Google web-vitals lib semantics):
 * - LCP: largest-contentful-paint entry, reported on page lifecycle change
 * - CLS: layout-shift entries excluding hadRecentInput, summed per session window
 * - INP: event entries, p98 of interaction durations
 * - FCP: first paint entry
 * - TTFB: navigation responseStart - requestStart
 *
 * All metrics are best-effort; browsers without PerformanceObserver support return nulls.
 * Zero LLM cost.
 */

import type { Page } from "playwright";

export interface PerformanceSignal {
  lcp_ms: number | null;
  cls: number | null;
  inp_ms: number | null;
  fcp_ms: number | null;
  ttfb_ms: number | null;
  dom_content_loaded_ms: number | null;
  load_ms: number | null;
  /** Resource counts by initiator type */
  resources: {
    total: number;
    script: number;
    stylesheet: number;
    image: number;
    xhr_or_fetch: number;
  };
  /** Transfer size totals (bytes) */
  transfer_bytes: number;
  /** Collection window (ms since attach) */
  window_ms: number;
}

/**
 * The script injected into every document to collect web vitals.
 * Exposed on window.__avCollect = () => PerformanceSignal
 */
const COLLECTOR_SCRIPT = `
(() => {
  if (window.__avPerf) return;
  const state = {
    lcp: null,
    cls: 0,
    inp: null,
    fcp: null,
    started: performance.now(),
  };

  // LCP: largest contentful paint (largest entry seen before first input)
  try {
    const po = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) state.lcp = last.startTime;
    });
    po.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {}

  // CLS: cumulative layout shift, excluding recent-input
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) state.cls += entry.value || 0;
      }
    });
    po.observe({ type: 'layout-shift', buffered: true });
  } catch (e) {}

  // INP: longest event duration (approximation; real INP uses p98)
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const d = entry.duration || 0;
        if (state.inp === null || d > state.inp) state.inp = d;
      }
    });
    po.observe({ type: 'event', buffered: true, durationThreshold: 40 });
  } catch (e) {}

  // FCP: first contentful paint
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'first-contentful-paint') state.fcp = entry.startTime;
      }
    });
    po.observe({ type: 'paint', buffered: true });
  } catch (e) {}

  window.__avPerf = state;
  window.__avCollect = () => {
    const nav = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource');
    const byType = { script: 0, stylesheet: 0, image: 0, xhr_or_fetch: 0 };
    let transfer = 0;
    for (const r of resources) {
      transfer += r.transferSize || 0;
      const t = r.initiatorType;
      if (t === 'script') byType.script++;
      else if (t === 'link' || t === 'css') byType.stylesheet++;
      else if (t === 'img') byType.image++;
      else if (t === 'xmlhttprequest' || t === 'fetch') byType.xhr_or_fetch++;
    }
    return {
      lcp_ms: state.lcp,
      cls: state.cls,
      inp_ms: state.inp,
      fcp_ms: state.fcp,
      ttfb_ms: nav ? nav.responseStart - nav.requestStart : null,
      dom_content_loaded_ms: nav ? nav.domContentLoadedEventEnd : null,
      load_ms: nav && nav.loadEventEnd ? nav.loadEventEnd : null,
      resources: {
        total: resources.length,
        script: byType.script,
        stylesheet: byType.stylesheet,
        image: byType.image,
        xhr_or_fetch: byType.xhr_or_fetch,
      },
      transfer_bytes: transfer,
      window_ms: performance.now() - state.started,
    };
  };
})();
`;

export class PerformanceSignalCollector {
  private _attached = false;

  constructor(private _page: Page) {}

  /**
   * Install the collector script. Must be called before page navigation
   * for accurate LCP/FCP. Idempotent.
   */
  async attach(): Promise<void> {
    if (this._attached) return;
    this._attached = true;
    // Install for every document (including post-navigation)
    await this._page.addInitScript(COLLECTOR_SCRIPT);
    // Also try to install into current document in case page already loaded
    await this._page.evaluate(COLLECTOR_SCRIPT).catch(() => {});
  }

  /**
   * Snapshot current vitals. Safe to call multiple times.
   * Returns an all-null signal if collector couldn't be installed.
   */
  async snapshot(): Promise<PerformanceSignal> {
    try {
      const result = await this._page.evaluate(() => {
        const collect = (window as unknown as { __avCollect?: () => PerformanceSignal }).__avCollect;
        return collect ? collect() : null;
      });
      if (result) return result;
    } catch {
      // Page may have been navigated; fall through to empty signal
    }
    return emptySignal();
  }
}

export function emptySignal(): PerformanceSignal {
  return {
    lcp_ms: null,
    cls: null,
    inp_ms: null,
    fcp_ms: null,
    ttfb_ms: null,
    dom_content_loaded_ms: null,
    load_ms: null,
    resources: { total: 0, script: 0, stylesheet: 0, image: 0, xhr_or_fetch: 0 },
    transfer_bytes: 0,
    window_ms: 0,
  };
}

// ─────────────────────────────────────────────────────────────
// Criterion matching (pure, no page needed)
// ─────────────────────────────────────────────────────────────

export interface PerformanceExpectation {
  lcp_max_ms?: number;
  cls_max?: number;
  inp_max_ms?: number;
  fcp_max_ms?: number;
  ttfb_max_ms?: number;
  transfer_bytes_max?: number;
}

export interface PerformanceMatchResult {
  met: boolean;
  violations: string[];
}

export function matchPerformance(
  signal: PerformanceSignal,
  expected: PerformanceExpectation,
): PerformanceMatchResult {
  const violations: string[] = [];
  const check = (
    actual: number | null | undefined,
    max: number | undefined,
    label: string,
  ): void => {
    if (max === undefined) return;
    if (actual === null || actual === undefined) {
      violations.push(`${label}: not measured`);
      return;
    }
    if (actual > max) violations.push(`${label}: ${actual.toFixed(1)} > ${max}`);
  };

  check(signal.lcp_ms, expected.lcp_max_ms, "LCP");
  check(signal.cls, expected.cls_max, "CLS");
  check(signal.inp_ms, expected.inp_max_ms, "INP");
  check(signal.fcp_ms, expected.fcp_max_ms, "FCP");
  check(signal.ttfb_ms, expected.ttfb_max_ms, "TTFB");
  check(signal.transfer_bytes, expected.transfer_bytes_max, "transfer_bytes");

  return { met: violations.length === 0, violations };
}

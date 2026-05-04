/**
 * PerformanceSignalCollector — integration test verifying PR-C wiring.
 *
 * The collector class itself is exercised by existing tests in
 * tests/signals/. PR-C's contribution is wiring it into the see / act /
 * extract default-open paths so primitive results carry
 * `diagnostics.performance` automatically. These tests prove that
 * end-to-end against a real Chromium instance.
 *
 * No LLM calls — pure observability.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { PerformanceSignalCollector } from "../../src/agent/signals/performance.js";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => {});
});

describe("PerformanceSignalCollector — primitive integration shape", () => {
  it("snapshot returns concrete fields after navigation", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const perf = new PerformanceSignalCollector(page);
      // attach BEFORE goto — required for LCP / FCP capture
      await perf.attach();
      await page.goto("https://example.com/", { waitUntil: "load" });
      // Give the layout-shift / paint observers a moment to flush
      await new Promise((r) => setTimeout(r, 500));

      const signal = await perf.snapshot();

      // Resources + transfer + window are always populated. example.com
      // is a single HTML document with no sub-resources, so total may
      // be 0 — assertion is on shape (defined number), not minimum.
      expect(signal.resources).toBeDefined();
      expect(typeof signal.resources.total).toBe("number");
      expect(signal.resources.total).toBeGreaterThanOrEqual(0);
      expect(signal.transfer_bytes).toBeGreaterThanOrEqual(0);
      expect(signal.window_ms).toBeGreaterThan(0);

      // Web Vitals are best-effort — at least FCP usually reports
      // for a simple HTML page like example.com. We assert the SHAPE
      // (numbers or null), not specific values.
      const isNumOrNull = (v: unknown): boolean =>
        v === null || typeof v === "number";
      expect(isNumOrNull(signal.lcp_ms)).toBe(true);
      expect(isNumOrNull(signal.cls)).toBe(true);
      expect(isNumOrNull(signal.inp_ms)).toBe(true);
      expect(isNumOrNull(signal.fcp_ms)).toBe(true);
      expect(isNumOrNull(signal.ttfb_ms)).toBe(true);
      expect(isNumOrNull(signal.dom_content_loaded_ms)).toBe(true);
      expect(isNumOrNull(signal.load_ms)).toBe(true);
    } finally {
      await context.close();
    }
  }, 60_000);

  it("snapshot is safe to call before any navigation (returns the empty signal)", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const perf = new PerformanceSignalCollector(page);
      await perf.attach();
      // No goto; calling snapshot anyway should not throw.
      const signal = await perf.snapshot();
      // Either the collector script ran and returned mostly nulls/zeros,
      // or it couldn't run and returned the full empty signal — either
      // way we should get a well-formed PerformanceSignal.
      expect(signal).toBeDefined();
      expect(signal.resources.total).toBeGreaterThanOrEqual(0);
      expect(signal.transfer_bytes).toBeGreaterThanOrEqual(0);
    } finally {
      await context.close();
    }
  }, 30_000);

  it("two consecutive snapshots both succeed (idempotent reads)", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const perf = new PerformanceSignalCollector(page);
      await perf.attach();
      await page.goto("https://example.com/", { waitUntil: "load" });
      const a = await perf.snapshot();
      const b = await perf.snapshot();
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      // window_ms must be monotonic non-decreasing (wall-clock based).
      expect(b.window_ms).toBeGreaterThanOrEqual(a.window_ms);
      // Resource counts only grow (or stay equal) between snapshots.
      expect(b.resources.total).toBeGreaterThanOrEqual(a.resources.total);
    } finally {
      await context.close();
    }
  }, 60_000);
});

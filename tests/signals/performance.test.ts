/**
 * Tests for matchPerformance (pure function — no browser needed).
 *
 * The actual DOM injection / PerformanceObserver path is covered by
 * integration tests against the fixture site (see tests/integration/).
 */

import { describe, it, expect } from "vitest";
import {
  matchPerformance,
  emptySignal,
  type PerformanceSignal,
} from "../../src/agent/signals/performance.js";

function mkSignal(overrides: Partial<PerformanceSignal> = {}): PerformanceSignal {
  return { ...emptySignal(), ...overrides };
}

describe("matchPerformance", () => {
  it("returns met=true when no expectations provided", () => {
    const r = matchPerformance(mkSignal({ lcp_ms: 5000 }), {});
    expect(r.met).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it("passes when all thresholds respected", () => {
    const sig = mkSignal({ lcp_ms: 1800, cls: 0.05, inp_ms: 120, fcp_ms: 800 });
    const r = matchPerformance(sig, {
      lcp_max_ms: 2500,
      cls_max: 0.1,
      inp_max_ms: 200,
      fcp_max_ms: 1500,
    });
    expect(r.met).toBe(true);
  });

  it("flags LCP violation", () => {
    const r = matchPerformance(mkSignal({ lcp_ms: 3500 }), { lcp_max_ms: 2500 });
    expect(r.met).toBe(false);
    expect(r.violations[0]).toMatch(/LCP/);
  });

  it("flags CLS violation", () => {
    const r = matchPerformance(mkSignal({ cls: 0.3 }), { cls_max: 0.1 });
    expect(r.met).toBe(false);
    expect(r.violations[0]).toMatch(/CLS/);
  });

  it("flags multiple violations simultaneously", () => {
    const sig = mkSignal({ lcp_ms: 4000, cls: 0.4, inp_ms: 500 });
    const r = matchPerformance(sig, { lcp_max_ms: 2500, cls_max: 0.1, inp_max_ms: 200 });
    expect(r.met).toBe(false);
    expect(r.violations).toHaveLength(3);
  });

  it("marks unmeasured metrics as violations when a threshold is set", () => {
    const r = matchPerformance(mkSignal({ lcp_ms: null }), { lcp_max_ms: 2500 });
    expect(r.met).toBe(false);
    expect(r.violations[0]).toMatch(/not measured/);
  });

  it("transfer_bytes threshold enforced", () => {
    const r = matchPerformance(
      mkSignal({ transfer_bytes: 3_500_000 }),
      { transfer_bytes_max: 2_000_000 },
    );
    expect(r.met).toBe(false);
    expect(r.violations[0]).toMatch(/transfer_bytes/);
  });
});

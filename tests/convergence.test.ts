import { describe, it, expect } from "vitest";
import {
  ConvergenceTracker,
  initCriteriaState,
  allCriteriaMet,
  type ActionRecord,
} from "../src/agent/convergence.js";

describe("ConvergenceTracker", () => {
  function makeRecord(overrides?: Partial<ActionRecord>): ActionRecord {
    return {
      url: "https://example.com",
      instruction: "Click button",
      dom_fingerprint: "abc123",
      success: true,
      ...overrides,
    };
  }

  it("returns continue for normal actions", () => {
    const tracker = new ConvergenceTracker(3, 3);
    const signal = tracker.recordAction(makeRecord());
    expect(signal.type).toBe("continue");
    expect(tracker.totalActions).toBe(1);
    expect(tracker.consecutiveFailures).toBe(0);
  });

  it("detects loops after 3 identical actions", () => {
    const tracker = new ConvergenceTracker(3, 3);
    const record = makeRecord();

    tracker.recordAction(record);
    tracker.recordAction(record);
    const signal = tracker.recordAction(record);

    expect(signal.type).toBe("loop_detected");
  });

  it("does not trigger loop/no-progress when the page state keeps advancing", () => {
    const tracker = new ConvergenceTracker(3, 3);

    // Distinct dom_fingerprint each step = real progress → never stuck.
    for (let i = 0; i < 10; i++) {
      const signal = tracker.recordAction(
        makeRecord({ instruction: `Action ${i}`, dom_fingerprint: `fp-${i}` }),
      );
      expect(signal.type).toBe("continue");
    }
  });

  it("detects no_progress when the page never advances despite varied instructions (Audit 2026-06-02 D2-C1)", () => {
    // The 26-step login-wall loop: every action 'succeeds' (fill passes) and
    // every instruction differs, but url + dom_fingerprint never change.
    // Default no-progress threshold is 8.
    const tracker = new ConvergenceTracker(3, 3, 8);
    let signal = tracker.recordAction(makeRecord({ instruction: "step 0" }));
    for (let i = 1; i <= 8 && signal.type === "continue"; i++) {
      signal = tracker.recordAction(
        makeRecord({ instruction: `step ${i}`, success: true }),
      );
    }
    expect(signal.type).toBe("no_progress");
  });

  it("legit multi-field form (below the no-progress threshold) does not trip", () => {
    const tracker = new ConvergenceTracker(3, 3, 8);
    // 6 fills on a structurally-stable form, then navigation (state changes).
    for (let i = 0; i < 6; i++) {
      const signal = tracker.recordAction(
        makeRecord({ instruction: `fill field ${i}`, success: true }),
      );
      expect(signal.type).toBe("continue");
    }
    const navSignal = tracker.recordAction(
      makeRecord({ instruction: "submit", dom_fingerprint: "next-page", success: true }),
    );
    expect(navSignal.type).toBe("continue");
  });

  it("does not trigger loop when URL differs", () => {
    const tracker = new ConvergenceTracker(3, 3);

    tracker.recordAction(makeRecord({ url: "https://a.com" }));
    tracker.recordAction(makeRecord({ url: "https://b.com" }));
    const signal = tracker.recordAction(makeRecord({ url: "https://c.com" }));

    expect(signal.type).toBe("continue");
  });

  it("detects stuck after N consecutive failures", () => {
    const tracker = new ConvergenceTracker(3, 3);

    // Use different instructions so loop detection doesn't trigger
    tracker.recordAction(makeRecord({ success: false, instruction: "A" }));
    tracker.recordAction(makeRecord({ success: false, instruction: "B" }));
    const signal = tracker.recordAction(
      makeRecord({ success: false, instruction: "C" }),
    );

    expect(signal.type).toBe("stuck");
    if (signal.type === "stuck") {
      expect(signal.consecutive_failures).toBe(3);
    }
  });

  it("resets consecutive failures on success", () => {
    const tracker = new ConvergenceTracker(3, 3);

    tracker.recordAction(makeRecord({ success: false, instruction: "A" }));
    tracker.recordAction(makeRecord({ success: false, instruction: "B" }));
    // Success resets counter
    tracker.recordAction(makeRecord({ success: true, instruction: "C" }));
    tracker.recordAction(makeRecord({ success: false, instruction: "D" }));
    tracker.recordAction(makeRecord({ success: false, instruction: "E" }));

    expect(tracker.consecutiveFailures).toBe(2);
    // Not stuck yet — only 2 consecutive
  });

  it("resetFailures clears counter", () => {
    const tracker = new ConvergenceTracker(3, 3);

    tracker.recordAction(makeRecord({ success: false, instruction: "A" }));
    tracker.recordAction(makeRecord({ success: false, instruction: "B" }));
    expect(tracker.consecutiveFailures).toBe(2);

    tracker.resetFailures();
    expect(tracker.consecutiveFailures).toBe(0);
  });

  it("tracks total actions correctly", () => {
    const tracker = new ConvergenceTracker(3, 3);

    for (let i = 0; i < 5; i++) {
      tracker.recordAction(makeRecord({ instruction: `Action ${i}` }));
    }

    expect(tracker.totalActions).toBe(5);
  });

  // ── checkLimits ─────────────────────────────────────────────

  it("returns budget_exceeded when cost exceeds cap", () => {
    const tracker = new ConvergenceTracker();
    const signal = tracker.checkLimits(3.5, 3.0, 100);
    expect(signal.type).toBe("budget_exceeded");
  });

  it("returns max_actions when actions exceed limit", () => {
    const tracker = new ConvergenceTracker();
    // Simulate actions
    for (let i = 0; i < 30; i++) {
      tracker.recordAction(makeRecord({ instruction: `Act ${i}` }));
    }
    const signal = tracker.checkLimits(0.5, 3.0, 30);
    expect(signal.type).toBe("max_actions");
  });

  it("returns continue when within limits", () => {
    const tracker = new ConvergenceTracker();
    const signal = tracker.checkLimits(0.5, 3.0, 100);
    expect(signal.type).toBe("continue");
  });
});

describe("CriteriaState", () => {
  it("initializes with all criteria pending", () => {
    const state = initCriteriaState([
      { id: "c1", description: "First", verification: "dom" },
      { id: "c2", description: "Second", verification: "visual" },
    ]);

    expect(state.pending.size).toBe(2);
    expect(state.met.size).toBe(0);
    expect(allCriteriaMet(state)).toBe(false);
  });

  it("allCriteriaMet returns true when all met", () => {
    const state = initCriteriaState([
      { id: "c1", description: "First", verification: "dom" },
    ]);

    state.met.add("c1");
    state.pending.delete("c1");

    expect(allCriteriaMet(state)).toBe(true);
  });

  it("allCriteriaMet returns true for empty criteria", () => {
    const state = initCriteriaState([]);
    expect(allCriteriaMet(state)).toBe(true);
  });

  it("tracks partial completion", () => {
    const state = initCriteriaState([
      { id: "c1", description: "First", verification: "dom" },
      { id: "c2", description: "Second", verification: "visual" },
      { id: "c3", description: "Third", verification: "extract" },
    ]);

    state.met.add("c1");
    state.pending.delete("c1");

    expect(state.met.size).toBe(1);
    expect(state.pending.size).toBe(2);
    expect(allCriteriaMet(state)).toBe(false);
  });
});

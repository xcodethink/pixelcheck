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

  it("does not trigger loop for different actions", () => {
    const tracker = new ConvergenceTracker(3, 3);

    for (let i = 0; i < 10; i++) {
      const signal = tracker.recordAction(
        makeRecord({ instruction: `Action ${i}` }),
      );
      expect(signal.type).toBe("continue");
    }
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

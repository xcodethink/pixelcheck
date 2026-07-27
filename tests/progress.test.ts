/**
 * Tests for src/core/progress.ts — ProgressReporter class.
 *
 * Covers TTY vs non-TTY behavior, ETA calculation, progress percentage,
 * and edge cases (0 steps, 1 step, unknown total).
 *
 * Pure logic + stderr capture — no real I/O or browser dependencies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProgressReporter, isTTY, type ProgressSummary } from "../src/core/progress.js";

// Silence pino during tests
vi.mock("../src/core/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// ─────────────────────────────────────────────────────────────
// isTTY detection
// ─────────────────────────────────────────────────────────────

describe("isTTY", () => {
  const original = (process.stderr as NodeJS.WriteStream).isTTY;

  afterEach(() => {
    Object.defineProperty(process.stderr, "isTTY", {
      value: original,
      writable: true,
      configurable: true,
    });
  });

  it("returns true when stderr.isTTY is true", () => {
    Object.defineProperty(process.stderr, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
    expect(isTTY()).toBe(true);
  });

  it("returns false when stderr.isTTY is undefined", () => {
    Object.defineProperty(process.stderr, "isTTY", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    expect(isTTY()).toBe(false);
  });

  it("returns false when stderr.isTTY is false", () => {
    Object.defineProperty(process.stderr, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });
    expect(isTTY()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// ETA calculation
// ─────────────────────────────────────────────────────────────

describe("ETA calculation", () => {
  it("returns null before any tick", () => {
    const p = new ProgressReporter({ forceTTY: false });
    p.start(5);
    expect(p.etaMs).toBeNull();
  });

  it("returns null when total is 0 (indeterminate)", () => {
    const p = new ProgressReporter({ forceTTY: false });
    p.start(0);
    p.tick("step");
    expect(p.etaMs).toBeNull();
  });

  it("calculates a positive ETA after a tick", async () => {
    const p = new ProgressReporter({ forceTTY: false });
    p.start(4);
    // Simulate time passing
    await new Promise((r) => setTimeout(r, 50));
    p.tick("step 1");
    const eta = p.etaMs;
    expect(eta).not.toBeNull();
    // 1 of 4 done after ~50ms, so ETA should be ~150ms (3 remaining)
    // Allow generous tolerance for CI timing jitter
    expect(eta!).toBeGreaterThan(30);
    expect(eta!).toBeLessThan(1000);
  });

  it("returns 0 ETA when all steps are done", async () => {
    const p = new ProgressReporter({ forceTTY: false });
    p.start(2);
    await new Promise((r) => setTimeout(r, 10));
    p.tick("step 1");
    p.tick("step 2");
    expect(p.etaMs).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Percentage tracking
// ─────────────────────────────────────────────────────────────

describe("percentage tracking", () => {
  it("starts at 0%", () => {
    const p = new ProgressReporter({ forceTTY: false });
    p.start(10);
    expect(p.pct).toBe(0);
  });

  it("reaches 100% after all ticks", () => {
    const p = new ProgressReporter({ forceTTY: false });
    p.start(3);
    p.tick("a");
    p.tick("b");
    p.tick("c");
    expect(p.pct).toBe(100);
  });

  it("reports intermediate percentages", () => {
    const p = new ProgressReporter({ forceTTY: false });
    p.start(4);
    p.tick("1");
    expect(p.pct).toBe(25);
    p.tick("2");
    expect(p.pct).toBe(50);
    p.tick("3");
    expect(p.pct).toBe(75);
    p.tick("4");
    expect(p.pct).toBe(100);
  });

  it("never exceeds 100% on extra ticks", () => {
    const p = new ProgressReporter({ forceTTY: false });
    p.start(2);
    p.tick("1");
    p.tick("2");
    p.tick("extra");
    // pct should cap at 100
    expect(p.pct).toBeLessThanOrEqual(100);
  });

  it("returns 0% when total is 0 (indeterminate)", () => {
    const p = new ProgressReporter({ forceTTY: false });
    p.start(0);
    p.tick("step");
    expect(p.pct).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles total of 1", () => {
    const p = new ProgressReporter({ forceTTY: false });
    p.start(1);
    expect(p.pct).toBe(0);
    p.tick("only step");
    expect(p.pct).toBe(100);
    expect(p.stepsCompleted).toBe(1);
    expect(p.stepsTotal).toBe(1);
  });

  it("handles total of 0 (indeterminate)", () => {
    const p = new ProgressReporter({ forceTTY: false });
    p.start(0);
    expect(p.stepsTotal).toBe(0);
    p.tick("a");
    p.tick("b");
    expect(p.stepsCompleted).toBe(2);
    expect(p.pct).toBe(0);
    expect(p.etaMs).toBeNull();
  });

  it("tracks stepsCompleted correctly", () => {
    const p = new ProgressReporter({ forceTTY: false });
    p.start(5);
    expect(p.stepsCompleted).toBe(0);
    p.tick("1");
    expect(p.stepsCompleted).toBe(1);
    p.tick("2");
    expect(p.stepsCompleted).toBe(2);
  });

  it("update() does not advance completed count", () => {
    const p = new ProgressReporter({ forceTTY: false });
    p.start(5);
    p.update("sub-step info");
    expect(p.stepsCompleted).toBe(0);
    p.tick("step 1");
    p.update("more info");
    expect(p.stepsCompleted).toBe(1);
  });

  it("negative total is clamped to 0", () => {
    const p = new ProgressReporter({ forceTTY: false });
    p.start(-3);
    expect(p.stepsTotal).toBe(0);
    expect(p.pct).toBe(0);
  });

  it("fractional total is floored", () => {
    const p = new ProgressReporter({ forceTTY: false });
    p.start(3.9);
    expect(p.stepsTotal).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────
// Non-TTY output (CI mode)
// ─────────────────────────────────────────────────────────────

describe("non-TTY output", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("writes bracketed progress lines to stderr", () => {
    const p = new ProgressReporter({ forceTTY: false });
    p.start(3);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("[0/3]"));

    p.tick("Homepage");
    const call = stderrSpy.mock.calls.find((c) =>
      String(c[0]).includes("Homepage"),
    );
    expect(call).toBeDefined();
    expect(String(call![0])).toMatch(/^\[1\/3\]/);
  });

  it("writes indeterminate prefix when total is 0", () => {
    const p = new ProgressReporter({ forceTTY: false });
    p.start(0);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("[0/?]"));

    p.tick("step");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("[1/?]"));
  });

  it("finish() writes a completion line", () => {
    const p = new ProgressReporter({ forceTTY: false });
    p.start(1);
    p.tick("done");
    const summary: ProgressSummary = { pass: 1, fail: 0, duration_ms: 5000 };
    p.finish(summary);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Audit complete"),
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("1 passed"),
    );
  });

  it("fail() writes a failure line", () => {
    const p = new ProgressReporter({ forceTTY: false });
    p.start(3);
    p.fail("Browser crashed");
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[FAIL] Browser crashed"),
    );
  });

  it("update() does not write to stderr in non-TTY mode", () => {
    const p = new ProgressReporter({ forceTTY: false });
    p.start(3);
    stderrSpy.mockClear();
    p.update("sub-step detail");
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// TTY mode (spinner)
// ─────────────────────────────────────────────────────────────

describe("TTY mode", () => {
  it("creates a spinner when forceTTY is true", () => {
    const p = new ProgressReporter({ forceTTY: true });
    p.start(3);
    // Spinner is internal; verify it does not throw and state is correct
    expect(p.stepsTotal).toBe(3);
    expect(p.pct).toBe(0);
    // Clean up
    p.finish({ pass: 3, fail: 0, duration_ms: 100 });
  });

  it("tick and update do not throw in TTY mode", () => {
    const p = new ProgressReporter({ forceTTY: true });
    p.start(2);
    expect(() => p.tick("step 1")).not.toThrow();
    expect(() => p.update("loading")).not.toThrow();
    expect(() => p.tick("step 2")).not.toThrow();
    p.finish({ pass: 2, fail: 0, duration_ms: 50 });
  });

  it("fail does not throw in TTY mode", () => {
    const p = new ProgressReporter({ forceTTY: true });
    p.start(2);
    expect(() => p.fail("Something broke")).not.toThrow();
  });
});

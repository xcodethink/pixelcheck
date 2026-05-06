import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  canResume,
  type Checkpoint,
} from "../src/core/checkpoint.js";
import type { Scenario, StepResult } from "../src/core/types.js";

// ─── helpers ───────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-test-"));
}

function makeStepResult(id: string, status: "pass" | "fail" = "pass"): StepResult {
  return {
    step_id: id,
    step_type: "visit",
    status,
    duration_ms: 100,
    retries_used: 0,
  };
}

function makeCheckpoint(overrides?: Partial<Checkpoint>): Checkpoint {
  return {
    runId: "run-001",
    scenarioId: "smoke",
    personaId: "us-free",
    completedSteps: 2,
    stepResults: [makeStepResult("step-1"), makeStepResult("step-2")],
    timestamp: "2026-05-06T10:00:00Z",
    status: "in_progress",
    totalSteps: 5,
    stepIds: ["step-1", "step-2", "step-3", "step-4", "step-5"],
    ...overrides,
  };
}

function makeScenario(overrides?: Partial<Scenario>): Scenario {
  return {
    id: "smoke",
    name: "Smoke Test",
    priority: "P0",
    goal: "Verify basic flow",
    applies_to: { personas: ["us-free"] },
    scoring_dimensions: ["completion"],
    mode: "scripted",
    persistent_storage: false,
    steps: [
      { id: "step-1", type: "visit", url: "https://example.com", critical: false, critical_review: false, retry: 2, wait_until: "domcontentloaded" },
      { id: "step-2", type: "act", instruction: "Click login", critical: false, critical_review: false, retry: 2 },
      { id: "step-3", type: "act", instruction: "Enter email", critical: false, critical_review: false, retry: 2 },
      { id: "step-4", type: "act", instruction: "Enter password", critical: false, critical_review: false, retry: 2 },
      { id: "step-5", type: "assert_visual", instruction: "Dashboard visible", dimensions: ["visual_polish"], critical: false, critical_review: false, retry: 2 },
    ],
    ...overrides,
  } as Scenario;
}

// ─── test suite ────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("checkpoint", () => {
  // ─── save / load round-trip ────────────────────────────────

  it("should save and load a checkpoint (round-trip)", () => {
    const cp = makeCheckpoint();
    saveCheckpoint(tmpDir, cp);
    const loaded = loadCheckpoint(tmpDir, cp.runId);
    expect(loaded).toEqual(cp);
  });

  it("should preserve all fields through round-trip", () => {
    const cp = makeCheckpoint({
      completedSteps: 1,
      stepResults: [makeStepResult("step-1", "fail")],
      status: "failed",
    });
    saveCheckpoint(tmpDir, cp);
    const loaded = loadCheckpoint(tmpDir, cp.runId);
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe("failed");
    expect(loaded!.stepResults[0].status).toBe("fail");
    expect(loaded!.completedSteps).toBe(1);
  });

  // ─── load nonexistent ──────────────────────────────────────

  it("should return null when loading a nonexistent checkpoint", () => {
    const result = loadCheckpoint(tmpDir, "no-such-run");
    expect(result).toBeNull();
  });

  it("should return null when output dir does not exist", () => {
    const result = loadCheckpoint("/tmp/nonexistent-dir-xyz", "run-001");
    expect(result).toBeNull();
  });

  // ─── clear ─────────────────────────────────────────────────

  it("should clear an existing checkpoint", () => {
    const cp = makeCheckpoint();
    saveCheckpoint(tmpDir, cp);
    expect(loadCheckpoint(tmpDir, cp.runId)).not.toBeNull();

    clearCheckpoint(tmpDir, cp.runId);
    expect(loadCheckpoint(tmpDir, cp.runId)).toBeNull();
  });

  it("should not throw when clearing a nonexistent checkpoint", () => {
    expect(() => clearCheckpoint(tmpDir, "no-such-run")).not.toThrow();
  });

  it("should also clean up leftover .tmp files on clear", () => {
    const cp = makeCheckpoint();
    const runDir = path.join(tmpDir, cp.runId);
    fs.mkdirSync(runDir, { recursive: true });
    // Write a leftover .tmp file
    fs.writeFileSync(path.join(runDir, "checkpoint.json.tmp"), "junk", "utf-8");

    clearCheckpoint(tmpDir, cp.runId);
    expect(fs.existsSync(path.join(runDir, "checkpoint.json.tmp"))).toBe(false);
  });

  // ─── canResume: matching scenario ──────────────────────────

  it("should return true for a compatible checkpoint", () => {
    const cp = makeCheckpoint();
    const sc = makeScenario();
    expect(canResume(cp, sc)).toBe(true);
  });

  // ─── canResume: mismatched scenario ID ─────────────────────

  it("should return false when scenario ID differs", () => {
    const cp = makeCheckpoint({ scenarioId: "other-scenario" });
    const sc = makeScenario();
    expect(canResume(cp, sc)).toBe(false);
  });

  // ─── canResume: different step count ───────────────────────

  it("should return false when scenario has different step count", () => {
    const cp = makeCheckpoint();
    const sc = makeScenario({
      steps: [
        { id: "step-1", type: "visit", url: "https://example.com", critical: false, critical_review: false, retry: 2, wait_until: "domcontentloaded" },
        { id: "step-2", type: "act", instruction: "Click login", critical: false, critical_review: false, retry: 2 },
      ],
    } as Partial<Scenario>);
    expect(canResume(cp, sc)).toBe(false);
  });

  // ─── canResume: different step IDs ─────────────────────────

  it("should return false when step IDs differ (same count)", () => {
    const cp = makeCheckpoint({
      totalSteps: 3,
      stepIds: ["a", "b", "c"],
    });
    const sc = makeScenario({
      steps: [
        { id: "a", type: "visit", url: "https://example.com", critical: false, critical_review: false, retry: 2, wait_until: "domcontentloaded" },
        { id: "b", type: "act", instruction: "Click", critical: false, critical_review: false, retry: 2 },
        { id: "x", type: "act", instruction: "Type", critical: false, critical_review: false, retry: 2 },
      ],
    } as Partial<Scenario>);
    expect(canResume(cp, sc)).toBe(false);
  });

  // ─── canResume: all steps completed ────────────────────────

  it("should return false when all steps are already completed", () => {
    const cp = makeCheckpoint({ completedSteps: 5 });
    const sc = makeScenario();
    expect(canResume(cp, sc)).toBe(false);
  });

  // ─── canResume: status checks ──────────────────────────────

  it("should return false for completed status", () => {
    const cp = makeCheckpoint({ status: "completed" });
    const sc = makeScenario();
    expect(canResume(cp, sc)).toBe(false);
  });

  it("should return true for failed status (retryable)", () => {
    const cp = makeCheckpoint({ status: "failed" });
    const sc = makeScenario();
    expect(canResume(cp, sc)).toBe(true);
  });

  // ─── canResume: autonomous scenario (no steps) ─────────────

  it("should return false for autonomous scenario (no steps array)", () => {
    const cp = makeCheckpoint();
    const sc = makeScenario();
    // Remove steps to simulate autonomous mode
    (sc as Record<string, unknown>).steps = undefined;
    expect(canResume(cp, sc)).toBe(false);
  });

  // ─── atomic write safety ───────────────────────────────────

  it("should not leave a .tmp file after successful save", () => {
    const cp = makeCheckpoint();
    saveCheckpoint(tmpDir, cp);

    const runDir = path.join(tmpDir, cp.runId);
    const tmpFile = path.join(runDir, "checkpoint.json.tmp");
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it("should create the run directory if it does not exist", () => {
    const cp = makeCheckpoint({ runId: "brand-new-run" });
    saveCheckpoint(tmpDir, cp);

    const runDir = path.join(tmpDir, "brand-new-run");
    expect(fs.existsSync(runDir)).toBe(true);
    expect(fs.existsSync(path.join(runDir, "checkpoint.json"))).toBe(true);
  });

  // ─── checkpoint with partial results ───────────────────────

  it("should handle checkpoint with zero completed steps", () => {
    const cp = makeCheckpoint({
      completedSteps: 0,
      stepResults: [],
    });
    saveCheckpoint(tmpDir, cp);
    const loaded = loadCheckpoint(tmpDir, cp.runId);
    expect(loaded).not.toBeNull();
    expect(loaded!.completedSteps).toBe(0);
    expect(loaded!.stepResults).toEqual([]);
  });

  it("should handle checkpoint with mixed pass/fail step results", () => {
    const cp = makeCheckpoint({
      completedSteps: 3,
      stepResults: [
        makeStepResult("step-1", "pass"),
        makeStepResult("step-2", "fail"),
        makeStepResult("step-3", "pass"),
      ],
    });
    saveCheckpoint(tmpDir, cp);
    const loaded = loadCheckpoint(tmpDir, cp.runId);
    expect(loaded!.stepResults).toHaveLength(3);
    expect(loaded!.stepResults[1].status).toBe("fail");
  });

  // ─── overwrite existing checkpoint ─────────────────────────

  it("should overwrite an existing checkpoint on re-save", () => {
    const cp1 = makeCheckpoint({ completedSteps: 2 });
    saveCheckpoint(tmpDir, cp1);

    const cp2 = makeCheckpoint({
      completedSteps: 4,
      stepResults: [
        makeStepResult("step-1"),
        makeStepResult("step-2"),
        makeStepResult("step-3"),
        makeStepResult("step-4"),
      ],
      timestamp: "2026-05-06T11:00:00Z",
    });
    saveCheckpoint(tmpDir, cp2);

    const loaded = loadCheckpoint(tmpDir, cp2.runId);
    expect(loaded!.completedSteps).toBe(4);
    expect(loaded!.timestamp).toBe("2026-05-06T11:00:00Z");
  });

  // ─── checkpoint with rich step output ──────────────────────

  it("should preserve step output and error fields", () => {
    const result: StepResult = {
      step_id: "extract-1",
      step_type: "extract",
      status: "pass",
      duration_ms: 500,
      retries_used: 1,
      output: { price: "$9.99", currency: "USD" },
      error: undefined,
      execution_method: "stagehand",
    };
    const cp = makeCheckpoint({
      completedSteps: 1,
      stepResults: [result],
    });
    saveCheckpoint(tmpDir, cp);
    const loaded = loadCheckpoint(tmpDir, cp.runId);
    expect(loaded!.stepResults[0].output).toEqual({ price: "$9.99", currency: "USD" });
    expect(loaded!.stepResults[0].execution_method).toBe("stagehand");
  });
});

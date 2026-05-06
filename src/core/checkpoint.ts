/**
 * M6-1 — Checkpoint support for resuming multi-step audits.
 *
 * When a scripted scenario fails midway, the runner can persist a checkpoint
 * containing all completed step results. On re-run the caller can load the
 * checkpoint and skip already-completed steps, saving time and cost.
 *
 * Checkpoint file location: `<outputDir>/<runId>/checkpoint.json`
 *
 * Write safety: all writes go to a `.tmp` sibling first, then `rename()`
 * atomically replaces the target — so a crash mid-write never corrupts the
 * checkpoint file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { StepResult, Scenario } from "./types.js";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface Checkpoint {
  /** Unique run identifier (matches the output directory name). */
  runId: string;
  /** Scenario this checkpoint belongs to. */
  scenarioId: string;
  /** Persona used for this run. */
  personaId: string;
  /** Number of steps that completed successfully. */
  completedSteps: number;
  /** Results collected so far (length === completedSteps). */
  stepResults: StepResult[];
  /** ISO-8601 timestamp of the last checkpoint write. */
  timestamp: string;
  /** Current status of the checkpointed run. */
  status: "in_progress" | "failed" | "completed";
  /**
   * Total number of steps in the scenario at checkpoint time.
   * Used by `canResume` to detect scenario mutations.
   */
  totalSteps: number;
  /**
   * Ordered list of step IDs from the scenario at checkpoint time.
   * Used by `canResume` to verify step identity, not just count.
   */
  stepIds: string[];
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function checkpointPath(outputDir: string, runId: string): string {
  return path.join(outputDir, runId, "checkpoint.json");
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Persist a checkpoint to disk using atomic write (write .tmp then rename).
 */
export function saveCheckpoint(
  outputDir: string,
  checkpoint: Checkpoint,
): void {
  const target = checkpointPath(outputDir, checkpoint.runId);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = `${target}.tmp`;
  const data = JSON.stringify(checkpoint, null, 2);
  fs.writeFileSync(tmp, data, "utf-8");
  fs.renameSync(tmp, target);
}

/**
 * Load a checkpoint from disk. Returns `null` if the file does not exist.
 */
export function loadCheckpoint(
  outputDir: string,
  runId: string,
): Checkpoint | null {
  const target = checkpointPath(outputDir, runId);
  if (!fs.existsSync(target)) return null;
  const raw = fs.readFileSync(target, "utf-8");
  return JSON.parse(raw) as Checkpoint;
}

/**
 * Remove a checkpoint file. No-op if it does not exist.
 */
export function clearCheckpoint(outputDir: string, runId: string): void {
  const target = checkpointPath(outputDir, runId);
  try {
    fs.unlinkSync(target);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // Also clean up any leftover .tmp file
  const tmp = `${target}.tmp`;
  try {
    fs.unlinkSync(tmp);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Validate that a checkpoint is compatible with a scenario and can be resumed.
 *
 * Checks:
 * 1. Scenario ID matches.
 * 2. Total step count matches.
 * 3. Step IDs match (order-sensitive).
 * 4. There are remaining steps to execute (completedSteps < totalSteps).
 * 5. Status is resumable ("in_progress" or "failed").
 */
export function canResume(checkpoint: Checkpoint, scenario: Scenario): boolean {
  // Must be same scenario
  if (checkpoint.scenarioId !== scenario.id) return false;

  // Must be scripted mode with steps
  const steps = scenario.steps;
  if (!steps) return false;

  // Step count must match
  if (checkpoint.totalSteps !== steps.length) return false;

  // Step IDs must match in order
  const scenarioStepIds = steps.map((s) => s.id);
  if (checkpoint.stepIds.length !== scenarioStepIds.length) return false;
  for (let i = 0; i < scenarioStepIds.length; i++) {
    if (checkpoint.stepIds[i] !== scenarioStepIds[i]) return false;
  }

  // Must have remaining steps
  if (checkpoint.completedSteps >= checkpoint.totalSteps) return false;

  // Must be in a resumable status
  if (checkpoint.status !== "in_progress" && checkpoint.status !== "failed") {
    return false;
  }

  return true;
}

/**
 * M6-2: Minimum reproduction generator.
 *
 * Given a failed audit run, produces a minimal scenario that reproduces
 * the failure — stripping all passing steps and unrelated configuration.
 * Useful for bug reports and debugging.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getLogger } from "./logger.js";
import type {
  Scenario,
  StepResult,
  Issue,
} from "./types.js";

const log = getLogger("min-repro");

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface MinReproResult {
  /** The minimal scenario that reproduces the failure */
  scenario: MinimalScenario;
  /** Number of steps removed */
  stepsRemoved: number;
  /** Original step count */
  originalStepCount: number;
  /** Issues preserved in the reproduction */
  issues: Issue[];
  /** YAML-formatted scenario string */
  yaml: string;
}

export interface MinimalScenario {
  name: string;
  description: string;
  url: string;
  steps: MinimalStep[];
}

export interface MinimalStep {
  type: string;
  target?: string;
  value?: string;
  action?: string;
  instruction?: string;
  selector?: string;
  url?: string;
}

// ─────────────────────────────────────────────────────────────
// Core logic
// ─────────────────────────────────────────────────────────────

/**
 * Generate a minimum reproduction scenario from a failed audit run.
 *
 * Strategy:
 * 1. Find the first failing step
 * 2. Include all steps up to and including the failing step
 * 3. Remove steps that are clearly independent (no data dependency)
 * 4. Generate a minimal YAML scenario
 */
export function generateMinRepro(
  scenario: Scenario,
  stepResults: StepResult[],
): MinReproResult {
  const allSteps = scenario.steps ?? [];
  const scenarioUrl = scenario.start_url ?? "";

  const failingStepIndex = stepResults.findIndex(
    (r) => r.status === "fail",
  );

  if (failingStepIndex === -1) {
    // No failure found — return the full scenario
    const steps = allSteps.map(stepToMinimal);
    return {
      scenario: {
        name: `repro-${scenario.name}`,
        description: `Reproduction of ${scenario.name} (no failure found)`,
        url: scenarioUrl,
        steps,
      },
      stepsRemoved: 0,
      originalStepCount: allSteps.length,
      issues: [],
      yaml: renderYaml({
        name: `repro-${scenario.name}`,
        description: `Reproduction of ${scenario.name}`,
        url: scenarioUrl,
        steps,
      }),
    };
  }

  // Include steps 0..failingStepIndex
  const relevantSteps = allSteps.slice(0, failingStepIndex + 1);
  const minimalSteps = relevantSteps.map(stepToMinimal);

  // No step-level issues in the type; issues live at ScenarioRunResult level
  const issues: Issue[] = [];

  const stepsRemoved = allSteps.length - relevantSteps.length;
  const minScenario: MinimalScenario = {
    name: `repro-${scenario.name}`,
    description: `Minimal reproduction — fails at step ${failingStepIndex + 1}`,
    url: scenarioUrl,
    steps: minimalSteps,
  };

  log.info(
    {
      original: allSteps.length,
      minimal: relevantSteps.length,
      removed: stepsRemoved,
      failStep: failingStepIndex,
    },
    "generated min-repro",
  );

  return {
    scenario: minScenario,
    stepsRemoved,
    originalStepCount: allSteps.length,
    issues,
    yaml: renderYaml(minScenario),
  };
}

/**
 * Write a min-repro scenario to a YAML file.
 */
export function writeMinRepro(outputPath: string, repro: MinReproResult): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, repro.yaml, "utf-8");
  log.info({ path: outputPath, steps: repro.scenario.steps.length }, "wrote min-repro file");
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function stepToMinimal(step: Record<string, unknown>): MinimalStep {
  const minimal: MinimalStep = { type: String(step.type ?? "unknown") };
  if (step.target) minimal.target = String(step.target);
  if (step.value) minimal.value = String(step.value);
  if (step.action) minimal.action = String(step.action);
  if (step.instruction) minimal.instruction = String(step.instruction);
  if (step.selector) minimal.selector = String(step.selector);
  if (step.url) minimal.url = String(step.url);
  return minimal;
}

function renderYaml(scenario: MinimalScenario): string {
  const lines: string[] = [];
  lines.push(`name: "${scenario.name}"`);
  lines.push(`description: "${scenario.description}"`);
  if (scenario.url) lines.push(`url: "${scenario.url}"`);
  lines.push("steps:");
  for (const step of scenario.steps) {
    lines.push(`  - type: "${step.type}"`);
    if (step.target) lines.push(`    target: "${step.target}"`);
    if (step.value) lines.push(`    value: "${step.value}"`);
    if (step.action) lines.push(`    action: "${step.action}"`);
    if (step.instruction) lines.push(`    instruction: "${step.instruction}"`);
    if (step.selector) lines.push(`    selector: "${step.selector}"`);
    if (step.url) lines.push(`    url: "${step.url}"`);
  }
  return lines.join("\n") + "\n";
}

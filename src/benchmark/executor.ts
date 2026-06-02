/**
 * Benchmark executor — bridges BenchmarkTask → Scenario → runAudit().
 *
 * Each task becomes a single autonomous scenario with one success criterion
 * ("complete the intent"). The agent loop + 5-layer stack do the work; we
 * capture the ending state and hand it to the evaluator for pass/fail judgment.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { BenchmarkTask } from "./task.js";
import type { TaskExecution } from "./runner.js";
import type { Persona, ProjectConfig, Scenario } from "../core/types.js";
import { ScenarioSchema } from "../core/types.js";
import { createStagehandWrapper } from "../core/stagehand-wrapper.js";
import { Recorder } from "../core/recorder.js";
import { AgentEventBus } from "../agent/events.js";
import { runAutonomousLoop } from "../agent/agent-loop.js";
import { resolvePersonaSecrets } from "../core/persona.js";
import { getStripeSecrets } from "../core/secrets.js";

/**
 * The default executor invoked by the `benchmark` CLI command. Exported
 * separately from the CLI so tests can inject a replacement.
 */
export async function executeBenchmarkTask(
  task: BenchmarkTask,
  config: ProjectConfig,
  persona: Persona,
): Promise<TaskExecution> {
  const start = Date.now();
  const scenario = taskToScenario(task);

  const tmpOut = fs.mkdtempSync(path.join(process.cwd(), ".benchmark-tmp-"));
  const resolvedPersona = resolvePersonaSecrets(persona);
  const eventBus = new AgentEventBus(`bench_${task.task_id}`);
  const stripeSecrets = getStripeSecrets();
  const cost = { value: 0 };
  let convergenceReason: string;
  let finalAnswer: string | undefined;
  let wrapper: Awaited<ReturnType<typeof createStagehandWrapper>> | undefined;

  try {
    wrapper = await createStagehandWrapper({
      persona: resolvedPersona,
      artifactsDir: tmpOut,
      headless: true,
    });
    const recorder = new Recorder(wrapper.page, tmpOut);

    const result = await runAutonomousLoop({
      config,
      persona: resolvedPersona,
      scenario,
      page: wrapper.page,
      stagehand: wrapper.stagehand,
      recorder,
      eventBus,
      cost,
      stripeSecrets,
    });
    convergenceReason = result.agent_summary.convergence_reason;

    // Use the last extract step's output as the free-form "answer"
    for (const s of [...result.stepResults].reverse()) {
      if (s.step_type === "extract" && s.output != null) {
        finalAnswer =
          typeof s.output === "string" ? s.output : JSON.stringify(s.output);
        break;
      }
    }

    const page = wrapper.page;
    const wrapperRef = wrapper;
    return {
      final_url: page.url(),
      answer: finalAnswer,
      getPage: async () => page,
      cleanup: async () => {
        await wrapperRef.close().catch(() => {});
        fs.rmSync(tmpOut, { recursive: true, force: true });
      },
      cost_usd: cost.value,
      duration_ms: Date.now() - start,
      convergence_reason: convergenceReason,
    };
  } catch (err) {
    if (wrapper) await wrapper.close().catch(() => {});
    fs.rmSync(tmpOut, { recursive: true, force: true });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// BenchmarkTask → Scenario
// ─────────────────────────────────────────────────────────────

/**
 * Convert a task spec into a valid autonomous Scenario.
 * Exported for unit tests.
 */
export function taskToScenario(task: BenchmarkTask): Scenario {
  const criterion = deriveCriterion(task);
  const rawScenario = {
    id: `bench_${task.task_id}`,
    name: `Benchmark: ${task.intent.slice(0, 60)}`,
    priority: "P1" as const,
    goal: task.intent,
    applies_to: { personas: task.persona_id ? [task.persona_id] : ["*"] },
    scoring_dimensions: ["completion"],
    mode: "autonomous" as const,
    start_url: task.start_url,
    success_criteria: [criterion],
    agent_config: {
      max_actions: task.max_actions ?? 30,
    },
  };
  const parsed = ScenarioSchema.safeParse(rawScenario);
  if (!parsed.success) {
    throw new Error(
      `task-to-scenario conversion failed: ${parsed.error.errors
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/**
 * Derive a primary success criterion from the task's eval spec.
 * We keep this simple — the real pass/fail judgment happens in evaluateTask()
 * after the run; the criterion only guides the agent to a stopping point.
 */
function deriveCriterion(task: BenchmarkTask): {
  id: string;
  description: string;
  verification: "visual" | "dom" | "extract" | "network" | "interaction";
  expected?: Record<string, unknown>;
  extract_instruction?: string;
  expected_pattern?: string;
} {
  if (task.eval.eval_types.includes("url_match") && task.eval.reference_url) {
    const ref = task.eval.reference_url;
    return {
      id: "reached_target_url",
      description: `Agent should navigate to a URL matching "${ref}"`,
      verification: "interaction",
      expected: { url_must_change: true },
    };
  }
  if (task.eval.eval_types.includes("string_match") && task.eval.reference_answers?.must_include) {
    return {
      id: "answer_contains",
      description: `Extract page info satisfying: ${task.intent}`,
      verification: "extract",
      extract_instruction: task.intent,
      expected_pattern: task.eval.reference_answers.must_include.join("|"),
    };
  }
  return {
    id: "intent_achieved",
    description: task.intent,
    verification: "visual",
  };
}

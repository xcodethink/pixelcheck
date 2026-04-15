/**
 * Agent Loop — Core Observe-Think-Act loop for autonomous browser exploration.
 *
 * Orchestrates Planner + Navigator + Convergence detection + Criteria checking.
 * Emits events to AgentEventBus for live observation.
 *
 * Reuses existing StepContext and executeStep handlers — autonomous mode
 * gets the full 5-layer reliability stack for free.
 */

import type { Page } from "playwright";
import type {
  Scenario,
  Persona,
  ProjectConfig,
  StepResult,
  ScenarioRunResult,
  Issue,
  DimensionScore,
  AgentConfig,
} from "../core/types.js";
import { executeStep, type StepContext } from "../handlers/index.js";
import { runCritic, type CriticResult } from "../core/critic.js";
import { Recorder } from "../core/recorder.js";
import { waitForPageStable } from "../core/page-stability.js";
import { extractDomSummary, formatDomSummary } from "./dom-summary.js";
import { createPlan, revisePlan, type Plan, type PlannedStep } from "./planner.js";
import { navigatorDecide, buildStepFromDecision } from "./navigator.js";
import {
  ConvergenceTracker,
  initCriteriaState,
  allCriteriaMet,
  checkDomCriterion,
  checkExtractCriterion,
  checkVisualCriterion,
  getDomFingerprint,
  type CriteriaState,
} from "./convergence.js";
import { AgentEventBus } from "./events.js";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface AutonomousRunOpts {
  config: ProjectConfig;
  persona: Persona;
  scenario: Scenario;
  page: Page;
  stagehand: StepContext["stagehand"];
  recorder: Recorder;
  eventBus: AgentEventBus;
  cost: { value: number };
  stripeSecrets: Record<string, string>;
  baselineDir?: string;
}

export interface AutonomousRunResult {
  stepResults: StepResult[];
  criticResults: CriticResult[];
  issues: Issue[];
  agent_summary: NonNullable<ScenarioRunResult["agent_summary"]>;
}

// ─────────────────────────────────────────────────────────────
// Agent Loop Implementation
// ─────────────────────────────────────────────────────────────

export async function runAutonomousLoop(
  opts: AutonomousRunOpts,
): Promise<AutonomousRunResult> {
  const { scenario, persona, page, eventBus, cost } = opts;

  // Resolve agent config (scenario overrides > project defaults > hardcoded defaults)
  const agentConfig = resolveAgentConfig(scenario.agent_config, opts.config.agent);
  const models = {
    planner: opts.config.models.planner ?? "claude-opus-4-6",
    navigator: opts.config.models.navigator ?? "claude-sonnet-4-6",
    replan: opts.config.models.replan ?? "claude-sonnet-4-6",
    critic: opts.config.models.critic,
  };
  const budgetCap = opts.config.budget_usd;
  const criteriaCheckInterval = Math.max(1, opts.config.agent?.criteria_check_interval ?? 3);

  const stepResults: StepResult[] = [];
  const criticResults: CriticResult[] = [];
  const issues: Issue[] = [];
  const failedPlans: Plan[] = [];
  const actionHistory: Array<{ instruction: string; result: string; success: boolean }> = [];

  // Initialize criteria tracking
  const criteriaState = initCriteriaState(scenario.success_criteria ?? []);

  // Initialize convergence tracker
  const convergence = new ConvergenceTracker(
    agentConfig.replan_threshold,
    3, // loop threshold
  );

  let convergenceReason: AutonomousRunResult["agent_summary"]["convergence_reason"] = "error";

  // Build StepContext for reusing existing handlers
  const ctx: StepContext = {
    page,
    stagehand: opts.stagehand,
    recorder: opts.recorder,
    persona,
    scenario,
    models: {
      default: opts.config.models.default,
      critic: opts.config.models.critic,
      computerUse: opts.config.models.computer_use,
    },
    store: {},
    criticResults,
    cost,
    stripeSecrets: opts.stripeSecrets,
    baselineDir: opts.baselineDir,
    diffResults: [],
  };

  try {
    // ── Step 1: Navigate to start URL ────────────────────────────
    const startUrl = scenario.start_url!;
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitForPageStable(page, { timeout: 6000 });

    // ── Step 2: Initial observation ──────────────────────────────
    const screenshot = await takeScreenshotBase64(page);
    const domSummary = await extractDomSummary(page);

    // ── Step 3: Create initial plan ──────────────────────────────
    const planResult = await createPlan(
      {
        goal: scenario.goal,
        success_criteria: scenario.success_criteria ?? [],
        hints: scenario.hints ?? [],
        persona,
        current_url: page.url(),
        current_screenshot_base64: screenshot,
        dom_summary: formatDomSummary(domSummary),
        history: [],
        failed_plans: [],
        remaining_budget_usd: budgetCap - cost.value,
      },
      models.planner,
      cost,
    );

    let plan = planResult.plan;
    eventBus.emitEvent("plan:created", {
      plan_id: plan.id,
      steps: plan.steps,
      reasoning: plan.reasoning,
    });

    let stepIndex = 0;

    // ── Step 4: Main loop ────────────────────────────────────────
    while (!allCriteriaMet(criteriaState)) {
      // Check pause/takeover
      await eventBus.checkpoint();

      // Check limits
      const limitSignal = convergence.checkLimits(
        cost.value,
        budgetCap,
        agentConfig.max_actions,
      );
      if (limitSignal.type !== "continue") {
        eventBus.emitEvent(
          limitSignal.type === "budget_exceeded"
            ? "convergence:budget_exceeded"
            : "convergence:stuck",
          limitSignal as unknown as Record<string, unknown>,
        );
        convergenceReason = limitSignal.type === "budget_exceeded" ? "budget_exceeded" : "max_actions";
        break;
      }

      // Plan exhausted — need replan
      if (stepIndex >= plan.steps.length) {
        if (failedPlans.length >= agentConfig.max_replans) {
          eventBus.emitEvent("convergence:stuck", { reason: "max_replans_exceeded" });
          convergenceReason = "max_replans";
          break;
        }

        const replanResult = await doReplan(
          opts, plan, failedPlans, actionHistory, criteriaState, models.replan, cost,
        );
        failedPlans.push(plan);
        plan = replanResult.plan;
        stepIndex = 0;
        convergence.resetFailures();
        eventBus.emitEvent("plan:revised", {
          plan_id: plan.id,
          steps: plan.steps,
          reasoning: plan.reasoning,
        });
        continue;
      }

      const plannedStep = plan.steps[stepIndex];
      if (!plannedStep) break; // Safety guard — should not happen after bounds check

      // ── THINK: Navigator decides concrete action ───────────────
      const currentScreenshot = await takeScreenshotBase64(page);
      const currentDom = await extractDomSummary(page);

      const decision = await navigatorDecide(
        {
          planned_step: plannedStep,
          persona,
          current_screenshot_base64: currentScreenshot,
          dom_summary: formatDomSummary(currentDom),
          page_url: page.url(),
          hints: scenario.hints ?? [],
        },
        models.navigator,
        cost,
      );

      eventBus.emitEvent("thought:decision", {
        instruction: decision.instruction,
        action_type: decision.action_type,
        reasoning: decision.reasoning,
        confidence: decision.confidence,
        needs_replan: decision.needs_replan,
      });

      // Navigator says replan needed
      if (decision.needs_replan) {
        actionHistory.push({
          instruction: plannedStep.instruction,
          result: "Navigator requested replan",
          success: false,
        });

        const domFp = await getDomFingerprint(page);
        const signal = convergence.recordAction({
          url: page.url(),
          instruction: plannedStep.instruction,
          dom_fingerprint: domFp,
          success: false,
        });

        if (signal.type === "stuck" || signal.type === "loop_detected") {
          if (failedPlans.length >= agentConfig.max_replans) {
            convergenceReason = "max_replans";
            break;
          }
          const replanResult = await doReplan(
            opts, plan, failedPlans, actionHistory, criteriaState, models.replan, cost,
          );
          failedPlans.push(plan);
          plan = replanResult.plan;
          stepIndex = 0;
          convergence.resetFailures();
          eventBus.emitEvent("plan:revised", {
            plan_id: plan.id,
            steps: plan.steps,
            reasoning: plan.reasoning,
          });
        }
        continue;
      }

      // ── ACT: Execute via existing handlers ─────────────────────
      const step = buildStepFromDecision(decision, convergence.totalActions);

      eventBus.emitEvent("action:start", {
        action_id: step.id,
        plan_step_index: stepIndex,
        action_type: decision.action_type,
        instruction: decision.instruction,
      });

      const result = await executeStep(step, ctx);
      stepResults.push(result);

      const domFp = await getDomFingerprint(page);
      const success = result.status === "pass" || result.status === "warn";

      actionHistory.push({
        instruction: decision.instruction,
        result: success ? "success" : (result.error ?? "failed"),
        success,
      });

      const signal = convergence.recordAction({
        url: page.url(),
        instruction: decision.instruction,
        dom_fingerprint: domFp,
        success,
      });

      if (success) {
        stepIndex++;
        eventBus.emitEvent("action:complete", {
          action_id: step.id,
          status: result.status,
          duration_ms: result.duration_ms,
          execution_method: result.execution_method,
        });
      } else {
        eventBus.emitEvent("action:failed", {
          action_id: step.id,
          error: result.error,
          duration_ms: result.duration_ms,
        });
      }

      // Handle convergence signals
      if (signal.type === "loop_detected") {
        eventBus.emitEvent("convergence:loop_detected", { hash: (signal as { repeated_hash: string }).repeated_hash });
        if (failedPlans.length >= agentConfig.max_replans) {
          convergenceReason = "max_replans";
          break;
        }
        const replanResult = await doReplan(
          opts, plan, failedPlans, actionHistory, criteriaState, models.replan, cost,
        );
        failedPlans.push(plan);
        plan = replanResult.plan;
        stepIndex = 0;
        convergence.resetFailures();
        eventBus.emitEvent("plan:revised", {
          plan_id: plan.id,
          steps: plan.steps,
          reasoning: plan.reasoning,
        });
        continue;
      }

      if (signal.type === "stuck") {
        if (failedPlans.length >= agentConfig.max_replans) {
          convergenceReason = "max_replans";
          break;
        }
        const replanResult = await doReplan(
          opts, plan, failedPlans, actionHistory, criteriaState, models.replan, cost,
        );
        failedPlans.push(plan);
        plan = replanResult.plan;
        stepIndex = 0;
        convergence.resetFailures();
        eventBus.emitEvent("plan:revised", {
          plan_id: plan.id,
          steps: plan.steps,
          reasoning: plan.reasoning,
        });
        continue;
      }

      // ── OBSERVE: Check success criteria ────────────────────────
      await checkCriteria(
        criteriaState,
        page,
        convergence.totalActions,
        criteriaCheckInterval,
        models.critic,
        cost,
        eventBus,
      );

      if (allCriteriaMet(criteriaState)) {
        eventBus.emitEvent("convergence:goal_met", {
          criteria_met: Array.from(criteriaState.met),
        });
        convergenceReason = "goal_met";
        break;
      }
    }

    // Final check in case criteria were met on last action
    if (allCriteriaMet(criteriaState)) {
      convergenceReason = "goal_met";
    }

    // ── Final critic scoring ───────────────────────────────────
    try {
      const finalScreenshot = await opts.recorder.screenshotSegments("final");
      const imageBuffers = [finalScreenshot.thumbnail, ...finalScreenshot.segments];
      const criticResult = await runCritic({
        model: models.critic,
        persona,
        scenario,
        instruction: `Final state evaluation: ${scenario.goal}`,
        imageBuffers,
        stepId: "final-critic",
      });
      criticResults.push(criticResult);
      cost.value += criticResult.costUsd;
      issues.push(...criticResult.issues);
    } catch {
      // Non-fatal — critic failure doesn't invalidate the run
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : undefined;
    if (process.env.AUDIT_DEBUG) {
      console.error(`[AGENT-LOOP] ${errStack ?? errMsg}`);
    }
    issues.push({
      severity: "critical",
      description: `Autonomous loop crashed: ${errMsg}`,
      recommendation: "Check logs. This may indicate a page crash, network issue, or API quota exceeded.",
    });
  }

  return {
    stepResults,
    criticResults,
    issues,
    agent_summary: {
      mode: "autonomous",
      plan_count: failedPlans.length + 1,
      total_actions: convergence.totalActions,
      criteria_met: Array.from(criteriaState.met),
      criteria_missed: Array.from(criteriaState.pending),
      convergence_reason: convergenceReason,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function resolveAgentConfig(
  scenarioConfig?: AgentConfig,
  projectConfig?: ProjectConfig["agent"],
): Required<Pick<AgentConfig, "max_actions" | "replan_threshold" | "max_replans">> {
  return {
    max_actions: scenarioConfig?.max_actions ?? projectConfig?.default_max_actions ?? 30,
    replan_threshold: scenarioConfig?.replan_threshold ?? projectConfig?.default_replan_threshold ?? 3,
    max_replans: scenarioConfig?.max_replans ?? projectConfig?.default_max_replans ?? 3,
  };
}

async function takeScreenshotBase64(page: Page): Promise<string> {
  try {
    const buffer = await page.screenshot({ type: "jpeg", quality: 60 });
    return buffer.toString("base64");
  } catch {
    return "";
  }
}

async function doReplan(
  opts: AutonomousRunOpts,
  currentPlan: Plan,
  failedPlans: Plan[],
  actionHistory: Array<{ instruction: string; result: string; success: boolean }>,
  criteriaState: CriteriaState,
  model: string,
  cost: { value: number },
) {
  const screenshot = await takeScreenshotBase64(opts.page);
  const domSummary = await extractDomSummary(opts.page);

  return revisePlan(
    {
      goal: opts.scenario.goal,
      success_criteria: opts.scenario.success_criteria ?? [],
      hints: opts.scenario.hints ?? [],
      persona: opts.persona,
      current_url: opts.page.url(),
      current_screenshot_base64: screenshot,
      dom_summary: formatDomSummary(domSummary),
      history: actionHistory,
      failed_plans: [...failedPlans, currentPlan],
      remaining_budget_usd: opts.config.budget_usd - cost.value,
    },
    model,
    cost,
  );
}

async function checkCriteria(
  state: CriteriaState,
  page: Page,
  totalActions: number,
  visualInterval: number,
  criticModel: string,
  cost: { value: number },
  eventBus: AgentEventBus,
): Promise<void> {
  for (const criterion of state.criteria) {
    if (state.met.has(criterion.id)) continue;

    let met = false;

    switch (criterion.verification) {
      case "dom":
        met = await checkDomCriterion(criterion, page);
        break;
      case "extract":
        met = await checkExtractCriterion(criterion, page);
        break;
      case "visual":
        // Only check visual criteria every N actions to reduce cost
        if (totalActions % visualInterval !== 0) continue;
        try {
          const screenshot = await takeScreenshotBase64(page);
          met = await checkVisualCriterion(criterion, screenshot, criticModel, cost);
        } catch {
          continue;
        }
        break;
    }

    eventBus.emitEvent("criterion:checked", {
      id: criterion.id,
      description: criterion.description,
      verification: criterion.verification,
      met,
    });

    if (met) {
      state.met.add(criterion.id);
      state.pending.delete(criterion.id);
      eventBus.emitEvent("criterion:met", {
        id: criterion.id,
        description: criterion.description,
      });
    }
  }
}

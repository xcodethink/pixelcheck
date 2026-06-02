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
  AgentConfig,
} from "../core/types.js";
import { executeStep, type StepContext } from "../handlers/index.js";
import { runCritic, type CriticResult } from "../core/critic.js";
import { Recorder } from "../core/recorder.js";
import { waitForPageStable } from "../core/page-stability.js";
import { extractDomSummary, formatDomSummary } from "./dom-summary.js";
import {
  createPlan,
  revisePlan,
  microReplan,
  type Plan,
} from "./planner.js";
import { PlanCache, computeDomSkeleton } from "./plan-cache.js";
import { AgentMemory, formatFactsForPlanner } from "./memory.js";
import {
  navigatorDecide,
  economicNavigatorDecide,
  buildStepFromDecision,
} from "./navigator.js";
import {
  ConvergenceTracker,
  initCriteriaState,
  allCriteriaMet,
  checkDomCriterion,
  checkExtractCriterion,
  checkVisualCriterion,
  checkNetworkCriterion,
  checkPerformanceCriterion,
  checkErrorCriterion,
  checkInteractionCriterion,
  getDomFingerprint,
  type CriteriaState,
} from "./convergence.js";
import { AgentEventBus } from "./events.js";
import { NetworkSignalCollector } from "./signals/network.js";
import { PerformanceSignalCollector } from "./signals/performance.js";
import { ErrorSignalCollector } from "./signals/errors.js";
import { takeSnapshot, type PageSnapshot } from "./signals/interaction.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("agent.loop");

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

  // ── Signal collectors: attach BEFORE navigation so LCP/init scripts fire correctly ──
  const networkCollector = new NetworkSignalCollector(page);
  const errorCollector = new ErrorSignalCollector(page);
  const performanceCollector = new PerformanceSignalCollector(page);
  networkCollector.start();
  errorCollector.start();
  await performanceCollector.attach();

  // Most recent pre-action page snapshot for interaction-criterion checks.
  let preActionSnapshot: PageSnapshot | null;

  // Plan cache state (may remain null if disabled) — hoisted so `finally` can record outcome.
  const cacheDisabledOuter = process.env.AUDIT_PLAN_CACHE_DISABLED === "1";
  const planCache: PlanCache | null = cacheDisabledOuter ? null : new PlanCache();
  let activeCacheKey: string | undefined;

  // Agent memory — loaded facts feed into planner prompt; successful runs
  // can add new facts in the future. Today we primarily consume.
  const memoryDisabled = process.env.AUDIT_MEMORY_DISABLED === "1";
  const memory: AgentMemory | null = memoryDisabled ? null : new AgentMemory();
  const memoryHost = AgentMemory.hostOf(scenario.start_url ?? opts.config.base_url);
  const memoryPersonaClass = AgentMemory.personaClass(
    persona.country,
    persona.device_class,
    persona.payment_tier,
  );

  // Micro-replan counter — resets after each full replan. Cap prevents a stuck
  // failing step from chaining cheap replans forever.
  const MAX_MICRO_REPLAN_ATTEMPTS = 2;
  let microReplanAttempts = 0;

  try {
    // ── Step 1: Navigate to start URL ────────────────────────────
    const startUrl = scenario.start_url!;
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitForPageStable(page, { timeout: 6000 });
    preActionSnapshot = await takeSnapshot(page);

    // ── Step 2: Initial observation ──────────────────────────────
    const screenshot = await takeScreenshotBase64(page);
    const domSummary = await extractDomSummary(page);
    const domSummaryText = formatDomSummary(domSummary);

    // ── Plan cache lookup (skip planner on hit) ──────────────────
    const cacheKeyInput = {
      scenario_id: scenario.id,
      persona,
      start_url: startUrl,
      dom_skeleton: computeDomSkeleton(domSummaryText),
    };

    let plan: Plan;
    const cachedHit = planCache?.lookup(cacheKeyInput);
    if (cachedHit) {
      plan = cachedHit.plan;
      activeCacheKey = cachedHit.key;
      eventBus.emitEvent("plan:created", {
        plan_id: plan.id,
        steps: plan.steps,
        reasoning: plan.reasoning,
        from_cache: true,
        cache_success_count: cachedHit.success_count,
        cache_failure_count: cachedHit.failure_count,
      });
    } else {
      // ── Step 3: Create initial plan (cache miss) ───────────────
      // Enrich scenario hints with learned facts from memory for this (host, persona class)
      const memFacts = memory
        ? memory.lookup({ host: memoryHost, persona_class: memoryPersonaClass, limit: 10, min_confidence: 0.3 })
        : [];
      const memHints = memFacts.map((f) => ({
        condition: "applies to this site",
        suggestion: f.fact,
      }));
      const combinedHints = [...(scenario.hints ?? []), ...memHints];
      if (memFacts.length > 0) {
        eventBus.emitEvent("thought:reasoning", {
          source: "memory",
          count: memFacts.length,
          preview: formatFactsForPlanner(memFacts).slice(0, 400),
        });
      }

      const planResult = await createPlan(
        {
          goal: scenario.goal,
          success_criteria: scenario.success_criteria ?? [],
          hints: combinedHints,
          persona,
          current_url: page.url(),
          current_screenshot_base64: screenshot,
          dom_summary: domSummaryText,
          history: [],
          failed_plans: [],
          remaining_budget_usd: budgetCap - cost.value,
        },
        models.planner,
        cost,
      );
      plan = planResult.plan;
      // Persist for future runs — outcome is recorded at loop end
      if (planCache) {
        planCache.store(cacheKeyInput, plan);
        activeCacheKey = PlanCache.makeKey(cacheKeyInput);
      }
      eventBus.emitEvent("plan:created", {
        plan_id: plan.id,
        steps: plan.steps,
        reasoning: plan.reasoning,
        from_cache: false,
      });
    }

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

      const decision = await runNavigator(
        {
          planned_step: plannedStep,
          persona,
          current_screenshot_base64: currentScreenshot,
          dom_summary: formatDomSummary(currentDom),
          page_url: page.url(),
          hints: scenario.hints ?? [],
        },
        opts.config,
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

        if (signal.type === "no_progress") {
          // Terminal: page never advanced — replanning won't help, stop. (D2-C1)
          convergenceReason = "no_progress";
          break;
        }
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
      // Snapshot BEFORE the action for interaction-criterion baseline.
      preActionSnapshot = await takeSnapshot(page);
      const step = buildStepFromDecision(decision, convergence.totalActions);

      eventBus.emitEvent("action:start", {
        action_id: step.id,
        plan_step_index: stepIndex,
        action_type: decision.action_type,
        instruction: decision.instruction,
      });

      const result = await executeStep(step, ctx);
      // Snapshot signals captured during this action and reset per-action collectors.
      const postSnapshot = await takeSnapshot(page);
      const interactionSignal =
        preActionSnapshot && postSnapshot
          ? { before: preActionSnapshot, after: postSnapshot }
          : undefined;
      result.signals = {
        network: networkCollector.snapshot(),
        errors: errorCollector.snapshot(),
        performance: await performanceCollector.snapshot(),
        interaction: interactionSignal,
      };
      networkCollector.reset();
      errorCollector.reset();
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
      if (signal.type === "no_progress") {
        // Terminal: the page has not advanced for N consecutive actions — the
        // agent is stuck (e.g. a login wall that never navigates). Stop rather
        // than burn the full action/budget cap making no progress. (D2-C1)
        eventBus.emitEvent("convergence:no_progress", {
          actions: (signal as { actions: number }).actions,
        });
        convergenceReason = "no_progress";
        break;
      }
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
        // Try a cheap micro-replan FIRST — rewrite just the failing step via
        // Haiku. Only escalate to a full Sonnet replan if the micro-replan
        // asks us to, or if its rewrite itself subsequently fails.
        if (microReplanAttempts < MAX_MICRO_REPLAN_ATTEMPTS) {
          const economyNav = (opts.config.cost_mode ?? "balanced") !== "max";
          const microModel = economyNav
            ? (opts.config.models.navigator_economy ?? "claude-haiku-4-5-20251001")
            : models.replan;
          const microResult = await microReplan(
            {
              failed_step: plannedStep,
              failure_reason: result.error ?? "failed without error message",
              current_url: page.url(),
              current_screenshot_base64: await takeScreenshotBase64(page),
              dom_summary: formatDomSummary(await extractDomSummary(page)),
              persona,
              hints: scenario.hints ?? [],
            },
            microModel,
            cost,
          );
          microReplanAttempts++;

          // Defensive: microReplan may return undefined under exhausted mocks
          // or upstream LLM failures. Treat as "escalate to full replan" so
          // the loop never crashes on `microResult.kind` access. The full
          // replan path below has its own retry / max_replans budget.
          if (!microResult || typeof microResult !== "object") {
            log.warn(
              { microReplanAttempts },
              "agent-loop: microReplan returned no result, escalating to full replan",
            );
            // Fall through to the full replan below.
          } else if (microResult.kind === "rewrite") {
            // Replace the failing step in-place and retry.
            plan.steps[stepIndex] = microResult.replacement;
            convergence.resetFailures();
            eventBus.emitEvent("plan:revised", {
              plan_id: plan.id,
              steps: plan.steps,
              reasoning: `micro-replan rewrite: ${microResult.replacement.reasoning}`,
              kind: "micro_rewrite",
            });
            continue;
          } else if (microResult.kind === "skip") {
            stepIndex++;
            convergence.resetFailures();
            eventBus.emitEvent("plan:revised", {
              plan_id: plan.id,
              steps: plan.steps,
              reasoning: `micro-replan skip: ${microResult.reason}`,
              kind: "micro_skip",
            });
            continue;
          }
          // kind === "escalate" OR undefined microResult — fall through to full replan
        }

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
        microReplanAttempts = 0; // fresh plan resets the counter
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
        {
          network: networkCollector,
          errors: errorCollector,
          performance: performanceCollector,
          preActionSnapshot,
        },
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
    log.error({ err: errMsg, stack: errStack }, `agent loop crashed`);
    issues.push({
      severity: "critical",
      description: `Autonomous loop crashed: ${errMsg}`,
      recommendation: "Check logs. This may indicate a page crash, network issue, or API quota exceeded.",
    });
  } finally {
    networkCollector.stop();
    errorCollector.stop();
    // Record plan outcome into cache (if we had a cache key)
    if (activeCacheKey && planCache) {
      const planSucceeded = convergenceReason === "goal_met";
      if (planSucceeded) {
        planCache.recordOutcome(activeCacheKey, true);
      } else if (convergenceReason === "max_replans" || convergenceReason === "error") {
        // Plan was abandoned — count as failure, will be retired after enough occurrences.
        planCache.recordOutcome(activeCacheKey, false);
      }
      // budget_exceeded / max_actions are not conclusive either way — don't record.
      planCache.close();
    }
    if (memory) memory.close();
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

interface SignalBundle {
  network: NetworkSignalCollector;
  errors: ErrorSignalCollector;
  performance: PerformanceSignalCollector;
  preActionSnapshot: PageSnapshot | null;
}

async function checkCriteria(
  state: CriteriaState,
  page: Page,
  totalActions: number,
  visualInterval: number,
  criticModel: string,
  cost: { value: number },
  eventBus: AgentEventBus,
  signals: SignalBundle,
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
      case "network":
        met = checkNetworkCriterion(criterion, signals.network);
        break;
      case "performance":
        met = await checkPerformanceCriterion(criterion, signals.performance);
        break;
      case "error":
        met = checkErrorCriterion(criterion, signals.errors);
        break;
      case "interaction":
        if (!signals.preActionSnapshot) continue;
        met = await checkInteractionCriterion(criterion, page, signals.preActionSnapshot);
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

// ─────────────────────────────────────────────────────────────
// Navigator dispatch — routes to economy or max tier per cost_mode
// ─────────────────────────────────────────────────────────────

/**
 * Choose and invoke the right navigator based on ProjectConfig.cost_mode,
 * overridable via AUDIT_COST_MODE env var for ad-hoc benchmarking.
 *
 *   'max'      → navigatorDecide with models.navigator (Sonnet)
 *   'balanced' → economicNavigatorDecide (Haiku primary → Sonnet escalation)
 *   'economy'  → economicNavigatorDecide (Haiku only, no escalation)
 */
async function runNavigator(
  input: Parameters<typeof navigatorDecide>[0],
  config: ProjectConfig,
  cost: { value: number },
): Promise<Awaited<ReturnType<typeof navigatorDecide>>> {
  const envMode = process.env.AUDIT_COST_MODE as "max" | "balanced" | "economy" | undefined;
  const mode = envMode ?? config.cost_mode ?? "balanced";
  const strong = config.models.navigator;
  const cheap = config.models.navigator_economy ?? "claude-haiku-4-5-20251001";

  if (mode === "max") {
    return navigatorDecide(input, strong, cost);
  }

  const decision = await economicNavigatorDecide(
    input,
    { primaryModel: cheap, fallbackModel: strong, primaryOnly: mode === "economy" },
    cost,
  );
  // Strip the telemetry prop before handing back to caller which types against NavigatorDecision.
  const { _telemetry, ...rest } = decision;
  void _telemetry;
  return rest;
}

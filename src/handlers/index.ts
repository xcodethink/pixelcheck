import * as path from "node:path";
import { createRequire } from "node:module";
import type { Page } from "playwright";
import type {
  Step,
  StepResult,
  Persona,
  Scenario,
  ConsoleError,
} from "../core/types.js";
import type { StagehandLike } from "../core/stagehand-wrapper.js";
import type { Recorder } from "../core/recorder.js";
import type { TempInbox } from "../core/email.js";
import { runCritic, type CriticResult } from "../core/critic.js";
import { parseAxeTags, expandAxeStandard } from "../core/wcag.js";
import { runComputerUseTask } from "../core/computer-use.js";
import { substituteTemplate } from "../core/scenario.js";
import { withRetry } from "../core/retry.js";
import { waitForMessage } from "../core/email.js";
import { diffAgainstBaseline, type DiffResult } from "../core/visual-diff.js";
import { waitForPageStable } from "../core/page-stability.js";
import { generateMutations, autoDiscoverSelectors } from "../core/instruction-mutator.js";

export interface StepContext {
  page: Page;
  stagehand: StagehandLike;
  recorder: Recorder;
  persona: Persona;
  scenario: Scenario;
  tempInbox?: TempInbox;
  models: { default: string; critic: string; computerUse: string };
  /** Mutable bag for step outputs to be referenced by later steps */
  store: Record<string, unknown>;
  /** Accumulator for critic outputs across the scenario */
  criticResults: CriticResult[];
  /** Accumulator for cost in USD */
  cost: { value: number };
  /** Stripe test secrets for substitution */
  stripeSecrets: Record<string, string>;
  /** Baseline dir for visual regression. If null, no diff. */
  baselineDir?: string;
  /** Diff results accumulator */
  diffResults: DiffResult[];
}

export type StepHandlerFn = (
  step: Step,
  ctx: StepContext,
) => Promise<Partial<StepResult>>;

/**
 * Master dispatch — picks the right handler for the step type.
 */
export async function executeStep(
  step: Step,
  ctx: StepContext,
): Promise<StepResult> {
  const startedAt = Date.now();
  let result: Partial<StepResult>;
  let retriesUsed = 0;
  const consoleErrors: ConsoleError[] = [];

  const runOnce = async () => {
    return await dispatch(step, ctx);
  };

  try {
    // `act` runs its own 4-layer reliability cascade (stagehand → selector
    // hint → instruction mutation → Opus computer-use) which IS its recovery
    // mechanism. Re-running it via the outer retry re-executes the whole
    // expensive cascade — including the Opus CU layer — multiplying spend on
    // every attempt. Cap act at zero outer retries; the cascade handles
    // recovery. Other step types keep step.retry. (Audit 2026-06-02 E3.)
    //
    // Uses the canonical core retry (maxRetries = retries, NOT total attempts)
    // so step execution shares one retry contract with the rest of the tool —
    // including its non-retryable guard, which refuses to retry
    // BudgetExceeded/ConsentDeclined (the vendored variant would have burned
    // spend retrying a budget error). (Audit 2026-06-02 D2-H1.)
    const maxRetries = step.type === "act" ? 0 : step.retry;
    result = await withRetry(
      runOnce,
      { maxRetries, backoffMs: 1000 },
      step.type,
      {
        onRetry: (_err, retryNumber) => {
          retriesUsed = retryNumber;
        },
      },
    );
    consoleErrors.push(...ctx.recorder.drainConsoleErrors());
  } catch (err) {
    consoleErrors.push(...ctx.recorder.drainConsoleErrors());
    const message = err instanceof Error ? err.message : String(err);
    // Take a failure screenshot for forensics
    const failShot = await ctx.recorder
      .screenshot(`${step.id}-FAIL`)
      .catch(() => undefined);

    return {
      step_id: step.id,
      step_type: step.type,
      status: step.critical ? "fail" : "warn",
      duration_ms: Date.now() - startedAt,
      error: message,
      retries_used: retriesUsed,
      screenshot: failShot?.filepath,
      screenshot_sha256: failShot?.sha256,
      console_errors: consoleErrors,
    };
  }

  return {
    step_id: step.id,
    step_type: step.type,
    status: result.status ?? "pass",
    duration_ms: Date.now() - startedAt,
    output: result.output,
    screenshot: result.screenshot,
    screenshot_sha256: result.screenshot_sha256,
    console_errors: consoleErrors,
    retries_used: retriesUsed,
    execution_method: result.execution_method,
  };
}

async function dispatch(step: Step, ctx: StepContext): Promise<Partial<StepResult>> {
  switch (step.type) {
    case "visit":
      return await handleVisit(step, ctx);
    case "act":
      return await handleAct(step, ctx);
    case "extract":
      return await handleExtract(step, ctx);
    case "observe":
      return await handleObserve(step, ctx);
    case "wait_for":
      return await handleWaitFor(step, ctx);
    case "assert_visual":
      return await handleAssertVisual(step, ctx);
    case "assert_dom":
      return await handleAssertDom(step, ctx);
    case "assert_a11y":
      return await handleAssertA11y(step, ctx);
    case "check_email":
      return await handleCheckEmail(step, ctx);
    case "screenshot":
      return await handleScreenshot(step, ctx);
    case "computer_use":
      return await handleComputerUse(step, ctx);
    case "custom":
      return await handleCustom(step, ctx);
    default: {
      const _exhaustive: never = step;
      throw new Error(`Unknown step type: ${(_exhaustive as Step).type}`);
    }
  }
}

const tplCtx = (ctx: StepContext) => ({
  persona: ctx.persona as unknown as Record<string, unknown>,
  env: process.env as Record<string, string>,
  stripe: ctx.stripeSecrets,
  store: ctx.store,
});

async function handleVisit(
  step: Extract<Step, { type: "visit" }>,
  ctx: StepContext,
): Promise<Partial<StepResult>> {
  const url = substituteTemplate(step.url, tplCtx(ctx));
  await ctx.page.goto(url, {
    waitUntil: step.wait_until,
    timeout: step.timeout ?? 30_000,
  });
  await ctx.page.waitForTimeout(800);
  return { status: "pass", output: { url } };
}

/**
 * handleAct — 4-Layer Reliability Stack
 *
 * Layer 1: Page stability gate (waitForPageStable)
 * Layer 2: Primary — Stagehand semantic action
 * Layer 3a: Selector Hint — direct Playwright click if selector_hint provided
 * Layer 3b: Instruction Mutation — rephrase/decompose/specify the instruction
 * Layer 4: Computer Use — autonomous pixel-level fallback (Sonnet for default,
 *          Opus for critical_review steps)
 *
 * Each layer only fires if the previous one failed. The execution_method
 * field in the result tracks which layer ultimately succeeded.
 */
async function handleAct(
  step: Extract<Step, { type: "act" }>,
  ctx: StepContext,
): Promise<Partial<StepResult>> {
  const instruction = substituteTemplate(step.instruction, tplCtx(ctx));

  // ── Layer 1: Page Stability Gate ─────────────────────────────────
  await waitForPageStable(ctx.page, { timeout: 6000 });

  // ── Layer 2: Stagehand Semantic Action (primary) ─────────────────
  try {
    const result = await ctx.stagehand.act({ action: instruction });
    return { status: "pass", output: result, execution_method: "stagehand" };
  } catch (stagehandErr) {
    // Primary failed — cascade through fallback layers
    const primaryError =
      stagehandErr instanceof Error ? stagehandErr.message : String(stagehandErr);

    // ── Layer 3a: Selector Hint (direct Playwright) ──────────────
    if (step.selector_hint) {
      try {
        const el = ctx.page.locator(step.selector_hint).first();
        await el.waitFor({ state: "visible", timeout: 5000 });
        await el.click();
        // Brief settle after click
        await ctx.page.waitForTimeout(300);
        return {
          status: "pass",
          output: { method: "selector_hint", selector: step.selector_hint },
          execution_method: "selector_hint",
        };
      } catch {
        // Selector hint also failed — continue to Layer 3b
      }
    }

    // ── Layer 3b: Instruction Mutation (LLM rewrite + local mutations) ──
    try {
      const mutations = await generateMutations(instruction, ctx.page, ctx.cost);
      for (const mutation of mutations) {
        for (const mutatedInstruction of mutation.instructions) {
          try {
            // Re-gate stability before each mutation attempt
            await waitForPageStable(ctx.page, { timeout: 3000, skipNetwork: true });
            const result = await ctx.stagehand.act({ action: mutatedInstruction });
            return {
              status: "pass",
              output: {
                method: "instruction_mutation",
                mutation_type: mutation.type,
                original: instruction,
                mutated: mutatedInstruction,
                result,
              },
              execution_method: "instruction_mutation",
            };
          } catch {
            // This mutation also failed — try next
            continue;
          }
        }
      }
    } catch {
      // Mutation generation itself failed — continue to Layer 3c
    }

    // ── Layer 3c: Auto Selector Discovery (observe → click) ─────
    try {
      const selectors = await autoDiscoverSelectors(instruction, ctx.stagehand);
      for (const selector of selectors) {
        try {
          const el = ctx.page.locator(selector).first();
          await el.waitFor({ state: "visible", timeout: 3000 });
          await el.click();
          await ctx.page.waitForTimeout(300);
          return {
            status: "pass",
            output: { method: "auto_selector", selector, original: instruction },
            execution_method: "selector_hint",
          };
        } catch {
          // This selector didn't work — try next
          continue;
        }
      }
    } catch {
      // observe() failed — continue to Layer 4
    }

    // ── Layer 4: Computer Use (autonomous fallback) ──────────────
    // Default to computer_use for act steps unless explicitly set to "skip" or "fail"
    const effectiveFallback = step.fallback ?? "computer_use";
    if (effectiveFallback === "computer_use") {
      // Use lightweight Sonnet mode for non-critical steps (3 iterations),
      // full Opus mode for critical_review steps (8 iterations).
      const isCritical = step.critical || step.critical_review;
      const cu = await runComputerUseTask({
        page: ctx.page,
        task: instruction,
        model: isCritical ? ctx.models.computerUse : ctx.models.default,
        maxIterations: isCritical ? 8 : 3,
      });
      ctx.cost.value += cu.costUsd;
      return {
        status: "pass",
        output: {
          method: "computer_use",
          primary_error: primaryError,
          ...cu,
        },
        execution_method: "computer_use",
      };
    }

    // ── Layer 4 (skip mode): skip step if configured ─────────────
    if (effectiveFallback === "skip") {
      return {
        status: "skip",
        output: { skipped: true, reason: primaryError },
      };
    }

    // All layers exhausted — propagate the original error
    throw stagehandErr;
  }
}

async function handleExtract(
  step: Extract<Step, { type: "extract" }>,
  ctx: StepContext,
): Promise<Partial<StepResult>> {
  // Layer 1: Stability gate
  await waitForPageStable(ctx.page, { timeout: 5000 });

  const instruction = substituteTemplate(step.instruction, tplCtx(ctx));
  const data = await ctx.stagehand.extract({
    instruction,
    schema: step.schema,
  });
  if (step.store_as) {
    ctx.store[step.store_as] = data;
  }
  return { status: "pass", output: data };
}

async function handleObserve(
  step: Extract<Step, { type: "observe" }>,
  ctx: StepContext,
): Promise<Partial<StepResult>> {
  // Layer 1: Stability gate
  await waitForPageStable(ctx.page, { timeout: 5000 });

  const instruction = substituteTemplate(step.instruction, tplCtx(ctx));
  const observations = await ctx.stagehand.observe({ instruction });
  if (step.store_as) {
    ctx.store[step.store_as] = observations;
  }
  return { status: "pass", output: observations };
}

async function handleWaitFor(
  step: Extract<Step, { type: "wait_for" }>,
  ctx: StepContext,
): Promise<Partial<StepResult>> {
  const timeout = step.timeout ?? 15_000;
  if (step.selector) {
    await ctx.page.locator(step.selector).first().waitFor({ timeout });
  } else if (step.text) {
    await ctx.page
      .getByText(step.text, { exact: false })
      .first()
      .waitFor({ timeout });
  } else if (step.ms) {
    await ctx.page.waitForTimeout(step.ms);
  } else {
    throw new Error("wait_for step requires selector, text, or ms");
  }
  return { status: "pass" };
}

async function handleAssertVisual(
  step: Extract<Step, { type: "assert_visual" }>,
  ctx: StepContext,
): Promise<Partial<StepResult>> {
  // Capture viewport-segmented screenshots for vision analysis. This avoids
  // the OCR hallucination caused by compressing a 6MB+ full-page screenshot
  // down to fit Anthropic's 1568px / 5MB limit.
  //
  // The recorder also produces a downscaled full-page thumbnail which we
  // pass FIRST so the model has macro context (where things are roughly)
  // before drilling into the high-res segments (exact text).
  const captured = await ctx.recorder.screenshotSegments(step.id);
  const diff = await maybeDiff(captured.full.filepath, step.id, ctx);
  const instruction = substituteTemplate(step.instruction, tplCtx(ctx));

  // Send: thumbnail (macro) + N segments (micro)
  const imageBuffers = [captured.thumbnail, ...captured.segments];

  const critic = await runCritic({
    model: ctx.models.critic,
    persona: ctx.persona,
    scenario: ctx.scenario,
    instruction,
    imageBuffers,
    stepId: step.id,
  });
  ctx.criticResults.push(critic);
  ctx.cost.value += critic.costUsd;

  // If critical_review is set and the critic has any high/critical issues
  // OR any score < 8, escalate to Computer Use second pass.
  let escalated = false;
  if (
    step.critical_review &&
    (critic.issues.some((i) => i.severity === "critical" || i.severity === "high") ||
      critic.scores.some((s) => s.score < 8))
  ) {
    escalated = true;
    const cu = await runComputerUseTask({
      page: ctx.page,
      task: `Re-review the current page with extra scrutiny. Original concern: ${instruction}. Look for issues a DOM-based check might miss: overlap, truncation, contrast, font sizing, hidden but rendered elements, broken images, layout breakage at this viewport.`,
      model: ctx.models.computerUse,
      maxIterations: 8,
    });
    ctx.cost.value += cu.costUsd;
  }

  // Determine pass/warn/fail
  const hasCriticalIssue = critic.issues.some((i) => i.severity === "critical");
  const hasHighIssue = critic.issues.some((i) => i.severity === "high");
  const minScore = critic.scores.length
    ? Math.min(...critic.scores.map((s) => s.score))
    : 10;

  let status: StepResult["status"] = "pass";
  if (hasCriticalIssue || minScore < 4) status = "fail";
  else if (hasHighIssue || minScore < 7) status = "warn";

  return {
    status,
    output: {
      scores: critic.scores,
      issues: critic.issues,
      escalated_to_computer_use: escalated,
      diff,
    },
    screenshot: captured.full.filepath,
    screenshot_sha256: captured.full.sha256,
  };
}

async function handleAssertDom(
  step: Extract<Step, { type: "assert_dom" }>,
  ctx: StepContext,
): Promise<Partial<StepResult>> {
  const locator = ctx.page.locator(step.selector);
  const expected = step.expected ?? {};
  const failures: string[] = [];

  if (expected.visible !== undefined) {
    const isVisible = await locator.first().isVisible().catch(() => false);
    if (isVisible !== expected.visible) {
      failures.push(`expected visible=${expected.visible}, got ${isVisible}`);
    }
  }
  if (expected.text_contains !== undefined) {
    const text = (await locator.first().textContent().catch(() => null)) ?? "";
    if (!text.includes(expected.text_contains)) {
      failures.push(`expected text to contain "${expected.text_contains}", got "${text.slice(0, 80)}"`);
    }
  }
  if (expected.count !== undefined) {
    const count = await locator.count();
    if (count !== expected.count) {
      failures.push(`expected count ${expected.count}, got ${count}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`assert_dom failed: ${failures.join("; ")}`);
  }
  return { status: "pass" };
}

/**
 * handleAssertA11y — axe-core WCAG accessibility audit.
 *
 * Injects axe-core into the page, runs analysis against the specified
 * WCAG standard, and converts violations to the auditor's Issue format.
 *
 * Complements the Vision Critic:
 *   - axe-core catches WCAG rule violations (ARIA, contrast, labels, etc.)
 *   - Vision Critic catches visual accessibility issues (layout, readability)
 */
/**
 * Resolve axe-core path using createRequire (ESM-safe).
 * Cached after first call.
 */
let _axeCorePath: string | undefined;
function resolveAxeCorePath(): string {
  if (!_axeCorePath) {
    const esmRequire = createRequire(import.meta.url);
    _axeCorePath = esmRequire.resolve("axe-core/axe.min.js");
  }
  return _axeCorePath;
}

async function handleAssertA11y(
  step: Extract<Step, { type: "assert_a11y" }>,
  ctx: StepContext,
): Promise<Partial<StepResult>> {
  // Layer 1: Stability gate — ensure page is fully rendered before analysis
  await waitForPageStable(ctx.page, { timeout: 5000 });

  const standard = step.standard ?? "wcag2aa";
  const exclude = step.exclude ?? [];
  const impactFilter = step.impact_filter;

  // Inject axe-core using Playwright's addScriptTag (CSP-safe — uses
  // Playwright's CDP protocol injection, bypasses page CSP restrictions).
  let axeResults: {
    violations: Array<{
      id: string;
      impact: "critical" | "serious" | "moderate" | "minor";
      description: string;
      help: string;
      helpUrl: string;
      tags: string[];
      nodes: Array<{ html: string; target: string[]; failureSummary: string }>;
    }>;
    passes: Array<{ id: string }>;
    incomplete: Array<{ id: string; impact: string }>;
  };

  try {
    // Inject axe-core via Playwright (not eval — CSP-safe)
    const axeCorePath = resolveAxeCorePath();
    const alreadyInjected = await ctx.page.evaluate(
      () => typeof (window as any).axe !== "undefined",
    );
    if (!alreadyInjected) {
      await ctx.page.addScriptTag({ path: axeCorePath });
    }

    // Run axe analysis.
    //
    // axe `runOnly: ["wcag2aa"]` is EXACT match — only rules tagged
    // wcag2aa run, NOT A-level rules. Pre-T-NEW-11 the handler passed
    // `[standard]` which silently missed Level A violations
    // (image-alt / label / button-name etc). Now we expand via
    // expandAxeStandard so e.g. wcag2aa → ["wcag2a", "wcag2aa"] and
    // wcag22aa → A+AA across 2.0/2.1/2.2. See ADR-030.
    const axeTags = expandAxeStandard(standard);
    axeResults = await ctx.page.evaluate(
      (runOpts) => {
        const axe = (window as any).axe;
        if (!axe) throw new Error("axe-core not available after injection");

        return axe.run(document, {
          runOnly: { type: "tag", values: runOpts.tags },
          resultTypes: ["violations", "passes", "incomplete"],
          ...(runOpts.exclude.length > 0
            ? { exclude: runOpts.exclude.map((s: string) => [s]) }
            : {}),
        });
      },
      { tags: axeTags, exclude },
    );
  } catch (err) {
    // axe-core injection or execution failed — return diagnostic, don't crash
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: step.critical ? "fail" : "warn",
      output: {
        error: `axe-core failed: ${message}`,
        standard,
        total_violations: 0,
        by_impact: { critical: 0, serious: 0, moderate: 0, minor: 0 },
        passes: 0,
        incomplete: 0,
        violations: [],
      },
    };
  }

  // Validate result shape
  if (!axeResults || !Array.isArray(axeResults.violations)) {
    return {
      status: "warn",
      output: { error: "axe-core returned invalid result shape", standard },
    };
  }

  // Filter by impact level if specified
  let violations = axeResults.violations;
  if (impactFilter && impactFilter.length > 0) {
    const filterSet = new Set(impactFilter);
    violations = violations.filter((v) => filterSet.has(v.impact));
  }

  // Count by severity
  const criticalCount = violations.filter((v) => v.impact === "critical").length;
  const seriousCount = violations.filter((v) => v.impact === "serious").length;
  const moderateCount = violations.filter((v) => v.impact === "moderate").length;
  const minorCount = violations.filter((v) => v.impact === "minor").length;

  // Convert to our Issue format. Each violation gets WCAG attribution
  // (level + dotted criterion id) extracted from its axe tags so
  // downstream reporters can group by WCAG level / principle / SC for
  // ADA / EAA compliance reporting (M2-2 / ADR-024).
  const issues = violations.map((v) => {
    const severity: "critical" | "high" | "medium" | "low" =
      v.impact === "critical"
        ? "critical"
        : v.impact === "serious"
          ? "high"
          : v.impact === "moderate"
            ? "medium"
            : "low";

    const wcagTags = v.tags.filter(
      (t) => t.startsWith("wcag") || t.startsWith("best-practice"),
    );
    const instances = v.nodes.length;
    const sampleTargets = v.nodes
      .slice(0, 3)
      .map((n) => n.target.join(" > "))
      .join("; ");

    const wcag = parseAxeTags(v.tags);

    return {
      severity,
      dimension: "accessibility" as const,
      step_id: step.id,
      description: `[${v.id}] ${v.description} (${instances} instance${instances > 1 ? "s" : ""}: ${sampleTargets})`,
      recommendation: `${v.help}. ${wcagTags.length > 0 ? `WCAG: ${wcagTags.join(", ")}. ` : ""}Reference: ${v.helpUrl}`,
      wcag_level: wcag.level,
      wcag_criterion: wcag.criterion?.id,
    };
  });

  // Compute accessibility score: weighted penalty formula
  const a11yScore = Math.max(
    0,
    10 - criticalCount * 2 - seriousCount * 1 - moderateCount * 0.5 - minorCount * 0.25,
  );

  // Push to critic results accumulator (consistent shape with runCritic output)
  const a11yScores = [
    {
      dimension: "accessibility",
      score: a11yScore,
      justification: `axe-core: ${criticalCount} critical, ${seriousCount} serious, ${moderateCount} moderate, ${minorCount} minor`,
    },
  ];
  ctx.criticResults.push({
    verdict: { scores: a11yScores, issues: [] },
    scores: a11yScores,
    issues,
    costUsd: 0,
    raw: { text: "", inputTokens: 0, outputTokens: 0, costUsd: 0 },
  });

  // Determine status
  const maxViolations = step.max_violations ?? 0;
  let status: StepResult["status"] = "pass";
  if (criticalCount > 0) {
    status = "fail";
  } else if (seriousCount > 0 || violations.length > maxViolations) {
    status = "warn";
  }

  return {
    status,
    output: {
      standard,
      total_violations: violations.length,
      by_impact: { critical: criticalCount, serious: seriousCount, moderate: moderateCount, minor: minorCount },
      passes: axeResults.passes.length,
      incomplete: axeResults.incomplete.length,
      a11y_score: a11yScore,
      violations: violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        instances: v.nodes.length,
        help_url: v.helpUrl,
      })),
    },
  };
}

async function handleCheckEmail(
  step: Extract<Step, { type: "check_email" }>,
  ctx: StepContext,
): Promise<Partial<StepResult>> {
  if (!ctx.tempInbox) {
    throw new Error("check_email step requires a temp inbox to be initialized in the scenario.");
  }
  const subjectMatch = step.expected_subject_contains
    ? substituteTemplate(step.expected_subject_contains, tplCtx(ctx))
    : undefined;
  const bodyMatch = step.expected_body_contains
    ? substituteTemplate(step.expected_body_contains, tplCtx(ctx))
    : undefined;

  const message = await waitForMessage(
    ctx.tempInbox,
    (m) => {
      if (subjectMatch && !m.subject.toLowerCase().includes(subjectMatch.toLowerCase())) {
        return false;
      }
      if (bodyMatch) {
        const body = (m.text ?? "") + (m.html?.join(" ") ?? "");
        if (!body.toLowerCase().includes(bodyMatch.toLowerCase())) return false;
      }
      return true;
    },
    step.wait_seconds * 1000,
  );

  if (!message) {
    throw new Error(
      `Email did not arrive within ${step.wait_seconds}s (subject contains: "${subjectMatch ?? "*"}")`,
    );
  }
  return {
    status: "pass",
    output: {
      from: message.from,
      subject: message.subject,
      received: message.receivedAt,
    },
  };
}

async function handleScreenshot(
  step: Extract<Step, { type: "screenshot" }>,
  ctx: StepContext,
): Promise<Partial<StepResult>> {
  const shot = await ctx.recorder.screenshot(step.label ?? step.id, step.full_page);
  const diff = await maybeDiff(shot.filepath, step.id, ctx);
  return {
    status: diff?.regression ? "warn" : "pass",
    screenshot: shot.filepath,
    screenshot_sha256: shot.sha256,
    output: diff ? { diff } : undefined,
  };
}

/**
 * If a baseline directory is configured, compare the current screenshot
 * against the baseline for this (persona, scenario, step) and return a
 * DiffResult. Bootstraps the baseline on first run.
 */
async function maybeDiff(
  currentPath: string,
  stepId: string,
  ctx: StepContext,
): Promise<DiffResult | undefined> {
  if (!ctx.baselineDir) return undefined;

  const fileName = path.basename(currentPath);
  const baselineKey = `${ctx.persona.id}__${ctx.scenario.id}__${stepId}.png`;
  const baselinePath = path.join(ctx.baselineDir, baselineKey);
  const diffOutput = path.join(
    path.dirname(currentPath),
    fileName.replace(/\.png$/, ".diff.png"),
  );

  try {
    const result = await diffAgainstBaseline({
      current: currentPath,
      baseline: baselinePath,
      diffOutput,
      thresholdPixels: 100,
    });
    ctx.diffResults.push(result);
    return result;
  } catch (err) {
    return {
      computed: false,
      regression: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handleComputerUse(
  step: Extract<Step, { type: "computer_use" }>,
  ctx: StepContext,
): Promise<Partial<StepResult>> {
  const task = substituteTemplate(step.task, tplCtx(ctx));
  const result = await runComputerUseTask({
    page: ctx.page,
    task,
    model: ctx.models.computerUse,
    maxIterations: step.max_iterations,
  });
  ctx.cost.value += result.costUsd;
  return { status: "pass", output: result };
}

async function handleCustom(
  step: Extract<Step, { type: "custom" }>,
  ctx: StepContext,
): Promise<Partial<StepResult>> {
  // Custom handlers are loaded via dynamic import. They must export a default
  // async function (step, ctx) => Partial<StepResult>.
  const handlerPath = step.handler;
  try {
    const mod = (await import(handlerPath)) as {
      default?: (s: typeof step, c: StepContext) => Promise<Partial<StepResult>>;
    };
    if (!mod.default) {
      throw new Error(`Custom handler ${handlerPath} has no default export`);
    }
    return await mod.default(step, ctx);
  } catch (err) {
    throw new Error(
      `Custom handler ${handlerPath} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
}

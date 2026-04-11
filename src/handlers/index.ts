import * as path from "node:path";
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
import { runComputerUseTask } from "../core/computer-use.js";
import { substituteTemplate } from "../core/scenario.js";
import { withRetry } from "stealth-core";
import { waitForMessage } from "../core/email.js";
import { diffAgainstBaseline, type DiffResult } from "../core/visual-diff.js";

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
  let result: Partial<StepResult> = {};
  let retriesUsed = 0;
  const consoleErrors: ConsoleError[] = [];

  const runOnce = async () => {
    return await dispatch(step, ctx);
  };

  try {
    result = await withRetry(runOnce, {
      maxAttempts: step.retry + 1,
      baseDelay: 1000,
      onRetry: (_err, attempt) => {
        retriesUsed = attempt;
      },
    });
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

async function handleAct(
  step: Extract<Step, { type: "act" }>,
  ctx: StepContext,
): Promise<Partial<StepResult>> {
  const instruction = substituteTemplate(step.instruction, tplCtx(ctx));
  try {
    const result = await ctx.stagehand.act({ action: instruction });
    return { status: "pass", output: result };
  } catch (err) {
    if (step.fallback === "computer_use") {
      // Fallback to Computer Use to recover from a missed click
      const cu = await runComputerUseTask({
        page: ctx.page,
        task: instruction,
        model: ctx.models.computerUse,
        maxIterations: 5,
      });
      ctx.cost.value += cu.costUsd;
      return { status: "pass", output: { fallback: "computer_use", ...cu } };
    }
    throw err;
  }
}

async function handleExtract(
  step: Extract<Step, { type: "extract" }>,
  ctx: StepContext,
): Promise<Partial<StepResult>> {
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
    );
  }
}

import * as fs from "node:fs";
import * as path from "node:path";
import pLimit from "p-limit";
import chalk from "chalk";
import type {
  Persona,
  Scenario,
  ProjectConfig,
  ScenarioRunResult,
  AuditRun,
  StepResult,
  Issue,
  DimensionScore,
} from "./types.js";
import { createStagehandWrapper } from "./stagehand-wrapper.js";
import { Recorder } from "./recorder.js";
import { executeStep, type StepContext } from "../handlers/index.js";
import { resolvePersonaSecrets } from "./persona.js";
import { createTempInbox } from "./email.js";
import { OriginThrottle, originOf } from "./throttle.js";
import {
  buildAdminCookies,
  getStripeSecrets,
  buildRedactPatterns,
} from "./secrets.js";
import type { CriticResult } from "./critic.js";
import type { DiffResult } from "./visual-diff.js";

export interface RunnerOptions {
  config: ProjectConfig;
  personas: Map<string, Persona>;
  scenarios: Scenario[];
  matrix: Array<{ scenario: Scenario; personaId: string }>;
  outputRoot: string;
  concurrency?: number;
  budgetUsd?: number;
  headless?: boolean;
  tag?: string;
  /** Path to the baselines directory (for visual regression). Optional. */
  baselineDir?: string;
  /** Whether to record Playwright trace for each unit */
  recordTrace?: boolean;
}

/**
 * Run the full (persona × scenario) matrix with concurrency control.
 *
 * Rules:
 *   - Different units run in parallel up to global concurrency.
 *   - Same target origin uses an OriginThrottle to serialize within-host work
 *     so we don't trip rate limits / WAFs.
 *   - Budget cap stops new units from starting once exceeded.
 */
export async function runAudit(opts: RunnerOptions): Promise<AuditRun> {
  const concurrency = opts.concurrency ?? opts.config.default_concurrency;
  const limit = pLimit(concurrency);
  const throttle = new OriginThrottle();
  const budget = opts.budgetUsd ?? opts.config.budget_usd;

  const runId = `${timestamp()}_${(opts.tag ?? opts.config.project_name)
    .replace(/[^a-z0-9_-]/gi, "_")
    .toLowerCase()}`;
  const runDir = path.join(opts.outputRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const stripeSecrets = getStripeSecrets();
  const redactPatterns = buildRedactPatterns(opts.config.redact_patterns);

  console.log(
    chalk.cyan(`\n[ai-audit] Run ${runId}`),
    chalk.gray(
      `(${opts.matrix.length} units, concurrency=${concurrency}, budget=$${budget.toFixed(2)})\n`,
    ),
  );

  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const results: ScenarioRunResult[] = [];
  const totalCost = { value: 0 };
  let stoppedForBudget = false;

  const tasks = opts.matrix.map(({ scenario, personaId }) =>
    limit(async () => {
      if (stoppedForBudget) {
        console.log(
          chalk.yellow(`[SKIP]`),
          `${scenario.id} × ${personaId} (budget exceeded)`,
        );
        return;
      }
      const persona = opts.personas.get(personaId);
      if (!persona) {
        console.log(
          chalk.red(`[ERROR]`),
          `persona ${personaId} not found for scenario ${scenario.id}`,
        );
        return;
      }
      const origin = originOf(opts.config.base_url);
      const result = await throttle.run(origin, () =>
        runOne({
          config: opts.config,
          persona: resolvePersonaSecrets(persona),
          scenario,
          runDir,
          headless: opts.headless ?? true,
          stripeSecrets,
          baselineDir: opts.baselineDir,
          recordTrace: opts.recordTrace ?? false,
        }),
      );
      totalCost.value += result.cost_usd;
      if (totalCost.value >= budget) {
        stoppedForBudget = true;
        console.log(
          chalk.yellow(
            `[BUDGET] Total cost $${totalCost.value.toFixed(2)} >= cap $${budget.toFixed(2)} — no new units will start.`,
          ),
        );
      }
      results.push(result);
      printUnitSummary(result);
    }),
  );

  await Promise.all(tasks);

  const finishedAt = new Date().toISOString();
  const summary = {
    total: results.length,
    pass: results.filter((r) => r.status === "pass").length,
    pass_with_issues: results.filter((r) => r.status === "pass_with_issues").length,
    fail: results.filter((r) => r.status === "fail").length,
    total_cost_usd: totalCost.value,
    total_issues: results.reduce((s, r) => s + r.issues.length, 0),
    critical_issues: results.reduce(
      (s, r) => s + r.issues.filter((i) => i.severity === "critical").length,
      0,
    ),
  };

  const audit: AuditRun = {
    run_id: runId,
    project_name: opts.config.project_name,
    base_url: opts.config.base_url,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Date.now() - startMs,
    results,
    summary,
    config: opts.config,
  };

  // Print failure repro hints
  for (const r of results) {
    if (r.status === "fail") {
      console.log(
        chalk.gray(
          `  [repro] npm run audit -- --scenario ${r.scenario_id} --persona ${r.persona_id} --headed`,
        ),
      );
    }
  }

  audit.redact_patterns = redactPatterns;
  return audit;
}

interface RunOneOpts {
  config: ProjectConfig;
  persona: Persona;
  scenario: Scenario;
  runDir: string;
  headless: boolean;
  stripeSecrets: Record<string, string>;
  baselineDir?: string;
  recordTrace: boolean;
}

async function runOne(opts: RunOneOpts): Promise<ScenarioRunResult> {
  const unitDir = path.join(
    opts.runDir,
    `${opts.persona.id}__${opts.scenario.id}`,
  );
  fs.mkdirSync(unitDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  console.log(
    chalk.blue(`[START]`),
    `${opts.scenario.id} × ${opts.persona.id}`,
  );

  let wrapper: Awaited<ReturnType<typeof createStagehandWrapper>> | undefined;
  let videoPath: string | undefined;
  const cost = { value: 0 };
  const stepResults: StepResult[] = [];
  const criticResults: CriticResult[] = [];
  const diffResults: DiffResult[] = [];
  const issues: Issue[] = [];
  let fingerprintId = "unknown";

  try {
    // Build admin cookies if scenario targets admin
    const targetsAdmin = opts.scenario.steps.some(
      (s) =>
        (s.type === "visit" && s.url.includes("/admin")) ||
        opts.scenario.id.includes("admin"),
    );
    const adminCookies = targetsAdmin
      ? buildAdminCookies(opts.config.admin_url ?? opts.config.base_url)
      : [];

    // Persistent storage for extension scenarios
    const userDataDir = opts.scenario.persistent_storage
      ? path.join(unitDir, "user-data")
      : undefined;

    wrapper = await createStagehandWrapper({
      persona: opts.persona,
      artifactsDir: unitDir,
      modelName: opts.config.models.default,
      apiKey: process.env.ANTHROPIC_API_KEY,
      headless: opts.headless,
      cookies: adminCookies,
      userDataDir,
      recordTrace: opts.recordTrace,
    });
    fingerprintId = wrapper.fingerprint.id;

    const recorder = new Recorder(wrapper.page, unitDir);

    // Some scenarios need a temp inbox (any check_email step → create inbox upfront)
    const needsInbox = opts.scenario.steps.some((s) => s.type === "check_email");
    const tempInbox = needsInbox ? await createTempInbox() : undefined;

    const ctx: StepContext = {
      page: wrapper.page,
      stagehand: wrapper.stagehand,
      recorder,
      persona: opts.persona,
      scenario: opts.scenario,
      tempInbox,
      models: {
        default: opts.config.models.default,
        critic: opts.config.models.critic,
        computerUse: opts.config.models.computer_use,
      },
      store: tempInbox ? { temp_inbox_address: tempInbox.address } : {},
      criticResults,
      cost,
      stripeSecrets: opts.stripeSecrets,
      baselineDir: opts.baselineDir,
      diffResults,
    };

    for (const step of opts.scenario.steps) {
      const result = await executeStep(step, ctx);
      stepResults.push(result);

      if (result.status === "fail" && step.critical) {
        console.log(
          chalk.red(`[CRITICAL FAIL]`),
          `${opts.scenario.id}/${step.id}: ${result.error ?? "see logs"}`,
        );
        break;
      }
    }

    recorder.flushConsoleLog();
  } catch (err) {
    issues.push({
      severity: "critical",
      description: `Scenario crashed: ${err instanceof Error ? err.message : String(err)}`,
      recommendation: "Check the logs and verify environment / credentials.",
    });
  } finally {
    if (wrapper) {
      try {
        videoPath = await wrapper.close();
      } catch {
        // ignore
      }
    }
  }

  // Aggregate scores from critic results
  const dimensionMap = new Map<string, number[]>();
  for (const cr of criticResults) {
    for (const s of cr.scores) {
      const arr = dimensionMap.get(s.dimension) ?? [];
      arr.push(s.score);
      dimensionMap.set(s.dimension, arr);
    }
    issues.push(...cr.issues);
  }
  const scores: DimensionScore[] = Array.from(dimensionMap.entries()).map(
    ([dimension, arr]) => ({
      dimension,
      score: arr.reduce((a, b) => a + b, 0) / arr.length,
      justification: `Aggregated across ${arr.length} critic call(s)`,
    }),
  );
  const overall = scores.length
    ? scores.reduce((s, x) => s + x.score, 0) / scores.length
    : 0;

  // Add visual regression issues
  const regressions = diffResults.filter((d) => d.regression);
  for (const r of regressions) {
    issues.push({
      severity: "medium",
      dimension: "visual_regression",
      description: `Visual regression: ${r.diffPixels ?? "?"} pixels differ from baseline${r.reason ? ` (${r.reason})` : ""}`,
      recommendation:
        "Open the diff PNG next to the screenshot to inspect the regression. Update baseline if intentional.",
      screenshot: r.diffImagePath,
    });
  }

  // Determine final status
  const hasCrit = issues.some((i) => i.severity === "critical");
  const hasFailStep = stepResults.some((s) => s.status === "fail");
  const status: ScenarioRunResult["status"] = hasCrit || hasFailStep
    ? "fail"
    : issues.length > 0 || stepResults.some((s) => s.status === "warn")
      ? "pass_with_issues"
      : "pass";

  return {
    scenario_id: opts.scenario.id,
    scenario_name: opts.scenario.name,
    persona_id: opts.persona.id,
    persona_display_name: opts.persona.display_name,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startMs,
    status,
    fingerprint_id: fingerprintId,
    steps: stepResults,
    scores,
    overall_score: overall,
    issues,
    artifacts: {
      video: videoPath,
      har: wrapper?.harPath,
      console_log: path.join(unitDir, "console.log"),
    },
    cost_usd: cost.value,
  };
}

function printUnitSummary(r: ScenarioRunResult): void {
  const tag =
    r.status === "pass"
      ? chalk.green("[PASS]")
      : r.status === "pass_with_issues"
        ? chalk.yellow("[WARN]")
        : chalk.red("[FAIL]");
  console.log(
    tag,
    `${r.scenario_id} × ${r.persona_id}`,
    chalk.gray(
      `score=${r.overall_score.toFixed(1)} issues=${r.issues.length} cost=$${r.cost_usd.toFixed(3)} ${(
        r.duration_ms / 1000
      ).toFixed(1)}s`,
    ),
  );
}

function timestamp(): string {
  const d = new Date();
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "_" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

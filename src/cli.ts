#!/usr/bin/env node
import * as path from "node:path";
import * as fs from "node:fs";
import { Command } from "commander";
import chalk from "chalk";
import dotenv from "dotenv";
import { loadProjectConfig, validateEnv } from "./core/config.js";
import { loadPersonas } from "./core/persona.js";
import { loadScenarios, buildExecutionMatrix } from "./core/scenario.js";
import { runAudit } from "./core/runner.js";
import {
  writeJsonReport,
  writeHtmlReport,
  writeMarkdownSummary,
} from "./core/reporter.js";
import { notifySlack, notifyTelegram } from "./core/notify.js";
import { preflightUrls } from "./core/url-preflight.js";
import { resolvePersonaSecrets } from "./core/persona.js";
import { getStripeSecrets } from "./core/secrets.js";

dotenv.config();

const program = new Command();

program
  .name("ai-audit")
  .description(
    "AI-driven post-deployment UX audit. Real browser, real personas, commercial-grade evaluation.",
  )
  .version("0.1.0");

program
  .command("run", { isDefault: true })
  .description("Run an audit")
  .option("-c, --config <path>", "Project config file", "config/scamlens.yaml")
  .option(
    "-p, --personas <dir>",
    "Personas directory",
    "personas",
  )
  .option(
    "-s, --scenarios <dir>",
    "Scenarios directory",
    "scenarios",
  )
  .option("-o, --out <dir>", "Output base dir", "reports")
  .option("--scenario <id>", "Run only this scenario id (repeatable)", collect, [])
  .option("--persona <id>", "Run only this persona id (repeatable)", collect, [])
  .option("-j, --concurrency <n>", "Parallel units", parseIntOpt)
  .option("--budget <usd>", "Max USD budget", parseFloatOpt)
  .option("--headed", "Visible browser (debug)", false)
  .option("--tag <tag>", "Tag for this run", "manual")
  .option("--baseline <dir>", "Visual regression baseline directory", "baselines")
  .option("--no-baseline", "Disable visual regression diff")
  .option("--trace", "Record Playwright trace for each unit", false)
  .option("--dry-run", "Validate config + matrix only", false)
  .option(
    "--no-preflight",
    "Skip URL pre-flight HEAD probe (default: probe enabled)",
  )
  .action(async (opts) => {
    try {
      await runCommand(opts);
    } catch (err) {
      console.error(
        chalk.red("\n[FATAL]"),
        err instanceof Error ? err.message : String(err),
      );
      process.exit(1);
    }
  });

program.parse();

interface RunOpts {
  config: string;
  personas: string;
  scenarios: string;
  out: string;
  scenario: string[];
  persona: string[];
  concurrency?: number;
  budget?: number;
  headed: boolean;
  tag: string;
  baseline: string | false;
  trace: boolean;
  dryRun: boolean;
  preflight: boolean;
}

async function runCommand(opts: RunOpts): Promise<void> {
  // Load config + validate env
  const config = loadProjectConfig(path.resolve(opts.config));

  // Load personas + scenarios
  const personas = loadPersonas(path.resolve(opts.personas));
  const scenarios = loadScenarios(path.resolve(opts.scenarios));

  // Only require ANTHROPIC_API_KEY if any selected scenario contains a step
  // that needs an LLM call. Infra smoke tests (visit/wait/screenshot/assert_dom
  // only) can run with no key.
  const llmStepTypes = new Set([
    "act",
    "extract",
    "observe",
    "assert_visual",
    "computer_use",
  ]);
  const selectedScenarioIds = new Set(opts.scenario);
  const preview = opts.scenario.length > 0
    ? Array.from(scenarios.values()).filter((s) => selectedScenarioIds.has(s.id))
    : Array.from(scenarios.values());
  const needsLlm = preview.some((s) =>
    s.steps.some((step) => llmStepTypes.has(step.type)),
  );
  if (needsLlm) {
    validateEnv(["ANTHROPIC_API_KEY"]);
  } else {
    // Set a dummy key so Stagehand construction doesn't crash if it validates
    // the value exists. It won't be called because no LLM steps run.
    if (!process.env.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = "sk-ant-infra-smoke-no-llm-calls";
      console.log(
        chalk.gray(
          "  [note] No LLM steps detected — running without ANTHROPIC_API_KEY.",
        ),
      );
    }
  }

  // Filter
  let scenarioList = Array.from(scenarios.values());
  if (opts.scenario.length > 0) {
    scenarioList = scenarioList.filter((s) => opts.scenario.includes(s.id));
  }
  let allowedPersonaIds = new Set(personas.keys());
  if (opts.persona.length > 0) {
    allowedPersonaIds = new Set(opts.persona);
  }

  const matrix = buildExecutionMatrix(scenarioList, allowedPersonaIds);

  if (matrix.length === 0) {
    throw new Error(
      "Empty execution matrix. Check --scenario / --persona filters and scenario applies_to lists.",
    );
  }

  console.log(chalk.cyan(`\n[ai-audit] ${config.project_name}`));
  console.log(chalk.gray(`  Config: ${opts.config}`));
  console.log(chalk.gray(`  Personas loaded: ${personas.size}`));
  console.log(chalk.gray(`  Scenarios loaded: ${scenarios.size}`));
  console.log(chalk.gray(`  Matrix size: ${matrix.length}`));
  console.log(
    chalk.gray(
      `  Models: default=${config.models.default} critic=${config.models.critic} cu=${config.models.computer_use}`,
    ),
  );

  if (opts.dryRun) {
    console.log(chalk.green("\n[DRY-RUN] Matrix:"));
    for (const m of matrix) {
      console.log(`  - ${m.scenario.id} × ${m.personaId}`);
    }
  }

  // URL pre-flight: HEAD probe every concrete visit URL before running any
  // LLM-spending step. Catches 404s / DNS issues / SSL problems for free.
  if (opts.preflight !== false) {
    console.log(chalk.gray("\n[preflight] Probing visit URLs..."));
    const matrixWithPersona = matrix
      .map((m) => {
        const persona = personas.get(m.personaId);
        if (!persona) return null;
        return { scenario: m.scenario, persona: resolvePersonaSecrets(persona) };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);
    const issues = await preflightUrls(matrixWithPersona, {
      stripeSecrets: getStripeSecrets(),
      timeoutMs: 10000,
    });
    if (issues.length > 0) {
      console.log(
        chalk.red(`[preflight] FAIL — ${issues.length} URL(s) unreachable:`),
      );
      for (const i of issues) {
        console.log(
          chalk.red(
            `  ${i.status} ${i.url}  (${i.scenario}/${i.step}, persona=${i.persona})`,
          ),
        );
      }
      throw new Error(
        `URL pre-flight failed. Fix the URLs in your scenarios or use --no-preflight to bypass (not recommended — wastes LLM budget on guaranteed failures).`,
      );
    }
    console.log(chalk.green("[preflight] All URLs OK"));
  }

  if (opts.dryRun) {
    return;
  }

  const baselineDir =
    opts.baseline === false
      ? undefined
      : path.resolve(typeof opts.baseline === "string" ? opts.baseline : "baselines");

  const audit = await runAudit({
    config,
    personas,
    scenarios: scenarioList,
    matrix,
    outputRoot: path.resolve(opts.out),
    concurrency: opts.concurrency,
    budgetUsd: opts.budget,
    headless: !opts.headed,
    tag: opts.tag,
    baselineDir,
    recordTrace: opts.trace,
  });

  // Persist reports
  const runDir = path.join(path.resolve(opts.out), audit.run_id);
  fs.mkdirSync(runDir, { recursive: true });
  const jsonPath = writeJsonReport(audit, runDir);
  const htmlPath = writeHtmlReport(audit, runDir);
  const mdPath = writeMarkdownSummary(audit, runDir);

  await notifySlack(audit);
  await notifyTelegram(audit);

  console.log("");
  console.log(chalk.cyan("[ai-audit] Complete"));
  console.log(`  JSON:    ${jsonPath}`);
  console.log(`  HTML:    ${htmlPath}`);
  console.log(`  Summary: ${mdPath}`);
  console.log("");
  console.log(
    `  ${chalk.green("PASS")} ${audit.summary.pass}  ` +
      `${chalk.yellow("WARN")} ${audit.summary.pass_with_issues}  ` +
      `${chalk.red("FAIL")} ${audit.summary.fail}  ` +
      `(${audit.summary.critical_issues} critical issues)`,
  );
  console.log(`  Cost: $${audit.summary.total_cost_usd.toFixed(3)}`);
  console.log("");

  // Exit code: 0 = all pass, 1 = critical, 2 = warn
  if (audit.summary.fail > 0) process.exit(1);
  if (audit.summary.pass_with_issues > 0) process.exit(2);
  process.exit(0);
}

function collect(value: string, prev: string[]): string[] {
  return prev.concat([value]);
}

function parseIntOpt(value: string): number {
  return parseInt(value, 10);
}

function parseFloatOpt(value: string): number {
  return parseFloat(value);
}

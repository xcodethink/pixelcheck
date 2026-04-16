#!/usr/bin/env node
import * as path from "node:path";
import * as fs from "node:fs";
import { Command } from "commander";
import chalk from "chalk";
import dotenv from "dotenv";
import { loadProjectConfig, validateEnv } from "./core/config.js";
import { ScenarioSchema } from "./core/types.js";
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
import { saveAuditToHistory, loadHistory, diffRuns } from "./core/history.js";

dotenv.config();

const program = new Command();

program
  .name("ai-audit")
  .description(
    "AI-driven post-deployment UX audit. Real browser, real personas, commercial-grade evaluation.",
  )
  .version("0.2.0");

program
  .command("run", { isDefault: true })
  .description("Run an audit")
  .option(
    "--project <dir>",
    "Project directory containing config.yaml + scenarios/ (and optionally personas/)",
  )
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
  .option("--observe", "Start live observer dashboard", false)
  .option("--observe-port <port>", "Observer dashboard port", parseIntOpt)
  .option("--mode <mode>", "Filter scenarios by mode: scripted | autonomous")
  .option("--dry-run", "Validate config + matrix only", false)
  .option(
    "--no-preflight",
    "Skip URL pre-flight HEAD probe (default: probe enabled)",
  )
  .option(
    "--min-score <n>",
    "Quality gate: fail with exit code 1 if overall score is below this threshold (0-10)",
    parseFloatOpt,
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

program
  .command("history")
  .description("Show audit history and quality trends")
  .option("-o, --out <dir>", "Reports directory", "reports")
  .option("-n, --limit <n>", "Number of recent runs to show", parseIntOpt)
  .option("--project <name>", "Filter by project name")
  .action((histOpts: { out: string; limit?: number; project?: string }) => {
    const reportsDir = path.resolve(histOpts.out);
    const entries = loadHistory(reportsDir, {
      limit: histOpts.limit ?? 20,
      project: histOpts.project,
    });
    if (entries.length === 0) {
      console.log(chalk.yellow("No audit history found."));
      return;
    }
    console.log(
      chalk.cyan(
        `\n[ai-audit] History (${entries.length} run${entries.length > 1 ? "s" : ""})\n`,
      ),
    );
    console.log(
      chalk.gray(
        "  Date        | Score | Pass | Warn | Fail | Issues | Cost    | Tag",
      ),
    );
    console.log(chalk.gray("  " + "-".repeat(80)));
    for (const e of entries) {
      const date = e.startedAt.split("T")[0] ?? e.startedAt.slice(0, 10);
      const score =
        e.overallScore >= 8
          ? chalk.green(e.overallScore.toFixed(1))
          : e.overallScore >= 5
            ? chalk.yellow(e.overallScore.toFixed(1))
            : chalk.red(e.overallScore.toFixed(1));
      console.log(
        `  ${date}  | ${score.padStart(14)}  | ${String(e.passCount).padStart(4)} | ${String(e.warnCount).padStart(4)} | ${String(e.failCount).padStart(4)} | ${String(e.totalIssues).padStart(6)} | $${e.totalCostUsd.toFixed(3).padStart(6)} | ${e.tag ?? "-"}`,
      );
    }
    console.log("");
  });

program
  .command("diff <runA> <runB>")
  .description("Compare two audit runs")
  .option("-o, --out <dir>", "Reports directory", "reports")
  .action(
    (runA: string, runB: string, diffOpts: { out: string }) => {
      const reportsDir = path.resolve(diffOpts.out);
      const result = diffRuns(reportsDir, runA, runB);
      if (!result) {
        console.log(chalk.red("One or both runs not found in history."));
        process.exit(1);
      }
      console.log(chalk.cyan(`\n[ai-audit] Diff: ${runA} → ${runB}\n`));
      const delta = (v: number, unit: string, invert = false) => {
        const sign = v > 0 ? "+" : "";
        const color =
          v === 0
            ? chalk.gray
            : (invert ? v < 0 : v > 0)
              ? chalk.green
              : chalk.red;
        return color(`${sign}${v}${unit}`);
      };
      console.log(`  Overall Score: ${result.runA.overallScore.toFixed(1)} → ${result.runB.overallScore.toFixed(1)} (${delta(result.scoreDelta, "")})`);
      console.log(`  Issues:        ${result.runA.totalIssues} → ${result.runB.totalIssues} (${delta(result.issuesDelta, "", true)})`);
      console.log(`  Cost:          $${result.runA.totalCostUsd.toFixed(3)} → $${result.runB.totalCostUsd.toFixed(3)} (${delta(result.costDelta, "", true)})`);
      console.log(`  Duration:      ${(result.runA.durationMs / 1000).toFixed(0)}s → ${(result.runB.durationMs / 1000).toFixed(0)}s`);

      if (Object.keys(result.dimensionDeltas).length > 0) {
        console.log(chalk.gray("\n  Dimension deltas:"));
        for (const [dim, d] of Object.entries(result.dimensionDeltas)) {
          console.log(`    ${dim}: ${delta(d, "")}`);
        }
      }
      if (result.newIssues.length > 0) {
        console.log(chalk.red(`\n  New issues (${result.newIssues.length}):`));
        for (const i of result.newIssues.slice(0, 10)) {
          console.log(chalk.red(`    [${i.severity}] ${i.description.slice(0, 100)}`));
        }
      }
      if (result.resolvedIssues.length > 0) {
        console.log(
          chalk.green(
            `\n  Resolved issues (${result.resolvedIssues.length}):`,
          ),
        );
        for (const i of result.resolvedIssues.slice(0, 10)) {
          console.log(chalk.green(`    [${i.severity}] ${i.description.slice(0, 100)}`));
        }
      }
      console.log("");
    },
  );

program
  .command("init <dir>")
  .description("Create a new project audit directory with template files")
  .option("--name <name>", "Project name")
  .option("--url <url>", "Base URL of the project")
  .action((dir: string, initOpts: { name?: string; url?: string }) => {
    const projectDir = path.resolve(dir);
    const projectName = initOpts.name || path.basename(projectDir);
    const baseUrl = initOpts.url || "https://example.com";

    fs.mkdirSync(path.join(projectDir, "scenarios"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "config.yaml"),
      [
        `project_name: ${projectName}`,
        `base_url: ${baseUrl}`,
        "",
        "default_concurrency: 3",
        "default_timeout_ms: 30000",
        "",
        "models:",
        "  default: claude-sonnet-4-6",
        "  critic: claude-sonnet-4-6",
        "  computer_use: claude-opus-4-6",
        "",
        "budget_usd: 3.0",
        "",
        "redact_patterns:",
        "  - sk-ant-",
        "  - pk_test_",
        "  - pk_live_",
        "",
        "notifications:",
        "  slack_webhook_env: SLACK_WEBHOOK",
        "  telegram_chat_id_env: TELEGRAM_CHAT_ID",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(projectDir, "scenarios", "00-smoke.yaml"),
      [
        `id: "00-smoke"`,
        `name: "Smoke Test"`,
        `priority: P0`,
        `goal: "Verify the site loads and key elements are visible"`,
        "",
        "applies_to:",
        "  personas:",
        "    - us-english-free-mobile",
        "",
        "scoring_dimensions:",
        "  - completion",
        "  - visual_polish",
        "",
        "steps:",
        `  - type: visit`,
        `    url: "${baseUrl}"`,
        `  - type: screenshot`,
        `    label: homepage`,
        `  - type: assert_visual`,
        `    instruction: "The homepage loads fully with no visible errors, broken images, or layout issues"`,
        "",
      ].join("\n"),
    );

    console.log(chalk.green(`\n[ai-audit] Project initialized: ${projectDir}`));
    console.log(chalk.gray(`  config.yaml — edit base_url, project_name, budget`));
    console.log(chalk.gray(`  scenarios/00-smoke.yaml — starter smoke test`));
    console.log(chalk.gray(`\nRun: ai-audit run --project ${dir}`));
    console.log(chalk.gray(`Built-in personas (6) will be used automatically.`));
    console.log(chalk.gray(`To customize personas, create a personas/ dir inside the project.`));
  });

// ── explore command: ad-hoc autonomous exploration ──────────────────

program
  .command("explore")
  .description("Ad-hoc autonomous exploration without a YAML scenario")
  .requiredOption("--url <url>", "Starting URL")
  .requiredOption("--goal <goal>", "What the agent should achieve")
  .option("--persona <id>", "Persona id", "us-english-free-mobile")
  .option("--criteria <criteria...>", "Success criteria descriptions")
  .option("--budget <usd>", "Max USD budget", parseFloatOpt)
  .option("--observe", "Start live observer dashboard", false)
  .option("--observe-port <port>", "Observer dashboard port", parseIntOpt)
  .option("--headed", "Visible browser", false)
  .option("-o, --out <dir>", "Output base dir", "reports")
  .action(async (exploreOpts: {
    url: string;
    goal: string;
    persona: string;
    criteria?: string[];
    budget?: number;
    observe: boolean;
    observePort?: number;
    headed: boolean;
    out: string;
  }) => {
    try {
      dotenv.config();

      // Build an in-memory autonomous scenario
      const scenario = {
        id: "explore-adhoc",
        name: "Ad-hoc Exploration",
        priority: "P0" as const,
        goal: exploreOpts.goal,
        mode: "autonomous" as const,
        start_url: exploreOpts.url,
        applies_to: { personas: [exploreOpts.persona] },
        scoring_dimensions: ["completion" as const, "visual_polish" as const],
        success_criteria: (exploreOpts.criteria ?? ["Page loads successfully"]).map(
          (desc, i) => ({
            id: `criterion-${i}`,
            description: desc,
            verification: "visual" as const,
          }),
        ),
        persistent_storage: false,
      };

      const personas = loadPersonas(path.resolve("personas"));
      // Parse through the schema so defaulted fields (cost_mode, navigator_economy…)
      // are populated. This future-proofs the `explore` command against new fields.
      const { ProjectConfigSchema } = await import("./core/types.js");
      const config = ProjectConfigSchema.parse({
        project_name: "explore",
        base_url: exploreOpts.url,
        default_concurrency: 1,
        default_timeout_ms: 30_000,
        budget_usd: exploreOpts.budget ?? 2.0,
      });

      validateEnv(["ANTHROPIC_API_KEY"]);

      // Validate the in-memory scenario through Zod
      const validated = ScenarioSchema.safeParse(scenario);
      if (!validated.success) {
        throw new Error(
          `Invalid explore scenario:\n${validated.error.errors.map((e) => `  - ${e.path.join(".")}: ${e.message}`).join("\n")}`,
        );
      }
      const validScenario = validated.data;

      const { audit } = await runAudit({
        config,
        personas,
        scenarios: [validScenario],
        matrix: [{ scenario: validScenario, personaId: exploreOpts.persona }],
        outputRoot: path.resolve(exploreOpts.out),
        headless: !exploreOpts.headed,
        tag: "explore",
        observe: exploreOpts.observe,
        observerPort: exploreOpts.observePort,
      });

      console.log(chalk.cyan("\n[explore] Complete"));
      console.log(`  Score: ${audit.results[0]?.overall_score.toFixed(1) ?? "N/A"}`);
      console.log(`  Cost: $${audit.summary.total_cost_usd.toFixed(3)}`);
      if (audit.results[0]?.agent_summary) {
        const as = audit.results[0].agent_summary;
        console.log(`  Actions: ${as.total_actions}, Plans: ${as.plan_count}`);
        console.log(`  Criteria met: ${as.criteria_met.join(", ") || "none"}`);
        console.log(`  Convergence: ${as.convergence_reason}`);
      }
    } catch (err) {
      console.error(chalk.red("[FATAL]"), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── replay command: replay past sessions ───────────────────────────

program
  .command("replay <run-dir>")
  .description("Replay a past agent session in the observer dashboard")
  .option("--port <port>", "Dashboard port", parseIntOpt)
  .action(async (runDir: string, replayOpts: { port?: number }) => {
    const { loadEventsFromNdjson } = await import("./observer/session-store.js");
    const { ObserverServer } = await import("./observer/server.js");
    const { AgentEventBus } = await import("./agent/events.js");
    const { SessionStore } = await import("./observer/session-store.js");

    const resolvedDir = path.resolve(runDir);
    const eventsFile = path.join(resolvedDir, "events.ndjson");

    if (!fs.existsSync(eventsFile)) {
      console.error(chalk.red(`No events.ndjson found in ${resolvedDir}`));
      process.exit(1);
    }

    const events = loadEventsFromNdjson(eventsFile);
    if (events.length === 0) {
      console.log(chalk.yellow(`[replay] No events found in ${eventsFile}`));
      process.exit(0);
    }
    console.log(chalk.cyan(`[replay] Loaded ${events.length} events from ${eventsFile}`));

    const bus = new AgentEventBus("replay");
    const store = new SessionStore("replay");
    store.attach(bus);

    const server = new ObserverServer({
      port: replayOpts.port ?? 3847,
      eventBus: bus,
      sessionStore: store,
    });

    await server.start();
    console.log(chalk.gray("  Replaying events... (Ctrl+C to stop)"));

    // Replay events with relative timing between consecutive events
    let prevTimestamp = new Date(events[0].timestamp).getTime();
    for (const event of events) {
      const eventTime = new Date(event.timestamp).getTime();
      const delay = Math.min(Math.max(0, eventTime - prevTimestamp), 500);
      prevTimestamp = eventTime;
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
      store.recordEvent(event);
      bus.emit(event.type, event);
      bus.emit("*", event);
    }

    console.log(chalk.green("[replay] Complete. Dashboard still serving. Ctrl+C to stop."));
    // Keep process alive
    await new Promise(() => {});
  });

// ─────────────────────────────────────────────────────────────
// `benchmark` command — run WebArena-compatible task sets
// ─────────────────────────────────────────────────────────────

program
  .command("benchmark")
  .description("Run a benchmark task set through the autonomous agent and emit pass@1 metrics")
  .requiredOption("--tasks <path>", "Task file, directory, or .jsonl")
  .option("-p, --personas <dir>", "Personas directory", "personas")
  .option("-o, --out <dir>", "Output directory", "reports/benchmarks")
  .option("--tag <tag>", "Benchmark run label", "benchmark")
  .option("--cost-mode <mode>", "max|balanced|economy", "balanced")
  .option("--per-task-budget <usd>", "Per-task budget cap", parseFloatOpt)
  .option("--total-budget <usd>", "Total run budget cap", parseFloatOpt)
  .option("--limit <n>", "Cap number of tasks", parseIntOpt)
  .option("--tags <csv>", "Filter by tag(s) (comma-separated)")
  .option(
    "--difficulties <csv>",
    "Filter by difficulty (easy,medium,hard — comma-separated)",
  )
  .action(async (opts: BenchmarkCliOpts) => {
    const { loadTasks } = await import("./benchmark/loader.js");
    const { runBenchmark } = await import("./benchmark/runner.js");
    const { ProjectConfigSchema } = await import("./core/types.js");

    const difficulties = opts.difficulties
      ? (opts.difficulties.split(",").map((s) => s.trim()) as Array<"easy" | "medium" | "hard">)
      : undefined;
    const tagsFilter = opts.tags ? opts.tags.split(",").map((s) => s.trim()) : undefined;

    const tasks = loadTasks(opts.tasks, {
      difficulties,
      tags: tagsFilter,
      limit: opts.limit,
    });
    if (tasks.length === 0) {
      console.error(chalk.red("No benchmark tasks matched filters."));
      process.exit(1);
    }

    const personas = await loadPersonas(path.resolve(opts.personas));
    const config = ProjectConfigSchema.parse({
      project_name: "benchmark",
      base_url: tasks[0]!.start_url,
      default_concurrency: 1,
      default_timeout_ms: 30_000,
      budget_usd: opts.totalBudget ?? 20,
      cost_mode: opts.costMode,
    });

    validateEnv(["ANTHROPIC_API_KEY"]);

    const outDir = path.join(path.resolve(opts.out), `${opts.tag}_${Date.now()}`);
    console.log(chalk.cyan(`\n[benchmark] ${tasks.length} tasks | cost_mode=${opts.costMode} | out=${outDir}`));

    // The execute() hook wires each task into the autonomous agent loop.
    // Implementation lives in a separate module so the runner stays pure/unit-testable.
    const { executeBenchmarkTask } = await import("./benchmark/executor.js");

    const report = await runBenchmark({
      tasks,
      config,
      personas,
      perTaskBudget: opts.perTaskBudget,
      totalBudget: opts.totalBudget,
      outputDir: outDir,
      tag: opts.tag,
      execute: executeBenchmarkTask,
      onTaskComplete: (r) => {
        const marker = r.passed ? chalk.green("✓") : chalk.red("✗");
        console.log(
          `  ${marker} ${r.task_id}  $${r.cost_usd.toFixed(3)}  ${r.duration_ms}ms  ${r.convergence_reason}`,
        );
      },
    });

    console.log(chalk.cyan("\n[benchmark] Complete"));
    console.log(`  pass@1:     ${(report.pass_at_1 * 100).toFixed(1)}%  (${report.passed}/${report.total_tasks})`);
    console.log(`  total cost: $${report.total_cost_usd.toFixed(2)}`);
    console.log(`  avg cost:   $${report.avg_cost_usd.toFixed(3)}/task`);
    console.log(`  p50 / p95:  ${report.p50_duration_ms}ms / ${report.p95_duration_ms}ms`);
    console.log(`  report:     ${path.join(outDir, "benchmark.md")}`);
  });

program.parse();

interface RunOpts {
  project?: string;
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
  observe: boolean;
  observePort?: number;
  mode?: string;
  dryRun: boolean;
  preflight: boolean;
  minScore?: number;
}

async function runCommand(opts: RunOpts): Promise<void> {
  // --project shorthand: resolve config/scenarios/personas from project dir
  if (opts.project) {
    const projectDir = path.resolve(opts.project);
    if (!fs.existsSync(projectDir)) {
      throw new Error(`Project directory not found: ${projectDir}`);
    }
    const projectConfig = path.join(projectDir, "config.yaml");
    if (!fs.existsSync(projectConfig)) {
      throw new Error(
        `No config.yaml in project directory: ${projectDir}\nRun "ai-audit init <dir>" to create a project template.`,
      );
    }
    opts.config = projectConfig;
    opts.scenarios = path.join(projectDir, "scenarios");
    // Use project personas if they exist, otherwise use built-in shared personas
    const projectPersonas = path.join(projectDir, "personas");
    if (fs.existsSync(projectPersonas)) {
      opts.personas = projectPersonas;
    }
  }

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
  const needsLlm = preview.some(
    (s) =>
      s.mode === "autonomous" ||
      (s.steps ?? []).some((step) => llmStepTypes.has(step.type)),
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
  if (opts.mode) {
    scenarioList = scenarioList.filter((s) => (s.mode ?? "scripted") === opts.mode);
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

  const { audit } = await runAudit({
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
    observe: opts.observe,
    observerPort: opts.observePort,
  });

  // Persist reports
  const reportsDir = path.resolve(opts.out);
  const runDir = path.join(reportsDir, audit.run_id);
  fs.mkdirSync(runDir, { recursive: true });

  // Save to history DB (before reports so trend chart includes this run)
  try {
    saveAuditToHistory(audit, reportsDir);
    console.log(chalk.gray("  [history] Saved to history.db"));
  } catch (histErr) {
    console.warn(
      chalk.yellow(
        `  [history] Failed to save: ${histErr instanceof Error ? histErr.message : String(histErr)}`,
      ),
    );
  }

  const jsonPath = writeJsonReport(audit, runDir);
  const htmlPath = writeHtmlReport(audit, runDir, reportsDir);
  const mdPath = writeMarkdownSummary(audit, runDir);

  await notifySlack(audit);
  await notifyTelegram(audit);

  // Reliability stack stats
  const allSteps = audit.results.flatMap((r) => r.steps);
  const methodCounts: Record<string, number> = {};
  for (const s of allSteps) {
    const method = s.execution_method ?? "stagehand";
    methodCounts[method] = (methodCounts[method] ?? 0) + 1;
  }
  const totalActSteps = allSteps.filter(
    (s) => s.step_type === "act" || s.step_type === "extract" || s.step_type === "observe",
  ).length;

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

  // Show reliability stack breakdown if any fallbacks were used
  if (totalActSteps > 0) {
    const stagehand = methodCounts["stagehand"] ?? 0;
    const selectorHint = methodCounts["selector_hint"] ?? 0;
    const mutation = methodCounts["instruction_mutation"] ?? 0;
    const computerUse = methodCounts["computer_use"] ?? 0;
    const effective = allSteps.filter(
      (s) => s.status === "pass" || s.status === "warn",
    ).length;
    const total = allSteps.length;
    const rate = total > 0 ? ((effective / total) * 100).toFixed(1) : "0";
    console.log(
      chalk.gray(
        `  Reliability: ${rate}% effective (stagehand=${stagehand} selector_hint=${selectorHint} mutation=${mutation} computer_use=${computerUse})`,
      ),
    );
  }
  console.log("");

  // Overall score for quality gate
  const overallScore =
    audit.results.length > 0
      ? audit.results.reduce((s, r) => s + r.overall_score, 0) /
        audit.results.length
      : 0;

  // Quality gate: --min-score
  if (opts.minScore !== undefined && overallScore < opts.minScore) {
    console.log(
      chalk.red(
        `[QUALITY GATE] Overall score ${overallScore.toFixed(1)} < minimum ${opts.minScore} — failing build.`,
      ),
    );
    process.exit(1);
  }

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

interface BenchmarkCliOpts {
  tasks: string;
  personas: string;
  out: string;
  tag: string;
  costMode: "max" | "balanced" | "economy";
  perTaskBudget?: number;
  totalBudget?: number;
  limit?: number;
  tags?: string;
  difficulties?: string;
}

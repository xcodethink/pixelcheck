#!/usr/bin/env node
/* eslint-disable no-console -- CLI output layer: console IS the user-facing
   product here, not a stray debug leak. Library code (src/core, src/agent)
   keeps no-console as an error and routes through the logger. (Audit G2) */
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
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
import { writeSpaReport } from "./core/reporter-spa.js";
import { writePdfReport } from "./core/reporter-pdf.js";
import {
  writeJunitXmlReport,
  writeSarifReport,
  writeJsonLinesReport,
  writeGithubAnnotationsReport,
  detectCiEnvironment,
  renderGithubAnnotations,
  resolveCiFormats,
} from "./core/ci-reporters.js";
import { notifySlack, notifyTelegram } from "./core/notify.js";
import { preflightUrls } from "./core/url-preflight.js";
import { resolvePersonaSecrets } from "./core/persona.js";
import { buildRedactPatterns, getStripeSecrets, redact } from "./core/secrets.js";
import { saveAuditToHistory, loadHistory, diffRuns } from "./core/history.js";
import { writeTrendsDashboard } from "./core/reporter-trends.js";
import {
  renderDiffHtml,
  renderDiffJson,
  renderDiffMarkdown,
  writeDiffReport,
  type DiffReportFormat,
} from "./core/reporter-diff.js";
import { normaliseLocale, type Locale } from "./core/i18n.js";
import { registerSecret } from "./core/logger.js";
import { runDoctor, renderDoctorReport } from "./commands/doctor.js";
import {
  ensureHeadlessShell,
  installFullChromium,
  resolveHeadlessShell,
} from "./core/browser-install.js";
import { pixelcheckHome } from "./core/home-dir.js";
import {
  findLatestReport,
  loadAuditReport,
  runExplain,
  renderExplainText,
  renderExplainJson,
} from "./commands/explain.js";
import {
  generateCompletion,
  SUPPORTED_SHELLS,
  type Shell,
} from "./commands/completions.js";
import {
  runInitInteractive,
  writeSampleScenario,
} from "./commands/init-interactive.js";
import { ensureConsent } from "./core/consent.js";
import { getPackageVersion } from "./core/version.js";

// quiet: true silences dotenv 17's default load banner — `dotenv.config()`
// without options writes a "[dotenv@17] injecting env (N) from .env" line
// to stdout on every CLI invocation. That noise breaks any consumer that
// parses CLI stdout (and would corrupt MCP stdio JSON-RPC frames if this
// path were ever shared with the MCP server entry).
//
// Load order: the project `.env` (cwd) first, then `~/.pixelcheck/.env` as a
// fallback. dotenv keeps the FIRST value it sees for a key and never overrides
// a var already present in the real environment, so precedence is:
//   shell env  >  ./.env  >  ~/.pixelcheck/.env
// The home fallback is what lets a GLOBAL install (`npm i -g pixelcheck`) find
// ANTHROPIC_API_KEY without a `.env` in every project directory.
dotenv.config({
  quiet: true,
  path: [
    path.join(process.cwd(), ".env"),
    path.join(pixelcheckHome(), ".env"),
  ],
});

// Register all known env-derived secrets with the logger redaction layer
// before any log emission.
for (const p of buildRedactPatterns([])) registerSecret(p);

function safeError(...args: unknown[]): void {
  const patterns = buildRedactPatterns([]);
  const safeArgs = args.map((a) =>
    typeof a === "string" ? redact(a, patterns) : a,
  );
  console.error(...safeArgs);
}

/**
 * Resolve the path to the personas/ directory bundled with the npm package.
 *
 * When running from a globally-installed `pixelcheck`, `import.meta.url`
 * resolves to `<...>/node_modules/pixelcheck/dist/cli.js`. The bundled
 * personas live one level up at `<...>/node_modules/pixelcheck/personas/`.
 *
 * Returns null if the bundled directory cannot be found (e.g., a build
 * artefact running before `personas/` was added to `files: [...]` in
 * package.json — would have been the v1.0.0 shipping bug, fixed in v1.0.1).
 */
function resolveBundledPersonas(): string | null {
  try {
    const candidate = fileURLToPath(new URL("../personas", import.meta.url));
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  } catch {
    // import.meta.url may not be a file URL in some bundling scenarios
  }
  return null;
}

/**
 * Count YAML files in a directory. Returns 0 if dir is missing.
 * Used by `pixelcheck init` to surface the actual number of bundled
 * personas in its post-scaffold message (B5 fix: was hardcoded "(6)").
 */
function countYamlFiles(dir: string | null): number {
  if (!dir) return 0;
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).length;
  } catch {
    return 0;
  }
}

/**
 * Resolve a personas directory: prefer the user-supplied path, fall back to
 * the bundled personas/ shipped with the npm package. Returns the resolved
 * absolute path; if neither exists, returns the resolved user path so the
 * downstream loadPersonas() throws its standard "directory not found" error.
 *
 * B1 fix (v1.0.1): every loadPersonas() call site goes through this so a
 * fresh `npm install pixelcheck` user without a project-local personas/ dir
 * still gets the 18 bundled personas instead of [FATAL] crashing.
 */
function resolvePersonasPath(userPath: string): string {
  const resolved = path.resolve(userPath);
  if (fs.existsSync(resolved)) return resolved;
  const bundled = resolveBundledPersonas();
  if (bundled) return bundled;
  return resolved; // will throw friendly "Personas directory not found"
}

const program = new Command();

program
  .name("pixelcheck")
  .description(
    "MCP-first browser primitives for AI agents — real eyes and hands on the web. Local-first. Vendor-agnostic.",
  )
  .version(getPackageVersion());

program
  .command("run", { isDefault: true })
  .description("Run an audit")
  .option(
    "--project <dir>",
    "Project directory containing config.yaml + scenarios/ (and optionally personas/)",
  )
  .option("-c, --config <path>", "Project config file", "config.yaml")
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
    "Quality gate: exit code 3 if overall score is below this threshold (0-10). Distinct from a scenario failure (exit 1).",
    parseFloatOpt,
  )
  .option(
    "--ci-format <formats>",
    "Comma-separated CI output formats: junit,sarif,jsonl,gha,all,none (default: auto — emit all when CI is detected)",
  )
  .option(
    "--no-pdf",
    "Skip PDF report generation (default: generate audit.pdf for stakeholder distribution)",
  )
  .option(
    "--locale <code>",
    "Report language: en | zh-CN | ja | es | de (default: en, or project config's default_locale)",
  )
  .option(
    "--auto-consent",
    "Skip first-run privacy consent prompt (also AUDIT_AUTO_CONSENT=1). Use only after reading PRIVACY.md.",
    false,
  )
  .option(
    "--no-redact-inputs",
    "Disable automatic password/secret/token field redaction in screenshots. NOT recommended for production audits.",
  )
  .action(async (opts) => {
    try {
      await runCommand(opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Friendly catch for ANTHROPIC_API_KEY missing (R47): rather
      // than dump a stack trace, point the user to console.anthropic.com
      // and the doctor command.
      if (
        err instanceof Error &&
        msg.includes("Missing required environment variables") &&
        msg.includes("ANTHROPIC_API_KEY")
      ) {
        safeError(chalk.red("\n[pixelcheck] ANTHROPIC_API_KEY not set."));
        safeError(
          chalk.gray(
            "  Get a key at https://console.anthropic.com → set " +
              "ANTHROPIC_API_KEY=sk-ant-...",
          ),
        );
        safeError(
          chalk.gray("  Run `pixelcheck doctor` to verify your environment."),
        );
        process.exit(1);
      }
      // Friendly catch for ConsentDeclinedError (T22 R34): user
      // explicitly said "no" to the consent prompt — exit cleanly.
      if (err instanceof Error && err.name === "ConsentDeclinedError") {
        safeError(chalk.yellow("\n[pixelcheck] " + msg));
        process.exit(1);
      }
      safeError(
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
        `\n[pixelcheck] History (${entries.length} run${entries.length > 1 ? "s" : ""})\n`,
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
  .command("trends")
  .description(
    "Generate a long-running quality trends dashboard (HTML) from history.db",
  )
  .option("-o, --out <dir>", "Reports directory containing history.db", "reports")
  .option("--dashboard <path>", "Output path for the HTML file (default: <reports>/trends.html)")
  .option("-n, --limit <n>", "Cap on history rows used for charts", parseIntOpt)
  .option("--project <name>", "Filter by project name")
  .option(
    "--locale <code>",
    "Dashboard language: en | zh-CN | ja | es | de (default: en)",
  )
  .action(
    (trendsOpts: {
      out: string;
      dashboard?: string;
      limit?: number;
      project?: string;
      locale?: string;
    }) => {
      const reportsDir = path.resolve(trendsOpts.out);
      const outPath = writeTrendsDashboard(reportsDir, {
        outPath: trendsOpts.dashboard
          ? path.resolve(trendsOpts.dashboard)
          : undefined,
        limit: trendsOpts.limit,
        project: trendsOpts.project,
        locale: trendsOpts.locale ? normaliseLocale(trendsOpts.locale) : undefined,
      });
      console.log(
        chalk.cyan(`\n[pixelcheck] Trends dashboard written to:\n  ${outPath}\n`),
      );
    },
  );

program
  .command("diff <runA> <runB>")
  .description("Compare two audit runs")
  .option("-o, --out <dir>", "Reports directory", "reports")
  .option(
    "-f, --format <format>",
    "Output format: text | markdown | html | json (default: text)",
  )
  .option(
    "--output <path>",
    "Write the diff to this file instead of stdout (format inferred from extension when --format is not set)",
  )
  .option(
    "--max-issues <n>",
    "Cap on items shown in new/resolved issue lists (default 10)",
    parseIntOpt,
  )
  .option(
    "--locale <code>",
    "Diff language: en | zh-CN | ja | es | de (default: en)",
  )
  .action(
    (
      runA: string,
      runB: string,
      diffOpts: {
        out: string;
        format?: string;
        output?: string;
        maxIssues?: number;
        locale?: string;
      },
    ) => {
      const reportsDir = path.resolve(diffOpts.out);
      const result = diffRuns(reportsDir, runA, runB);
      if (!result) {
        console.log(chalk.red("One or both runs not found in history."));
        process.exit(1);
      }

      const format = (diffOpts.format ?? "text") as DiffReportFormat;
      const opts = {
        maxIssues: diffOpts.maxIssues,
        locale: diffOpts.locale ? normaliseLocale(diffOpts.locale) : undefined,
      };

      if (diffOpts.output) {
        const outPath = writeDiffReport(
          result,
          path.resolve(diffOpts.output),
          diffOpts.format ? format : undefined,
          opts,
        );
        console.log(chalk.cyan(`\n[pixelcheck] Diff written to:\n  ${outPath}\n`));
        return;
      }

      // No --output → render to stdout. text format keeps the legacy
      // colored-terminal layout via chalk; the other formats are
      // emitted as plain UTF-8 (downstream consumers redirect or pipe).
      switch (format) {
        case "markdown":
          process.stdout.write(renderDiffMarkdown(result, opts) + "\n");
          break;
        case "html":
          process.stdout.write(renderDiffHtml(result, opts) + "\n");
          break;
        case "json":
          process.stdout.write(renderDiffJson(result) + "\n");
          break;
        case "text":
        default: {
          // Legacy chalk-coloured terminal layout — preserved bit-for-bit
          // so users who pipe `pixelcheck diff | less -R` see the same output.
          console.log(chalk.cyan(`\n[pixelcheck] Diff: ${runA} → ${runB}\n`));
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
          console.log(
            `  Overall Score: ${result.runA.overallScore.toFixed(1)} → ${result.runB.overallScore.toFixed(1)} (${delta(result.scoreDelta, "")})`,
          );
          console.log(
            `  Issues:        ${result.runA.totalIssues} → ${result.runB.totalIssues} (${delta(result.issuesDelta, "", true)})`,
          );
          console.log(
            `  Cost:          $${result.runA.totalCostUsd.toFixed(3)} → $${result.runB.totalCostUsd.toFixed(3)} (${delta(result.costDelta, "", true)})`,
          );
          console.log(
            `  Duration:      ${(result.runA.durationMs / 1000).toFixed(0)}s → ${(result.runB.durationMs / 1000).toFixed(0)}s`,
          );
          if (Object.keys(result.dimensionDeltas).length > 0) {
            console.log(chalk.gray("\n  Dimension deltas:"));
            for (const [dim, d] of Object.entries(result.dimensionDeltas)) {
              console.log(`    ${dim}: ${delta(d, "")}`);
            }
          }
          if (result.newIssues.length > 0) {
            console.log(chalk.red(`\n  New issues (${result.newIssues.length}):`));
            for (const i of result.newIssues.slice(0, 10)) {
              console.log(
                chalk.red(`    [${i.severity}] ${i.description.slice(0, 100)}`),
              );
            }
          }
          if (result.resolvedIssues.length > 0) {
            console.log(
              chalk.green(`\n  Resolved issues (${result.resolvedIssues.length}):`),
            );
            for (const i of result.resolvedIssues.slice(0, 10)) {
              console.log(
                chalk.green(`    [${i.severity}] ${i.description.slice(0, 100)}`),
              );
            }
          }
          console.log("");
        }
      }
    },
  );

/**
 * Scaffold a project audit directory with config.yaml + a starter scenario.
 * Used by both the non-interactive `pixelcheck init <dir>` (CI / scripted)
 * and the interactive wizard `pixelcheck init` (no args, T23 R46).
 */
function scaffoldProject(args: {
  projectDir: string;
  projectName: string;
  baseUrl: string;
}): void {
  const { projectDir, projectName, baseUrl } = args;

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
        `  - id: visit-home`,
        `    type: visit`,
        `    url: "${baseUrl}"`,
        `  - id: capture-homepage`,
        `    type: screenshot`,
        `    label: homepage`,
        `  - id: assert-homepage-loads`,
        `    type: assert_visual`,
        `    instruction: "The homepage loads fully with no visible errors, broken images, or layout issues"`,
        "",
      ].join("\n"),
    );

    console.log(chalk.green(`\n[pixelcheck] Project initialized: ${projectDir}`));
    console.log(chalk.gray(`  config.yaml — edit base_url, project_name, budget`));
    console.log(chalk.gray(`  scenarios/00-smoke.yaml — starter smoke test`));
    console.log(chalk.gray(`\nRun: pixelcheck run --project ${projectDir}`));
    const bundledCount = countYamlFiles(resolveBundledPersonas());
    if (bundledCount > 0) {
      console.log(chalk.gray(`Built-in personas (${bundledCount}) will be used automatically.`));
      console.log(chalk.gray(`To customize personas, create a personas/ dir inside the project.`));
    } else {
      console.log(chalk.yellow(`No bundled personas found. Create a personas/ dir inside the project.`));
    }
}

program
  .command("init [dir]")
  .description(
    "Initialize a new audit project. With <dir>: non-interactive scaffold (CI-friendly). Without: interactive wizard.",
  )
  .option("--name <name>", "Project name (non-interactive only)")
  .option("--url <url>", "Base URL of the project (non-interactive only)")
  .action(
    async (
      dir: string | undefined,
      initOpts: { name?: string; url?: string },
    ) => {
      // Non-interactive path — backward-compat with v0.3 `init <dir>`
      if (dir) {
        const projectDir = path.resolve(dir);
        const projectName = initOpts.name || path.basename(projectDir);
        const baseUrl = initOpts.url || "https://example.com";
        scaffoldProject({ projectDir, projectName, baseUrl });
        return;
      }

      // Interactive path (T23 R46) — readline wizard prompts user, then
      // calls scaffoldProject with the answers.
      const answers = await runInitInteractive({ startDir: process.cwd() });
      scaffoldProject({
        projectDir: answers.projectDir,
        projectName: answers.projectName,
        baseUrl: answers.baseUrl,
      });

      if (answers.createSampleScenario) {
        const written = writeSampleScenario(
          answers.projectDir,
          answers.baseUrl,
        );
        if (written) {
          console.log(chalk.gray(`  scenarios/homepage-smoke.yaml — sample`));
        }
      }

      if (answers.runDoctorAfter) {
        console.log("");
        console.log(chalk.cyan("[pixelcheck] Running doctor checks..."));
        const report = await runDoctor({ projectDir: answers.projectDir });
        for (const line of renderDoctorReport(report)) {
          console.log(line);
        }
        if (report.exitCode !== 0) {
          console.log("");
          console.log(
            chalk.yellow(
              "Some doctor checks failed. Address them before running an audit.",
            ),
          );
        }
      }
    },
  );

// ── doctor command: diagnose environment for run-readiness ──────────

program
  .command("doctor")
  .description(
    "Diagnose Node / API key / config / scenarios / network. Exits 0 if ready, 1 if any check fails.",
  )
  .option("--verbose", "Show diagnostic details (env values via redaction)")
  .option("--skip-network", "Skip api.anthropic.com reachability check")
  .option("--skip-browser", "Skip the Playwright Chromium binary check")
  .option(
    "--fix",
    "Self-heal a missing headless-shell binary by downloading it directly",
  )
  .action(
    async (doctorOpts: {
      verbose?: boolean;
      skipNetwork?: boolean;
      skipBrowser?: boolean;
      fix?: boolean;
    }) => {
      const report = await runDoctor({
        verbose: doctorOpts.verbose,
        skipNetwork: doctorOpts.skipNetwork,
        skipBrowser: doctorOpts.skipBrowser,
        fix: doctorOpts.fix,
        onFixProgress: (line) => console.log(chalk.gray(`  ${line}`)),
      });
      for (const line of renderDoctorReport(report, {
        verbose: doctorOpts.verbose,
      })) {
        console.log(line);
      }
      process.exit(report.exitCode);
    },
  );

// ── install command: download the browser binary pixelcheck needs ───

program
  .command("install")
  .description(
    "Download the browser binary pixelcheck needs (Chrome Headless Shell). " +
      "Usually automatic via postinstall; run this if the browser is missing.",
  )
  .option(
    "--headed",
    "Also install full Chromium (only needed for `--headed` runs)",
  )
  .action(async (installOpts: { headed?: boolean }) => {
    const progress = (line: string) => console.log(chalk.gray(`  ${line}`));
    let failed = false;

    const existing = resolveHeadlessShell();
    if (existing?.present) {
      console.log(
        chalk.green("[OK] Chrome Headless Shell already installed."),
      );
    } else {
      console.log("Installing Chrome Headless Shell ...");
      const heal = await ensureHeadlessShell({ onProgress: progress });
      if (heal.status === "installed" || heal.status === "already-present") {
        console.log(chalk.green(`[OK] ${heal.message}`));
      } else {
        console.log(chalk.red(`[FAIL] ${heal.message}`));
        failed = true;
      }
    }

    if (installOpts.headed) {
      const r = installFullChromium({ onProgress: progress });
      if (r.status === "installed") {
        console.log(chalk.green(`[OK] ${r.message}`));
      } else {
        console.log(chalk.red(`[FAIL] ${r.message}`));
        failed = true;
      }
    }

    console.log("");
    if (failed) {
      console.log(
        chalk.yellow(
          "Some installs failed. Re-run `pixelcheck install`, or see " +
            "docs/INSTALLATION.md for offline / proxy setups.",
        ),
      );
      process.exit(1);
    }
    console.log("Run `pixelcheck doctor` to verify your environment.");
  });

// ── explain command: explain audit issues ───────────────────────────

program
  .command("explain <query>")
  .description(
    "Explain an audit issue. <query> is an issue index (0-based) or a dimension name (e.g. localization, accessibility).",
  )
  .option("--json", "Output machine-readable JSON")
  .option("--locale <locale>", "Report language (en, zh-CN, ja, es, de)")
  .option("--report <path>", "Path to a specific audit.json file")
  .action(
    (
      query: string,
      explainOpts: {
        json?: boolean;
        locale?: string;
        report?: string;
      },
    ) => {
      const locale = normaliseLocale(explainOpts.locale);

      // Resolve the audit report
      let reportPath = explainOpts.report;
      if (!reportPath) {
        reportPath = findLatestReport() ?? undefined;
        if (!reportPath) {
          safeError(
            chalk.red(
              "[pixelcheck] No audit report found. Run `pixelcheck run` first, or specify --report <path>.",
            ),
          );
          process.exit(1);
        }
      }

      if (!fs.existsSync(reportPath)) {
        safeError(
          chalk.red(`[pixelcheck] Report not found: ${reportPath}`),
        );
        process.exit(1);
      }

      let audit;
      try {
        audit = loadAuditReport(reportPath);
      } catch (err) {
        safeError(
          chalk.red(
            `[pixelcheck] Failed to parse report: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exit(1);
      }

      const result = runExplain(query, audit);

      if (explainOpts.json) {
        console.log(renderExplainJson(result));
      } else {
        for (const line of renderExplainText(result, locale)) {
          console.log(line);
        }
      }
    },
  );

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
      dotenv.config({ quiet: true });

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

      const personas = loadPersonas(resolvePersonasPath("personas"));
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

      // Write the full report set (JSON + HTML + SPA + markdown) just like
      // the `run` command does. Without this, `explore` users got browser
      // artifacts but no machine-readable report or rich explorer.
      const reportsDir = path.resolve(exploreOpts.out);
      const runDir = path.join(reportsDir, audit.run_id);

      // Persist to the history DB too — without this an `explore` run never
      // entered history, so trends/diff were silently empty for the
      // documented quick-start workflow. (Audit 2026-06-02 H3.)
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

      try {
        writeJsonReport(audit, runDir);
        writeHtmlReport(audit, runDir);
        writeSpaReport(audit, runDir);
        writeMarkdownSummary(audit, runDir);
      } catch (reportErr) {
        console.warn(chalk.yellow(
          `  [reports] failed to write: ${reportErr instanceof Error ? reportErr.message : String(reportErr)}`,
        ));
      }

      console.log(chalk.cyan("\n[explore] Complete"));
      console.log(`  Score: ${audit.results[0]?.overall_score.toFixed(1) ?? "N/A"}`);
      console.log(`  Cost: $${audit.summary.total_cost_usd.toFixed(3)}`);
      if (audit.results[0]?.agent_summary) {
        const as = audit.results[0].agent_summary;
        console.log(`  Actions: ${as.total_actions}, Plans: ${as.plan_count}`);
        console.log(`  Criteria met: ${as.criteria_met.join(", ") || "none"}`);
        console.log(`  Convergence: ${as.convergence_reason}`);
      }
      console.log(`  Reports: ${runDir}`);
    } catch (err) {
      safeError(chalk.red("[FATAL]"), err instanceof Error ? err.message : String(err));
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

    const personas = await loadPersonas(resolvePersonasPath(opts.personas));
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
        const marker = r.passed ? chalk.green("[OK]") : chalk.red("[FAIL]");
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

// ─────────────────────────────────────────────────────────────
// `calibrate` command — run critic against labeled fixtures + gate
// ─────────────────────────────────────────────────────────────

program
  .command("calibrate")
  .description("Run critic calibration against labeled screenshot fixtures; fails if the gate regresses.")
  .option(
    "--fixtures <dir>",
    "Calibration fixtures directory",
    "tests/fixtures/critic-calibration",
  )
  .option("--model <id>", "Critic model override (default: claude-sonnet-4-6)", "claude-sonnet-4-6")
  .option("--tag <tag>", "Run label", "calibrate")
  .option("--out <dir>", "Output directory", "reports/calibration")
  .option("--min-agreement <n>", "Minimum mean agreement (0..1)", parseFloatOpt)
  .option("--max-distance <n>", "Maximum mean max distance (0..10)", parseFloatOpt)
  .option("--min-fully-aligned <n>", "Minimum fully-aligned rate (0..1)", parseFloatOpt)
  .action(async (opts: CalibrateCliOpts) => {
    const { runCalibration, scoreReport } = await import("./calibration/runner.js");
    validateEnv(["ANTHROPIC_API_KEY"]);

    const outDir = path.join(path.resolve(opts.out), `${opts.tag}_${Date.now()}`);
    console.log(chalk.cyan(`\n[calibrate] fixtures=${opts.fixtures} model=${opts.model}`));

    const report = await runCalibration({
      fixturesDir: path.resolve(opts.fixtures),
      model: opts.model,
      tag: opts.tag,
      outputDir: outDir,
      onSampleComplete: (s) => {
        const marker =
          s.agreement_rate === 1 && s.issue_check.passed
            ? chalk.green("[OK]")
            : chalk.yellow("[WARN]");
        console.log(
          `  ${marker} ${s.sample_id}  agreement=${(s.agreement_rate * 100).toFixed(0)}%  max_dist=${s.max_distance.toFixed(1)}  $${s.cost_usd.toFixed(3)}`,
        );
      },
    });

    const gate = scoreReport(report, {
      min_mean_agreement: opts.minAgreement,
      max_mean_max_distance: opts.maxDistance,
      min_fully_aligned_rate: opts.minFullyAligned,
    });

    console.log(chalk.cyan("\n[calibrate] Complete"));
    console.log(`  mean agreement:      ${(gate.computed.mean_agreement * 100).toFixed(1)}%`);
    console.log(`  mean max distance:   ${gate.computed.mean_max_distance.toFixed(2)}`);
    console.log(`  fully aligned rate:  ${(gate.computed.fully_aligned_rate * 100).toFixed(1)}%`);
    console.log(`  total cost:          $${report.total_cost_usd.toFixed(3)}`);
    console.log(`  report:              ${path.join(outDir, "calibration.md")}`);

    if (!gate.passed) {
      console.log(chalk.red("\n[GATE FAILED]"));
      for (const v of gate.violations) console.log(chalk.red(`  - ${v}`));
      process.exit(1);
    }
    console.log(chalk.green("\n[GATE PASSED]"));
  });

// ─────────────────────────────────────────────────────────────
// `persona` command — generate persona YAML from market data
// ─────────────────────────────────────────────────────────────

const personaCmd = program.command("persona").description("Persona generator utilities");

personaCmd
  .command("generate")
  .description("Generate a persona YAML from country + device market data")
  .requiredOption("--country <code>", "ISO 3166-1 alpha-2 code (e.g. US, BR, IN)")
  .option("--device <class>", "desktop | tablet | mobile (defaults to market modal)")
  .option("--tier <tier>", "free | pro | max | power (defaults to typical for country)")
  .option("--id <id>", "Override persona id")
  .option("--out <dir>", "Write YAML to this dir (default: stdout)")
  .action(async (opts: PersonaGenCliOpts) => {
    const { writePersonaYaml, generatePersona } = await import("./persona-gen/generate.js");
    try {
      if (opts.out) {
        const pth = writePersonaYaml(
          {
            country: opts.country,
            device: opts.device as "desktop" | "tablet" | "mobile" | undefined,
            payment_tier: opts.tier as "free" | "pro" | "max" | "power" | undefined,
            id: opts.id,
          },
          path.resolve(opts.out),
        );
        console.log(chalk.cyan(`[persona] wrote ${pth}`));
      } else {
        const result = generatePersona({
          country: opts.country,
          device: opts.device as "desktop" | "tablet" | "mobile" | undefined,
          payment_tier: opts.tier as "free" | "pro" | "max" | "power" | undefined,
          id: opts.id,
        });
        process.stdout.write("# " + result.note + "\n" + result.yaml);
      }
    } catch (err) {
      safeError(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

personaCmd
  .command("list-countries")
  .description("Print the list of countries with market data available")
  .action(async () => {
    const { availableCountries } = await import("./persona-gen/generate.js");
    for (const c of availableCountries()) {
      console.log(`  ${c.code}  ${c.name}`);
    }
  });

// ── prune command: artifact retention cleanup ───────────────────────

program
  .command("prune")
  .description(
    "Delete primitive artifact directories (sees / acts / extracts / judges / compares) older than each kind's retention window (default 30 days, configurable via AUDIT_<KIND>_RETENTION_DAYS env vars; set to 0 to disable).",
  )
  .action(async () => {
    const { pruneAllArtifacts, renderPruneReport } = await import(
      "./core/artifacts-prune.js"
    );
    const result = pruneAllArtifacts({ skipStamp: true });
    console.log("Prune summary:");
    for (const line of renderPruneReport(result)) {
      console.log(line);
    }
    const hasErrors = result.entries.some((e) => e.errors.length > 0);
    process.exit(hasErrors ? 1 : 0);
  });

// ── completions command: shell tab-completion scripts ────────────────

program
  .command("completions <shell>")
  .description(
    "Generate shell completion scripts. Supported shells: bash, zsh, fish.",
  )
  .action((shell: string) => {
    const lower = shell.toLowerCase();
    if (!(SUPPORTED_SHELLS as readonly string[]).includes(lower)) {
      console.error(
        `Unknown shell: "${shell}". Supported shells: ${SUPPORTED_SHELLS.join(", ")}`,
      );
      console.error("");
      console.error("Usage:");
      console.error(
        "  pixelcheck completions bash > ~/.bash_completion.d/pixelcheck",
      );
      console.error(
        "  pixelcheck completions zsh  > ~/.zfunc/_pixelcheck",
      );
      console.error(
        "  pixelcheck completions fish > ~/.config/fish/completions/pixelcheck.fish",
      );
      process.exit(1);
    }
    process.stdout.write(generateCompletion(lower as Shell, program));
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
  ciFormat?: string;
  pdf: boolean;
  locale?: string;
  /** T22 — bypass first-run consent prompt (also AUDIT_AUTO_CONSENT=1 env). */
  autoConsent: boolean;
  /**
   * T22 — Commander's `--no-redact-inputs` flag becomes opts.redactInputs=false;
   * default (when flag not passed) is redactInputs=true (intentional).
   */
  redactInputs: boolean;
}

async function runCommand(opts: RunOpts): Promise<void> {
  // T22: validate API key before consent — if no API key, no point prompting.
  // The friendly error catcher above will surface the ANTHROPIC_API_KEY guidance.
  validateEnv(["ANTHROPIC_API_KEY"]);

  // T22: consent gate — first run prompts the operator (or auto-consents in
  // CI / non-TTY / via env / via flag). See PRIVACY.md and ADR-031 (TBD).
  // Only consent here, NOT before --dry-run (no data leaves the machine).
  if (!opts.dryRun) {
    await ensureConsent({ cliAutoConsent: opts.autoConsent });
  }

  // T22: surface --no-redact-inputs as an env var so deeply-nested handlers
  // (recorder.screenshot / recorder.screenshotSegments) can read it without
  // threading it through every signature. Default is ON; setting "0"
  // explicitly disables.
  if (opts.redactInputs === false) {
    process.env.AUDIT_REDACT_INPUTS = "0";
  }

  // --project shorthand: resolve config/scenarios/personas from project dir
  if (opts.project) {
    const projectDir = path.resolve(opts.project);
    if (!fs.existsSync(projectDir)) {
      throw new Error(`Project directory not found: ${projectDir}`);
    }
    const projectConfig = path.join(projectDir, "config.yaml");
    if (!fs.existsSync(projectConfig)) {
      throw new Error(
        `No config.yaml in project directory: ${projectDir}\nRun "pixelcheck init <dir>" to create a project template.`,
      );
    }
    opts.config = projectConfig;
    opts.scenarios = path.join(projectDir, "scenarios");
    // Use project personas if they exist, otherwise fall back to built-in
    // shared personas bundled with the package (B1 fix: v1.0.0 shipped no
    // personas at all and `pixelcheck run` would crash with "Personas
    // directory not found" for every fresh install — see ADR-034).
    const projectPersonas = path.join(projectDir, "personas");
    if (fs.existsSync(projectPersonas)) {
      opts.personas = projectPersonas;
    } else {
      const bundledPersonas = resolveBundledPersonas();
      if (bundledPersonas) {
        opts.personas = bundledPersonas;
      }
    }
  }

  // Load config + validate env
  const config = loadProjectConfig(path.resolve(opts.config));

  // Load personas + scenarios
  const personas = loadPersonas(resolvePersonasPath(opts.personas));
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

  console.log(chalk.cyan(`\n[pixelcheck] ${config.project_name}`));
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
  const spaPath = writeSpaReport(audit, runDir);

  // Resolve locale: --locale CLI arg overrides config.default_locale,
  // which itself defaults to 'en'. Unknown codes fall back to 'en' via
  // normaliseLocale (handles "zh", "ja-JP", case mismatches, etc).
  const reportLocale: Locale = normaliseLocale(
    opts.locale ?? config.default_locale,
  );

  // Stakeholder-facing PDF (default: on; --no-pdf to skip during local
  // iteration). PDF generation spawns a fresh chromium for the print
  // render — adds ~2s but the result is the artefact PMs / executives
  // / customers actually consume. Failures are non-fatal: the audit
  // remains complete and we just log a warning.
  let pdfPath: string | null = null;
  if (opts.pdf !== false) {
    try {
      pdfPath = await writePdfReport(audit, runDir, { locale: reportLocale });
    } catch (err) {
      console.warn(
        chalk.yellow(
          `  [pdf] Failed to render audit.pdf: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  // CI-friendly output formats. --ci-format selects which to emit:
  //   "auto" (default): emit all four when a CI environment is detected,
  //                     none on a developer laptop (so /tmp/audit-runs/
  //                     stays clean during local iteration)
  //   "all":            force-emit all four regardless of environment
  //   "none":           skip all CI formats
  //   "junit,sarif,..": comma-separated subset
  const ciSet = resolveCiFormats(opts.ciFormat);
  const ciOutputs: Record<string, string> = {};
  if (ciSet.has("junit")) ciOutputs.junit = writeJunitXmlReport(audit, runDir);
  if (ciSet.has("sarif")) ciOutputs.sarif = writeSarifReport(audit, runDir);
  if (ciSet.has("jsonl")) ciOutputs.jsonl = writeJsonLinesReport(audit, runDir);
  if (ciSet.has("gha")) ciOutputs.gha = writeGithubAnnotationsReport(audit, runDir);

  // When running inside GitHub Actions, also stream the annotations to
  // stderr so they attach inline to PR diffs without the user needing to
  // wire a separate workflow step. Other CI vendors don't have an
  // equivalent inline-annotation stdio convention.
  if (detectCiEnvironment() === "github-actions" && audit.summary.total_issues > 0) {
    for (const line of renderGithubAnnotations(audit)) {
      process.stderr.write(line + "\n");
    }
  }

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
  console.log(chalk.cyan("[pixelcheck] Complete"));
  console.log(`  JSON:    ${jsonPath}`);
  console.log(`  HTML:    ${htmlPath}`);
  console.log(`  SPA:     ${spaPath}`);
  console.log(`  Summary: ${mdPath}`);
  if (pdfPath) console.log(`  PDF:     ${pdfPath}`);
  for (const [name, p] of Object.entries(ciOutputs)) {
    console.log(`  ${name.toUpperCase().padEnd(7)} ${p}`);
  }
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

  // Exit-code contract (documented for CI):
  //   0 = clean pass
  //   1 = one or more scenarios FAILED (functional break) — most severe
  //   2 = passed with warnings (non-critical issues)
  //   3 = quality-gate regression: overall score below --min-score
  // Distinct codes let CI tell a score regression apart from a functional
  // failure; before, both were 1 and a warn=2 was masked whenever the gate
  // tripped. Precedence: a hard failure (1) dominates a gate regression (3),
  // which dominates warnings (2). (Audit 2026-06-02 H4.)
  if (audit.summary.fail > 0) process.exit(1);

  if (opts.minScore !== undefined && overallScore < opts.minScore) {
    console.log(
      chalk.red(
        `[QUALITY GATE] Overall score ${overallScore.toFixed(1)} < minimum ${opts.minScore} — failing build.`,
      ),
    );
    process.exit(3);
  }

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

interface CalibrateCliOpts {
  fixtures: string;
  model: string;
  tag: string;
  out: string;
  minAgreement?: number;
  maxDistance?: number;
  minFullyAligned?: number;
}

interface PersonaGenCliOpts {
  country: string;
  device?: string;
  tier?: string;
  id?: string;
  out?: string;
}

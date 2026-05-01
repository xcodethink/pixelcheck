/**
 * `ai-audit init` (no args) — interactive wizard for first-run setup.
 *
 * Why this exists (T23 closes RISK-REGISTER R46):
 * The legacy `ai-audit init <dir>` is non-interactive (CI-friendly).
 * For a human running `ai-audit init` cold, an interactive wizard
 * prompting for project name / base URL / API key / first scenario is
 * the difference between a 30-second setup and a 5-minute one.
 *
 * Implementation: Node's built-in `node:readline/promises`. Zero new
 * dependencies (the project already has chalk for color).
 *
 * The wizard:
 *   1. Asks for project name (default: current dir name)
 *   2. Asks for base URL (default: http://localhost:3000)
 *   3. Detects ANTHROPIC_API_KEY in env; if missing, instructs how to set it
 *   4. Offers to create a sample scenario (homepage smoke)
 *   5. Optionally runs `ai-audit doctor` at the end to sanity-check
 *
 * The wizard delegates to the same scaffolding logic the non-interactive
 * `init <dir>` already uses — see `scaffoldProject()`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface WizardAnswers {
  projectDir: string;
  projectName: string;
  baseUrl: string;
  createSampleScenario: boolean;
  runDoctorAfter: boolean;
}

export interface InitInteractiveOptions {
  /** Default starting dir (caller passes process.cwd() unless overridden). */
  startDir?: string;
  /**
   * Test seam — supply a custom prompt fn (returns the next answer) so
   * unit tests can drive the wizard without reading stdin.
   */
  promptFn?: (question: string, defaultAnswer?: string) => Promise<string>;
}

/**
 * Default prompt using readline. Returns the trimmed answer; falls back
 * to the supplied default if the user just hits enter.
 */
async function readlinePrompt(
  rl: readline.Interface,
  question: string,
  defaultAnswer?: string,
): Promise<string> {
  const suffix = defaultAnswer !== undefined ? ` [${defaultAnswer}]` : "";
  const raw = await rl.question(`${question}${suffix}: `);
  const trimmed = raw.trim();
  if (trimmed === "" && defaultAnswer !== undefined) return defaultAnswer;
  return trimmed;
}

/**
 * Run the interactive wizard. Returns the answers; the CALLER is
 * responsible for invoking the scaffolding logic (so cli.ts can reuse the
 * same `scaffoldProject` function the non-interactive `init <dir>`
 * already uses).
 */
export async function runInitInteractive(
  opts: InitInteractiveOptions = {},
): Promise<WizardAnswers> {
  const startDir = opts.startDir ?? process.cwd();

  let promptOnce: (
    question: string,
    defaultAnswer?: string,
  ) => Promise<string>;
  let rl: readline.Interface | undefined;

  if (opts.promptFn) {
    promptOnce = opts.promptFn;
  } else {
    rl = readline.createInterface({ input, output });
    promptOnce = (q, d) => readlinePrompt(rl!, q, d);
  }

  try {
    const intro = [
      "",
      "Welcome to ai-browser-auditor — interactive setup",
      "================================================",
      "",
      "This wizard creates a new audit project with:",
      "  - config.yaml (project name + base URL + model defaults)",
      "  - scenarios/ (at least one starter scenario)",
      "",
      "Press Enter to accept the default in [brackets].",
      "",
    ];
    for (const line of intro) {
      // eslint-disable-next-line no-console
      console.log(line);
    }

    const projectDirInput = await promptOnce(
      "Project directory (relative or absolute path)",
      ".",
    );
    const projectDir = path.resolve(startDir, projectDirInput);

    const defaultName = path.basename(projectDir);
    const projectName = await promptOnce("Project name", defaultName);

    const baseUrl = await promptOnce(
      "Base URL of the application to audit",
      "http://localhost:3000",
    );

    const createSampleAnswer = await promptOnce(
      "Create a sample 'homepage smoke' scenario? (y/n)",
      "y",
    );
    const createSampleScenario = /^y/i.test(createSampleAnswer);

    const runDoctorAnswer = await promptOnce(
      "Run `ai-audit doctor` after setup to verify environment? (y/n)",
      "y",
    );
    const runDoctorAfter = /^y/i.test(runDoctorAnswer);

    if (!process.env.ANTHROPIC_API_KEY) {
      // eslint-disable-next-line no-console
      console.log("");
      // eslint-disable-next-line no-console
      console.log("Note: ANTHROPIC_API_KEY is not set in your environment.");
      // eslint-disable-next-line no-console
      console.log(
        "      Get one at https://console.anthropic.com and set it before",
      );
      // eslint-disable-next-line no-console
      console.log(
        "      running an audit:  export ANTHROPIC_API_KEY=sk-ant-...",
      );
    }

    return {
      projectDir,
      projectName,
      baseUrl,
      createSampleScenario,
      runDoctorAfter,
    };
  } finally {
    if (rl) rl.close();
  }
}

/**
 * Sample 'homepage smoke' scenario YAML. Used by both the interactive
 * wizard (when the user opts in) and the non-interactive `init <dir>`
 * scaffolder when no scenarios/*.yaml files exist yet.
 */
export function sampleSmokeScenarioYaml(baseUrl: string): string {
  return [
    "id: homepage-smoke",
    "name: Homepage smoke audit",
    `description: First audit — visits the home page and runs basic checks.`,
    "",
    "steps:",
    `  - type: visit`,
    `    url: ${baseUrl}`,
    "",
    "  - type: assert_a11y",
    "    standard: wcag22aa",
    "",
    "  - type: see",
    `    goal: "Identify the primary call-to-action above the fold."`,
    "",
  ].join("\n");
}

/**
 * Write a sample scenario file to <projectDir>/scenarios/homepage-smoke.yaml.
 * Idempotent: skips if the file already exists. Returns the path written
 * (or null when skipped).
 */
export function writeSampleScenario(
  projectDir: string,
  baseUrl: string,
): string | null {
  const scenariosDir = path.join(projectDir, "scenarios");
  fs.mkdirSync(scenariosDir, { recursive: true });
  const filePath = path.join(scenariosDir, "homepage-smoke.yaml");
  if (fs.existsSync(filePath)) return null;
  fs.writeFileSync(filePath, sampleSmokeScenarioYaml(baseUrl), "utf8");
  return filePath;
}

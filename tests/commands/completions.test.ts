/**
 * Unit tests for src/commands/completions.ts.
 *
 * Covers:
 *  - bash / zsh / fish output generation (non-empty, valid structure)
 *  - All top-level commands appear in each shell's completions
 *  - Invalid shell type detection
 *  - Command introspection (extractCommands, extractGlobalOptions)
 */

import { describe, it, expect } from "vitest";
import { Command } from "commander";
import {
  generateCompletion,
  extractCommands,
  extractGlobalOptions,
  SUPPORTED_SHELLS,
  type Shell,
} from "../../src/commands/completions.js";

// ─────────────────────────────────────────────────────────────
// Build a realistic mock program tree that mirrors pixelcheck's
// command surface without pulling in the full cli.ts (which
// calls dotenv.config + registers secrets on import).
// ─────────────────────────────────────────────────────────────

function buildMockProgram(): Command {
  const program = new Command();
  program.name("pixelcheck").version("0.0.0-test");

  program
    .command("run")
    .description("Run an audit")
    .option("--project <dir>", "Project directory")
    .option("-o, --out <dir>", "Output base dir")
    .option("--headed", "Visible browser")
    .option("--dry-run", "Validate config only");

  program
    .command("history")
    .description("Show audit history and quality trends")
    .option("-o, --out <dir>", "Reports directory")
    .option("-n, --limit <n>", "Number of recent runs");

  program
    .command("trends")
    .description("Generate a quality trends dashboard")
    .option("-o, --out <dir>", "Reports directory");

  program
    .command("diff <runA> <runB>")
    .description("Compare two audit runs")
    .option("-f, --format <format>", "Output format");

  program
    .command("init [dir]")
    .description("Initialize a new audit project")
    .option("--name <name>", "Project name")
    .option("--url <url>", "Base URL");

  program
    .command("doctor")
    .description("Diagnose environment")
    .option("--verbose", "Show details")
    .option("--skip-network", "Skip network checks");

  program
    .command("explore")
    .description("Ad-hoc autonomous exploration")
    .option("--url <url>", "Starting URL")
    .option("--goal <goal>", "Agent goal");

  program
    .command("replay <run-dir>")
    .description("Replay a past agent session")
    .option("--port <port>", "Dashboard port");

  program
    .command("benchmark")
    .description("Run a benchmark task set")
    .option("--tasks <path>", "Task file");

  program
    .command("calibrate")
    .description("Run critic calibration")
    .option("--fixtures <dir>", "Fixtures directory");

  // Nested subcommand group (like `persona generate`, `persona list-countries`)
  const personaCmd = program.command("persona").description("Persona utilities");
  personaCmd
    .command("generate")
    .description("Generate a persona YAML")
    .option("--country <code>", "ISO country code")
    .option("--out <dir>", "Write YAML to dir");
  personaCmd
    .command("list-countries")
    .description("List countries with market data");

  program
    .command("prune")
    .description("Delete old artifact directories");

  program
    .command("completions <shell>")
    .description("Generate shell completion scripts");

  return program;
}

// ─────────────────────────────────────────────────────────────
// Expected commands — every top-level command that should
// appear in completions output.
// ─────────────────────────────────────────────────────────────

const EXPECTED_COMMANDS = [
  "run",
  "history",
  "trends",
  "diff",
  "init",
  "doctor",
  "explore",
  "replay",
  "benchmark",
  "calibrate",
  "persona",
  "prune",
  "completions",
];

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe("extractCommands", () => {
  it("returns all top-level commands", () => {
    const program = buildMockProgram();
    const cmds = extractCommands(program);
    const names = cmds.map((c) => c.name);

    for (const expected of EXPECTED_COMMANDS) {
      expect(names).toContain(expected);
    }
  });

  it("captures nested subcommands for persona", () => {
    const program = buildMockProgram();
    const cmds = extractCommands(program);
    const persona = cmds.find((c) => c.name === "persona");

    expect(persona).toBeDefined();
    expect(persona!.subcommands.length).toBe(2);
    const subNames = persona!.subcommands.map((s) => s.name);
    expect(subNames).toContain("generate");
    expect(subNames).toContain("list-countries");
  });

  it("captures options for run command", () => {
    const program = buildMockProgram();
    const cmds = extractCommands(program);
    const run = cmds.find((c) => c.name === "run")!;

    const optLongs = run.options.map((o) => o.long);
    expect(optLongs).toContain("project");
    expect(optLongs).toContain("out");
    expect(optLongs).toContain("headed");
    expect(optLongs).toContain("dry-run");
  });
});

describe("extractGlobalOptions", () => {
  it("includes version (help is implicit in Commander and not in options array)", () => {
    const program = buildMockProgram();
    const globals = extractGlobalOptions(program);
    const longs = globals.map((o) => o.long);

    expect(longs).toContain("version");
    // Commander's --help is implicit and not exposed in the options array
    expect(globals.length).toBeGreaterThanOrEqual(1);
  });
});

describe("generateCompletion — bash", () => {
  const program = buildMockProgram();
  const output = generateCompletion("bash", program);

  it("produces non-empty output", () => {
    expect(output.length).toBeGreaterThan(100);
  });

  it("contains the complete function and registration", () => {
    expect(output).toContain("_pixelcheck()");
    expect(output).toContain("complete -F _pixelcheck pixelcheck");
  });

  it("includes all top-level commands", () => {
    for (const cmd of EXPECTED_COMMANDS) {
      expect(output).toContain(cmd);
    }
  });

  it("includes per-command options", () => {
    expect(output).toContain("--project");
    expect(output).toContain("--verbose");
    expect(output).toContain("--skip-network");
  });

  it("includes nested subcommand names", () => {
    expect(output).toContain("generate");
    expect(output).toContain("list-countries");
  });
});

describe("generateCompletion — zsh", () => {
  const program = buildMockProgram();
  const output = generateCompletion("zsh", program);

  it("starts with #compdef", () => {
    expect(output).toMatch(/^#compdef pixelcheck/);
  });

  it("defines the _pixelcheck function", () => {
    expect(output).toContain("_pixelcheck()");
    expect(output).toContain('_pixelcheck "$@"');
  });

  it("includes all top-level commands with descriptions", () => {
    for (const cmd of EXPECTED_COMMANDS) {
      expect(output).toContain(cmd);
    }
    expect(output).toContain("Run an audit");
    expect(output).toContain("Diagnose environment");
  });

  it("includes command-specific options", () => {
    expect(output).toContain("--project");
    expect(output).toContain("--verbose");
  });
});

describe("generateCompletion — fish", () => {
  const program = buildMockProgram();
  const output = generateCompletion("fish", program);

  it("contains complete commands", () => {
    expect(output).toContain("complete -c pixelcheck");
  });

  it("disables file completions", () => {
    expect(output).toContain("complete -c pixelcheck -f");
  });

  it("includes all top-level commands", () => {
    for (const cmd of EXPECTED_COMMANDS) {
      expect(output).toContain(cmd);
    }
  });

  it("includes per-command options with descriptions", () => {
    // Fish uses `-l project` not `--project`
    expect(output).toContain("-l project");
    expect(output).toContain("Project directory");
  });

  it("includes nested subcommands", () => {
    expect(output).toContain("generate");
    expect(output).toContain("list-countries");
  });

  it("includes global options", () => {
    // Fish uses `-l version` not `--version`
    expect(output).toContain("-l version");
  });
});

describe("SUPPORTED_SHELLS constant", () => {
  it("contains bash, zsh, fish", () => {
    expect(SUPPORTED_SHELLS).toEqual(["bash", "zsh", "fish"]);
  });
});

describe("invalid shell type", () => {
  it("is not in SUPPORTED_SHELLS", () => {
    expect((SUPPORTED_SHELLS as readonly string[]).includes("powershell")).toBe(
      false,
    );
    expect((SUPPORTED_SHELLS as readonly string[]).includes("")).toBe(false);
    expect((SUPPORTED_SHELLS as readonly string[]).includes("csh")).toBe(false);
  });
});

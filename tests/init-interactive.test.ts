/**
 * Unit tests for src/commands/init-interactive.ts.
 *
 * Drives the wizard via the `promptFn` test seam (no readline / stdin).
 * Covers: defaults / explicit inputs / sample-scenario opt-in / doctor
 * opt-in / API key absence note + sampleSmokeScenarioYaml + writeSampleScenario.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runInitInteractive,
  sampleSmokeScenarioYaml,
  writeSampleScenario,
} from "../src/commands/init-interactive.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "init-interactive-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

/**
 * Build a promptFn that returns answers from the supplied array in order.
 * If the wizard asks more questions than answers supplied, the helper
 * throws — guarding against the wizard adding new prompts without test
 * updates.
 */
function makePromptFn(answers: string[]): (q: string) => Promise<string> {
  let i = 0;
  return async (_question: string, defaultAnswer?: string) => {
    if (i >= answers.length) {
      throw new Error(
        `wizard asked more questions than answers supplied (i=${i}, total=${answers.length})`,
      );
    }
    const supplied = answers[i++];
    if (supplied === "" && defaultAnswer !== undefined) return defaultAnswer;
    return supplied!;
  };
}

describe("runInitInteractive — happy path", () => {
  it("uses all defaults when user just hits enter", async () => {
    const promptFn = makePromptFn(["", "", "", "", ""]);
    const answers = await runInitInteractive({
      startDir: tmpRoot,
      promptFn,
    });
    expect(answers.projectDir).toBe(tmpRoot); // "." resolved against tmpRoot
    expect(answers.projectName).toBe(path.basename(tmpRoot));
    expect(answers.baseUrl).toBe("http://localhost:3000");
    expect(answers.createSampleScenario).toBe(true);
    expect(answers.runDoctorAfter).toBe(true);
  });

  it("respects explicit answers", async () => {
    const promptFn = makePromptFn([
      "demo-project",
      "demo-shop",
      "https://demo.example.com",
      "n",
      "n",
    ]);
    const answers = await runInitInteractive({
      startDir: tmpRoot,
      promptFn,
    });
    expect(answers.projectDir).toBe(path.join(tmpRoot, "demo-project"));
    expect(answers.projectName).toBe("demo-shop");
    expect(answers.baseUrl).toBe("https://demo.example.com");
    expect(answers.createSampleScenario).toBe(false);
    expect(answers.runDoctorAfter).toBe(false);
  });

  it("treats 'y'/'Y'/'yes'/'YES' as truthy", async () => {
    const promptFn = makePromptFn(["", "", "", "Y", "yes"]);
    const answers = await runInitInteractive({
      startDir: tmpRoot,
      promptFn,
    });
    expect(answers.createSampleScenario).toBe(true);
    expect(answers.runDoctorAfter).toBe(true);
  });

  it("treats 'n'/'N'/'no'/'never' as falsy", async () => {
    const promptFn = makePromptFn(["", "", "", "N", "never"]);
    const answers = await runInitInteractive({
      startDir: tmpRoot,
      promptFn,
    });
    expect(answers.createSampleScenario).toBe(false);
    expect(answers.runDoctorAfter).toBe(false);
  });

  it("resolves projectDir as absolute when relative path given", async () => {
    const promptFn = makePromptFn(["my-app", "", "", "", ""]);
    const answers = await runInitInteractive({
      startDir: tmpRoot,
      promptFn,
    });
    expect(path.isAbsolute(answers.projectDir)).toBe(true);
    expect(answers.projectDir).toBe(path.join(tmpRoot, "my-app"));
  });
});

describe("sampleSmokeScenarioYaml", () => {
  it("produces a YAML with id / name / steps", () => {
    const yaml = sampleSmokeScenarioYaml("https://example.com");
    expect(yaml).toContain("id: homepage-smoke");
    expect(yaml).toContain("name: Homepage smoke audit");
    expect(yaml).toContain("steps:");
    expect(yaml).toContain("type: visit");
    expect(yaml).toContain("url: https://example.com");
    expect(yaml).toContain("type: assert_a11y");
    expect(yaml).toContain("standard: wcag22aa");
    expect(yaml).toContain("type: see");
  });

  it("interpolates the supplied baseUrl into the visit step", () => {
    const yaml = sampleSmokeScenarioYaml("https://acme.example/");
    expect(yaml).toContain("url: https://acme.example/");
  });
});

describe("writeSampleScenario", () => {
  it("creates scenarios/homepage-smoke.yaml with the supplied baseUrl", () => {
    const result = writeSampleScenario(tmpRoot, "https://example.com");
    expect(result).toBe(path.join(tmpRoot, "scenarios", "homepage-smoke.yaml"));
    const written = fs.readFileSync(result!, "utf8");
    expect(written).toContain("url: https://example.com");
  });

  it("creates the scenarios/ directory if it doesn't exist", () => {
    const scenariosDir = path.join(tmpRoot, "scenarios");
    expect(fs.existsSync(scenariosDir)).toBe(false);
    writeSampleScenario(tmpRoot, "https://example.com");
    expect(fs.existsSync(scenariosDir)).toBe(true);
  });

  it("returns null when the file already exists (idempotent)", () => {
    const filePath = path.join(tmpRoot, "scenarios", "homepage-smoke.yaml");
    fs.mkdirSync(path.join(tmpRoot, "scenarios"), { recursive: true });
    fs.writeFileSync(filePath, "existing content");
    const result = writeSampleScenario(tmpRoot, "https://example.com");
    expect(result).toBeNull();
    // Existing content unchanged
    expect(fs.readFileSync(filePath, "utf8")).toBe("existing content");
  });
});

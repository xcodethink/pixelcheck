import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  generateMinRepro,
  writeMinRepro,
  type MinReproResult,
} from "../src/core/min-repro.js";
import type { Scenario, StepResult, Issue } from "../src/core/types.js";

function makeScenario(overrides?: Partial<Scenario>): Scenario {
  return {
    name: "test-scenario",
    start_url: "https://example.com",
    steps: [
      { type: "visit", url: "https://example.com" },
      { type: "act", instruction: "click login" },
      { type: "screenshot" },
      { type: "assert_a11y" },
      { type: "act", instruction: "fill form" },
    ],
    ...overrides,
  } as unknown as Scenario;
}

function makeStepResults(statuses: Array<"pass" | "fail" | "warn" | "skip">): StepResult[] {
  return statuses.map((status, i) => ({
    status,
    step_index: i,
    issues: status === "fail" ? [{ id: `issue-${i}`, severity: "high", dimension: "functionality", title: `Step ${i} failed`, description: "test" } as unknown as Issue] : [],
  })) as unknown as StepResult[];
}

describe("min-repro", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  describe("generateMinRepro", () => {
    it("includes steps up to first failure", () => {
      const scenario = makeScenario();
      const results = makeStepResults(["pass", "pass", "fail", "pass", "pass"]);
      const repro = generateMinRepro(scenario, results);

      expect(repro.scenario.steps).toHaveLength(3); // steps 0, 1, 2
      expect(repro.stepsRemoved).toBe(2);
      expect(repro.originalStepCount).toBe(5);
    });

    it("returns empty issues (issues live at ScenarioRunResult level)", () => {
      const scenario = makeScenario();
      const results = makeStepResults(["pass", "fail", "pass", "pass", "pass"]);
      const repro = generateMinRepro(scenario, results);

      expect(repro.issues).toEqual([]);
    });

    it("handles failure on first step", () => {
      const scenario = makeScenario();
      const results = makeStepResults(["fail", "pass", "pass", "pass", "pass"]);
      const repro = generateMinRepro(scenario, results);

      expect(repro.scenario.steps).toHaveLength(1);
      expect(repro.stepsRemoved).toBe(4);
    });

    it("handles failure on last step", () => {
      const scenario = makeScenario();
      const results = makeStepResults(["pass", "pass", "pass", "pass", "fail"]);
      const repro = generateMinRepro(scenario, results);

      expect(repro.scenario.steps).toHaveLength(5);
      expect(repro.stepsRemoved).toBe(0);
    });

    it("handles no failure (returns full scenario)", () => {
      const scenario = makeScenario();
      const results = makeStepResults(["pass", "pass", "pass", "pass", "pass"]);
      const repro = generateMinRepro(scenario, results);

      expect(repro.scenario.steps).toHaveLength(5);
      expect(repro.stepsRemoved).toBe(0);
      expect(repro.issues).toEqual([]);
    });

    it("handles error status as failure", () => {
      const scenario = makeScenario();
      const results = makeStepResults(["pass", "fail", "pass", "pass", "pass"]);
      const repro = generateMinRepro(scenario, results);

      expect(repro.scenario.steps).toHaveLength(2);
    });

    it("generates valid YAML output", () => {
      const scenario = makeScenario();
      const results = makeStepResults(["pass", "fail", "pass", "pass", "pass"]);
      const repro = generateMinRepro(scenario, results);

      expect(repro.yaml).toContain("name:");
      expect(repro.yaml).toContain("description:");
      expect(repro.yaml).toContain("steps:");
      expect(repro.yaml).toContain("repro-test-scenario");
    });

    it("sets descriptive name and description", () => {
      const scenario = makeScenario();
      const results = makeStepResults(["pass", "pass", "fail", "pass", "pass"]);
      const repro = generateMinRepro(scenario, results);

      expect(repro.scenario.name).toBe("repro-test-scenario");
      expect(repro.scenario.description).toContain("step 3");
    });

    it("preserves step details", () => {
      const scenario = makeScenario();
      const results = makeStepResults(["pass", "fail", "pass", "pass", "pass"]);
      const repro = generateMinRepro(scenario, results);

      expect(repro.scenario.steps[0].type).toBe("visit");
      expect(repro.scenario.steps[0].url).toBe("https://example.com");
      expect(repro.scenario.steps[1].type).toBe("act");
      expect(repro.scenario.steps[1].instruction).toBe("click login");
    });

    it("handles single-step scenario", () => {
      const scenario = makeScenario({
        steps: [{ type: "visit", url: "https://example.com" }] as any,
      });
      const results = makeStepResults(["fail"]);
      const repro = generateMinRepro(scenario, results);

      expect(repro.scenario.steps).toHaveLength(1);
      expect(repro.stepsRemoved).toBe(0);
    });

    it("handles empty scenario", () => {
      const scenario = makeScenario({ steps: [] as any });
      const results: StepResult[] = [];
      const repro = generateMinRepro(scenario, results);

      expect(repro.scenario.steps).toHaveLength(0);
      expect(repro.stepsRemoved).toBe(0);
    });
  });

  describe("writeMinRepro", () => {
    it("writes YAML file to disk", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "min-repro-test-"));
      const outputPath = path.join(tmpDir, "repro.yaml");
      const repro = generateMinRepro(
        makeScenario(),
        makeStepResults(["pass", "fail", "pass", "pass", "pass"]),
      );

      writeMinRepro(outputPath, repro);

      expect(fs.existsSync(outputPath)).toBe(true);
      const content = fs.readFileSync(outputPath, "utf-8");
      expect(content).toContain("repro-test-scenario");
      expect(content).toContain("steps:");
    });

    it("creates nested directories", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "min-repro-test-"));
      const outputPath = path.join(tmpDir, "a", "b", "repro.yaml");
      const repro = generateMinRepro(
        makeScenario(),
        makeStepResults(["fail"]),
      );

      writeMinRepro(outputPath, repro);
      expect(fs.existsSync(outputPath)).toBe(true);
    });
  });
});

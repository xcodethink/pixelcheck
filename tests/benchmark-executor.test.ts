import { describe, it, expect } from "vitest";
import { taskToScenario } from "../src/benchmark/executor.js";
import { BenchmarkTaskSchema, type BenchmarkTask } from "../src/benchmark/task.js";

function task(overrides: Partial<BenchmarkTask> = {}): BenchmarkTask {
  return BenchmarkTaskSchema.parse({
    task_id: "0001",
    intent: "Find the cheapest laptop and add it to the cart",
    start_url: "https://shop.example.com",
    eval: { eval_types: ["string_match"], reference_answers: { must_include: ["cart"] } },
    ...overrides,
  });
}

describe("benchmark executor — taskToScenario (G3)", () => {
  it("produces a valid autonomous scenario carrying the task intent", () => {
    const s = taskToScenario(task());
    expect(s.id).toBe("bench_0001");
    expect(s.mode).toBe("autonomous");
    expect(s.goal).toContain("cheapest laptop");
    expect(s.start_url).toBe("https://shop.example.com");
    expect(s.success_criteria.length).toBe(1);
  });

  it("defaults max_actions to 30 and applies to all personas when unset", () => {
    const s = taskToScenario(task());
    expect(s.agent_config?.max_actions).toBe(30);
    expect(s.applies_to.personas).toEqual(["*"]);
  });

  it("honors an explicit max_actions and persona_id", () => {
    const s = taskToScenario(task({ max_actions: 12, persona_id: "power-user" }));
    expect(s.agent_config?.max_actions).toBe(12);
    expect(s.applies_to.personas).toEqual(["power-user"]);
  });

  describe("deriveCriterion branches", () => {
    it("url_match → interaction criterion expecting a URL change", () => {
      const s = taskToScenario(
        task({ eval: { eval_types: ["url_match"], reference_url: "https://shop.example.com/checkout" } }),
      );
      const c = s.success_criteria[0]!;
      expect(c.id).toBe("reached_target_url");
      expect(c.verification).toBe("interaction");
      expect(c.expected).toMatchObject({ url_must_change: true });
      expect(c.description).toContain("checkout");
    });

    it("string_match → extract criterion with a must_include pattern", () => {
      const s = taskToScenario(
        task({ eval: { eval_types: ["string_match"], reference_answers: { must_include: ["Order #", "confirmed"] } } }),
      );
      const c = s.success_criteria[0]!;
      expect(c.id).toBe("answer_contains");
      expect(c.verification).toBe("extract");
      expect(c.expected_pattern).toBe("Order #|confirmed");
      expect(c.extract_instruction).toBe(task().intent);
    });

    it("falls back to a visual intent_achieved criterion otherwise", () => {
      const s = taskToScenario(task({ eval: { eval_types: ["program_html"] } }));
      const c = s.success_criteria[0]!;
      expect(c.id).toBe("intent_achieved");
      expect(c.verification).toBe("visual");
    });

    it("url_match without reference_url falls through to the visual default", () => {
      const s = taskToScenario(task({ eval: { eval_types: ["url_match"] } }));
      expect(s.success_criteria[0]!.id).toBe("intent_achieved");
    });
  });
});

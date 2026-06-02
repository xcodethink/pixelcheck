/**
 * Tests for the benchmark runner's scheduling + report summarization logic.
 * Executes tasks with an injected mock `execute` to stay hermetic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import { runBenchmark, summarize, renderMarkdown, type TaskExecution } from "../../src/benchmark/runner.js";
import type { BenchmarkTask } from "../../src/benchmark/task.js";
import type { Persona, ProjectConfig } from "../../src/core/types.js";

function mkPersona(): Persona {
  return {
    id: "us-desktop",
    display_name: "US Desktop",
    country: "US",
    language: "en",
    locale: "en-US",
    timezone: "America/New_York",
    device_class: "desktop",
    payment_tier: "free",
    mental_model: "",
    critical_concerns: [],
  };
}

function mkConfig(): ProjectConfig {
  return {
    project_name: "test",
    base_url: "https://x.example",
    default_concurrency: 1,
    default_timeout_ms: 30_000,
    models: {
      default: "sonnet",
      critic: "sonnet",
      computer_use: "opus",
      planner: "opus",
      navigator: "sonnet",
      replan: "sonnet",
      navigator_economy: "haiku",
    },
    cost_mode: "balanced",
    budget_usd: 1.0,
    redact_patterns: [],
  };
}

function mkTask(overrides: Partial<BenchmarkTask> = {}): BenchmarkTask {
  return {
    task_id: "t1",
    intent: "do a thing",
    start_url: "https://x",
    sites: [],
    tags: [],
    eval: {
      eval_types: ["string_match"],
      reference_answers: { must_include: ["yes"] },
      reference_url_match: "exact",
    },
    ...overrides,
  };
}

// A fake page — the evaluator only calls it for program_html checks.
class FakePage extends EventEmitter {
  url = (): string => "https://x/";
  goto = vi.fn();
  locator = vi.fn(() => ({ count: async () => 0, first: () => ({ textContent: async () => "" }) }));
}

function mkExec(result: Partial<TaskExecution> = {}): TaskExecution {
  return {
    final_url: "https://x/done",
    answer: "yes that's done",
    getPage: async () => new FakePage() as unknown as import("playwright").Page,
    cleanup: vi.fn(async () => {}),
    cost_usd: 0.01,
    duration_ms: 500,
    convergence_reason: "goal_met",
    ...result,
  };
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("runBenchmark", () => {
  it("records pass for matching task and writes output files", async () => {
    const task = mkTask();
    const report = await runBenchmark({
      tasks: [task],
      config: mkConfig(),
      personas: new Map([["us-desktop", mkPersona()]]),
      outputDir: tmp,
      tag: "unit-1",
      execute: async () => mkExec({ answer: "yes it worked" }),
    });
    expect(report.passed).toBe(1);
    expect(report.pass_at_1).toBe(1);
    expect(report.total_tasks).toBe(1);
    expect(fs.existsSync(path.join(tmp, "benchmark.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "benchmark.md"))).toBe(true);
  });

  it("records fail when string_match not satisfied", async () => {
    const task = mkTask({ eval: { eval_types: ["string_match"], reference_answers: { must_include: ["nope"] }, reference_url_match: "exact" } });
    const report = await runBenchmark({
      tasks: [task],
      config: mkConfig(),
      personas: new Map([["us-desktop", mkPersona()]]),
      outputDir: tmp,
      tag: "unit-2",
      execute: async () => mkExec({ answer: "yes that's done" }),
    });
    expect(report.passed).toBe(0);
    expect(report.pass_at_1).toBe(0);
  });

  it("honors per-task budget and stops after total budget exceeded", async () => {
    const tasks = [mkTask({ task_id: "1" }), mkTask({ task_id: "2" }), mkTask({ task_id: "3" })];
    let callCount = 0;
    const report = await runBenchmark({
      tasks,
      config: mkConfig(),
      personas: new Map([["us-desktop", mkPersona()]]),
      outputDir: tmp,
      tag: "budget",
      totalBudget: 0.015, // after 1 task at $0.01, budget remaining is 0.005 — third task should be skipped
      execute: async () => {
        callCount++;
        return mkExec({ cost_usd: 0.01, answer: "yes ok" });
      },
    });
    // 2 tasks executed; 3rd skipped with run_budget_exceeded
    expect(callCount).toBe(2);
    expect(report.tasks[2]!.convergence_reason).toBe("run_budget_exceeded");
  });

  it("handles a crashing execute gracefully", async () => {
    const task = mkTask();
    const report = await runBenchmark({
      tasks: [task],
      config: mkConfig(),
      personas: new Map([["us-desktop", mkPersona()]]),
      outputDir: tmp,
      tag: "crash",
      execute: async () => {
        throw new Error("simulated browser crash");
      },
    });
    expect(report.tasks[0]!.passed).toBe(false);
    expect(report.tasks[0]!.error).toMatch(/simulated browser crash/);
  });

  it("returns missing-persona error for unknown persona_id", async () => {
    const task = mkTask({ persona_id: "nonexistent" });
    const report = await runBenchmark({
      tasks: [task],
      config: mkConfig(),
      personas: new Map([["us-desktop", mkPersona()]]),
      outputDir: tmp,
      tag: "missing-persona",
      execute: async () => mkExec(),
    });
    expect(report.tasks[0]!.passed).toBe(false);
    expect(report.tasks[0]!.error).toMatch(/persona/);
  });
});

describe("summarize", () => {
  it("computes by_difficulty and by_tag breakdowns", () => {
    const tasks = [
      { task_id: "1", intent: "", tags: ["signup"], difficulty: "easy" as const, passed: true, score: 1, eval_detail: { passed: true, per_check: [], score: 1 }, cost_usd: 0.01, duration_ms: 100, final_url: "", convergence_reason: "goal_met" },
      { task_id: "2", intent: "", tags: ["signup"], difficulty: "easy" as const, passed: false, score: 0, eval_detail: { passed: false, per_check: [], score: 0 }, cost_usd: 0.01, duration_ms: 150, final_url: "", convergence_reason: "goal_met" },
      { task_id: "3", intent: "", tags: ["checkout"], difficulty: "hard" as const, passed: true, score: 1, eval_detail: { passed: true, per_check: [], score: 1 }, cost_usd: 0.02, duration_ms: 300, final_url: "", convergence_reason: "goal_met" },
    ];
    const report = summarize(tasks, "agg-test", mkConfig(), new Date(), new Date());
    expect(report.by_difficulty.easy.pass_rate).toBe(0.5);
    expect(report.by_difficulty.hard.pass_rate).toBe(1);
    expect(report.by_tag.signup.pass_rate).toBe(0.5);
    expect(report.by_tag.checkout.pass_rate).toBe(1);
    expect(report.pass_at_1).toBeCloseTo(2 / 3);
  });

  it("handles empty task list", () => {
    const report = summarize([], "empty", mkConfig(), new Date(), new Date());
    expect(report.pass_at_1).toBe(0);
    expect(report.total_tasks).toBe(0);
    expect(report.avg_cost_usd).toBe(0);
  });
});

describe("renderMarkdown", () => {
  it("produces a well-formed markdown report", () => {
    const report = summarize(
      [{ task_id: "1", intent: "do it", tags: [], passed: true, score: 1, eval_detail: { passed: true, per_check: [], score: 1 }, cost_usd: 0.01, duration_ms: 100, final_url: "", convergence_reason: "goal_met" }],
      "fmt-test",
      mkConfig(),
      new Date(),
      new Date(),
    );
    const md = renderMarkdown(report);
    expect(md).toMatch(/# Benchmark: fmt-test/);
    expect(md).toMatch(/pass@1.*100/);
    expect(md).toMatch(/\| 1 \| do it \| \[OK\]/);
  });
});

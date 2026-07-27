/**
 * Benchmark Runner — executes BenchmarkTasks through the autonomous agent loop
 * and produces WebArena-comparable metrics (pass@1, avg cost, avg duration).
 *
 * Each task is converted to a Scenario with mode='autonomous' on the fly,
 * reusing the full 5-layer reliability stack + signal-based convergence.
 *
 * Output: BenchmarkReport (machine-readable) + summary text.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { BenchmarkTask } from "./task.js";
import { evaluateTask, type TaskEvalResult } from "./evaluator.js";
import type { Persona, ProjectConfig } from "../core/types.js";
import { RESULT_SCHEMA_VERSION } from "../core/result-schema.js";

export interface BenchmarkRunOpts {
  tasks: BenchmarkTask[];
  config: ProjectConfig;
  personas: Map<string, Persona>;
  /** Per-task budget (USD) cap. Default: 0.5. */
  perTaskBudget?: number;
  /** Overall run budget (USD). Default: no cap. */
  totalBudget?: number;
  /** Concurrency. Default: 1 (strict) — benchmarks should be deterministic. */
  concurrency?: number;
  /** Output directory for per-task artifacts + summary JSON. */
  outputDir: string;
  /** Label printed in the header (e.g., 'balanced-mode-2026-04-16'). */
  tag: string;
  /** Called once per task for telemetry */
  onTaskComplete?: (entry: BenchmarkTaskResult) => void;
  /**
   * Task execution hook — injected to keep this module testable.
   * Default implementation calls the autonomous agent loop.
   */
  execute: (task: BenchmarkTask, config: ProjectConfig, persona: Persona) => Promise<TaskExecution>;
}

export interface TaskExecution {
  final_url: string;
  answer?: string;
  /** Page handle for post-hoc program_html checks */
  getPage: () => Promise<import("playwright").Page>;
  /** Cleanup (close browser, etc.) — always called, even on failure */
  cleanup: () => Promise<void>;
  /** Actual USD cost spent on this task */
  cost_usd: number;
  /** Wall-clock duration */
  duration_ms: number;
  /** Convergence reason emitted by the agent loop */
  convergence_reason: string;
}

export interface BenchmarkTaskResult {
  /** Result schema version (SemVer). Stamped by the runner. */
  schema_version?: string;
  task_id: string;
  intent: string;
  difficulty?: "easy" | "medium" | "hard";
  tags: string[];
  passed: boolean;
  score: number;
  eval_detail: TaskEvalResult;
  cost_usd: number;
  duration_ms: number;
  final_url: string;
  convergence_reason: string;
  error?: string;
}

export interface BenchmarkReport {
  /** Result schema version (SemVer). Stamped by `summarize`. */
  schema_version?: string;
  tag: string;
  started_at: string;
  finished_at: string;
  total_tasks: number;
  passed: number;
  pass_at_1: number;
  /** Breakdown by difficulty */
  by_difficulty: Record<string, { total: number; passed: number; pass_rate: number }>;
  by_tag: Record<string, { total: number; passed: number; pass_rate: number }>;
  total_cost_usd: number;
  avg_cost_usd: number;
  avg_duration_ms: number;
  p50_duration_ms: number;
  p95_duration_ms: number;
  /** Per-task results */
  tasks: BenchmarkTaskResult[];
  config_summary: {
    cost_mode: string;
    planner: string;
    navigator: string;
    navigator_economy: string;
  };
}

// ─────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────

export async function runBenchmark(opts: BenchmarkRunOpts): Promise<BenchmarkReport> {
  const startedAt = new Date();
  const taskResults: BenchmarkTaskResult[] = [];
  let runningCost = 0;
  const totalBudget = opts.totalBudget ?? Infinity;
  const perTaskBudget = opts.perTaskBudget ?? 0.5;

  fs.mkdirSync(opts.outputDir, { recursive: true });

  for (const task of opts.tasks) {
    if (runningCost >= totalBudget) {
      taskResults.push({
        schema_version: RESULT_SCHEMA_VERSION,
        task_id: task.task_id,
        intent: task.intent,
        difficulty: task.difficulty,
        tags: task.tags,
        passed: false,
        score: 0,
        eval_detail: { passed: false, per_check: [], score: 0 },
        cost_usd: 0,
        duration_ms: 0,
        final_url: "",
        convergence_reason: "run_budget_exceeded",
      });
      continue;
    }

    const personaId = task.persona_id ?? defaultPersonaId(opts.personas);
    const persona = opts.personas.get(personaId);
    if (!persona) {
      taskResults.push(makeErrorResult(task, `persona "${personaId}" not found`));
      continue;
    }

    // Scope the per-task config
    const taskConfig: ProjectConfig = {
      ...opts.config,
      budget_usd: Math.min(perTaskBudget, totalBudget - runningCost),
    };

    const started = Date.now();
    let exec: TaskExecution | undefined;
    try {
      exec = await opts.execute(task, taskConfig, persona);
      const page = await exec.getPage();
      const evalResult = await evaluateTask(task, {
        final_url: exec.final_url,
        answer: exec.answer,
        page,
      });
      const entry: BenchmarkTaskResult = {
        schema_version: RESULT_SCHEMA_VERSION,
        task_id: task.task_id,
        intent: task.intent,
        difficulty: task.difficulty,
        tags: task.tags,
        passed: evalResult.passed,
        score: evalResult.score,
        eval_detail: evalResult,
        cost_usd: exec.cost_usd,
        duration_ms: exec.duration_ms,
        final_url: exec.final_url,
        convergence_reason: exec.convergence_reason,
      };
      taskResults.push(entry);
      runningCost += exec.cost_usd;
      opts.onTaskComplete?.(entry);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const entry: BenchmarkTaskResult = {
        ...makeErrorResult(task, errMsg),
        duration_ms: Date.now() - started,
      };
      taskResults.push(entry);
      opts.onTaskComplete?.(entry);
    } finally {
      if (exec) {
        await exec.cleanup().catch(() => {});
      }
    }
  }

  const finishedAt = new Date();
  const report = summarize(taskResults, opts.tag, opts.config, startedAt, finishedAt);
  fs.writeFileSync(
    path.join(opts.outputDir, "benchmark.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(opts.outputDir, "benchmark.md"),
    renderMarkdown(report),
    "utf8",
  );
  return report;
}

// ─────────────────────────────────────────────────────────────
// Summary / reporting (pure)
// ─────────────────────────────────────────────────────────────

export function summarize(
  tasks: BenchmarkTaskResult[],
  tag: string,
  config: ProjectConfig,
  startedAt: Date,
  finishedAt: Date,
): BenchmarkReport {
  const passed = tasks.filter((t) => t.passed).length;
  const total = tasks.length;
  const totalCost = tasks.reduce((s, t) => s + t.cost_usd, 0);
  const durations = tasks.map((t) => t.duration_ms).sort((a, b) => a - b);

  const byDifficulty: BenchmarkReport["by_difficulty"] = {};
  for (const diff of ["easy", "medium", "hard"] as const) {
    const scoped = tasks.filter((t) => t.difficulty === diff);
    if (scoped.length === 0) continue;
    const sp = scoped.filter((t) => t.passed).length;
    byDifficulty[diff] = {
      total: scoped.length,
      passed: sp,
      pass_rate: sp / scoped.length,
    };
  }

  const byTag: BenchmarkReport["by_tag"] = {};
  const allTags = new Set<string>();
  for (const t of tasks) for (const tg of t.tags) allTags.add(tg);
  for (const tag of allTags) {
    const scoped = tasks.filter((t) => t.tags.includes(tag));
    const sp = scoped.filter((t) => t.passed).length;
    byTag[tag] = { total: scoped.length, passed: sp, pass_rate: sp / scoped.length };
  }

  return {
    schema_version: RESULT_SCHEMA_VERSION,
    tag,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    total_tasks: total,
    passed,
    pass_at_1: total === 0 ? 0 : passed / total,
    by_difficulty: byDifficulty,
    by_tag: byTag,
    total_cost_usd: round(totalCost, 4),
    avg_cost_usd: total === 0 ? 0 : round(totalCost / total, 4),
    avg_duration_ms: total === 0 ? 0 : Math.round(durations.reduce((s, d) => s + d, 0) / total),
    p50_duration_ms: pct(durations, 0.5),
    p95_duration_ms: pct(durations, 0.95),
    tasks,
    config_summary: {
      cost_mode: config.cost_mode ?? "balanced",
      planner: config.models.planner,
      navigator: config.models.navigator,
      navigator_economy: config.models.navigator_economy ?? "claude-haiku-4-5-20251001",
    },
  };
}

export function renderMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`# Benchmark: ${report.tag}`);
  lines.push("");
  lines.push(`- Started: ${report.started_at}`);
  lines.push(`- Finished: ${report.finished_at}`);
  lines.push(`- Cost mode: **${report.config_summary.cost_mode}**`);
  lines.push(`- Models: planner=${report.config_summary.planner}, navigator=${report.config_summary.navigator}, economy=${report.config_summary.navigator_economy}`);
  lines.push("");
  lines.push(`## Summary`);
  lines.push(`| metric | value |`);
  lines.push(`|---|---|`);
  lines.push(`| pass@1 | **${(report.pass_at_1 * 100).toFixed(1)}%** (${report.passed}/${report.total_tasks}) |`);
  lines.push(`| total cost | $${report.total_cost_usd.toFixed(2)} |`);
  lines.push(`| avg cost/task | $${report.avg_cost_usd.toFixed(3)} |`);
  lines.push(`| p50 duration | ${report.p50_duration_ms}ms |`);
  lines.push(`| p95 duration | ${report.p95_duration_ms}ms |`);
  lines.push("");

  if (Object.keys(report.by_difficulty).length > 0) {
    lines.push(`## By difficulty`);
    lines.push(`| difficulty | pass@1 |`);
    lines.push(`|---|---|`);
    for (const [k, v] of Object.entries(report.by_difficulty)) {
      lines.push(`| ${k} | ${(v.pass_rate * 100).toFixed(1)}% (${v.passed}/${v.total}) |`);
    }
    lines.push("");
  }

  lines.push(`## Per-task`);
  lines.push(`| id | intent | passed | cost | duration |`);
  lines.push(`|---|---|---|---|---|`);
  for (const t of report.tasks) {
    const intent = t.intent.length > 60 ? t.intent.slice(0, 57) + "..." : t.intent;
    lines.push(`| ${t.task_id} | ${intent} | ${t.passed ? "[OK]" : "[FAIL]"} | $${t.cost_usd.toFixed(3)} | ${t.duration_ms}ms |`);
  }
  return lines.join("\n") + "\n";
}

function makeErrorResult(task: BenchmarkTask, err: string): BenchmarkTaskResult {
  return {
    schema_version: RESULT_SCHEMA_VERSION,
    task_id: task.task_id,
    intent: task.intent,
    difficulty: task.difficulty,
    tags: task.tags,
    passed: false,
    score: 0,
    eval_detail: { passed: false, per_check: [], score: 0 },
    cost_usd: 0,
    duration_ms: 0,
    final_url: "",
    convergence_reason: "error",
    error: err,
  };
}

function defaultPersonaId(personas: Map<string, Persona>): string {
  // Prefer a US desktop persona if present
  for (const [id, p] of personas) {
    if (p.country === "US" && p.device_class === "desktop") return id;
  }
  // Otherwise first available
  const first = personas.keys().next();
  if (first.done) throw new Error("no personas available for benchmark");
  return first.value;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx] ?? 0;
}

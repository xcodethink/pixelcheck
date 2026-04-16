/**
 * Benchmark task loader — reads a directory or JSONL file of BenchmarkTask specs.
 *
 * Accepted inputs:
 *   - A directory: each *.json file is a single task (WebArena layout)
 *   - A single .json file: array of tasks OR single task
 *   - A .jsonl file: one task per line
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { BenchmarkTaskSchema, type BenchmarkTask } from "./task.js";

export interface LoadOpts {
  /** Filter by difficulty tags */
  difficulties?: Array<"easy" | "medium" | "hard">;
  /** Filter by tag (any match) */
  tags?: string[];
  /** Cap on number of tasks returned */
  limit?: number;
}

export function loadTasks(input: string, opts: LoadOpts = {}): BenchmarkTask[] {
  const stat = fs.statSync(input);
  let raw: unknown[] = [];

  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(input).sort()) {
      if (!name.endsWith(".json") && !name.endsWith(".jsonl")) continue;
      raw.push(...readJsonFile(path.join(input, name)));
    }
  } else {
    raw = readJsonFile(input);
  }

  const tasks: BenchmarkTask[] = [];
  for (const [i, entry] of raw.entries()) {
    const result = BenchmarkTaskSchema.safeParse(entry);
    if (!result.success) {
      throw new Error(
        `benchmark task #${i} failed schema validation:\n  ${result.error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join("\n  ")}`,
      );
    }
    tasks.push(result.data);
  }

  return filterAndLimit(tasks, opts);
}

function readJsonFile(p: string): unknown[] {
  const content = fs.readFileSync(p, "utf8");
  if (p.endsWith(".jsonl")) {
    return content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }
  const parsed = JSON.parse(content);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function filterAndLimit(tasks: BenchmarkTask[], opts: LoadOpts): BenchmarkTask[] {
  let out = tasks;
  if (opts.difficulties && opts.difficulties.length > 0) {
    out = out.filter((t) => t.difficulty && opts.difficulties!.includes(t.difficulty));
  }
  if (opts.tags && opts.tags.length > 0) {
    out = out.filter((t) => opts.tags!.some((tag) => t.tags.includes(tag)));
  }
  if (opts.limit !== undefined && opts.limit > 0) {
    out = out.slice(0, opts.limit);
  }
  return out;
}

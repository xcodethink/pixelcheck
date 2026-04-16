/**
 * Tests for the benchmark task loader.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadTasks } from "../../src/benchmark/loader.js";

let tmp: string;

function makeTask(overrides: Record<string, unknown> = {}): unknown {
  return {
    task_id: "t1",
    intent: "do the thing",
    start_url: "https://x",
    eval: { eval_types: ["string_match"], reference_answers: { must_include: ["ok"] } },
    difficulty: "easy",
    tags: ["signup"],
    ...overrides,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-loader-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("loadTasks", () => {
  it("loads a single-task .json file", () => {
    const p = path.join(tmp, "a.json");
    fs.writeFileSync(p, JSON.stringify(makeTask()));
    const tasks = loadTasks(p);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_id).toBe("t1");
  });

  it("loads an array-of-tasks .json file", () => {
    const p = path.join(tmp, "multi.json");
    fs.writeFileSync(p, JSON.stringify([makeTask(), makeTask({ task_id: "t2" })]));
    expect(loadTasks(p)).toHaveLength(2);
  });

  it("loads a .jsonl file", () => {
    const p = path.join(tmp, "tasks.jsonl");
    fs.writeFileSync(
      p,
      [JSON.stringify(makeTask({ task_id: "a" })), JSON.stringify(makeTask({ task_id: "b" }))].join("\n"),
    );
    const tasks = loadTasks(p);
    expect(tasks.map((t) => t.task_id)).toEqual(["a", "b"]);
  });

  it("loads all .json files in a directory", () => {
    fs.writeFileSync(path.join(tmp, "01.json"), JSON.stringify(makeTask({ task_id: "1" })));
    fs.writeFileSync(path.join(tmp, "02.json"), JSON.stringify(makeTask({ task_id: "2" })));
    fs.writeFileSync(path.join(tmp, "readme.txt"), "ignore me");
    const tasks = loadTasks(tmp);
    expect(tasks.map((t) => t.task_id).sort()).toEqual(["1", "2"]);
  });

  it("filters by difficulty", () => {
    fs.writeFileSync(path.join(tmp, "e.json"), JSON.stringify(makeTask({ task_id: "e", difficulty: "easy" })));
    fs.writeFileSync(path.join(tmp, "h.json"), JSON.stringify(makeTask({ task_id: "h", difficulty: "hard" })));
    expect(loadTasks(tmp, { difficulties: ["easy"] }).map((t) => t.task_id)).toEqual(["e"]);
  });

  it("filters by tags", () => {
    fs.writeFileSync(path.join(tmp, "a.json"), JSON.stringify(makeTask({ task_id: "a", tags: ["signup"] })));
    fs.writeFileSync(path.join(tmp, "b.json"), JSON.stringify(makeTask({ task_id: "b", tags: ["checkout"] })));
    expect(loadTasks(tmp, { tags: ["signup"] }).map((t) => t.task_id)).toEqual(["a"]);
  });

  it("applies limit", () => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tmp, `t${i}.json`), JSON.stringify(makeTask({ task_id: `t${i}` })));
    }
    expect(loadTasks(tmp, { limit: 3 })).toHaveLength(3);
  });

  it("throws on schema violations with useful error", () => {
    fs.writeFileSync(path.join(tmp, "bad.json"), JSON.stringify({ intent: "missing task_id" }));
    expect(() => loadTasks(tmp)).toThrow(/task_id/);
  });

  it("coerces numeric task_id to string", () => {
    fs.writeFileSync(path.join(tmp, "n.json"), JSON.stringify(makeTask({ task_id: 42 })));
    const tasks = loadTasks(tmp);
    expect(tasks[0].task_id).toBe("42");
    expect(typeof tasks[0].task_id).toBe("string");
  });
});

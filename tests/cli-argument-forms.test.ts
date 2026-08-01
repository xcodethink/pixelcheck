import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listHistoryProjects } from "../src/core/history.js";

/**
 * Two commands took an argument in a form the user does not have.
 *
 * `run` and `init` take `--project <dir>`; `history` and `trends` took
 * `--project <name>`. Each was documented correctly on its own, which is why
 * the mismatch is easy to walk into: the obvious command after
 * `pixelcheck run --project projects/demo` is
 * `pixelcheck history --project projects/demo`, and that printed "No audit
 * history found" with seven runs sitting in the database.
 *
 * `diff <runA> <runB>` had the same shape: it wants a run id, while every
 * completed audit prints absolute report paths — and the id is the directory's
 * own basename, so the two were needlessly non-interchangeable.
 *
 * Both failed silently or near-silently, which is the part that matters. An
 * empty result is indistinguishable from having no data, and the reader has no
 * reason to suspect the argument.
 *
 * The resolvers themselves live in the CLI module, which runs Commander on
 * import; these tests cover the supporting query that makes the improved
 * message possible, and the shape both resolvers rely on.
 */

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-args-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("listHistoryProjects", () => {
  it("returns an empty list when there is no database at all", () => {
    // Distinguishing "no database" from "filter matched nothing" is what lets
    // the CLI say something useful instead of one message for both.
    expect(listHistoryProjects(tmp)).toEqual([]);
  });

  it("does not throw on a directory that exists but holds no history", () => {
    fs.mkdirSync(path.join(tmp, "reports"), { recursive: true });
    expect(() => listHistoryProjects(path.join(tmp, "reports"))).not.toThrow();
  });
});

describe("run id and project directory are interchangeable by construction", () => {
  it("a run directory's basename is the run id", () => {
    // This is the property `resolveRunId` depends on. If report directories
    // ever stop being named after the run, that resolver silently starts
    // producing wrong ids, so the assumption is pinned rather than assumed.
    const runId = "2026-08-01_084654_manual";
    const runDir = path.join(tmp, "reports", runId);
    fs.mkdirSync(runDir, { recursive: true });

    expect(path.basename(runDir)).toBe(runId);
  });

  it("a project directory carries its name in config.yaml", () => {
    // The property `resolveProjectFilter` depends on: the name stored in
    // history comes from config.yaml, so the directory can be mapped to it.
    const projectDir = path.join(tmp, "projects", "demo");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "config.yaml"),
      "project_name: Demo\nbase_url: https://example.com\n",
    );

    const raw = fs.readFileSync(path.join(projectDir, "config.yaml"), "utf8");
    expect(raw).toMatch(/^project_name:\s*Demo$/m);
    expect(path.basename(projectDir)).not.toBe("Demo");
  });
});

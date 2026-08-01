import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeJsonReport, writeMarkdownSummary } from "../src/core/reporter.js";
import { writeSpaReport } from "../src/core/reporter-spa.js";
import type { AuditRun } from "../src/core/types.js";

/**
 * Persisting the reports must not throw away the audit.
 *
 * Measured on a three-unit matrix pointed at a 2 MB volume: fifty seconds of
 * browser launches and LLM calls, $0.067 of real spend, and the process died
 * with a bare `[FATAL] ENOSPC: no space left on device, open '…/audit.json'`.
 * No counts, no cost, no indication that the audit itself had finished — only
 * the write failed.
 *
 * The PDF writer had worked this way all along, with a comment saying the
 * audit remains complete when it fails. The other five did not.
 *
 * These tests cover the property the CLI depends on: a writer that cannot
 * write throws rather than returning a bogus path, and does so per file so the
 * caller can report which ones were lost. The end-to-end behaviour — verdict
 * and cost printed, failures listed after them, non-zero exit — is exercised
 * by running the binary against a full volume, which is not something a unit
 * test can stage.
 */

let tmp: string;

/**
 * A directory path that cannot be created on any platform, because its parent
 * is a regular file. Stands in for a full disk: both surface as a failed
 * open/mkdir, and a writer that swallowed either would hand the CLI a path to
 * a file that does not exist — worse than the crash it replaces.
 */
function unwritableDir(): string {
  const blocker = path.join(tmp, `blocker-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(blocker, "not a directory");
  return path.join(blocker, "reports");
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "report-write-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sampleAudit(): AuditRun {
  const now = "2026-08-02T00:00:00.000Z";
  return {
    run_id: "write-probe",
    project_name: "probe",
    base_url: "https://probe.example",
    started_at: now,
    finished_at: now,
    duration_ms: 1,
    results: [
      {
        scenario_id: "s1",
        scenario_name: "Smoke",
        persona_id: "p1",
        persona_display_name: "US Desktop",
        started_at: now,
        finished_at: now,
        duration_ms: 1,
        status: "fail",
        fingerprint_id: "fp",
        steps: [],
        scores: [],
        overall_score: 1,
        issues: [
          {
            severity: "critical",
            description: "something broke",
            recommendation: "fix it",
          },
        ],
        artifacts: {},
        cost_usd: 0.067,
      },
    ],
    summary: {
      total: 1,
      pass: 0,
      pass_with_issues: 0,
      fail: 1,
      total_cost_usd: 0.067,
      total_issues: 1,
      critical_issues: 1,
    },
    config: {} as AuditRun["config"],
  } as AuditRun;
}

describe("report writers under an unwritable destination", () => {
  it.each([
    ["writeJsonReport", (a: AuditRun, d: string) => writeJsonReport(a, d)],
    ["writeMarkdownSummary", (a: AuditRun, d: string) => writeMarkdownSummary(a, d)],
    ["writeSpaReport", (a: AuditRun, d: string) => writeSpaReport(a, d)],
  ])("%s throws rather than reporting success", (_name, write) => {
    // A destination whose parent is a regular file. Every platform refuses to
    // create a directory there, which a chmod-based version of this test did
    // not achieve: `chmod 0o500` does not restrict directory writes on
    // Windows, so all three writers succeeded and the assertions failed on the
    // Windows matrix while passing everywhere they were written.
    expect(() => write(sampleAudit(), unwritableDir())).toThrow();
  });

  it("writes normally when the destination is writable", () => {
    // The guard must not change the happy path.
    const out = writeJsonReport(sampleAudit(), tmp);
    expect(fs.existsSync(out)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(out, "utf8")) as AuditRun;
    expect(parsed.summary.total_cost_usd).toBe(0.067);
  });

  it("keeps each writer independent, so one failure does not hide the others", () => {
    // The CLI reports failures per file. That is only useful if a writer's
    // failure is confined to itself rather than aborting the group.
    const dest = unwritableDir();

    const failures: string[] = [];
    for (const [name, write] of [
      ["audit.json", writeJsonReport],
      ["summary.md", writeMarkdownSummary],
    ] as Array<[string, (a: AuditRun, d: string) => string]>) {
      try {
        write(sampleAudit(), dest);
      } catch {
        failures.push(name);
      }
    }

    expect(failures).toEqual(["audit.json", "summary.md"]);
  });
});

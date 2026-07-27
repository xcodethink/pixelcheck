import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { saveAuditToHistory, loadHistory, diffRuns } from "../src/core/history.js";
import { RESULT_SCHEMA_VERSION } from "../src/core/result-schema.js";
import type { AuditRun, ProjectConfig } from "../src/core/types.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "audit-history-test-"));
}

function makeAuditRun(overrides?: Partial<AuditRun>): AuditRun {
  const config: ProjectConfig = {
    project_name: "test-project",
    base_url: "https://example.com",
    default_concurrency: 3,
    default_timeout_ms: 30000,
    models: {
      default: "claude-sonnet-4-6",
      critic: "claude-sonnet-4-6",
      computer_use: "claude-opus-4-6",
    },
    budget_usd: 3.0,
    redact_patterns: [],
  };

  return {
    run_id: "2026-04-12_120000_test",
    project_name: "test-project",
    base_url: "https://example.com",
    started_at: "2026-04-12T12:00:00Z",
    finished_at: "2026-04-12T12:01:00Z",
    duration_ms: 60000,
    results: [
      {
        scenario_id: "smoke",
        scenario_name: "Smoke Test",
        persona_id: "us-free",
        persona_display_name: "US Free User",
        started_at: "2026-04-12T12:00:00Z",
        finished_at: "2026-04-12T12:01:00Z",
        duration_ms: 60000,
        status: "pass",
        fingerprint_id: "macbook-1",
        steps: [],
        scores: [
          { dimension: "completion", score: 8.5, justification: "test" },
          { dimension: "visual_polish", score: 7.0, justification: "test" },
        ],
        overall_score: 7.75,
        issues: [
          {
            severity: "medium",
            description: "Button too small",
            recommendation: "Make it bigger",
          },
        ],
        artifacts: {},
        cost_usd: 0.05,
      },
    ],
    summary: {
      total: 1,
      pass: 1,
      pass_with_issues: 0,
      fail: 0,
      total_cost_usd: 0.05,
      total_issues: 1,
      critical_issues: 0,
    },
    config,
    ...overrides,
  };
}

describe("history", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves and loads a single audit run", () => {
    const audit = makeAuditRun();
    saveAuditToHistory(audit, tmpDir);

    const entries = loadHistory(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("2026-04-12_120000_test");
    expect(entries[0].projectName).toBe("test-project");
    expect(entries[0].overallScore).toBe(7.75);
    expect(entries[0].passCount).toBe(1);
    expect(entries[0].totalIssues).toBe(1);
  });

  it("loads dimension averages correctly", () => {
    const audit = makeAuditRun();
    saveAuditToHistory(audit, tmpDir);

    const entries = loadHistory(tmpDir);
    expect(entries[0].dimensionAverages["completion"]).toBe(8.5);
    expect(entries[0].dimensionAverages["visual_polish"]).toBe(7);
  });

  it("returns empty array when no history.db exists", () => {
    const entries = loadHistory(tmpDir);
    expect(entries).toEqual([]);
  });

  it("saves multiple runs and respects limit", () => {
    for (let i = 0; i < 5; i++) {
      saveAuditToHistory(
        makeAuditRun({
          run_id: `run_${i}`,
          started_at: `2026-04-${String(10 + i).padStart(2, "0")}T12:00:00Z`,
        }),
        tmpDir,
      );
    }

    const all = loadHistory(tmpDir, { limit: 10 });
    expect(all).toHaveLength(5);

    const limited = loadHistory(tmpDir, { limit: 3 });
    expect(limited).toHaveLength(3);
    // Most recent first
    expect(limited[0].id).toBe("run_4");
  });

  it("filters by project name", () => {
    saveAuditToHistory(makeAuditRun({ run_id: "a", project_name: "proj-a" }), tmpDir);
    saveAuditToHistory(makeAuditRun({ run_id: "b", project_name: "proj-b" }), tmpDir);

    const projA = loadHistory(tmpDir, { project: "proj-a" });
    expect(projA).toHaveLength(1);
    expect(projA[0].projectName).toBe("proj-a");
  });

  it("diffs two runs correctly", () => {
    saveAuditToHistory(
      makeAuditRun({
        run_id: "run_old",
        started_at: "2026-04-10T12:00:00Z",
        results: [
          {
            scenario_id: "smoke",
            scenario_name: "Smoke",
            persona_id: "us",
            persona_display_name: "US",
            started_at: "2026-04-10T12:00:00Z",
            finished_at: "2026-04-10T12:01:00Z",
            duration_ms: 60000,
            status: "pass",
            fingerprint_id: "f1",
            steps: [],
            scores: [{ dimension: "completion", score: 6.0, justification: "" }],
            overall_score: 6.0,
            issues: [{ severity: "high", description: "Old bug", recommendation: "Fix" }],
            artifacts: {},
            cost_usd: 0.03,
          },
        ],
        summary: { total: 1, pass: 1, pass_with_issues: 0, fail: 0, total_cost_usd: 0.03, total_issues: 1, critical_issues: 0 },
      }),
      tmpDir,
    );

    saveAuditToHistory(
      makeAuditRun({
        run_id: "run_new",
        started_at: "2026-04-12T12:00:00Z",
        results: [
          {
            scenario_id: "smoke",
            scenario_name: "Smoke",
            persona_id: "us",
            persona_display_name: "US",
            started_at: "2026-04-12T12:00:00Z",
            finished_at: "2026-04-12T12:01:00Z",
            duration_ms: 45000,
            status: "pass",
            fingerprint_id: "f1",
            steps: [],
            scores: [{ dimension: "completion", score: 8.5, justification: "" }],
            overall_score: 8.5,
            issues: [{ severity: "medium", description: "New warning", recommendation: "Check" }],
            artifacts: {},
            cost_usd: 0.04,
          },
        ],
        summary: { total: 1, pass: 1, pass_with_issues: 0, fail: 0, total_cost_usd: 0.04, total_issues: 1, critical_issues: 0 },
      }),
      tmpDir,
    );

    const diff = diffRuns(tmpDir, "run_old", "run_new");
    expect(diff).not.toBeNull();
    expect(diff!.scoreDelta).toBe(2.5);
    expect(diff!.newIssues).toHaveLength(1);
    expect(diff!.newIssues[0].description).toBe("New warning");
    expect(diff!.resolvedIssues).toHaveLength(1);
    expect(diff!.resolvedIssues[0].description).toBe("Old bug");
  });

  it("returns null when diffing non-existent runs", () => {
    saveAuditToHistory(makeAuditRun(), tmpDir);
    const diff = diffRuns(tmpDir, "nonexistent_a", "nonexistent_b");
    expect(diff).toBeNull();
  });

  it("persists audit.schema_version through save/load round-trip (M9-2)", () => {
    saveAuditToHistory(
      makeAuditRun({ run_id: "with_version", schema_version: "1.0.0" }),
      tmpDir,
    );
    const entries = loadHistory(tmpDir);
    const found = entries.find((e) => e.id === "with_version");
    expect(found).toBeDefined();
    expect(found!.schemaVersion).toBe("1.0.0");
  });

  it("stamps the current RESULT_SCHEMA_VERSION when audit lacks one", () => {
    // Older AuditRun shape (no schema_version on the object): the saver
    // backfills with whatever RESULT_SCHEMA_VERSION is current. As that
    // constant bumps over time, so does the value persisted here.
    const old = makeAuditRun({ run_id: "no_version" });
    delete (old as { schema_version?: string }).schema_version;
    saveAuditToHistory(old, tmpDir);
    const entries = loadHistory(tmpDir);
    const found = entries.find((e) => e.id === "no_version");
    expect(found).toBeDefined();
    expect(found!.schemaVersion).toBe(RESULT_SCHEMA_VERSION);
  });
});

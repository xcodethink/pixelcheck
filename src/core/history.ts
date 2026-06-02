/**
 * History — SQLite-backed audit history for trend tracking.
 *
 * Stores structured summaries of every audit run so the HTML report can
 * embed trend charts and the CLI can gate on quality thresholds.
 *
 * Schema:
 *   audit_runs        — one row per run (summary stats)
 *   dimension_scores   — one row per (run, persona, scenario, dimension)
 *   issues_history     — one row per issue
 *
 * Uses better-sqlite3 for synchronous, zero-config local storage.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type Database from "better-sqlite3";
import { openManagedDatabase, type Migration } from "./db-migrate.js";
import type { AuditRun } from "./types.js";
import { RESULT_SCHEMA_VERSION } from "./result-schema.js";

/**
 * Schema migrations. The PRAGMA user_version pragma tracks which have run.
 * Distinct from the result schema's SemVer string (`RESULT_SCHEMA_VERSION`).
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "initial schema (audit_runs, dimension_scores, issues_history)",
    up: `
      CREATE TABLE IF NOT EXISTS audit_runs (
        id              TEXT PRIMARY KEY,
        tag             TEXT,
        project_name    TEXT NOT NULL,
        base_url        TEXT NOT NULL,
        started_at      TEXT NOT NULL,
        finished_at     TEXT NOT NULL,
        duration_ms     INTEGER NOT NULL,
        total_cost_usd  REAL NOT NULL DEFAULT 0,
        total_units     INTEGER NOT NULL DEFAULT 0,
        pass_count      INTEGER NOT NULL DEFAULT 0,
        warn_count      INTEGER NOT NULL DEFAULT 0,
        fail_count      INTEGER NOT NULL DEFAULT 0,
        total_issues    INTEGER NOT NULL DEFAULT 0,
        critical_issues INTEGER NOT NULL DEFAULT 0,
        overall_score   REAL NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS dimension_scores (
        run_id       TEXT NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,
        persona_id   TEXT NOT NULL,
        scenario_id  TEXT NOT NULL,
        dimension    TEXT NOT NULL,
        score        REAL NOT NULL,
        PRIMARY KEY (run_id, persona_id, scenario_id, dimension)
      );

      CREATE TABLE IF NOT EXISTS issues_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      TEXT NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,
        severity    TEXT NOT NULL,
        dimension   TEXT,
        description TEXT NOT NULL,
        step_id     TEXT,
        recommendation TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_scores_run ON dimension_scores(run_id);
      CREATE INDEX IF NOT EXISTS idx_scores_dimension ON dimension_scores(dimension);
      CREATE INDEX IF NOT EXISTS idx_issues_run ON issues_history(run_id);
      CREATE INDEX IF NOT EXISTS idx_runs_project ON audit_runs(project_name);
      CREATE INDEX IF NOT EXISTS idx_runs_started ON audit_runs(started_at);
    `,
  },
  {
    version: 2,
    // M9-2: record the result schema version each row was written under.
    // Backfilled to '1.0.0' for legacy rows; producers stamp current
    // RESULT_SCHEMA_VERSION on new inserts. Default lets ad-hoc INSERTs skip
    // the column without errors.
    description: "M9-2 add audit_runs.schema_version",
    up: `ALTER TABLE audit_runs ADD COLUMN schema_version TEXT NOT NULL DEFAULT '1.0.0';`,
  },
];

function openDb(dbPath: string): Database.Database {
  return openManagedDatabase({
    dbPath,
    migrations: MIGRATIONS,
    foreignKeys: true,
  });
}

/**
 * Save an audit run to the history database.
 */
export function saveAuditToHistory(
  audit: AuditRun,
  reportsDir: string,
): void {
  const dbPath = path.join(reportsDir, "history.db");
  const db = openDb(dbPath);

  try {
    const overallScore =
      audit.results.length > 0
        ? audit.results.reduce((s, r) => s + r.overall_score, 0) /
          audit.results.length
        : 0;

    const insertRun = db.prepare(`
      INSERT OR REPLACE INTO audit_runs
        (id, tag, project_name, base_url, started_at, finished_at,
         duration_ms, total_cost_usd, total_units, pass_count, warn_count,
         fail_count, total_issues, critical_issues, overall_score,
         schema_version)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertScore = db.prepare(`
      INSERT OR REPLACE INTO dimension_scores
        (run_id, persona_id, scenario_id, dimension, score)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertIssue = db.prepare(`
      INSERT INTO issues_history
        (run_id, severity, dimension, description, step_id, recommendation)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const transaction = db.transaction(() => {
      // Insert run summary
      insertRun.run(
        audit.run_id,
        audit.run_id.split("_").slice(2).join("_") || null,
        audit.project_name,
        audit.base_url,
        audit.started_at,
        audit.finished_at,
        audit.duration_ms,
        audit.summary.total_cost_usd,
        audit.summary.total,
        audit.summary.pass,
        audit.summary.pass_with_issues,
        audit.summary.fail,
        audit.summary.total_issues,
        audit.summary.critical_issues,
        overallScore,
        audit.schema_version ?? RESULT_SCHEMA_VERSION,
      );

      // Insert per-unit dimension scores
      for (const result of audit.results) {
        for (const score of result.scores) {
          insertScore.run(
            audit.run_id,
            result.persona_id,
            result.scenario_id,
            score.dimension,
            score.score,
          );
        }

        // Insert issues
        for (const issue of result.issues) {
          insertIssue.run(
            audit.run_id,
            issue.severity,
            issue.dimension ?? null,
            issue.description,
            issue.step_id ?? null,
            issue.recommendation,
          );
        }
      }
    });

    transaction();
  } finally {
    db.close();
  }
}

/**
 * A compact summary of a historical audit run for trend display.
 */
export interface HistoryEntry {
  id: string;
  tag: string | null;
  projectName: string;
  startedAt: string;
  durationMs: number;
  totalCostUsd: number;
  totalUnits: number;
  passCount: number;
  warnCount: number;
  failCount: number;
  totalIssues: number;
  criticalIssues: number;
  overallScore: number;
  /** Average score per dimension across all units in this run */
  dimensionAverages: Record<string, number>;
  /** Result schema version this row was written under (M9-2). */
  schemaVersion?: string;
}

/**
 * Load the N most recent audit runs for a project (or all projects).
 */
export function loadHistory(
  reportsDir: string,
  opts?: { limit?: number; project?: string },
): HistoryEntry[] {
  const dbPath = path.join(reportsDir, "history.db");
  if (!fs.existsSync(dbPath)) return [];

  const db = openDb(dbPath);
  try {
    const limit = opts?.limit ?? 20;
    const project = opts?.project;

    const rows = project
      ? db
          .prepare(
            `SELECT * FROM audit_runs WHERE project_name = ? ORDER BY started_at DESC LIMIT ?`,
          )
          .all(project, limit) as any[]
      : db
          .prepare(
            `SELECT * FROM audit_runs ORDER BY started_at DESC LIMIT ?`,
          )
          .all(limit) as any[];

    const scoreSql = db.prepare(`
      SELECT dimension, AVG(score) as avg_score
      FROM dimension_scores
      WHERE run_id = ?
      GROUP BY dimension
    `);

    return rows.map((row) => {
      const dimRows = scoreSql.all(row.id) as Array<{
        dimension: string;
        avg_score: number;
      }>;
      const dimensionAverages: Record<string, number> = {};
      for (const d of dimRows) {
        dimensionAverages[d.dimension] = Math.round(d.avg_score * 10) / 10;
      }

      return {
        id: row.id,
        tag: row.tag,
        projectName: row.project_name,
        startedAt: row.started_at,
        durationMs: row.duration_ms,
        totalCostUsd: row.total_cost_usd,
        totalUnits: row.total_units,
        passCount: row.pass_count,
        warnCount: row.warn_count,
        failCount: row.fail_count,
        totalIssues: row.total_issues,
        criticalIssues: row.critical_issues,
        overallScore: row.overall_score,
        dimensionAverages,
        schemaVersion: row.schema_version ?? undefined,
      };
    });
  } finally {
    db.close();
  }
}

/**
 * Compare two audit runs and return a structured diff.
 */
export interface RunDiff {
  runA: HistoryEntry;
  runB: HistoryEntry;
  scoreDelta: number;
  costDelta: number;
  durationDelta: number;
  issuesDelta: number;
  dimensionDeltas: Record<string, number>;
  newIssues: Array<{ severity: string; description: string }>;
  resolvedIssues: Array<{ severity: string; description: string }>;
}

export function diffRuns(
  reportsDir: string,
  runIdA: string,
  runIdB: string,
): RunDiff | null {
  const dbPath = path.join(reportsDir, "history.db");
  if (!fs.existsSync(dbPath)) return null;

  const db = openDb(dbPath);
  try {
    const entries = loadHistory(reportsDir, { limit: 9999 });
    const runA = entries.find((e) => e.id === runIdA);
    const runB = entries.find((e) => e.id === runIdB);
    if (!runA || !runB) return null;

    // Dimension deltas
    const allDimensions = new Set([
      ...Object.keys(runA.dimensionAverages),
      ...Object.keys(runB.dimensionAverages),
    ]);
    const dimensionDeltas: Record<string, number> = {};
    for (const dim of allDimensions) {
      const a = runA.dimensionAverages[dim] ?? 0;
      const b = runB.dimensionAverages[dim] ?? 0;
      dimensionDeltas[dim] = Math.round((b - a) * 10) / 10;
    }

    // Issue diff
    const issuesA = db
      .prepare(
        `SELECT severity, description FROM issues_history WHERE run_id = ?`,
      )
      .all(runIdA) as Array<{ severity: string; description: string }>;
    const issuesB = db
      .prepare(
        `SELECT severity, description FROM issues_history WHERE run_id = ?`,
      )
      .all(runIdB) as Array<{ severity: string; description: string }>;

    const issueSetA = new Set(issuesA.map((i) => i.description));
    const issueSetB = new Set(issuesB.map((i) => i.description));

    const newIssues = issuesB.filter((i) => !issueSetA.has(i.description));
    const resolvedIssues = issuesA.filter(
      (i) => !issueSetB.has(i.description),
    );

    return {
      runA,
      runB,
      scoreDelta:
        Math.round((runB.overallScore - runA.overallScore) * 10) / 10,
      costDelta:
        Math.round((runB.totalCostUsd - runA.totalCostUsd) * 1000) / 1000,
      durationDelta: runB.durationMs - runA.durationMs,
      issuesDelta: runB.totalIssues - runA.totalIssues,
      dimensionDeltas,
      newIssues,
      resolvedIssues,
    };
  } finally {
    db.close();
  }
}

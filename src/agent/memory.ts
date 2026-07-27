/**
 * Agent Memory — Per-site playbooks accumulated across audit runs.
 *
 * Every autonomous run learns concrete facts about a target site:
 *   - "The signup CTA is labeled 'Register', not 'Sign up'."
 *   - "The pricing table is only visible after scrolling ~500px."
 *   - "A cookie banner appears on first visit; clicking 'Accept' unblocks."
 *
 * Without memory, every audit re-discovers these facts from scratch. With
 * memory, we pre-load relevant observations into the planner prompt so the
 * agent converges faster (fewer replans, fewer wrong clicks).
 *
 * Storage: SQLite, shared with plan-cache.db at ~/.pixelcheck/.
 * We keep a fact-per-row design rather than blob-per-site so individual
 * facts can age out, be promoted/demoted on confirmation, or be read
 * selectively for the planner context window.
 */

import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type Database from "better-sqlite3";
import { openManagedDatabase, type Migration } from "../core/db-migrate.js";

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "initial schema (site_memory)",
    up: `
      CREATE TABLE IF NOT EXISTS site_memory (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        host            TEXT NOT NULL,
        persona_class   TEXT NOT NULL,
        fact            TEXT NOT NULL,
        fact_hash       TEXT NOT NULL,
        source          TEXT NOT NULL DEFAULT 'agent',
        confidence      REAL NOT NULL DEFAULT 0.5,
        confirmations   INTEGER NOT NULL DEFAULT 1,
        contradictions  INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at    TEXT NOT NULL DEFAULT (datetime('now')),
        ttl_seconds     INTEGER NOT NULL DEFAULT 2592000
      );
      CREATE INDEX IF NOT EXISTS idx_site_memory_host ON site_memory(host, persona_class);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_site_memory_fact ON site_memory(fact_hash);
    `,
  },
];

export interface MemoryFact {
  id: number;
  host: string;
  persona_class: string;
  fact: string;
  source: string;
  confidence: number;
  confirmations: number;
  contradictions: number;
  created_at: string;
  last_used_at: string;
  ttl_seconds: number;
}

export interface MemoryOpts {
  dbPath?: string;
  /** Default TTL for new facts (seconds). Default: 30 days. */
  ttlSeconds?: number;
  disabled?: boolean;
}

export interface LookupOpts {
  host: string;
  persona_class: string;
  /** Cap on number of facts returned. Default: 10. */
  limit?: number;
  /** Minimum confidence (0..1). Default: 0. */
  min_confidence?: number;
}

export interface RecordOpts {
  host: string;
  persona_class: string;
  fact: string;
  source?: string;
  confidence?: number;
}

export class AgentMemory {
  private _db: Database.Database | null = null;
  private readonly _dbPath: string;
  private readonly _ttlSeconds: number;
  private readonly _disabled: boolean;

  constructor(opts: MemoryOpts = {}) {
    this._disabled = opts.disabled ?? process.env.AUDIT_MEMORY_DISABLED === "1";
    this._ttlSeconds = opts.ttlSeconds ?? 30 * 24 * 60 * 60;
    this._dbPath =
      opts.dbPath ??
      process.env.AUDIT_MEMORY_PATH ??
      path.join(
        process.env.PIXELCHECK_HOME ??
          process.env.AUDIT_HOME ??
          path.join(os.homedir(), ".pixelcheck"),
        "memory.db",
      );
  }

  private _open(): Database.Database {
    if (this._db) return this._db;
    this._db = openManagedDatabase({
      dbPath: this._dbPath,
      migrations: MIGRATIONS,
    });
    return this._db;
  }

  /**
   * Store a new fact or update an existing one (idempotent on host+persona+fact).
   * Repeated calls with the same fact increment confirmations and boost confidence.
   *
   * Implemented as a single INSERT ... ON CONFLICT(fact_hash) DO UPDATE so
   * two concurrent processes recording the same fact never race between
   * SELECT and INSERT (M9-3): the conflict resolution and the increment are
   * one atomic SQLite statement. The confidence bump is capped at 0.99 via
   * SQLite's scalar min().
   */
  record(opts: RecordOpts): void {
    if (this._disabled) return;
    const db = this._open();
    const hash = factHash(opts.host, opts.persona_class, opts.fact);

    db.prepare(
      `INSERT INTO site_memory
         (host, persona_class, fact, fact_hash, source, confidence, ttl_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fact_hash) DO UPDATE SET
         confirmations = confirmations + 1,
         confidence    = min(0.99, confidence + 0.05),
         last_used_at  = datetime('now')`,
    ).run(
      opts.host,
      opts.persona_class,
      opts.fact,
      hash,
      opts.source ?? "agent",
      opts.confidence ?? 0.5,
      this._ttlSeconds,
    );
  }

  /**
   * Look up facts for a site, optionally filtered by persona class.
   * Returns most-recently-used / highest-confidence facts first.
   */
  lookup(opts: LookupOpts): MemoryFact[] {
    if (this._disabled) return [];
    const db = this._open();
    const rows = db
      .prepare(
        `SELECT id, host, persona_class, fact, source, confidence,
                confirmations, contradictions, created_at, last_used_at, ttl_seconds
         FROM site_memory
         WHERE host = ? AND (persona_class = ? OR persona_class = '*')
           AND confidence >= ?
           AND contradictions < confirmations + 1
           AND (julianday('now') - julianday(created_at)) * 86400 < ttl_seconds
         ORDER BY confidence DESC, last_used_at DESC
         LIMIT ?`,
      )
      .all(
        opts.host,
        opts.persona_class,
        opts.min_confidence ?? 0,
        opts.limit ?? 10,
      ) as MemoryFact[];

    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      db.prepare(
        `UPDATE site_memory SET last_used_at = datetime('now')
         WHERE id IN (${ids.map(() => "?").join(",")})`,
      ).run(...ids);
    }
    return rows;
  }

  /**
   * Record a contradiction — the fact turned out to be wrong this run.
   * Enough contradictions drop the fact out of lookup() results.
   */
  contradict(factId: number): void {
    if (this._disabled) return;
    const db = this._open();
    db.prepare(
      `UPDATE site_memory
         SET contradictions = contradictions + 1,
             confidence = MAX(0.01, confidence - 0.2)
         WHERE id = ?`,
    ).run(factId);
  }

  /**
   * Delete expired facts. Called opportunistically, not on a schedule.
   */
  prune(): number {
    if (this._disabled) return 0;
    const db = this._open();
    const r = db.prepare(
      `DELETE FROM site_memory
       WHERE (julianday('now') - julianday(created_at)) * 86400 > ttl_seconds
          OR (contradictions > confirmations + 2)`,
    ).run();
    return r.changes;
  }

  size(): number {
    if (this._disabled) return 0;
    const db = this._open();
    return (db.prepare(`SELECT COUNT(*) as n FROM site_memory`).get() as { n: number }).n;
  }

  close(): void {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }

  /**
   * Compute the persona_class string used as a lookup axis.
   * Shape matches PlanCache.makeKey() — keep the two aligned.
   */
  static personaClass(country: string, device_class: string, payment_tier: string): string {
    return `${country}|${device_class}|${payment_tier}`;
  }

  /**
   * Extract the host from a URL (falls back to 80-char prefix for non-URLs).
   */
  static hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url.slice(0, 80);
    }
  }
}

/**
 * Format a list of facts as a compact planner prompt section.
 * Returns an empty string when there are no facts (so callers can just
 * concatenate it without worrying about an empty "## Memory" section).
 */
export function formatFactsForPlanner(facts: MemoryFact[]): string {
  if (facts.length === 0) return "";
  const lines = ["## Learned facts about this site"];
  for (const f of facts) {
    const tag = f.confidence >= 0.8 ? "(high confidence)" : f.confidence >= 0.5 ? "" : "(tentative)";
    lines.push(`- ${f.fact} ${tag}`.trim());
  }
  return lines.join("\n");
}

function factHash(host: string, persona: string, fact: string): string {
  return crypto.createHash("sha256").update(`${host}|${persona}|${fact}`).digest("hex").slice(0, 32);
}

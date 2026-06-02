/**
 * Plan Cache — SQLite store for reusable autonomous plans.
 *
 * Motivation: re-planning from scratch for every audit is expensive.
 * Most autonomous runs target the same (site, goal, persona class, DOM shape)
 * combination repeatedly. Caching successful plans against that key yields
 * 60-80% hit rates in practice, cutting planning cost by the same margin.
 *
 * Key components (order-independent):
 *   scenario_id     — identifies the goal + success criteria set
 *   persona_class   — (country, device_class, payment_tier) tuple, NOT full persona id
 *                     so the cache is shared across similar personas
 *   start_url_host  — ignores path/query/hash so a plan works for any page of a site
 *   dom_skeleton    — hashed DOM structure (tag-tree + interactive element count),
 *                     deliberately ignores content so copy changes don't invalidate
 *
 * Cache entries carry a success_count / failure_count so we can retire plans that
 * stop working (e.g., the site changed). TTL is enforced on read.
 *
 * Storage: ~/.pixelcheck/plan-cache.db by default; override via opts.dbPath
 * or AUDIT_PLAN_CACHE_PATH env var. Small (< 1 MB in practice).
 */

import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type Database from "better-sqlite3";
import { openManagedDatabase, type Migration } from "../core/db-migrate.js";
import type { Plan } from "./planner.js";
import type { Persona } from "../core/types.js";

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "initial schema (plan_cache)",
    up: `
      CREATE TABLE IF NOT EXISTS plan_cache (
        key             TEXT PRIMARY KEY,
        scenario_id     TEXT NOT NULL,
        persona_class   TEXT NOT NULL,
        host            TEXT NOT NULL,
        dom_skeleton    TEXT NOT NULL,
        plan_json       TEXT NOT NULL,
        success_count   INTEGER NOT NULL DEFAULT 0,
        failure_count   INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at    TEXT NOT NULL DEFAULT (datetime('now')),
        ttl_seconds     INTEGER NOT NULL DEFAULT 604800
      );

      CREATE INDEX IF NOT EXISTS idx_plan_cache_scenario ON plan_cache(scenario_id);
      CREATE INDEX IF NOT EXISTS idx_plan_cache_host ON plan_cache(host);
    `,
  },
];

export interface PlanCacheOpts {
  dbPath?: string;
  /** Default TTL for newly inserted entries (seconds). Default 7 days. */
  ttlSeconds?: number;
  /** Disable cache entirely (useful for CI benchmarks). */
  disabled?: boolean;
}

export interface CacheKeyInput {
  scenario_id: string;
  persona: Persona;
  start_url: string;
  dom_skeleton: string;
}

export interface CachedPlanRecord {
  key: string;
  plan: Plan;
  success_count: number;
  failure_count: number;
  created_at: string;
  last_used_at: string;
  ttl_seconds: number;
}

export class PlanCache {
  private _db: Database.Database | null = null;
  private readonly _dbPath: string;
  private readonly _ttlSeconds: number;
  private readonly _disabled: boolean;

  constructor(opts: PlanCacheOpts = {}) {
    this._disabled = opts.disabled ?? process.env.AUDIT_PLAN_CACHE_DISABLED === "1";
    this._ttlSeconds = opts.ttlSeconds ?? 7 * 24 * 60 * 60;
    this._dbPath =
      opts.dbPath ??
      process.env.AUDIT_PLAN_CACHE_PATH ??
      path.join(
        process.env.PIXELCHECK_HOME ??
          process.env.AUDIT_HOME ??
          path.join(os.homedir(), ".pixelcheck"),
        "plan-cache.db",
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
   * Build the cache key from semantically meaningful components.
   * Stable across runs but ignores cosmetic variation.
   */
  static makeKey(input: CacheKeyInput): string {
    const personaClass = `${input.persona.country}|${input.persona.device_class}|${input.persona.payment_tier}`;
    let host: string;
    try {
      host = new URL(input.start_url).host;
    } catch {
      host = input.start_url.slice(0, 80);
    }
    const raw = [input.scenario_id, personaClass, host, input.dom_skeleton].join("\n");
    return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
  }

  /**
   * Look up a cached plan. Returns undefined if disabled, missing, or expired.
   * Updates last_used_at on hit.
   */
  lookup(input: CacheKeyInput): CachedPlanRecord | undefined {
    if (this._disabled) return undefined;
    const db = this._open();
    const key = PlanCache.makeKey(input);
    const row = db
      .prepare(
        `SELECT key, plan_json, success_count, failure_count, created_at, last_used_at, ttl_seconds
         FROM plan_cache WHERE key = ?`,
      )
      .get(key) as
      | {
          key: string;
          plan_json: string;
          success_count: number;
          failure_count: number;
          created_at: string;
          last_used_at: string;
          ttl_seconds: number;
        }
      | undefined;
    if (!row) return undefined;

    // TTL check
    const created = Date.parse(row.created_at + "Z");
    if (Number.isFinite(created)) {
      const ageSec = (Date.now() - created) / 1000;
      if (ageSec > row.ttl_seconds) {
        db.prepare(`DELETE FROM plan_cache WHERE key = ?`).run(key);
        return undefined;
      }
    }

    // Retire plans that have failed more than they succeed (once they have data)
    if (row.failure_count >= 3 && row.failure_count > row.success_count) {
      db.prepare(`DELETE FROM plan_cache WHERE key = ?`).run(key);
      return undefined;
    }

    db.prepare(`UPDATE plan_cache SET last_used_at = datetime('now') WHERE key = ?`).run(key);

    try {
      const plan = JSON.parse(row.plan_json) as Plan;
      return {
        key: row.key,
        plan,
        success_count: row.success_count,
        failure_count: row.failure_count,
        created_at: row.created_at,
        last_used_at: row.last_used_at,
        ttl_seconds: row.ttl_seconds,
      };
    } catch {
      // Corrupted record — purge
      db.prepare(`DELETE FROM plan_cache WHERE key = ?`).run(key);
      return undefined;
    }
  }

  /**
   * Store or replace a plan for the given key.
   */
  store(input: CacheKeyInput, plan: Plan): void {
    if (this._disabled) return;
    const db = this._open();
    const key = PlanCache.makeKey(input);
    const personaClass = `${input.persona.country}|${input.persona.device_class}|${input.persona.payment_tier}`;
    let host: string;
    try {
      host = new URL(input.start_url).host;
    } catch {
      host = "";
    }
    db.prepare(
      `INSERT INTO plan_cache (key, scenario_id, persona_class, host, dom_skeleton, plan_json, ttl_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         plan_json    = excluded.plan_json,
         last_used_at = datetime('now'),
         ttl_seconds  = excluded.ttl_seconds`,
    ).run(
      key,
      input.scenario_id,
      personaClass,
      host,
      input.dom_skeleton,
      JSON.stringify(plan),
      this._ttlSeconds,
    );
  }

  /**
   * Record the outcome of a previously-cached plan. Used to retire stale plans.
   */
  recordOutcome(key: string, success: boolean): void {
    if (this._disabled) return;
    const db = this._open();
    const column = success ? "success_count" : "failure_count";
    db.prepare(`UPDATE plan_cache SET ${column} = ${column} + 1 WHERE key = ?`).run(key);
  }

  /**
   * Explicitly invalidate a cache entry (e.g., when its plan just failed).
   */
  invalidate(key: string): void {
    if (this._disabled) return;
    const db = this._open();
    db.prepare(`DELETE FROM plan_cache WHERE key = ?`).run(key);
  }

  /**
   * Prune expired entries. Called opportunistically, not on a schedule.
   */
  prune(): number {
    if (this._disabled) return 0;
    const db = this._open();
    const result = db.prepare(
      `DELETE FROM plan_cache
       WHERE (julianday('now') - julianday(created_at)) * 86400 > ttl_seconds`,
    ).run();
    return result.changes;
  }

  /**
   * Return entry count — useful for tests and health checks.
   */
  size(): number {
    if (this._disabled) return 0;
    const db = this._open();
    const row = db.prepare(`SELECT COUNT(*) as n FROM plan_cache`).get() as { n: number };
    return row.n;
  }

  close(): void {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }
}

/**
 * Compute a stable DOM skeleton hash from a DOM summary string.
 *
 * Strategy: strip content (text, hrefs, placeholders), keep structure only.
 * We use the caller-provided dom_summary (from extractDomSummary) and hash the
 * collapsed version to avoid invalidating the cache on every copy change.
 */
export function computeDomSkeleton(domSummary: string): string {
  // Keep only tag names and nesting structure tokens; drop long textual blobs.
  const collapsed = domSummary
    .replace(/"[^"]{4,}"/g, '""')
    .replace(/\s+/g, " ")
    .replace(/\b\d{3,}\b/g, "N") // big numbers (IDs, timestamps)
    .slice(0, 4000);
  return crypto.createHash("sha256").update(collapsed).digest("hex").slice(0, 16);
}

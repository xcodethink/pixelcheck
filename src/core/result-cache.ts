/**
 * Result cache (M9-4) — local persistent cache for primitive results.
 *
 * Why: AI agents repeatedly hit the same URL with the same options
 * during reasoning loops. Without a cache every reasoning step burns
 * fresh vision tokens. This module memoises results from the
 * deterministic primitives (`judge`, `extract`, `see` w/ goal) so a
 * second identical call returns instantly, costs $0, and makes
 * `compare`'s double-blind mode amortise its judge calls across
 * comparisons.
 *
 * What is cacheable:
 *   - judge(url, rubrics, criteria, persona, model, ...)
 *   - extract(url, schema, instruction, selector, persona)
 *   - see(url, goal, persona, ...) — only when a goal triggered a
 *     vision call (no goal = no LLM cost = nothing to save)
 *
 * What is NOT cached:
 *   - act       — semantically wrong: NL `act { instruction }` and the
 *                 deterministic mutators are imperative state changes.
 *                 Re-running may produce different downstream state.
 *   - compare   — transparently benefits from judge cache (its two
 *                 per-side judge calls hit cache; synthesis is tiny).
 *   - audit_url — heavyweight, many-variable; deferred to a future task.
 *
 * Storage: SQLite at `~/.ai-browser-auditor/result-cache.db` (override
 * via `AUDIT_RESULT_CACHE_PATH`). One table; one row per cache entry.
 * WAL transition is wrapped in a file-lock per the M9-3 follow-up
 * pattern (see history.ts / agent/memory.ts).
 *
 * Key derivation: sha256 of canonical-JSON({ primitive, ...inputs }).
 * Each primitive defines what goes into `inputs`. Order independence
 * is achieved by sorting object keys recursively before stringify.
 *
 * TTL: default 24h, override via `AUDIT_RESULT_CACHE_TTL_MS`. Entries
 * older than the TTL are treated as misses and pruned opportunistically
 * when the DB is opened. Entries written under a different
 * `RESULT_SCHEMA_VERSION` major+minor are also treated as misses and
 * deleted on read.
 *
 * Bypass:
 *   - `AUDIT_RESULT_CACHE_DISABLED=1` — global off-switch (no read, no write)
 *   - per-call `cache: false` — same effect but only for one call
 *   - per-call `cacheBust: true` — skip read but DO write the new result
 *
 * Concurrency: `INSERT ... ON CONFLICT(key) DO UPDATE` is one
 * statement; SQLite serialises it. Readers and writers across processes
 * share the WAL log.
 *
 * Cost-guard interaction: a cache HIT does not call any LLM and does
 * not touch the cost-guard. The returned result has `cost_usd = 0` and
 * `cache.cost_saved_usd` set to the original computation cost so
 * downstream callers can report savings.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import Database from "better-sqlite3";

import { withFileLockSync } from "./file-lock.js";
import { getLogger } from "./logger.js";
import { RESULT_SCHEMA_VERSION } from "./result-schema.js";

const log = getLogger("result-cache");

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

/**
 * Annotation attached to a cached result. Always present on
 * cache-aware primitive results regardless of hit or miss so callers
 * can distinguish "cache disabled / not applicable" (field absent)
 * from "cache miss" (`hit: false`) from "cache hit" (`hit: true`).
 */
export interface ResultCacheMeta {
  /** True when the result was served from cache. */
  hit: boolean;
  /** Milliseconds since the cached entry was written. 0 on miss. */
  age_ms: number;
  /** sha256 of the canonical input — same key for same inputs across machines. */
  key: string;
  /**
   * On hit: the original result's `cost_usd` (i.e. dollars saved by the
   * cache hit). Omitted on miss. Lets downstream callers (`compare`)
   * surface aggregate savings without double-counting.
   */
  cost_saved_usd?: number;
}

export interface ResultCacheConfig {
  /** Override the SQLite path. Defaults to env or `~/.ai-browser-auditor/result-cache.db`. */
  dbPath?: string;
  /** Override the TTL. Defaults to env or 24h. */
  ttlMs?: number;
  /** Force-disable the cache for this instance. Defaults to env. */
  disabled?: boolean;
}

export interface ResultCacheLookupArgs {
  /** Logical primitive name. Must match what was stored. */
  primitive: string;
  /** Canonical-stringified input the cache key was derived from. */
  cacheKeyInputs: unknown;
}

export interface ResultCacheLookupHit<T> {
  hit: true;
  /** The cached value, with `cache` annotated for the consumer. */
  value: T;
  ageMs: number;
  key: string;
}

export interface ResultCacheLookupMiss {
  hit: false;
  key: string;
}

export type ResultCacheLookup<T> = ResultCacheLookupHit<T> | ResultCacheLookupMiss;

export interface WithResultCacheArgs<T> {
  primitive: string;
  /** What goes into the hash. Test seams MUST be excluded. */
  cacheKeyInputs: unknown;
  /**
   * The expensive computation. Receives the resolved cache key so the
   * result can embed its own `cache` field with the same key the cache
   * stored it under.
   */
  compute: (key: string) => Promise<T>;
  /**
   * Per-call disable. `false` = no read + no write. Defaults to true
   * (cache enabled — subject to env / config disable).
   */
  cacheEnabled?: boolean;
  /**
   * Per-call bust. `true` = skip read, still write. Default false.
   */
  cacheBust?: boolean;
  /** TTL override for this call. */
  ttlMs?: number;
  /**
   * Extracts the `cost_usd` from the freshly computed result so the
   * cache hit downstream can report `cost_saved_usd`. Defaults to
   * reading `result.cost_usd`.
   */
  costExtractor?: (result: T) => number;
  /**
   * Sets `result.cache` and `result.cost_usd` for the returned object.
   * Defaults to a shallow object spread; primitives with read-only
   * fields can supply a custom mutator.
   */
  applyCacheMeta?: (result: T, meta: ResultCacheMeta, hit: boolean) => T;
}

// ─────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // prune once per opened DB per hour

export function defaultDbPath(): string {
  const env = process.env.AUDIT_RESULT_CACHE_PATH;
  if (env && env.length > 0) return env;
  return path.join(os.homedir(), ".ai-browser-auditor", "result-cache.db");
}

function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function isDisabledByEnv(): boolean {
  const v = (process.env.AUDIT_RESULT_CACHE_DISABLED ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// ─────────────────────────────────────────────────────────────
// Canonical JSON + key derivation
// ─────────────────────────────────────────────────────────────

/**
 * Sort object keys recursively before JSON.stringify so semantically
 * equivalent inputs produce the same string. Arrays preserve order
 * (order is meaningful for `steps`, `rubrics`, etc.). Functions and
 * undefined are dropped — same as default JSON.stringify behaviour.
 */
export function canonicalJsonStringify(value: unknown): string {
  const DROP = Symbol("drop");
  const seen = new WeakSet();
  const walk = (v: unknown): unknown => {
    if (v === null) return null;
    if (typeof v === "undefined" || typeof v === "function") return DROP;
    if (typeof v !== "object") {
      if (typeof v === "number" && !Number.isFinite(v)) return null;
      return v;
    }
    if (seen.has(v as object)) return null;
    seen.add(v as object);
    if (Array.isArray(v)) {
      // Arrays preserve length: undefined / functions become null
      // (matches default JSON.stringify behaviour).
      return v.map((item) => {
        const w = walk(item);
        return w === DROP ? null : w;
      });
    }
    const out: Record<string, unknown> = {};
    const keys = Object.keys(v as Record<string, unknown>).sort();
    for (const k of keys) {
      const next = walk((v as Record<string, unknown>)[k]);
      if (next === DROP) continue;
      out[k] = next;
    }
    return out;
  };
  const walked = walk(value);
  // Top-level undefined / function → emit "null" (JSON has no undefined).
  return JSON.stringify(walked === DROP ? null : walked);
}

/**
 * Compute the cache key for `(primitive, inputs)`. Stable across
 * processes, machines, and Node versions (sha256 + canonical JSON).
 */
export function cacheKeyFor(primitive: string, inputs: unknown): string {
  const canonical = canonicalJsonStringify({ primitive, inputs });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ─────────────────────────────────────────────────────────────
// SQLite layer
// ─────────────────────────────────────────────────────────────

const SCHEMA_USER_VERSION = 1;
const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS result_cache (
    key            TEXT PRIMARY KEY,
    primitive      TEXT NOT NULL,
    value_json     TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cache_created ON result_cache(created_at);
  CREATE INDEX IF NOT EXISTS idx_cache_primitive ON result_cache(primitive);
`;

interface DbHandle {
  db: Database.Database;
  /** When the last opportunistic prune ran. */
  lastPruneAt: number;
}

const dbHandles = new Map<string, DbHandle>();

function openDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // M9-3 follow-up pattern: WAL transition is EXCLUSIVE-locked and does
  // NOT walk the busy_timeout. Wrap it in a file-lock so concurrent
  // openers serialise the journal_mode flip; once set, it persists
  // in the file header and subsequent opens read-and-skip.
  db.pragma("busy_timeout = 5000");
  withFileLockSync(`${dbPath}.init.lock`, () => {
    const mode = db.pragma("journal_mode", { simple: true }) as string;
    if (mode !== "wal") {
      db.pragma("journal_mode = WAL");
    }
  });

  const userVersion =
    (db.pragma("user_version", { simple: true }) as number | null) ?? 0;
  if (userVersion < SCHEMA_USER_VERSION) {
    db.exec(TABLE_DDL);
    db.pragma(`user_version = ${SCHEMA_USER_VERSION}`);
  }
  return db;
}

function getDb(dbPath: string): DbHandle {
  let handle = dbHandles.get(dbPath);
  if (!handle) {
    const db = openDb(dbPath);
    handle = { db, lastPruneAt: 0 };
    dbHandles.set(dbPath, handle);
  }
  return handle;
}

function shouldPrune(handle: DbHandle, now: number): boolean {
  return now - handle.lastPruneAt > PRUNE_INTERVAL_MS;
}

/**
 * Drop entries older than `maxAgeMs` and entries written under a
 * stricter schema version mismatch. Cheap; runs opportunistically when
 * the DB is opened (or via {@link pruneCache}).
 */
export function pruneCache(opts: {
  dbPath?: string;
  maxAgeMs?: number;
  now?: number;
} = {}): { removed: number } {
  const dbPath = opts.dbPath ?? defaultDbPath();
  const handle = getDb(dbPath);
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? readEnvNumber("AUDIT_RESULT_CACHE_TTL_MS", DEFAULT_TTL_MS);
  const cutoff = now - maxAge;

  const stmt = handle.db.prepare(
    `DELETE FROM result_cache WHERE created_at < ? OR schema_version != ?`,
  );
  const info = stmt.run(cutoff, RESULT_SCHEMA_VERSION);
  handle.lastPruneAt = now;
  return { removed: Number(info.changes ?? 0) };
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

export interface ResultCacheRow {
  primitive: string;
  value: unknown;
  schemaVersion: string;
  createdAt: number;
}

/**
 * Look up a cache entry. Returns null if disabled, missing, expired,
 * or written under an incompatible schema version.
 */
export function lookupCache<T = unknown>(args: {
  key: string;
  ttlMs?: number;
  now?: number;
  config?: ResultCacheConfig;
}): { hit: false } | { hit: true; value: T; ageMs: number } {
  const cfg = args.config ?? {};
  const disabled = cfg.disabled ?? isDisabledByEnv();
  if (disabled) return { hit: false };

  const dbPath = cfg.dbPath ?? defaultDbPath();
  const handle = getDb(dbPath);
  const now = args.now ?? Date.now();

  if (shouldPrune(handle, now)) {
    try {
      pruneCache({ dbPath, maxAgeMs: cfg.ttlMs, now });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "result-cache: prune failed; continuing",
      );
    }
  }

  let row: { value_json: string; schema_version: string; created_at: number } | undefined;
  try {
    row = handle.db
      .prepare(
        `SELECT value_json, schema_version, created_at FROM result_cache WHERE key = ?`,
      )
      .get(args.key) as
      | { value_json: string; schema_version: string; created_at: number }
      | undefined;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "result-cache: lookup failed",
    );
    return { hit: false };
  }

  if (!row) return { hit: false };

  if (row.schema_version !== RESULT_SCHEMA_VERSION) {
    // Mismatched envelope schema — treat as miss; it'll be re-written
    // and the next prune will sweep stragglers.
    return { hit: false };
  }

  const ttl = args.ttlMs ?? cfg.ttlMs ?? readEnvNumber("AUDIT_RESULT_CACHE_TTL_MS", DEFAULT_TTL_MS);
  const ageMs = now - row.created_at;
  if (ageMs > ttl) return { hit: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value_json);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "result-cache: stored JSON unparsable; ignoring entry",
    );
    return { hit: false };
  }

  return { hit: true, value: parsed as T, ageMs };
}

/**
 * Persist a result. Atomic upsert via `INSERT ... ON CONFLICT DO UPDATE`
 * so two writers racing the same key converge cleanly.
 */
export function storeCache(args: {
  key: string;
  primitive: string;
  value: unknown;
  now?: number;
  config?: ResultCacheConfig;
}): void {
  const cfg = args.config ?? {};
  const disabled = cfg.disabled ?? isDisabledByEnv();
  if (disabled) return;

  const dbPath = cfg.dbPath ?? defaultDbPath();
  const handle = getDb(dbPath);
  const now = args.now ?? Date.now();

  let json: string;
  try {
    json = JSON.stringify(args.value);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), primitive: args.primitive },
      "result-cache: serialisation failed; skipping write",
    );
    return;
  }

  try {
    handle.db
      .prepare(
        `INSERT INTO result_cache (key, primitive, value_json, schema_version, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           primitive = excluded.primitive,
           value_json = excluded.value_json,
           schema_version = excluded.schema_version,
           created_at = excluded.created_at`,
      )
      .run(args.key, args.primitive, json, RESULT_SCHEMA_VERSION, now);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), primitive: args.primitive },
      "result-cache: write failed; continuing without cache",
    );
  }
}

function defaultCostExtractor(result: unknown): number {
  if (
    result &&
    typeof result === "object" &&
    "cost_usd" in result &&
    typeof (result as { cost_usd: unknown }).cost_usd === "number"
  ) {
    return (result as { cost_usd: number }).cost_usd;
  }
  return 0;
}

function defaultApplyCacheMeta<T>(result: T, meta: ResultCacheMeta, hit: boolean): T {
  if (!result || typeof result !== "object") return result;
  const obj = result as Record<string, unknown>;
  if (hit) {
    // Zero out cost_usd so callers aggregating cost (e.g. compare summing
    // its two judge calls) do not double-count cached work.
    return { ...obj, cost_usd: 0, cache: meta } as T;
  }
  return { ...obj, cache: meta } as T;
}

/**
 * Wrap a primitive's expensive computation with the result cache.
 *
 * On hit: returns the cached value with `cache.hit=true`,
 *   `cache.cost_saved_usd` = the original cost, and the result's own
 *   `cost_usd` zeroed.
 *
 * On miss: computes via `compute(key)` and persists the result before
 *   returning it with `cache.hit=false`.
 *
 * Disabled: bypass entirely; computes and returns without touching the
 *   DB. The result still has `cache: undefined` so the schema sees a
 *   uniform shape.
 */
export async function withResultCache<T>(args: WithResultCacheArgs<T>): Promise<T> {
  const enabled = args.cacheEnabled ?? true;
  const key = cacheKeyFor(args.primitive, args.cacheKeyInputs);
  const apply = args.applyCacheMeta ?? defaultApplyCacheMeta;
  const extractCost = args.costExtractor ?? defaultCostExtractor;

  if (!enabled || isDisabledByEnv()) {
    const fresh = await args.compute(key);
    return fresh;
  }

  if (!args.cacheBust) {
    const lookup = lookupCache<T>({ key, ttlMs: args.ttlMs });
    if (lookup.hit) {
      const cost = extractCost(lookup.value);
      const meta: ResultCacheMeta = {
        hit: true,
        age_ms: lookup.ageMs,
        key,
        cost_saved_usd: cost,
      };
      return apply(lookup.value, meta, true);
    }
  }

  const fresh = await args.compute(key);
  storeCache({ key, primitive: args.primitive, value: fresh });
  const meta: ResultCacheMeta = { hit: false, age_ms: 0, key };
  return apply(fresh, meta, false);
}

// ─────────────────────────────────────────────────────────────
// Test seams
// ─────────────────────────────────────────────────────────────

/** Test-only: close & forget every cached DB handle (forces re-open). */
export function _resetCacheForTests(): void {
  for (const h of dbHandles.values()) {
    try {
      h.db.close();
    } catch {
      // ignore
    }
  }
  dbHandles.clear();
}

/** Test-only: peek at how many handles are currently open. */
export function _openHandleCountForTests(): number {
  return dbHandles.size;
}

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  cacheKeyFor,
  canonicalJsonStringify,
  lookupCache,
  storeCache,
  pruneCache,
  withResultCache,
  _resetCacheForTests,
  type ResultCacheMeta,
} from "../src/core/result-cache.js";
import { RESULT_SCHEMA_VERSION } from "../src/core/result-schema.js";

function tmpDb(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "result-cache-")),
    "cache.db",
  );
}

function cleanup(dbPath: string): void {
  try {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

beforeEach(() => {
  _resetCacheForTests();
  delete process.env.AUDIT_RESULT_CACHE_PATH;
  delete process.env.AUDIT_RESULT_CACHE_TTL_MS;
  delete process.env.AUDIT_RESULT_CACHE_DISABLED;
});

afterEach(() => {
  _resetCacheForTests();
});

describe("canonicalJsonStringify", () => {
  it("sorts object keys deterministically", () => {
    const a = canonicalJsonStringify({ b: 1, a: 2, c: 3 });
    const b = canonicalJsonStringify({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it("recursively sorts nested objects", () => {
    const a = canonicalJsonStringify({ outer: { z: 1, a: 2 }, list: [{ y: 1, x: 2 }] });
    const b = canonicalJsonStringify({ list: [{ x: 2, y: 1 }], outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it("preserves array order (semantically meaningful for steps/rubrics)", () => {
    expect(canonicalJsonStringify([1, 2, 3])).toBe("[1,2,3]");
    expect(canonicalJsonStringify([3, 2, 1])).toBe("[3,2,1]");
  });

  it("drops functions/undefined keys; non-finite numbers become null", () => {
    const out = canonicalJsonStringify({
      a: 1,
      b: undefined,
      c: () => 1,
      d: Number.NaN,
      e: Infinity,
    });
    // undefined / functions are dropped (matches default JSON.stringify
    // behaviour for object members). NaN / Infinity become null.
    expect(out).toBe('{"a":1,"d":null,"e":null}');
  });

  it("handles cycles by emitting null for the back-edge", () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    // The walk hits the back-edge first (during the walk of `a.self`),
    // marks `a` as already-seen and returns null for the inner reference.
    // Outer JSON.stringify then sees the `seen` walker has already
    // emitted the parent object once (with x:1), but our walker bails
    // on the second visit. Either an empty object or a self:null is
    // acceptable — what we forbid is throwing or infinite recursion.
    const out = canonicalJsonStringify(a);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("cacheKeyFor", () => {
  it("produces a stable sha256 hex string", () => {
    const k = cacheKeyFor("judge", { url: "https://example.com", rubrics: ["aesthetic"] });
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the same key regardless of input key order", () => {
    const k1 = cacheKeyFor("judge", { url: "https://x.com", rubrics: ["aesthetic"], model: "m" });
    const k2 = cacheKeyFor("judge", { model: "m", rubrics: ["aesthetic"], url: "https://x.com" });
    expect(k1).toBe(k2);
  });

  it("changes when the primitive name changes", () => {
    const k1 = cacheKeyFor("judge", { url: "https://x.com" });
    const k2 = cacheKeyFor("extract", { url: "https://x.com" });
    expect(k1).not.toBe(k2);
  });

  it("changes when input value changes", () => {
    const k1 = cacheKeyFor("judge", { url: "https://x.com" });
    const k2 = cacheKeyFor("judge", { url: "https://y.com" });
    expect(k1).not.toBe(k2);
  });

  it("treats {a: undefined, b: 1} the same as {b: 1}", () => {
    const k1 = cacheKeyFor("judge", { a: undefined, b: 1 });
    const k2 = cacheKeyFor("judge", { b: 1 });
    expect(k1).toBe(k2);
  });
});

describe("lookupCache + storeCache", () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = tmpDb();
  });
  afterEach(() => cleanup(dbPath));

  it("returns hit:false for an empty cache", () => {
    const r = lookupCache({ key: "deadbeef", config: { dbPath } });
    expect(r.hit).toBe(false);
  });

  it("round-trips a value", () => {
    const key = cacheKeyFor("judge", { url: "https://x.com" });
    storeCache({
      key,
      primitive: "judge",
      value: { score: 7, cost_usd: 0.005 },
      now: 1_700_000_000_000,
      config: { dbPath },
    });
    const r = lookupCache<{ score: number; cost_usd: number }>({
      key,
      now: 1_700_000_000_500,
      config: { dbPath },
    });
    expect(r.hit).toBe(true);
    if (r.hit) {
      expect(r.value.score).toBe(7);
      expect(r.value.cost_usd).toBe(0.005);
      expect(r.ageMs).toBe(500);
    }
  });

  it("treats expired entries as misses", () => {
    const key = cacheKeyFor("judge", { url: "https://x.com" });
    storeCache({
      key,
      primitive: "judge",
      value: { score: 7 },
      now: 1_700_000_000_000,
      config: { dbPath },
    });
    const r = lookupCache({
      key,
      now: 1_700_000_000_000 + 25 * 3600 * 1000,
      ttlMs: 24 * 3600 * 1000,
      config: { dbPath },
    });
    expect(r.hit).toBe(false);
  });

  it("treats stale entries as misses when env TTL is shorter", () => {
    const key = cacheKeyFor("judge", { url: "https://x.com" });
    storeCache({
      key,
      primitive: "judge",
      value: { score: 7 },
      now: 1_700_000_000_000,
      config: { dbPath },
    });
    process.env.AUDIT_RESULT_CACHE_TTL_MS = "1000";
    const r = lookupCache({
      key,
      now: 1_700_000_000_000 + 5000,
      config: { dbPath },
    });
    expect(r.hit).toBe(false);
  });

  it("upserts on conflict — same key replaces value", () => {
    const key = "abc";
    storeCache({ key, primitive: "judge", value: { v: 1 }, config: { dbPath } });
    storeCache({ key, primitive: "judge", value: { v: 2 }, config: { dbPath } });
    const r = lookupCache<{ v: number }>({ key, config: { dbPath } });
    expect(r.hit).toBe(true);
    if (r.hit) expect(r.value.v).toBe(2);
  });

  it("returns hit:false when AUDIT_RESULT_CACHE_DISABLED is set", () => {
    const key = "abc";
    storeCache({ key, primitive: "judge", value: { v: 1 }, config: { dbPath } });
    process.env.AUDIT_RESULT_CACHE_DISABLED = "1";
    const r = lookupCache({ key, config: { dbPath } });
    expect(r.hit).toBe(false);
  });

  it("storeCache is a no-op when disabled by env", () => {
    process.env.AUDIT_RESULT_CACHE_DISABLED = "1";
    storeCache({ key: "abc", primitive: "judge", value: { v: 1 }, config: { dbPath } });
    delete process.env.AUDIT_RESULT_CACHE_DISABLED;
    const r = lookupCache({ key: "abc", config: { dbPath } });
    expect(r.hit).toBe(false);
  });

  it("ignores cached entries written under a different RESULT_SCHEMA_VERSION", () => {
    const key = "abc";
    // Write directly with a different version by reaching into the DB.
    // Reuse storeCache then mutate — easier than re-implementing the open path.
    storeCache({ key, primitive: "judge", value: { v: 1 }, config: { dbPath } });
    // Mutate the row.
    const Database = require("better-sqlite3");
    const db = new Database(dbPath);
    db.prepare(`UPDATE result_cache SET schema_version = ? WHERE key = ?`).run(
      "0.0.1",
      key,
    );
    db.close();
    _resetCacheForTests();
    const r = lookupCache({ key, config: { dbPath } });
    expect(r.hit).toBe(false);
  });

  it("survives malformed value_json by treating it as a miss", () => {
    storeCache({ key: "abc", primitive: "judge", value: { v: 1 }, config: { dbPath } });
    const Database = require("better-sqlite3");
    const db = new Database(dbPath);
    db.prepare(`UPDATE result_cache SET value_json = ? WHERE key = ?`).run("{ not json", "abc");
    db.close();
    _resetCacheForTests();
    const r = lookupCache({ key: "abc", config: { dbPath } });
    expect(r.hit).toBe(false);
  });
});

describe("pruneCache", () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = tmpDb();
  });
  afterEach(() => cleanup(dbPath));

  it("removes entries older than maxAgeMs", () => {
    storeCache({
      key: "old",
      primitive: "judge",
      value: { v: 1 },
      now: 1_700_000_000_000,
      config: { dbPath },
    });
    storeCache({
      key: "new",
      primitive: "judge",
      value: { v: 2 },
      now: 1_700_000_000_000 + 60_000,
      config: { dbPath },
    });
    const result = pruneCache({
      dbPath,
      maxAgeMs: 30_000,
      now: 1_700_000_000_000 + 60_000,
    });
    expect(result.removed).toBe(1);
    expect(lookupCache({ key: "old", now: 1_700_000_000_000 + 60_000, config: { dbPath } }).hit).toBe(false);
    const newR = lookupCache({ key: "new", now: 1_700_000_000_000 + 60_000, config: { dbPath } });
    expect(newR.hit).toBe(true);
  });

  it("removes entries with mismatched schema_version", () => {
    storeCache({ key: "abc", primitive: "judge", value: { v: 1 }, config: { dbPath } });
    const Database = require("better-sqlite3");
    const db = new Database(dbPath);
    db.prepare(`UPDATE result_cache SET schema_version = ? WHERE key = ?`).run("0.0.1", "abc");
    db.close();
    _resetCacheForTests();
    const result = pruneCache({ dbPath });
    expect(result.removed).toBe(1);
  });
});

describe("withResultCache", () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = tmpDb();
    process.env.AUDIT_RESULT_CACHE_PATH = dbPath;
  });
  afterEach(() => {
    cleanup(dbPath);
    delete process.env.AUDIT_RESULT_CACHE_PATH;
  });

  it("calls compute on miss and persists the result", async () => {
    let computeCalls = 0;
    const result = await withResultCache({
      primitive: "judge",
      cacheKeyInputs: { url: "https://x.com" },
      compute: async () => {
        computeCalls++;
        return { score: 7, cost_usd: 0.01 };
      },
    });
    expect(computeCalls).toBe(1);
    expect((result as { score: number }).score).toBe(7);
    expect((result as { cache?: ResultCacheMeta }).cache).toEqual({
      hit: false,
      age_ms: 0,
      key: expect.any(String),
    });
  });

  it("serves from cache on the second call", async () => {
    let computeCalls = 0;
    const compute = async () => {
      computeCalls++;
      return { score: 7, cost_usd: 0.01 };
    };
    await withResultCache({
      primitive: "judge",
      cacheKeyInputs: { url: "https://x.com" },
      compute,
    });
    const second = (await withResultCache({
      primitive: "judge",
      cacheKeyInputs: { url: "https://x.com" },
      compute,
    })) as { score: number; cost_usd: number; cache: ResultCacheMeta };
    expect(computeCalls).toBe(1);
    expect(second.cache.hit).toBe(true);
    expect(second.cache.cost_saved_usd).toBe(0.01);
    expect(second.cost_usd).toBe(0); // zeroed on hit
  });

  it("respects cacheBust by recomputing while still writing", async () => {
    let computeCalls = 0;
    const compute = async () => {
      computeCalls++;
      return { score: computeCalls, cost_usd: 0.01 };
    };
    await withResultCache({ primitive: "judge", cacheKeyInputs: { url: "x" }, compute });
    const bust = (await withResultCache({
      primitive: "judge",
      cacheKeyInputs: { url: "x" },
      compute,
      cacheBust: true,
    })) as { score: number; cache: ResultCacheMeta };
    expect(computeCalls).toBe(2);
    expect(bust.cache.hit).toBe(false);
    // Subsequent call hits cache and gets the busted value (score=2).
    const third = (await withResultCache({
      primitive: "judge",
      cacheKeyInputs: { url: "x" },
      compute,
    })) as { score: number; cache: ResultCacheMeta };
    expect(computeCalls).toBe(2);
    expect(third.cache.hit).toBe(true);
    expect(third.score).toBe(2);
  });

  it("respects cacheEnabled=false (no read, no write)", async () => {
    let computeCalls = 0;
    const compute = async () => {
      computeCalls++;
      return { score: 7, cost_usd: 0.01 };
    };
    await withResultCache({ primitive: "judge", cacheKeyInputs: { url: "x" }, compute });
    const second = (await withResultCache({
      primitive: "judge",
      cacheKeyInputs: { url: "x" },
      compute,
      cacheEnabled: false,
    })) as { score: number; cache?: ResultCacheMeta };
    expect(computeCalls).toBe(2);
    expect(second.cache).toBeUndefined();
  });

  it("respects AUDIT_RESULT_CACHE_DISABLED env (no read, no write)", async () => {
    let computeCalls = 0;
    const compute = async () => {
      computeCalls++;
      return { score: 7, cost_usd: 0 };
    };
    process.env.AUDIT_RESULT_CACHE_DISABLED = "1";
    try {
      await withResultCache({ primitive: "judge", cacheKeyInputs: { url: "x" }, compute });
      const second = (await withResultCache({
        primitive: "judge",
        cacheKeyInputs: { url: "x" },
        compute,
      })) as { cache?: ResultCacheMeta };
      expect(computeCalls).toBe(2);
      expect(second.cache).toBeUndefined();
    } finally {
      delete process.env.AUDIT_RESULT_CACHE_DISABLED;
    }
  });

  it("misses for different inputs", async () => {
    let computeCalls = 0;
    const compute = async () => {
      computeCalls++;
      return { score: computeCalls, cost_usd: 0 };
    };
    await withResultCache({ primitive: "judge", cacheKeyInputs: { url: "x" }, compute });
    await withResultCache({ primitive: "judge", cacheKeyInputs: { url: "y" }, compute });
    expect(computeCalls).toBe(2);
  });

  it("misses across different primitives even with same inputs", async () => {
    let computeCalls = 0;
    const compute = async () => {
      computeCalls++;
      return { v: computeCalls, cost_usd: 0 };
    };
    await withResultCache({ primitive: "judge", cacheKeyInputs: { url: "x" }, compute });
    await withResultCache({ primitive: "extract", cacheKeyInputs: { url: "x" }, compute });
    expect(computeCalls).toBe(2);
  });

  it("custom costExtractor + applyCacheMeta hook", async () => {
    let computeCalls = 0;
    const compute = async () => {
      computeCalls++;
      return { custom_cost: 0.5, payload: "first" };
    };
    const args = {
      primitive: "judge",
      cacheKeyInputs: { url: "x" },
      compute,
      costExtractor: (r: { custom_cost: number }) => r.custom_cost,
      applyCacheMeta: <T extends object>(r: T, meta: ResultCacheMeta) => ({ ...r, _meta: meta }),
    } as const;
    await withResultCache(args);
    const second = (await withResultCache(args)) as {
      _meta: ResultCacheMeta;
      payload: string;
    };
    expect(second._meta.hit).toBe(true);
    expect(second._meta.cost_saved_usd).toBe(0.5);
    expect(second.payload).toBe("first");
  });

  it("rewrites cache when schema version on stored value mismatches", async () => {
    let computeCalls = 0;
    const compute = async () => {
      computeCalls++;
      return { v: computeCalls, cost_usd: 0 };
    };
    await withResultCache({ primitive: "judge", cacheKeyInputs: { url: "x" }, compute });
    const Database = require("better-sqlite3");
    const db = new Database(dbPath);
    db.prepare(`UPDATE result_cache SET schema_version = ?`).run("0.0.1");
    db.close();
    _resetCacheForTests();
    process.env.AUDIT_RESULT_CACHE_PATH = dbPath;
    const after = (await withResultCache({
      primitive: "judge",
      cacheKeyInputs: { url: "x" },
      compute,
    })) as { v: number; cache: ResultCacheMeta };
    expect(computeCalls).toBe(2);
    expect(after.cache.hit).toBe(false);
    expect(after.v).toBe(2);
    // Lookup again — should now hit at the current version.
    const third = (await withResultCache({
      primitive: "judge",
      cacheKeyInputs: { url: "x" },
      compute,
    })) as { v: number; cache: ResultCacheMeta };
    expect(computeCalls).toBe(2);
    expect(third.cache.hit).toBe(true);
  });
});

describe("RESULT_SCHEMA_VERSION sanity", () => {
  it("is a SemVer string", () => {
    expect(RESULT_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("LRU disk-quota prune (T17 — closes R49)", () => {
  it("bumps last_used_at on a hit so re-touched entries survive eviction", () => {
    const dbPath = tmpDb();
    try {
      // Write 5 rows
      for (let i = 0; i < 5; i++) {
        storeCache({
          key: `k${i}`,
          primitive: "judge",
          value: { i },
          now: 1000 + i,
          config: { dbPath, ttlMs: 1_000_000 },
        });
      }
      // Touch k0 — its last_used_at should now be the freshest
      const hit = lookupCache({
        key: "k0",
        now: 9999,
        config: { dbPath, ttlMs: 1_000_000 },
      });
      expect(hit.hit).toBe(true);

      // Prune with maxRows=3 → 2 rows must be evicted. k0 (touched
      // at 9999) survives; k1 + k2 (oldest last_used_at) get evicted.
      const result = pruneCache({
        dbPath,
        now: 10000,
        maxRows: 3,
        maxDiskMb: 0,
      });
      expect(result.lruEvicted).toBe(2);

      const after0 = lookupCache({
        key: "k0",
        now: 10001,
        config: { dbPath, ttlMs: 1_000_000 },
      });
      const after1 = lookupCache({
        key: "k1",
        now: 10001,
        config: { dbPath, ttlMs: 1_000_000 },
      });
      expect(after0.hit).toBe(true);
      expect(after1.hit).toBe(false);
    } finally {
      cleanup(dbPath);
    }
  });

  it("evicts oldest when row-count cap is exceeded", () => {
    const dbPath = tmpDb();
    try {
      for (let i = 0; i < 10; i++) {
        storeCache({
          key: `k${i}`,
          primitive: "judge",
          value: { i },
          now: 1000 + i,
          config: { dbPath, ttlMs: 1_000_000 },
        });
      }
      const result = pruneCache({
        dbPath,
        now: 2000,
        maxRows: 4,
        maxDiskMb: 0,
      });
      expect(result.lruEvicted).toBe(6);

      // The 4 newest (k6..k9) should remain
      for (let i = 0; i < 6; i++) {
        const r = lookupCache({
          key: `k${i}`,
          now: 2001,
          config: { dbPath, ttlMs: 1_000_000 },
        });
        expect(r.hit).toBe(false);
      }
      for (let i = 6; i < 10; i++) {
        const r = lookupCache({
          key: `k${i}`,
          now: 2001,
          config: { dbPath, ttlMs: 1_000_000 },
        });
        expect(r.hit).toBe(true);
      }
    } finally {
      cleanup(dbPath);
    }
  });

  it("maxRows=0 disables row-count cap", () => {
    const dbPath = tmpDb();
    try {
      for (let i = 0; i < 5; i++) {
        storeCache({
          key: `k${i}`,
          primitive: "judge",
          value: { i },
          now: 1000 + i,
          config: { dbPath, ttlMs: 1_000_000 },
        });
      }
      const result = pruneCache({
        dbPath,
        now: 2000,
        maxRows: 0,
        maxDiskMb: 0,
      });
      expect(result.lruEvicted).toBe(0);
    } finally {
      cleanup(dbPath);
    }
  });

  it("env vars AUDIT_RESULT_CACHE_MAX_ROWS / MAX_DISK_MB drive defaults", () => {
    const dbPath = tmpDb();
    try {
      for (let i = 0; i < 6; i++) {
        storeCache({
          key: `k${i}`,
          primitive: "judge",
          value: { i },
          now: 1000 + i,
          config: { dbPath, ttlMs: 1_000_000 },
        });
      }
      process.env.AUDIT_RESULT_CACHE_MAX_ROWS = "2";
      process.env.AUDIT_RESULT_CACHE_MAX_DISK_MB = "0";
      try {
        const result = pruneCache({ dbPath, now: 2000 });
        expect(result.lruEvicted).toBe(4);
      } finally {
        delete process.env.AUDIT_RESULT_CACHE_MAX_ROWS;
        delete process.env.AUDIT_RESULT_CACHE_MAX_DISK_MB;
      }
    } finally {
      cleanup(dbPath);
    }
  });

  it("TTL prune runs first, then LRU on the remainder", () => {
    const dbPath = tmpDb();
    try {
      // 3 ancient + 5 fresh
      for (let i = 0; i < 3; i++) {
        storeCache({
          key: `old${i}`,
          primitive: "judge",
          value: { i },
          now: 100,
          config: { dbPath, ttlMs: 1_000 },
        });
      }
      for (let i = 0; i < 5; i++) {
        storeCache({
          key: `fresh${i}`,
          primitive: "judge",
          value: { i },
          now: 5000 + i,
          config: { dbPath, ttlMs: 1_000_000 },
        });
      }
      const result = pruneCache({
        dbPath,
        now: 5100, // ancients are now ~5000ms old, > 1000ms TTL
        maxAgeMs: 1000,
        maxRows: 3,
        maxDiskMb: 0,
      });
      expect(result.removed).toBe(3); // 3 ancient TTL-pruned
      expect(result.lruEvicted).toBe(2); // 5 fresh - cap 3 = 2 evicted
      // The 3 freshest (fresh2..fresh4) remain
      for (let i = 0; i < 2; i++) {
        const r = lookupCache({
          key: `fresh${i}`,
          now: 5101,
          config: { dbPath, ttlMs: 1_000_000 },
        });
        expect(r.hit).toBe(false);
      }
      for (let i = 2; i < 5; i++) {
        const r = lookupCache({
          key: `fresh${i}`,
          now: 5101,
          config: { dbPath, ttlMs: 1_000_000 },
        });
        expect(r.hit).toBe(true);
      }
    } finally {
      cleanup(dbPath);
    }
  });
});

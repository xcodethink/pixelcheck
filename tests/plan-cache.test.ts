/**
 * Tests for PlanCache — SQLite-backed reusable plan storage.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { PlanCache, computeDomSkeleton } from "../src/agent/plan-cache.js";
import type { Plan } from "../src/agent/planner.js";
import type { Persona } from "../src/core/types.js";

function mkPersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "test-persona",
    display_name: "Test Persona",
    country: "US",
    language: "en",
    locale: "en-US",
    timezone: "America/New_York",
    device_class: "desktop",
    payment_tier: "free",
    mental_model: "",
    critical_concerns: [],
    ...overrides,
  };
}

function mkPlan(id = "plan-1"): Plan {
  return {
    id,
    created_at: new Date().toISOString(),
    reasoning: "test plan",
    steps: [
      { index: 0, action_type: "visit", instruction: "go home", reasoning: "", targets_criteria: [] },
    ],
  };
}

let cache: PlanCache;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-cache-"));
  cache = new PlanCache({ dbPath: path.join(tmpDir, "cache.db") });
});

afterEach(() => {
  cache.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("PlanCache", () => {
  const baseInput = {
    scenario_id: "signup",
    persona: mkPersona(),
    start_url: "https://example.com/",
    dom_skeleton: "abc123",
  };

  it("returns undefined on miss", () => {
    expect(cache.lookup(baseInput)).toBeUndefined();
  });

  it("stores and retrieves a plan", () => {
    const plan = mkPlan();
    cache.store(baseInput, plan);
    const hit = cache.lookup(baseInput);
    expect(hit).toBeDefined();
    expect(hit!.plan.id).toBe("plan-1");
    expect(cache.size()).toBe(1);
  });

  it("produces the same key for equivalent personas", () => {
    const p1 = mkPersona({ id: "persona-a", display_name: "A" });
    const p2 = mkPersona({ id: "persona-b", display_name: "B" });
    const k1 = PlanCache.makeKey({ ...baseInput, persona: p1 });
    const k2 = PlanCache.makeKey({ ...baseInput, persona: p2 });
    // Same country/device/tier -> same key
    expect(k1).toBe(k2);
  });

  it("produces different keys for different device classes", () => {
    const p1 = mkPersona({ device_class: "desktop" });
    const p2 = mkPersona({ device_class: "mobile" });
    const k1 = PlanCache.makeKey({ ...baseInput, persona: p1 });
    const k2 = PlanCache.makeKey({ ...baseInput, persona: p2 });
    expect(k1).not.toBe(k2);
  });

  it("ignores URL path/query — only host counts", () => {
    const k1 = PlanCache.makeKey({ ...baseInput, start_url: "https://example.com/x?a=1" });
    const k2 = PlanCache.makeKey({ ...baseInput, start_url: "https://example.com/y?b=2" });
    expect(k1).toBe(k2);
    const k3 = PlanCache.makeKey({ ...baseInput, start_url: "https://other.com/" });
    expect(k1).not.toBe(k3);
  });

  it("invalidates a specific entry", () => {
    cache.store(baseInput, mkPlan());
    const hit = cache.lookup(baseInput)!;
    cache.invalidate(hit.key);
    expect(cache.lookup(baseInput)).toBeUndefined();
  });

  it("retires entries with failure_count >= 3 and > success_count", () => {
    cache.store(baseInput, mkPlan());
    const hit = cache.lookup(baseInput)!;
    cache.recordOutcome(hit.key, false);
    cache.recordOutcome(hit.key, false);
    cache.recordOutcome(hit.key, false);
    // After 3 failures, lookup should purge and miss
    expect(cache.lookup(baseInput)).toBeUndefined();
  });

  it("keeps entries where successes dominate", () => {
    cache.store(baseInput, mkPlan());
    const hit = cache.lookup(baseInput)!;
    cache.recordOutcome(hit.key, true);
    cache.recordOutcome(hit.key, true);
    cache.recordOutcome(hit.key, false);
    const after = cache.lookup(baseInput);
    expect(after).toBeDefined();
  });

  it("respects TTL", () => {
    const shortCache = new PlanCache({
      dbPath: path.join(tmpDir, "ttl.db"),
      ttlSeconds: -1, // any lookup will be considered expired
    });
    shortCache.store(baseInput, mkPlan());
    expect(shortCache.lookup(baseInput)).toBeUndefined();
    shortCache.close();
  });

  it("prune removes only expired entries", () => {
    const c2 = new PlanCache({ dbPath: path.join(tmpDir, "prune.db"), ttlSeconds: -1 });
    c2.store(baseInput, mkPlan());
    expect(c2.size()).toBe(1);
    const pruned = c2.prune();
    expect(pruned).toBe(1);
    expect(c2.size()).toBe(0);
    c2.close();
  });

  it("disabled cache is a no-op", () => {
    const disabled = new PlanCache({ dbPath: path.join(tmpDir, "disabled.db"), disabled: true });
    disabled.store(baseInput, mkPlan());
    expect(disabled.lookup(baseInput)).toBeUndefined();
    expect(disabled.size()).toBe(0);
    disabled.close();
  });
});

describe("computeDomSkeleton", () => {
  it("ignores long quoted attribute values (copy changes don't invalidate)", () => {
    const a = computeDomSkeleton('<a href="https://example.com/long-slug-v1">Link</a>');
    const b = computeDomSkeleton('<a href="https://example.com/totally-different-slug-v2">Link</a>');
    expect(a).toBe(b);
  });

  it("normalizes whitespace differences", () => {
    const a = computeDomSkeleton("<div>   <b>X</b>\n\n<i>Y</i>   </div>");
    const b = computeDomSkeleton("<div> <b>X</b> <i>Y</i> </div>");
    expect(a).toBe(b);
  });

  it("produces different hashes for different structures", () => {
    const a = computeDomSkeleton("<div><button>A</button></div>");
    const b = computeDomSkeleton("<div><a>A</a></div>");
    expect(a).not.toBe(b);
  });
});

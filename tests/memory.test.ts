/**
 * Tests for AgentMemory — per-site fact store.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AgentMemory, formatFactsForPlanner } from "../src/agent/memory.js";

let tmp: string;
let mem: AgentMemory;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
  mem = new AgentMemory({ dbPath: path.join(tmp, "m.db") });
});
afterEach(() => {
  mem.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const host = "app.example";
const pclass = "US|desktop|free";

describe("AgentMemory", () => {
  it("stores and retrieves a fact", () => {
    mem.record({ host, persona_class: pclass, fact: "CTA labeled 'Register' not 'Sign up'" });
    const facts = mem.lookup({ host, persona_class: pclass });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.fact).toMatch(/Register/);
    expect(mem.size()).toBe(1);
  });

  it("idempotent on same fact — increments confirmations and confidence", () => {
    mem.record({ host, persona_class: pclass, fact: "X", confidence: 0.5 });
    mem.record({ host, persona_class: pclass, fact: "X" });
    mem.record({ host, persona_class: pclass, fact: "X" });
    const facts = mem.lookup({ host, persona_class: pclass });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.confirmations).toBe(3);
    expect(facts[0]!.confidence).toBeGreaterThan(0.55);
  });

  it("distinct facts stored separately", () => {
    mem.record({ host, persona_class: pclass, fact: "A" });
    mem.record({ host, persona_class: pclass, fact: "B" });
    expect(mem.lookup({ host, persona_class: pclass })).toHaveLength(2);
  });

  it("persona_class='*' matches any persona", () => {
    mem.record({ host, persona_class: "*", fact: "cookie banner on first visit" });
    const match = mem.lookup({ host, persona_class: "US|mobile|pro" });
    expect(match).toHaveLength(1);
  });

  it("other hosts are isolated", () => {
    mem.record({ host: "app.example", persona_class: pclass, fact: "X" });
    mem.record({ host: "other.example", persona_class: pclass, fact: "X" });
    expect(mem.lookup({ host: "app.example", persona_class: pclass })).toHaveLength(1);
    expect(mem.lookup({ host: "other.example", persona_class: pclass })).toHaveLength(1);
  });

  it("contradict drops fact's confidence and eventually purges", () => {
    mem.record({ host, persona_class: pclass, fact: "wrong thing" });
    const [fact] = mem.lookup({ host, persona_class: pclass });
    expect(fact).toBeDefined();
    mem.contradict(fact!.id);
    mem.contradict(fact!.id);
    mem.contradict(fact!.id);
    // After multiple contradictions contradictions > confirmations+1, lookup filters it out
    expect(mem.lookup({ host, persona_class: pclass })).toHaveLength(0);
  });

  it("honors min_confidence filter", () => {
    mem.record({ host, persona_class: pclass, fact: "low", confidence: 0.2 });
    mem.record({ host, persona_class: pclass, fact: "high", confidence: 0.9 });
    const top = mem.lookup({ host, persona_class: pclass, min_confidence: 0.5 });
    expect(top).toHaveLength(1);
    expect(top[0]!.fact).toBe("high");
  });

  it("honors limit", () => {
    for (let i = 0; i < 15; i++) {
      mem.record({ host, persona_class: pclass, fact: `fact-${i}` });
    }
    expect(mem.lookup({ host, persona_class: pclass, limit: 5 })).toHaveLength(5);
  });

  it("prune removes expired entries", () => {
    const short = new AgentMemory({ dbPath: path.join(tmp, "short.db"), ttlSeconds: -1 });
    short.record({ host, persona_class: pclass, fact: "expired" });
    expect(short.size()).toBe(1);
    expect(short.prune()).toBe(1);
    expect(short.size()).toBe(0);
    short.close();
  });

  it("disabled memory is a no-op", () => {
    const off = new AgentMemory({ dbPath: path.join(tmp, "off.db"), disabled: true });
    off.record({ host, persona_class: pclass, fact: "x" });
    expect(off.size()).toBe(0);
    expect(off.lookup({ host, persona_class: pclass })).toHaveLength(0);
    off.close();
  });

  it("personaClass and hostOf helpers", () => {
    expect(AgentMemory.personaClass("BR", "mobile", "free")).toBe("BR|mobile|free");
    expect(AgentMemory.hostOf("https://example.com/foo?x=1")).toBe("example.com");
    expect(AgentMemory.hostOf("not-a-url")).toBe("not-a-url");
  });
});

describe("formatFactsForPlanner", () => {
  it("returns empty string for empty list", () => {
    expect(formatFactsForPlanner([])).toBe("");
  });

  it("tags facts by confidence band", () => {
    const facts = [
      { id: 1, host: "x", persona_class: "*", fact: "F1", source: "a", confidence: 0.9, confirmations: 3, contradictions: 0, created_at: "", last_used_at: "", ttl_seconds: 0 },
      { id: 2, host: "x", persona_class: "*", fact: "F2", source: "a", confidence: 0.3, confirmations: 1, contradictions: 0, created_at: "", last_used_at: "", ttl_seconds: 0 },
    ];
    const out = formatFactsForPlanner(facts);
    expect(out).toContain("high confidence");
    expect(out).toContain("tentative");
    expect(out).toContain("F1");
    expect(out).toContain("F2");
  });

  it("two child processes recording the same fact concurrently never error and converge to one row", async () => {
    const { spawn } = await import("node:child_process");
    const dbPath = path.join(tmp, "race.db");
    const ITERATIONS = 12;
    const child = `
const { AgentMemory } = require(${JSON.stringify(
      path.join(process.cwd(), "dist/agent/memory.js"),
    )});
const mem = new AgentMemory({ dbPath: ${JSON.stringify(dbPath)} });
const ITER = ${ITERATIONS};
for (let i = 0; i < ITER; i++) {
  mem.record({ host: "shared.example", persona_class: "US|desktop|free", fact: "shared fact" });
  const start = Date.now();
  while (Date.now() - start < 1) {}
}
mem.close();
process.exit(0);
`;
    const procs = [0, 1, 2].map(
      () =>
        new Promise<number>((resolve, reject) => {
          const p = spawn(process.execPath, ["-e", child], {
            cwd: process.cwd(),
          });
          p.on("exit", (code) => resolve(code ?? -1));
          p.on("error", reject);
        }),
    );
    const codes = await Promise.all(procs);
    expect(codes).toEqual([0, 0, 0]);

    // Re-open the DB to read the result.
    const m = new AgentMemory({ dbPath });
    const facts = m.lookup({
      host: "shared.example",
      persona_class: "US|desktop|free",
    });
    expect(facts).toHaveLength(1);
    // Total confirmations across 3 procs × ITER calls = (3*ITER - 1) increments
    // on top of the initial INSERT (which sets confirmations=1 by default).
    // SQLite's atomic INSERT...ON CONFLICT guarantees no lost increments.
    expect(facts[0]!.confirmations).toBe(3 * ITERATIONS);
    m.close();
  }, 60_000);
});

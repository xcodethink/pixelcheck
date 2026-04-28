import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CostGuard,
  BudgetExceededError,
  COST_LEDGER_SCHEMA_VERSION,
  getCostGuard,
  _resetCostGuardForTests,
  _setCostGuardForTests,
  type LedgerSnapshot,
} from "../src/core/cost-guard.js";

const SONNET = "claude-sonnet-4-6"; // $3 in / $15 out per 1M tokens

function tmpLedger(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "cost-guard-")),
    "ledger.json",
  );
}

function readLedger(p: string): LedgerSnapshot {
  return JSON.parse(fs.readFileSync(p, "utf-8")) as LedgerSnapshot;
}

const FIXED_NOW = new Date("2026-04-28T10:00:00Z");
const NEXT_DAY = new Date("2026-04-29T10:00:00Z");

describe("CostGuard.recordUsage", () => {
  let ledgerPath: string;

  beforeEach(() => {
    ledgerPath = tmpLedger();
  });

  afterEach(() => {
    try {
      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("computes cost via estimateCost and accumulates run + day totals", () => {
    const guard = new CostGuard({
      ledgerPath,
      now: () => FIXED_NOW,
      limits: {
        maxRunUsd: 100,
        maxRunTokens: 1e9,
        maxDailyUsd: 100,
        maxDailyTokens: 1e9,
      },
    });

    // 1M input + 1M output = $3 + $15 = $18 on Sonnet
    const r = guard.recordUsage(SONNET, 1_000_000, 1_000_000);
    expect(r.usd).toBeCloseTo(18, 6);
    expect(r.runUsd).toBeCloseTo(18, 6);
    expect(r.dailyUsd).toBeCloseTo(18, 6);

    // Second call accumulates
    const r2 = guard.recordUsage(SONNET, 100_000, 0);
    expect(r2.runUsd).toBeCloseTo(18.3, 6);
    expect(r2.dailyUsd).toBeCloseTo(18.3, 6);
  });

  it("persists ledger atomically with schema_version stamped", () => {
    const guard = new CostGuard({
      ledgerPath,
      now: () => FIXED_NOW,
      limits: {
        maxRunUsd: 100,
        maxRunTokens: 1e9,
        maxDailyUsd: 100,
        maxDailyTokens: 1e9,
      },
    });
    guard.recordUsage(SONNET, 1000, 500);

    const ledger = readLedger(ledgerPath);
    expect(ledger.schema_version).toBe(COST_LEDGER_SCHEMA_VERSION);
    expect(ledger.days["2026-04-28"]).toBeDefined();
    expect(ledger.days["2026-04-28"]!.input_tokens).toBe(1000);
    expect(ledger.days["2026-04-28"]!.output_tokens).toBe(500);
    expect(ledger.days["2026-04-28"]!.usd).toBeCloseTo(
      (1000 * 3 + 500 * 15) / 1_000_000,
      9,
    );
  });

  it("two CostGuard instances sharing the same ledger see the daily total", () => {
    const a = new CostGuard({
      ledgerPath,
      now: () => FIXED_NOW,
      limits: {
        maxRunUsd: 100,
        maxRunTokens: 1e9,
        maxDailyUsd: 100,
        maxDailyTokens: 1e9,
      },
    });
    a.recordUsage(SONNET, 500_000, 0); // $1.5

    const b = new CostGuard({
      ledgerPath,
      now: () => FIXED_NOW,
      limits: {
        maxRunUsd: 100,
        maxRunTokens: 1e9,
        maxDailyUsd: 100,
        maxDailyTokens: 1e9,
      },
    });
    expect(b.snapshot().today.usd).toBeCloseTo(1.5, 6);

    b.recordUsage(SONNET, 500_000, 0); // another $1.5 → daily $3.0
    expect(b.snapshot().today.usd).toBeCloseTo(3.0, 6);
    expect(readLedger(ledgerPath).days["2026-04-28"]!.usd).toBeCloseTo(3.0, 6);
  });

  it("starts a fresh per-day bucket when the date rolls over", () => {
    let now = FIXED_NOW;
    const guard = new CostGuard({
      ledgerPath,
      now: () => now,
      limits: {
        maxRunUsd: 100,
        maxRunTokens: 1e9,
        maxDailyUsd: 100,
        maxDailyTokens: 1e9,
      },
    });
    guard.recordUsage(SONNET, 1_000_000, 0); // $3 on day 1
    now = NEXT_DAY;
    guard.recordUsage(SONNET, 1_000_000, 0); // $3 on day 2

    const ledger = readLedger(ledgerPath);
    expect(ledger.days["2026-04-28"]!.usd).toBeCloseTo(3, 6);
    expect(ledger.days["2026-04-29"]!.usd).toBeCloseTo(3, 6);
    // run totals carry across days (run lifecycle is independent of UTC day)
    expect(guard.snapshot().run.usd).toBeCloseTo(6, 6);
  });
});

describe("CostGuard.checkBudget + recordUsage tripwires", () => {
  let ledgerPath: string;
  beforeEach(() => {
    ledgerPath = tmpLedger();
  });
  afterEach(() => {
    try {
      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("throws BudgetExceededError on run-usd cap (post-call)", () => {
    const guard = new CostGuard({
      ledgerPath,
      now: () => FIXED_NOW,
      limits: {
        maxRunUsd: 1,
        maxRunTokens: 1e9,
        maxDailyUsd: 100,
        maxDailyTokens: 1e9,
      },
    });
    // 500K input = $1.5 > $1 cap
    expect(() => guard.recordUsage(SONNET, 500_000, 0)).toThrow(
      BudgetExceededError,
    );
    try {
      guard.recordUsage(SONNET, 1, 0);
    } catch (err) {
      expect((err as BudgetExceededError).kind).toBe("run-usd");
    }
  });

  it("throws on run-tokens cap", () => {
    const guard = new CostGuard({
      ledgerPath,
      now: () => FIXED_NOW,
      limits: {
        maxRunUsd: 1000,
        maxRunTokens: 100,
        maxDailyUsd: 1000,
        maxDailyTokens: 1e9,
      },
    });
    expect(() => guard.recordUsage(SONNET, 200, 0)).toThrow(
      /run-tokens/,
    );
  });

  it("throws on daily-usd cap (across runs / restarts)", () => {
    const limits = {
      maxRunUsd: 1000,
      maxRunTokens: 1e9,
      maxDailyUsd: 1,
      maxDailyTokens: 1e9,
    };
    const guard = new CostGuard({
      ledgerPath,
      now: () => FIXED_NOW,
      limits,
    });
    // 200K input = $0.6
    guard.recordUsage(SONNET, 200_000, 0);
    guard.resetRun(); // simulate next audit run, same day
    // 300K input = $0.9 → daily total $1.5 > $1 cap
    expect(() => guard.recordUsage(SONNET, 300_000, 0)).toThrow(/daily-usd/);
  });

  it("checkBudget alone (no recordUsage) throws once over", () => {
    const guard = new CostGuard({
      ledgerPath,
      now: () => FIXED_NOW,
      limits: {
        maxRunUsd: 0.5,
        maxRunTokens: 1e9,
        maxDailyUsd: 1000,
        maxDailyTokens: 1e9,
      },
    });
    expect(() => guard.checkBudget()).not.toThrow();
    // 200K input = $0.6 > $0.5 — recordUsage will throw…
    expect(() => guard.recordUsage(SONNET, 200_000, 0)).toThrow();
    // …and a follow-up checkBudget call also throws (state is sticky)
    expect(() => guard.checkBudget()).toThrow(BudgetExceededError);
  });

  it("error message includes the env override hint", () => {
    const guard = new CostGuard({
      ledgerPath,
      now: () => FIXED_NOW,
      limits: {
        maxRunUsd: 0.01,
        maxRunTokens: 1e9,
        maxDailyUsd: 1000,
        maxDailyTokens: 1e9,
      },
    });
    try {
      guard.recordUsage(SONNET, 100_000, 0);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect((err as Error).message).toMatch(/AUDIT_COST_MAX_RUN_USD/);
      expect((err as Error).message).toMatch(/AUDIT_COST_GUARD_DISABLED/);
    }
  });
});

describe("CostGuard.resetRun + snapshot", () => {
  let ledgerPath: string;
  beforeEach(() => {
    ledgerPath = tmpLedger();
  });
  afterEach(() => {
    try {
      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("resetRun clears in-memory run counters but not the ledger", () => {
    const guard = new CostGuard({
      ledgerPath,
      now: () => FIXED_NOW,
      limits: {
        maxRunUsd: 100,
        maxRunTokens: 1e9,
        maxDailyUsd: 100,
        maxDailyTokens: 1e9,
      },
    });
    guard.recordUsage(SONNET, 1_000_000, 0); // $3
    expect(guard.snapshot().run.usd).toBeCloseTo(3, 6);
    guard.resetRun();
    expect(guard.snapshot().run.usd).toBe(0);
    expect(guard.snapshot().today.usd).toBeCloseTo(3, 6);
  });

  it("snapshot reports the current today date and ledger path", () => {
    const guard = new CostGuard({
      ledgerPath,
      now: () => FIXED_NOW,
      limits: {
        maxRunUsd: 100,
        maxRunTokens: 1e9,
        maxDailyUsd: 100,
        maxDailyTokens: 1e9,
      },
    });
    const snap = guard.snapshot();
    expect(snap.today.date).toBe("2026-04-28");
    expect(snap.ledgerPath).toBe(ledgerPath);
    expect(snap.disabled).toBe(false);
  });
});

describe("CostGuard disabled mode", () => {
  let ledgerPath: string;
  beforeEach(() => {
    ledgerPath = tmpLedger();
  });
  afterEach(() => {
    try {
      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("disabled=true: never throws, never persists", () => {
    const guard = new CostGuard({
      ledgerPath,
      now: () => FIXED_NOW,
      disabled: true,
      limits: {
        maxRunUsd: 0.001,
        maxRunTokens: 1,
        maxDailyUsd: 0.001,
        maxDailyTokens: 1,
      },
    });
    expect(() => guard.checkBudget()).not.toThrow();
    expect(() => guard.recordUsage(SONNET, 1_000_000, 1_000_000)).not.toThrow();
    expect(fs.existsSync(ledgerPath)).toBe(false);
  });

  it("AUDIT_COST_GUARD_DISABLED=1 honored at construction time", () => {
    const prev = process.env.AUDIT_COST_GUARD_DISABLED;
    process.env.AUDIT_COST_GUARD_DISABLED = "1";
    try {
      const guard = new CostGuard({
        ledgerPath,
        now: () => FIXED_NOW,
        limits: {
          maxRunUsd: 0.001,
          maxRunTokens: 1,
          maxDailyUsd: 0.001,
          maxDailyTokens: 1,
        },
      });
      expect(guard.snapshot().disabled).toBe(true);
      expect(() => guard.recordUsage(SONNET, 1_000_000, 1_000_000)).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.AUDIT_COST_GUARD_DISABLED;
      else process.env.AUDIT_COST_GUARD_DISABLED = prev;
    }
  });
});

describe("Ledger pruning", () => {
  it("drops entries older than 30 days at next write", () => {
    const ledgerPath = tmpLedger();
    const old = "2026-01-01"; // > 30 days before FIXED_NOW (2026-04-28)
    const recent = "2026-04-15";
    const seed: LedgerSnapshot = {
      schema_version: COST_LEDGER_SCHEMA_VERSION,
      days: {
        [old]: { input_tokens: 100, output_tokens: 50, usd: 0.001 },
        [recent]: { input_tokens: 200, output_tokens: 100, usd: 0.002 },
      },
    };
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify(seed), "utf-8");

    const guard = new CostGuard({
      ledgerPath,
      now: () => FIXED_NOW,
      limits: {
        maxRunUsd: 100,
        maxRunTokens: 1e9,
        maxDailyUsd: 100,
        maxDailyTokens: 1e9,
      },
    });
    guard.recordUsage(SONNET, 1, 0); // triggers a write → prune

    const after = readLedger(ledgerPath);
    expect(after.days[old]).toBeUndefined();
    expect(after.days[recent]).toBeDefined();
    expect(after.days["2026-04-28"]).toBeDefined();
    fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true });
  });

  it("recovers from a malformed ledger file (treats as empty)", () => {
    const ledgerPath = tmpLedger();
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, "{ this is not json", "utf-8");
    const guard = new CostGuard({
      ledgerPath,
      now: () => FIXED_NOW,
      limits: {
        maxRunUsd: 100,
        maxRunTokens: 1e9,
        maxDailyUsd: 100,
        maxDailyTokens: 1e9,
      },
    });
    expect(() => guard.recordUsage(SONNET, 100, 0)).not.toThrow();
    const after = readLedger(ledgerPath);
    expect(after.schema_version).toBe(COST_LEDGER_SCHEMA_VERSION);
    expect(after.days["2026-04-28"]).toBeDefined();
    fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true });
  });
});

describe("Singleton accessor", () => {
  afterEach(() => {
    _resetCostGuardForTests();
  });

  it("getCostGuard returns the same instance across calls", () => {
    _resetCostGuardForTests();
    const a = getCostGuard();
    const b = getCostGuard();
    expect(a).toBe(b);
  });

  it("_setCostGuardForTests installs a custom instance", () => {
    const custom = new CostGuard({
      ledgerPath: tmpLedger(),
      now: () => FIXED_NOW,
      disabled: true,
    });
    _setCostGuardForTests(custom);
    expect(getCostGuard()).toBe(custom);
    fs.rmSync(path.dirname(custom.snapshot().ledgerPath), {
      recursive: true,
      force: true,
    });
  });

  it("_resetCostGuardForTests forces re-construction", () => {
    const a = getCostGuard();
    _resetCostGuardForTests();
    const b = getCostGuard();
    expect(a).not.toBe(b);
  });
});

/**
 * Cost-guard end-to-end integration test (T7a — closes RISK-REGISTER R7).
 *
 * What unit tests already cover (tests/cost-guard*.test.ts):
 *   - checkBudget / recordUsage / threshold logic per-method
 *   - Module-level singleton + AsyncLocalStorage scope
 *   - Concurrent recorders via file-lock (M9-3)
 *
 * What this integration test adds:
 *   - End-to-end: CostGuard with low cap → recordUsage pushes over
 *     limit → next checkBudget throws BudgetExceededError, blocking
 *     the next LLM call BEFORE the API is hit.
 *   - Cross-process semantics: ledger persists; a fresh CostGuard
 *     instance reading the same ledger path sees the accumulated
 *     usage (this is the model real CI workers experience when
 *     running parallel audits).
 *   - withCostRun AsyncLocalStorage isolation: parallel runs share
 *     the daily ledger but each run has its own independent run-cap
 *     budget.
 *
 * No real Anthropic API calls — we exercise the cost-guard hook
 * surface directly (the same surface llm.ts wires its
 * checkBudget/recordUsage calls to).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  BudgetExceededError,
  CostGuard,
  withCostRun,
} from "../../src/core/cost-guard.js";

let tmpDir: string;
let ledgerPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-guard-e2e-"));
  ledgerPath = path.join(tmpDir, "ledger.json");
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ─────────────────────────────────────────────────────────────
// End-to-end: low budget intercepts next LLM call
// ─────────────────────────────────────────────────────────────

describe("cost-guard e2e — low budget intercepts next LLM call", () => {
  it("checkBudget intercepts BEFORE next LLM call once cap reached", async () => {
    // Run cap = $0.001. Two small haiku calls each ~$0.0006 →
    // first call records OK (cumulative $0.0006 < cap), but second
    // call's recordUsage tips the cumulative to $0.0012 > cap.
    //
    // The "interception" happens at TWO surfaces depending on timing:
    //   (a) recordUsage itself throws AFTER recording when the new
    //       cumulative tips past cap — caller's try/catch catches it
    //       and abandons subsequent calls.
    //   (b) checkBudget() at the start of the NEXT call detects the
    //       prior over-cap state and throws BEFORE invoking the API.
    // Production llm.ts wires both; this test exercises both surfaces.
    const guard = new CostGuard({
      ledgerPath,
      limits: {
        maxRunUsd: 0.001,
        maxRunTokens: Number.POSITIVE_INFINITY,
        maxDailyUsd: 100,
        maxDailyTokens: Number.POSITIVE_INFINITY,
      },
    });

    await withCostRun(async () => {
      // Initial state: no usage yet; checkBudget passes.
      expect(() => guard.checkBudget()).not.toThrow();

      // First LLM call: 500 input + 200 output of haiku
      // = 500*$0.8/M + 200*$4/M = $0.0004 + $0.0008 = $0.0012 > $0.001 cap
      // recordUsage itself throws (post-record check tips over).
      expect(() =>
        guard.recordUsage("claude-haiku-4-5-20251001", 500, 200),
      ).toThrow(BudgetExceededError);

      // Even though recordUsage threw, the usage WAS still recorded
      // (post-record check). The next checkBudget therefore also
      // throws — this is the (b) surface that blocks the NEXT call
      // from hitting the API.
      expect(() => guard.checkBudget()).toThrow(BudgetExceededError);

      // Error carries actionable context for ops debugging.
      try {
        guard.checkBudget();
      } catch (err) {
        expect(err).toBeInstanceOf(BudgetExceededError);
        if (err instanceof BudgetExceededError) {
          expect(err.message).toMatch(/budget|cap|usd|exceed/i);
        }
      }
    });
  });

  it("ledger persists usage across CostGuard instances (cross-process simulation)", async () => {
    // Worker A: small usage well under both caps.
    const guardA = new CostGuard({
      ledgerPath,
      limits: {
        maxRunUsd: 1,
        maxRunTokens: Number.POSITIVE_INFINITY,
        maxDailyUsd: 0.005,
        maxDailyTokens: Number.POSITIVE_INFINITY,
      },
    });

    await withCostRun(async () => {
      // 1000 input + 500 output haiku = $0.0008 + $0.002 = $0.0028
      // — under $0.005 day cap, allowed.
      guardA.recordUsage("claude-haiku-4-5-20251001", 1000, 500);
    });

    // Ledger written to disk by worker A. Shape:
    //   { schema_version: string, days: Record<dateStr, DayEntry> }
    //   DayEntry { input_tokens, output_tokens, usd }
    expect(fs.existsSync(ledgerPath)).toBe(true);
    const ledgerJson = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as {
      schema_version: string;
      days: Record<
        string,
        { input_tokens: number; output_tokens: number; usd: number }
      >;
    };
    expect(ledgerJson.schema_version).toBe("1.0.0");
    const dayKeys = Object.keys(ledgerJson.days);
    expect(dayKeys.length).toBe(1);
    const todayEntry = ledgerJson.days[dayKeys[0]!]!;
    expect(todayEntry.usd).toBeGreaterThan(0);
    expect(todayEntry.input_tokens).toBe(1000);
    expect(todayEntry.output_tokens).toBe(500);

    // Worker B starts fresh — reads the same ledger path.
    const guardB = new CostGuard({
      ledgerPath,
      limits: {
        maxRunUsd: 1,
        maxRunTokens: Number.POSITIVE_INFINITY,
        maxDailyUsd: 0.005, // same day cap, partly consumed by A
        maxDailyTokens: Number.POSITIVE_INFINITY,
      },
    });

    // Worker B: a smaller call that ALONE would fit the day cap, but
    // combined with worker A's prior usage tips the day-cap.
    // 1000 input + 500 output haiku again = $0.0028. Cumulative day
    // total = $0.0056 > $0.005 day cap → recordUsage throws.
    await withCostRun(async () => {
      expect(() =>
        guardB.recordUsage("claude-haiku-4-5-20251001", 1000, 500),
      ).toThrow(BudgetExceededError);
    });
  });

  it("withCostRun isolates per-run cap across parallel audits sharing daily ledger", async () => {
    const guard = new CostGuard({
      ledgerPath,
      limits: {
        maxRunUsd: 0.005, // $0.005 per-run
        maxRunTokens: Number.POSITIVE_INFINITY,
        maxDailyUsd: 100,
        maxDailyTokens: Number.POSITIVE_INFINITY,
      },
    });

    let runAPassedAfterRunBOver = false;
    let runBExceeded = false;

    // Run A and Run B concurrently. Each has its own withCostRun
    // scope; their per-run usd is isolated even though they share
    // the daily ledger.
    await Promise.all([
      withCostRun(async () => {
        // Run A: tiny usage well under per-run cap
        guard.recordUsage("claude-haiku-4-5-20251001", 100, 50);
        await new Promise((r) => setTimeout(r, 50));
        // Run A's per-run still has plenty of budget
        try {
          guard.checkBudget();
          runAPassedAfterRunBOver = true;
        } catch {
          runAPassedAfterRunBOver = false;
        }
      }),
      withCostRun(async () => {
        // Run B: usage that busts per-run cap.
        // 5000 input + 2000 output haiku = $0.004 + $0.008 = $0.012
        // > $0.005 per-run → recordUsage throws.
        try {
          guard.recordUsage("claude-haiku-4-5-20251001", 5000, 2000);
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            runBExceeded = true;
          }
        }
      }),
    ]);

    // Run B's per-run cap was tripped…
    expect(runBExceeded).toBe(true);
    // …but Run A's per-run cap is independent — its checkBudget passes.
    expect(runAPassedAfterRunBOver).toBe(true);
  });
});

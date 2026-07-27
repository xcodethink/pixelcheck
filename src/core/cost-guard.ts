/**
 * Cost guard — process-wide token / USD spending caps with a persistent
 * daily ledger (M5-6).
 *
 * Two layers of protection:
 *
 *   - per-run    — cap on a single audit / MCP tool invocation.
 *                  resetRun() is called at runner / MCP entry; counters
 *                  are kept in memory for the life of that run.
 *
 *   - per-day    — cap on UTC-day total across every process. Persisted
 *                  to a JSON ledger so concurrent / sequential processes
 *                  share the same wallet. Last-write-wins on the file
 *                  (acceptable for a single-developer local tool).
 *
 * Each LLM call site must do:
 *
 *     const guard = getCostGuard();
 *     guard.checkBudget();                  // throws if already over
 *     const resp = await client.messages.create(...);
 *     guard.recordUsage(model, in, out);    // throws if this call put us over
 *
 * recordUsage may also throw (post-call) when a single response straddles
 * the limit; that's intentional — downstream code should treat the response
 * as the last one allowed and stop the loop.
 *
 * Disabling: set AUDIT_COST_GUARD_DISABLED=1 to make every method a no-op
 * (used by `npm test` so unit tests never touch the real ledger).
 *
 * Ledger schema (versioned via M9-2 conventions):
 *
 *     {
 *       "schema_version": "1.0.0",
 *       "days": {
 *         "2026-04-28": {
 *           "input_tokens":  12345,
 *           "output_tokens": 6789,
 *           "usd":           0.123
 *         },
 *         ...
 *       }
 *     }
 *
 * The ledger auto-prunes entries older than LEDGER_RETENTION_DAYS at load
 * time so the file never grows unbounded.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { estimateCost } from "./llm.js";
import { withFileLockSync } from "./file-lock.js";
import { pixelcheckHome } from "./home-dir.js";
import { getLogger } from "./logger.js";

const log = getLogger("cost-guard");

export const COST_LEDGER_SCHEMA_VERSION = "1.0.0";

const LEDGER_RETENTION_DAYS = 30;

const DEFAULT_MAX_RUN_USD = 5.0;
const DEFAULT_MAX_RUN_TOKENS = 10_000_000;
const DEFAULT_MAX_DAILY_USD = 50.0;
const DEFAULT_MAX_DAILY_TOKENS = 100_000_000;

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type BudgetExceededKind =
  | "run-usd"
  | "run-tokens"
  | "daily-usd"
  | "daily-tokens";

export class BudgetExceededError extends Error {
  constructor(
    public readonly kind: BudgetExceededKind,
    public readonly current: number,
    public readonly limit: number,
  ) {
    super(
      `Cost guard tripped: ${kind} ${formatValue(kind, current)} ` +
        `exceeds limit ${formatValue(kind, limit)}. ` +
        `Set AUDIT_COST_MAX_${kindEnv(kind)} or AUDIT_COST_GUARD_DISABLED=1 to override.`,
    );
    this.name = "BudgetExceededError";
  }
}

function formatValue(kind: BudgetExceededKind, n: number): string {
  if (kind === "run-usd" || kind === "daily-usd") return `$${n.toFixed(4)}`;
  return `${n.toLocaleString("en-US")} tokens`;
}

function kindEnv(kind: BudgetExceededKind): string {
  return (
    {
      "run-usd": "RUN_USD",
      "run-tokens": "RUN_TOKENS",
      "daily-usd": "DAILY_USD",
      "daily-tokens": "DAILY_TOKENS",
    } as Record<BudgetExceededKind, string>
  )[kind];
}

export interface CostGuardLimits {
  maxRunUsd: number;
  maxRunTokens: number;
  maxDailyUsd: number;
  maxDailyTokens: number;
}

export interface DayEntry {
  input_tokens: number;
  output_tokens: number;
  usd: number;
}

export interface LedgerSnapshot {
  schema_version: string;
  days: Record<string, DayEntry>;
}

export interface RunSnapshot {
  startedAt: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface CostGuardSnapshot {
  disabled: boolean;
  limits: CostGuardLimits;
  run: RunSnapshot;
  today: DayEntry & { date: string };
  ledgerPath: string;
}

export interface CostGuardOptions {
  ledgerPath?: string;
  limits?: Partial<CostGuardLimits>;
  /** Test seam: override the clock used for "today" calculations. */
  now?: () => Date;
  /** Test seam: force-disable persistence. */
  disabled?: boolean;
}

// ─────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────

function defaultLedgerPath(): string {
  const env = process.env.AUDIT_COST_LEDGER_PATH;
  if (env && env.length > 0) return env;
  return path.join(pixelcheckHome(), "cost-ledger.json");
}

function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function defaultLimits(): CostGuardLimits {
  return {
    maxRunUsd: readEnvNumber("AUDIT_COST_MAX_RUN_USD", DEFAULT_MAX_RUN_USD),
    maxRunTokens: readEnvNumber(
      "AUDIT_COST_MAX_RUN_TOKENS",
      DEFAULT_MAX_RUN_TOKENS,
    ),
    maxDailyUsd: readEnvNumber(
      "AUDIT_COST_MAX_DAILY_USD",
      DEFAULT_MAX_DAILY_USD,
    ),
    maxDailyTokens: readEnvNumber(
      "AUDIT_COST_MAX_DAILY_TOKENS",
      DEFAULT_MAX_DAILY_TOKENS,
    ),
  };
}

function isDisabledByEnv(): boolean {
  const v = (process.env.AUDIT_COST_GUARD_DISABLED ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function todayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function emptyDay(): DayEntry {
  return { input_tokens: 0, output_tokens: 0, usd: 0 };
}

function emptyRun(now: Date): RunSnapshot {
  return {
    startedAt: now.toISOString(),
    inputTokens: 0,
    outputTokens: 0,
    usd: 0,
  };
}

function loadLedger(filePath: string): LedgerSnapshot {
  try {
    if (!fs.existsSync(filePath)) {
      return { schema_version: COST_LEDGER_SCHEMA_VERSION, days: {} };
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<LedgerSnapshot> | null;
    if (!parsed || typeof parsed !== "object" || !parsed.days) {
      return { schema_version: COST_LEDGER_SCHEMA_VERSION, days: {} };
    }
    return {
      schema_version: parsed.schema_version ?? COST_LEDGER_SCHEMA_VERSION,
      days: parsed.days,
    };
  } catch (err) {
    log.warn(
      { filePath, err: err instanceof Error ? err.message : String(err) },
      "ledger load failed — starting fresh",
    );
    return { schema_version: COST_LEDGER_SCHEMA_VERSION, days: {} };
  }
}

function pruneLedger(ledger: LedgerSnapshot, now: Date): LedgerSnapshot {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - LEDGER_RETENTION_DAYS);
  const cutoffKey = todayKey(cutoff);
  const kept: Record<string, DayEntry> = {};
  for (const [day, entry] of Object.entries(ledger.days)) {
    if (day >= cutoffKey) kept[day] = entry;
  }
  return { schema_version: ledger.schema_version, days: kept };
}

function writeLedgerAtomic(filePath: string, ledger: LedgerSnapshot): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

/**
 * AsyncLocalStorage holding the per-run counters for the currently
 * executing audit / MCP tool call. When set, all checkBudget /
 * recordUsage calls in that async context use THIS object instead of
 * the singleton's fallback `run` field. This is what makes a single
 * MCP server process safely serve concurrent tool calls — each
 * dispatch wraps its work in `withCostRun()` and gets its own private
 * counters.
 *
 * When unset (eg. unit tests that exercise CostGuard directly without
 * a wrapping run scope), `cost-guard.run` falls back to the instance's
 * own field. Behaviour matches the pre-M9-3 API.
 */
const runScope = new AsyncLocalStorage<RunSnapshot>();

/**
 * Run `fn` with a fresh per-run cost-guard counter scope.
 *
 *   await withCostRun(() => runAudit(opts))
 *   await withCostRun(() => mcpToolHandler(args))
 *
 * Inside `fn`, every getCostGuard().checkBudget() / .recordUsage()
 * sees a private RunSnapshot. Sibling calls running in parallel get
 * their own scopes and never interfere.
 */
export function withCostRun<T>(fn: () => T | Promise<T>): Promise<T> {
  const fresh = emptyRun(new Date());
  return Promise.resolve(runScope.run(fresh, fn));
}

/** Test-only: peek at the currently active run scope, if any. */
export function _getActiveRunScopeForTests(): RunSnapshot | undefined {
  return runScope.getStore();
}

export class CostGuard {
  private readonly ledgerPath: string;
  private readonly lockPath: string;
  private limits: CostGuardLimits;
  private readonly now: () => Date;
  private disabled: boolean;
  private fallbackRun: RunSnapshot;

  constructor(opts: CostGuardOptions = {}) {
    this.ledgerPath = opts.ledgerPath ?? defaultLedgerPath();
    this.lockPath = `${this.ledgerPath}.lock`;
    this.limits = { ...defaultLimits(), ...(opts.limits ?? {}) };
    this.now = opts.now ?? (() => new Date());
    this.disabled = opts.disabled ?? isDisabledByEnv();
    this.fallbackRun = emptyRun(this.now());
  }

  /**
   * The active per-run snapshot. Prefers the AsyncLocalStorage scope
   * (set by withCostRun) and falls back to the instance's own field
   * for callers that haven't wrapped themselves in a scope (eg. unit
   * tests exercising the class directly).
   */
  private get run(): RunSnapshot {
    return runScope.getStore() ?? this.fallbackRun;
  }

  /**
   * Reset per-run counters.
   *
   * - With an active withCostRun scope: mutates the scope's snapshot
   *   in place (zeros out the four counter fields, refreshes
   *   startedAt). The scope object identity is preserved so other
   *   refs in the same async context still see the reset.
   * - Without a scope: resets this.fallbackRun (legacy behaviour).
   *
   * Most callers no longer need to call this directly — withCostRun
   * already starts each scope with fresh counters. resetRun() is
   * still wired at runner / MCP entry as a belt-and-suspenders
   * (zeroes the fallback when no scope is active, eg. CLI without
   * MCP wrapping).
   */
  resetRun(): void {
    const fresh = emptyRun(this.now());
    const scope = runScope.getStore();
    if (scope) {
      scope.startedAt = fresh.startedAt;
      scope.inputTokens = fresh.inputTokens;
      scope.outputTokens = fresh.outputTokens;
      scope.usd = fresh.usd;
      return;
    }
    this.fallbackRun = fresh;
  }

  /**
   * Verify spend is below all four caps. Throws BudgetExceededError if
   * already at or over the limit. Cheap — no IO under the lock; reads
   * the ledger once but does not mutate.
   */
  checkBudget(): void {
    if (this.disabled) return;
    const runSnap = this.run;
    if (runSnap.usd >= this.limits.maxRunUsd) {
      throw new BudgetExceededError(
        "run-usd",
        runSnap.usd,
        this.limits.maxRunUsd,
      );
    }
    const runTokens = runSnap.inputTokens + runSnap.outputTokens;
    if (runTokens >= this.limits.maxRunTokens) {
      throw new BudgetExceededError(
        "run-tokens",
        runTokens,
        this.limits.maxRunTokens,
      );
    }
    const today = this.readToday();
    if (today.usd >= this.limits.maxDailyUsd) {
      throw new BudgetExceededError(
        "daily-usd",
        today.usd,
        this.limits.maxDailyUsd,
      );
    }
    const dayTokens = today.input_tokens + today.output_tokens;
    if (dayTokens >= this.limits.maxDailyTokens) {
      throw new BudgetExceededError(
        "daily-tokens",
        dayTokens,
        this.limits.maxDailyTokens,
      );
    }
  }

  /**
   * Record an LLM call's usage. Persists to the ledger and bumps in-memory
   * run counters. Throws BudgetExceededError if this call put us at or over
   * any cap (so the caller can stop downstream loops immediately).
   */
  recordUsage(
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): { usd: number; runUsd: number; dailyUsd: number } {
    const usd = estimateCost(model, inputTokens, outputTokens);
    if (this.disabled) {
      return { usd, runUsd: 0, dailyUsd: 0 };
    }

    const runSnap = this.run;
    // Update run counters (in-memory; per-scope when ALS is active)
    runSnap.inputTokens += inputTokens;
    runSnap.outputTokens += outputTokens;
    runSnap.usd += usd;

    // Update day counter (persistent). Hold the ledger lock for the whole
    // read-modify-write so concurrent processes never lose updates. The
    // file lock is process-wide; in-process serialization is provided by
    // the lock as well (only one withFileLockSync can hold a given path
    // at a time within the same process either).
    const dayKey = todayKey(this.now());
    let dayUsdAfter = 0;
    let dayTokensAfter = 0;
    try {
      // 30s lock-acquire budget (default 5s) — withFileLockSync's default is
      // tuned for low contention; cost-guard ledger writes can be hit by 10+
      // concurrent processes (3-child cross-process race test, plus 12-worker
      // vitest matrices, plus real audit fan-out). 30s gives the lock
      // exponential backoff (max 100ms) ~300 retries to find a window.
      withFileLockSync(
        this.lockPath,
        () => {
          const ledger = pruneLedger(loadLedger(this.ledgerPath), this.now());
          const day = ledger.days[dayKey] ?? emptyDay();
          day.input_tokens += inputTokens;
          day.output_tokens += outputTokens;
          day.usd += usd;
          ledger.days[dayKey] = day;
          ledger.schema_version = COST_LEDGER_SCHEMA_VERSION;
          writeLedgerAtomic(this.ledgerPath, ledger);
          dayUsdAfter = day.usd;
          dayTokensAfter = day.input_tokens + day.output_tokens;
        },
        { timeoutMs: 30_000 },
      );
    } catch (err) {
      // The ledger WRITE failed (lock timeout / fs error) so this call's spend
      // was not persisted. Leaving dayUsdAfter at 0 would silently BYPASS the
      // daily cap (it reads "0 spent today" → never fires). Best-effort re-read
      // the ledger (lockless) and add this call's delta so the cap still tracks
      // approximately rather than fail-open on contention. (Audit 2026-06-02 E4.)
      try {
        const today = this.readToday();
        dayUsdAfter = today.usd + usd;
        dayTokensAfter =
          today.input_tokens + today.output_tokens + inputTokens + outputTokens;
      } catch {
        dayUsdAfter = usd;
        dayTokensAfter = inputTokens + outputTokens;
      }
      log.warn(
        {
          filePath: this.ledgerPath,
          err: err instanceof Error ? err.message : String(err),
          estimatedDayUsd: dayUsdAfter,
        },
        "ledger write failed — daily cap using best-effort estimate (not bypassed)",
      );
    }

    log.debug(
      {
        model,
        inputTokens,
        outputTokens,
        usd,
        runUsd: runSnap.usd,
        dailyUsd: dayUsdAfter,
      },
      "llm usage recorded",
    );

    // Post-call enforcement: if THIS call straddled the limit, throw so the
    // downstream loop stops here (the response itself is still returned to
    // the caller; only the next iteration is blocked).
    const runTokens = runSnap.inputTokens + runSnap.outputTokens;
    if (runSnap.usd > this.limits.maxRunUsd) {
      log.warn(
        { runUsd: runSnap.usd, limit: this.limits.maxRunUsd },
        "run usd cap exceeded after this call",
      );
      throw new BudgetExceededError(
        "run-usd",
        runSnap.usd,
        this.limits.maxRunUsd,
      );
    }
    if (runTokens > this.limits.maxRunTokens) {
      log.warn(
        { runTokens, limit: this.limits.maxRunTokens },
        "run token cap exceeded after this call",
      );
      throw new BudgetExceededError(
        "run-tokens",
        runTokens,
        this.limits.maxRunTokens,
      );
    }
    if (dayUsdAfter > this.limits.maxDailyUsd) {
      log.warn(
        { dayUsd: dayUsdAfter, limit: this.limits.maxDailyUsd },
        "daily usd cap exceeded after this call",
      );
      throw new BudgetExceededError(
        "daily-usd",
        dayUsdAfter,
        this.limits.maxDailyUsd,
      );
    }
    if (dayTokensAfter > this.limits.maxDailyTokens) {
      log.warn(
        { dayTokens: dayTokensAfter, limit: this.limits.maxDailyTokens },
        "daily token cap exceeded after this call",
      );
      throw new BudgetExceededError(
        "daily-tokens",
        dayTokensAfter,
        this.limits.maxDailyTokens,
      );
    }

    return { usd, runUsd: runSnap.usd, dailyUsd: dayUsdAfter };
  }

  /** Read the current day's totals without mutating. */
  private readToday(): DayEntry {
    const dayKey = todayKey(this.now());
    const ledger = loadLedger(this.ledgerPath);
    return ledger.days[dayKey] ?? emptyDay();
  }

  snapshot(): CostGuardSnapshot {
    const dayKey = todayKey(this.now());
    return {
      disabled: this.disabled,
      limits: { ...this.limits },
      run: { ...this.run },
      today: { date: dayKey, ...this.readToday() },
      ledgerPath: this.ledgerPath,
    };
  }

  /** Test-only: expose the resolved lockfile path. */
  _getLockPathForTests(): string {
    return this.lockPath;
  }

  /** Test-only: replace limits at runtime. */
  _setLimitsForTests(limits: Partial<CostGuardLimits>): void {
    this.limits = { ...this.limits, ...limits };
  }

  /** Test-only: toggle disabled flag. */
  _setDisabledForTests(disabled: boolean): void {
    this.disabled = disabled;
  }
}

// ─────────────────────────────────────────────────────────────
// Singleton accessor
// ─────────────────────────────────────────────────────────────

let singleton: CostGuard | null = null;

export function getCostGuard(): CostGuard {
  if (!singleton) singleton = new CostGuard();
  return singleton;
}

/** Test-only: replace the singleton with a custom instance. */
export function _setCostGuardForTests(guard: CostGuard | null): void {
  singleton = guard;
}

/** Test-only: clear the singleton (so the next access reads fresh env). */
export function _resetCostGuardForTests(): void {
  singleton = null;
}

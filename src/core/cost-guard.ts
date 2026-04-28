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
import * as os from "node:os";
import * as path from "node:path";
import { estimateCost } from "./llm.js";
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
  return path.join(os.homedir(), ".ai-browser-auditor", "cost-ledger.json");
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

export class CostGuard {
  private readonly ledgerPath: string;
  private limits: CostGuardLimits;
  private readonly now: () => Date;
  private disabled: boolean;
  private run: RunSnapshot;

  constructor(opts: CostGuardOptions = {}) {
    this.ledgerPath = opts.ledgerPath ?? defaultLedgerPath();
    this.limits = { ...defaultLimits(), ...(opts.limits ?? {}) };
    this.now = opts.now ?? (() => new Date());
    this.disabled = opts.disabled ?? isDisabledByEnv();
    this.run = emptyRun(this.now());
  }

  /** Reset per-run counters. Call at the start of each audit / MCP tool call. */
  resetRun(): void {
    this.run = emptyRun(this.now());
  }

  /**
   * Verify spend is below all four caps. Throws BudgetExceededError if
   * already at or over the limit. Cheap — no IO.
   */
  checkBudget(): void {
    if (this.disabled) return;
    if (this.run.usd >= this.limits.maxRunUsd) {
      throw new BudgetExceededError(
        "run-usd",
        this.run.usd,
        this.limits.maxRunUsd,
      );
    }
    const runTokens = this.run.inputTokens + this.run.outputTokens;
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

    // Update run counters (in-memory)
    this.run.inputTokens += inputTokens;
    this.run.outputTokens += outputTokens;
    this.run.usd += usd;

    // Update day counter (persistent)
    const dayKey = todayKey(this.now());
    const ledger = pruneLedger(loadLedger(this.ledgerPath), this.now());
    const day = ledger.days[dayKey] ?? emptyDay();
    day.input_tokens += inputTokens;
    day.output_tokens += outputTokens;
    day.usd += usd;
    ledger.days[dayKey] = day;
    ledger.schema_version = COST_LEDGER_SCHEMA_VERSION;
    try {
      writeLedgerAtomic(this.ledgerPath, ledger);
    } catch (err) {
      log.warn(
        {
          filePath: this.ledgerPath,
          err: err instanceof Error ? err.message : String(err),
        },
        "ledger write failed — continuing with in-memory state",
      );
    }

    log.debug(
      {
        model,
        inputTokens,
        outputTokens,
        usd,
        runUsd: this.run.usd,
        dailyUsd: day.usd,
      },
      "llm usage recorded",
    );

    // Post-call enforcement: if THIS call straddled the limit, throw so the
    // downstream loop stops here (the response itself is still returned to
    // the caller; only the next iteration is blocked).
    const runTokens = this.run.inputTokens + this.run.outputTokens;
    const dayTokens = day.input_tokens + day.output_tokens;
    if (this.run.usd > this.limits.maxRunUsd) {
      log.warn(
        { runUsd: this.run.usd, limit: this.limits.maxRunUsd },
        "run usd cap exceeded after this call",
      );
      throw new BudgetExceededError(
        "run-usd",
        this.run.usd,
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
    if (day.usd > this.limits.maxDailyUsd) {
      log.warn(
        { dayUsd: day.usd, limit: this.limits.maxDailyUsd },
        "daily usd cap exceeded after this call",
      );
      throw new BudgetExceededError(
        "daily-usd",
        day.usd,
        this.limits.maxDailyUsd,
      );
    }
    if (dayTokens > this.limits.maxDailyTokens) {
      log.warn(
        { dayTokens, limit: this.limits.maxDailyTokens },
        "daily token cap exceeded after this call",
      );
      throw new BudgetExceededError(
        "daily-tokens",
        dayTokens,
        this.limits.maxDailyTokens,
      );
    }

    return { usd, runUsd: this.run.usd, dailyUsd: day.usd };
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

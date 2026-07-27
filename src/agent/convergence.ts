/**
 * Convergence Detector — Detects loops, stuck states, and completion.
 *
 * Three detection mechanisms:
 * 1. Loop detection: same (url, dom_hash, instruction) appearing 3+ times
 * 2. Stuck detection: N consecutive failures triggers replan signal
 * 3. Completion detection: all success criteria met
 */

import * as crypto from "node:crypto";
import type { Page } from "playwright";
import type { SuccessCriterion } from "../core/types.js";
import { callVision } from "../core/llm.js";
import { NetworkSignalCollector, type NetworkMatcher } from "./signals/network.js";
import {
  PerformanceSignalCollector,
  matchPerformance,
  type PerformanceExpectation,
} from "./signals/performance.js";
import {
  ErrorSignalCollector,
  matchErrors,
  type ErrorExpectation,
} from "./signals/errors.js";
import {
  diffSnapshots,
  matchInteraction,
  takeSnapshot,
  type InteractionExpectation,
  type PageSnapshot,
} from "./signals/interaction.js";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface ActionRecord {
  url: string;
  instruction: string;
  dom_fingerprint: string;
  success: boolean;
}

export type ConvergenceSignal =
  | { type: "continue" }
  | { type: "loop_detected"; repeated_hash: string }
  | { type: "stuck"; consecutive_failures: number }
  | { type: "goal_met" }
  | { type: "budget_exceeded"; spent: number; cap: number }
  | { type: "max_actions"; count: number; limit: number }
  // Terminal: the page state (url + DOM fingerprint) has not advanced for N
  // consecutive actions regardless of per-action success — the agent is stuck
  // (e.g. fill→click→fill→click on a login wall that never navigates). Distinct
  // from loop_detected (which replans); this ends the unit so we stop burning
  // budget. (Audit 2026-06-02 D2-C1.)
  | { type: "no_progress"; actions: number };

// ─────────────────────────────────────────────────────────────
// Convergence Tracker
// ─────────────────────────────────────────────────────────────

export class ConvergenceTracker {
  private _history: ActionRecord[] = [];
  private _hashCounts = new Map<string, number>();
  private _consecutiveFailures = 0;
  private _totalActions = 0;

  // Stasis tracking: consecutive actions on an unchanged (url + DOM) state.
  private _lastStateKey: string | null = null;
  private _noProgressCount = 0;

  constructor(
    private _replanThreshold: number = 3,
    private _loopThreshold: number = 3,
    // High by design: legitimate multi-field forms produce several actions on a
    // structurally-stable page (the fingerprint ignores input values), but are
    // bounded; a genuinely stuck loop is unbounded. 8 clears normal forms while
    // still cutting the 26-step login-wall loop short.
    private _noProgressThreshold: number = 8,
  ) {}

  get totalActions(): number {
    return this._totalActions;
  }

  get consecutiveFailures(): number {
    return this._consecutiveFailures;
  }

  /**
   * Record an action and check for convergence signals.
   */
  recordAction(record: ActionRecord): ConvergenceSignal {
    this._history.push(record);
    // Cap history to prevent unbounded memory growth
    if (this._history.length > 100) this._history.shift();
    this._totalActions++;

    if (record.success) {
      this._consecutiveFailures = 0;
    } else {
      this._consecutiveFailures++;
    }

    // Stasis: track consecutive actions where the page state did not advance.
    // Independent of per-action success and of the (LLM-authored) instruction
    // text, so a fill→click→fill→click loop on a non-navigating page is caught
    // even though each "fill" reports success and each instruction differs.
    const stateKey = `${record.url}|${record.dom_fingerprint}`;
    if (stateKey === this._lastStateKey) {
      this._noProgressCount++;
    } else {
      this._noProgressCount = 0;
      this._lastStateKey = stateKey;
    }
    if (this._noProgressCount >= this._noProgressThreshold) {
      return { type: "no_progress", actions: this._noProgressCount + 1 };
    }

    // Check for loop
    const hash = this._hashAction(record);
    const count = (this._hashCounts.get(hash) ?? 0) + 1;
    this._hashCounts.set(hash, count);

    if (count >= this._loopThreshold) {
      return { type: "loop_detected", repeated_hash: hash };
    }

    // Check for stuck
    if (this._consecutiveFailures >= this._replanThreshold) {
      return { type: "stuck", consecutive_failures: this._consecutiveFailures };
    }

    return { type: "continue" };
  }

  /**
   * Reset consecutive failure counter (e.g., after a successful replan).
   */
  resetFailures(): void {
    this._consecutiveFailures = 0;
  }

  /**
   * Check budget and action limits.
   */
  checkLimits(
    currentCost: number,
    budgetCap: number,
    maxActions: number,
  ): ConvergenceSignal {
    if (currentCost >= budgetCap) {
      return { type: "budget_exceeded", spent: currentCost, cap: budgetCap };
    }
    if (this._totalActions >= maxActions) {
      return { type: "max_actions", count: this._totalActions, limit: maxActions };
    }
    return { type: "continue" };
  }

  private _hashAction(record: ActionRecord): string {
    const data = `${record.url}|${record.dom_fingerprint}|${record.instruction}`;
    return crypto.createHash("md5").update(data).digest("hex").slice(0, 12);
  }
}

// ─────────────────────────────────────────────────────────────
// Criteria Checking
// ─────────────────────────────────────────────────────────────

export interface CriteriaState {
  met: Set<string>;
  pending: Set<string>;
  criteria: SuccessCriterion[];
}

export function initCriteriaState(criteria: SuccessCriterion[]): CriteriaState {
  return {
    met: new Set(),
    pending: new Set(criteria.map((c) => c.id)),
    criteria,
  };
}

export function allCriteriaMet(state: CriteriaState): boolean {
  return state.pending.size === 0;
}

/**
 * Check a single DOM-based criterion against the current page.
 * Zero LLM cost.
 */
export async function checkDomCriterion(
  criterion: SuccessCriterion,
  page: Page,
): Promise<boolean> {
  if (criterion.verification !== "dom" || !criterion.selector) return false;

  try {
    const locator = page.locator(criterion.selector);
    const expected = criterion.expected ?? {};

    if (expected.visible !== undefined) {
      const isVisible = await locator.first().isVisible().catch(() => false);
      if (isVisible !== expected.visible) return false;
    }

    if (expected.text_contains !== undefined) {
      const text = (await locator.first().textContent().catch(() => null)) ?? "";
      if (!text.includes(expected.text_contains)) return false;
    }

    // If no expected conditions specified, just check element exists and is visible
    if (expected.visible === undefined && expected.text_contains === undefined) {
      const count = await locator.count();
      return count > 0;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Check an extract-based criterion.
 * Zero LLM cost — uses regex matching.
 */
export async function checkExtractCriterion(
  criterion: SuccessCriterion,
  page: Page,
): Promise<boolean> {
  if (criterion.verification !== "extract") return false;
  if (!criterion.extract_instruction || !criterion.expected_pattern) return false;

  try {
    // Simple text extraction from page
    const text = await page.evaluate(() => document.body.innerText);
    const pattern = new RegExp(criterion.expected_pattern);
    return pattern.test(text);
  } catch {
    return false;
  }
}

/**
 * Check a visual criterion using Claude Vision.
 * Cost: ~$0.014 per check.
 */
export async function checkVisualCriterion(
  criterion: SuccessCriterion,
  screenshotBase64: string,
  model: string,
  cost: { value: number },
): Promise<boolean> {
  if (criterion.verification !== "visual") return false;

  try {
    const response = await callVision({
      model,
      systemPrompt:
        "You are evaluating whether a success criterion is met based on a screenshot. " +
        "Answer with ONLY a JSON object: { \"met\": true } or { \"met\": false, \"reason\": \"...\" }",
      userPrompt: `Is this criterion met? "${criterion.description}"`,
      imageBase64: screenshotBase64,
      imageMediaType: "image/jpeg",
      maxTokens: 256,
    });

    cost.value += response.costUsd;

    const parsed = JSON.parse(
      response.text.match(/\{[\s\S]*\}/)?.[0] ?? '{"met": false}',
    ) as { met: boolean };
    return parsed.met === true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Signal-based criterion checkers (zero LLM cost)
// ─────────────────────────────────────────────────────────────

/**
 * Criterion checked against captured network traffic.
 * Uses the NetworkSignalCollector's findMatching() query API.
 */
export function checkNetworkCriterion(
  criterion: SuccessCriterion,
  network: NetworkSignalCollector,
): boolean {
  if (criterion.verification !== "network") return false;
  const exp = criterion.expected ?? {};
  const matcher: NetworkMatcher = {
    url_pattern: exp.url_pattern,
    method: exp.method,
    status_range: exp.status_range as [number, number] | undefined,
    max_duration_ms: exp.max_duration_ms,
  };
  const matches = network.findMatching(matcher);
  return matches.length > 0;
}

/**
 * Criterion checked against Core Web Vitals.
 * Reads current vitals from the PerformanceSignalCollector.
 */
export async function checkPerformanceCriterion(
  criterion: SuccessCriterion,
  perf: PerformanceSignalCollector,
): Promise<boolean> {
  if (criterion.verification !== "performance") return false;
  const exp = (criterion.expected ?? {}) as PerformanceExpectation;
  const signal = await perf.snapshot();
  return matchPerformance(signal, exp).met;
}

/**
 * Criterion checked against client-side errors.
 * The collector is expected to have been configured with any ignore patterns.
 */
export function checkErrorCriterion(
  criterion: SuccessCriterion,
  errors: ErrorSignalCollector,
): boolean {
  if (criterion.verification !== "error") return false;
  const exp = (criterion.expected ?? {}) as ErrorExpectation;
  if (exp.ignore_patterns && exp.ignore_patterns.length > 0) {
    errors.setIgnorePatterns(exp.ignore_patterns);
  }
  const signal = errors.snapshot();
  return matchErrors(signal, exp).met;
}

/**
 * Criterion checked against before/after interaction snapshots.
 * Expects a baseline snapshot provided by the caller (the agent loop takes one
 * before each action and passes it in when checking this criterion).
 */
export async function checkInteractionCriterion(
  criterion: SuccessCriterion,
  page: Page,
  baseline: PageSnapshot,
): Promise<boolean> {
  if (criterion.verification !== "interaction") return false;
  const after = await takeSnapshot(page);
  const diff = diffSnapshots(baseline, after);
  const exp = (criterion.expected ?? {}) as InteractionExpectation;
  return matchInteraction(diff, exp).met;
}

/**
 * Generate a compact DOM fingerprint for loop detection.
 * Hashes the set of interactive element signatures.
 */
export async function getDomFingerprint(page: Page): Promise<string> {
  try {
    const sig = await page.evaluate(() => {
      const els = document.querySelectorAll(
        'a, button, input, select, [role="button"]',
      );
      const sigs: string[] = [];
      for (const el of Array.from(els).slice(0, 30)) {
        sigs.push(
          `${el.tagName}#${el.id}.${el.className}:${(el.textContent ?? "").trim().slice(0, 20)}`,
        );
      }
      return sigs.sort().join("|");
    });
    return crypto.createHash("md5").update(sig).digest("hex").slice(0, 8);
  } catch {
    return "unknown";
  }
}

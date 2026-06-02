/**
 * VisualCollector — PR-D / ADR-034.
 *
 * Wraps the rubric-based vision call (already implemented inside the
 * `judge` primitive) so that the see / act / extract primitives can
 * surface a uniform `diagnostics.visual` field on their results without
 * duplicating prompt construction or JSON parsing.
 *
 * Why a wrapper, not a direct call to `judge()`:
 *   - `judge()` writes its own artifacts directory, computes its own
 *     cache key, and returns a fully-formed `JudgeResult`. That is the
 *     right shape for the standalone `judge` primitive but heavier than
 *     necessary when the only caller is "score the screenshot the host
 *     primitive already took". This collector reuses just the inner
 *     vision call (`runJudgeVision` from judge.ts), skipping screenshot
 *     re-capture, on-disk sidecars, and result-cache key derivation.
 *   - Returns a `VisualScoring` envelope (a normalised subset of
 *     JudgeResult) suitable for embedding inside DiagnosticsSchema.
 *   - Always-collect-never-skip rule from ADR-034 has one carve-out:
 *     visual scoring is the only diagnostics dimension that costs real
 *     LLM money (whitebox + performance are passive observers). The
 *     host primitive controls invocation via `cfg.visualScoring`
 *     (`'off'` default — explicit opt-in required).
 *
 * Invocation modes (caller's responsibility, not the collector's):
 *   - `'off'`   never invoke (default; matches "no surprise spend").
 *   - `'auto'`  invoke only when the caller already supplied a `goal`
 *               (host primitive was already going to make at least
 *               one vision call, so the visual scoring is bundled in).
 *   - `'eager'` invoke unconditionally (Wayne's "audit-completeness"
 *               extreme; full ADR-034 always-collect for visual too).
 *
 * Skip semantics: when the host decides not to invoke, it can still
 * call `skip(reason)` to emit a properly-shaped envelope explaining
 * why no scoring ran. That keeps `diagnostics.visual` discoverable as
 * "yes, this dimension was considered" rather than silently absent.
 */

import { getLogger } from "./logger.js";
import { callVision, type VisionResponse } from "./llm.js";
import {
  resolveCriteria,
  runJudgeVision,
  computeOverallScore,
  DEFAULT_JUDGE_MODEL,
} from "./primitives/judge.js";
import type {
  JudgeCriterionSpec,
  JudgeRubricKind,
  VisualScoring,
} from "./result-schema.js";

const log = getLogger("visual-collector");

export type VisualScoringMode = "off" | "auto" | "eager";

export interface VisualCollectorOptions {
  /** Built-in rubrics. Default: `["aesthetic"]`. */
  rubrics?: JudgeRubricKind[];
  /** Caller-supplied criteria appended after rubric criteria. */
  customCriteria?: Array<Omit<JudgeCriterionSpec, "kind">>;
  /** Vision model id. Default `DEFAULT_JUDGE_MODEL`. */
  model?: string;
  /** Test seam: replace the vision call. */
  callVisionImpl?: typeof callVision;
}

export type VisualSkipReason = NonNullable<VisualScoring["skip_reason"]>;

/**
 * Decide whether visual scoring should run for a host primitive call.
 *
 * Pure function so it can be exercised by tests without any LLM
 * activity. The host primitive is responsible for actually invoking
 * `score()` (or `skip()` with the reason returned here).
 */
export function shouldScore(args: {
  mode: VisualScoringMode | undefined;
  hasGoal: boolean;
}): { run: true } | { run: false; reason: VisualSkipReason } {
  const mode = args.mode ?? "off";
  if (mode === "off") return { run: false, reason: "config_off" };
  if (mode === "eager") return { run: true };
  // mode === 'auto'
  if (!args.hasGoal) return { run: false, reason: "no_goal" };
  return { run: true };
}

export class VisualCollector {
  private readonly rubrics: JudgeRubricKind[] | undefined;
  private readonly customCriteria:
    | Array<Omit<JudgeCriterionSpec, "kind">>
    | undefined;
  private readonly model: string;
  private readonly callVisionImpl: typeof callVision;

  constructor(opts: VisualCollectorOptions = {}) {
    this.rubrics = opts.rubrics;
    this.customCriteria = opts.customCriteria;
    this.model = opts.model ?? DEFAULT_JUDGE_MODEL;
    this.callVisionImpl = opts.callVisionImpl ?? callVision;
  }

  /**
   * Build a `VisualScoring` envelope explaining why no vision call ran.
   * Cost / duration are zero, verdicts / findings empty, but the field
   * is still emitted so downstream consumers see "we thought about it".
   */
  skip(reason: VisualSkipReason): VisualScoring {
    return {
      scored: false,
      skip_reason: reason,
      rubrics: [],
      verdicts: [],
      findings: [],
      overall_score: null,
      summary: null,
      cost_usd: 0,
      duration_ms: 0,
    };
  }

  /**
   * Run the rubric-based vision call against `buf` and emit a
   * `VisualScoring` envelope. Never throws — on failure returns a
   * `skip(reason='vision_error')` envelope so the host primitive's
   * own status is not contaminated by a diagnostics-only failure.
   */
  async score(buf: Buffer): Promise<VisualScoring> {
    const t0 = Date.now();

    let resolved: { criteria: JudgeCriterionSpec[]; rubrics: JudgeRubricKind[] };
    try {
      resolved = resolveCriteria({
        rubrics: this.rubrics,
        customCriteria: this.customCriteria,
      });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "visual-collector: rubric resolution failed",
      );
      return {
        ...this.skip("vision_error"),
        duration_ms: Date.now() - t0,
      };
    }

    let raw: Awaited<ReturnType<typeof runJudgeVision>>;
    try {
      raw = await runJudgeVision({
        criteria: resolved.criteria,
        buf,
        model: this.model,
        callVisionImpl: this.callVisionImpl,
      });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "visual-collector: vision call failed",
      );
      return {
        ...this.skip("vision_error"),
        rubrics: resolved.rubrics,
        model: this.model,
        duration_ms: Date.now() - t0,
      };
    }

    return buildVisualScoring({
      raw,
      criteria: resolved.criteria,
      rubrics: resolved.rubrics,
      model: this.model,
      durationMs: Date.now() - t0,
    });
  }
}

/**
 * Compose a `VisualScoring` envelope from the raw vision output. Lifted
 * out so the `judge` primitive can populate its own `diagnostics.visual`
 * mirror from data it already has, without re-running the vision call.
 */
export function buildVisualScoring(args: {
  raw: {
    verdicts: Array<{
      criterion_id: string;
      score: number;
      rationale: string;
      evidence: string[];
    }>;
    findings: Array<{
      severity: "critical" | "high" | "medium" | "low";
      criterion_id: string | null;
      description: string;
      location?: string;
      recommendation: string;
    }>;
    summary: string | null;
    costUsd: number;
    raw?: VisionResponse;
  };
  criteria: JudgeCriterionSpec[];
  rubrics: JudgeRubricKind[];
  model: string;
  durationMs: number;
}): VisualScoring {
  // Index criterion id → spec so we can attach label + kind to each
  // verdict (the diagnostics envelope is self-contained — no need to
  // join back to the rubric to render the report).
  const criterionById = new Map(args.criteria.map((c) => [c.id, c] as const));

  const verdicts: VisualScoring["verdicts"] = [];
  for (const v of args.raw.verdicts) {
    const spec = criterionById.get(v.criterion_id);
    if (!spec) continue; // judge.ts already drops unknown ids; defensive
    verdicts.push({
      criterion_id: v.criterion_id,
      label: spec.label,
      kind: spec.kind,
      score: v.score,
      rationale: v.rationale,
      evidence: v.evidence,
    });
  }

  return {
    scored: true,
    rubrics: args.rubrics,
    verdicts,
    findings: args.raw.findings.map((f) => ({
      severity: f.severity,
      criterion_id: f.criterion_id,
      description: f.description,
      location: f.location,
      recommendation: f.recommendation,
    })),
    overall_score: computeOverallScore(args.raw.verdicts, args.criteria.length),
    summary: args.raw.summary,
    model: args.model,
    cost_usd: args.raw.costUsd,
    duration_ms: args.durationMs,
  };
}

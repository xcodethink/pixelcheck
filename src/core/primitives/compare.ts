/**
 * `compare` primitive (N-3) — A/B page comparison primitive.
 *
 * Two modes:
 *   - `double_blind` (default): judges each side independently with the
 *     same rubric, then runs ONE synthesis vision call that sees both
 *     screenshots and emits per-criterion winners. 3 vision calls total
 *     (with the two judges parallelised, wall-clock ≈ 2 calls).
 *   - `fast`: 1 vision call sees both screenshots side-by-side and
 *     emits per-side scores + winners directly. Cheaper (~3× cheaper)
 *     but vulnerable to anchoring bias — the model's absolute scores
 *     get dragged toward the difference between the two sides.
 *
 * Why double-blind by default? Commercial UX-review practice (Nielsen
 * Norman, Baymard Institute) evaluates each candidate independently
 * before being compared, so absolute scores aren't contaminated by the
 * difference between the two pages. Same logic in code review,
 * scientific peer review, and legal evaluation. ADR-014 has the full
 * rationale and the rejected alternatives.
 *
 * Cost-guard: every vision call goes through `callVision`, which already
 * wires the daily ledger + AsyncLocalStorage per-run scope (M5-6 + M9-3).
 *
 * Test seams: `_judge` (replace per-side judge), `_callVision` (stub the
 * synthesis call). Production callers never set these.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { getLogger } from "../logger.js";
import { callVision, extractJson } from "../llm.js";
import { compressForVision } from "../image.js";
import { RESULT_SCHEMA_VERSION } from "../result-schema.js";
import type {
  CompareCriterionVerdict,
  CompareMode,
  CompareResultShape,
  CompareSide,
  CompareWinner,
  JudgeCriterionSpec,
  JudgeRubricKind,
  JudgeResultShape,
} from "../result-schema.js";
import {
  judge,
  resolveCriteria,
  type ExistingCapture,
  type JudgeOptions,
} from "./judge.js";
import type { SeePersonaHints, WaitFor } from "./see.js";

const log = getLogger("primitive.compare");

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

export interface CompareSideInput {
  /** Target URL. Either url or capture must be set. */
  url?: string;
  /** Pre-captured snapshot. Wins over url if both set. */
  capture?: ExistingCapture;
  /** Per-side persona hints forwarded to the upstream judge → see capture. */
  persona?: SeePersonaHints;
  /** Per-side viewport override (e.g. mobile vs desktop comparison). */
  viewport?: { width: number; height: number };
}

export interface CompareOptions {
  /** Side A. */
  a: CompareSideInput;
  /** Side B. */
  b: CompareSideInput;

  /** Strategy. Default `"double_blind"`. */
  mode?: CompareMode;

  /** Built-in rubrics to apply. Default `["aesthetic"]`. */
  rubrics?: JudgeRubricKind[];

  /** Caller-supplied custom criteria. Same shape as judge. */
  customCriteria?: Array<Omit<JudgeCriterionSpec, "kind">>;

  /** Shared see-style options forwarded to both sides if they capture. */
  waitFor?: WaitFor;
  fullPage?: boolean;
  includeDom?: boolean;
  includeConsole?: boolean;
  timeoutMs?: number;
  headless?: boolean;

  /** Per-call artifacts root. Default: `$AUDIT_COMPARES_DIR` or `~/.pixelcheck/compares/`. */
  artifactsRoot?: string;

  /** Vision model. Default `"claude-sonnet-4-6"`. */
  model?: string;

  /** Test seams. */
  _judge?: typeof judge;
  _callVision?: typeof callVision;
}

export type CompareResult = CompareResultShape;

// ─────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────

export const DEFAULT_COMPARE_MODE: CompareMode = "double_blind";
export const DEFAULT_COMPARE_MODEL = "claude-sonnet-4-6";

export function defaultCompareArtifactsRoot(): string {
  const envDir = process.env.AUDIT_COMPARES_DIR;
  if (envDir && envDir.length > 0) return envDir;
  const home =
    process.env.PIXELCHECK_HOME ??
    process.env.AUDIT_HOME ??
    path.join(os.homedir(), ".pixelcheck");
  return path.join(home, "compares");
}

function makeRunDir(root: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(3).toString("hex");
  const dir = path.join(root, `${ts}-${rand}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// ─────────────────────────────────────────────────────────────
// Synthesis prompt (used by both modes)
// ─────────────────────────────────────────────────────────────

export function buildCompareSystemPrompt(args: {
  criteria: JudgeCriterionSpec[];
  mode: CompareMode;
}): string {
  const criterionLines = args.criteria
    .map(
      (c) =>
        `  - id: ${c.id}\n    label: ${c.label}\n    kind: ${c.kind}\n    rubric: ${c.description}`,
    )
    .join("\n");

  const modeNote =
    args.mode === "double_blind"
      ? `You will be given TWO screenshots labelled SIDE A and SIDE B, plus the per-side judgements that were already made independently for each. Use the prior judgements as context, but emit your own winner for each criterion based on what you see in BOTH screenshots side by side.`
      : `You will be given TWO screenshots labelled SIDE A and SIDE B. Score each side on every criterion AND pick a winner per criterion in the same call.`;

  return `You are a senior product designer doing an A/B comparison of two web pages.

${modeNote}

For EACH criterion in the rubric, return a per_criterion entry:
- criterion_id: the exact id from the rubric (snake_case, never paraphrased)
- score_a: number 0..10 ${args.mode === "fast" ? "(REQUIRED — score side A on this criterion)" : "(may be null if you defer to the prior judgement of side A)"}
- score_b: number 0..10 ${args.mode === "fast" ? "(REQUIRED — score side B on this criterion)" : "(may be null if you defer to the prior judgement of side B)"}
- winner: "a" | "b" | "tie"
- rationale: ONE sentence grounded in observed evidence from BOTH sides (cite a specific element on each side that drove the verdict)

Also return:
- overall_winner: "a" | "b" | "tie" — across all criteria, which side wins overall? Tie if no clear majority.
- summary: 1-3 sentences describing the dominant difference between A and B (what you'd tell a designer in the corridor).

CRITICAL ANTI-HALLUCINATION RULES:
- ONLY report text you can ACTUALLY READ in the screenshots. Never guess what a typical landing page would say.
- Quote rendered text character for character in your rationale. Don't normalise.
- If a region is too small/blurry to read, say so rather than fabricating contents.
- For dark-pattern criteria: 10 = no dark pattern detected, 0 = blatant dark pattern. Don't invert direction.

You MUST return a single valid JSON object with this exact shape:
{
  "per_criterion": [
    { "criterion_id": "...", "score_a": 0..10|null, "score_b": 0..10|null, "winner": "a"|"b"|"tie", "rationale": "..." }
  ],
  "overall_winner": "a" | "b" | "tie",
  "summary": "..."
}

Rubric to compare on:
${criterionLines}

Return ONLY the JSON. No prose, no code fences. The per_criterion array MUST contain exactly one entry per criterion above (do not skip any). Use the exact criterion_id strings.`;
}

export function buildCompareUserPrompt(args: {
  criteria: JudgeCriterionSpec[];
  judgeA?: JudgeResultShape | null;
  judgeB?: JudgeResultShape | null;
}): string {
  const ids = args.criteria.map((c) => c.id).join(", ");
  const lines: string[] = [
    `Compare side A vs side B on these criteria: ${ids}.`,
    `Return JSON only matching the schema in the system prompt.`,
  ];
  if (args.judgeA && args.judgeB) {
    lines.push("");
    lines.push("Prior independent judgements (for context — you are not bound by them):");
    lines.push(`SIDE A overall_score: ${args.judgeA.overall_score ?? "n/a"}`);
    for (const v of args.judgeA.verdicts) {
      lines.push(`  A.${v.criterion_id}: ${v.score} — ${v.rationale}`);
    }
    lines.push(`SIDE B overall_score: ${args.judgeB.overall_score ?? "n/a"}`);
    for (const v of args.judgeB.verdicts) {
      lines.push(`  B.${v.criterion_id}: ${v.score} — ${v.rationale}`);
    }
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────
// Primitive
// ─────────────────────────────────────────────────────────────

export async function compare(opts: CompareOptions): Promise<CompareResult> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();

  if (!opts.a.url && !opts.a.capture) {
    throw new Error("compare: side A requires either `url` or `capture`");
  }
  if (!opts.b.url && !opts.b.capture) {
    throw new Error("compare: side B requires either `url` or `capture`");
  }

  const mode: CompareMode = opts.mode ?? DEFAULT_COMPARE_MODE;
  const { criteria, rubrics } = resolveCriteria({
    rubrics: opts.rubrics,
    customCriteria: opts.customCriteria,
  });
  const model = opts.model ?? DEFAULT_COMPARE_MODEL;

  const artifactsRoot = opts.artifactsRoot ?? defaultCompareArtifactsRoot();
  fs.mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 });
  const runDir = makeRunDir(artifactsRoot);
  const sideADir = path.join(runDir, "a");
  const sideBDir = path.join(runDir, "b");
  fs.mkdirSync(sideADir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sideBDir, { recursive: true, mode: 0o700 });

  const judgeImpl = opts._judge ?? judge;
  const callVisionImpl = opts._callVision ?? callVision;

  let costUsd = 0;
  let status: CompareResult["status"] = "ok";
  let errorMsg: string | undefined;
  let perCriterion: CompareCriterionVerdict[] = [];
  let overallWinner: CompareWinner = "tie";
  let summary: string | null = null;
  let judgeA: JudgeResultShape | null = null;
  let judgeB: JudgeResultShape | null = null;

  let sideACapture: ExistingCapture | null = opts.a.capture ?? null;
  let sideBCapture: ExistingCapture | null = opts.b.capture ?? null;

  try {
    if (mode === "double_blind") {
      // Double-blind: kick off both judges in parallel for wall-clock parity
      // with fast mode. Each judge can capture independently.
      const [resA, resB] = await Promise.all([
        judgeImpl(buildJudgeOpts(opts, "a", criteria, sideADir, model)),
        judgeImpl(buildJudgeOpts(opts, "b", criteria, sideBDir, model)),
      ]);
      judgeA = resA;
      judgeB = resB;
      costUsd += resA.cost_usd + resB.cost_usd;

      if (resA.status !== "ok") {
        throw new Error(`compare: side A judge failed: ${resA.error ?? "unknown"}`);
      }
      if (resB.status !== "ok") {
        throw new Error(`compare: side B judge failed: ${resB.error ?? "unknown"}`);
      }

      sideACapture = sideACapture ?? captureFromJudge(resA);
      sideBCapture = sideBCapture ?? captureFromJudge(resB);
    } else {
      // Fast mode: just ensure we have screenshots for both sides via judge's
      // upstream see; we still want DOM/console for the result envelope.
      // Run two see-only captures in parallel by piggybacking on judge with
      // an empty-vision stub — but that complicates ledger accounting. So
      // in fast mode we delegate capture to a lightweight inline path:
      // we directly call the upstream see via judge with an empty rubric
      // pass... actually simplest: just use judge with a stub that returns
      // empty verdicts AND skip the cost double-count. But cleaner:
      // require fast mode to receive captures (or run minimal see calls
      // ourselves below).
      const [capA, capB] = await Promise.all([
        ensureCapture(opts.a, sideADir, model, opts, judgeImpl),
        ensureCapture(opts.b, sideBDir, model, opts, judgeImpl),
      ]);
      sideACapture = capA;
      sideBCapture = capB;
    }

    // Synthesis vision call. Both modes share this step; double-blind passes
    // the prior judgements as context, fast mode emits the only scores here.
    if (!sideACapture || !sideBCapture) {
      throw new Error("compare: missing captures for synthesis call");
    }

    const synthesis = await runCompareSynthesis({
      criteria,
      mode,
      sideACapture,
      sideBCapture,
      judgeA,
      judgeB,
      model,
      callVisionImpl,
    });
    costUsd += synthesis.costUsd;
    perCriterion = synthesis.perCriterion;
    overallWinner = synthesis.overallWinner;
    summary = synthesis.summary;
  } catch (err) {
    status = "error";
    errorMsg = err instanceof Error ? err.message : String(err);
    log.warn(
      { err: errorMsg, runDir },
      "compare: failed",
    );
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - t0;

  const sideA: CompareSide = {
    url_input: sideACapture?.url_input ?? opts.a.url ?? "",
    url_final: sideACapture?.url_final ?? opts.a.url ?? "",
    title: sideACapture?.title ?? "",
    judge: judgeA,
    screenshot: judgeA?.screenshot ?? captureToScreenshot(sideACapture),
    artifacts_dir: judgeA?.artifacts_dir ?? sideADir,
  };
  const sideB: CompareSide = {
    url_input: sideBCapture?.url_input ?? opts.b.url ?? "",
    url_final: sideBCapture?.url_final ?? opts.b.url ?? "",
    title: sideBCapture?.title ?? "",
    judge: judgeB,
    screenshot: judgeB?.screenshot ?? captureToScreenshot(sideBCapture),
    artifacts_dir: judgeB?.artifacts_dir ?? sideBDir,
  };

  const result: CompareResult = {
    schema_version: RESULT_SCHEMA_VERSION,
    mode,
    rubrics,
    criteria,
    started_at: startedAt,
    finished_at: finishedAt,
    status,
    error: errorMsg,
    side_a: sideA,
    side_b: sideB,
    per_criterion: perCriterion,
    overall_winner: overallWinner,
    summary,
    artifacts_dir: runDir,
    model,
    cost_usd: costUsd,
    duration_ms: durationMs,
  };

  // Sidecar JSON for replay.
  try {
    fs.writeFileSync(
      path.join(runDir, "compare.json"),
      JSON.stringify(result, null, 2) + "\n",
      "utf8",
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "compare: failed to write compare.json sidecar",
    );
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function buildJudgeOpts(
  opts: CompareOptions,
  side: "a" | "b",
  criteria: JudgeCriterionSpec[],
  artifactsRoot: string,
  model: string,
): JudgeOptions {
  const sideOpts = side === "a" ? opts.a : opts.b;
  // Pass criteria explicitly so judge applies the EXACT rubric set we want
  // (avoids re-resolving from rubrics alone, which would dedupe customs
  // away if the caller's rubrics array lacks "custom").
  return {
    url: sideOpts.url,
    capture: sideOpts.capture,
    persona: sideOpts.persona,
    viewport: sideOpts.viewport,
    rubrics: opts.rubrics,
    customCriteria: opts.customCriteria,
    waitFor: opts.waitFor,
    fullPage: opts.fullPage,
    includeDom: opts.includeDom,
    includeConsole: opts.includeConsole,
    timeoutMs: opts.timeoutMs,
    headless: opts.headless,
    model,
    artifactsRoot,
  };
}

function captureFromJudge(j: JudgeResultShape): ExistingCapture | null {
  if (!j.screenshot) return null;
  return {
    url_input: j.url_input,
    url_final: j.url_final,
    title: j.title,
    screenshot_path: j.screenshot.path,
    loaded_at: j.loaded_at,
    dom: j.dom,
    console: j.console,
  };
}

function captureToScreenshot(
  cap: ExistingCapture | null,
): JudgeResultShape["screenshot"] {
  if (!cap) return null;
  try {
    const buf = fs.readFileSync(cap.screenshot_path);
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    return {
      path: cap.screenshot_path,
      sha256: sha,
      bytes: buf.length,
    };
  } catch {
    return null;
  }
}

/**
 * Fast-mode capture path — run a minimal judge with the same rubric but
 * skip the synthesis call inside, because we'll do our own. We reuse
 * judge to keep the upstream `see` plumbing in one place; the rubric
 * vision call cost is recorded into the same daily ledger but is part
 * of fast-mode's accounting.
 *
 * Implementation note: in fast mode we ALSO get a per-side judgement
 * (cheap because there's only the synthesis on top). That seems
 * counter to the "1 vision call" promise — so instead we use a
 * minimal capture path: judge with a no-op vision stub would
 * complicate cost accounting. The cleanest implementation is to
 * delegate capture to the upstream `see` directly.
 *
 * For v1.0 we just call judge in fast mode with a stub vision that
 * returns empty verdicts → costs become (judge upstream see capture =
 * 0 cost) + (synthesis = 1 vision call). Total: 1 vision call as
 * promised. The "judge" in fast mode is a capture proxy — not
 * embedded in the result.
 */
async function ensureCapture(
  side: CompareSideInput,
  artifactsRoot: string,
  model: string,
  opts: CompareOptions,
  judgeImpl: typeof judge,
): Promise<ExistingCapture> {
  if (side.capture) return side.capture;
  if (!side.url) {
    throw new Error("compare: side has neither url nor capture");
  }
  // Use judge with a no-op vision call to reuse its capture pipeline
  // without spending an LLM call. The judge result is discarded; we only
  // keep the screenshot/dom/console. We thread `judgeImpl` so the caller's
  // test seam (`opts._judge`) is honoured here too — otherwise unit tests
  // that stub _judge would fail in fast mode.
  const noop = async () => ({ text: "{}", inputTokens: 0, outputTokens: 0, costUsd: 0 });
  const captureJudge = await judgeImpl({
    url: side.url,
    persona: side.persona,
    viewport: side.viewport,
    waitFor: opts.waitFor,
    fullPage: opts.fullPage,
    includeDom: opts.includeDom,
    includeConsole: opts.includeConsole,
    timeoutMs: opts.timeoutMs,
    headless: opts.headless,
    artifactsRoot,
    model,
    _callVision: noop,
  });
  if (captureJudge.status !== "ok") {
    throw new Error(`compare: capture failed for ${side.url}: ${captureJudge.error}`);
  }
  const cap = captureFromJudge(captureJudge);
  if (!cap) throw new Error(`compare: capture had no screenshot for ${side.url}`);
  return cap;
}

interface CompareSynthesisRaw {
  perCriterion: CompareCriterionVerdict[];
  overallWinner: CompareWinner;
  summary: string | null;
  costUsd: number;
}

export async function runCompareSynthesis(args: {
  criteria: JudgeCriterionSpec[];
  mode: CompareMode;
  sideACapture: ExistingCapture;
  sideBCapture: ExistingCapture;
  judgeA: JudgeResultShape | null;
  judgeB: JudgeResultShape | null;
  model: string;
  callVisionImpl: typeof callVision;
}): Promise<CompareSynthesisRaw> {
  // Deliberately single-image per side (not compressForVisionMulti): the
  // synthesis hinges on labelled "SIDE A" vs "SIDE B" frames, and slicing each
  // side into N images would destroy that pairing (the model could not tell
  // which slices belong to which side). compressForVision still enforces the
  // 8000px hard limit, so tall pages downscale safely instead of 400-ing.
  const bufA = fs.readFileSync(args.sideACapture.screenshot_path);
  const bufB = fs.readFileSync(args.sideBCapture.screenshot_path);
  const compA = await compressForVision(bufA);
  const compB = await compressForVision(bufB);

  const systemPrompt = buildCompareSystemPrompt({
    criteria: args.criteria,
    mode: args.mode,
  });
  const userPrompt = buildCompareUserPrompt({
    criteria: args.criteria,
    judgeA: args.judgeA,
    judgeB: args.judgeB,
  });

  const resp = await args.callVisionImpl({
    model: args.model,
    systemPrompt,
    userPrompt,
    images: [
      { base64: compA.base64, mediaType: compA.mediaType, label: "SIDE A:" },
      { base64: compB.base64, mediaType: compB.mediaType, label: "SIDE B:" },
    ],
    maxTokens: 4096,
  });

  let parsed: unknown;
  try {
    parsed = extractJson(resp.text);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "compare: synthesis returned malformed JSON",
    );
    return {
      perCriterion: [],
      overallWinner: "tie",
      summary: null,
      costUsd: resp.costUsd,
    };
  }

  return {
    ...parseCompareRawJson(parsed, args.criteria),
    costUsd: resp.costUsd,
  };
}

export function parseCompareRawJson(
  raw: unknown,
  criteria: JudgeCriterionSpec[],
): {
  perCriterion: CompareCriterionVerdict[];
  overallWinner: CompareWinner;
  summary: string | null;
} {
  const obj = (raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const allowedIds = new Set(criteria.map((c) => c.id));
  const allowedWinners = new Set<CompareWinner>(["a", "b", "tie"]);

  const arr = Array.isArray(obj.per_criterion) ? (obj.per_criterion as unknown[]) : [];
  const perCriterion: CompareCriterionVerdict[] = [];
  for (const v of arr) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const id = typeof o.criterion_id === "string" ? o.criterion_id : "";
    if (!allowedIds.has(id)) continue;
    const w = typeof o.winner === "string" ? o.winner : "";
    if (!allowedWinners.has(w as CompareWinner)) continue;
    const scoreA = clampScoreOrNull(o.score_a);
    const scoreB = clampScoreOrNull(o.score_b);
    perCriterion.push({
      criterion_id: id,
      score_a: scoreA,
      score_b: scoreB,
      winner: reconcileWinner(scoreA, scoreB, w as CompareWinner),
      rationale: typeof o.rationale === "string" ? o.rationale : "",
    });
  }

  const overallRaw = typeof obj.overall_winner === "string" ? obj.overall_winner : "";
  const overallWinner: CompareWinner = allowedWinners.has(overallRaw as CompareWinner)
    ? (overallRaw as CompareWinner)
    : majorityWinner(perCriterion);

  const summary = typeof obj.summary === "string" && obj.summary.length > 0 ? obj.summary : null;

  return { perCriterion, overallWinner, summary };
}

/**
 * Reconcile a stated per-criterion winner against its numeric scores.
 *
 * When both side scores are present they are the objective signal — a stated
 * winner that contradicts them is a model self-inconsistency (e.g. it labels
 * "a" the winner while scoring a:3 b:8). Derive the winner from the scores so
 * the verdict is internally coherent. When a score is missing (fast mode can
 * emit labels only) there's nothing to cross-check against, so keep the
 * stated label. (Audit 2026-06-02 E6/D3-M3.)
 */
function reconcileWinner(
  scoreA: number | null,
  scoreB: number | null,
  stated: CompareWinner,
): CompareWinner {
  if (scoreA === null || scoreB === null) return stated;
  if (scoreA > scoreB) return "a";
  if (scoreB > scoreA) return "b";
  return "tie";
}

function clampScoreOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(10, Math.max(0, n));
}

export function majorityWinner(verdicts: CompareCriterionVerdict[]): CompareWinner {
  if (verdicts.length === 0) return "tie";
  let a = 0;
  let b = 0;
  for (const v of verdicts) {
    if (v.winner === "a") a++;
    else if (v.winner === "b") b++;
  }
  if (a > b) return "a";
  if (b > a) return "b";
  return "tie";
}

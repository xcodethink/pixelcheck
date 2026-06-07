/**
 * `judge` primitive (N-8) — single-page rubric-driven critic.
 *
 * Intent: an AI agent (or a human via MCP) hands us a URL and a set of
 * rubrics ("aesthetic", "dark_pattern", or a custom criteria list) and
 * gets back a structured verdict — one score 0..10 per criterion, plus
 * severity-graded findings with on-screen locations.
 *
 * Architectural placement (vs. the existing `runCritic` in critic.ts):
 *   - `runCritic` is persona × scenario × dimension scoring, used by
 *     the audit run and tightly coupled to scenario YAML. It scores
 *     dimensions defined per-scenario.
 *   - `judge` is rubric × URL with no scenario YAML. The rubric is
 *     reified data the prompt is built from (criteria id+label+description),
 *     so external consumers can join verdicts back to the rubric and
 *     compose new rubrics without prompt-engineering.
 *
 * Cost-guard: the single vision call goes through `callVision`, which
 * wires the daily ledger + AsyncLocalStorage per-run scope (M5-6 + M9-3).
 *
 * Test seams: `_see` (replace the upstream capture) + `_callVision` (stub
 * the LLM). Production callers never set these.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { getLogger } from "../logger.js";
import { callVision, extractJson, type VisionResponse } from "../llm.js";
import { compressForVisionMulti } from "../image.js";
import { RESULT_SCHEMA_VERSION } from "../result-schema.js";
import type {
  JudgeCriterionSpec,
  JudgeFinding,
  JudgeRubricKind,
  JudgeResultShape,
  JudgeVerdict,
} from "../result-schema.js";
import { withResultCache } from "../result-cache.js";
import {
  see,
  type SeeOptions,
  type SeePersonaHints,
  type SeeResult,
  type WaitFor,
} from "./see.js";
import { AESTHETIC_CRITERIA } from "../critics/aesthetic.js";
import { DARK_PATTERN_CRITERIA } from "../critics/dark-pattern.js";
import { buildVisualScoring } from "../visual-collector.js";

const log = getLogger("primitive.judge");

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

export interface JudgeOptions {
  /** Target URL. Required when `capture` is not provided. */
  url?: string;
  /**
   * Pre-captured page snapshot (e.g. from a prior `see()` or `extract()`).
   * When provided, judge skips capture and runs straight to the vision call.
   * Either `url` or `capture` must be set; if both are set, `capture` wins
   * and `url` is recorded as `url_input` only.
   */
  capture?: ExistingCapture;

  /**
   * Built-in rubrics to apply. Default: `["aesthetic"]`.
   * Multiple rubrics compose: their criteria are concatenated and the
   * single vision call covers all of them.
   */
  rubrics?: JudgeRubricKind[];

  /**
   * Caller-supplied custom criteria. When non-empty, `rubrics` is
   * augmented with `"custom"` and these criteria are appended verbatim.
   * Use this for one-off rubrics ("How well does this page explain
   * pricing tiers?") without modifying built-in rubrics.
   */
  customCriteria?: Array<Omit<JudgeCriterionSpec, "kind">>;

  /** Persona hints forwarded to `see` if a fresh capture is taken. */
  persona?: SeePersonaHints;
  waitFor?: WaitFor;
  viewport?: { width: number; height: number };
  fullPage?: boolean;
  includeDom?: boolean;
  includeConsole?: boolean;
  timeoutMs?: number;
  headless?: boolean;

  /** Where to write per-call artifacts. Default: `$AUDIT_JUDGES_DIR` or `~/.pixelcheck/judges/`. */
  artifactsRoot?: string;

  /** Vision critic model id. Default `"claude-sonnet-4-6"`. */
  model?: string;

  /**
   * Result cache (M9-4). Caching is on by default. The cache key
   * covers url (or capture screenshot sha + url_final), rubrics,
   * customCriteria, persona/viewport, and model — anything that
   * would change the verdict.
   */
  cache?: boolean;
  cacheBust?: boolean;
  cacheTtlMs?: number;

  /** Test seams. */
  _see?: typeof see;
  _callVision?: typeof callVision;
}

export interface ExistingCapture {
  /** Echoed into JudgeResult.url_input for traceability. */
  url_input?: string;
  /** Where the page actually landed. */
  url_final: string;
  title: string;
  /** Path to a screenshot.png on disk. judge re-reads it. */
  screenshot_path: string;
  /** SeeDom-shaped DOM summary, optional. */
  dom?: SeeResult["dom"];
  /** SeeConsole-shaped errors, optional. */
  console?: SeeResult["console"];
  /** When the capture was taken. */
  loaded_at?: string;
}

export type JudgeResult = JudgeResultShape;

// ─────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────

export const DEFAULT_JUDGE_PERSONA_ID = "judge-default-desktop";
export const DEFAULT_JUDGE_MODEL = "claude-sonnet-4-6";
export const DEFAULT_RUBRICS: JudgeRubricKind[] = ["aesthetic"];

export function defaultJudgeArtifactsRoot(): string {
  const envDir = process.env.AUDIT_JUDGES_DIR;
  if (envDir && envDir.length > 0) return envDir;
  const home =
    process.env.PIXELCHECK_HOME ??
    process.env.AUDIT_HOME ??
    path.join(os.homedir(), ".pixelcheck");
  return path.join(home, "judges");
}

function makeRunDir(root: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(3).toString("hex");
  const dir = path.join(root, `${ts}-${rand}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// ─────────────────────────────────────────────────────────────
// Rubric assembly
// ─────────────────────────────────────────────────────────────

/**
 * Build the criteria list for a given options object. Order matters for
 * verdict join stability — rubrics are processed in the order the caller
 * supplied them, with custom criteria appended last.
 *
 * Throws if no criteria would be produced (no rubric and no custom
 * criteria), since a rubric-less judge is meaningless.
 */
export function resolveCriteria(opts: {
  rubrics?: JudgeRubricKind[];
  customCriteria?: Array<Omit<JudgeCriterionSpec, "kind">>;
}): { criteria: JudgeCriterionSpec[]; rubrics: JudgeRubricKind[] } {
  const rubrics: JudgeRubricKind[] = [];
  const criteria: JudgeCriterionSpec[] = [];
  const seen = new Set<string>();

  for (const r of opts.rubrics ?? DEFAULT_RUBRICS) {
    if (rubrics.includes(r)) continue; // dedupe rubric kinds
    if (r === "aesthetic") {
      rubrics.push(r);
      for (const c of AESTHETIC_CRITERIA) pushUnique(c);
    } else if (r === "dark_pattern") {
      rubrics.push(r);
      for (const c of DARK_PATTERN_CRITERIA) pushUnique(c);
    } else if (r === "custom") {
      // `custom` standalone has no built-in criteria; it's a marker that
      // the caller's customCriteria are present. We still record it.
      rubrics.push(r);
    }
  }

  if (opts.customCriteria && opts.customCriteria.length > 0) {
    if (!rubrics.includes("custom")) rubrics.push("custom");
    for (const c of opts.customCriteria) {
      pushUnique({ ...c, kind: "custom" });
    }
  }

  if (criteria.length === 0) {
    throw new Error(
      "judge: no criteria — supply at least one built-in rubric or a custom criterion",
    );
  }

  return { criteria, rubrics };

  function pushUnique(c: JudgeCriterionSpec): void {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    criteria.push(c);
  }
}

// ─────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────

export function buildJudgeSystemPrompt(criteria: JudgeCriterionSpec[]): string {
  const criterionLines = criteria
    .map(
      (c) =>
        `  - id: ${c.id}\n    label: ${c.label}\n    kind: ${c.kind}\n    rubric: ${c.description}`,
    )
    .join("\n");

  return `You are a senior product designer and UX researcher conducting a structured page audit.

You will be given:
- A screenshot of one web page.
- A rubric of criteria to score, each with a stable id, a human label, and a one-sentence rubric describing what the score means.

For EACH criterion in the rubric, return a verdict object with:
- criterion_id: the exact id from the rubric (snake_case, never paraphrased)
- score: a number 0..10. 10 = excellent on this criterion. For dark-pattern criteria, 10 = no dark pattern detected, 0 = blatant dark pattern.
- rationale: ONE sentence grounded in observed evidence. Cite what you see, not what is typical.
- evidence: array of short quoted strings or visual cues you used. May be empty if the verdict is purely visual.

Also return findings — severity-graded issues with locations:
- severity: "critical" | "high" | "medium" | "low"
- criterion_id: the rubric id this finding ties to, or null if it cuts across criteria
- description: ONE sentence describing the issue
- location: a physical area on the screen (e.g. "footer column 2", "hero CTA", "below-the-fold pricing card 3")
- recommendation: ONE sentence actionable fix

CRITICAL ANTI-HALLUCINATION RULES:
- ONLY report text you can ACTUALLY READ in the screenshot. Never guess, never fabricate "what a typical SaaS landing page would have", never list strings unless you literally see those exact characters rendered.
- Quote rendered text character for character in evidence. Do not normalize, lowercase, or paraphrase.
- "location" must describe a physical area you can see, NOT an inferred section name from training data.
- If a region is too small/blurry to read, say so in your rationale rather than fabricating contents.
- The cost of one missed issue is far less than the cost of one fabricated string.

You MUST return a single valid JSON object with this exact shape:
{
  "verdicts": [
    { "criterion_id": "...", "score": 0..10, "rationale": "...", "evidence": ["...", "..."] }
  ],
  "findings": [
    { "severity": "...", "criterion_id": "..."|null, "description": "...", "location": "...", "recommendation": "..." }
  ],
  "summary": "..."  // optional, one or two sentences describing the dominant story (most important wins/losses)
}

Rubric to score:
${criterionLines}

Return ONLY the JSON. No prose, no code fences. Limit findings to 10 most important.`;
}

export function buildJudgeUserPrompt(
  criteria: JudgeCriterionSpec[],
  multiImage = false,
): string {
  const ids = criteria.map((c) => c.id).join(", ");
  const target = multiImage ? "page" : "screenshot";
  const multiNote = multiImage
    ? `

This page is too tall to capture in one legible image, so it is provided as MULTIPLE images: the FIRST image is a low-resolution full-page thumbnail for macro context (layout / where sections are) — do NOT read fine text from it. The REMAINING images are high-resolution vertical slices (top → bottom, ~20% overlap) — read exact text only from these. Together they are one continuous page; score it as a whole and do not double-count content that appears in the overlap between slices.`
    : "";

  return `Score the ${target} on these criteria: ${ids}.${multiNote}

Return JSON only, matching the schema in the system prompt. The verdicts array MUST contain exactly one entry per criterion above (do not skip any). Use the exact criterion_id strings.`;
}

// ─────────────────────────────────────────────────────────────
// Primitive
// ─────────────────────────────────────────────────────────────

/**
 * Build the cache-key inputs for a `judge` call. When the caller
 * supplies a pre-captured screenshot the screenshot path's contents
 * hash IS the cache discriminator (different screenshot bytes →
 * different verdict), so we hash the file contents as part of the key.
 * For the URL path the URL itself is enough.
 */
function judgeCacheKeyInputs(opts: JudgeOptions): unknown {
  const persona = opts.persona ?? {};
  const captureFingerprint = opts.capture
    ? {
        url_final: opts.capture.url_final,
        screenshot_sha256: hashScreenshotPath(opts.capture.screenshot_path),
      }
    : undefined;
  return {
    url: opts.url,
    capture: captureFingerprint,
    rubrics: opts.rubrics ?? DEFAULT_RUBRICS,
    custom_criteria: opts.customCriteria ?? [],
    waitFor: opts.waitFor,
    fullPage: opts.fullPage,
    includeDom: opts.includeDom,
    includeConsole: opts.includeConsole,
    viewport: opts.viewport ?? persona.viewport,
    locale: persona.locale,
    timezone: persona.timezone,
    user_agent: persona.user_agent,
    persona_id: persona.id,
    model: opts.model ?? DEFAULT_JUDGE_MODEL,
  };
}

function hashScreenshotPath(p: string): string {
  try {
    const buf = fs.readFileSync(p);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    // If the file isn't readable here, the compute path will surface the
    // real error with a better message. Use the raw path so the key still
    // varies between distinct paths.
    return `path:${p}`;
  }
}

export async function judge(opts: JudgeOptions): Promise<JudgeResult> {
  return withResultCache<JudgeResult>({
    primitive: "judge",
    cacheKeyInputs: judgeCacheKeyInputs(opts),
    cacheEnabled: opts.cache !== false,
    cacheBust: opts.cacheBust,
    ttlMs: opts.cacheTtlMs,
    compute: () => computeJudge(opts),
  });
}

async function computeJudge(opts: JudgeOptions): Promise<JudgeResult> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();

  if (!opts.url && !opts.capture) {
    throw new Error("judge: either `url` or `capture` is required");
  }

  const { criteria, rubrics } = resolveCriteria(opts);
  const model = opts.model ?? DEFAULT_JUDGE_MODEL;
  const personaId = opts.persona?.id ?? DEFAULT_JUDGE_PERSONA_ID;

  const artifactsRoot = opts.artifactsRoot ?? defaultJudgeArtifactsRoot();
  fs.mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 });
  const runDir = makeRunDir(artifactsRoot);

  let urlInput = opts.capture?.url_input ?? opts.url ?? "";
  let urlFinal = opts.capture?.url_final ?? urlInput;
  let title = opts.capture?.title ?? "";
  let loadedAt = opts.capture?.loaded_at ?? startedAt;
  let dom: JudgeResult["dom"] = opts.capture?.dom ?? null;
  let consoleSection: JudgeResult["console"] = opts.capture?.console ?? null;
  let screenshotMeta: JudgeResult["screenshot"] = null;
  let screenshotBuf: Buffer | null = null;
  let costUsd = 0;
  let status: JudgeResult["status"] = "ok";
  let errorMsg: string | undefined;
  let verdicts: JudgeVerdict[] = [];
  let findings: JudgeFinding[] = [];
  let summary: string | null = null;

  try {
    if (opts.capture) {
      // Re-read the existing screenshot. judge does not reproduce the
      // capture; it only validates the file exists and is readable.
      screenshotBuf = fs.readFileSync(opts.capture.screenshot_path);
      const shaHex = crypto.createHash("sha256").update(screenshotBuf).digest("hex");
      screenshotMeta = {
        path: opts.capture.screenshot_path,
        sha256: shaHex,
        bytes: screenshotBuf.length,
      };
    } else if (opts.url) {
      const seeImpl = opts._see ?? see;
      const seeOpts: SeeOptions = {
        url: opts.url,
        persona: opts.persona,
        waitFor: opts.waitFor,
        viewport: opts.viewport,
        fullPage: opts.fullPage,
        includeDom: opts.includeDom,
        includeConsole: opts.includeConsole,
        timeoutMs: opts.timeoutMs,
        headless: opts.headless,
        artifactsRoot: runDir,
      };
      const captured: SeeResult = await seeImpl(seeOpts);
      if (captured.status !== "ok") {
        throw new Error(captured.error ?? "see failed during judge capture");
      }
      urlInput = captured.url_input;
      urlFinal = captured.url_final;
      title = captured.title;
      loadedAt = captured.loaded_at;
      dom = captured.dom;
      consoleSection = captured.console;
      if (captured.screenshot) {
        screenshotMeta = captured.screenshot;
        screenshotBuf = fs.readFileSync(captured.screenshot.path);
      }
      // see's own per-call cost (typically 0 here since no goal is set).
      costUsd += captured.cost_usd;
    }

    if (!screenshotBuf) {
      throw new Error("judge: no screenshot available — capture failed or path missing");
    }

    const callVisionImpl = opts._callVision ?? callVision;
    const visionResult = await runJudgeVision({
      criteria,
      buf: screenshotBuf,
      model,
      callVisionImpl,
    });
    verdicts = visionResult.verdicts;
    findings = visionResult.findings;
    summary = visionResult.summary;
    costUsd += visionResult.costUsd;
  } catch (err) {
    status = "error";
    errorMsg = err instanceof Error ? err.message : String(err);
    log.warn(
      { err: errorMsg, url: opts.url, runDir },
      "judge: failed",
    );
  }

  const overall = computeOverallScore(verdicts, criteria.length);
  const durationMs = Date.now() - t0;

  // PR-D / ADR-034: judge IS visual scoring, so always emit a normalized
  // mirror under `diagnostics.visual` so consumers reading any primitive
  // get a uniform shape. On error (`status === "error"` and verdicts
  // empty) we emit a `scored: false / vision_error` envelope.
  const diagnostics: JudgeResult["diagnostics"] = {
    collected_at: "always",
    visual:
      status === "ok"
        ? buildVisualScoring({
            raw: {
              verdicts,
              findings,
              summary,
              costUsd: costUsd, // best-effort: includes any nested capture cost
            },
            criteria,
            rubrics,
            model,
            durationMs,
          })
        : {
            scored: false,
            skip_reason: "vision_error",
            rubrics,
            verdicts: [],
            findings: [],
            overall_score: null,
            summary: null,
            model,
            cost_usd: 0,
            duration_ms: durationMs,
          },
  };

  const result: JudgeResult = {
    schema_version: RESULT_SCHEMA_VERSION,
    url_input: urlInput,
    url_final: urlFinal,
    title,
    loaded_at: loadedAt,
    status,
    error: errorMsg,
    rubrics,
    criteria,
    verdicts,
    findings,
    overall_score: overall,
    summary,
    dom,
    console: consoleSection,
    screenshot: screenshotMeta,
    persona_id: personaId,
    artifacts_dir: runDir,
    model,
    cost_usd: costUsd,
    duration_ms: durationMs,
    diagnostics,
  };

  // Write a JSON sidecar so the result is reproducible without re-running.
  try {
    fs.writeFileSync(
      path.join(runDir, "judge.json"),
      JSON.stringify(result, null, 2) + "\n",
      "utf8",
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "judge: failed to write judge.json sidecar",
    );
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────

export interface JudgeVisionRaw {
  verdicts: JudgeVerdict[];
  findings: JudgeFinding[];
  summary: string | null;
  costUsd: number;
  raw: VisionResponse;
}

export async function runJudgeVision(args: {
  criteria: JudgeCriterionSpec[];
  buf: Buffer;
  model: string;
  callVisionImpl: typeof callVision;
}): Promise<JudgeVisionRaw> {
  // Tall full-page screenshots exceed Anthropic's 8000 px hard limit (400) and,
  // even when downscaled to fit, lose the text legibility rubric scoring needs.
  // compressForVisionMulti returns a macro thumbnail + native-resolution slices
  // for tall pages, or a single image for normal ones.
  const compressed = await compressForVisionMulti(args.buf);
  const multiImage = compressed.length > 1;
  const systemPrompt = buildJudgeSystemPrompt(args.criteria);
  const userPrompt = buildJudgeUserPrompt(args.criteria, multiImage);

  const resp = await args.callVisionImpl({
    model: args.model,
    systemPrompt,
    userPrompt,
    images: compressed.map((c) => ({
      base64: c.base64,
      mediaType: c.mediaType,
    })),
    maxTokens: 4096,
  });

  let parsed: unknown;
  try {
    parsed = extractJson(resp.text);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "judge: vision returned malformed JSON",
    );
    return {
      verdicts: [],
      findings: [
        {
          severity: "low",
          criterion_id: null,
          description: `Vision critic returned malformed JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
          recommendation: "Review judge prompt or model output stability.",
        },
      ],
      summary: null,
      costUsd: resp.costUsd,
      raw: resp,
    };
  }

  return parseJudgeRawJson(parsed, args.criteria, resp);
}

/**
 * Defensive parse: take the raw JSON the model emitted and coerce it
 * into shape, dropping fields that don't match the rubric ids and
 * normalising scores into 0..10.
 */
export function parseJudgeRawJson(
  raw: unknown,
  criteria: JudgeCriterionSpec[],
  resp: VisionResponse,
): JudgeVisionRaw {
  const obj = (raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const verdictsIn = Array.isArray(obj.verdicts) ? (obj.verdicts as unknown[]) : [];
  const findingsIn = Array.isArray(obj.findings) ? (obj.findings as unknown[]) : [];
  const summary =
    typeof obj.summary === "string" && obj.summary.length > 0 ? obj.summary : null;

  const allowedIds = new Set(criteria.map((c) => c.id));
  const verdicts: JudgeVerdict[] = [];
  for (const v of verdictsIn) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const id = typeof o.criterion_id === "string" ? o.criterion_id : "";
    if (!allowedIds.has(id)) continue;
    const scoreRaw = typeof o.score === "number" ? o.score : Number(o.score);
    if (!Number.isFinite(scoreRaw)) continue;
    const score = Math.min(10, Math.max(0, scoreRaw));
    verdicts.push({
      criterion_id: id,
      score,
      rationale: typeof o.rationale === "string" ? o.rationale : "",
      evidence: Array.isArray(o.evidence)
        ? (o.evidence as unknown[]).filter((e): e is string => typeof e === "string")
        : [],
    });
  }

  const allowedSeverities = new Set(["critical", "high", "medium", "low"]);
  const findings: JudgeFinding[] = [];
  for (const f of findingsIn) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    const sev = typeof o.severity === "string" ? o.severity : "";
    if (!allowedSeverities.has(sev)) continue;
    const cidRaw = o.criterion_id;
    const cid = typeof cidRaw === "string" && allowedIds.has(cidRaw) ? cidRaw : null;
    findings.push({
      severity: sev as JudgeFinding["severity"],
      criterion_id: cid,
      description: typeof o.description === "string" ? o.description : "",
      location: typeof o.location === "string" && o.location.length > 0 ? o.location : undefined,
      recommendation: typeof o.recommendation === "string" ? o.recommendation : "",
    });
  }

  return {
    verdicts,
    findings,
    summary,
    costUsd: resp.costUsd,
    raw: resp,
  };
}

/**
 * Mean verdict score, scaled to the FULL rubric.
 *
 * `criteriaCount` is how many criteria were supposed to be scored. The model
 * sometimes omits a criterion's verdict (often a low-scoring one); averaging
 * only over the verdicts it *did* return spuriously raises the overall score.
 * Dividing by the expected criteria count instead treats a missing verdict as
 * an implicit 0 — incomplete judgment can never inflate the score, only drag
 * it down. (Audit 2026-06-02 E6/D3-M2.) Omit `criteriaCount` (or pass 0) to
 * keep the legacy "average over present verdicts" behavior.
 */
export function computeOverallScore(
  verdicts: JudgeVerdict[],
  criteriaCount = 0,
): number | null {
  if (verdicts.length === 0) return null;
  const sum = verdicts.reduce((acc, v) => acc + v.score, 0);
  const denom = criteriaCount > 0
    ? Math.max(verdicts.length, criteriaCount)
    : verdicts.length;
  return Number((sum / denom).toFixed(2));
}

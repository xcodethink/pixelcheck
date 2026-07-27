/**
 * `extract` primitive (N-4) — schema-bound structured extraction.
 *
 * Intent: an AI agent (Claude Code etc.) wants a typed payload back from a
 * URL — pricing tiers, feature lists, FAQ entries, plan comparisons —
 * shaped exactly the way it asked for. Caller hands us a JSON Schema
 * (industry-standard, JSON-serialisable across the MCP wire), the
 * primitive converts it to a Zod schema, runs Stagehand's `extract()`,
 * and returns matching `data` plus the standard see/act envelope (DOM
 * summary, console errors, screenshot, persona, artifacts, cost,
 * duration).
 *
 * Engine: single — Stagehand only. Unlike `see` (raw Playwright fast
 * path) and `act` (auto-picked between Playwright and Stagehand based on
 * step kinds), `extract` is fundamentally LLM-driven: there is no
 * deterministic alternative for "give me an arbitrarily-shaped object
 * matching this schema." If Stagehand isn't installed, the primitive
 * surfaces a clear error message at open-time.
 *
 * JSON Schema subset (whitelist):
 *   - type: object | array | string | number | integer | boolean | null
 *   - type: ["string", "null"] (nullable shorthand)
 *   - properties / required (object members + which are mandatory)
 *   - items (array element schema)
 *   - enum (string | number | boolean enums; string-only → z.enum)
 *   - description (forwarded to .describe() for LLM hint quality)
 *   - nullable: true (OpenAPI shorthand for "or null")
 *   - additionalProperties (accepted but ignored — strip is our default)
 *   - pattern / minLength / maxLength / minimum / maximum (accepted but
 *     ignored at conversion time; Stagehand's LLM prompt does not
 *     enforce them anyway)
 *   - title / default / examples / $schema / $id (metadata, no-op)
 *
 * Explicitly rejected (clear error to the caller):
 *   - oneOf / anyOf / allOf / not / $ref
 *   - patternProperties / dependencies / if / then / else
 *   - const (use a single-element enum instead)
 *
 * The root schema must be `type: "object"` because Stagehand's
 * `page.extract()` requires `T extends z.AnyZodObject`.
 *
 * Cost-guard: Stagehand v2 exposes a running `metrics` object on the
 * Stagehand instance (extractPromptTokens / extractCompletionTokens).
 * The primitive snapshots `metrics` before and after the extract call,
 * computes the USD cost via `estimateCost(model, deltaIn, deltaOut)`,
 * and hands it to `getCostGuard().recordUsage()` so the persistent
 * daily ledger stays accurate. If recordUsage throws BudgetExceededError
 * (the call straddled a cap), the data is still returned but `status`
 * flips to `"error"` with the budget message — partial success.
 *
 * Test seams: `_openStagehand` replaces the Stagehand init+open path,
 * and `_callExtract` replaces the extract method on the opened session
 * so unit tests can stub the LLM round-trip without spinning Stagehand.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type BrowserContext, type Page } from "playwright";
import { z } from "zod";

import { getLogger } from "../logger.js";
import { extractDomSummary } from "../../agent/dom-summary.js";
import { estimateCost } from "../llm.js";
import {
  getCostGuard,
  BudgetExceededError,
} from "../cost-guard.js";
import { RESULT_SCHEMA_VERSION, type ResultCacheMeta } from "../result-schema.js";
import { withResultCache } from "../result-cache.js";
import type { ConsoleError } from "../types.js";
import {
  DEFAULT_LOCALE,
  DEFAULT_TIMEZONE,
  DEFAULT_VIEWPORT,
  type SeePersonaHints,
  type WaitFor,
} from "./see.js";
import { VisualCollector, shouldScore } from "../visual-collector.js";

const log = getLogger("primitive.extract");

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

/**
 * Minimal JSON Schema subset accepted by the converter. Documented above.
 * Intentionally `unknown`-shaped at runtime — we walk the keys ourselves
 * and reject unsupported ones with a precise error message.
 */
export type JsonSchemaSubset = Record<string, unknown>;

export interface ExtractOptions {
  /** Target URL. Required. */
  url: string;
  /**
   * JSON Schema describing the desired payload shape. Optional — when
   * omitted, Stagehand falls back to `{ extraction: string }` and
   * returns free-form prose answering the `instruction`.
   */
  schema?: JsonSchemaSubset;
  /**
   * Natural-language hint passed to Stagehand's extract LLM call. When
   * absent, the primitive synthesises one from the schema's top-level
   * field names (and optional `description` annotations) so extraction
   * quality stays high without forcing the caller to write boilerplate.
   */
  instruction?: string;
  /**
   * Constrain extraction to a CSS sub-region. Forwarded to Stagehand
   * as `selector`. Useful for pages with multiple repeated sections
   * (e.g. pricing-card grid: `selector: "main"`).
   */
  selector?: string;
  /** Optional persona-shaped navigation hints. */
  persona?: SeePersonaHints;
  /** Override viewport (overrides persona viewport). */
  viewport?: { width: number; height: number };
  /** Final-screenshot full-page vs viewport-only. Default true. */
  fullPage?: boolean;
  /** Include final DOM summary. Default true. */
  includeDom?: boolean;
  /** Include captured console errors. Default true. */
  includeConsole?: boolean;
  /** Per-navigation timeout (ms). Default 30000. */
  timeoutMs?: number;
  /** Initial-navigation wait strategy. Default "networkidle". */
  waitFor?: WaitFor;
  /** Run headless. Default true. */
  headless?: boolean;
  /** Where to write per-call artifacts. Default `$AUDIT_EXTRACTS_DIR` or `~/.pixelcheck/extracts/`. */
  artifactsRoot?: string;
  /** LLM model id (must be a key in PRICING). Default `"claude-sonnet-4-6"`. */
  model?: string;

  /**
   * Rubric-based visual scoring (PR-D / ADR-034). See `SeeOptions.visualScoring`
   * for the full mode semantics. `'auto'` mode invokes whenever the host
   * primitive runs (since extract always makes an LLM call for the data
   * extraction itself, bundling visual scoring is the same cost shape).
   * Default `'off'`.
   */
  visualScoring?: import("../visual-collector.js").VisualScoringMode;
  /** Built-in rubrics for visual scoring. Default `["aesthetic"]`. */
  visualRubrics?: import("./judge.js").JudgeOptions["rubrics"];
  /** Caller-supplied criteria appended after rubric criteria. */
  visualCustomCriteria?: import("./judge.js").JudgeOptions["customCriteria"];
  /** Vision model used for visual scoring. Default `DEFAULT_JUDGE_MODEL`. */
  visualModel?: string;
  /**
   * Test seam: replace the vision call used by visual scoring (PR-D).
   * Production callers never set this.
   */
  _callVision?: typeof import("../llm.js").callVision;

  /**
   * Result cache (M9-4). Caching is on by default. The cache key
   * covers url, schema, instruction, selector, persona/viewport, and
   * model — anything that would change the extracted data.
   */
  cache?: boolean;
  cacheBust?: boolean;
  cacheTtlMs?: number;

  // ── Test seams ────────────────────────────────────────────────
  /** Replace the Stagehand init+open path. */
  _openStagehand?: StagehandOpenFn;
  /**
   * Replace the extract method on the opened session. Lets unit tests
   * stub the LLM round-trip without ever spinning Stagehand. The shape
   * mirrors what we'd otherwise call as `page.extract(args)`.
   */
  _callExtract?: ExtractCallFn;
}

export interface ExtractResult {
  schema_version: string;
  url_input: string;
  url_final: string;
  title: string;
  loaded_at: string;
  status: "ok" | "error";
  error?: string;
  engine: "stagehand";
  data: unknown;
  schema_used?: JsonSchemaSubset;
  instruction_used?: string;
  selector_used?: string;
  dom: {
    interactive_count: number;
    headings: string[];
    summary: string;
    text_excerpt?: string;
  } | null;
  console: { errors_count: number; errors: ConsoleError[] } | null;
  screenshot: {
    path: string;
    sha256: string;
    bytes?: number;
    width?: number;
    height?: number;
  } | null;
  persona_id: string;
  artifacts_dir: string;
  cost_usd: number;
  duration_ms: number;
  /** Result-cache annotation (M9-4). Absent when caching not applicable. */
  cache?: ResultCacheMeta;
  /** Multi-dimensional audit diagnostics (ADR-034 / Phase 0). Populated
   *  by WhiteboxCollector when default open path is used. */
  diagnostics?: {
    collected_at: "always" | "on_failure";
    popups?: import("../whitebox-collector.js").PopupSnapshot[];
    network?: import("../whitebox-collector.js").NetworkLog;
    cookies?: import("../whitebox-collector.js").CookieData[];
    storage?: import("../whitebox-collector.js").StorageSnapshot;
    /** Core Web Vitals + page-load + resource metrics (PR-C / ADR-034). */
    performance?: import("../../agent/signals/performance.js").PerformanceSignal;
    /** Rubric-based vision scoring (PR-D / ADR-034). Only populated
     *  when `cfg.visualScoring` opts in (default `'off'`). */
    visual?: import("../result-schema.js").VisualScoring;
  };
}

// ─────────────────────────────────────────────────────────────
// Open-function shape (test seam)
// ─────────────────────────────────────────────────────────────

export interface OpenedExtractor {
  page: Page;
  context: BrowserContext | null;
  consoleErrors: ConsoleError[];
  /** Run a Stagehand-backed extract call. */
  extract: ExtractCallFn;
  /** Read the current Stagehand metrics snapshot. v3 made `metrics`
   * async (returns `Promise<StagehandMetrics>`), so this is async too. */
  readMetrics: () => Promise<StagehandMetricsSnapshot>;
  /** Optional WhiteboxCollector attached on default open. Test seams
   *  may omit it; extract then skips diagnostics. (PR-B / ADR-034) */
  whitebox?: import("../whitebox-collector.js").WhiteboxCollector;
  /** Optional PerformanceSignalCollector attached on default open path.
   *  Test seams may omit it. (PR-C / ADR-034) */
  performance?: import("../../agent/signals/performance.js").PerformanceSignalCollector;
  close: () => Promise<void>;
}

export interface StagehandMetricsSnapshot {
  extractPromptTokens: number;
  extractCompletionTokens: number;
}

export interface ExtractCallArgs {
  instruction?: string;
  schema?: z.AnyZodObject;
  selector?: string;
}

export type ExtractCallFn = (args: ExtractCallArgs) => Promise<unknown>;

export type StagehandOpenFn = (cfg: OpenConfig) => Promise<OpenedExtractor>;

export interface OpenConfig {
  url: string;
  viewport: { width: number; height: number };
  locale: string;
  timezone: string;
  userAgent?: string;
  headless: boolean;
  timeoutMs: number;
  waitFor: WaitFor;
  model: string;
}

// ─────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────

export const DEFAULT_PERSONA_ID = "extract-default-desktop";
export const DEFAULT_MODEL = "claude-sonnet-4-6";

/** Resolve the artifacts root with env override. */
export function defaultArtifactsRoot(): string {
  const envDir = process.env.AUDIT_EXTRACTS_DIR;
  if (envDir && envDir.length > 0) return envDir;
  const home =
    process.env.PIXELCHECK_HOME ??
    process.env.AUDIT_HOME ??
    path.join(os.homedir(), ".pixelcheck");
  return path.join(home, "extracts");
}

function makeRunDir(root: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(3).toString("hex");
  const dir = path.join(root, `${ts}-${rand}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// ─────────────────────────────────────────────────────────────
// JSON Schema → Zod (subset)
// ─────────────────────────────────────────────────────────────

const UNSUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "$ref",
  "patternProperties",
  "dependencies",
  "if",
  "then",
  "else",
  "const",
]);

/**
 * Convert a JSON Schema subset to a Zod schema. The root must describe an
 * object (Stagehand.extract requires `T extends z.AnyZodObject`).
 *
 * Throws a precise error message identifying which keyword and path
 * tripped the converter, so callers can fix their schema instead of
 * staring at silent partial extraction.
 */
export function jsonSchemaToZod(schema: unknown): z.AnyZodObject {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("extract: schema must be a JSON Schema object");
  }
  const root = schema as JsonSchemaSubset;
  const t = pickPrimaryType(root);
  // Allow a bare { properties: {...} } as a convenience — common shorthand.
  if (t !== "object" && !(root.properties && t === undefined)) {
    throw new Error(
      `extract: root schema must have type "object" (got "${t ?? "<missing>"}") — Stagehand.extract requires an object schema`,
    );
  }
  const normalised = { ...root, type: "object" } as JsonSchemaSubset;
  return jsonSchemaToZodInner(normalised, "") as z.AnyZodObject;
}

function jsonSchemaToZodInner(
  schema: JsonSchemaSubset,
  path: string,
): z.ZodTypeAny {
  for (const key of Object.keys(schema)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) {
      throw new Error(
        `extract: unsupported JSON Schema keyword "${key}" at ${path || "<root>"} — extract supports a subset (type / properties / required / items / enum / description / nullable). Replace or remove it.`,
      );
    }
  }

  let baseType: z.ZodTypeAny;

  // `enum` overrides `type` (matching JSON Schema semantics).
  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) {
      throw new Error(
        `extract: enum at ${path || "<root>"} must have at least one value`,
      );
    }
    if (schema.enum.every((v) => typeof v === "string")) {
      baseType = z.enum(schema.enum as [string, ...string[]]);
    } else {
      baseType = z.union(
        schema.enum.map((v) =>
          z.literal(v as string | number | boolean),
        ) as unknown as readonly [
          z.ZodTypeAny,
          z.ZodTypeAny,
          ...z.ZodTypeAny[]
        ],
      );
    }
  } else {
    const t = pickPrimaryType(schema);
    const isNullable =
      schema.nullable === true ||
      (Array.isArray(schema.type) &&
        schema.type.includes("null") &&
        schema.type.length > 1);

    switch (t) {
      case "object": {
        const props =
          (schema.properties as Record<string, JsonSchemaSubset> | undefined) ??
          {};
        const required = new Set(
          Array.isArray(schema.required) ? (schema.required as string[]) : [],
        );
        const shape: Record<string, z.ZodTypeAny> = {};
        for (const [k, v] of Object.entries(props)) {
          let field = jsonSchemaToZodInner(v, path ? `${path}.${k}` : k);
          if (!required.has(k)) field = field.optional();
          shape[k] = field;
        }
        baseType = z.object(shape);
        break;
      }
      case "string":
        baseType = z.string();
        break;
      case "number":
        baseType = z.number();
        break;
      case "integer":
        baseType = z.number().int();
        break;
      case "boolean":
        baseType = z.boolean();
        break;
      case "null":
        baseType = z.null();
        break;
      case "array": {
        if (!schema.items || typeof schema.items !== "object") {
          throw new Error(
            `extract: array at ${path || "<root>"} requires an "items" schema`,
          );
        }
        baseType = z.array(
          jsonSchemaToZodInner(
            schema.items as JsonSchemaSubset,
            `${path}[]`,
          ),
        );
        break;
      }
      default:
        throw new Error(
          `extract: unsupported type "${t ?? "<missing>"}" at ${path || "<root>"} — supported: object, array, string, number, integer, boolean, null`,
        );
    }

    if (isNullable) baseType = baseType.nullable();
  }

  if (typeof schema.description === "string" && schema.description.length > 0) {
    baseType = baseType.describe(schema.description);
  }

  return baseType;
}

function pickPrimaryType(schema: JsonSchemaSubset): string | undefined {
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) {
    // Drop "null" (handled separately) and pick the first concrete type.
    const concrete = (schema.type as string[]).find((s) => s !== "null");
    return concrete;
  }
  return undefined;
}

/**
 * Build a default instruction from the top-level fields of the JSON
 * Schema. Stagehand's extract performs noticeably better with a
 * one-line hint, even when the schema makes the intent obvious — so we
 * generate one when the caller doesn't supply their own.
 */
export function synthesizeInstruction(
  schema: JsonSchemaSubset | undefined,
): string {
  if (!schema || typeof schema !== "object") {
    return "Extract structured data from the page.";
  }
  const props = (schema.properties as Record<string, JsonSchemaSubset>) ?? {};
  const fields = Object.entries(props).map(([name, sub]) => {
    const desc = typeof sub.description === "string" ? sub.description : "";
    return desc ? `${name} (${desc})` : name;
  });
  if (fields.length === 0) {
    return "Extract structured data from the page.";
  }
  return `Extract the following fields from the page: ${fields.join(", ")}.`;
}

// ─────────────────────────────────────────────────────────────
// Primitive
// ─────────────────────────────────────────────────────────────

/**
 * Build the cache-key inputs for an `extract` call. Excludes timeout /
 * headless / artifactsRoot / test seams — those affect performance or
 * file location, not the extracted data itself.
 */
function extractCacheKeyInputs(opts: ExtractOptions): unknown {
  const persona = opts.persona ?? {};
  return {
    url: opts.url,
    schema: opts.schema,
    instruction: opts.instruction,
    selector: opts.selector,
    waitFor: opts.waitFor ?? "networkidle",
    fullPage: opts.fullPage ?? true,
    includeDom: opts.includeDom ?? true,
    includeConsole: opts.includeConsole ?? true,
    viewport: opts.viewport ?? persona.viewport ?? { ...DEFAULT_VIEWPORT },
    locale: persona.locale ?? DEFAULT_LOCALE,
    timezone: persona.timezone ?? DEFAULT_TIMEZONE,
    user_agent: persona.user_agent,
    persona_id: persona.id,
    model: opts.model ?? DEFAULT_MODEL,
    // PR-D / ADR-034: visual scoring inputs alter the result envelope
    // (diagnostics.visual changes verdicts/findings) so they must be
    // part of the cache key.
    visual_scoring: opts.visualScoring ?? "off",
    visual_rubrics: opts.visualRubrics,
    visual_custom_criteria: opts.visualCustomCriteria,
    visual_model: opts.visualModel,
  };
}

export async function extract(opts: ExtractOptions): Promise<ExtractResult> {
  return withResultCache<ExtractResult>({
    primitive: "extract",
    cacheKeyInputs: extractCacheKeyInputs(opts),
    cacheEnabled: opts.cache !== false,
    cacheBust: opts.cacheBust,
    ttlMs: opts.cacheTtlMs,
    compute: () => computeExtract(opts),
  });
}

async function computeExtract(opts: ExtractOptions): Promise<ExtractResult> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();

  const persona = opts.persona ?? {};
  const personaId = persona.id ?? DEFAULT_PERSONA_ID;
  const viewport = opts.viewport ?? persona.viewport ?? { ...DEFAULT_VIEWPORT };
  const locale = persona.locale ?? DEFAULT_LOCALE;
  const timezone = persona.timezone ?? DEFAULT_TIMEZONE;
  const userAgent = persona.user_agent;
  const waitFor: WaitFor = opts.waitFor ?? "networkidle";
  const headless = opts.headless ?? true;
  const timeoutMs = opts.timeoutMs ?? 30000;
  const includeDom = opts.includeDom ?? true;
  const includeConsole = opts.includeConsole ?? true;
  const fullPage = opts.fullPage ?? true;
  const model = opts.model ?? DEFAULT_MODEL;

  const artifactsRoot = opts.artifactsRoot ?? defaultArtifactsRoot();
  fs.mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 });
  const runDir = makeRunDir(artifactsRoot);

  // Convert schema up-front so a malformed JSON Schema fails fast
  // (before we burn ~5 s on Stagehand cold-start).
  let zodSchema: z.AnyZodObject | undefined;
  if (opts.schema !== undefined) {
    try {
      zodSchema = jsonSchemaToZod(opts.schema);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(opts, runDir, personaId, startedAt, t0, msg);
    }
  }

  const instructionUsed =
    (typeof opts.instruction === "string" && opts.instruction.length > 0
      ? opts.instruction
      : undefined) ??
    (opts.schema ? synthesizeInstruction(opts.schema) : undefined);

  let urlFinal = opts.url;
  let title = "";
  let dom: ExtractResult["dom"] = null;
  let consoleSection: ExtractResult["console"] = null;
  let screenshot: ExtractResult["screenshot"] = null;
  let data: unknown = null;
  let costUsd = 0;
  let status: ExtractResult["status"] = "ok";
  let errorMsg: string | undefined;
  /** ADR-034 Phase 0 — populated from WhiteboxCollector when default
   *  open path is used. */
  let diagnostics: ExtractResult["diagnostics"] = undefined;

  try {
    const open = opts._openStagehand ?? defaultOpenStagehand;
    const opened = await open({
      url: opts.url,
      viewport,
      locale,
      timezone,
      userAgent,
      headless,
      timeoutMs,
      waitFor,
      model,
    });

    try {
      const page = opened.page;
      urlFinal = safePageUrl(page, opts.url);

      const extractFn = opts._callExtract ?? opened.extract;
      const before = await opened.readMetrics();
      try {
        data = await extractFn({
          instruction: instructionUsed,
          schema: zodSchema,
          selector: opts.selector,
        });
      } catch (err) {
        status = "error";
        errorMsg = err instanceof Error ? err.message : String(err);
        log.warn(
          { err: errorMsg, url: opts.url, runDir },
          "extract: page.extract() failed",
        );
      }
      const after = await opened.readMetrics();
      const deltaIn = Math.max(
        0,
        after.extractPromptTokens - before.extractPromptTokens,
      );
      const deltaOut = Math.max(
        0,
        after.extractCompletionTokens - before.extractCompletionTokens,
      );
      if (deltaIn > 0 || deltaOut > 0) {
        try {
          const usage = getCostGuard().recordUsage(model, deltaIn, deltaOut);
          costUsd = usage.usd;
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            costUsd = estimateCost(model, deltaIn, deltaOut);
            status = "error";
            errorMsg = errorMsg ?? err.message;
          } else {
            throw err;
          }
        }
      }

      title = await page.title().catch(() => "");

      try {
        const buf = await page.screenshot({ fullPage, type: "png" });
        const sha = crypto.createHash("sha256").update(buf).digest("hex");
        const finalPath = path.join(runDir, "screenshot.png");
        fs.writeFileSync(finalPath, buf);
        fs.writeFileSync(`${finalPath}.sha256`, sha + "\n");
        screenshot = {
          path: finalPath,
          sha256: sha,
          bytes: buf.length,
          width: viewport.width,
          height: viewport.height,
        };
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "extract: screenshot failed",
        );
      }

      if (includeDom) {
        try {
          const summary = await extractDomSummary(page);
          const headings = await extractHeadings(page);
          dom = {
            interactive_count: summary.totalInteractive,
            headings,
            summary: summary.elements,
            text_excerpt: summary.textContent || undefined,
          };
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "extract: DOM summary extraction failed",
          );
        }
      }

      if (includeConsole) {
        const errs = opened.consoleErrors.slice();
        consoleSection = { errors_count: errs.length, errors: errs };
      }

      // Persist the raw extracted payload as artifact for replay / debug.
      try {
        fs.writeFileSync(
          path.join(runDir, "data.json"),
          JSON.stringify(data ?? null, null, 2) + "\n",
          "utf8",
        );
      } catch {
        /* best effort */
      }

      // ADR-034 Phase 0: collect diagnostics before context.close().
      const visualMode = opts.visualScoring ?? "off";
      // extract always makes an LLM call for the data extraction, so
      // `'auto'` runs unconditionally (the bundled visual scoring is
      // proportionally small overhead vs the host extract call).
      const visualDecision = shouldScore({
        mode: visualMode,
        hasGoal: true,
      });
      const visualEnabled = visualMode !== "off";
      if (opened.whitebox || opened.performance || visualEnabled) {
        diagnostics = { collected_at: "always" };
        if (opened.whitebox) {
          try {
            const wb = await opened.whitebox.collect();
            diagnostics.popups = wb.popups;
            diagnostics.network = wb.network;
            diagnostics.cookies = wb.cookies;
            diagnostics.storage = wb.storage;
          } catch (wbErr) {
            log.warn(
              { err: wbErr instanceof Error ? wbErr.message : String(wbErr) },
              "extract: whitebox diagnostics collection failed",
            );
          }
        }
        if (opened.performance) {
          try {
            diagnostics.performance = await opened.performance.snapshot();
          } catch (perfErr) {
            log.warn(
              { err: perfErr instanceof Error ? perfErr.message : String(perfErr) },
              "extract: performance diagnostics collection failed",
            );
          }
        }
        if (visualEnabled) {
          const collector = new VisualCollector({
            rubrics: opts.visualRubrics,
            customCriteria: opts.visualCustomCriteria,
            model: opts.visualModel,
            callVisionImpl: opts._callVision,
          });
          if (!visualDecision.run) {
            diagnostics.visual = collector.skip(visualDecision.reason);
          } else if (!screenshot) {
            diagnostics.visual = collector.skip("no_screenshot");
          } else {
            try {
              const buf = fs.readFileSync(screenshot.path);
              diagnostics.visual = await collector.score(buf);
              costUsd += diagnostics.visual.cost_usd;
            } catch (visErr) {
              log.warn(
                { err: visErr instanceof Error ? visErr.message : String(visErr) },
                "extract: visual scoring failed",
              );
              diagnostics.visual = collector.skip("vision_error");
            }
          }
        }
      }
    } finally {
      await opened.close().catch(() => {});
    }
  } catch (err) {
    status = "error";
    errorMsg = err instanceof Error ? err.message : String(err);
    log.warn({ err: errorMsg, url: opts.url, runDir }, "extract: open/navigate failed");
  }

  return {
    schema_version: RESULT_SCHEMA_VERSION,
    url_input: opts.url,
    url_final: urlFinal,
    title,
    loaded_at: startedAt,
    status,
    error: errorMsg,
    engine: "stagehand",
    data,
    schema_used: opts.schema,
    instruction_used: instructionUsed,
    selector_used: opts.selector,
    dom,
    console: consoleSection,
    screenshot,
    persona_id: personaId,
    artifacts_dir: runDir,
    cost_usd: costUsd,
    duration_ms: Date.now() - t0,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function errorResult(
  opts: ExtractOptions,
  runDir: string,
  personaId: string,
  startedAt: string,
  t0: number,
  errorMsg: string,
): ExtractResult {
  return {
    schema_version: RESULT_SCHEMA_VERSION,
    url_input: opts.url,
    url_final: opts.url,
    title: "",
    loaded_at: startedAt,
    status: "error",
    error: errorMsg,
    engine: "stagehand",
    data: null,
    schema_used: opts.schema,
    instruction_used: opts.instruction,
    selector_used: opts.selector,
    dom: null,
    console: null,
    screenshot: null,
    persona_id: personaId,
    artifacts_dir: runDir,
    cost_usd: 0,
    duration_ms: Date.now() - t0,
  };
}

// ─────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────

function safePageUrl(page: Page, fallback: string): string {
  try {
    return page.url();
  } catch {
    return fallback;
  }
}

async function extractHeadings(page: Page): Promise<string[]> {
  return page
    .evaluate(() => {
      const out: string[] = [];
      for (const h of Array.from(document.querySelectorAll("h1, h2, h3"))) {
        const text = (h.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
        if (!text) continue;
        out.push(`${h.tagName.toLowerCase()}: ${text}`);
        if (out.length >= 10) break;
      }
      return out;
    })
    .catch(() => [] as string[]);
}

function wireConsoleListeners(page: Page): ConsoleError[] {
  const consoleErrors: ConsoleError[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push({
        type: "console",
        text: msg.text(),
        location: msg.location()?.url,
        timestamp: new Date().toISOString(),
      });
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors.push({
      type: "pageerror",
      text: err.message,
      location: err.stack,
      timestamp: new Date().toISOString(),
    });
  });
  page.on("requestfailed", (req) => {
    const failure = req.failure();
    consoleErrors.push({
      type: "requestfailed",
      text: `${failure?.errorText ?? "unknown"} ${req.url()}`,
      timestamp: new Date().toISOString(),
    });
  });
  return consoleErrors;
}

function normalizeWaitUntil(
  waitFor: WaitFor | undefined,
): "load" | "domcontentloaded" | "networkidle" {
  if (waitFor === "load" || waitFor === "domcontentloaded" || waitFor === "networkidle") {
    return waitFor;
  }
  return "load";
}

const defaultOpenStagehand: StagehandOpenFn = async (cfg) => {
  // Lazy import — keeps the primitive importable in test environments
  // where the Stagehand peer dep may be absent. Production paths fail
  // here with a clear install hint when it isn't.
  const mod = (await import("@browserbasehq/stagehand").catch(() => null)) as
    | { Stagehand?: new (...args: unknown[]) => unknown }
    | null;

  if (!mod || !mod.Stagehand) {
    throw new Error(
      "Stagehand not installed — `extract` requires @browserbasehq/stagehand. Run `npm install @browserbasehq/stagehand`.",
    );
  }

  type StagehandV3 = {
    init(): Promise<void>;
    extract(
      instruction: string,
      schema?: unknown,
      options?: { selector?: string },
    ): Promise<unknown>;
    close(opts?: { force?: boolean }): Promise<void>;
    get context(): BrowserContext;
    get metrics(): Promise<StagehandMetricsSnapshot & Record<string, number>>;
  };
  const Ctor = mod.Stagehand as new (cfg: Record<string, unknown>) => StagehandV3;

  const stagehand = new Ctor({
    env: "LOCAL",
    model: {
      modelName: `anthropic/${cfg.model}`,
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
    verbose: 1,
    disablePino: true,
    localBrowserLaunchOptions: {
      headless: cfg.headless,
      viewport: cfg.viewport,
      locale: cfg.locale,
      timezoneId: cfg.timezone,
    },
  });
  await stagehand.init();
  // v3: pages live on V3Context.pages(); `stagehand.page` is gone.
  const ctx = stagehand.context;
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  // ADR-034 Phase 0 — attach white-box collector. Stagehand V3Context is
  // a real Playwright BrowserContext; same hooks as the pure Playwright
  // path in see.ts / act.ts work here too.
  const { WhiteboxCollector } = await import("../whitebox-collector.js");
  const whitebox = new WhiteboxCollector(ctx, page);
  whitebox.attach();
  // PR-C: PerformanceSignalCollector for Web Vitals (must attach before goto).
  const { PerformanceSignalCollector } = await import(
    "../../agent/signals/performance.js"
  );
  const performance = new PerformanceSignalCollector(page);
  await performance.attach();
  const consoleErrors = wireConsoleListeners(page);

  const waitUntil = normalizeWaitUntil(cfg.waitFor);
  await page.goto(cfg.url, { waitUntil, timeout: cfg.timeoutMs });
  if (typeof cfg.waitFor === "object" && cfg.waitFor.type === "selector") {
    await page.waitForSelector(cfg.waitFor.selector, { timeout: cfg.timeoutMs });
  }

  return {
    page,
    context: ctx,
    consoleErrors,
    whitebox,
    performance,
    extract: (args: ExtractCallArgs) => {
      const instruction = args.instruction ?? "";
      // v3 extract is positional: extract(instruction, schema?, options?).
      // Selector forwarded; page is left to v3's `awaitActivePage()` —
      // passing our Playwright Page errors with "Failed to resolve V3
      // Page from Playwright page".
      const options = args.selector ? { selector: args.selector } : undefined;
      return stagehand.extract(instruction, args.schema, options);
    },
    readMetrics: async () => {
      // v3 made metrics async — fetches from API in BROWSERBASE mode,
      // returns local in LOCAL mode (which is what we use here).
      const m = await stagehand.metrics;
      return {
        extractPromptTokens: m?.extractPromptTokens ?? 0,
        extractCompletionTokens: m?.extractCompletionTokens ?? 0,
      };
    },
    close: async () => {
      try {
        await stagehand.close({ force: true });
      } catch {
        /* ignore */
      }
    },
  };
};

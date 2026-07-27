/**
 * `act` primitive (N-2) — execute a sequence of actions on a URL.
 *
 * Intent: an AI agent (Claude Code etc.) wants to "do" something on a page —
 * click, type, screenshot, ask the page a natural-language question — and
 * get back a structured per-step record plus a final DOM summary, console
 * errors, and a final screenshot. This is the second AI primitive in the
 * v1 catalog, following `see` (N-1).
 *
 * Engine selection (auto):
 *   - If any step is `{ type: "act" }`, the session runs on Stagehand
 *     (~5 s cold-start) so the natural-language action can be resolved by
 *     Stagehand's act() AI call.
 *   - Otherwise the session runs on raw Playwright (~1 s cold-start), the
 *     same fast path used by `see`. Pure-Playwright steps (goto / click /
 *     fill / press / wait / wait_for / scroll / screenshot) are fully
 *     deterministic and need no LLM.
 *
 * `note { goal }` always runs through `callVision` directly. It does not
 * require Stagehand and works with either engine.
 *
 * Cost-guard: every LLM-bearing step (`act` via Stagehand, `note` via
 * `callVision`) flows through `callVision` / Stagehand's own LLM client.
 * `callVision` is wired to the cost ledger and per-run AsyncLocalStorage
 * (M5-6 + M9-3). MCP-side dispatch wraps every tool call in `withCostRun`
 * so two parallel `act` invocations get independent run snapshots.
 *
 * Failure semantics: `stop_on_error: true` (default) breaks the loop on
 * first failure and marks subsequent steps as `skipped`. `false` keeps
 * going — useful for "best effort" exploratory sequences.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

import { getLogger } from "../logger.js";
import { extractDomSummary } from "../../agent/dom-summary.js";
import { callVision, type VisionResponse } from "../llm.js";
import { compressForVisionMulti, MULTI_IMAGE_PROMPT_NOTE } from "../image.js";
import { RESULT_SCHEMA_VERSION } from "../result-schema.js";
import type { ConsoleError } from "../types.js";
import {
  DEFAULT_LOCALE,
  DEFAULT_TIMEZONE,
  DEFAULT_VIEWPORT,
  type SeePersonaHints,
  type WaitFor,
} from "./see.js";
import { VisualCollector, shouldScore } from "../visual-collector.js";

const log = getLogger("primitive.act");

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

export type ActStep =
  | { type: "goto"; url: string; wait_for?: WaitFor; timeout_ms?: number }
  | { type: "click"; selector: string; timeout_ms?: number }
  | { type: "fill"; selector: string; value: string; timeout_ms?: number }
  | { type: "press"; key: string; selector?: string; timeout_ms?: number }
  | { type: "wait"; ms: number }
  | {
      type: "wait_for";
      selector: string;
      state?: "visible" | "attached" | "hidden";
      timeout_ms?: number;
    }
  | { type: "scroll"; selector?: string; delta_y?: number; to_bottom?: boolean }
  | { type: "screenshot"; label?: string; full_page?: boolean }
  | { type: "act"; instruction: string }
  | { type: "note"; goal: string };

export type ActStepKind = ActStep["type"];

export interface ActOptions {
  /** Target URL. Loaded before any step runs. */
  url: string;
  /** Sequence of actions to run, in order. */
  steps: ActStep[];
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
  /** Default per-action timeout (ms). Default 30000. */
  timeoutMs?: number;
  /** Initial-navigation wait strategy. Default "networkidle". */
  waitFor?: WaitFor;
  /** Run headless. Default true. */
  headless?: boolean;
  /** Stop the loop on first error and skip remaining steps. Default true. */
  stopOnError?: boolean;
  /** Where to write per-call artifacts. Default `$AUDIT_ACTS_DIR` or `~/.pixelcheck/acts/`. */
  artifactsRoot?: string;
  /** Critic model for `note` steps. Default `"claude-sonnet-4-6"`. */
  criticModel?: string;
  /** Force the engine. Default: auto (stagehand if any `act` step, else playwright). */
  engine?: ActEngine;

  /**
   * Rubric-based visual scoring (PR-D / ADR-034). See `SeeOptions.visualScoring`
   * for the full mode semantics. `'auto'` mode invokes when any step in the
   * sequence supplies a `goal` (e.g. a `note` step). Default `'off'`.
   */
  visualScoring?: import("../visual-collector.js").VisualScoringMode;
  /** Built-in rubrics for visual scoring. Default `["aesthetic"]`. */
  visualRubrics?: import("./judge.js").JudgeOptions["rubrics"];
  /** Caller-supplied criteria appended after rubric criteria. */
  visualCustomCriteria?: import("./judge.js").JudgeOptions["customCriteria"];
  /** Vision model used for visual scoring. Default `DEFAULT_JUDGE_MODEL`. */
  visualModel?: string;

  // ── Test seams (same pattern as see / cost-guard) ────────────
  /** Replace the raw-Playwright open path. */
  _open?: PlaywrightOpenFn;
  /** Replace the Stagehand open path. */
  _openStagehand?: StagehandOpenFn;
  /** Replace the vision call used by `note` steps. */
  _callVision?: typeof callVision;
}

export type ActEngine = "playwright" | "stagehand";

export interface ActStepResult {
  index: number;
  type: ActStepKind;
  status: "ok" | "error" | "skipped";
  duration_ms: number;
  error?: string;
  screenshot?: { path: string; sha256: string; bytes?: number; width?: number; height?: number };
  note?: string;
  output?: unknown;
  cost_usd: number;
}

export interface ActResult {
  schema_version: string;
  url_input: string;
  url_final: string;
  title: string;
  started_at: string;
  finished_at: string;
  status: "ok" | "error";
  error?: string;
  engine: ActEngine;
  steps: ActStepResult[];
  dom: {
    interactive_count: number;
    headings: string[];
    summary: string;
    text_excerpt?: string;
  } | null;
  console: { errors_count: number; errors: ConsoleError[] } | null;
  screenshot: { path: string; sha256: string; bytes?: number; width?: number; height?: number } | null;
  persona_id: string;
  artifacts_dir: string;
  cost_usd: number;
  duration_ms: number;
  /** Multi-dimensional audit diagnostics (ADR-034 / Phase 0). Populated
   *  by WhiteboxCollector when default open paths are used. */
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
// Open-function shapes (test seams)
// ─────────────────────────────────────────────────────────────

export interface OpenedPlaywright {
  page: Page;
  context: BrowserContext | null;
  consoleErrors: ConsoleError[];
  /** Optional WhiteboxCollector attached on default open paths. Test
   *  seams may omit it; act then skips diagnostics. (PR-B / ADR-034) */
  whitebox?: import("../whitebox-collector.js").WhiteboxCollector;
  /** Optional PerformanceSignalCollector attached on default open paths.
   *  Test seams may omit it. (PR-C / ADR-034) */
  performance?: import("../../agent/signals/performance.js").PerformanceSignalCollector;
  close: () => Promise<void>;
}

export interface OpenedStagehand extends OpenedPlaywright {
  /** Run a Stagehand AI act() call against the active page. */
  stagehandAct: (instruction: string) => Promise<unknown>;
}

export type PlaywrightOpenFn = (cfg: OpenConfig) => Promise<OpenedPlaywright>;
export type StagehandOpenFn = (cfg: OpenConfig) => Promise<OpenedStagehand>;

export interface OpenConfig {
  url: string;
  viewport: { width: number; height: number };
  locale: string;
  timezone: string;
  userAgent?: string;
  headless: boolean;
  timeoutMs: number;
  waitFor: WaitFor;
}

// ─────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────

export const DEFAULT_PERSONA_ID = "act-default-desktop";
export const DEFAULT_CRITIC_MODEL = "claude-sonnet-4-6";

/** Resolve the artifacts root with env override. */
export function defaultArtifactsRoot(): string {
  const envDir = process.env.AUDIT_ACTS_DIR;
  if (envDir && envDir.length > 0) return envDir;
  const home =
    process.env.PIXELCHECK_HOME ??
    process.env.AUDIT_HOME ??
    path.join(os.homedir(), ".pixelcheck");
  return path.join(home, "acts");
}

/** Pick the engine for a given step list. */
export function pickEngine(steps: ActStep[]): ActEngine {
  return steps.some((s) => s.type === "act") ? "stagehand" : "playwright";
}

function makeRunDir(root: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(3).toString("hex");
  const dir = path.join(root, `${ts}-${rand}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// ─────────────────────────────────────────────────────────────
// Primitive
// ─────────────────────────────────────────────────────────────

export async function act(opts: ActOptions): Promise<ActResult> {
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
  const stopOnError = opts.stopOnError ?? true;
  const engine: ActEngine = opts.engine ?? pickEngine(opts.steps);

  const artifactsRoot = opts.artifactsRoot ?? defaultArtifactsRoot();
  fs.mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 });
  const runDir = makeRunDir(artifactsRoot);

  const stepResults: ActStepResult[] = [];
  let urlFinal = opts.url;
  let title = "";
  let dom: ActResult["dom"] = null;
  let consoleSection: ActResult["console"] = null;
  let finalScreenshot: ActResult["screenshot"] = null;
  let costUsd = 0;
  let status: ActResult["status"] = "ok";
  let errorMsg: string | undefined;
  /** ADR-034 Phase 0 — populated from WhiteboxCollector when default open
   *  paths are used. Test seams that omit `whitebox` get no diagnostics. */
  let diagnostics: ActResult["diagnostics"] = undefined;

  try {
    const opened = await openSession(engine, {
      url: opts.url,
      viewport,
      locale,
      timezone,
      userAgent,
      headless,
      timeoutMs,
      waitFor,
      _open: opts._open,
      _openStagehand: opts._openStagehand,
    });

    try {
      const page = opened.page;
      let aborted = false;

      for (let i = 0; i < opts.steps.length; i++) {
        const step = opts.steps[i]!;
        if (aborted) {
          stepResults.push({
            index: i,
            type: step.type,
            status: "skipped",
            duration_ms: 0,
            cost_usd: 0,
          });
          continue;
        }
        const result = await runStep({
          step,
          index: i,
          page,
          opened,
          runDir,
          defaultTimeoutMs: timeoutMs,
          criticModel: opts.criticModel ?? DEFAULT_CRITIC_MODEL,
          callVisionImpl: opts._callVision ?? callVision,
          engine,
        });
        stepResults.push(result);
        costUsd += result.cost_usd;
        if (result.status === "error" && stopOnError) {
          aborted = true;
        }
      }

      urlFinal = safePageUrl(page, opts.url);
      title = await page.title().catch(() => "");

      try {
        const buf = await page.screenshot({ fullPage, type: "png" });
        const sha = crypto.createHash("sha256").update(buf).digest("hex");
        const finalPath = path.join(runDir, "screenshot.png");
        fs.writeFileSync(finalPath, buf);
        fs.writeFileSync(`${finalPath}.sha256`, sha + "\n");
        finalScreenshot = {
          path: finalPath,
          sha256: sha,
          bytes: buf.length,
          width: viewport.width,
          height: viewport.height,
        };
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "act: final screenshot failed",
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
            "act: DOM summary extraction failed",
          );
        }
      }

      if (includeConsole) {
        const errs = opened.consoleErrors.slice();
        consoleSection = { errors_count: errs.length, errors: errs };
      }

      if (stepResults.some((s) => s.status === "error")) {
        status = "error";
        const firstErr = stepResults.find((s) => s.status === "error")!;
        errorMsg = `step ${firstErr.index} (${firstErr.type}): ${firstErr.error ?? "unknown"}`;
      }

      // ADR-034 Phase 0: collect diagnostics before context.close().
      const visualMode = opts.visualScoring ?? "off";
      // act has no top-level `goal`; `'auto'` triggers if any step is a `note`
      // step (which itself makes a vision call, so bundling visual scoring
      // costs only one extra call).
      const hasNoteStep = opts.steps.some((s) => s.type === "note");
      const visualDecision = shouldScore({
        mode: visualMode,
        hasGoal: hasNoteStep,
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
              "act: whitebox diagnostics collection failed",
            );
          }
        }
        if (opened.performance) {
          try {
            diagnostics.performance = await opened.performance.snapshot();
          } catch (perfErr) {
            log.warn(
              { err: perfErr instanceof Error ? perfErr.message : String(perfErr) },
              "act: performance diagnostics collection failed",
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
          } else if (!finalScreenshot) {
            diagnostics.visual = collector.skip("no_screenshot");
          } else {
            try {
              const buf = fs.readFileSync(finalScreenshot.path);
              diagnostics.visual = await collector.score(buf);
              costUsd += diagnostics.visual.cost_usd;
            } catch (visErr) {
              log.warn(
                { err: visErr instanceof Error ? visErr.message : String(visErr) },
                "act: visual scoring failed",
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
    log.warn({ err: errorMsg, url: opts.url, runDir }, "act: navigation failed");
  }

  const finishedAt = new Date().toISOString();
  return {
    schema_version: RESULT_SCHEMA_VERSION,
    url_input: opts.url,
    url_final: urlFinal,
    title,
    started_at: startedAt,
    finished_at: finishedAt,
    status,
    error: errorMsg,
    engine,
    steps: stepResults,
    dom,
    console: consoleSection,
    screenshot: finalScreenshot,
    persona_id: personaId,
    artifacts_dir: runDir,
    cost_usd: costUsd,
    duration_ms: Date.now() - t0,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

// ─────────────────────────────────────────────────────────────
// Step execution
// ─────────────────────────────────────────────────────────────

interface RunStepCtx {
  step: ActStep;
  index: number;
  page: Page;
  opened: OpenedPlaywright | OpenedStagehand;
  runDir: string;
  defaultTimeoutMs: number;
  criticModel: string;
  callVisionImpl: typeof callVision;
  engine: ActEngine;
}

async function runStep(ctx: RunStepCtx): Promise<ActStepResult> {
  const t0 = Date.now();
  const base = {
    index: ctx.index,
    type: ctx.step.type,
    status: "ok" as const,
    duration_ms: 0,
    cost_usd: 0,
  };
  try {
    switch (ctx.step.type) {
      case "goto": {
        const wait = normalizeWaitUntil(ctx.step.wait_for);
        await ctx.page.goto(ctx.step.url, {
          waitUntil: wait,
          timeout: ctx.step.timeout_ms ?? ctx.defaultTimeoutMs,
        });
        if (
          typeof ctx.step.wait_for === "object" &&
          ctx.step.wait_for !== null &&
          ctx.step.wait_for.type === "selector"
        ) {
          await ctx.page.waitForSelector(ctx.step.wait_for.selector, {
            timeout: ctx.step.timeout_ms ?? ctx.defaultTimeoutMs,
          });
        }
        return {
          ...base,
          duration_ms: Date.now() - t0,
          output: { url: ctx.step.url },
        };
      }
      case "click": {
        await ctx.page.click(ctx.step.selector, {
          timeout: ctx.step.timeout_ms ?? ctx.defaultTimeoutMs,
        });
        return { ...base, duration_ms: Date.now() - t0 };
      }
      case "fill": {
        await ctx.page.fill(ctx.step.selector, ctx.step.value, {
          timeout: ctx.step.timeout_ms ?? ctx.defaultTimeoutMs,
        });
        return { ...base, duration_ms: Date.now() - t0 };
      }
      case "press": {
        if (ctx.step.selector) {
          // Honour the per-step timeout while waiting for the target element,
          // same as click/fill — a slow-to-appear target shouldn't hang on
          // Playwright's default. (Audit 2026-06-02 E9.)
          await ctx.page
            .locator(ctx.step.selector)
            .first()
            .press(ctx.step.key, {
              timeout: ctx.step.timeout_ms ?? ctx.defaultTimeoutMs,
            });
        } else {
          await ctx.page.keyboard.press(ctx.step.key);
        }
        return { ...base, duration_ms: Date.now() - t0 };
      }
      case "wait": {
        await ctx.page.waitForTimeout(ctx.step.ms);
        return { ...base, duration_ms: Date.now() - t0 };
      }
      case "wait_for": {
        await ctx.page.waitForSelector(ctx.step.selector, {
          state: ctx.step.state ?? "visible",
          timeout: ctx.step.timeout_ms ?? ctx.defaultTimeoutMs,
        });
        return { ...base, duration_ms: Date.now() - t0 };
      }
      case "scroll": {
        if (ctx.step.to_bottom) {
          await ctx.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        } else if (ctx.step.selector) {
          await ctx.page.locator(ctx.step.selector).first().scrollIntoViewIfNeeded();
        } else if (typeof ctx.step.delta_y === "number") {
          const dy = ctx.step.delta_y;
          await ctx.page.evaluate((delta) => window.scrollBy(0, delta), dy);
        } else {
          // No to_bottom / selector / delta_y → there is nothing to scroll.
          // Reporting success would mask a misconfigured step; fail loudly
          // instead. (Audit 2026-06-02 E9.)
          throw new Error(
            "scroll step is a no-op: set one of to_bottom, selector, or delta_y",
          );
        }
        return { ...base, duration_ms: Date.now() - t0 };
      }
      case "screenshot": {
        const buf = await ctx.page.screenshot({
          fullPage: ctx.step.full_page ?? true,
          type: "png",
        });
        const sha = crypto.createHash("sha256").update(buf).digest("hex");
        const safeLabel =
          (ctx.step.label ?? `step-${ctx.index}`).replace(/[^a-zA-Z0-9._-]/g, "-") || `step-${ctx.index}`;
        const filePath = path.join(ctx.runDir, `${safeLabel}.png`);
        fs.writeFileSync(filePath, buf);
        fs.writeFileSync(`${filePath}.sha256`, sha + "\n");
        return {
          ...base,
          duration_ms: Date.now() - t0,
          screenshot: { path: filePath, sha256: sha, bytes: buf.length },
        };
      }
      case "act": {
        const stagehandAct = (ctx.opened as OpenedStagehand).stagehandAct;
        if (typeof stagehandAct !== "function") {
          throw new Error(
            "act step requires the stagehand engine; engine resolution returned playwright",
          );
        }
        const out = await stagehandAct(ctx.step.instruction);
        return {
          ...base,
          duration_ms: Date.now() - t0,
          output: out as unknown,
        };
      }
      case "note": {
        const buf = await ctx.page.screenshot({ fullPage: true, type: "png" });
        const compressed = await compressForVisionMulti(buf);
        const multiImage = compressed.length > 1;
        const resp: VisionResponse = await ctx.callVisionImpl({
          model: ctx.criticModel,
          systemPrompt:
            "You are a careful UI observer. Answer the user's question about the page in 1-3 sentences. Cite only what you can actually see. If the question cannot be answered from what is shown, say so plainly. Do not speculate or invent.",
          userPrompt: multiImage
            ? (ctx.step.goal ?? "") + MULTI_IMAGE_PROMPT_NOTE
            : ctx.step.goal,
          images: compressed.map((c) => ({
            base64: c.base64,
            mediaType: c.mediaType,
          })),
          maxTokens: 512,
        });
        return {
          ...base,
          duration_ms: Date.now() - t0,
          note: resp.text.trim(),
          cost_usd: resp.costUsd,
        };
      }
    }
  } catch (err) {
    return {
      ...base,
      status: "error",
      duration_ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Engine open
// ─────────────────────────────────────────────────────────────

interface OpenSessionInput extends OpenConfig {
  _open?: PlaywrightOpenFn;
  _openStagehand?: StagehandOpenFn;
}

async function openSession(
  engine: ActEngine,
  cfg: OpenSessionInput,
): Promise<OpenedPlaywright | OpenedStagehand> {
  if (engine === "stagehand") {
    const open = cfg._openStagehand ?? defaultOpenStagehand;
    return open(cfg);
  }
  const open = cfg._open ?? defaultOpenPlaywright;
  return open(cfg);
}

const defaultOpenPlaywright: PlaywrightOpenFn = async (cfg) => {
  const browser = await chromium.launch({ headless: cfg.headless });
  const context = await browser.newContext({
    viewport: cfg.viewport,
    locale: cfg.locale,
    timezoneId: cfg.timezone,
    userAgent: cfg.userAgent,
  });
  const page = await context.newPage();
  // ADR-034 Phase 0 — attach white-box collector AFTER newPage so popup
  // listener doesn't capture the main page itself, BEFORE goto so popup
  // / network events on the initial navigation are captured.
  const { WhiteboxCollector } = await import("../whitebox-collector.js");
  const whitebox = new WhiteboxCollector(context, page);
  whitebox.attach();
  // PR-C: attach existing PerformanceSignalCollector for Web Vitals.
  // MUST attach before goto so addInitScript injects the
  // PerformanceObserver before first paint.
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
    context,
    consoleErrors,
    whitebox,
    performance,
    close: async () => {
      try {
        await context.close();
      } catch {
        /* ignore */
      }
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    },
  };
};

const defaultOpenStagehand: StagehandOpenFn = async (cfg) => {
  // Lazy import — keeps the primitive importable in test environments
  // where the Stagehand peer dep may be absent.
  const mod = (await import("@browserbasehq/stagehand").catch(() => null)) as
    | { Stagehand?: new (...args: unknown[]) => unknown }
    | null;

  if (!mod || !mod.Stagehand) {
    throw new Error(
      "Stagehand not installed — `act` steps require @browserbasehq/stagehand. Run `npm install @browserbasehq/stagehand`.",
    );
  }

  type StagehandV3 = {
    init(): Promise<void>;
    act(instruction: string, options?: unknown): Promise<unknown>;
    close(opts?: { force?: boolean }): Promise<void>;
    get context(): BrowserContext;
  };
  const Ctor = mod.Stagehand as new (cfg: Record<string, unknown>) => StagehandV3;

  const baseModel = "claude-sonnet-4-6";
  const stagehand = new Ctor({
    env: "LOCAL",
    model: {
      modelName: `anthropic/${baseModel}`,
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
  // v3 removed `stagehand.page`; pages now live on V3Context.pages().
  // The active page (the one Stagehand will drive) is the most-recently-
  // active tab — for our single-page primitive flow it's pages()[0].
  const ctx = stagehand.context;
  const pages = ctx.pages();
  const page = pages[0] ?? (await ctx.newPage());
  // ADR-034 Phase 0 — attach white-box collector. Stagehand's V3Context
  // is a real Playwright BrowserContext under the hood, so the same
  // popup / network / cookie / storage hooks work as in the pure
  // Playwright path above.
  const { WhiteboxCollector } = await import("../whitebox-collector.js");
  const whitebox = new WhiteboxCollector(ctx, page);
  whitebox.attach();
  // PR-C: same PerformanceSignalCollector wiring as the Playwright path
  // (Stagehand V3Context is a real Playwright BrowserContext).
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
    // v3's act() is positional `act(instruction, options?)` on the
    // Stagehand instance — not on the page like v2. We let Stagehand pick
    // its V3Context's active page automatically; passing our Playwright
    // Page object errors with "Failed to resolve V3 Page from Playwright
    // page". Same CDP target underneath either way.
    stagehandAct: (instruction: string) => stagehand.act(instruction),
    close: async () => {
      try {
        await stagehand.close({ force: true });
      } catch {
        /* ignore */
      }
    },
  };
};

// ─────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────

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

/**
 * `see` primitive (N-1) — one-shot navigation snapshot for AI clients.
 *
 * Intent: an AI agent (Claude Code etc.) wants to "look at" a URL and get
 * back a structured observation — DOM summary, console errors, a saved
 * screenshot, and (optionally) a short natural-language note answering a
 * question about the page. This is the lightest primitive in the kit:
 *   - No scenario YAML
 *   - No persona file required (persona hints are optional)
 *   - No reporter / SPA / history pipeline
 *   - 0 LLM cost when `goal` is omitted (snapshot only; result is cacheable)
 *   - When `goal` is provided: the goal vision call, plus a lightweight
 *     visual-state / key-elements vision call (gated on `goal`, see below)
 *
 * Architectural note: this primitive deliberately bypasses Stagehand and the
 * runner. It uses raw Playwright. Stagehand's init cost (~3-5 s + LLM-bound
 * model initialisation) defeats the point of `see`. The trade-off is that
 * `see` does not run the full stealth-core fingerprint patches; if a target
 * site requires bot-evasion the caller should reach for `audit_url` /
 * `explore_url` instead.
 *
 * Cost-guard: vision calls go through `callVision`, which already wires the
 * cost ledger and the per-run AsyncLocalStorage scope (M5-6 + M9-3). So an
 * MCP `see` invocation under the standard dispatcher already inherits its
 * own per-run snapshot.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { chromium, type Page } from "playwright";

import { getLogger } from "../logger.js";
import { extractDomSummary } from "../../agent/dom-summary.js";
import { callVision, type VisionResponse } from "../llm.js";
import {
  compressForVision,
  compressForVisionMulti,
  MULTI_IMAGE_PROMPT_NOTE,
} from "../image.js";
import type { ConsoleError } from "../types.js";
import { RESULT_SCHEMA_VERSION, type ResultCacheMeta } from "../result-schema.js";
import { withResultCache } from "../result-cache.js";
import { VisualCollector, shouldScore } from "../visual-collector.js";

const log = getLogger("primitive.see");

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

export type WaitFor =
  | "load"
  | "domcontentloaded"
  | "networkidle"
  | { type: "selector"; selector: string };

/**
 * Optional persona-shaped hints. `see` accepts only the navigational fields
 * it needs; full Persona objects from `personas/*.yaml` are forward-compatible
 * (extra fields are ignored).
 */
export interface SeePersonaHints {
  id?: string;
  viewport?: { width: number; height: number };
  locale?: string;
  timezone?: string;
  user_agent?: string;
  network_profile?: string;
}

export interface SeeOptions {
  /** Target URL. Required. */
  url: string;
  /** When set, run a single vision call to answer this question about the page. */
  goal?: string;
  /** Persona-shaped navigational hints. Optional. */
  persona?: SeePersonaHints;
  /** Page wait strategy after navigation. Default `"networkidle"`. */
  waitFor?: WaitFor;
  /** Override viewport. Default: persona viewport, else 1280x800. */
  viewport?: { width: number; height: number };
  /** Full-page screenshot vs viewport-only. Default true. */
  fullPage?: boolean;
  /** Include DOM summary in the result. Default true. */
  includeDom?: boolean;
  /** Include console errors in the result. Default true. */
  includeConsole?: boolean;
  /** Per-navigation timeout ms. Default 30000. */
  timeoutMs?: number;
  /** Run headless. Default true. */
  headless?: boolean;
  /** Where to write per-call artifacts (one subdir per `see`). Default: `$AUDIT_SEES_DIR` or `~/.pixelcheck/sees/`. */
  artifactsRoot?: string;
  /** Critic model id. Default `"claude-sonnet-4-6"`. */
  criticModel?: string;

  /**
   * Rubric-based visual scoring (PR-D / ADR-034). Controls whether the
   * VisualCollector runs after the page is captured, populating
   * `result.diagnostics.visual`.
   *
   * - `'off'` (default): never invoke. The other diagnostics dimensions
   *   are passive observers (whitebox / performance) so they always
   *   collect; visual scoring costs real LLM money so it requires
   *   explicit opt-in.
   * - `'auto'`: invoke only when `goal` is supplied — the host call was
   *   already going to make a vision call, so the visual scoring is
   *   bundled in.
   * - `'eager'`: invoke unconditionally. Matches ADR-034's
   *   "always-collect" stance for callers running a full audit.
   */
  visualScoring?: import("../visual-collector.js").VisualScoringMode;
  /** Built-in rubrics for visual scoring. Default `["aesthetic"]`. */
  visualRubrics?: import("./judge.js").JudgeOptions["rubrics"];
  /** Caller-supplied criteria appended after rubric criteria. */
  visualCustomCriteria?: import("./judge.js").JudgeOptions["customCriteria"];
  /** Vision model used for visual scoring. Default `DEFAULT_JUDGE_MODEL`. */
  visualModel?: string;

  /**
   * Result cache (M9-4). Only applied when `goal` is set, because
   * without a goal `see` makes no LLM call and a cached snapshot
   * could mislead the caller with stale page state. Defaults: cache
   * enabled, no bust, TTL from env.
   */
  cache?: boolean;
  cacheBust?: boolean;
  cacheTtlMs?: number;

  /**
   * Test seam: replace the Playwright launch + navigate path. Returns the
   * loaded `Page`, the running list of console errors, and a `close()`
   * teardown. When set, defaults browser/context/proxy logic is skipped.
   */
  _open?: OpenFn;
  /** Test seam: stub the vision call for note synthesis. */
  _callVision?: typeof callVision;
}

export interface SeeResult {
  schema_version: string;
  url_input: string;
  url_final: string;
  title: string;
  loaded_at: string;
  status: "ok" | "error";
  error?: string;
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
  note: string | null;
  /** Visual state detected from screenshot (loading / ready / error / empty / partial). */
  visual_state?: "loading" | "ready" | "error" | "empty" | "partial";
  /** Key interactive elements detected from screenshot with approximate positions. */
  key_elements?: Array<{
    label: string;
    type: string;
    region: "top-left" | "top-center" | "top-right" | "center-left" | "center" | "center-right" | "bottom-left" | "bottom-center" | "bottom-right";
    obscured?: boolean;
  }>;
  persona_id: string;
  artifacts_dir: string;
  cost_usd: number;
  duration_ms: number;
  /** Result-cache annotation (M9-4). Absent when caching not applicable. */
  cache?: ResultCacheMeta;
  /** Multi-dimensional audit diagnostics (ADR-034 / Phase 0). Populated
   *  by the WhiteboxCollector when one is attached via defaultOpen.
   *  Test seams that supply a custom `_open` without a collector get
   *  no diagnostics field. */
  diagnostics?: {
    collected_at: "always" | "on_failure";
    popups?: import("../whitebox-collector.js").PopupSnapshot[];
    network?: import("../whitebox-collector.js").NetworkLog;
    cookies?: import("../whitebox-collector.js").CookieData[];
    storage?: import("../whitebox-collector.js").StorageSnapshot;
    /** Core Web Vitals + page-load + resource metrics (PR-C / ADR-034).
     *  Mirrors the PerformanceSignal shape from the existing
     *  PerformanceSignalCollector in src/agent/signals/performance.ts. */
    performance?: import("../../agent/signals/performance.js").PerformanceSignal;
    /** Rubric-based vision scoring (PR-D / ADR-034). Only populated
     *  when `cfg.visualScoring` opts in (default `'off'`) — this is
     *  the only diagnostics dimension that costs LLM money. */
    visual?: import("../result-schema.js").VisualScoring;
  };
}

export type OpenFn = (cfg: {
  url: string;
  viewport: { width: number; height: number };
  locale: string;
  timezone: string;
  userAgent?: string;
  networkProfile?: string;
  headless: boolean;
  timeoutMs: number;
  waitFor: WaitFor;
}) => Promise<{
  page: Page;
  consoleErrors: ConsoleError[];
  /** Optional WhiteboxCollector attached on `defaultOpen`. Test seams
   *  may omit it; the see primitive then skips diagnostics. (PR-B / ADR-034) */
  whitebox?: import("../whitebox-collector.js").WhiteboxCollector;
  /** Optional PerformanceSignalCollector attached on `defaultOpen`.
   *  Test seams may omit it. (PR-C / ADR-034) */
  performance?: import("../../agent/signals/performance.js").PerformanceSignalCollector;
  close: () => Promise<void>;
}>;

// ─────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
export const DEFAULT_LOCALE = "en-US";
export const DEFAULT_TIMEZONE = "UTC";
export const DEFAULT_PERSONA_ID = "see-default-desktop";
export const DEFAULT_CRITIC_MODEL = "claude-sonnet-4-6";

/** Resolve the artifacts root with env override. */
export function defaultArtifactsRoot(): string {
  const envDir = process.env.AUDIT_SEES_DIR;
  if (envDir && envDir.length > 0) return envDir;
  const home =
    process.env.PIXELCHECK_HOME ??
    process.env.AUDIT_HOME ??
    path.join(os.homedir(), ".pixelcheck");
  return path.join(home, "sees");
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

/**
 * Build the cache-key inputs for a `see` call. Extracted so callers
 * (and tests) can reason about exactly what makes two calls equivalent
 * for caching purposes. Excludes timeout / headless / artifactsRoot —
 * those affect performance / file location, not the observable result.
 */
function seeCacheKeyInputs(opts: SeeOptions): unknown {
  const persona = opts.persona ?? {};
  return {
    url: opts.url,
    goal: opts.goal,
    waitFor: opts.waitFor ?? "networkidle",
    fullPage: opts.fullPage ?? true,
    includeDom: opts.includeDom ?? true,
    includeConsole: opts.includeConsole ?? true,
    viewport: opts.viewport ?? persona.viewport ?? { width: 1280, height: 800 },
    locale: persona.locale ?? DEFAULT_LOCALE,
    timezone: persona.timezone ?? DEFAULT_TIMEZONE,
    user_agent: persona.user_agent,
    persona_id: persona.id,
    critic_model: opts.criticModel ?? DEFAULT_CRITIC_MODEL,
    // PR-D / ADR-034: visual scoring inputs alter the result envelope
    // (diagnostics.visual changes verdicts/findings) so they must be
    // part of the cache key.
    visual_scoring: opts.visualScoring ?? "off",
    visual_rubrics: opts.visualRubrics,
    visual_custom_criteria: opts.visualCustomCriteria,
    visual_model: opts.visualModel,
  };
}

export async function see(opts: SeeOptions): Promise<SeeResult> {
  // Cache only when a goal triggered a vision call. Without a goal,
  // see makes no LLM call and the result is a fresh page snapshot —
  // serving a cached one would mislead callers with possibly-stale
  // state.
  const eligible = typeof opts.goal === "string" && opts.goal.length > 0;
  if (!eligible) {
    return computeSee(opts);
  }
  return withResultCache<SeeResult>({
    primitive: "see",
    cacheKeyInputs: seeCacheKeyInputs(opts),
    cacheEnabled: opts.cache !== false,
    cacheBust: opts.cacheBust,
    ttlMs: opts.cacheTtlMs,
    compute: () => computeSee(opts),
  });
}

async function computeSee(opts: SeeOptions): Promise<SeeResult> {
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
  const artifactsRoot = opts.artifactsRoot ?? defaultArtifactsRoot();
  fs.mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 });
  const runDir = makeRunDir(artifactsRoot);

  let urlFinal = opts.url;
  let title = "";
  let dom: SeeResult["dom"] = null;
  let consoleSection: SeeResult["console"] = null;
  let screenshot: SeeResult["screenshot"] = null;
  let note: string | null = null;
  let visualState: SeeResult["visual_state"] = undefined;
  let keyElements: SeeResult["key_elements"] = undefined;
  let costUsd = 0;
  let status: SeeResult["status"] = "ok";
  let errorMsg: string | undefined;
  /** ADR-034 Phase 0 — populated from WhiteboxCollector inside the
   *  inner try, surfaced on the result if collection succeeded. */
  let diagnostics: SeeResult["diagnostics"] = undefined;

  try {
    const open = opts._open ?? defaultOpen;
    const opened = await open({
      url: opts.url,
      viewport,
      locale,
      timezone,
      userAgent,
      networkProfile: persona.network_profile,
      headless,
      timeoutMs,
      waitFor,
    });
    try {
      const page = opened.page;
      urlFinal = safePageUrl(page, opts.url);
      title = await page.title().catch(() => "");

      const buf = await page.screenshot({ fullPage, type: "png" });
      const shaHex = crypto.createHash("sha256").update(buf).digest("hex");
      const screenshotPath = path.join(runDir, "screenshot.png");
      fs.writeFileSync(screenshotPath, buf);
      fs.writeFileSync(`${screenshotPath}.sha256`, shaHex + "\n");
      screenshot = {
        path: screenshotPath,
        sha256: shaHex,
        bytes: buf.length,
        width: viewport.width,
        height: viewport.height,
      };

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
            "see: DOM summary extraction failed",
          );
        }
      }

      if (includeConsole) {
        const errs = opened.consoleErrors.slice();
        consoleSection = { errors_count: errs.length, errors: errs };
      }

      if (opts.goal) {
        const noteResult = await synthesizeNote({
          buf,
          goal: opts.goal,
          model: opts.criticModel ?? DEFAULT_CRITIC_MODEL,
          callVisionImpl: opts._callVision ?? callVision,
        });
        note = noteResult.text;
        costUsd += noteResult.costUsd;
      }

      // Visual state + key-elements detection. This makes its OWN vision call,
      // so it must only run when a goal is set — otherwise a goal-less `see`
      // (documented as 0 LLM cost, and snapshot-cacheable) would silently pay
      // for a Sonnet call on every snapshot. Gating on goal restores the
      // "0 cost without goal" contract and the goal-less cache. (Audit 2026-06-02 E1.)
      const hasGoalForVisualState =
        typeof opts.goal === "string" && opts.goal.length > 0;
      if (buf && !opts._open && hasGoalForVisualState) {
        try {
          const vsResult = await detectVisualState({
            buf,
            model: opts.criticModel ?? DEFAULT_CRITIC_MODEL,
            callVisionImpl: opts._callVision ?? callVision,
          });
          visualState = vsResult.visual_state;
          keyElements = vsResult.key_elements;
          costUsd += vsResult.costUsd;
        } catch (err) {
          log.warn({ err: err instanceof Error ? err.message : String(err) }, "see: visual state detection failed");
        }
      }

      // ADR-034 Phase 0: collect diagnostics before context.close().
      // Always-collect, never-skip (see ADR rationale). Test seams that omit
      // a collector simply leave the corresponding sub-field absent.
      const visualMode = opts.visualScoring ?? "off";
      const visualDecision = shouldScore({
        mode: visualMode,
        hasGoal: Boolean(opts.goal),
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
              "see: whitebox diagnostics collection failed",
            );
          }
        }
        if (opened.performance) {
          try {
            diagnostics.performance = await opened.performance.snapshot();
          } catch (perfErr) {
            log.warn(
              { err: perfErr instanceof Error ? perfErr.message : String(perfErr) },
              "see: performance diagnostics collection failed",
            );
          }
        }
        // PR-D / ADR-034: rubric-based visual scoring. Only invoked when
        // the caller opts in (`'auto'` with goal, or `'eager'`). On skip
        // we still emit a shaped envelope explaining why no scoring ran.
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
                "see: visual scoring failed",
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
    log.warn(
      { err: errorMsg, url: opts.url, runDir },
      "see: navigation failed",
    );
  }

  const durationMs = Date.now() - t0;
  return {
    schema_version: RESULT_SCHEMA_VERSION,
    url_input: opts.url,
    url_final: urlFinal,
    title,
    loaded_at: startedAt,
    status,
    error: errorMsg,
    dom,
    console: consoleSection,
    screenshot,
    note,
    ...(visualState ? { visual_state: visualState } : {}),
    ...(keyElements?.length ? { key_elements: keyElements } : {}),
    persona_id: personaId,
    artifacts_dir: runDir,
    cost_usd: costUsd,
    duration_ms: durationMs,
    ...(diagnostics ? { diagnostics } : {}),
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

async function synthesizeNote(args: {
  buf: Buffer;
  goal: string;
  model: string;
  callVisionImpl: typeof callVision;
}): Promise<{ text: string; costUsd: number }> {
  try {
    const compressed = await compressForVisionMulti(args.buf);
    const multiImage = compressed.length > 1;
    const resp: VisionResponse = await args.callVisionImpl({
      model: args.model,
      systemPrompt:
        "You are a careful UI observer. Answer the user's question about the page in 1-3 sentences. Cite only what you can actually see. If the question cannot be answered from what is shown, say so plainly. Do not speculate or invent.",
      userPrompt: multiImage ? args.goal + MULTI_IMAGE_PROMPT_NOTE : args.goal,
      images: compressed.map((c) => ({
        base64: c.base64,
        mediaType: c.mediaType,
      })),
      maxTokens: 512,
    });
    return { text: resp.text.trim(), costUsd: resp.costUsd };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "see: note synthesis failed",
    );
    return { text: "", costUsd: 0 };
  }
}

async function detectVisualState(args: {
  buf: Buffer;
  model: string;
  callVisionImpl: typeof callVision;
}): Promise<{
  visual_state: SeeResult["visual_state"];
  key_elements: SeeResult["key_elements"];
  costUsd: number;
}> {
  // Deliberately single-image (not compressForVisionMulti): this detects
  // overall load state ("loading" / "ready" / "error") and maps key elements
  // onto a 3x3 viewport grid — both assume ONE frame, which slicing would
  // break. compressForVision still enforces the 8000px hard limit.
  const compressed = await compressForVision(args.buf);
  const resp: VisionResponse = await args.callVisionImpl({
    model: args.model,
    systemPrompt: `You are a UI state analyzer. Given a screenshot, respond ONLY with valid JSON (no markdown, no explanation):
{
  "visual_state": "loading" | "ready" | "error" | "empty" | "partial",
  "key_elements": [
    { "label": "element text or purpose", "type": "button|link|input|nav|modal|form", "region": "top-left|top-center|top-right|center-left|center|center-right|bottom-left|bottom-center|bottom-right", "obscured": false }
  ]
}
Rules:
- visual_state: "ready" if page looks fully loaded and functional, "loading" if spinner/skeleton visible, "error" if error message/crash visible, "empty" if blank or no content, "partial" if some content loaded but parts missing
- key_elements: list up to 5 most important interactive elements. "obscured" = true if the element is partially hidden by a popup/overlay/banner
- region: divide the viewport into a 3x3 grid, report which cell the element center falls in`,
    userPrompt: "Analyze this page screenshot.",
    images: [{ base64: compressed.base64, mediaType: compressed.mediaType }],
    maxTokens: 512,
  });

  try {
    const raw = resp.text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(raw);
    return {
      visual_state: parsed.visual_state,
      key_elements: Array.isArray(parsed.key_elements) ? parsed.key_elements.slice(0, 5) : undefined,
      costUsd: resp.costUsd,
    };
  } catch {
    log.warn("see: could not parse visual state JSON, falling back");
    return { visual_state: undefined, key_elements: undefined, costUsd: resp.costUsd };
  }
}

const defaultOpen: OpenFn = async (cfg) => {
  const browser = await chromium.launch({ headless: cfg.headless });
  const context = await browser.newContext({
    viewport: cfg.viewport,
    locale: cfg.locale,
    timezoneId: cfg.timezone,
    userAgent: cfg.userAgent,
  });
  const page = await context.newPage();

  // Network throttling — apply persona's network_profile via CDP
  if (cfg.networkProfile) {
    const { resolveNetworkProfile } = await import("../network-profiles.js");
    const profile = resolveNetworkProfile(cfg.networkProfile);
    if (profile) {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.emulateNetworkConditions", {
        offline: profile.offline,
        downloadThroughput: profile.downloadThroughput,
        uploadThroughput: profile.uploadThroughput,
        latency: profile.latency,
      });
    }
  }

  // ADR-034 Phase 0 — attach white-box collector AFTER newPage so the
  // popup listener doesn't capture the main page itself, BEFORE goto so
  // popup / network events on the initial navigation are captured.
  const { WhiteboxCollector } = await import("../whitebox-collector.js");
  const whitebox = new WhiteboxCollector(context, page);
  whitebox.attach();
  // PR-C: attach existing PerformanceSignalCollector for Web Vitals.
  // Must attach BEFORE goto so addInitScript injects the
  // PerformanceObserver before the page's first paint — otherwise
  // LCP / FCP measurements are lost.
  const { PerformanceSignalCollector } = await import(
    "../../agent/signals/performance.js"
  );
  const performance = new PerformanceSignalCollector(page);
  await performance.attach();
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

  const waitUntil =
    cfg.waitFor === "load" ||
    cfg.waitFor === "domcontentloaded" ||
    cfg.waitFor === "networkidle"
      ? cfg.waitFor
      : "load";
  await page.goto(cfg.url, { waitUntil, timeout: cfg.timeoutMs });

  if (typeof cfg.waitFor === "object" && cfg.waitFor.type === "selector") {
    await page.waitForSelector(cfg.waitFor.selector, { timeout: cfg.timeoutMs });
  }

  return {
    page,
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

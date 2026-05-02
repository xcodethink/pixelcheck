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
 *   - 0 LLM cost when `goal` is omitted
 *   - One vision call when `goal` is provided
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
import { compressForVision } from "../image.js";
import type { ConsoleError } from "../types.js";
import { RESULT_SCHEMA_VERSION, type ResultCacheMeta } from "../result-schema.js";
import { withResultCache } from "../result-cache.js";

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
  persona_id: string;
  artifacts_dir: string;
  cost_usd: number;
  duration_ms: number;
  /** Result-cache annotation (M9-4). Absent when caching not applicable. */
  cache?: ResultCacheMeta;
}

export type OpenFn = (cfg: {
  url: string;
  viewport: { width: number; height: number };
  locale: string;
  timezone: string;
  userAgent?: string;
  headless: boolean;
  timeoutMs: number;
  waitFor: WaitFor;
}) => Promise<{
  page: Page;
  consoleErrors: ConsoleError[];
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
  fs.mkdirSync(dir, { recursive: true });
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
  fs.mkdirSync(artifactsRoot, { recursive: true });
  const runDir = makeRunDir(artifactsRoot);

  let urlFinal = opts.url;
  let title = "";
  let dom: SeeResult["dom"] = null;
  let consoleSection: SeeResult["console"] = null;
  let screenshot: SeeResult["screenshot"] = null;
  let note: string | null = null;
  let costUsd = 0;
  let status: SeeResult["status"] = "ok";
  let errorMsg: string | undefined;

  try {
    const open = opts._open ?? defaultOpen;
    const opened = await open({
      url: opts.url,
      viewport,
      locale,
      timezone,
      userAgent,
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
    persona_id: personaId,
    artifacts_dir: runDir,
    cost_usd: costUsd,
    duration_ms: durationMs,
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
    const compressed = await compressForVision(args.buf);
    const resp: VisionResponse = await args.callVisionImpl({
      model: args.model,
      systemPrompt:
        "You are a careful UI observer. Answer the user's question about the screenshot in 1-3 sentences. Cite only what you can actually see. If the question cannot be answered from the screenshot, say so plainly. Do not speculate or invent.",
      userPrompt: args.goal,
      images: [{ base64: compressed.base64, mediaType: compressed.mediaType }],
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

const defaultOpen: OpenFn = async (cfg) => {
  const browser = await chromium.launch({ headless: cfg.headless });
  const context = await browser.newContext({
    viewport: cfg.viewport,
    locale: cfg.locale,
    timezoneId: cfg.timezone,
    userAgent: cfg.userAgent,
  });
  const page = await context.newPage();
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

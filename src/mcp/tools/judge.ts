/**
 * `judge` — N-8 primitive: rubric-driven page critic.
 *
 * MCP-side wrapper for `src/core/primitives/judge.ts`. Translates the
 * incoming JSON arguments into JudgeOptions, runs the primitive, and
 * returns a stamped JSON ToolResult (M9-2 envelope).
 *
 * Rubrics: callers may pick built-in rubrics (`aesthetic`,
 * `dark_pattern`) and/or supply a `custom_criteria` array. The
 * primitive's `resolveCriteria` dedupes rubric kinds and criterion ids
 * across both sources, and rejects calls that would yield zero
 * criteria (so the tool never silently returns an empty verdict).
 *
 * Cost-guard: the single vision call is recorded into the daily ledger
 * by `callVision`. The MCP dispatcher already wraps every tool call in
 * `withCostRun` (M9-3), so two parallel `judge` invocations on this
 * server process see independent per-run counters.
 */

import * as fs from "node:fs";
import { loadPersonas, resolvePersonasDir } from "../../core/persona.js";
import {
  judge,
  type JudgeOptions,
  type ExistingCapture,
} from "../../core/primitives/judge.js";
import type { SeePersonaHints, WaitFor } from "../../core/primitives/see.js";
import {
  JudgeResultSchema,
  type JudgeRubricKind,
  type JudgeCriterionSpec,
} from "../../core/result-schema.js";
import { stampedTextResult, type ToolResult } from "../result.js";
import type { ToolDefinition } from "../registry.js";

const inputSchema = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description:
        "The URL to load and judge. Either `url` or `capture` must be provided. If both are provided, `capture` wins (judge will not re-navigate).",
    },
    capture: {
      type: "object",
      description:
        "Pre-captured page snapshot from a prior `see` / `extract` invocation. When provided, judge skips the browser entirely and runs only the vision call.",
      properties: {
        url_input: { type: "string" },
        url_final: { type: "string" },
        title: { type: "string" },
        screenshot_path: {
          type: "string",
          description: "Absolute path to the existing screenshot.png on disk.",
        },
        loaded_at: { type: "string" },
      },
      required: ["url_final", "title", "screenshot_path"],
    },
    rubrics: {
      type: "array",
      description:
        "Built-in rubrics to apply. Default: ['aesthetic']. Allowed values: 'aesthetic' (8 criteria covering visual hierarchy, typography, alignment, contrast, spacing, polish, density, brand cohesion), 'dark_pattern' (12 criteria covering forced continuity, hidden costs, pre-selected options, fake urgency, confirmshaming, obstruction, misdirection, trick questions, disguised ads, bait & switch, privacy zuckering, nagging), or 'custom' (used implicitly when custom_criteria is non-empty).",
      items: { type: "string", enum: ["aesthetic", "dark_pattern", "custom"] },
    },
    custom_criteria: {
      type: "array",
      description:
        "Caller-supplied custom criteria. Each must include `id` (snake_case), `label`, and `description`. The `kind` field is set to 'custom' automatically.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          description: { type: "string" },
        },
        required: ["id", "label", "description"],
      },
    },
    persona: {
      type: "string",
      description:
        "Optional persona id from ./personas/. Drives viewport / locale / timezone for the upstream `see` capture. If omitted, judge uses 1280x800 / en-US / UTC.",
    },
    viewport_width: { type: "number" },
    viewport_height: { type: "number" },
    full_page: { type: "boolean", description: "Full-page screenshot vs viewport-only. Default true." },
    include_dom: { type: "boolean", description: "Include DOM summary in the result. Default true." },
    include_console: { type: "boolean", description: "Include console errors. Default true." },
    timeout_ms: { type: "number", description: "Per-navigation timeout. Default 30000." },
    wait_for: {
      type: "string",
      description:
        "Page wait strategy: 'load' | 'domcontentloaded' | 'networkidle' | a CSS selector. Default 'networkidle'.",
    },
    headless: { type: "boolean", description: "Run headless. Default true." },
    model: {
      type: "string",
      description:
        "LLM model id used for the vision call. Default 'claude-sonnet-4-6'. Must be a key in the cost-guard PRICING table.",
    },
    cache: {
      type: "boolean",
      description:
        "Result cache (M9-4). Default true. Set false to bypass for one call.",
    },
    cache_bust: {
      type: "boolean",
      description:
        "Force a fresh compute, but still write the new result to the cache. Default false.",
    },
    cache_ttl_ms: {
      type: "number",
      description:
        "Per-call cache TTL override (ms). Default: AUDIT_RESULT_CACHE_TTL_MS env or 24h.",
    },
  },
};

const KNOWN_WAIT_LITERALS = new Set(["load", "domcontentloaded", "networkidle"]);

function parseWaitFor(value: unknown): WaitFor | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (KNOWN_WAIT_LITERALS.has(value)) return value as WaitFor;
  return { type: "selector", selector: value };
}

async function loadPersonaHints(id: string | undefined): Promise<SeePersonaHints | undefined> {
  if (!id) return undefined;
  const dir = resolvePersonasDir();
  if (!fs.existsSync(dir)) return { id };
  try {
    const personas = await loadPersonas(dir);
    const p = personas.get(id);
    if (!p) return { id };
    return {
      id: p.id,
      viewport: p.viewport,
      locale: p.locale,
      timezone: p.timezone,
    };
  } catch {
    return { id };
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asCapture(v: unknown): ExistingCapture | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const urlFinal = asString(o.url_final);
  const title = typeof o.title === "string" ? o.title : undefined;
  const screenshotPath = asString(o.screenshot_path);
  if (!urlFinal || title === undefined || !screenshotPath) return undefined;
  return {
    url_input: asString(o.url_input),
    url_final: urlFinal,
    title,
    screenshot_path: screenshotPath,
    loaded_at: asString(o.loaded_at),
  };
}

function asRubrics(v: unknown): JudgeRubricKind[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: JudgeRubricKind[] = [];
  for (const item of v) {
    if (item === "aesthetic" || item === "dark_pattern" || item === "custom") {
      out.push(item);
    }
  }
  return out.length > 0 ? out : undefined;
}

function asCustomCriteria(
  v: unknown,
): Array<Omit<JudgeCriterionSpec, "kind">> | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Array<Omit<JudgeCriterionSpec, "kind">> = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = asString(o.id);
    const label = asString(o.label);
    const description = asString(o.description);
    if (!id || !label || !description) continue;
    out.push({ id, label, description });
  }
  return out.length > 0 ? out : undefined;
}

async function handler(args: Record<string, unknown>): Promise<ToolResult> {
  const url = asString(args.url);
  const capture = asCapture(args.capture);
  if (!url && !capture) {
    throw new Error("judge: either `url` or `capture` is required");
  }
  if (url) {
    const { assertSafeUrl } = await import("../../core/url-guard.js");
    assertSafeUrl(url, { allowPrivate: process.env.PIXELCHECK_ALLOW_PRIVATE === "1" });
  }

  const personaId = asString(args.persona);
  const persona = await loadPersonaHints(personaId);

  const opts: JudgeOptions = {
    url,
    capture,
    rubrics: asRubrics(args.rubrics),
    customCriteria: asCustomCriteria(args.custom_criteria),
    persona,
    waitFor: parseWaitFor(args.wait_for),
    fullPage: typeof args.full_page === "boolean" ? args.full_page : undefined,
    includeDom: typeof args.include_dom === "boolean" ? args.include_dom : undefined,
    includeConsole:
      typeof args.include_console === "boolean" ? args.include_console : undefined,
    timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
    headless: typeof args.headless === "boolean" ? args.headless : undefined,
    model: asString(args.model),
    cache: typeof args.cache === "boolean" ? args.cache : undefined,
    cacheBust: typeof args.cache_bust === "boolean" ? args.cache_bust : undefined,
    cacheTtlMs: typeof args.cache_ttl_ms === "number" ? args.cache_ttl_ms : undefined,
  };

  const w = typeof args.viewport_width === "number" ? args.viewport_width : undefined;
  const h = typeof args.viewport_height === "number" ? args.viewport_height : undefined;
  if (w && h) opts.viewport = { width: w, height: h };

  const result = await judge(opts);
  return stampedTextResult("JudgeResult", JudgeResultSchema, result);
}

export const judgeTool: ToolDefinition = {
  name: "judge",
  description:
    "Single-page rubric-driven critic. Captures a URL (or accepts a pre-captured snapshot) and runs one vision call against the chosen rubric(s). Built-in rubrics: 'aesthetic' (8 criteria — visual hierarchy, typography, alignment, contrast, spacing, polish, density, brand cohesion) and 'dark_pattern' (12 criteria — forced continuity, hidden costs, pre-selected options, fake urgency, confirmshaming, obstruction, misdirection, trick questions, disguised ads, bait & switch, privacy zuckering, nagging). Caller-supplied custom criteria are also supported. Returns per-criterion verdicts (0..10 score + rationale + evidence) plus severity-graded findings with on-screen locations. 1 vision call per invocation.",
  kind: "primitive",
  resultSchema: "JudgeResult",
  cacheable: true,
  costEstimateUsd: {
    typical: 0.02,
    min: 0.01,
    max: 0.06,
    unit: "per_call",
    notes:
      "1 vision call per invocation regardless of rubric count. M9-4 result cache always engaged (key includes url|capture-bytes + rubrics + criteria + persona + model).",
  },
  sideEffects: ["navigation", "network_egress", "fs_writes_artifacts"],
  requires: { apiKeys: ["ANTHROPIC_API_KEY"], browser: true },
  inputSchema,
  handler,
};

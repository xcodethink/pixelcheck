/**
 * `compare` — N-3 primitive: A/B page comparison.
 *
 * MCP-side wrapper for `src/core/primitives/compare.ts`. Translates the
 * incoming JSON arguments into CompareOptions, runs the primitive, and
 * returns a stamped JSON ToolResult (M9-2 envelope).
 *
 * Mode: default `double_blind` (3 vision calls — 2 parallel judges then
 * 1 synthesis call; free of anchoring bias). `fast` collapses to a
 * single side-by-side call for cost-sensitive batch use.
 *
 * Cost-guard: every vision call is recorded into the daily ledger by
 * callVision. The MCP dispatcher already wraps each tool call in
 * withCostRun (M9-3), so two parallel `compare` invocations on this
 * server process see independent per-run counters.
 */

import * as fs from "node:fs";
import { loadPersonas, resolvePersonasDir } from "../../core/persona.js";
import {
  compare,
  type CompareOptions,
  type CompareSideInput,
} from "../../core/primitives/compare.js";
import type { ExistingCapture } from "../../core/primitives/judge.js";
import type { SeePersonaHints, WaitFor } from "../../core/primitives/see.js";
import {
  CompareResultSchema,
  type CompareMode,
  type JudgeCriterionSpec,
  type JudgeRubricKind,
} from "../../core/result-schema.js";
import { stampedTextResult, type ToolResult } from "../result.js";
import type { ToolDefinition } from "../registry.js";

const sideSchema = {
  type: "object",
  description:
    "One side of the A/B comparison. Either `url` or `capture` must be present. If both, `capture` wins.",
  properties: {
    url: { type: "string" },
    capture: {
      type: "object",
      description:
        "Pre-captured snapshot from a prior `see` / `extract` / `judge` call.",
      properties: {
        url_input: { type: "string" },
        url_final: { type: "string" },
        title: { type: "string" },
        screenshot_path: { type: "string" },
        loaded_at: { type: "string" },
      },
      required: ["url_final", "title", "screenshot_path"],
    },
    persona: {
      type: "string",
      description:
        "Optional persona id from ./personas/. Drives viewport / locale / timezone for THIS side's capture (judge → see).",
    },
    viewport_width: { type: "number" },
    viewport_height: { type: "number" },
  },
};

const inputSchema = {
  type: "object",
  properties: {
    a: sideSchema,
    b: sideSchema,
    mode: {
      type: "string",
      enum: ["double_blind", "fast"],
      description:
        "Strategy. `double_blind` (default) judges each side independently then synthesises a comparison — 3 vision calls, free of anchoring bias. `fast` collapses to 1 vision call seeing both screenshots — cheaper but anchored.",
    },
    rubrics: {
      type: "array",
      items: { type: "string", enum: ["aesthetic", "dark_pattern", "custom"] },
      description:
        "Built-in rubrics to apply to both sides. Default: ['aesthetic']. Same rubric semantics as the `judge` tool.",
    },
    custom_criteria: {
      type: "array",
      description:
        "Caller-supplied custom criteria applied to both sides. Each must include `id` (snake_case), `label`, `description`.",
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
    full_page: { type: "boolean" },
    include_dom: { type: "boolean" },
    include_console: { type: "boolean" },
    timeout_ms: { type: "number" },
    wait_for: {
      type: "string",
      description:
        "Page wait strategy: 'load' | 'domcontentloaded' | 'networkidle' | a CSS selector. Default 'networkidle'.",
    },
    headless: { type: "boolean" },
    model: { type: "string", description: "LLM model id used for vision calls. Default 'claude-sonnet-4-6'." },
  },
  required: ["a", "b"],
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

async function asSideInput(v: unknown, label: string): Promise<CompareSideInput> {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`compare: side ${label} must be an object`);
  }
  const o = v as Record<string, unknown>;
  const url = asString(o.url);
  const capture = asCapture(o.capture);
  if (!url && !capture) {
    throw new Error(`compare: side ${label} requires either url or capture`);
  }
  if (url) {
    const { assertSafeUrl } = await import("../../core/url-guard.js");
    assertSafeUrl(url, { allowPrivate: process.env.PIXELCHECK_ALLOW_PRIVATE === "1" });
  }
  const personaId = asString(o.persona);
  const persona = await loadPersonaHints(personaId);

  const w = typeof o.viewport_width === "number" ? o.viewport_width : undefined;
  const h = typeof o.viewport_height === "number" ? o.viewport_height : undefined;

  const side: CompareSideInput = { url, capture, persona };
  if (w && h) side.viewport = { width: w, height: h };
  return side;
}

function asMode(v: unknown): CompareMode | undefined {
  if (v === "double_blind" || v === "fast") return v;
  return undefined;
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
  if (!args.a) throw new Error("compare: `a` is required");
  if (!args.b) throw new Error("compare: `b` is required");

  const a = await asSideInput(args.a, "a");
  const b = await asSideInput(args.b, "b");

  const opts: CompareOptions = {
    a,
    b,
    mode: asMode(args.mode),
    rubrics: asRubrics(args.rubrics),
    customCriteria: asCustomCriteria(args.custom_criteria),
    waitFor: parseWaitFor(args.wait_for),
    fullPage: typeof args.full_page === "boolean" ? args.full_page : undefined,
    includeDom: typeof args.include_dom === "boolean" ? args.include_dom : undefined,
    includeConsole:
      typeof args.include_console === "boolean" ? args.include_console : undefined,
    timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
    headless: typeof args.headless === "boolean" ? args.headless : undefined,
    model: asString(args.model),
  };

  const result = await compare(opts);
  return stampedTextResult("CompareResult", CompareResultSchema, result);
}

export const compareTool: ToolDefinition = {
  name: "compare",
  description:
    "A/B page comparison primitive. Each side is `{url}` or a pre-captured `{capture}`. Default mode `double_blind` judges each side independently with the same rubric (parallel) then runs ONE synthesis vision call seeing both screenshots — 3 vision calls total, free of anchoring bias (commercial UX-review practice). `fast` mode collapses to 1 side-by-side vision call (cheaper, anchored). Built-in rubrics: 'aesthetic' (8 criteria) and 'dark_pattern' (12 criteria); custom criteria also supported. Returns per-criterion winner (a/b/tie) + rationale + per-side scores + overall winner + summary, with the embedded JudgeResult for each side in double_blind mode.",
  kind: "primitive",
  resultSchema: "CompareResult",
  cacheable: false,
  costEstimateUsd: {
    typical: 0.06,
    min: 0.01,
    max: 0.18,
    unit: "per_call",
    notes:
      "double_blind: 2 judge calls + 1 synthesis call (~3× judge cost). fast: 1 side-by-side call (~1× judge cost, anchored). Cache: compare itself is NOT cached, but each side's `judge` sub-call IS cached transparently — repeat compares with the same A & B pay only the synthesis call.",
  },
  sideEffects: ["navigation", "network_egress", "fs_writes_artifacts"],
  requires: { apiKeys: ["ANTHROPIC_API_KEY"], browser: true },
  inputSchema,
  handler,
};

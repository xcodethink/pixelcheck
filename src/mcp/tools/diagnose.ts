/**
 * `diagnose` — PR-E preset: holistic page-health diagnosis (ADR-034).
 *
 * Single-call commercial-grade audit entry-point. The MCP wrapper:
 *   1. Translates incoming JSON args into DiagnoseOptions.
 *   2. Loads persona hints if a persona id is supplied.
 *   3. Delegates to the `diagnose` primitive (which captures the page
 *      with eager visual scoring, serialises every diagnostics dimension
 *      into a vision-call prompt, parses + validates the structured
 *      output, and computes the overall health score).
 *   4. Stamps a JSON ToolResult (M9-2 envelope) for the dispatcher.
 *
 * Cost band: ~$0.02-0.04 per call (1 visual-scoring vision call inside
 * see + 1 diagnose vision call). Cacheable so repeated calls on the
 * same URL reuse the prior diagnosis until the cache TTL expires.
 *
 * Cost-guard: both vision calls go through `callVision`, which records
 * usage in the daily ledger. The MCP dispatcher already wraps every
 * tool call in `withCostRun` (M9-3), so per-run counters stay correct.
 */

import * as fs from "node:fs";
import { loadPersonas, resolvePersonasDir } from "../../core/persona.js";
import {
  diagnose,
  type DiagnoseOptions,
} from "../../core/primitives/diagnose.js";
import type { SeePersonaHints, WaitFor } from "../../core/primitives/see.js";
import {
  DiagnoseResultSchema,
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
        "The URL to diagnose. Required. The primitive captures the page (with eager visual scoring), reads every diagnostics dimension (performance / network / popups / cookies / storage / visual), and asks an LLM to produce a structured commercial-grade diagnosis.",
    },
    persona: {
      type: "string",
      description:
        "Optional persona id from ./personas/. Drives viewport / locale / timezone for the upstream capture. If omitted, diagnose uses 1280x800 / en-US / UTC.",
    },
    viewport_width: { type: "number" },
    viewport_height: { type: "number" },
    timeout_ms: {
      type: "number",
      description: "Per-navigation timeout. Default 30000.",
    },
    wait_for: {
      type: "string",
      description:
        "Page wait strategy: 'load' | 'domcontentloaded' | 'networkidle' | a CSS selector. Default 'networkidle'.",
    },
    headless: { type: "boolean", description: "Run headless. Default true." },
    model: {
      type: "string",
      description:
        "LLM model id used for the diagnosis vision call. Default 'claude-sonnet-4-6'. Must be a key in the cost-guard PRICING table.",
    },
    visual_rubrics: {
      type: "array",
      description:
        "Built-in rubrics for the upstream visualScoring='eager' call. Default ['aesthetic']. Allowed values: 'aesthetic', 'dark_pattern', 'custom'.",
      items: { type: "string", enum: ["aesthetic", "dark_pattern", "custom"] },
    },
    visual_custom_criteria: {
      type: "array",
      description:
        "Caller-supplied custom criteria forwarded to the upstream visual scoring call. Each must include id (snake_case), label, description.",
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
    visual_model: {
      type: "string",
      description:
        "Vision model id used for the upstream visual scoring call. Default: same as `model`.",
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
  required: ["url"],
};

const KNOWN_WAIT_LITERALS = new Set(["load", "domcontentloaded", "networkidle"]);

function parseWaitFor(value: unknown): WaitFor | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (KNOWN_WAIT_LITERALS.has(value)) return value as WaitFor;
  return { type: "selector", selector: value };
}

async function loadPersonaHints(
  id: string | undefined,
): Promise<SeePersonaHints | undefined> {
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
  if (!url) {
    throw new Error("diagnose: `url` is required");
  }
  const { assertSafeUrl } = await import("../../core/url-guard.js");
  assertSafeUrl(url, { allowPrivate: process.env.PIXELCHECK_ALLOW_PRIVATE === "1" });

  const personaId = asString(args.persona);
  const persona = await loadPersonaHints(personaId);

  const opts: DiagnoseOptions = {
    url,
    persona,
    waitFor: parseWaitFor(args.wait_for),
    timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
    headless: typeof args.headless === "boolean" ? args.headless : undefined,
    model: asString(args.model),
    visualRubrics: asRubrics(args.visual_rubrics),
    visualCustomCriteria: asCustomCriteria(args.visual_custom_criteria),
    visualModel: asString(args.visual_model),
    cache: typeof args.cache === "boolean" ? args.cache : undefined,
    cacheBust: typeof args.cache_bust === "boolean" ? args.cache_bust : undefined,
    cacheTtlMs:
      typeof args.cache_ttl_ms === "number" ? args.cache_ttl_ms : undefined,
  };

  const w = typeof args.viewport_width === "number" ? args.viewport_width : undefined;
  const h = typeof args.viewport_height === "number" ? args.viewport_height : undefined;
  if (w && h) opts.viewport = { width: w, height: h };

  const result = await diagnose(opts);
  return stampedTextResult("DiagnoseResult", DiagnoseResultSchema, result);
}

export const diagnoseTool: ToolDefinition = {
  name: "diagnose",
  description:
    "Holistic page-health diagnosis (ADR-034 / Phase 0 entrypoint). Captures a URL with eager visual scoring, reads every diagnostics dimension (performance / network / popups / cookies / storage / visual), and produces a commercial-grade structured report: per-finding severity + dimension + confidence + evidence_refs (cited diagnostics paths) + standards_mapping (Core Web Vitals, WCAG, OWASP, GDPR), a 0-100 overall_health_score, per-dimension drill-down scores, and a CTO-readable executive_summary. 2 vision calls per invocation (visual scoring + diagnosis).",
  kind: "preset",
  resultSchema: "DiagnoseResult",
  cacheable: true,
  costEstimateUsd: {
    typical: 0.03,
    min: 0.02,
    max: 0.08,
    unit: "per_call",
    notes:
      "2 vision calls per invocation: 1 for upstream visualScoring='eager' (~$0.005-0.02), 1 for the diagnosis itself (~$0.01-0.06). M9-4 result cache always engaged (key includes url + persona + visual rubrics + model).",
  },
  sideEffects: ["navigation", "network_egress", "fs_writes_artifacts"],
  requires: { apiKeys: ["ANTHROPIC_API_KEY"], browser: true },
  inputSchema,
  handler,
};

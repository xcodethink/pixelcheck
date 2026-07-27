/**
 * `extract` — N-4 primitive: schema-bound structured extraction.
 *
 * MCP-side wrapper for `src/core/primitives/extract.ts`. Translates the
 * incoming JSON arguments into ExtractOptions, runs the primitive, and
 * returns a stamped JSON ToolResult (M9-2 envelope).
 *
 * Schema input: AI clients hand us a JSON Schema object describing the
 * desired payload shape. The primitive's converter accepts a
 * documented subset (object/array/string/number/integer/boolean/null,
 * properties, required, items, enum, description, nullable) and rejects
 * the rest with a precise error message. See ADR-013 for the rationale
 * (no Zod over the wire; no `json-schema-to-zod` dependency; whitelist
 * over best-effort conversion).
 *
 * Persona resolution: identical to the `see` and `act` MCP wrappers.
 * If `persona` is provided AND ./personas/<id>.yaml exists, we pull
 * viewport / locale / timezone hints; otherwise we fall back to
 * extract's built-in defaults.
 *
 * Cost-guard: Stagehand-internal LLM cost is captured via metrics
 * snapshots (see primitives/extract.ts) and recorded into the
 * persistent daily ledger. The MCP dispatcher already wraps every
 * tool call in withCostRun (M9-3), so two parallel `extract` calls
 * served by this server process see independent per-run counters.
 */

import * as fs from "node:fs";
import { loadPersonas, resolvePersonasDir } from "../../core/persona.js";
import {
  extract,
  type ExtractOptions,
  type JsonSchemaSubset,
} from "../../core/primitives/extract.js";
import type { SeePersonaHints, WaitFor } from "../../core/primitives/see.js";
import { ExtractResultSchema } from "../../core/result-schema.js";
import { stampedTextResult, type ToolResult } from "../result.js";
import { requireString } from "../helpers.js";
import type { ToolDefinition } from "../registry.js";

const inputSchema = {
  type: "object",
  properties: {
    url: { type: "string", description: "The URL to load." },
    schema: {
      type: "object",
      description:
        "JSON Schema describing the desired payload shape. Subset accepted: type (object | array | string | number | integer | boolean | null), properties, required, items, enum, description, nullable. oneOf / anyOf / allOf / not / $ref / const are rejected with a precise error. Root must have type: \"object\". When omitted, Stagehand falls back to a free-form `{ extraction: string }` answer driven by `instruction`.",
      additionalProperties: true,
    },
    instruction: {
      type: "string",
      description:
        "Natural-language hint passed to Stagehand's extract LLM. Optional — when absent and a schema is provided, the primitive synthesises one from the schema's top-level field names.",
    },
    selector: {
      type: "string",
      description:
        "Constrain extraction to a CSS sub-region (e.g. `main`, `section.pricing`). Forwarded to Stagehand. Useful when a page has multiple repeated sections.",
    },
    persona: {
      type: "string",
      description:
        "Optional persona id from ./personas/. Drives viewport / locale / timezone. If omitted, extract uses 1280x800 / en-US / UTC.",
    },
    viewport_width: { type: "number", description: "Override viewport width." },
    viewport_height: { type: "number", description: "Override viewport height." },
    full_page: {
      type: "boolean",
      description: "Final-screenshot full-page vs viewport-only. Default true.",
    },
    include_dom: {
      type: "boolean",
      description: "Include final DOM summary. Default true.",
    },
    include_console: {
      type: "boolean",
      description: "Include captured console errors. Default true.",
    },
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
        "LLM model id used by Stagehand. Default 'claude-sonnet-4-6'. Must be a key in the cost-guard PRICING table.",
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

function asObjectOrUndefined(v: unknown): JsonSchemaSubset | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as JsonSchemaSubset;
  }
  return undefined;
}

async function handler(args: Record<string, unknown>): Promise<ToolResult> {
  const url = requireString(args.url, "url");
  const { assertSafeUrl } = await import("../../core/url-guard.js");
  assertSafeUrl(url, { allowPrivate: process.env.PIXELCHECK_ALLOW_PRIVATE === "1" });
  const personaId =
    typeof args.persona === "string" && args.persona.length > 0 ? args.persona : undefined;
  const persona = await loadPersonaHints(personaId);

  const schema = asObjectOrUndefined(args.schema);
  const instruction =
    typeof args.instruction === "string" && args.instruction.length > 0
      ? args.instruction
      : undefined;
  const selector =
    typeof args.selector === "string" && args.selector.length > 0
      ? args.selector
      : undefined;

  const opts: ExtractOptions = {
    url,
    schema,
    instruction,
    selector,
    persona,
    waitFor: parseWaitFor(args.wait_for),
    fullPage: typeof args.full_page === "boolean" ? args.full_page : undefined,
    includeDom: typeof args.include_dom === "boolean" ? args.include_dom : undefined,
    includeConsole:
      typeof args.include_console === "boolean" ? args.include_console : undefined,
    timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
    headless: typeof args.headless === "boolean" ? args.headless : undefined,
    model: typeof args.model === "string" && args.model.length > 0 ? args.model : undefined,
    cache: typeof args.cache === "boolean" ? args.cache : undefined,
    cacheBust: typeof args.cache_bust === "boolean" ? args.cache_bust : undefined,
    cacheTtlMs: typeof args.cache_ttl_ms === "number" ? args.cache_ttl_ms : undefined,
  };

  const w = typeof args.viewport_width === "number" ? args.viewport_width : undefined;
  const h = typeof args.viewport_height === "number" ? args.viewport_height : undefined;
  if (w && h) opts.viewport = { width: w, height: h };

  const result = await extract(opts);
  return stampedTextResult("ExtractResult", ExtractResultSchema, result);
}

export const extractTool: ToolDefinition = {
  name: "extract",
  description:
    "Schema-bound structured extraction from a URL. Caller hands us a JSON Schema describing the desired payload shape; the tool runs Stagehand's extract() under the hood and returns matching `data` plus DOM summary, console errors, and a screenshot. Single LLM call per invocation. Single engine: Stagehand. When `schema` is omitted, returns Stagehand's free-form `{ extraction: string }` driven by `instruction`.",
  kind: "primitive",
  resultSchema: "ExtractResult",
  cacheable: true,
  costEstimateUsd: {
    typical: 0.02,
    min: 0.005,
    max: 0.1,
    unit: "per_call",
    notes:
      "1 Stagehand extract call. Cost scales with schema complexity and page DOM size. M9-4 result cache always engaged (key includes url + schema + instruction).",
  },
  sideEffects: ["navigation", "network_egress", "fs_writes_artifacts"],
  requires: { apiKeys: ["ANTHROPIC_API_KEY"], browser: true },
  inputSchema,
  handler,
};

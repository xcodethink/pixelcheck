/**
 * `see` — N-1 primitive: one-shot navigation snapshot.
 *
 * MCP-side wrapper for `src/core/primitives/see.ts`. Translates the JSON
 * argument shape into `SeeOptions`, runs the primitive, and returns a
 * stamped JSON `ToolResult` (M9-2 envelope).
 *
 * Persona resolution: if `persona` is provided AND the project ships a
 * `./personas/` directory with a matching id, we extract its viewport,
 * locale, timezone hints. If anything is missing we silently fall back to
 * see's built-in defaults — `see` is intentionally safe to invoke without
 * any persona files at all.
 *
 * Cost-guard: vision calls inside `see` flow through `callVision`, which
 * is already wired to the cost ledger and the per-run AsyncLocalStorage
 * scope (M5-6 + M9-3). The MCP dispatcher wraps every tool call in
 * `withCostRun`, so this tool inherits run isolation automatically.
 */

import * as fs from "node:fs";
import { loadPersonas, resolvePersonasDir } from "../../core/persona.js";
import {
  see,
  type SeeOptions,
  type SeePersonaHints,
  type WaitFor,
} from "../../core/primitives/see.js";
import { SeeResultSchema } from "../../core/result-schema.js";
import { stampedTextResult, type ToolResult } from "../result.js";
import { requireString } from "../helpers.js";
import type { ToolDefinition } from "../registry.js";

const inputSchema = {
  type: "object",
  properties: {
    url: { type: "string", description: "The URL to load." },
    goal: {
      type: "string",
      description:
        "Optional natural-language question. When set, runs one vision call against the screenshot and returns the answer in `note`. Costs ~$0.005.",
    },
    persona: {
      type: "string",
      description:
        "Optional persona id from ./personas/. Drives viewport / locale / timezone. If omitted, see uses 1280x800 / en-US / UTC.",
    },
    wait_for: {
      type: "string",
      description:
        "Page wait strategy: 'load' | 'domcontentloaded' | 'networkidle' | a CSS selector. Default 'networkidle'.",
    },
    viewport_width: {
      type: "number",
      description: "Override viewport width (overrides persona viewport).",
    },
    viewport_height: {
      type: "number",
      description: "Override viewport height (overrides persona viewport).",
    },
    full_page: {
      type: "boolean",
      description: "Capture full-page screenshot vs viewport-only. Default true.",
    },
    include_dom: {
      type: "boolean",
      description: "Include DOM summary in the result. Default true.",
    },
    include_console: {
      type: "boolean",
      description: "Include captured console errors in the result. Default true.",
    },
    timeout_ms: {
      type: "number",
      description: "Per-navigation timeout. Default 30000.",
    },
    headless: {
      type: "boolean",
      description: "Run headless. Default true.",
    },
    cache: {
      type: "boolean",
      description:
        "Result cache (M9-4). Default true. Only applied when `goal` is set (a goal-less see has no LLM cost and risks serving a stale snapshot). Set false to bypass.",
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
  // Treat anything else as a CSS selector.
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
      network_profile: (p as Record<string, unknown>).network_profile as string | undefined,
    };
  } catch {
    return { id };
  }
}

async function handler(args: Record<string, unknown>): Promise<ToolResult> {
  const url = requireString(args.url, "url");
  const { assertSafeUrl } = await import("../../core/url-guard.js");
  assertSafeUrl(url, { allowPrivate: process.env.PIXELCHECK_ALLOW_PRIVATE === "1" });
  const goal = typeof args.goal === "string" && args.goal.length > 0 ? args.goal : undefined;
  const personaId =
    typeof args.persona === "string" && args.persona.length > 0 ? args.persona : undefined;
  const persona = await loadPersonaHints(personaId);

  const opts: SeeOptions = {
    url,
    goal,
    persona,
    waitFor: parseWaitFor(args.wait_for),
    fullPage: typeof args.full_page === "boolean" ? args.full_page : undefined,
    includeDom: typeof args.include_dom === "boolean" ? args.include_dom : undefined,
    includeConsole:
      typeof args.include_console === "boolean" ? args.include_console : undefined,
    timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
    headless: typeof args.headless === "boolean" ? args.headless : undefined,
    cache: typeof args.cache === "boolean" ? args.cache : undefined,
    cacheBust: typeof args.cache_bust === "boolean" ? args.cache_bust : undefined,
    cacheTtlMs: typeof args.cache_ttl_ms === "number" ? args.cache_ttl_ms : undefined,
  };

  const w = typeof args.viewport_width === "number" ? args.viewport_width : undefined;
  const h = typeof args.viewport_height === "number" ? args.viewport_height : undefined;
  if (w && h) opts.viewport = { width: w, height: h };

  const result = await see(opts);
  return stampedTextResult("SeeResult", SeeResultSchema, result);
}

export const seeTool: ToolDefinition = {
  name: "see",
  description:
    "Look at a URL once and return DOM summary + screenshot + console errors + an optional vision note. Lightweight primitive: 0 LLM cost when goal is omitted, ~1 vision call when set. Faster than audit_url / explore_url for one-shot inspection.",
  kind: "primitive",
  resultSchema: "SeeResult",
  cacheable: true,
  costEstimateUsd: {
    typical: 0,
    min: 0,
    max: 0.01,
    unit: "per_call",
    notes:
      "Free without `goal`. With `goal`: ~1 vision call (~$0.005 with Sonnet 4.6). M9-4 result cache is engaged only when `goal` is set.",
  },
  sideEffects: ["navigation", "network_egress", "fs_writes_artifacts"],
  requires: { apiKeys: ["ANTHROPIC_API_KEY"], browser: true },
  inputSchema,
  handler,
};

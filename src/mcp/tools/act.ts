/**
 * `act` — N-2 primitive: execute a sequence of actions on a URL.
 *
 * MCP-side wrapper for `src/core/primitives/act.ts`. Translates the
 * incoming JSON arguments into ActOptions, runs the primitive, and
 * returns a stamped JSON ToolResult (M9-2 envelope).
 *
 * Persona resolution: identical to the `see` MCP wrapper. If `persona`
 * is provided AND ./personas/<id>.yaml exists, we pull viewport / locale
 * / timezone hints; otherwise we fall back to act's built-in defaults.
 *
 * Cost-guard: vision spend (note steps and Stagehand-internal LLM calls)
 * inherits from the dispatcher's withCostRun scope. The persistent ledger
 * is shared via the file lock inside recordUsage. See ADR-008 / ADR-009.
 */

import * as fs from "node:fs";
import { loadPersonas, resolvePersonasDir } from "../../core/persona.js";
import {
  act,
  type ActOptions,
  type ActStep,
} from "../../core/primitives/act.js";
import type { SeePersonaHints, WaitFor } from "../../core/primitives/see.js";
import { ActResultSchema } from "../../core/result-schema.js";
import { stampedTextResult, type ToolResult } from "../result.js";
import { requireString } from "../helpers.js";
import type { ToolDefinition } from "../registry.js";

const stepShape = {
  type: "object",
  description:
    "A single action. type=goto/click/fill/press/wait/wait_for/scroll/screenshot are deterministic (no LLM). type=act runs natural-language Stagehand action; type=note runs one vision call to answer a question about the current screen.",
  properties: {
    type: {
      type: "string",
      enum: [
        "goto",
        "click",
        "fill",
        "press",
        "wait",
        "wait_for",
        "scroll",
        "screenshot",
        "act",
        "note",
      ],
    },
    url: { type: "string", description: "[goto] Target URL." },
    selector: {
      type: "string",
      description:
        "[click/fill/wait_for/scroll] CSS selector. [press] Optional — if absent, key is sent to the page-level keyboard.",
    },
    value: { type: "string", description: "[fill] Value to type into the input." },
    key: { type: "string", description: "[press] Key name, e.g. 'Enter' or 'Tab'." },
    ms: {
      type: "number",
      description: "[wait] Milliseconds to sleep.",
    },
    state: {
      type: "string",
      enum: ["visible", "attached", "hidden"],
      description: "[wait_for] Element state to wait for. Default 'visible'.",
    },
    delta_y: {
      type: "number",
      description: "[scroll] Pixels to scroll by (negative = up). Ignored if to_bottom=true.",
    },
    to_bottom: {
      type: "boolean",
      description: "[scroll] Scroll all the way to document.body.scrollHeight.",
    },
    label: {
      type: "string",
      description:
        "[screenshot] Filename label, slugified into <label>.png under the artefacts directory. Default 'step-<index>'.",
    },
    full_page: {
      type: "boolean",
      description: "[screenshot] Full-page vs viewport-only. Default true.",
    },
    instruction: {
      type: "string",
      description:
        "[act] Natural-language instruction passed to Stagehand's act() — e.g. 'Click the Sign Up button in the navigation'.",
    },
    goal: {
      type: "string",
      description:
        "[note] Question to answer about the current screen. Costs ~$0.005 per note step.",
    },
    timeout_ms: {
      type: "number",
      description: "[goto/click/fill/wait_for] Per-action timeout. Default 30000.",
    },
    wait_for: {
      type: "string",
      description:
        "[goto] Page wait strategy: 'load' | 'domcontentloaded' | 'networkidle' | a CSS selector (treated as wait_for_selector). Default 'networkidle'.",
    },
  },
  required: ["type"],
};

const inputSchema = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "Initial URL to load before the first step runs.",
    },
    steps: {
      type: "array",
      description: "Ordered sequence of actions.",
      items: stepShape,
    },
    persona: {
      type: "string",
      description:
        "Optional persona id from ./personas/. Drives viewport / locale / timezone. If omitted, act uses 1280x800 / en-US / UTC.",
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
      description: "Default per-action timeout. Default 30000.",
    },
    wait_for: {
      type: "string",
      description:
        "Initial-navigation wait strategy: 'load' | 'domcontentloaded' | 'networkidle' | a CSS selector. Default 'networkidle'.",
    },
    headless: { type: "boolean", description: "Run headless. Default true." },
    stop_on_error: {
      type: "boolean",
      description:
        "Stop the loop on first failed step and mark remaining steps as 'skipped'. Default true.",
    },
    engine: {
      type: "string",
      enum: ["playwright", "stagehand"],
      description:
        "Force the engine. Default: auto — 'stagehand' if any step.type='act', else 'playwright'.",
    },
  },
  required: ["url", "steps"],
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

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function coerceSteps(raw: unknown): ActStep[] {
  if (!Array.isArray(raw)) {
    throw new Error("steps must be an array");
  }
  const out: ActStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = asObject(raw[i]);
    if (!s) throw new Error(`steps[${i}] must be an object`);
    const t = s.type;
    if (typeof t !== "string") throw new Error(`steps[${i}].type must be a string`);
    out.push(coerceStep(s, i));
  }
  return out;
}

function coerceStep(s: Record<string, unknown>, i: number): ActStep {
  const t = s.type as string;
  switch (t) {
    case "goto":
      return {
        type: "goto",
        url: requireString(s.url, `steps[${i}].url`),
        wait_for: parseWaitFor(s.wait_for),
        timeout_ms: typeof s.timeout_ms === "number" ? s.timeout_ms : undefined,
      };
    case "click":
      return {
        type: "click",
        selector: requireString(s.selector, `steps[${i}].selector`),
        timeout_ms: typeof s.timeout_ms === "number" ? s.timeout_ms : undefined,
      };
    case "fill":
      return {
        type: "fill",
        selector: requireString(s.selector, `steps[${i}].selector`),
        value: requireString(s.value, `steps[${i}].value`),
        timeout_ms: typeof s.timeout_ms === "number" ? s.timeout_ms : undefined,
      };
    case "press":
      return {
        type: "press",
        key: requireString(s.key, `steps[${i}].key`),
        selector: typeof s.selector === "string" ? s.selector : undefined,
      };
    case "wait":
      if (typeof s.ms !== "number") throw new Error(`steps[${i}].ms must be a number`);
      return { type: "wait", ms: s.ms };
    case "wait_for":
      return {
        type: "wait_for",
        selector: requireString(s.selector, `steps[${i}].selector`),
        state: typeof s.state === "string" ? (s.state as "visible" | "attached" | "hidden") : undefined,
        timeout_ms: typeof s.timeout_ms === "number" ? s.timeout_ms : undefined,
      };
    case "scroll":
      return {
        type: "scroll",
        selector: typeof s.selector === "string" ? s.selector : undefined,
        delta_y: typeof s.delta_y === "number" ? s.delta_y : undefined,
        to_bottom: typeof s.to_bottom === "boolean" ? s.to_bottom : undefined,
      };
    case "screenshot":
      return {
        type: "screenshot",
        label: typeof s.label === "string" ? s.label : undefined,
        full_page: typeof s.full_page === "boolean" ? s.full_page : undefined,
      };
    case "act":
      return {
        type: "act",
        instruction: requireString(s.instruction, `steps[${i}].instruction`),
      };
    case "note":
      return {
        type: "note",
        goal: requireString(s.goal, `steps[${i}].goal`),
      };
    default:
      throw new Error(`steps[${i}].type unknown: ${t}`);
  }
}

async function handler(args: Record<string, unknown>): Promise<ToolResult> {
  const url = requireString(args.url, "url");
  const { assertSafeUrl } = await import("../../core/url-guard.js");
  const allowPrivate = process.env.PIXELCHECK_ALLOW_PRIVATE === "1";
  assertSafeUrl(url, { allowPrivate });
  const steps = coerceSteps(args.steps);
  // Validate goto step URLs too
  for (const step of steps) {
    if (step.type === "goto") assertSafeUrl(step.url, { allowPrivate });
  }
  const personaId =
    typeof args.persona === "string" && args.persona.length > 0 ? args.persona : undefined;
  const persona = await loadPersonaHints(personaId);

  const opts: ActOptions = {
    url,
    steps,
    persona,
    waitFor: parseWaitFor(args.wait_for),
    fullPage: typeof args.full_page === "boolean" ? args.full_page : undefined,
    includeDom: typeof args.include_dom === "boolean" ? args.include_dom : undefined,
    includeConsole:
      typeof args.include_console === "boolean" ? args.include_console : undefined,
    timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
    headless: typeof args.headless === "boolean" ? args.headless : undefined,
    stopOnError:
      typeof args.stop_on_error === "boolean" ? args.stop_on_error : undefined,
    engine:
      args.engine === "playwright" || args.engine === "stagehand"
        ? args.engine
        : undefined,
  };

  const w = typeof args.viewport_width === "number" ? args.viewport_width : undefined;
  const h = typeof args.viewport_height === "number" ? args.viewport_height : undefined;
  if (w && h) opts.viewport = { width: w, height: h };

  const result = await act(opts);
  return stampedTextResult("ActResult", ActResultSchema, result);
}

export const actTool: ToolDefinition = {
  name: "act",
  description:
    "Execute a sequence of actions on a URL: goto / click / fill / press / wait / wait_for / scroll / screenshot, plus AI steps `act` (Stagehand natural language) and `note` (one vision call). Returns per-step status, final DOM summary, console errors, and a final screenshot. Engine auto-selects: Stagehand only if any step.type='act'.",
  kind: "primitive",
  resultSchema: "ActResult",
  cacheable: false,
  costEstimateUsd: {
    typical: 0.01,
    min: 0,
    max: 0.05,
    unit: "per_step",
    notes:
      "Deterministic steps (goto/click/fill/press/wait/...) cost $0. AI steps: `act` ~$0.005-0.02 (Stagehand), `note` ~$0.005 (1 vision call). Total = sum across steps. NOT cached — act is state-changing.",
  },
  sideEffects: [
    "navigation",
    "state_changing",
    "network_egress",
    "fs_writes_artifacts",
  ],
  requires: { apiKeys: ["ANTHROPIC_API_KEY"], browser: true },
  inputSchema,
  handler,
};

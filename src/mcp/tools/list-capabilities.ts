/**
 * `list_capabilities` — M9-5 self-describe tool.
 *
 * Returns a richer, structured catalog than the spec-level
 * `tools/list` MCP request: every shipped tool with its kind, input
 * schema, result schema title, cacheability, static cost-estimate
 * band, side-effects, and dependency declarations; plus the public
 * env-var table and live state of the M9-4 result cache.
 *
 * Pure introspection. No LLM. No browser. No runtime probe of
 * secrets — secret env vars are NAMED but never valued. Cache file
 * path is exposed (paths are not secrets) so AI agents can write
 * diagnostic / cleanup scripts.
 *
 * Plumbing-wise the tool is a registry projection — every field on
 * the output rows is already on `ToolDefinition` (M9-5 C2). The only
 * derived data are:
 *   - cache.{enabled, ttl_ms_default, path} — pulled from the
 *     M9-4 result-cache module so the report reflects whatever the
 *     calling process is actually configured for, not a stale
 *     snapshot.
 *   - env table — hand-curated to mirror the env knobs documented in
 *     `.env.development` / README. Adding a new env var means adding
 *     one row here so `list_capabilities` stays a single source of
 *     truth for AI agents.
 *
 * Naming: top-level fields use snake_case to match the rest of the
 * MCP envelope conventions (`schema_version`, `cost_usd`, etc.). The
 * registry stores camelCase TypeScript names internally; this
 * handler does the snake_case translation.
 */

import { ListCapabilitiesResultSchema } from "../../core/result-schema.js";
import { stampedTextResult, type ToolResult } from "../result.js";
import {
  defaultDbPath as defaultResultCacheDbPath,
} from "../../core/result-cache.js";
import { RESULT_SCHEMA_VERSION } from "../../core/result-schema.js";
import { getPackageVersion } from "../../core/version.js";
import type { ToolDefinition } from "../registry.js";

// Server identity — kept in sync with src/mcp/server.ts. The version is
// read at runtime from package.json (via getPackageVersion) so a release
// bump never has to chase 4+ hardcoded copies through the codebase. The
// name stays inline because there is exactly one of those.
const SERVER_NAME = "pixelcheck";

const DEFAULT_RESULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // mirror result-cache.ts default

const inputSchema = {
  type: "object",
  properties: {},
};

/**
 * Public env-var documentation table. Rows are read-only metadata
 * — NEVER list values, only names + scope + default.
 *
 * Anthropic / OpenAI etc. live under `auth`. A row with `default: ""`
 * means there is no built-in fallback (e.g. ANTHROPIC_API_KEY must be
 * set for any LLM-using tool). Cost-guard knobs land under
 * `cost_guard` so AI agents can filter to one subsystem.
 *
 * IMPORTANT: callers may NOT use `required: true` to determine
 * whether an env var is currently set in the running process. That
 * field is a STATIC dependency declaration. Probing presence at
 * runtime would leak secret-presence — out of scope by design.
 */
function envTable(): Array<{
  name: string;
  description: string;
  scope:
    | "auth"
    | "cache"
    | "cost_guard"
    | "artifacts"
    | "logging"
    | "memory"
    | "reports";
  default: string;
  required: boolean;
}> {
  return [
    // ── auth ─────────────────────────────────────────────────────
    {
      name: "ANTHROPIC_API_KEY",
      description:
        "Anthropic API key. Required by every LLM-using tool (audit_url, explore_url, see with goal, act with `act`/`note` steps, extract, judge, compare, calibrate_critic).",
      scope: "auth",
      default: "",
      required: true,
    },
    // ── cache (M9-4) ─────────────────────────────────────────────
    {
      name: "AUDIT_RESULT_CACHE_PATH",
      description:
        "SQLite file backing the M9-4 result cache. Override to isolate cache between environments.",
      scope: "cache",
      default: "~/.pixelcheck/result-cache.db",
      required: false,
    },
    {
      name: "AUDIT_RESULT_CACHE_TTL_MS",
      description:
        "Default time-to-live for cache entries. Per-call `cache_ttl_ms` overrides this.",
      scope: "cache",
      default: String(DEFAULT_RESULT_CACHE_TTL_MS),
      required: false,
    },
    {
      name: "AUDIT_RESULT_CACHE_DISABLED",
      description:
        "Set to 1/true/yes to globally bypass the result cache (no read, no write).",
      scope: "cache",
      default: "",
      required: false,
    },
    // ── cost guard (M5-6) ────────────────────────────────────────
    {
      name: "AUDIT_COST_LEDGER_PATH",
      description:
        "Persistent JSON ledger backing the per-day USD cap. Override to isolate spend between environments.",
      scope: "cost_guard",
      default: "~/.pixelcheck/cost-ledger.json",
      required: false,
    },
    {
      name: "AUDIT_COST_MAX_RUN_USD",
      description: "Per-run USD cap enforced inside withCostRun(). Default $5.",
      scope: "cost_guard",
      default: "5",
      required: false,
    },
    {
      name: "AUDIT_COST_MAX_DAILY_USD",
      description: "Per-day (UTC) USD cap enforced via the ledger. Default $50.",
      scope: "cost_guard",
      default: "50",
      required: false,
    },
    {
      name: "AUDIT_COST_GUARD_DISABLED",
      description: "Set to 1/true/yes to globally bypass cost guard (every check no-ops).",
      scope: "cost_guard",
      default: "",
      required: false,
    },
    // ── artifacts (per-primitive) ────────────────────────────────
    {
      name: "AUDIT_SEES_DIR",
      description: "Override the artifacts root for `see` (one subdir per call).",
      scope: "artifacts",
      default: "~/.pixelcheck/sees",
      required: false,
    },
    {
      name: "AUDIT_ACTS_DIR",
      description: "Override the artifacts root for `act` (one subdir per call).",
      scope: "artifacts",
      default: "~/.pixelcheck/acts",
      required: false,
    },
    {
      name: "AUDIT_EXTRACTS_DIR",
      description:
        "Override the artifacts root for `extract` (one subdir per call, with data.json sidecar).",
      scope: "artifacts",
      default: "~/.pixelcheck/extracts",
      required: false,
    },
    {
      name: "AUDIT_JUDGES_DIR",
      description: "Override the artifacts root for `judge` (one subdir per call).",
      scope: "artifacts",
      default: "~/.pixelcheck/judges",
      required: false,
    },
    {
      name: "AUDIT_COMPARES_DIR",
      description: "Override the artifacts root for `compare` (one subdir per call).",
      scope: "artifacts",
      default: "~/.pixelcheck/compares",
      required: false,
    },
    // ── reports / history ────────────────────────────────────────
    {
      name: "AUDIT_REPORTS_DIR",
      description:
        "Override the reports root used by audit_url / explore_url. Reports DB lives under `<root>/history.db`.",
      scope: "reports",
      default: "./reports",
      required: false,
    },
    // ── memory / plan cache ──────────────────────────────────────
    {
      name: "AUDIT_MEMORY_PATH",
      description: "SQLite file backing the agent memory store. Override to isolate per env.",
      scope: "memory",
      default: "~/.pixelcheck/memory.db",
      required: false,
    },
    {
      name: "AUDIT_MEMORY_DISABLED",
      description: "Set to 1/true/yes to bypass agent memory entirely.",
      scope: "memory",
      default: "",
      required: false,
    },
    {
      name: "AUDIT_PLAN_CACHE_PATH",
      description: "SQLite file backing the planner's cache.",
      scope: "memory",
      default: "~/.pixelcheck/plan-cache.db",
      required: false,
    },
    {
      name: "AUDIT_PLAN_CACHE_DISABLED",
      description: "Set to 1/true/yes to bypass the planner's cache.",
      scope: "memory",
      default: "",
      required: false,
    },
    // ── logging (M1-3) ───────────────────────────────────────────
    {
      name: "LOG_LEVEL",
      description: "pino log level: trace | debug | info | warn | error | fatal. Default info.",
      scope: "logging",
      default: "info",
      required: false,
    },
    {
      name: "LOG_PRETTY",
      description: "Force pretty-printed logs (1) vs JSON (0). Default: TTY-aware.",
      scope: "logging",
      default: "",
      required: false,
    },
    {
      name: "LOG_FILE",
      description: "Append all log lines to this file as well as stderr.",
      scope: "logging",
      default: "",
      required: false,
    },
  ];
}

function isCacheDisabledByEnv(): boolean {
  const v = (process.env.AUDIT_RESULT_CACHE_DISABLED ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Snapshot the M9-4 cache config visible to the calling process. We
 * intentionally read process.env directly (rather than calling a
 * cache helper) so we don't pay the cost of opening the SQLite file
 * just to describe it. `path` reflects whatever the resolution order
 * (env override → home dir default) settled on.
 */
function snapshotCacheInfo(): {
  enabled: boolean;
  ttl_ms_default: number;
  path: string;
} {
  return {
    enabled: !isCacheDisabledByEnv(),
    ttl_ms_default: readEnvNumber(
      "AUDIT_RESULT_CACHE_TTL_MS",
      DEFAULT_RESULT_CACHE_TTL_MS,
    ),
    path: defaultResultCacheDbPath(),
  };
}

/**
 * Project a `ToolDefinition` (camelCase TS) to a `ToolCapability`
 * (snake_case JSON). `result_schema` is omitted when the source
 * `resultSchema` is unset so callers see the field consistently:
 * present means "you can fetch a published JSON Schema by this
 * title", absent means "freeform / undocumented body".
 */
function describeTool(def: ToolDefinition): Record<string, unknown> {
  const cap: Record<string, unknown> = {
    name: def.name,
    description: def.description,
    kind: def.kind,
    input_schema: def.inputSchema,
    cacheable: def.cacheable,
    cost_estimate_usd: {
      typical: def.costEstimateUsd.typical,
      min: def.costEstimateUsd.min,
      max: def.costEstimateUsd.max,
      unit: def.costEstimateUsd.unit,
      ...(def.costEstimateUsd.notes ? { notes: def.costEstimateUsd.notes } : {}),
    },
    side_effects: [...def.sideEffects],
    requires: {
      api_keys: [...def.requires.apiKeys],
      browser: def.requires.browser,
      ...(def.requires.personasDir !== undefined
        ? { personas_dir: def.requires.personasDir }
        : {}),
      ...(def.requires.scenariosDir !== undefined
        ? { scenarios_dir: def.requires.scenariosDir }
        : {}),
    },
  };
  if (def.resultSchema) cap.result_schema = def.resultSchema;
  return cap;
}

export function buildCapabilities(
  tools: readonly ToolDefinition[],
): Record<string, unknown> {
  return {
    server: { name: SERVER_NAME, version: getPackageVersion() },
    result_schema_version: RESULT_SCHEMA_VERSION,
    tools: tools.map(describeTool),
    env: envTable(),
    cache: snapshotCacheInfo(),
  };
}

async function handler(_args: Record<string, unknown>): Promise<ToolResult> {
  // Lazy import to avoid the circular dep of pulling server.ts back into
  // a tool registered by server.ts. The registry itself does not own
  // ALL_TOOLS — it's owned by server.ts, the canonical catalog.
  const { ALL_TOOLS } = await import("../server.js");
  const capabilities = buildCapabilities(ALL_TOOLS);
  return stampedTextResult(
    "ListCapabilitiesResult",
    ListCapabilitiesResultSchema,
    capabilities,
  );
}

export const listCapabilitiesTool: ToolDefinition = {
  name: "list_capabilities",
  description:
    "Self-describe the MCP server. Returns every shipped tool with its kind, input schema, result schema title, cacheability, static cost-estimate band, side-effects, and dependency declarations; plus the public env-var table and live state of the M9-4 result cache. Pure introspection — no LLM, no browser, no probe of secret presence. Call this first to plan which tools to use and budget for them.",
  kind: "meta",
  resultSchema: "ListCapabilitiesResult",
  cacheable: false,
  costEstimateUsd: { typical: 0, min: 0, max: 0, unit: "per_call" },
  sideEffects: ["fs_reads"],
  requires: { apiKeys: [], browser: false },
  inputSchema,
  handler,
};

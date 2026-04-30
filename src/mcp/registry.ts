/**
 * MCP tool registry (M3-6 + M9-1).
 *
 * Each tool surfaces itself as a `ToolDefinition` from `src/mcp/tools/*.ts`
 * and is registered here. The server's `ListToolsRequestSchema` handler
 * iterates the registry to derive the public catalog, and the
 * `CallToolRequestSchema` handler routes by name. Adding a new tool means
 * writing one `tools/<name>.ts` file and registering it — no per-tool
 * switch-case in `server.ts`.
 *
 * Why a registry instead of a flat array of handlers:
 *   - Single source of truth: input schema, description, kind, result
 *     schema name, and handler all live in one record per tool.
 *   - M9-5 self-describe (`list_capabilities`) just iterates the registry.
 *   - Kind discrimination (`preset` vs `primitive`) lets clients show
 *     audit_url etc. as composed presets and the new N-1~N-4 primitives
 *     as building blocks.
 *
 * The registry deliberately does NOT wrap handlers in `withCostRun` or
 * try/catch: those are transport-level concerns owned by `server.ts`,
 * not registry concerns. Keeping the registry side-effect-free makes it
 * trivial to unit-test handler routing without spinning up cost-guard
 * scopes.
 */

import type { ToolResult } from "./result.js";

/**
 * `preset`: a curated combination of primitives shipped as one tool
 *           (e.g. `audit_url` runs the full audit pipeline).
 * `primitive`: a single capability building block (`see`, `act`,
 *           `extract`, `compare` — populated by N-1~N-4).
 * `meta`: introspection / discovery (list_personas, list_scenarios,
 *         get_last_report, list_capabilities).
 */
export type ToolKind = "preset" | "primitive" | "meta";

/**
 * Side effects a handler may produce. Mirrors the Zod
 * `ToolSideEffectSchema` in `src/core/result-schema.ts`. List every
 * effect a tool's own body can cause — cross-tool effects (e.g.
 * `compare` calls `judge` which writes artifacts) are NOT propagated;
 * each row covers what its own handler does.
 */
export type ToolSideEffect =
  | "navigation"
  | "state_changing"
  | "fs_writes_artifacts"
  | "fs_writes_history"
  | "fs_reads"
  | "network_egress";

/** Static cost band for one invocation of a tool. */
export interface ToolCostEstimate {
  typical: number;
  min: number;
  max: number;
  unit: "per_call" | "per_step" | "per_persona_scenario";
  notes?: string;
}

/**
 * Static dependency declarations. INTENTIONALLY does not probe runtime
 * state (whether each env var is currently set) — that would leak
 * secret-presence to every caller. Agents who hit a missing
 * dependency get a normal error from the tool body.
 */
export interface ToolRequirements {
  /** Env var names this tool's code path will read. */
  apiKeys: string[];
  /** Whether the handler launches a Chromium instance. */
  browser: boolean;
  /** Whether the project is expected to ship a personas/ directory. */
  personasDir?: boolean;
  /** Whether the project is expected to ship a scenarios/ directory. */
  scenariosDir?: boolean;
}

export interface ToolDefinition {
  /** Tool name as exposed over MCP `tools/list`. */
  name: string;
  /** One-line human description. Shown in MCP clients. */
  description: string;
  /**
   * Raw JSON Schema for the tool's `arguments`. Must match the shape
   * MCP clients can validate locally (object with `properties`,
   * optionally `required`).
   */
  inputSchema: Record<string, unknown>;
  /** Discrimination for client UX and `list_capabilities`. */
  kind: ToolKind;
  /**
   * Optional pointer into `docs/schemas/`. When set, `list_capabilities`
   * surfaces this so AI clients can fetch the JSON Schema and validate
   * / generate against it.
   */
  resultSchema?: string;
  /**
   * Whether the M9-4 result cache will key on this tool's inputs.
   * `false` for state-changing tools (act), heavyweight presets
   * (audit_url / explore_url), and tools whose value comes from
   * sub-call hits (compare's judge sub-calls cache transparently).
   */
  cacheable: boolean;
  /** Static cost band — see `ToolCostEstimate`. */
  costEstimateUsd: ToolCostEstimate;
  /** Effects this handler can produce. */
  sideEffects: readonly ToolSideEffect[];
  /** Static dependencies — see `ToolRequirements`. */
  requires: ToolRequirements;
  /** Tool body. Receives raw MCP arguments, returns a ToolResult. */
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    if (this.tools.has(def.name)) {
      throw new Error(`tool already registered: ${def.name}`);
    }
    this.tools.set(def.name, def);
  }

  registerAll(defs: readonly ToolDefinition[]): void {
    for (const d of defs) this.register(d);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Stable insertion-ordered list. */
  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  size(): number {
    return this.tools.size;
  }

  /**
   * Build the MCP `tools/list` payload subset (drops handler, keeps the
   * fields a client needs to render and validate). `kind` is included so
   * clients aware of the primitive/preset/meta split can group accordingly;
   * unaware clients ignore it.
   */
  describe(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    kind: ToolKind;
    resultSchema?: string;
  }> {
    return this.list().map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
      kind: d.kind,
      ...(d.resultSchema ? { resultSchema: d.resultSchema } : {}),
    }));
  }
}

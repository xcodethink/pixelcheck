/**
 * Plugin hook system for PixelCheck.
 *
 * Plugins can intercept and extend audit lifecycle events. Each plugin
 * is a plain object implementing one or more hook functions. Hooks are
 * called in registration order and may be async.
 *
 * Lifecycle hooks:
 *   - beforeAudit(ctx)         — called before an audit run starts
 *   - afterAudit(ctx, result)  — called after an audit run completes
 *   - beforeStep(ctx, step)    — called before each scenario step
 *   - afterStep(ctx, step, result) — called after each step completes
 *   - onIssue(ctx, issue)      — called when an issue is detected
 *   - onError(ctx, error)      — called when an unrecoverable error occurs
 *   - transform(result)        — last chance to modify the final result
 *
 * Plugin loading:
 *   - Inline: pass plugin objects to `registerPlugin()`
 *   - File:   `pixelcheck.config.ts` exports `plugins: [...]`
 *   - Directory: `plugins/` folder with `*.plugin.ts` files
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getLogger } from "./logger.js";
import type {
  AuditRun,
  Issue,
  Scenario,
  StepResult,
} from "./types.js";

const log = getLogger("plugin");

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface PluginContext {
  /** Current audit run ID */
  runId: string;
  /** Output directory for this run */
  outputRoot: string;
  /** Current scenario (if in step-level hook) */
  scenario?: Scenario;
  /** Current persona ID (if in step-level hook) */
  personaId?: string;
}

export interface PixelCheckPlugin {
  /** Unique plugin name (for logging and dedup) */
  name: string;
  /** Semver version string */
  version?: string;

  /** Called before an audit run starts */
  beforeAudit?(ctx: PluginContext): void | Promise<void>;
  /** Called after an audit run completes */
  afterAudit?(ctx: PluginContext, result: AuditRun): void | Promise<void>;
  /** Called before each scenario step executes */
  beforeStep?(ctx: PluginContext, stepIndex: number): void | Promise<void>;
  /** Called after each scenario step completes */
  afterStep?(ctx: PluginContext, stepIndex: number, result: StepResult): void | Promise<void>;
  /** Called when an issue is detected */
  onIssue?(ctx: PluginContext, issue: Issue): void | Promise<void>;
  /** Called on unrecoverable error */
  onError?(ctx: PluginContext, error: Error): void | Promise<void>;
  /** Last-chance transform of the final audit result */
  transform?(result: AuditRun): AuditRun | Promise<AuditRun>;
}

// ─────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────

const plugins: PixelCheckPlugin[] = [];

/**
 * Register a plugin. Duplicate names are rejected.
 */
export function registerPlugin(plugin: PixelCheckPlugin): void {
  if (!plugin.name) {
    throw new Error("Plugin must have a name");
  }
  if (plugins.some((p) => p.name === plugin.name)) {
    throw new Error(`Plugin "${plugin.name}" is already registered`);
  }
  plugins.push(plugin);
  log.info({ plugin: plugin.name, version: plugin.version }, "plugin registered");
}

/**
 * Remove a plugin by name. Returns true if found and removed.
 */
export function unregisterPlugin(name: string): boolean {
  const idx = plugins.findIndex((p) => p.name === name);
  if (idx === -1) return false;
  plugins.splice(idx, 1);
  log.info({ plugin: name }, "plugin unregistered");
  return true;
}

/**
 * Get all registered plugins (read-only snapshot).
 */
export function getPlugins(): readonly PixelCheckPlugin[] {
  return [...plugins];
}

/**
 * Clear all plugins (useful for testing).
 */
export function clearPlugins(): void {
  plugins.length = 0;
}

// ─────────────────────────────────────────────────────────────
// Hook runners
// ─────────────────────────────────────────────────────────────

/**
 * Run a named hook across all plugins. Errors in individual plugins
 * are logged but do not prevent other plugins from running.
 */
async function runHook(
  hookName: keyof PixelCheckPlugin,
  args: unknown[],
): Promise<void> {
  for (const plugin of plugins) {
    const fn = plugin[hookName];
    if (typeof fn === "function") {
      try {
        await (fn as (...a: unknown[]) => unknown).apply(plugin, args);
      } catch (err) {
        log.error(
          { plugin: plugin.name, hook: hookName, err: (err as Error).message },
          "plugin hook error (non-fatal)",
        );
      }
    }
  }
}

export async function runBeforeAudit(ctx: PluginContext): Promise<void> {
  await runHook("beforeAudit", [ctx]);
}

export async function runAfterAudit(ctx: PluginContext, result: AuditRun): Promise<void> {
  await runHook("afterAudit", [ctx, result]);
}

export async function runBeforeStep(ctx: PluginContext, stepIndex: number): Promise<void> {
  await runHook("beforeStep", [ctx, stepIndex]);
}

export async function runAfterStep(ctx: PluginContext, stepIndex: number, result: StepResult): Promise<void> {
  await runHook("afterStep", [ctx, stepIndex, result]);
}

export async function runOnIssue(ctx: PluginContext, issue: Issue): Promise<void> {
  await runHook("onIssue", [ctx, issue]);
}

export async function runOnError(ctx: PluginContext, error: Error): Promise<void> {
  await runHook("onError", [ctx, error]);
}

/**
 * Run transform hooks in order. Each plugin gets the result from the
 * previous plugin (pipeline pattern).
 */
export async function runTransform(result: AuditRun): Promise<AuditRun> {
  let current = result;
  for (const plugin of plugins) {
    if (typeof plugin.transform === "function") {
      try {
        current = await plugin.transform(current);
      } catch (err) {
        log.error(
          { plugin: plugin.name, err: (err as Error).message },
          "plugin transform error (skipping this plugin's transform)",
        );
      }
    }
  }
  return current;
}

// ─────────────────────────────────────────────────────────────
// Plugin loading from directory
// ─────────────────────────────────────────────────────────────

/**
 * Load plugins from a directory. Each `.plugin.ts` or `.plugin.js` file
 * must default-export a PixelCheckPlugin object.
 */
export async function loadPluginsFromDir(dir: string): Promise<number> {
  if (!fs.existsSync(dir)) {
    log.debug({ dir }, "plugin directory does not exist, skipping");
    return 0;
  }

  const entries = fs.readdirSync(dir).filter(
    (f) => f.endsWith(".plugin.ts") || f.endsWith(".plugin.js"),
  );

  let loaded = 0;
  for (const entry of entries) {
    const fullPath = path.resolve(dir, entry);
    try {
      const mod = await import(fullPath);
      const plugin: PixelCheckPlugin = mod.default ?? mod;
      if (plugin && plugin.name) {
        registerPlugin(plugin);
        loaded++;
      } else {
        log.warn({ file: entry }, "plugin file does not export a valid plugin (needs 'name')");
      }
    } catch (err) {
      log.error({ file: entry, err: (err as Error).message }, "failed to load plugin");
    }
  }
  return loaded;
}

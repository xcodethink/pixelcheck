/**
 * Output verbosity modes for the PixelCheck CLI (M7-6).
 *
 * Three levels:
 *   - quiet   — errors only; suppresses all non-error output so only final
 *                JSON result reaches stdout.
 *   - normal  — default; info-level logging (step progress, summaries).
 *   - verbose — debug-level detail; includes LLM prompts/responses, step
 *                timing, browser events.
 *
 * Resolution order (highest wins):
 *   1. CLI flags: --quiet / -q  or  --verbose / -v
 *   2. Environment variable: PIXELCHECK_VERBOSITY=quiet|normal|verbose
 *   3. Default: normal
 *
 * This module does NOT modify logger.ts. It reads the resolved verbosity
 * and sets `process.env.LOG_LEVEL` before the first logger is instantiated,
 * so pino picks up the correct level automatically.
 */

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type VerbosityLevel = "quiet" | "normal" | "verbose";

const VALID_LEVELS = new Set<VerbosityLevel>(["quiet", "normal", "verbose"]);

/** Pino log level that corresponds to each verbosity mode. */
const LEVEL_MAP: Record<VerbosityLevel, string> = {
  quiet: "error",
  normal: "info",
  verbose: "debug",
};

// ─────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────

export interface VerbosityFlags {
  /** --quiet / -q was passed */
  quiet?: boolean;
  /** --verbose / -v was passed */
  verbose?: boolean;
}

/**
 * Resolve the effective verbosity level.
 *
 * Priority: explicit flags > PIXELCHECK_VERBOSITY env > "normal" default.
 *
 * If both --quiet and --verbose are set, --quiet wins (errors-only is the
 * safer default when the intent is ambiguous).
 */
export function resolveVerbosity(flags: VerbosityFlags = {}): VerbosityLevel {
  // 1. CLI flags (highest priority)
  if (flags.quiet) return "quiet";
  if (flags.verbose) return "verbose";

  // 2. Environment variable
  const env = process.env.PIXELCHECK_VERBOSITY?.toLowerCase() as
    | VerbosityLevel
    | undefined;
  if (env && VALID_LEVELS.has(env)) return env;

  // 3. Default
  return "normal";
}

/**
 * Map a VerbosityLevel to the corresponding pino log level string.
 */
export function verbosityToLogLevel(level: VerbosityLevel): string {
  return LEVEL_MAP[level];
}

// ─────────────────────────────────────────────────────────────
// Application
// ─────────────────────────────────────────────────────────────

/** Currently active verbosity level (set by `applyVerbosity`). */
let currentLevel: VerbosityLevel = "normal";

/**
 * Resolve verbosity from flags/env/default and configure `process.env.LOG_LEVEL`
 * so that any subsequent `getLogger()` call from logger.ts picks up the right
 * pino level.
 *
 * Call this early in CLI startup, **before** the first `getLogger()` call.
 *
 * Returns the resolved level so callers can pass `verbose: level === "verbose"`
 * to subsystems that accept a boolean verbose flag (e.g. `attachConsoleLogger`).
 */
export function applyVerbosity(flags: VerbosityFlags = {}): VerbosityLevel {
  const level = resolveVerbosity(flags);
  currentLevel = level;
  process.env.LOG_LEVEL = LEVEL_MAP[level];
  return level;
}

/**
 * Return the currently active verbosity level (set by the most recent
 * `applyVerbosity` call, or "normal" if never called).
 */
export function getVerbosity(): VerbosityLevel {
  return currentLevel;
}

/**
 * Whether the current verbosity is "quiet" — useful for conditionally
 * suppressing non-error console output (e.g. progress spinners, summary
 * banners) that bypasses the structured logger.
 */
export function isQuiet(): boolean {
  return currentLevel === "quiet";
}

/**
 * Whether the current verbosity is "verbose" — useful for enabling
 * additional debug output (LLM prompts/responses, step timing, browser
 * events) that would be too noisy in normal mode.
 */
export function isVerbose(): boolean {
  return currentLevel === "verbose";
}

// ─────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────

/** Reset the module-level state. Test-only. */
export function _resetVerbosityForTests(): void {
  currentLevel = "normal";
}

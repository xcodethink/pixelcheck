/**
 * Resolve the PixelCheck data home directory with backward-compat
 * support for the v0.x `AUDIT_HOME` env var.
 *
 * Why this module exists (E1 — closes the deprecation-cycle gap left
 * by ADR-033):
 *
 * The PixelCheck rebrand promised that v0.x users with explicit
 * `AUDIT_HOME` set would NOT break (ADR-033 §Backwards-compat). To make
 * good on that promise programmatically we:
 *
 *   1. Read `PIXELCHECK_HOME` first (the v1+ canonical env var).
 *   2. Fall back to `AUDIT_HOME` (silent compat) — but emit a one-shot
 *      deprecation warning to stderr so v0.x users see it once per
 *      process and have a chance to migrate before the v2.0 sunset.
 *   3. Otherwise default to `~/.pixelcheck/`.
 *
 * Sunset target: v2.0 — `AUDIT_HOME` removed; only `PIXELCHECK_HOME`
 * recognised. The deprecation cycle gives users at least one full
 * v1.x minor cycle to migrate (per docs/DEPRECATION-POLICY.md).
 *
 * The warning is emitted at most once per Node process to avoid
 * flooding logs in long-running MCP server sessions.
 */

import * as os from "node:os";
import * as path from "node:path";
import { getLogger } from "./logger.js";

const log = getLogger("home-dir");

const DEFAULT_DIR = ".pixelcheck";

let warned = false;

/**
 * Resolve the PixelCheck data home directory.
 *
 * Order of precedence:
 *   1. `PIXELCHECK_HOME` env var (v1+ canonical)
 *   2. `AUDIT_HOME` env var (v0.x legacy — emits a one-shot deprecation warning)
 *   3. `~/.pixelcheck/`
 */
export function pixelcheckHome(): string {
  const v1 = process.env.PIXELCHECK_HOME;
  if (v1 && v1.length > 0) return v1;

  const v0 = process.env.AUDIT_HOME;
  if (v0 && v0.length > 0) {
    if (!warned) {
      warned = true;
      log.warn(
        {
          env_var: "AUDIT_HOME",
          replacement: "PIXELCHECK_HOME",
          sunset_release: "v2.0",
          policy: "docs/DEPRECATION-POLICY.md",
        },
        "AUDIT_HOME is deprecated and will be removed in v2.0. " +
          "Migrate by setting PIXELCHECK_HOME=$AUDIT_HOME (or unsetting " +
          "AUDIT_HOME to use the default ~/.pixelcheck/).",
      );
    }
    return v0;
  }

  return path.join(os.homedir(), DEFAULT_DIR);
}

/**
 * Test seam — reset the once-per-process warning latch so unit tests
 * that exercise the deprecation path can verify it fires correctly.
 * Intentionally NOT exported via src/index.ts so it's not part of the
 * public API.
 */
export function _resetDeprecationWarningForTests(): void {
  warned = false;
}

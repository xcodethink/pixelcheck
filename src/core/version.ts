/**
 * Single source of truth for the package version.
 *
 * Reads `package.json#version` at runtime so we don't have to remember to
 * bump 4+ hardcoded strings on every release (CLI `--version`, SARIF tool
 * driver version, MCP server self-identification, MCP capabilities). v1.1.0
 * shipped with `1.0.1` strings still in source — this helper fixes that
 * recurrence pattern.
 *
 * Layout assumption: this file lives at `src/core/version.ts` (or
 * `dist/core/version.js` after build), so `package.json` is always two
 * levels up from `__dirname`. Both dev (tsx via src/) and production
 * (compiled via dist/) preserve this depth.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedVersion: string | undefined;

export function getPackageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const pkgPath = path.resolve(__dirname, "../../package.json");
    const raw = fs.readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { name?: string; version?: string };
    if (pkg.name === "pixelcheck" && typeof pkg.version === "string") {
      cachedVersion = pkg.version;
      return cachedVersion;
    }
  } catch {
    // Fall through to the "unknown" sentinel — should never happen in a
    // properly-installed package; surfaces as an obvious bug if it does.
  }
  cachedVersion = "0.0.0-unknown";
  return cachedVersion;
}

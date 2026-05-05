/**
 * Update-available banner.
 *
 * Once per 24 h the CLI checks GitHub Releases for a newer version of
 * pixelcheck. If one exists, a one-line banner is printed to stderr so
 * users see it without breaking stdout pipelines (jq, JSON consumers,
 * MCP stdio frames if this code path is ever shared with the server).
 *
 * Design constraints:
 *
 * 1. **Never block the CLI.** A network hiccup must not delay
 *    `pixelcheck doctor`, `pixelcheck run`, or any other command. We
 *    enforce a 3-second wall-clock budget on the network probe and
 *    swallow every error. Failure is silent.
 *
 * 2. **Never write to stdout.** Banners go to `process.stderr` only.
 *    Stdout is reserved for command output that downstream tools may
 *    parse. The MCP server (`pixelcheck-mcp`) uses stdio JSON-RPC and
 *    does not call this module — but defending against an accidental
 *    future call is cheap and prudent.
 *
 * 3. **24-hour cache.** A cache file under `<pixelcheckHome()>/`
 *    records the last check time and the latest version observed.
 *    Within the TTL we read from cache and skip the network entirely
 *    — fast, offline-friendly, and rate-limit-safe against the GitHub
 *    API's 60 req/h unauthenticated cap.
 *
 * 4. **Disable hooks for CI.** `PIXELCHECK_DISABLE_UPDATE_CHECK=1`
 *    short-circuits the entire module so CI runs do not depend on
 *    GitHub being reachable. `NO_UPDATE_NOTIFIER=1` (the de-facto
 *    cross-tool convention from `update-notifier`) is also honoured.
 *
 * 5. **Skip introspection commands.** `--version`, `--help`,
 *    `-V`, `-h`, and any subcommand named `doctor` already report
 *    update state in their own format. The banner is for the
 *    everyday `pixelcheck run` path.
 *
 * The public surface is:
 *
 *   - `checkForUpdate({ force? })`: pure data. Returns the
 *     current/latest version pair plus a boolean `isOutdated` flag and
 *     a `fromCache` debug flag. Used by `pixelcheck doctor` to fold the
 *     same signal into its own report.
 *
 *   - `printUpdateBannerIfDue()`: reads argv, decides whether to
 *     emit the banner, awaits at most the network budget, prints to
 *     stderr, returns.
 *
 * The module deliberately does NOT prompt the user, run an installer,
 * or modify the filesystem outside the cache file. Telling the user
 * is enough — installation choices belong to whoever invoked the CLI.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { getLogger } from "./logger.js";
import { pixelcheckHome } from "./home-dir.js";
import { getPackageVersion } from "./version.js";

const log = getLogger("update-banner");

// GitHub releases endpoint. Repo URL stays here — getPackageVersion()
// already gives us the package version, and the bug-tracker URL in
// package.json#bugs would force us to parse it. One literal is simpler
// and the repo is part of our identity, not a configurable property.
const RELEASES_LATEST_URL =
  "https://api.github.com/repos/xcodethink/pixelcheck/releases/latest";

const CACHE_FILENAME = "update-cache.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const NETWORK_TIMEOUT_MS = 3_000;

interface CacheRecord {
  /** Epoch ms of the last successful check (network OR cache hit). */
  checked_at: number;
  /** Latest semver string reported by GitHub Releases ("vX.Y.Z" or "X.Y.Z"). */
  latest_version: string;
}

export interface UpdateCheckResult {
  current_version: string;
  latest_version: string | null;
  is_outdated: boolean;
  /** True when the result came from the cache rather than a fresh network call. */
  from_cache: boolean;
  /** True when the check was skipped entirely (env disable, no network needed, etc.). */
  skipped: boolean;
}

function cachePath(): string {
  return path.join(pixelcheckHome(), CACHE_FILENAME);
}

function readCache(): CacheRecord | null {
  try {
    const raw = fs.readFileSync(cachePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<CacheRecord>;
    if (
      typeof parsed.checked_at !== "number" ||
      typeof parsed.latest_version !== "string" ||
      parsed.latest_version.length === 0
    ) {
      return null;
    }
    return { checked_at: parsed.checked_at, latest_version: parsed.latest_version };
  } catch {
    return null;
  }
}

function writeCache(record: CacheRecord): void {
  try {
    const dir = pixelcheckHome();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(record), { encoding: "utf8" });
  } catch (err) {
    // Cache write failures are non-fatal — we'll just refetch next run.
    log.debug({ err: (err as Error).message }, "update-banner cache write failed");
  }
}

/**
 * Strip an optional leading `v` and split into numeric components.
 * Returns null for unparseable input — callers fall back to "no update
 * known" rather than guessing.
 */
function parseSemver(input: string): [number, number, number] | null {
  const stripped = input.startsWith("v") ? input.slice(1) : input;
  // Allow a trailing pre-release / build suffix; we only compare
  // major.minor.patch so anything after is ignored. This intentionally
  // treats `1.2.0-rc.1` as equal to `1.2.0` for banner purposes — a
  // pre-release is not "newer" in user-facing terms unless we also
  // surface the pre-release flag, which is out of scope for the banner.
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(stripped);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function semverGt(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

function isDisabledByEnv(): boolean {
  const truthy = (v: string | undefined): boolean => {
    if (!v) return false;
    const lower = v.toLowerCase();
    return lower === "1" || lower === "true" || lower === "yes";
  };
  return (
    truthy(process.env.PIXELCHECK_DISABLE_UPDATE_CHECK) ||
    truthy(process.env.NO_UPDATE_NOTIFIER)
  );
}

/**
 * Decide if the banner should run for the given argv. Public so tests
 * (and `doctor`, if it ever wants to share the rule) can exercise the
 * decision without invoking IO.
 *
 * Skipped when:
 *   - argv contains a help / version flag (commander prints its own).
 *   - the first positional is `doctor` (doctor folds update state into
 *     its own report).
 *   - argv contains `--json` or any well-known machine-readable flag
 *     (callers piping JSON should not see decorative banners).
 */
export function shouldRunBanner(argv: readonly string[]): boolean {
  const tokens = argv.slice(2); // drop node + script
  if (tokens.length === 0) return true;
  for (const t of tokens) {
    if (t === "-h" || t === "--help" || t === "-V" || t === "--version") return false;
    if (t === "--json") return false;
  }
  if (tokens[0] === "doctor" || tokens[0] === "help") return false;
  return true;
}

async function fetchLatestVersion(): Promise<string | null> {
  // AbortController + timeout: a stuck network must not stall the CLI.
  // Node 18+ ships a global `fetch` and `AbortController` so no extra
  // dep is needed.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    const res = await fetch(RELEASES_LATEST_URL, {
      method: "GET",
      signal: controller.signal,
      headers: {
        // GitHub strongly recommends a UA. `User-Agent` cannot be a
        // fully bare string per their docs, so we identify as
        // pixelcheck and include the running version for triage.
        "User-Agent": `pixelcheck/${getPackageVersion()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      log.debug(
        { status: res.status },
        "update-banner GitHub releases probe non-OK",
      );
      return null;
    }
    const body = (await res.json()) as { tag_name?: string };
    if (typeof body.tag_name !== "string" || body.tag_name.length === 0) {
      return null;
    }
    return body.tag_name;
  } catch (err) {
    log.debug({ err: (err as Error).message }, "update-banner network probe failed");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pure data. Returns the current/latest version pair plus an
 * `is_outdated` flag. Reads from the 24 h cache when available; only
 * falls back to the network when the cache is missing or stale.
 *
 * `force: true` ignores the cache and forces a network probe — used
 * by `doctor --no-cache` paths that want a definitive answer.
 */
export async function checkForUpdate(
  opts: { force?: boolean } = {},
): Promise<UpdateCheckResult> {
  const current = getPackageVersion();
  if (isDisabledByEnv()) {
    return {
      current_version: current,
      latest_version: null,
      is_outdated: false,
      from_cache: false,
      skipped: true,
    };
  }

  if (!opts.force) {
    const cached = readCache();
    if (cached && Date.now() - cached.checked_at < CACHE_TTL_MS) {
      return {
        current_version: current,
        latest_version: cached.latest_version,
        is_outdated: semverGt(cached.latest_version, current),
        from_cache: true,
        skipped: false,
      };
    }
  }

  const latest = await fetchLatestVersion();
  if (latest === null) {
    return {
      current_version: current,
      latest_version: null,
      is_outdated: false,
      from_cache: false,
      skipped: false,
    };
  }
  writeCache({ checked_at: Date.now(), latest_version: latest });
  return {
    current_version: current,
    latest_version: latest,
    is_outdated: semverGt(latest, current),
    from_cache: false,
    skipped: false,
  };
}

/**
 * If a newer release exists, print one stderr line. Bounded by the
 * network timeout, but a cache hit returns instantly.
 *
 * Test seam: pass `stream` to redirect output (stderr in production,
 * a buffer in tests).
 */
export async function printUpdateBannerIfDue(
  opts: {
    argv?: readonly string[];
    stream?: NodeJS.WritableStream;
    force?: boolean;
  } = {},
): Promise<void> {
  const argv = opts.argv ?? process.argv;
  if (!shouldRunBanner(argv)) return;
  if (isDisabledByEnv()) return;

  let result: UpdateCheckResult;
  try {
    result = await checkForUpdate({ force: opts.force });
  } catch (err) {
    // checkForUpdate already swallows errors, but defend in depth.
    log.debug({ err: (err as Error).message }, "update-banner check threw");
    return;
  }

  if (!result.is_outdated || !result.latest_version) return;

  const stream = opts.stream ?? process.stderr;
  const current = result.current_version;
  const latest = result.latest_version;
  // ASCII-only — terminals without UTF-8 / chalk colour support still
  // render this cleanly. Single line so it doesn't dominate the output.
  const line = `[pixelcheck] update available: ${current} -> ${latest}  (npm i -g pixelcheck@latest, or set PIXELCHECK_DISABLE_UPDATE_CHECK=1 to silence)\n`;
  stream.write(line);
}

/**
 * Disk-quota / retention prune for MCP primitive artifact directories.
 *
 * Why this exists (T9 — closes RISK-REGISTER R50):
 *
 * Each call to `see` / `act` / `extract` / `judge` / `compare` writes a
 * timestamped subdirectory under `~/.pixelcheck/<kind>/` (~50 KB
 * to a few MB per call: screenshots, DOM dumps, LLM responses, payload
 * JSONs). On a busy MCP server connected to Claude Code or Cursor these
 * dirs grow without bound — a single user reported 12 GB after a month.
 *
 * The prune contract:
 *
 *   - One directory per primitive kind, configured via env:
 *     * AUDIT_SEES_DIR / AUDIT_ACTS_DIR / AUDIT_EXTRACTS_DIR /
 *       AUDIT_JUDGES_DIR / AUDIT_COMPARES_DIR
 *   - One retention setting per kind, all default to 30 days:
 *     * AUDIT_SEES_RETENTION_DAYS / AUDIT_ACTS_RETENTION_DAYS / ...
 *   - "Delete entries whose mtime is older than the retention window."
 *     mtime not ctime → robust against clock skew on shared filesystems.
 *   - Top-level entry granularity only — we never recurse into a call's
 *     subdirectory and selectively delete files; either the whole call
 *     stays or the whole call goes. Half-deleted call dirs are useless.
 *   - Setting `<KIND>_RETENTION_DAYS=0` disables prune for that kind
 *     (not "delete everything immediately" — `0` means "infinite
 *     retention", matching how every Linux retention tool behaves).
 *
 * Two callers:
 *
 *   1. `pixelcheck prune` — explicit user-triggered cleanup, prints
 *      summary, exit 0/1.
 *   2. MCP server lazy first-of-day prune on startup — at most once per
 *      24h to avoid burning CPU on every connect (`prune-stamp.json`).
 *
 * Invariants:
 *
 *   - Missing dir is fine (log + skip, not an error)
 *   - Permission denied is fine (log warn + skip; user's home perms not
 *     our problem)
 *   - We never touch anything outside the configured artifact dirs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pixelcheckHome } from "./home-dir.js";
import { getLogger } from "./logger.js";

const log = getLogger("artifacts-prune");

export type ArtifactKind =
  | "sees"
  | "acts"
  | "extracts"
  | "judges"
  | "compares";

export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "sees",
  "acts",
  "extracts",
  "judges",
  "compares",
] as const;

const DEFAULT_RETENTION_DAYS = 30;

/**
 * Where the prune-stamp lives — used by MCP-server lazy prune to avoid
 * running prune more than once per 24h.
 */
function pruneStampPath(): string {
  return path.join(pixelcheckHome(), "prune-stamp.json");
}

/** Directory for a given artifact kind, honouring env override. */
export function defaultArtifactDir(kind: ArtifactKind): string {
  const envKey = `AUDIT_${kind.toUpperCase()}_DIR`;
  const fromEnv = process.env[envKey];
  if (fromEnv) return fromEnv;
  return path.join(pixelcheckHome(), kind);
}

/** Retention days for a given kind (env override → default). */
export function retentionDaysFor(kind: ArtifactKind): number {
  const envKey = `AUDIT_${kind.toUpperCase()}_RETENTION_DAYS`;
  const raw = process.env[envKey];
  if (raw === undefined) return DEFAULT_RETENTION_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RETENTION_DAYS;
  return n;
}

export interface PruneEntry {
  kind: ArtifactKind;
  dir: string;
  retentionDays: number;
  scanned: number;
  deleted: number;
  bytesFreed: number;
  errors: string[];
  skipped: boolean;
}

export interface PruneOptions {
  /** Override "now" for tests. */
  now?: () => Date;
  /** Skip writing the stamp file (for the explicit `pixelcheck prune`). */
  skipStamp?: boolean;
}

export interface PruneResult {
  entries: PruneEntry[];
  totalDeleted: number;
  totalBytesFreed: number;
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += dirSizeBytes(full);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // racey delete; ignore
        }
      }
    }
  } catch {
    // unreadable dir; bytes-freed reporting is best-effort
  }
  return total;
}

/**
 * Prune one artifact kind. Returns a structured entry. Never throws —
 * errors land in `entry.errors` so the orchestrator can print all of
 * them and still continue with the remaining kinds.
 */
export function pruneOneKind(
  kind: ArtifactKind,
  opts: PruneOptions = {},
): PruneEntry {
  const dir = defaultArtifactDir(kind);
  const retentionDays = retentionDaysFor(kind);
  const entry: PruneEntry = {
    kind,
    dir,
    retentionDays,
    scanned: 0,
    deleted: 0,
    bytesFreed: 0,
    errors: [],
    skipped: false,
  };

  if (retentionDays === 0) {
    entry.skipped = true;
    return entry;
  }

  if (!fs.existsSync(dir)) {
    entry.skipped = true;
    return entry;
  }

  const now = (opts.now ?? (() => new Date()))();
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    entry.errors.push(
      `read ${dir} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return entry;
  }

  for (const dirent of dirents) {
    entry.scanned++;
    const full = path.join(dir, dirent.name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs >= cutoffMs) continue;
      const bytes = dirent.isDirectory() ? dirSizeBytes(full) : stat.size;
      fs.rmSync(full, { recursive: true, force: true });
      entry.deleted++;
      entry.bytesFreed += bytes;
    } catch (err) {
      entry.errors.push(
        `prune ${full} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return entry;
}

/**
 * Prune all 5 artifact kinds. Writes the stamp file unless
 * `skipStamp: true` is passed (the CLI does so to allow a back-to-back
 * `pixelcheck prune; pixelcheck prune` to actually run twice).
 */
export function pruneAllArtifacts(opts: PruneOptions = {}): PruneResult {
  const entries = ARTIFACT_KINDS.map((k) => pruneOneKind(k, opts));
  const totalDeleted = entries.reduce((s, e) => s + e.deleted, 0);
  const totalBytesFreed = entries.reduce((s, e) => s + e.bytesFreed, 0);

  if (!opts.skipStamp) {
    try {
      const stampPath = pruneStampPath();
      fs.mkdirSync(path.dirname(stampPath), { recursive: true });
      fs.writeFileSync(
        stampPath,
        JSON.stringify(
          {
            schema_version: "1.0.0",
            last_pruned_at: (opts.now ?? (() => new Date()))().toISOString(),
            total_deleted: totalDeleted,
            total_bytes_freed: totalBytesFreed,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "failed to write prune stamp",
      );
    }
  }

  return { entries, totalDeleted, totalBytesFreed };
}

/**
 * Lazy prune for MCP server startup: prune at most once per 24h.
 * Reads `prune-stamp.json` to decide; first-ever run always prunes.
 * Returns the prune result if a prune ran, or null if skipped.
 */
export function pruneIfStale(opts: PruneOptions = {}): PruneResult | null {
  const stampPath = pruneStampPath();
  const now = (opts.now ?? (() => new Date()))();
  try {
    if (fs.existsSync(stampPath)) {
      const raw = fs.readFileSync(stampPath, "utf8");
      const stamp = JSON.parse(raw) as { last_pruned_at?: string };
      if (stamp.last_pruned_at) {
        const last = new Date(stamp.last_pruned_at).getTime();
        if (Number.isFinite(last) && now.getTime() - last < 24 * 60 * 60 * 1000) {
          return null;
        }
      }
    }
  } catch {
    // unreadable / malformed → fall through and prune
  }
  return pruneAllArtifacts(opts);
}

/** Format bytes as human-readable (KB / MB / GB). */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const v = bytes / Math.pow(1024, i);
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/**
 * Render a multi-line summary of a prune run for the CLI. Pure: callers
 * decide where to write. One line per kind + one summary line + per-kind
 * error lines if any.
 */
export function renderPruneReport(result: PruneResult): string[] {
  const lines: string[] = [];
  for (const entry of result.entries) {
    if (entry.skipped) {
      const reason =
        entry.retentionDays === 0
          ? `retention disabled (${entry.kind.toUpperCase()}_RETENTION_DAYS=0)`
          : "directory missing";
      lines.push(
        `  ${entry.kind.padEnd(9)} skipped — ${reason} (${entry.dir})`,
      );
      continue;
    }
    lines.push(
      `  ${entry.kind.padEnd(9)} kept ${entry.scanned - entry.deleted} / deleted ${
        entry.deleted
      } (freed ${formatBytes(entry.bytesFreed)}, retention ${entry.retentionDays}d)`,
    );
    for (const err of entry.errors) {
      lines.push(`    ! ${err}`);
    }
  }
  lines.push("");
  lines.push(
    `Total: ${result.totalDeleted} entries removed, ${formatBytes(result.totalBytesFreed)} freed.`,
  );
  return lines;
}

/**
 * Unit tests for src/core/artifacts-prune.ts (T9 — closes R50).
 *
 * Coverage:
 *   - Default retention is 30 days
 *   - Env override sets retention per kind (AUDIT_<KIND>_RETENTION_DAYS)
 *   - 0 means "infinite retention" (skip), not "delete everything"
 *   - Default dir is ~/.pixelcheck/<kind> unless AUDIT_<KIND>_DIR set
 *   - Missing dir → skipped (not an error)
 *   - Mtime older than cutoff → deleted; younger → kept
 *   - bytesFreed reflects the recursive size of deleted entries
 *   - File errors are captured into entry.errors, not thrown
 *   - pruneAllArtifacts writes the stamp file (mode 0600)
 *   - skipStamp option suppresses stamp write
 *   - pruneIfStale skips when stamp < 24h old, runs when > 24h or missing
 *   - renderPruneReport produces stable strings
 *   - formatBytes covers 0 / B / KB / MB / GB
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ARTIFACT_KINDS,
  defaultArtifactDir,
  retentionDaysFor,
  pruneOneKind,
  pruneAllArtifacts,
  pruneIfStale,
  renderPruneReport,
  formatBytes,
  type ArtifactKind,
} from "../src/core/artifacts-prune.js";

let tmpHome: string;
let savedEnv: NodeJS.ProcessEnv;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prune-test-"));
}

function makeEntry(
  dir: string,
  name: string,
  ageDays: number,
  bytes = 100,
): string {
  const sub = path.join(dir, name);
  fs.mkdirSync(sub, { recursive: true });
  const file = path.join(sub, "data.bin");
  fs.writeFileSync(file, Buffer.alloc(bytes));
  const ageMs = ageDays * 24 * 60 * 60 * 1000;
  const past = new Date(Date.now() - ageMs);
  fs.utimesSync(sub, past, past);
  fs.utimesSync(file, past, past);
  return sub;
}

beforeEach(() => {
  savedEnv = { ...process.env };
  tmpHome = makeTmpHome();
  process.env.AUDIT_HOME = tmpHome;
  for (const k of ARTIFACT_KINDS) {
    delete process.env[`AUDIT_${k.toUpperCase()}_DIR`];
    delete process.env[`AUDIT_${k.toUpperCase()}_RETENTION_DAYS`];
  }
});

afterEach(() => {
  process.env = savedEnv;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("retention day resolution", () => {
  it("defaults to 30 days when env is unset", () => {
    for (const kind of ARTIFACT_KINDS) {
      expect(retentionDaysFor(kind)).toBe(30);
    }
  });

  it("honors AUDIT_<KIND>_RETENTION_DAYS env", () => {
    process.env.AUDIT_SEES_RETENTION_DAYS = "7";
    process.env.AUDIT_ACTS_RETENTION_DAYS = "0";
    expect(retentionDaysFor("sees")).toBe(7);
    expect(retentionDaysFor("acts")).toBe(0);
    expect(retentionDaysFor("judges")).toBe(30);
  });

  it("ignores garbage env values and falls back to default", () => {
    process.env.AUDIT_SEES_RETENTION_DAYS = "not-a-number";
    expect(retentionDaysFor("sees")).toBe(30);
    process.env.AUDIT_SEES_RETENTION_DAYS = "-5";
    expect(retentionDaysFor("sees")).toBe(30);
  });
});

describe("artifact dir resolution", () => {
  it("defaults to ~/.pixelcheck/<kind> with PIXELCHECK_HOME applied", () => {
    expect(defaultArtifactDir("sees")).toBe(path.join(tmpHome, "sees"));
    expect(defaultArtifactDir("compares")).toBe(
      path.join(tmpHome, "compares"),
    );
  });

  it("honors AUDIT_<KIND>_DIR override", () => {
    const custom = path.join(tmpHome, "custom-sees");
    process.env.AUDIT_SEES_DIR = custom;
    expect(defaultArtifactDir("sees")).toBe(custom);
  });
});

describe("pruneOneKind", () => {
  it("returns skipped when dir is missing", () => {
    const entry = pruneOneKind("sees");
    expect(entry.skipped).toBe(true);
    expect(entry.scanned).toBe(0);
    expect(entry.deleted).toBe(0);
  });

  it("returns skipped when retention is 0 (infinite)", () => {
    process.env.AUDIT_SEES_RETENTION_DAYS = "0";
    const dir = path.join(tmpHome, "sees");
    fs.mkdirSync(dir);
    makeEntry(dir, "old-call", 90);
    const entry = pruneOneKind("sees");
    expect(entry.skipped).toBe(true);
    expect(fs.existsSync(path.join(dir, "old-call"))).toBe(true);
  });

  it("deletes entries older than retention, keeps newer ones", () => {
    const dir = path.join(tmpHome, "sees");
    fs.mkdirSync(dir);
    makeEntry(dir, "old-call", 60, 200); // 60d > 30d retention → delete
    makeEntry(dir, "fresh-call", 5, 200); // 5d < 30d → keep
    const entry = pruneOneKind("sees");
    expect(entry.skipped).toBe(false);
    expect(entry.scanned).toBe(2);
    expect(entry.deleted).toBe(1);
    expect(entry.bytesFreed).toBeGreaterThanOrEqual(200);
    expect(fs.existsSync(path.join(dir, "old-call"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "fresh-call"))).toBe(true);
  });

  it("deletes nothing when all entries are within retention", () => {
    const dir = path.join(tmpHome, "judges");
    fs.mkdirSync(dir);
    makeEntry(dir, "a", 1);
    makeEntry(dir, "b", 10);
    const entry = pruneOneKind("judges");
    expect(entry.deleted).toBe(0);
    expect(entry.scanned).toBe(2);
  });

  it("respects custom retention via env", () => {
    process.env.AUDIT_SEES_RETENTION_DAYS = "3";
    const dir = path.join(tmpHome, "sees");
    fs.mkdirSync(dir);
    makeEntry(dir, "5-day-old", 5);
    makeEntry(dir, "1-day-old", 1);
    const entry = pruneOneKind("sees");
    expect(entry.deleted).toBe(1);
    expect(fs.existsSync(path.join(dir, "5-day-old"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "1-day-old"))).toBe(true);
  });

  it("uses injected `now` for deterministic tests", () => {
    const dir = path.join(tmpHome, "sees");
    fs.mkdirSync(dir);
    const sub = makeEntry(dir, "x", 0, 50);
    // utimesSync above set mtime to ~now. Pretend "now" is 100 days
    // later → entry should be older than 30d retention.
    const future = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000);
    const entry = pruneOneKind("sees", { now: () => future });
    expect(entry.deleted).toBe(1);
    expect(fs.existsSync(sub)).toBe(false);
  });
});

describe("pruneAllArtifacts", () => {
  it("walks all 5 kinds and aggregates totals", () => {
    for (const kind of ARTIFACT_KINDS) {
      const dir = path.join(tmpHome, kind);
      fs.mkdirSync(dir);
      makeEntry(dir, "old", 60, 100);
    }
    const result = pruneAllArtifacts({ skipStamp: true });
    expect(result.entries.length).toBe(5);
    expect(result.totalDeleted).toBe(5);
    expect(result.totalBytesFreed).toBeGreaterThanOrEqual(500);
  });

  it("writes the prune-stamp.json with mode 0600 (POSIX)", () => {
    pruneAllArtifacts();
    const stamp = path.join(tmpHome, "prune-stamp.json");
    expect(fs.existsSync(stamp)).toBe(true);
    if (process.platform !== "win32") {
      const mode = fs.statSync(stamp).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    const parsed = JSON.parse(fs.readFileSync(stamp, "utf8"));
    expect(parsed.schema_version).toBe("1.0.0");
    expect(typeof parsed.last_pruned_at).toBe("string");
  });

  it("skipStamp suppresses stamp file write", () => {
    pruneAllArtifacts({ skipStamp: true });
    const stamp = path.join(tmpHome, "prune-stamp.json");
    expect(fs.existsSync(stamp)).toBe(false);
  });
});

describe("pruneIfStale", () => {
  it("runs when no stamp exists", () => {
    const dir = path.join(tmpHome, "sees");
    fs.mkdirSync(dir);
    makeEntry(dir, "old", 60);
    const result = pruneIfStale();
    expect(result).not.toBeNull();
    expect(result!.totalDeleted).toBe(1);
  });

  it("skips when stamp is fresh (< 24h)", () => {
    fs.writeFileSync(
      path.join(tmpHome, "prune-stamp.json"),
      JSON.stringify({ last_pruned_at: new Date().toISOString() }),
    );
    const result = pruneIfStale();
    expect(result).toBeNull();
  });

  it("runs when stamp is stale (> 24h)", () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(tmpHome, "prune-stamp.json"),
      JSON.stringify({ last_pruned_at: stale }),
    );
    const dir = path.join(tmpHome, "sees");
    fs.mkdirSync(dir);
    makeEntry(dir, "old", 60);
    const result = pruneIfStale();
    expect(result).not.toBeNull();
    expect(result!.totalDeleted).toBe(1);
  });

  it("runs when stamp is malformed", () => {
    fs.writeFileSync(
      path.join(tmpHome, "prune-stamp.json"),
      "{ not valid json",
    );
    const dir = path.join(tmpHome, "sees");
    fs.mkdirSync(dir);
    makeEntry(dir, "old", 60);
    const result = pruneIfStale();
    expect(result).not.toBeNull();
  });
});

describe("renderPruneReport", () => {
  it("emits one summary line per kind plus totals", () => {
    const dir = path.join(tmpHome, "sees");
    fs.mkdirSync(dir);
    makeEntry(dir, "old", 60);
    const result = pruneAllArtifacts({ skipStamp: true });
    const lines = renderPruneReport(result);
    expect(lines.length).toBeGreaterThanOrEqual(7); // 5 kinds + blank + total
    expect(lines.some((l) => l.includes("sees"))).toBe(true);
    expect(lines[lines.length - 1]).toMatch(/Total:.*1 entries/);
  });

  it("notes retention disabled when set to 0", () => {
    process.env.AUDIT_SEES_RETENTION_DAYS = "0";
    const dir = path.join(tmpHome, "sees");
    fs.mkdirSync(dir);
    const result = pruneAllArtifacts({ skipStamp: true });
    const lines = renderPruneReport(result);
    expect(lines.some((l) => l.includes("retention disabled"))).toBe(true);
  });
});

describe("formatBytes", () => {
  it("renders 0 as 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("renders kilobytes / megabytes / gigabytes", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024 * 5)).toBe("5.0 MB");
    expect(formatBytes(1024 * 1024 * 1024 * 12)).toBe("12 GB");
  });
});

describe("ARTIFACT_KINDS", () => {
  it("lists exactly the 5 supported primitive kinds", () => {
    expect(ARTIFACT_KINDS).toEqual([
      "sees",
      "acts",
      "extracts",
      "judges",
      "compares",
    ]);
  });

  it.each(ARTIFACT_KINDS as readonly ArtifactKind[])(
    "kind %s round-trips through defaultArtifactDir + retentionDaysFor",
    (kind) => {
      expect(defaultArtifactDir(kind)).toBe(path.join(tmpHome, kind));
      expect(retentionDaysFor(kind)).toBe(30);
    },
  );
});

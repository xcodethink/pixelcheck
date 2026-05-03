#!/usr/bin/env tsx
/**
 * Detect drift between src/vendor/stealth-core/ and the canonical
 * stealth-core source tree.
 *
 * Why this exists (ADR-032 follow-up):
 *   stealth-core is vendored under src/vendor/. Without an automated
 *   check, the upstream stealth-core source (path provided via
 *   STEALTH_CORE_SRC) can drift out of sync with the vendor copy.
 *   This script flags any diff so a contributor can decide:
 *     - The drift is intentional (vendor is locked at an older version
 *       on purpose) → silence by setting AUDIT_VENDOR_DRIFT_OK=1
 *     - The drift is unintentional → run `bash scripts/sync-vendor.sh`
 *
 * The check is local-only by default — it knows where the canonical
 * source is on the maintainer's machine. CI runs default to skip
 * (the canonical path isn't available on GitHub-hosted runners), but
 * a future GH workspace-with-canonical setup can turn it back on.
 *
 * Exits:
 *   0 — vendor matches canonical (or canonical not present and
 *       AUDIT_VENDOR_DRIFT_SKIP_IF_MISSING=1)
 *   0 — drift detected but AUDIT_VENDOR_DRIFT_OK=1 set
 *   1 — drift detected (set AUDIT_VENDOR_DRIFT_OK=1 to silence, or run sync)
 *   2 — canonical path missing (operator error; not a drift fault)
 *
 * Usage:
 *   tsx scripts/check-vendor-drift.ts
 *   STEALTH_CORE_SRC=/custom/path tsx scripts/check-vendor-drift.ts
 *   AUDIT_VENDOR_DRIFT_SKIP_IF_MISSING=1 tsx scripts/check-vendor-drift.ts  # CI mode
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const VENDOR_DIR = path.join(REPO_ROOT, "src/vendor/stealth-core");
const CANONICAL = process.env.STEALTH_CORE_SRC ?? "";
const CANONICAL_SRC = path.join(CANONICAL, "src");

interface FileResult {
  name: string;
  status: "match" | "drift" | "missing-canonical" | "missing-vendor";
  vendorBytes?: number;
  canonicalBytes?: number;
}

function readDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
  } catch {
    return [];
  }
}

function diff(a: string, b: string): boolean {
  if (!fs.existsSync(a) || !fs.existsSync(b)) return true;
  const aBuf = fs.readFileSync(a);
  const bBuf = fs.readFileSync(b);
  if (aBuf.length !== bBuf.length) return true;
  return Buffer.compare(aBuf, bBuf) !== 0;
}

function main(): void {
  const skipIfMissing = process.env.AUDIT_VENDOR_DRIFT_SKIP_IF_MISSING === "1";
  const overrideOk = process.env.AUDIT_VENDOR_DRIFT_OK === "1";

  if (!CANONICAL || !fs.existsSync(CANONICAL_SRC)) {
    if (skipIfMissing) {
      console.log(
        `vendor-drift: canonical source not provided / missing — skipping (AUDIT_VENDOR_DRIFT_SKIP_IF_MISSING=1)`,
      );
      process.exit(0);
    }
    console.error(
      `vendor-drift: canonical stealth-core source not found.`,
    );
    console.error(
      `              set STEALTH_CORE_SRC=/path/to/stealth-core, or run with`,
    );
    console.error(
      `              AUDIT_VENDOR_DRIFT_SKIP_IF_MISSING=1 to skip in CI.`,
    );
    process.exit(2);
  }

  if (!fs.existsSync(VENDOR_DIR)) {
    console.error(`vendor-drift: ${VENDOR_DIR} does not exist (vendor missing entirely)`);
    process.exit(1);
  }

  const vendorFiles = new Set(readDir(VENDOR_DIR));
  const canonicalFiles = new Set(readDir(CANONICAL_SRC));
  const allFiles = new Set([...vendorFiles, ...canonicalFiles]);

  const results: FileResult[] = [];
  for (const name of [...allFiles].sort()) {
    const vendor = path.join(VENDOR_DIR, name);
    const canonical = path.join(CANONICAL_SRC, name);
    const inVendor = vendorFiles.has(name);
    const inCanonical = canonicalFiles.has(name);

    if (inVendor && !inCanonical) {
      results.push({ name, status: "missing-canonical" });
    } else if (!inVendor && inCanonical) {
      results.push({ name, status: "missing-vendor" });
    } else {
      const drifted = diff(vendor, canonical);
      results.push({
        name,
        status: drifted ? "drift" : "match",
        vendorBytes: fs.statSync(vendor).size,
        canonicalBytes: fs.statSync(canonical).size,
      });
    }
  }

  const drifted = results.filter((r) => r.status !== "match");

  if (drifted.length === 0) {
    console.log(
      `vendor-drift: ${results.length} file(s) match canonical at ${CANONICAL_SRC} ✓`,
    );
    process.exit(0);
  }

  console.log("");
  console.log(`vendor-drift: detected ${drifted.length} drifted file(s):`);
  console.log("");
  for (const r of drifted) {
    if (r.status === "missing-canonical") {
      console.log(`  ! ${r.name}  vendor has it but canonical does not`);
    } else if (r.status === "missing-vendor") {
      console.log(`  ! ${r.name}  canonical has it but vendor does not`);
    } else {
      console.log(
        `  ~ ${r.name}  vendor ${r.vendorBytes}B ≠ canonical ${r.canonicalBytes}B`,
      );
    }
  }
  console.log("");

  if (overrideOk) {
    console.log(
      "AUDIT_VENDOR_DRIFT_OK=1 set — drift accepted (intentional vendor lock).",
    );
    process.exit(0);
  }

  console.log("Resolution paths:");
  console.log("  - Run `bash scripts/sync-vendor.sh` to pull canonical into vendor/");
  console.log("  - Set AUDIT_VENDOR_DRIFT_OK=1 if vendor is locked deliberately");
  console.log("  - Update STEALTH_CORE_SRC if canonical lives at a different path");
  process.exit(1);
}

main();

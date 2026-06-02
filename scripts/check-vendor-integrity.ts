#!/usr/bin/env tsx
/**
 * Verify the integrity of the vendored stealth-core copy against a
 * committed SHA-256 manifest (src/vendor/stealth-core/integrity.json).
 *
 * Why this exists (F4 follow-up to ADR-032):
 *   `scripts/check-vendor-drift.ts` diffs the vendor copy against the
 *   canonical upstream tree — but that tree is NOT present on
 *   GitHub-hosted runners, so the CI drift step is a no-op there
 *   (AUDIT_VENDOR_DRIFT_SKIP_IF_MISSING=1). That left CI with no
 *   enforceable gate over the vendored bytes at all.
 *
 *   This check needs NO canonical source. It recomputes the SHA-256 of
 *   every vendored .ts file and compares against the committed manifest.
 *   It runs everywhere (CI included) and catches:
 *     - accidental in-place edits to a vendored file (drift WITHIN this
 *       repo, which the canonical-diff check can't see on runners)
 *     - a tampered / corrupted vendor copy
 *     - a file added to or removed from the vendor dir without updating
 *       the manifest (so the manifest stays an honest inventory)
 *
 *   When a vendor refresh is intentional (after `scripts/sync-vendor.sh`),
 *   regenerate the manifest with `--write` and commit it alongside the
 *   vendor change. The manifest diff then documents exactly what bytes
 *   changed, which is the provenance record F4 asked for.
 *
 * Exits:
 *   0 — every vendored file matches the manifest (or --write succeeded)
 *   1 — mismatch: drift, missing/extra file, or corrupt manifest
 *
 * Usage:
 *   tsx scripts/check-vendor-integrity.ts            # verify (CI mode)
 *   tsx scripts/check-vendor-integrity.ts --write     # regenerate manifest
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const VENDOR_DIR = path.join(REPO_ROOT, "src/vendor/stealth-core");
const MANIFEST_PATH = path.join(VENDOR_DIR, "integrity.json");

export interface VendorManifest {
  library: string;
  vendored_from: string;
  vendored_at: string;
  adr: string;
  license: string;
  algorithm: "sha256";
  files: Record<string, string>;
}

export interface IntegrityResult {
  ok: boolean;
  /** Human-readable lines describing each problem (empty when ok). */
  problems: string[];
  /** Freshly-computed digests, keyed by file basename. */
  computed: Record<string, string>;
}

function listVendorFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .sort();
}

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Pure verification core — no process exit, no console. Returns a result
 * the CLI and the regression test can both consume.
 */
export function verifyVendorIntegrity(
  manifest: VendorManifest,
  vendorDir: string = VENDOR_DIR,
): IntegrityResult {
  const problems: string[] = [];
  const computed: Record<string, string> = {};

  if (manifest.algorithm !== "sha256") {
    problems.push(`manifest algorithm "${manifest.algorithm}" is not sha256`);
    return { ok: false, problems, computed };
  }

  const onDisk = new Set(listVendorFiles(vendorDir));
  const inManifest = new Set(Object.keys(manifest.files));

  for (const name of onDisk) {
    computed[name] = sha256(path.join(vendorDir, name));
    if (!inManifest.has(name)) {
      problems.push(`${name} exists on disk but is NOT in the manifest`);
    }
  }
  for (const name of inManifest) {
    if (!onDisk.has(name)) {
      problems.push(`${name} is in the manifest but MISSING from disk`);
      continue;
    }
    if (computed[name] !== manifest.files[name]) {
      problems.push(
        `${name} hash mismatch: expected ${manifest.files[name].slice(0, 12)}…, got ${computed[name].slice(0, 12)}…`,
      );
    }
  }

  return { ok: problems.length === 0, problems, computed };
}

function main(): void {
  const write = process.argv.includes("--write");

  if (!fs.existsSync(VENDOR_DIR)) {
    console.error(`vendor-integrity: ${VENDOR_DIR} does not exist`);
    process.exit(1);
  }

  if (write) {
    const existing: Partial<VendorManifest> = fs.existsSync(MANIFEST_PATH)
      ? (JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as VendorManifest)
      : {};
    const files: Record<string, string> = {};
    for (const name of listVendorFiles(VENDOR_DIR)) {
      files[name] = sha256(path.join(VENDOR_DIR, name));
    }
    const manifest: VendorManifest = {
      library: existing.library ?? "stealth-core",
      vendored_from:
        existing.vendored_from ?? "@xcodethink/stealth-core (private, first-party)",
      vendored_at: existing.vendored_at ?? "unknown",
      adr: existing.adr ?? "ADR-032",
      license: existing.license ?? "MIT",
      algorithm: "sha256",
      files,
    };
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
    console.log(
      `vendor-integrity: wrote manifest for ${Object.keys(files).length} file(s) → ${path.relative(REPO_ROOT, MANIFEST_PATH)}`,
    );
    process.exit(0);
  }

  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(
      `vendor-integrity: manifest missing at ${path.relative(REPO_ROOT, MANIFEST_PATH)} — run with --write to create it`,
    );
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as VendorManifest;
  const result = verifyVendorIntegrity(manifest, VENDOR_DIR);

  if (result.ok) {
    console.log(
      `vendor-integrity: ${Object.keys(manifest.files).length} file(s) match the committed sha256 manifest ✓`,
    );
    process.exit(0);
  }

  console.error("");
  console.error(`vendor-integrity: ${result.problems.length} problem(s) detected:`);
  for (const p of result.problems) console.error(`  - ${p}`);
  console.error("");
  console.error("If this vendor change is intentional (after scripts/sync-vendor.sh),");
  console.error("regenerate the manifest with: npm run check:vendor-integrity -- --write");
  console.error("then commit src/vendor/stealth-core/integrity.json alongside the change.");
  process.exit(1);
}

// Only run the CLI when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

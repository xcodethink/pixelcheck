import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifyVendorIntegrity,
  type VendorManifest,
} from "../scripts/check-vendor-integrity.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const VENDOR_DIR = path.join(REPO_ROOT, "src/vendor/stealth-core");
const MANIFEST_PATH = path.join(VENDOR_DIR, "integrity.json");

function loadManifest(): VendorManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as VendorManifest;
}

describe("vendor-integrity (F4)", () => {
  it("the committed manifest matches the real vendored files on disk", () => {
    const result = verifyVendorIntegrity(loadManifest(), VENDOR_DIR);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("the manifest covers every vendored .ts file (no silent gaps)", () => {
    const manifest = loadManifest();
    const onDisk = fs
      .readdirSync(VENDOR_DIR)
      .filter((f) => f.endsWith(".ts"))
      .sort();
    expect(Object.keys(manifest.files).sort()).toEqual(onDisk);
    expect(onDisk.length).toBeGreaterThanOrEqual(6);
  });

  it("pins provenance metadata (source, license, date, ADR)", () => {
    const m = loadManifest();
    expect(m.algorithm).toBe("sha256");
    expect(m.license).toBe("MIT");
    expect(m.adr).toMatch(/ADR-032/);
    expect(m.vendored_from).toMatch(/stealth-core/);
    expect(m.vendored_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  describe("tamper detection (against a throwaway copy)", () => {
    function makeTmpVendor(): { dir: string; manifest: VendorManifest; cleanup: () => void } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-integrity-"));
      const files: Record<string, string> = {};
      const manifest = loadManifest();
      for (const name of Object.keys(manifest.files)) {
        fs.copyFileSync(path.join(VENDOR_DIR, name), path.join(dir, name));
        files[name] = manifest.files[name];
      }
      return {
        dir,
        manifest: { ...manifest, files },
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
      };
    }

    it("flags an edited vendored file (hash mismatch)", () => {
      const { dir, manifest, cleanup } = makeTmpVendor();
      try {
        const victim = Object.keys(manifest.files)[0];
        fs.appendFileSync(path.join(dir, victim), "\n// injected drift\n");
        const result = verifyVendorIntegrity(manifest, dir);
        expect(result.ok).toBe(false);
        expect(result.problems.some((p) => p.includes(victim) && p.includes("hash mismatch"))).toBe(
          true,
        );
      } finally {
        cleanup();
      }
    });

    it("flags an extra file not present in the manifest", () => {
      const { dir, manifest, cleanup } = makeTmpVendor();
      try {
        fs.writeFileSync(path.join(dir, "rogue.ts"), "export const x = 1;\n");
        const result = verifyVendorIntegrity(manifest, dir);
        expect(result.ok).toBe(false);
        expect(result.problems.some((p) => p.includes("rogue.ts") && p.includes("NOT in the manifest"))).toBe(
          true,
        );
      } finally {
        cleanup();
      }
    });

    it("flags a manifest entry whose file was removed from disk", () => {
      const { dir, manifest, cleanup } = makeTmpVendor();
      try {
        const victim = Object.keys(manifest.files)[0];
        fs.rmSync(path.join(dir, victim));
        const result = verifyVendorIntegrity(manifest, dir);
        expect(result.ok).toBe(false);
        expect(result.problems.some((p) => p.includes(victim) && p.includes("MISSING from disk"))).toBe(
          true,
        );
      } finally {
        cleanup();
      }
    });

    it("rejects a non-sha256 manifest", () => {
      const { dir, manifest, cleanup } = makeTmpVendor();
      try {
        const result = verifyVendorIntegrity(
          { ...manifest, algorithm: "md5" as unknown as "sha256" },
          dir,
        );
        expect(result.ok).toBe(false);
        expect(result.problems[0]).toMatch(/not sha256/);
      } finally {
        cleanup();
      }
    });
  });
});

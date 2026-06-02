import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readPkg(): { engines?: { node?: string; npm?: string } } {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
}

/** Lowest major version a `>=X.Y.Z` / `^X` style range admits. */
function minMajor(range: string): number {
  const m = range.match(/(\d+)/);
  if (!m) throw new Error(`cannot parse version range: ${range}`);
  return Number(m[1]);
}

/** Pull the `node: [20, 22]` matrix list out of ci.yml. */
function ciNodeMatrix(): number[] {
  const yml = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
  const m = yml.match(/node:\s*\[([^\]]+)\]/);
  if (!m) throw new Error("could not find `node: [...]` matrix in ci.yml");
  return m[1]
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n));
}

describe("package engines accuracy (F6)", () => {
  it("declares Node >= 20 (the toolchain needs 20+; >=18 was a false claim)", () => {
    const node = readPkg().engines?.node;
    expect(node).toBeDefined();
    expect(minMajor(node!)).toBeGreaterThanOrEqual(20);
  });

  it("declares npm >= 9 (bundled with Node 20)", () => {
    const npm = readPkg().engines?.npm;
    expect(npm).toBeDefined();
    expect(minMajor(npm!)).toBeGreaterThanOrEqual(9);
  });

  it("every CI matrix Node version meets the declared engines floor", () => {
    const floor = minMajor(readPkg().engines!.node!);
    const matrix = ciNodeMatrix();
    expect(matrix.length).toBeGreaterThan(0);
    for (const n of matrix) {
      expect(n).toBeGreaterThanOrEqual(floor);
    }
  });

  it("CI actually tests the declared minimum supported Node major", () => {
    // Guards the inverse drift: claiming support for a version no CI run
    // exercises (the original >=18 bug — nothing tested 18).
    const floor = minMajor(readPkg().engines!.node!);
    expect(ciNodeMatrix()).toContain(floor);
  });
});

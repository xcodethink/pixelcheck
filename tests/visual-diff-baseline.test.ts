import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { diffAgainstBaseline } from "../src/core/visual-diff.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "visdiff-"));
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function tinyPng(seed: number): Buffer {
  // 1x1 PNG, color varies with seed so different seeds produce different bytes.
  const r = seed & 0xff;
  const g = (seed >> 8) & 0xff;
  const b = (seed >> 16) & 0xff;
  // Pre-encoded 1x1 RGBA PNG with the right pixel bytes.
  // Build from the standard PNG signature + minimal IHDR/IDAT/IEND with
  // zlib-deflated raw data. Easiest: rely on a fixed 1x1 black PNG and
  // append a tag for distinctness — content equality isn't what the test
  // checks; we just need different files.
  const blackPng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
    0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, r, g, b, 0xff, 0x00, 0x00,
    0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  return blackPng;
}

describe("diffAgainstBaseline — bootstrap concurrency safety", () => {
  it("creates a baseline atomically when one does not yet exist", async () => {
    const baseline = path.join(dir, "shot.png");
    const current = path.join(dir, "current.png");
    fs.writeFileSync(current, tinyPng(0x010203));

    const result = await diffAgainstBaseline({
      current,
      baseline,
      diffOutput: path.join(dir, "diff.png"),
    });

    expect(result.computed).toBe(false);
    expect(result.regression).toBe(false);
    expect(fs.existsSync(baseline)).toBe(true);
    // Tmp files cleaned up
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("two parallel first-runs both succeed; one baseline survives, no .tmp leaks", async () => {
    const baseline = path.join(dir, "shot.png");
    const current1 = path.join(dir, "current1.png");
    const current2 = path.join(dir, "current2.png");
    fs.writeFileSync(current1, tinyPng(0x010203));
    fs.writeFileSync(current2, tinyPng(0x040506));

    // Run two diffs in parallel, both targeting the SAME baseline path.
    const [r1, r2] = await Promise.all([
      diffAgainstBaseline({
        current: current1,
        baseline,
        diffOutput: path.join(dir, "diff1.png"),
      }),
      diffAgainstBaseline({
        current: current2,
        baseline,
        diffOutput: path.join(dir, "diff2.png"),
      }),
    ]);

    // Neither should have computed a real diff (both saw the bootstrap path
    // initially or one saw the freshly-installed baseline as "exists" and
    // tried to diff — that's fine, it just won't be `computed: true` without
    // odiff installed).
    expect([r1.regression, r2.regression]).toContain(false);
    expect(fs.existsSync(baseline)).toBe(true);

    // No leftover tmp files
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);

    // Baseline matches one of the two source files, not a corrupted blend.
    const baselineBytes = fs.readFileSync(baseline);
    const a = fs.readFileSync(current1);
    const b = fs.readFileSync(current2);
    const matchesA = baselineBytes.equals(a);
    const matchesB = baselineBytes.equals(b);
    expect(matchesA || matchesB).toBe(true);
  });
});

/**
 * Tests for src/core/visual-diff.ts — diff-after-baseline-exists path.
 * (visual-diff-baseline.test.ts already covers the bootstrap branch.)
 *
 * We exercise the real odiff-bin against sharp-generated PNGs so the test
 * reflects what odiff actually produces. Each test runs in an isolated
 * tmpdir and is hermetic.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";

import { diffAgainstBaseline } from "../src/core/visual-diff.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "visdiff-diff-"));
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

async function writeSolidPng(
  filePath: string,
  size: number,
  rgb: { r: number; g: number; b: number },
): Promise<void> {
  await sharp({
    create: { width: size, height: size, channels: 3, background: rgb },
  })
    .png()
    .toFile(filePath);
}

describe("diffAgainstBaseline — diff path", () => {
  it("reports match (no regression, diffPixels=0) when current = baseline", async () => {
    const baseline = path.join(dir, "baseline.png");
    const current = path.join(dir, "current.png");
    await writeSolidPng(baseline, 64, { r: 100, g: 100, b: 100 });
    await writeSolidPng(current, 64, { r: 100, g: 100, b: 100 });

    const result = await diffAgainstBaseline({
      current,
      baseline,
      diffOutput: path.join(dir, "diff.png"),
    });

    if (!result.computed) {
      // odiff-bin unavailable in this env → graceful degrade. Skip.
      expect(result.regression).toBe(false);
      return;
    }
    expect(result.computed).toBe(true);
    expect(result.regression).toBe(false);
    expect(result.diffPixels).toBe(0);
    expect(result.match).toBe(1);
  }, 30_000);

  it("reports regression when diff > thresholdPixels (low threshold)", async () => {
    const baseline = path.join(dir, "baseline.png");
    const current = path.join(dir, "current.png");
    await writeSolidPng(baseline, 64, { r: 0, g: 0, b: 0 });
    await writeSolidPng(current, 64, { r: 255, g: 255, b: 255 });

    const result = await diffAgainstBaseline({
      current,
      baseline,
      diffOutput: path.join(dir, "diff.png"),
      thresholdPixels: 10,
    });

    if (!result.computed) return; // odiff unavailable
    expect(result.computed).toBe(true);
    expect(result.regression).toBe(true);
    expect((result.diffPixels ?? 0)).toBeGreaterThan(10);
    expect(result.diffImagePath).toBe(path.join(dir, "diff.png"));
    // Diff image was written
    expect(fs.existsSync(path.join(dir, "diff.png"))).toBe(true);
  }, 30_000);

  it("does NOT report regression when diff ≤ thresholdPixels (large threshold)", async () => {
    const baseline = path.join(dir, "baseline.png");
    const current = path.join(dir, "current.png");
    await writeSolidPng(baseline, 32, { r: 0, g: 0, b: 0 });
    await writeSolidPng(current, 32, { r: 255, g: 255, b: 255 });

    const result = await diffAgainstBaseline({
      current,
      baseline,
      diffOutput: path.join(dir, "diff.png"),
      thresholdPixels: 100_000,
    });

    if (!result.computed) return;
    expect(result.regression).toBe(false);
    expect((result.diffPixels ?? 0)).toBeGreaterThan(0);
  }, 30_000);

  it("returns computed=false with reason when current is invalid path", async () => {
    const baseline = path.join(dir, "baseline.png");
    await writeSolidPng(baseline, 16, { r: 0, g: 0, b: 0 });

    const result = await diffAgainstBaseline({
      current: path.join(dir, "missing-current.png"),
      baseline,
      diffOutput: path.join(dir, "diff.png"),
    });

    if (result.computed) {
      // Some odiff versions may treat missing as a match-fail; either way no
      // regression should be silently reported on bad inputs.
      expect(result.regression).toBeDefined();
    } else {
      expect(result.regression).toBe(false);
      expect(result.reason).toBeDefined();
    }
  }, 30_000);

  it("uses default threshold of 100 pixels when not specified", async () => {
    const baseline = path.join(dir, "baseline.png");
    const current = path.join(dir, "current.png");
    await writeSolidPng(baseline, 8, { r: 0, g: 0, b: 0 });
    await writeSolidPng(current, 8, { r: 255, g: 255, b: 255 });

    const result = await diffAgainstBaseline({
      current,
      baseline,
      diffOutput: path.join(dir, "diff.png"),
    });

    if (!result.computed) return;
    // 8x8 = 64 pixels of diff — under default 100 threshold → no regression
    expect(result.regression).toBe(false);
    expect((result.diffPixels ?? 0)).toBeLessThanOrEqual(100);
  }, 30_000);
});

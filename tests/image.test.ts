/**
 * Tests for src/core/image.ts — vision-API-bound image compression.
 * Uses real `sharp` (it's a non-optional dep) so tests reflect actual behavior.
 * Generates real PNG / JPEG buffers so detectMediaType is exercised.
 */

import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";
import sharp from "sharp";
import { compressForVision, compressForVisionMulti } from "../src/core/image.js";

async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 100, b: 50 },
    },
  })
    .png()
    .toBuffer();
}

async function makeJpeg(width: number, height: number, quality = 80): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 100, b: 50 },
    },
  })
    .jpeg({ quality })
    .toBuffer();
}

describe("compressForVision — small inputs", () => {
  it("returns small PNG inputs untouched (under threshold), labeled image/png", async () => {
    const small = await makePng(100, 100);
    expect(small.length).toBeLessThan(2_500_000);
    const out = await compressForVision(small);
    expect(out.bytes).toBe(small.length);
    expect(out.mediaType).toBe("image/png");
    expect(out.base64).toBe(small.toString("base64"));
    // No resize for the bypass path
    expect(out.width).toBeUndefined();
    expect(out.height).toBeUndefined();
  });

  it("returns small JPEG inputs labeled image/jpeg via magic-byte detection", async () => {
    const smallJpg = await makeJpeg(100, 100);
    expect(smallJpg.length).toBeLessThan(2_500_000);
    const out = await compressForVision(smallJpg);
    expect(out.mediaType).toBe("image/jpeg");
    expect(out.bytes).toBe(smallJpg.length);
  });

  it("defaults to image/png when magic bytes don't match a known format", async () => {
    const garbage = Buffer.from("this-is-not-a-real-image-but-its-tiny");
    const out = await compressForVision(garbage);
    expect(out.mediaType).toBe("image/png");
    expect(out.bytes).toBe(garbage.length);
  });
});

/**
 * Cryptographically-random RGB raw bytes — uniform-color sharp `create`
 * buffers compress to nothing through PNG, so we feed sharp incompressible
 * noise to force the file size above the 2.5 MB bypass threshold.
 */
function noiseRgb(width: number, height: number): Buffer {
  return crypto.randomBytes(width * height * 3);
}

describe("compressForVision — large inputs", () => {
  it("downsizes a large noisy PNG until it fits under 5 MB and returns image/jpeg", async () => {
    const big = await sharp(noiseRgb(2200, 2200), {
      raw: { width: 2200, height: 2200, channels: 3 },
    })
      .png({ compressionLevel: 6 })
      .toBuffer();

    expect(big.length).toBeGreaterThan(2_500_000);

    const out = await compressForVision(big);
    expect(out.bytes).toBeLessThanOrEqual(5_000_000);
    expect(out.mediaType).toBe("image/jpeg");
    expect(out.width).toBeDefined();
    expect(out.height).toBeDefined();
    // Long edge clamped to MAX_LONG_EDGE = 1568
    const longEdge = Math.max(out.width!, out.height!);
    expect(longEdge).toBeLessThanOrEqual(1568);
    expect(out.width).toBe(out.height); // square in → square out under fit:inside
  }, 30_000);

  it("does not upscale when the long edge is already within MAX_LONG_EDGE", async () => {
    const med = await sharp(noiseRgb(1500, 1500), {
      raw: { width: 1500, height: 1500, channels: 3 },
    })
      .png({ compressionLevel: 6 })
      .toBuffer();

    if (med.length < 2_500_000) return; // skip if compression beat us
    const out = await compressForVision(med);
    expect(out.bytes).toBeLessThanOrEqual(5_000_000);
    expect(out.mediaType).toBe("image/jpeg");
    expect(out.width!).toBeLessThanOrEqual(1500);
    expect(out.height!).toBeLessThanOrEqual(1500);
  }, 30_000);
});

/**
 * Regression for 2026-06-07: a 1280×8587 full-page PNG that was only 1.47 MB
 * slipped past the byte-only bypass and 400'd the vision API with
 * "image dimensions exceed max allowed size: 8000 pixels". A small-byte but
 * over-8000px image must now be resized, not sent as-is.
 */
describe("compressForVision — tall-page hard-limit guard (8000px)", () => {
  it("does NOT bypass a small-byte PNG taller than 8000px; clamps long edge", async () => {
    const tall = await makePng(1280, 8587); // uniform color → compresses tiny
    expect(tall.length).toBeLessThan(2_500_000); // would have hit the old bypass
    const out = await compressForVision(tall);
    // Must have been resized (bypass leaves width/height undefined).
    expect(out.width).toBeDefined();
    expect(out.height).toBeDefined();
    const longEdge = Math.max(out.width!, out.height!);
    expect(longEdge).toBeLessThanOrEqual(1568);
    // And the actual emitted bytes decode to dimensions under the hard limit.
    const meta = await sharp(Buffer.from(out.base64, "base64")).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(8000);
  }, 30_000);

  it("still bypasses a small PNG within dimension limits", async () => {
    const small = await makePng(800, 600);
    const out = await compressForVision(small);
    expect(out.bytes).toBe(small.length); // untouched
    expect(out.width).toBeUndefined();
  });
});

describe("compressForVisionMulti — tall-page slicing", () => {
  it("returns a single image for a short page", async () => {
    const short = await makePng(1280, 800);
    const out = await compressForVisionMulti(short);
    expect(out).toHaveLength(1);
  });

  it("returns thumbnail + slices for a very tall page, each API-safe", async () => {
    const tall = await sharp(noiseRgb(1280, 8600), {
      raw: { width: 1280, height: 8600, channels: 3 },
    })
      .png({ compressionLevel: 6 })
      .toBuffer();

    const out = await compressForVisionMulti(tall);
    // 1 thumbnail + multiple native-resolution slices.
    expect(out.length).toBeGreaterThan(1);
    expect(out.length).toBeLessThanOrEqual(1 + 8); // thumbnail + MAX_SLICES

    for (const img of out) {
      expect(img.bytes).toBeLessThanOrEqual(5_000_000);
      const meta = await sharp(Buffer.from(img.base64, "base64")).metadata();
      expect(meta.width ?? 0).toBeLessThanOrEqual(8000);
      expect(meta.height ?? 0).toBeLessThanOrEqual(8000);
    }
  }, 60_000);
});

describe("compressForVision — base64 round-trip", () => {
  it("the returned base64 decodes to bytes of the reported size", async () => {
    const small = await makePng(50, 50);
    const out = await compressForVision(small);
    const decoded = Buffer.from(out.base64, "base64");
    expect(decoded.length).toBe(out.bytes);
  });
});

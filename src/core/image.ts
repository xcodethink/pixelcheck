/**
 * Image compression for vision API.
 *
 * Anthropic's vision endpoint enforces:
 *   - Max 5 MB per image
 *   - Max 1568 px on the longest edge (anything larger gets downsampled)
 *   - Max ~1.15 megapixels (anything larger gets downsampled)
 *
 * Full-page screenshots from real product pages routinely exceed these
 * (a long pricing page can hit 6-10 MB PNG). We pre-compress before sending
 * to:
 *   1. Stay under the 5 MB hard limit (avoids 400 errors)
 *   2. Avoid wasting tokens on pixels Claude will downsample anyway
 *   3. Preserve text legibility (key for the localization audit)
 */

const MAX_BYTES = 5_000_000; // hard cap below Anthropic's 5_242_880
const MAX_LONG_EDGE = 1568;

export interface CompressedImage {
  base64: string;
  mediaType: "image/jpeg" | "image/png";
  bytes: number;
  width?: number;
  height?: number;
}

/**
 * Detect image format from the buffer's magic bytes.
 * PNG starts with 89 50 4E 47, JPEG starts with FF D8 FF.
 */
function detectMediaType(buf: Buffer): "image/png" | "image/jpeg" {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  // Default fall-through; safer to assume PNG since Playwright outputs PNG
  return "image/png";
}

/**
 * Compress an image buffer to fit Anthropic vision constraints.
 * Strategy:
 *   1. Resize so long edge ≤ 1568 px (lossless wins)
 *   2. Convert to JPEG quality 85 (preserves text, tiny vs PNG)
 *   3. If still > 5 MB, lower quality to 70, then 55
 *
 * Returns base64-encoded data ready to send to the vision API.
 * Detects the actual media type from buffer magic bytes so callers can pass
 * either PNG or JPEG inputs without mislabeling them.
 */
export async function compressForVision(input: Buffer): Promise<CompressedImage> {
  // If the original is already tiny, send as-is. Auto-detect actual format
  // from magic bytes — the recorder may pass JPEG thumbnails OR PNG segments
  // and Anthropic enforces the declared media_type matches the actual bytes.
  if (input.length < MAX_BYTES / 2) {
    return {
      base64: input.toString("base64"),
      mediaType: detectMediaType(input),
      bytes: input.length,
    };
  }

  let sharpMod: typeof import("sharp") | null;
  try {
    sharpMod = (await import("sharp")) as unknown as typeof import("sharp");
  } catch {
    // No sharp — we have no choice but to send as-is and hope for the best.
    return {
      base64: input.toString("base64"),
      mediaType: "image/png",
      bytes: input.length,
    };
  }

  // sharp default export shape varies between CJS and ESM interop builds.
  const sharp =
    (sharpMod as unknown as { default?: typeof import("sharp") }).default ?? sharpMod;

  const meta = await sharp(input).metadata();
  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
  const scale = longEdge > MAX_LONG_EDGE ? MAX_LONG_EDGE / longEdge : 1;
  const targetWidth = Math.round((meta.width ?? 0) * scale);
  const targetHeight = Math.round((meta.height ?? 0) * scale);

  for (const quality of [85, 70, 55, 40]) {
    const out = await sharp(input)
      .resize({ width: targetWidth, height: targetHeight, fit: "inside" })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (out.length <= MAX_BYTES) {
      return {
        base64: out.toString("base64"),
        mediaType: "image/jpeg",
        bytes: out.length,
        width: targetWidth,
        height: targetHeight,
      };
    }
  }

  // Last resort: very aggressive resize
  const minimal = await sharp(input)
    .resize({ width: Math.min(targetWidth, 1024), fit: "inside" })
    .jpeg({ quality: 50, mozjpeg: true })
    .toBuffer();
  return {
    base64: minimal.toString("base64"),
    mediaType: "image/jpeg",
    bytes: minimal.length,
  };
}

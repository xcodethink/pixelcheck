/**
 * Image compression for vision API.
 *
 * Anthropic's vision endpoint enforces:
 *   - Max 5 MB per image (HARD — 400 error above this)
 *   - Max 8000 px on EITHER edge (HARD — 400 error above this). This is
 *     distinct from the soft 1568 px / 1.15 MP downsample limits below and
 *     is independent of byte size: a 1280×8587 PNG that is only 1.5 MB still
 *     gets rejected with "image dimensions exceed max allowed size: 8000
 *     pixels". A small-byte-but-very-tall full-page screenshot used to slip
 *     past the byte-only bypass and 400 the vision call (see 2026-06-07).
 *   - Max 1568 px on the longest edge (anything larger gets downsampled)
 *   - Max ~1.15 megapixels (anything larger gets downsampled)
 *
 * Full-page screenshots from real product pages routinely exceed these
 * (a long pricing page can hit 6-10 MB PNG). We pre-compress before sending
 * to:
 *   1. Stay under the 5 MB / 8000 px hard limits (avoids 400 errors)
 *   2. Avoid wasting tokens on pixels Claude will downsample anyway
 *   3. Preserve text legibility (key for the localization audit)
 *
 * Note: a single downscaled image of a very tall page becomes illegible
 * (text shrinks past the 1568 px clamp). For rubric scoring, prefer
 * `compressForVisionMulti`, which emits a macro thumbnail + native-resolution
 * vertical slices instead of one squashed image.
 */

import { getLogger } from "./logger.js";

const log = getLogger("image");

const MAX_BYTES = 5_000_000; // hard cap below Anthropic's 5_242_880
const MAX_LONG_EDGE = 1568;
/** Anthropic rejects any image whose width OR height exceeds this (HARD 400). */
const MAX_EDGE_HARD = 8000;

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
 * Read a PNG's pixel dimensions straight from the IHDR chunk without
 * decoding the image (so the byte-size bypass can stay sharp-free for tiny
 * inputs while still rejecting tall ones). For a valid PNG the width/height
 * big-endian uint32s sit at fixed offsets: 8-byte signature + 4-byte length
 * + 4-byte "IHDR" tag → width at byte 16, height at byte 20. Returns null
 * for non-PNG or truncated buffers.
 */
function readPngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  const isPng =
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isPng) return null;
  const isIhdr =
    buf[12] === 0x49 && buf[13] === 0x48 && buf[14] === 0x44 && buf[15] === 0x52;
  if (!isIhdr) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
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
  //
  // Byte-size is NOT sufficient on its own: a full-page screenshot can be
  // both small (whitespace-heavy PNG) AND taller than the 8000 px hard limit.
  // Only bypass when the dimensions are known-safe; otherwise fall through to
  // the sharp resize path so the long edge gets clamped under 8000 px.
  const pngSize = readPngSize(input);
  const overHardEdge =
    pngSize !== null &&
    (pngSize.width > MAX_EDGE_HARD || pngSize.height > MAX_EDGE_HARD);
  if (input.length < MAX_BYTES / 2 && !overHardEdge) {
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

/**
 * Native-resolution vertical slice height. Kept under MAX_LONG_EDGE so each
 * slice is sent at full clarity (no soft downsample) — the whole point of
 * slicing is to preserve text legibility that a single squashed full-page
 * image destroys.
 */
const SLICE_HEIGHT = 1400;
/** Overlap between consecutive slices so a heading + its content never split. */
const SLICE_OVERLAP_RATIO = 0.2;
/**
 * Cap slices so a pathologically long page can't blow the vision budget.
 * 8 native slices (≈20% overlap) fully cover a page up to ~9.4k px tall — the
 * vast majority of real landing pages. Beyond that the slices are spread to
 * span the whole page (reduced overlap) rather than dropping the bottom.
 */
const MAX_SLICES = 8;
/**
 * Slice only when the page is meaningfully taller than one slice — a page that
 * fits in ~1.2 slices reads fine as a single (lightly downscaled) image.
 */
const SLICE_TRIGGER_HEIGHT = Math.round(SLICE_HEIGHT * 1.2);

/**
 * Compress a (potentially very tall) full-page screenshot into a SEQUENCE of
 * vision-API-safe images, mirroring the recorder/critic "thumbnail + overlapping
 * viewport segments" strategy but working purely in image space (no live Page).
 *
 * Returns:
 *   - `[single]`  when the page already fits the single-image envelope, OR when
 *     sharp is unavailable / metadata can't be read. Identical bytes to
 *     `compressForVision` in that case.
 *   - `[thumbnail, slice1, slice2, …]` for tall pages: a downscaled full-page
 *     thumbnail for macro context (first), followed by native-resolution
 *     vertical slices (≤20% overlap) for legible text. Each element is
 *     individually run through `compressForVision`, so every returned image is
 *     guaranteed under the 5 MB / 8000 px / 1568 px limits.
 *
 * This is the correct input for rubric scoring (`runJudgeVision`); a single
 * downscaled image of an 8000 px page is illegible and scores inaccurately.
 */
/**
 * Appended to an otherwise single-image vision prompt when the page was tall
 * enough that `compressForVisionMulti` returned a thumbnail + slices. Keeps the
 * model from treating "the screenshot" as one frame and from double-counting
 * content that appears in the slice overlap. (The `judge` primitive builds its
 * own richer variant inline; this is the shared note for the simpler
 * note / diagnose vision calls.)
 */
export const MULTI_IMAGE_PROMPT_NOTE =
  "\n\nThis page is too tall to capture in one legible image, so it is provided " +
  "as MULTIPLE images: the FIRST is a low-resolution full-page thumbnail for " +
  "macro context (do NOT read fine text from it); the REMAINING images are " +
  "high-resolution vertical slices from top to bottom (~20% overlap — read " +
  "exact text only from these). Treat them as one continuous page and do not " +
  "double-count content that appears in the overlap between slices.";

export async function compressForVisionMulti(
  input: Buffer,
): Promise<CompressedImage[]> {
  let sharpMod: typeof import("sharp") | null;
  try {
    sharpMod = (await import("sharp")) as unknown as typeof import("sharp");
  } catch {
    return [await compressForVision(input)];
  }
  const sharp =
    (sharpMod as unknown as { default?: typeof import("sharp") }).default ?? sharpMod;

  let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    meta = await sharp(input).metadata();
  } catch {
    return [await compressForVision(input)];
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  // Short / unknown pages: a single image is legible enough.
  if (width === 0 || height === 0 || height <= SLICE_TRIGGER_HEIGHT) {
    return [await compressForVision(input)];
  }

  // Macro thumbnail first (whole page, downscaled), then native-res slices.
  const images: CompressedImage[] = [await compressForVision(input)];

  // Slices needed to cover the whole page with the ideal ~20% overlap.
  const idealStride = Math.max(
    1,
    Math.floor(SLICE_HEIGHT * (1 - SLICE_OVERLAP_RATIO)),
  );
  const neededSlices = Math.max(
    1,
    Math.ceil((height - SLICE_HEIGHT) / idealStride) + 1,
  );
  const sliceCount = Math.min(neededSlices, MAX_SLICES);
  // When the page is taller than the slice budget allows, widen the stride so
  // the slices still span top→bottom (reduced overlap) instead of dropping the
  // bottom of the page from native-resolution scoring. Never silently truncate.
  const stride =
    sliceCount > 1
      ? Math.max(idealStride, Math.ceil((height - SLICE_HEIGHT) / (sliceCount - 1)))
      : 0;
  if (neededSlices > MAX_SLICES) {
    log.warn(
      { height, sliceCount, neededSlices },
      "compressForVisionMulti: page taller than slice budget — overlap reduced to keep full-page coverage",
    );
  }

  for (let i = 0; i < sliceCount; i++) {
    const top = Math.min(i * stride, Math.max(0, height - SLICE_HEIGHT));
    const sliceH = Math.min(SLICE_HEIGHT, height - top);
    if (sliceH <= 0) break;
    try {
      const sliceBuf = await sharp(input)
        .extract({ left: 0, top, width, height: sliceH })
        .png()
        .toBuffer();
      images.push(await compressForVision(sliceBuf));
    } catch {
      // A bad extract shouldn't sink the whole audit — the thumbnail + any
      // earlier slices still give the model usable context.
      continue;
    }
  }

  return images;
}

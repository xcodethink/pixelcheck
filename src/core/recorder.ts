import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Page, Frame } from "playwright";
import type { ConsoleError } from "./types.js";
// The previous version of the redaction pass swallowed its failures under a
// comment saying the caller should log them, to avoid coupling this file to
// the logger. No caller did, so a security control could fail for the life of
// the code without saying so. runner.ts and stagehand-wrapper.ts both import
// this; the coupling is the house style and costs less than the silence.
import { getLogger } from "./logger.js";

const log = getLogger("recorder");

/**
 * Recorder: attaches listeners to a Page and accumulates artifacts.
 */
export class Recorder {
  private consoleErrors: ConsoleError[] = [];
  private screenshotIndex = 0;

  constructor(
    private readonly page: Page,
    private readonly artifactsDir: string,
  ) {
    // mode 0o700 — artifacts contain screenshots that may include sensitive
    // content from the audited page. T22.
    fs.mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
    this.attachListeners();
  }

  private attachListeners(): void {
    this.page.on("console", (msg) => {
      if (msg.type() === "error") {
        this.consoleErrors.push({
          type: "console",
          text: msg.text(),
          location: msg.location()?.url,
          timestamp: new Date().toISOString(),
        });
      }
    });

    this.page.on("pageerror", (err) => {
      this.consoleErrors.push({
        type: "pageerror",
        text: err.message,
        location: err.stack,
        timestamp: new Date().toISOString(),
      });
    });

    this.page.on("requestfailed", (req) => {
      const failure = req.failure();
      this.consoleErrors.push({
        type: "requestfailed",
        text: `${failure?.errorText ?? "unknown"} ${req.url()}`,
        timestamp: new Date().toISOString(),
      });
    });
  }

  async screenshot(
    label?: string,
    fullPage = true,
    opts: { redactInputs?: boolean } = {},
  ): Promise<{
    filepath: string;
    sha256: string;
    base64: string;
    buffer: Buffer;
  }> {
    this.screenshotIndex++;
    const idx = String(this.screenshotIndex).padStart(2, "0");
    const safeLabel = (label ?? "step")
      .replace(/[^a-z0-9_-]/gi, "_")
      .toLowerCase();
    const filename = `${idx}-${safeLabel}.png`;
    const filepath = path.join(this.artifactsDir, filename);

    // Full-page captures audit whole-page content, so force scroll-reveal
    // animations to their end state first (avoids false "empty void" from
    // opacity:0 sections). Viewport captures (fullPage=false) are left alone
    // so act/see can still catch a genuinely stuck animation or loading frame.
    if (fullPage) {
      await this.settleAnimations();
    }

    const pass = shouldRedactInputs(opts.redactInputs)
      ? await redactSensitiveInputs(this.page)
      : undefined;
    if (pass && pass.unreachableFrames > 0) {
      log.warn(
        { unreachable: pass.unreachableFrames, redacted: pass.redacted },
        `input redaction could not reach every frame`,
      );
    }
    try {
      const buffer = await this.page.screenshot({ fullPage, type: "png" });
      fs.writeFileSync(filepath, buffer);

      const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
      fs.writeFileSync(`${filepath}.sha256`, sha256 + "\n");

      return {
        filepath,
        sha256,
        base64: buffer.toString("base64"),
        buffer,
      };
    } finally {
      // Restore before returning, not after the caller is done: the next
      // step may type into or submit this very form.
      await pass?.restore();
    }
  }

  /**
   * Capture full-page content as a series of viewport-sized segments by
   * scrolling. This avoids the resolution loss that comes from compressing a
   * single 6+ MB full-page screenshot down to fit Anthropic's 5MB / 1568px
   * vision limit, which causes severe OCR hallucination on dense pages.
   *
   * Strategy (best practice for vision-based audit):
   *  1. Pre-scroll all the way to the bottom + back to top to TRIGGER lazy
   *     loading (Astro islands, intersection observers, image lazy load).
   *  2. Capture native-resolution viewport segments with 20% OVERLAP between
   *     consecutive segments — this guarantees no section title/content gets
   *     split across the segment boundary, which was a real source of false
   *     "missing component" findings.
   *  3. Take a single full-page screenshot for the archive AND a downscaled
   *     thumbnail of the full page that's sent to the critic FIRST, before
   *     the segments. The thumbnail gives the model macro context (where
   *     things are roughly), and the segments give micro detail (exact text).
   *
   * Each segment is a native-resolution viewport snapshot — typically
   * 200-500 KB, well under any limit, and Claude reads them at full clarity.
   */
  async screenshotSegments(
    label?: string,
    opts: { redactInputs?: boolean } = {},
  ): Promise<{
    /** Full-page composite for archival/reports */
    full: { filepath: string; sha256: string; buffer: Buffer };
    /** Downscaled full-page thumbnail for vision macro context (sent first) */
    thumbnail: Buffer;
    /** Viewport-sized segments for vision input (sent after thumbnail) */
    segments: Buffer[];
    /** On-disk paths for the segments */
    segmentPaths: string[];
  }> {
    this.screenshotIndex++;
    const idx = String(this.screenshotIndex).padStart(2, "0");
    const safeLabel = (label ?? "step")
      .replace(/[^a-z0-9_-]/gi, "_")
      .toLowerCase();

    // ─── 1. Trigger lazy loading by scrolling all the way through ──────
    // Many modern sites lazy-render below-the-fold content (images, lists,
    // even entire components). Without this pre-scroll, segments at the
    // bottom of the page would show empty placeholders.
    await this.triggerLazyLoad();

    // ─── 1.2. Force scroll-reveal animations to their end state ───────
    // Without this, revealed sections snap back to opacity:0 during the
    // fullPage capture and render as black, causing false "empty void"
    // findings. See settleAnimations() for the full rationale.
    await this.settleAnimations();

    // ─── 1.5. Redact sensitive inputs before any screenshot ──────────
    // Replace password / secret / token / api-key field
    // contents with **** so they don't leak via screenshot → Claude API.
    // Off only if caller explicitly opts out (e.g., a fixture page where
    // redaction would interfere with the audit) OR env AUDIT_REDACT_INPUTS=0.
    // Redact, shoot everything, then put the values back. Every screenshot
    // in this method has to be taken inside the same pass, and the restore has
    // to happen even if one of them throws — a page left holding ******** in
    // its password field breaks the steps that come after it.
    const pass = shouldRedactInputs(opts.redactInputs)
      ? await redactSensitiveInputs(this.page)
      : undefined;
    if (pass && pass.unreachableFrames > 0) {
      log.warn(
        { unreachable: pass.unreachableFrames, redacted: pass.redacted },
        `input redaction could not reach every frame`,
      );
    }
    try {

    // ─── 2. Save full-page composite for archival ─────────────────────
    const fullName = `${idx}-${safeLabel}.png`;
    const fullPath = path.join(this.artifactsDir, fullName);
    const fullBuf = await this.page.screenshot({ fullPage: true, type: "png" });
    fs.writeFileSync(fullPath, fullBuf);
    const fullSha = crypto
      .createHash("sha256")
      .update(fullBuf)
      .digest("hex");
    fs.writeFileSync(`${fullPath}.sha256`, fullSha + "\n");

    // ─── 3. Build downscaled thumbnail for macro context ──────────────
    const thumbnail = await this.buildThumbnail(fullBuf);

    // ─── 4. Capture overlapping viewport segments ─────────────────────
    const dims = await this.page.evaluate(() => ({
      docHeight: Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
      ),
      viewportH: window.innerHeight,
    }));

    // 20% overlap: each segment advances by 80% of the viewport height.
    // This ensures section titles + their content are never split across the
    // segment boundary, eliminating "title without component" false positives.
    const overlapRatio = 0.2;
    const stride = Math.floor(dims.viewportH * (1 - overlapRatio));

    // Cap segments. Each segment is one ~30-80K token vision input.
    // 5 covers most scrollable pages without blowing the budget.
    const maxSegments = 5;
    const naturalSegments = Math.max(
      1,
      Math.ceil((dims.docHeight - dims.viewportH * overlapRatio) / stride),
    );
    const segmentCount = Math.min(naturalSegments, maxSegments);

    const segments: Buffer[] = [];
    const segmentPaths: string[] = [];

    for (let i = 0; i < segmentCount; i++) {
      const scrollY = Math.min(
        i * stride,
        Math.max(0, dims.docHeight - dims.viewportH),
      );
      await this.page.evaluate((y) => window.scrollTo(0, y), scrollY);
      // Wait for any sticky-element repositioning + animation settling
      await this.page.waitForTimeout(400);

      const segName = `${idx}-${safeLabel}-seg${String(i + 1).padStart(2, "0")}.png`;
      const segPath = path.join(this.artifactsDir, segName);
      const segBuf = await this.page.screenshot({
        fullPage: false,
        type: "png",
      });
      fs.writeFileSync(segPath, segBuf);
      segments.push(segBuf);
      segmentPaths.push(segPath);
    }

    // Reset scroll
    await this.page.evaluate(() => window.scrollTo(0, 0));
    await this.page.waitForTimeout(200);

    return {
      full: { filepath: fullPath, sha256: fullSha, buffer: fullBuf },
      thumbnail,
      segments,
      segmentPaths,
    };
    } finally {
      await pass?.restore();
    }
  }

  /**
   * Force scroll-reveal animations to their END state before a screenshot.
   *
   * WHY: pages that reveal content on scroll (IntersectionObserver + opacity
   * 0→1, "animate-in" / "reveal" / AOS / framer-motion whileInView, etc.) are
   * a major source of FALSE "empty dark void / low-contrast body text"
   * findings. A `fullPage: true` screenshot resizes the viewport to the full
   * document height, which makes IntersectionObservers re-evaluate; sections
   * that were revealed during the pre-scroll snap back to opacity:0 and render
   * as solid black. The critic then reports missing/invisible content that is
   * actually present.
   *
   * Three layers of defense, all best-effort:
   *  1. Emulate `prefers-reduced-motion: reduce` — well-behaved reveal libs
   *     skip straight to the final state when this is set.
   *  2. `getAnimations().finish()` — force any running Web Animations / CSS
   *     transitions to their end frame.
   *  3. Inject a stylesheet that neutralizes animation/transition and forces
   *     opacity:1 on the common reveal-element selectors, as a fallback for
   *     libs that gate visibility purely via a class + IntersectionObserver.
   *
   * This is intentionally conservative: it only touches opacity/animation/
   * transition, never layout, so it cannot introduce a *different* visual
   * artifact. Call AFTER triggerLazyLoad(), BEFORE any screenshot.
   */
  private async settleAnimations(): Promise<void> {
    try {
      // Layer 1: reduced-motion tells compliant libraries to skip animation.
      await this.page.emulateMedia({ reducedMotion: "reduce" });

      // Layers 2+3 run in the page context.
      await this.page.evaluate(() => {
        // Layer 2: finish every in-flight animation/transition.
        try {
          for (const anim of document.getAnimations()) {
            try {
              anim.finish();
            } catch {
              // finite-only; ignore infinite/unfinishable animations
            }
          }
        } catch {
          // getAnimations unsupported; fall through to CSS override
        }

        // Layer 3: fallback stylesheet for class-gated reveal elements.
        // Covers the common patterns: opacity-0 utility (Tailwind), AOS
        // (data-aos), and *reveal*/*fade*/*animate* class names that start
        // hidden. Forcing opacity to 1 makes their content visible for the
        // screenshot without altering position or size.
        const STYLE_ID = "pixelcheck-settle-animations";
        if (!document.getElementById(STYLE_ID)) {
          const style = document.createElement("style");
          style.id = STYLE_ID;
          style.textContent = `
            *, *::before, *::after {
              animation-duration: 0s !important;
              animation-delay: 0s !important;
              transition-duration: 0s !important;
              transition-delay: 0s !important;
            }
            .opacity-0,
            [class*="reveal" i],
            [class*="fade" i],
            [class*="animate-in" i],
            [data-aos]:not(.aos-animate) {
              opacity: 1 !important;
              transform: none !important;
              visibility: visible !important;
            }
          `;
          document.head.appendChild(style);
        }
      });

      // Brief settle so the forced end-states paint before capture.
      await this.page.waitForTimeout(150);
    } catch {
      // Page may have closed; not fatal — screenshot proceeds without settle.
    }
  }

  /**
   * Scroll to the bottom of the page, wait for lazy content, then back to top.
   * This is the standard idiom for triggering intersection-observer based
   * lazy loading. Used before any full-page or segmented screenshot.
   */
  private async triggerLazyLoad(): Promise<void> {
    try {
      await this.page.evaluate(async () => {
        await new Promise<void>((resolve) => {
          let totalHeight = 0;
          const distance = 400;
          const timer = setInterval(() => {
            const scrollHeight = Math.max(
              document.body.scrollHeight,
              document.documentElement.scrollHeight,
            );
            window.scrollBy(0, distance);
            totalHeight += distance;
            if (totalHeight >= scrollHeight + window.innerHeight) {
              clearInterval(timer);
              window.scrollTo(0, 0);
              setTimeout(() => resolve(), 400);
            }
          }, 100);
        });
      });
      // Extra settle for any post-scroll fetches to complete
      await this.page.waitForTimeout(600);
    } catch {
      // Page may have closed mid-scroll; not fatal
    }
  }

  /**
   * Downscale a full-page PNG to a thumbnail that fits Anthropic's vision
   * pipeline ceiling (1568px long edge, ~1.15M pixels). This gives the model
   * macro context for the entire page in a single image.
   *
   * Falls back to the raw buffer if sharp is not available.
   */
  private async buildThumbnail(input: Buffer): Promise<Buffer> {
    try {
      const sharpMod = (await import("sharp").catch(() => null)) as
        | { default: (b: Buffer) => {
            metadata: () => Promise<{ width?: number; height?: number }>;
            resize: (
              opts: { width: number; height: number; fit: "inside" },
            ) => { jpeg: (o: { quality: number; mozjpeg: boolean }) => { toBuffer: () => Promise<Buffer> } };
          } }
        | null;
      if (!sharpMod) return input;
      const sharp = sharpMod.default;

      const meta = await sharp(input).metadata();
      const w = meta.width ?? 1440;
      const h = meta.height ?? 8000;

      // Target the long edge to ~1280 (well under 1568) so the thumbnail
      // fits comfortably and Claude can still read large text.
      const longEdge = Math.max(w, h);
      const scale = Math.min(1, 1280 / longEdge);
      const targetW = Math.round(w * scale);
      const targetH = Math.round(h * scale);

      return await sharp(input)
        .resize({ width: targetW, height: targetH, fit: "inside" })
        .jpeg({ quality: 70, mozjpeg: true })
        .toBuffer();
    } catch {
      return input;
    }
  }

  /**
   * Drain accumulated console errors and reset the buffer.
   */
  drainConsoleErrors(): ConsoleError[] {
    const out = this.consoleErrors;
    this.consoleErrors = [];
    return out;
  }

  /**
   * Get all console errors without draining.
   */
  getConsoleErrors(): ConsoleError[] {
    return [...this.consoleErrors];
  }

  /**
   * Persist console errors to a log file.
   */
  flushConsoleLog(): string {
    const logPath = path.join(this.artifactsDir, "console.log");
    const content = this.consoleErrors
      .map(
        (e) =>
          `[${e.timestamp}] [${e.type}] ${e.text}${e.location ? ` @ ${e.location}` : ""}`,
      )
      .join("\n");
    fs.writeFileSync(logPath, content || "(no console errors)\n");
    return logPath;
  }
}

// ─────────────────────────────────────────────────────────────
// Sensitive input redaction
// ─────────────────────────────────────────────────────────────

/**
 * Decide whether to redact based on caller option AND env override.
 *
 * Precedence (highest first):
 *   1. Explicit `false` from caller → skip (test fixtures, opt-out scenarios)
 *   2. Explicit `true` from caller → redact (override env)
 *   3. Env `AUDIT_REDACT_INPUTS=0` → skip (CLI --no-redact-inputs flag sets this)
 *   4. Default → redact (privacy-first)
 */
function shouldRedactInputs(callerOpt: boolean | undefined): boolean {
  if (callerOpt === false) return false;
  if (callerOpt === true) return true;
  if (process.env.AUDIT_REDACT_INPUTS === "0") return false;
  return true;
}

/**
 * Replace the contents of password / secret / API-key / token input
 * fields with `********` immediately before a screenshot is taken.
 * Mutates the live DOM via page.evaluate; the page's actual user
 * experience is not affected (the inputs are restored to their
 * original values after the screenshot is taken? — NO: we do NOT
 * restore. Screenshots are post-action artifacts; reverting the field
 * would race the next step. Audit primitives that need the original
 * value (e.g., extract) should run BEFORE redaction.)
 *
 * Heuristic dimensions — redact a field if ANY match:
 *
 *   1. `<input type="password">`
 *   2. `autocomplete` ∈ HTML autocomplete sensitive set:
 *        - current-password / new-password / one-time-code
 *        - cc-number / cc-csc / cc-exp / cc-exp-month / cc-exp-year
 *   3. `name` / `id` / `aria-label` / `placeholder` matches the
 *      sensitive-name regex covering 12 patterns:
 *        password / secret / token / api[_-]?key / otp / pin /
 *        recovery|backup[_-]?code / mfa|2fa /
 *        (aws|access)[_-]?key / private[_-]?key / passphrase /
 *        ssn|social[_-]?security / cardnumber|cc[_-]?number / cvv|cvc
 *
 * Notes vs prior versions (closes v1.0 documented gap):
 * - Recovery / backup codes are now redacted (recovery_code, backup_code
 *   account-recovery flows are common post-2FA setup).
 * - AWS access keys (aws_access_key_id, AKIA-...) and private keys.
 * - Credit card number / CVV / expiry — payment-form pages (Stripe, etc).
 *
 * Why mutate vs CSS overlay: CSS `-webkit-text-security: disc` only hides
 * the rendered glyphs, not the underlying value — Claude vision still
 * sees the original characters in some cases (autofill or partial reflow).
 * Replacing the value with `********` guarantees the screenshot bytes
 * never contain the user's secret.
 *
 * False-positive trade-off: with the expanded heuristic we err towards
 * over-redacting (e.g. a field literally named `pin_to_top` would also
 * match). The cost of a false positive is "user can't see the
 * redacted field's content in the screenshot"; the cost of a false
 * negative is "user secret leaks to LLM". We pick the safer side.
 */
/** What a redaction pass did, so the caller can restore and can log. */
export interface RedactionPass {
  /** Fields whose value was replaced. */
  redacted: number;
  /** Frames that could not be reached — a cross-origin frame that detached. */
  unreachableFrames: number;
  /** Put the original values back. Safe to call once. */
  restore(): Promise<void>;
}

/** Marks a redacted field so restore can find it again without a selector. */
const REDACT_MARKER = "data-pixelcheck-redacted";

/**
 * Replace sensitive field values with `********` everywhere in the page,
 * returning a handle that puts them back.
 *
 * Three things this had to learn, all measured in Chromium:
 *
 * 1. It only walked the main frame's light DOM. A card number inside an
 *    iframe kept its value (`4111111111111111`), as did a password inside
 *    an open shadow root — while the comment above named Stripe, which
 *    renders its fields in exactly such a frame. Every frame and every open
 *    shadow root is walked now. Closed shadow roots remain unreachable, and
 *    nothing can change that from outside the page.
 *
 * 2. The replacement was permanent. A scenario that fills a password, takes
 *    a screenshot, then submits, submitted `********` — measured end to end.
 *    The site rejects the login and the audit records a finding against the
 *    site for a fault in this tool, which is the worst shape a bug can take
 *    in an auditing product. Hence restore().
 *
 * 3. Failures were swallowed by a bare catch, under a comment saying the
 *    caller should log them. No caller did. The counts come back so the
 *    recorder can say what happened.
 *
 * The original values stay in this process and are never written into the
 * DOM — an attribute holding the secret would simply move the leak from the
 * screenshot to any DOM dump.
 */
async function redactSensitiveInputs(page: Page): Promise<RedactionPass> {
  const perFrame: Array<{ frame: Frame; values: string[] }> = [];
  let unreachableFrames = 0;

  // Enumerating the frames can itself fail — a page that has been closed, or
  // a test double standing in for one. A screenshot is forensic evidence and
  // losing it is worse than not redacting, so this degrades rather than
  // throwing; it is counted so the recorder can say the pass was incomplete
  // instead of reporting a clean zero.
  let frames: Frame[] = [];
  try {
    frames = typeof page.frames === "function" ? page.frames() : [];
    if (frames.length === 0) unreachableFrames++;
  } catch {
    unreachableFrames++;
  }

  for (const frame of frames) {
    try {
      const values = await frame.evaluate((marker) => {
        const SENSITIVE_NAME_RE =
          /password|secret|token|api[_-]?key|otp|pin|recovery[_-]?code|backup[_-]?code|mfa|2fa|aws[_-]?(?:access|secret)|access[_-]?key|private[_-]?key|passphrase|ssn|social[_-]?security|card[_-]?number|cardnumber|cc[_-]?number|cvv|cvc/i;

        const SENSITIVE_AUTOCOMPLETE = new Set([
          "current-password",
          "new-password",
          "one-time-code",
          "cc-number",
          "cc-csc",
          "cc-exp",
          "cc-exp-month",
          "cc-exp-year",
        ]);

        // Walked with an explicit stack rather than a recursive helper.
        // esbuild wraps named functions in `__name(...)` to preserve
        // Function.name, and that helper does not exist inside the page —
        // the whole pass throws `ReferenceError: __name is not defined` and
        // redacts nothing. It fails only on the tsx path, so a build would
        // have hidden it.
        const found: Element[] = [];
        const roots: Array<Document | ShadowRoot> = [document];
        while (roots.length > 0) {
          const root = roots.pop() as Document | ShadowRoot;
          found.push(...Array.from(root.querySelectorAll("input, textarea")));
          for (const el of Array.from(root.querySelectorAll("*"))) {
            const sr = (el as Element & { shadowRoot?: ShadowRoot | null })
              .shadowRoot;
            if (sr) roots.push(sr);
          }
        }

        const originals: string[] = [];
        for (const el of found) {
          const input = el as HTMLInputElement | HTMLTextAreaElement;
          const type =
            (input.getAttribute("type") || "").toLowerCase() || "text";
          const sensitive =
            type === "password" ||
            SENSITIVE_AUTOCOMPLETE.has(
              (input.getAttribute("autocomplete") || "").toLowerCase(),
            ) ||
            SENSITIVE_NAME_RE.test(input.getAttribute("name") || "") ||
            SENSITIVE_NAME_RE.test(input.getAttribute("id") || "") ||
            SENSITIVE_NAME_RE.test(input.getAttribute("aria-label") || "") ||
            SENSITIVE_NAME_RE.test(input.getAttribute("placeholder") || "");
          if (sensitive && input.value && input.value.length > 0) {
            input.setAttribute(marker, String(originals.length));
            originals.push(input.value);
            input.value = "********";
          }
        }
        return originals;
      }, REDACT_MARKER);
      if (values.length > 0) perFrame.push({ frame, values });
    } catch {
      // A frame that navigated or detached mid-pass. Counted rather than
      // swallowed: an operator running with redaction on needs to know a
      // frame went unchecked.
      unreachableFrames++;
    }
  }

  let restored = false;
  return {
    redacted: perFrame.reduce((n, f) => n + f.values.length, 0),
    unreachableFrames,
    async restore(): Promise<void> {
      if (restored) return;
      restored = true;
      for (const { frame, values } of perFrame) {
        try {
          await frame.evaluate(
            ([marker, vals]) => {
              // Same explicit stack, same reason.
              const found: Element[] = [];
              const roots: Array<Document | ShadowRoot> = [document];
              while (roots.length > 0) {
                const root = roots.pop() as Document | ShadowRoot;
                found.push(
                  ...Array.from(root.querySelectorAll(`[${marker}]`)),
                );
                for (const el of Array.from(root.querySelectorAll("*"))) {
                  const sr = (el as Element & { shadowRoot?: ShadowRoot | null })
                    .shadowRoot;
                  if (sr) roots.push(sr);
                }
              }
              for (const el of found) {
                const input = el as HTMLInputElement | HTMLTextAreaElement;
                const i = Number(input.getAttribute(marker as string));
                const original = (vals as string[])[i];
                if (original !== undefined) input.value = original;
                input.removeAttribute(marker as string);
              }
            },
            [REDACT_MARKER, values] as [string, string[]],
          );
        } catch {
          // The frame is gone, so there is nothing left to restore in it.
        }
      }
    },
  };
}

export { redactSensitiveInputs };

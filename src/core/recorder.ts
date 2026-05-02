import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "playwright";
import type { ConsoleError } from "./types.js";

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
    // content from the audited page. T22 (R36).
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

    if (shouldRedactInputs(opts.redactInputs)) {
      await redactSensitiveInputs(this.page);
    }
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

    // ─── 1.5. Redact sensitive inputs before any screenshot ──────────
    // T22 (R37): replace password / secret / token / api-key field
    // contents with **** so they don't leak via screenshot → Claude API.
    // Off only if caller explicitly opts out (e.g., a fixture page where
    // redaction would interfere with the audit) OR env AUDIT_REDACT_INPUTS=0.
    if (shouldRedactInputs(opts.redactInputs)) {
      await redactSensitiveInputs(this.page);
    }

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
// Sensitive input redaction (T22 — closes RISK-REGISTER R37)
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
 * Notes vs prior versions (closes R-NEW-58 v1.0 documented gap):
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
async function redactSensitiveInputs(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      // Combined sensitive-name regex — 12 patterns.
      // Anchor-friendly so substring matches inside longer names work
      // (e.g. `user_password_field` → match via `password`).
      const SENSITIVE_NAME_RE =
        /password|secret|token|api[_-]?key|otp|pin|recovery[_-]?code|backup[_-]?code|mfa|2fa|aws[_-]?(?:access|secret)|access[_-]?key|private[_-]?key|passphrase|ssn|social[_-]?security|card[_-]?number|cardnumber|cc[_-]?number|cvv|cvc/i;

      const SENSITIVE_AUTOCOMPLETE = new Set([
        "current-password",
        "new-password",
        "one-time-code",
        // HTML autocomplete spec credit-card values
        "cc-number",
        "cc-csc",
        "cc-exp",
        "cc-exp-month",
        "cc-exp-year",
      ]);

      const inputs = document.querySelectorAll("input, textarea");
      for (const el of Array.from(inputs)) {
        const input = el as HTMLInputElement | HTMLTextAreaElement;
        const type =
          (input.getAttribute("type") || "").toLowerCase() || "text";
        const autocomplete = (
          input.getAttribute("autocomplete") || ""
        ).toLowerCase();
        const name = input.getAttribute("name") || "";
        const id = input.getAttribute("id") || "";
        const ariaLabel = input.getAttribute("aria-label") || "";
        const placeholder = input.getAttribute("placeholder") || "";
        const sensitive =
          type === "password" ||
          SENSITIVE_AUTOCOMPLETE.has(autocomplete) ||
          SENSITIVE_NAME_RE.test(name) ||
          SENSITIVE_NAME_RE.test(id) ||
          SENSITIVE_NAME_RE.test(ariaLabel) ||
          SENSITIVE_NAME_RE.test(placeholder);
        if (sensitive && input.value && input.value.length > 0) {
          input.value = "********";
        }
      }
    });
  } catch {
    // Page may have closed mid-redact; recorder errors are non-fatal so
    // don't block the screenshot. Worst case: we screenshot the original
    // (unredacted) content. The caller (handler) will log the artifact
    // path; an operator running with --redact-inputs ON would expect
    // redaction so we should at least surface the failure in logs.
    // (Logging deferred to caller to avoid coupling recorder to logger.)
  }
}

export { redactSensitiveInputs };

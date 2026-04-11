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
    fs.mkdirSync(artifactsDir, { recursive: true });
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

  async screenshot(label?: string, fullPage = true): Promise<{
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
   * Each segment is a native-resolution viewport snapshot — typically
   * 200-500 KB, well under any limit, and Claude reads them at full clarity.
   *
   * Returns one full-page screenshot for the artifact archive PLUS the
   * individual segments for vision input.
   */
  async screenshotSegments(label?: string): Promise<{
    /** Full-page composite for archival/reports */
    full: { filepath: string; sha256: string; buffer: Buffer };
    /** Viewport-sized segments for vision input */
    segments: Buffer[];
    /** On-disk paths for the segments */
    segmentPaths: string[];
  }> {
    this.screenshotIndex++;
    const idx = String(this.screenshotIndex).padStart(2, "0");
    const safeLabel = (label ?? "step")
      .replace(/[^a-z0-9_-]/gi, "_")
      .toLowerCase();

    // Save full-page composite for archival
    const fullName = `${idx}-${safeLabel}.png`;
    const fullPath = path.join(this.artifactsDir, fullName);
    const fullBuf = await this.page.screenshot({ fullPage: true, type: "png" });
    fs.writeFileSync(fullPath, fullBuf);
    const fullSha = crypto
      .createHash("sha256")
      .update(fullBuf)
      .digest("hex");
    fs.writeFileSync(`${fullPath}.sha256`, fullSha + "\n");

    // Get document size + viewport size
    const dims = await this.page.evaluate(() => ({
      docHeight: Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
      ),
      viewportH: window.innerHeight,
    }));

    // Cap segments. Each segment is one ~50-150K token vision input.
    // 5 covers most scrollable pages without blowing the budget.
    const maxSegments = 5;
    const naturalSegments = Math.ceil(dims.docHeight / dims.viewportH);
    const segmentCount = Math.min(naturalSegments, maxSegments);

    const segments: Buffer[] = [];
    const segmentPaths: string[] = [];

    for (let i = 0; i < segmentCount; i++) {
      const scrollY = i * dims.viewportH;
      await this.page.evaluate((y) => window.scrollTo(0, y), scrollY);
      // Wait for any lazy content / sticky-element repositioning
      await this.page.waitForTimeout(300);

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

    return {
      full: { filepath: fullPath, sha256: fullSha, buffer: fullBuf },
      segments,
      segmentPaths,
    };
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

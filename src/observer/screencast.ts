/**
 * CDP Screencast — Real-time browser frame streaming via Chrome DevTools Protocol.
 *
 * Uses Page.startScreencast for efficient JPEG frame streaming.
 * Only sends frames when the viewport changes, at controlled quality/resolution.
 * Non-blocking — does not affect agent execution performance.
 */

import type { Page, CDPSession } from "playwright";
import { getLogger } from "../core/logger.js";

const log = getLogger("observer.screencast");

export interface ScreencastOptions {
  /** Image format. Default: "jpeg" */
  format?: "jpeg" | "png";
  /** JPEG quality (1-100). Default: 50 */
  quality?: number;
  /** Max frame width. Default: 800 */
  maxWidth?: number;
  /** Max frame height. Default: 600 */
  maxHeight?: number;
  /** Send every Nth frame (1 = every frame). Default: 3 (~10fps at 30fps render) */
  everyNthFrame?: number;
}

export interface ScreencastHandle {
  /** Stop the screencast and clean up CDP session */
  stop(): Promise<void>;
}

/**
 * Start CDP screencast on a Playwright Page.
 *
 * @param page Playwright Page instance
 * @param onFrame Callback invoked with base64-encoded JPEG/PNG frame data
 * @param options Screencast configuration
 * @returns Handle to stop the screencast
 */
export async function startScreencast(
  page: Page,
  onFrame: (base64Data: string, metadata: { timestamp: number }) => void,
  options: ScreencastOptions = {},
): Promise<ScreencastHandle> {
  const {
    format = "jpeg",
    quality = 50,
    maxWidth = 800,
    maxHeight = 600,
    everyNthFrame = 3,
  } = options;

  let cdp: CDPSession;
  try {
    cdp = await page.context().newCDPSession(page);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      `CDP not available, screencast disabled`,
    );
    return { stop: async () => {} };
  }

  cdp.on("Page.screencastFrame", (params) => {
    onFrame(params.data, { timestamp: params.metadata.timestamp ?? Date.now() });
    // Must ack each frame to continue receiving
    cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
  });

  await cdp.send("Page.startScreencast", {
    format,
    quality,
    maxWidth,
    maxHeight,
    everyNthFrame,
  });

  return {
    stop: async () => {
      try {
        await cdp.send("Page.stopScreencast");
      } catch {
        // Page may already be closed
      }
      try {
        await cdp.detach();
      } catch {
        // Session may already be detached
      }
    },
  };
}

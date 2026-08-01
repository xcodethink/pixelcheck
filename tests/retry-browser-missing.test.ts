import { describe, it, expect } from "vitest";
import { withRetry, terminalErrorReason } from "../src/core/retry.js";

/**
 * A browser that was never installed is terminal, the same as one that died.
 *
 * The first pass at the terminal-error classifier covered a browser that had
 * been alive and closed — "Target page, context or browser has been closed" —
 * and missed the case where it was never there. Playwright reports that as
 * "Executable doesn't exist at …", identically whether the download never ran,
 * the cache was cleared, or PLAYWRIGHT_BROWSERS_PATH points somewhere empty.
 *
 * It was retried three times per step. No amount of retrying installs a
 * browser, and this is not a rare state: the whole `pixelcheck install` and
 * `doctor --fix` machinery exists because it happens.
 *
 * Measured on a three-unit matrix with the browser made unavailable: 11s before
 * this, 1s after.
 */

async function attempts(message: string): Promise<number> {
  let n = 0;
  try {
    await withRetry(
      async () => {
        n++;
        throw new Error(message);
      },
      { maxRetries: 2, backoffMs: 1 },
      "test",
    );
  } catch {
    /* expected */
  }
  return n;
}

describe("a missing browser executable is terminal", () => {
  it.each([
    "browserContext.newPage: Executable doesn't exist at /p/chrome-headless-shell",
    "browserType.launch: Executable doesn't exist at /x/chrome",
    "Failed to launch chromium because executable doesn't exist",
    "Looks like Playwright was just installed or updated. Please run the following command to download new browsers",
  ])("classifies and stops on: %s", async (message) => {
    expect(terminalErrorReason(new Error(message))).toBe(
      "browser executable missing",
    );
    expect(await attempts(message)).toBe(1);
  });

  it.each([
    "Navigation timeout of 30000 ms exceeded",
    "locator.click: element not found",
    "503 Service Unavailable",
    "net::ERR_NAME_NOT_RESOLVED",
  ])("still retries the transient failure: %s", async (message) => {
    // The half that matters most. A classifier that swallowed these would be
    // a worse defect than the one it replaces.
    expect(terminalErrorReason(new Error(message))).toBeNull();
    expect(await attempts(message)).toBe(3);
  });

  it("does not fire on prose that merely mentions an executable", () => {
    // Issue descriptions are LLM-written and land in the same classifier via
    // the CLI's environment-failure summary. A false positive there would tell
    // the user their machine is broken when the site simply scored badly.
    expect(
      terminalErrorReason(
        new Error("The download button suggests an executable is available"),
      ),
    ).toBeNull();
  });
});

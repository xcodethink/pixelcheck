import { describe, it, expect } from "vitest";
import { withRetry, terminalErrorReason } from "../src/core/retry.js";

/**
 * The retry policy must not retry what cannot succeed.
 *
 * `retryableErrors` is an allow-list, defaults to empty, and nothing in this
 * repository has ever set it — so before this, every error except two named
 * classes was retried. The single production call site wraps a whole step:
 * navigate, screenshot, LLM call. A full disk or a dead browser re-ran that
 * cascade twice with backoff to fail identically and take longer doing it.
 *
 * Both directions are tested. A classifier that stops retrying transient
 * failures would be a worse bug than the one it replaces, so the second half
 * of this file matters as much as the first.
 */

/** Runs a function that always throws, and reports how many attempts happened. */
async function attemptsBeforeGivingUp(err: unknown): Promise<number> {
  let attempts = 0;
  try {
    await withRetry(
      async () => {
        attempts++;
        throw err;
      },
      { maxRetries: 2, backoffMs: 1 },
      "test",
    );
  } catch {
    /* expected */
  }
  return attempts;
}

describe("terminalErrorReason", () => {
  it.each([
    ["ENOSPC: no space left on device, write", "no space left on device"],
    ["EDQUOT: disk quota exceeded", "disk quota exceeded"],
    ["EROFS: read-only file system, open '/x'", "read-only file system"],
    ["EACCES: permission denied, mkdir '/x'", "permission denied"],
    ["EPERM: operation not permitted, rmdir '/x'", "operation not permitted"],
    ["Target page, context or browser has been closed", "browser or page closed"],
    ["Protocol error (Page.captureScreenshot): Target closed", "browser or page closed"],
    ["401 Unauthorized: invalid_api_key", "authentication rejected"],
  ])("classifies %s", (message, expected) => {
    expect(terminalErrorReason(new Error(message))).toBe(expected);
  });

  it.each([
    "ECONNRESET",
    "503 Service Unavailable",
    "Navigation timeout of 30000 ms exceeded",
    "locator.click: element not found",
    "429 Too Many Requests",
    "socket hang up",
  ])("leaves transient failure %s alone", (message) => {
    expect(terminalErrorReason(new Error(message))).toBeNull();
  });

  it("does not match a message that merely mentions a code in passing", () => {
    // The word boundaries matter: a page whose content includes the string
    // would otherwise abort a run through an error message that quotes it.
    expect(terminalErrorReason(new Error("no ENOSPCX code here"))).toBeNull();
  });
});

describe("withRetry — terminal conditions", () => {
  it("stops after one attempt when the disk is full", async () => {
    // Each retry writes again, including the screenshots taken along the way,
    // so retrying is not merely useless here — it makes the condition worse.
    expect(await attemptsBeforeGivingUp(new Error("ENOSPC: no space left on device"))).toBe(1);
  });

  it("stops after one attempt when the browser is gone", async () => {
    expect(
      await attemptsBeforeGivingUp(new Error("Target page, context or browser has been closed")),
    ).toBe(1);
  });

  it("stops after one attempt when the credential was rejected", async () => {
    // Hammering an endpoint that just rejected the key is how a key gets
    // rate-limited.
    const err = Object.assign(new Error("bad key"), { name: "AuthenticationError" });
    expect(await attemptsBeforeGivingUp(err)).toBe(1);
  });

  it("still retries a transient network failure", async () => {
    expect(await attemptsBeforeGivingUp(new Error("ECONNRESET"))).toBe(3);
  });

  it("still retries an upstream 503", async () => {
    expect(await attemptsBeforeGivingUp(new Error("503 Service Unavailable"))).toBe(3);
  });

  it("still retries a navigation timeout", async () => {
    expect(
      await attemptsBeforeGivingUp(new Error("Navigation timeout of 30000 ms exceeded")),
    ).toBe(3);
  });

  it("succeeds normally when the operation eventually works", async () => {
    // The guard must not change the happy path.
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("ECONNRESET");
        return "done";
      },
      { maxRetries: 3, backoffMs: 1 },
      "test",
    );
    expect(result).toBe("done");
    expect(attempts).toBe(3);
  });
});

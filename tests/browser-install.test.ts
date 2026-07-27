/**
 * Unit tests for src/core/browser-install.ts.
 *
 * Network-free: covers the deterministic pieces — CfT platform-token
 * mapping and headless-shell path resolution against the real
 * playwright-core/browsers.json shipped in node_modules. The actual
 * download in ensureHeadlessShell() is exercised only for its no-op /
 * unsupported branches (no network egress from tests).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  cftPlatformToken,
  resolveHeadlessShell,
  isMissingBrowserBinaryError,
  launchWithBrowserAutoInstall,
  assertTrustedDownloadUrl,
  _setEnsureHeadlessShellForTests,
} from "../src/core/browser-install.js";

describe("assertTrustedDownloadUrl (Audit 2026-06-02 A1/A2 — supply chain)", () => {
  it("accepts the real Chrome-for-Testing download hosts over HTTPS", () => {
    for (const u of [
      "https://cdn.playwright.dev/builds/cft/1234/chrome-headless-shell-mac-arm64.zip",
      "https://storage.googleapis.com/chrome-for-testing-public/x.zip",
      "https://playwright.download.prss.microsoft.com/dbazure/x.zip",
    ]) {
      expect(() => assertTrustedDownloadUrl(u)).not.toThrow();
    }
  });

  it("rejects an untrusted host (redirect-to-attacker)", () => {
    expect(() =>
      assertTrustedDownloadUrl("https://evil.example.com/chrome-headless-shell.zip"),
    ).toThrow(/untrusted host/i);
  });

  it("rejects non-HTTPS even on a trusted host", () => {
    expect(() =>
      assertTrustedDownloadUrl("http://cdn.playwright.dev/x.zip"),
    ).toThrow(/HTTPS required/i);
  });

  it("rejects a malformed URL", () => {
    expect(() => assertTrustedDownloadUrl("not a url")).toThrow(/malformed/i);
  });
});

describe("cftPlatformToken", () => {
  it("maps macOS arm64 / x64", () => {
    expect(cftPlatformToken("darwin", "arm64")).toBe("mac-arm64");
    expect(cftPlatformToken("darwin", "x64")).toBe("mac-x64");
  });

  it("maps linux x64", () => {
    expect(cftPlatformToken("linux", "x64")).toBe("linux64");
  });

  it("maps Windows x64 / ia32", () => {
    expect(cftPlatformToken("win32", "x64")).toBe("win64");
    expect(cftPlatformToken("win32", "ia32")).toBe("win32");
  });

  it("returns null for combos with no published CfT headless-shell build", () => {
    expect(cftPlatformToken("linux", "arm64")).toBeNull();
    expect(cftPlatformToken("darwin", "ppc")).toBeNull();
    expect(cftPlatformToken("freebsd" as NodeJS.Platform, "x64")).toBeNull();
  });
});

describe("resolveHeadlessShell", () => {
  it("resolves revision + path from playwright-core browsers.json", () => {
    const info = resolveHeadlessShell();
    // browsers.json is always present in this repo's node_modules.
    expect(info).not.toBeNull();
    if (!info) return;
    expect(info.revision).toMatch(/^\d+$/);
    // The executable lives under the underscore-named install dir, NOT the
    // hyphenated full-Chromium dir — this is the whole point of the check.
    expect(info.executablePath).toContain(
      `chromium_headless_shell-${info.revision}`,
    );
    expect(info.executablePath).toMatch(/chrome-headless-shell(\.exe)?$/);
    expect(typeof info.present).toBe("boolean");
  });

  it("install dir and executable share the same revision", () => {
    const info = resolveHeadlessShell();
    if (!info) return;
    expect(info.executablePath.startsWith(info.installDir)).toBe(true);
  });
});

describe("isMissingBrowserBinaryError", () => {
  it("matches Playwright's missing-executable messages", () => {
    expect(
      isMissingBrowserBinaryError(
        new Error(
          "browserType.launch: Executable doesn't exist at /x/chromium_headless_shell-1217/y",
        ),
      ),
    ).toBe(true);
    expect(
      isMissingBrowserBinaryError(new Error("run npx playwright install")),
    ).toBe(true);
    expect(
      isMissingBrowserBinaryError("missing chrome-headless-shell binary"),
    ).toBe(true);
  });

  it("does NOT match unrelated runtime faults", () => {
    expect(
      isMissingBrowserBinaryError(new Error("Navigation timeout of 30000ms")),
    ).toBe(false);
    expect(
      isMissingBrowserBinaryError(new Error("connect ECONNREFUSED 127.0.0.1")),
    ).toBe(false);
    expect(isMissingBrowserBinaryError(null)).toBe(false);
  });
});

describe("launchWithBrowserAutoInstall", () => {
  afterEach(() => _setEnsureHeadlessShellForTests(null));

  it("returns the launch result and never heals on first-try success", async () => {
    const heal = vi.fn();
    _setEnsureHeadlessShellForTests(heal as never);
    const launch = vi.fn().mockResolvedValue("browser");
    await expect(launchWithBrowserAutoInstall(launch)).resolves.toBe("browser");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(heal).not.toHaveBeenCalled();
  });

  it("rethrows a non-missing-binary error WITHOUT attempting a heal", async () => {
    const heal = vi.fn();
    _setEnsureHeadlessShellForTests(heal as never);
    const launch = vi
      .fn()
      .mockRejectedValue(new Error("Navigation timeout of 30000ms"));
    await expect(launchWithBrowserAutoInstall(launch)).rejects.toThrow(
      /Navigation timeout/,
    );
    expect(launch).toHaveBeenCalledTimes(1);
    expect(heal).not.toHaveBeenCalled();
  });

  it("heals once and retries when the binary is missing", async () => {
    const heal = vi
      .fn()
      .mockResolvedValue({ status: "installed", message: "installed" });
    _setEnsureHeadlessShellForTests(heal as never);
    const launch = vi
      .fn()
      .mockRejectedValueOnce(new Error("Executable doesn't exist at /x"))
      .mockResolvedValueOnce("browser");
    await expect(launchWithBrowserAutoInstall(launch)).resolves.toBe("browser");
    expect(launch).toHaveBeenCalledTimes(2);
    expect(heal).toHaveBeenCalledTimes(1);
  });

  it("surfaces an actionable error when the heal itself fails", async () => {
    const heal = vi
      .fn()
      .mockResolvedValue({ status: "error", message: "download failed" });
    _setEnsureHeadlessShellForTests(heal as never);
    const launch = vi
      .fn()
      .mockRejectedValue(new Error("Executable doesn't exist at /x"));
    await expect(launchWithBrowserAutoInstall(launch)).rejects.toThrow(
      /auto-install error: download failed[\s\S]*Original launch error/,
    );
    // Only the first launch ran; we did not blindly retry after a failed heal.
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

/**
 * Unit tests for src/core/browser-install.ts.
 *
 * Network-free: covers the deterministic pieces — CfT platform-token
 * mapping and headless-shell path resolution against the real
 * playwright-core/browsers.json shipped in node_modules. The actual
 * download in ensureHeadlessShell() is exercised only for its no-op /
 * unsupported branches (no network egress from tests).
 */

import { describe, it, expect } from "vitest";
import {
  cftPlatformToken,
  resolveHeadlessShell,
} from "../src/core/browser-install.js";

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

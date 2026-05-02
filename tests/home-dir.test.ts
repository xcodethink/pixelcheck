/**
 * Unit tests for src/core/home-dir.ts (E1 — deprecation cycle for AUDIT_HOME).
 *
 * Covers:
 *   - PIXELCHECK_HOME takes precedence
 *   - AUDIT_HOME falls back when PIXELCHECK_HOME unset
 *   - Default ~/.pixelcheck/ when neither is set
 *   - Deprecation warning fires once per process when AUDIT_HOME is the
 *     resolved source (not when PIXELCHECK_HOME is set)
 *   - Empty string env vars are treated as unset
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import {
  pixelcheckHome,
  _resetDeprecationWarningForTests,
} from "../src/core/home-dir.js";

beforeEach(() => {
  delete process.env.PIXELCHECK_HOME;
  delete process.env.AUDIT_HOME;
  _resetDeprecationWarningForTests();
});

afterEach(() => {
  // Tests that spy on logger.warn share the singleton logger across the
  // suite — restore between tests to avoid spy bleed.
  vi.restoreAllMocks();
});

describe("pixelcheckHome — resolution order", () => {
  it("returns PIXELCHECK_HOME when set", () => {
    process.env.PIXELCHECK_HOME = "/custom/pixelcheck";
    expect(pixelcheckHome()).toBe("/custom/pixelcheck");
  });

  it("falls back to AUDIT_HOME when PIXELCHECK_HOME is unset", () => {
    process.env.AUDIT_HOME = "/legacy/audit";
    expect(pixelcheckHome()).toBe("/legacy/audit");
  });

  it("PIXELCHECK_HOME wins over AUDIT_HOME when both are set", () => {
    process.env.PIXELCHECK_HOME = "/canonical";
    process.env.AUDIT_HOME = "/legacy";
    expect(pixelcheckHome()).toBe("/canonical");
  });

  it("defaults to ~/.pixelcheck/ when neither is set", () => {
    expect(pixelcheckHome()).toBe(path.join(os.homedir(), ".pixelcheck"));
  });

  it("treats empty string PIXELCHECK_HOME as unset", () => {
    process.env.PIXELCHECK_HOME = "";
    process.env.AUDIT_HOME = "/legacy/audit";
    expect(pixelcheckHome()).toBe("/legacy/audit");
  });

  it("treats empty string AUDIT_HOME as unset", () => {
    process.env.AUDIT_HOME = "";
    expect(pixelcheckHome()).toBe(path.join(os.homedir(), ".pixelcheck"));
  });
});

describe("pixelcheckHome — deprecation warning", () => {
  it("warns once when AUDIT_HOME resolves the path", async () => {
    const logger = await import("../src/core/logger.js");
    const warnSpy = vi.spyOn(logger.getLogger("home-dir"), "warn");
    process.env.AUDIT_HOME = "/legacy/audit";

    pixelcheckHome();
    pixelcheckHome();
    pixelcheckHome();

    // Each pixelcheckHome() call returns the resolved path; the warning
    // fires only on the first call where AUDIT_HOME is the resolved
    // source (warn-once latch).
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const callArgs = warnSpy.mock.calls[0]!;
    const message = callArgs[1] as string;
    expect(message).toMatch(/AUDIT_HOME is deprecated/);
    expect(message).toMatch(/PIXELCHECK_HOME/);
    expect(message).toMatch(/v2\.0/);
  });

  it("does NOT warn when PIXELCHECK_HOME is the resolved source", async () => {
    const logger = await import("../src/core/logger.js");
    const warnSpy = vi.spyOn(logger.getLogger("home-dir"), "warn");
    process.env.PIXELCHECK_HOME = "/canonical";
    process.env.AUDIT_HOME = "/legacy"; // present but ignored

    pixelcheckHome();
    pixelcheckHome();

    // Even though AUDIT_HOME is set, it never resolved the path —
    // so no deprecation warning should fire. The user did the right
    // thing by also setting PIXELCHECK_HOME.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does NOT warn on default (~/.pixelcheck/) path resolution", async () => {
    const logger = await import("../src/core/logger.js");
    const warnSpy = vi.spyOn(logger.getLogger("home-dir"), "warn");

    pixelcheckHome();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

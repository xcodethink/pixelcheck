/**
 * Tests for src/core/verbosity.ts — verbosity mode resolution and application.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveVerbosity,
  applyVerbosity,
  getVerbosity,
  isQuiet,
  isVerbose,
  verbosityToLogLevel,
  _resetVerbosityForTests,
} from "../src/core/verbosity.js";

const savedEnv = { ...process.env };

beforeEach(() => {
  _resetVerbosityForTests();
  delete process.env.PIXELCHECK_VERBOSITY;
  delete process.env.LOG_LEVEL;
});

afterEach(() => {
  _resetVerbosityForTests();
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

// ─────────────────────────────────────────────────────────────
// resolveVerbosity
// ─────────────────────────────────────────────────────────────

describe("resolveVerbosity", () => {
  it("defaults to 'normal' when no flags or env set", () => {
    expect(resolveVerbosity()).toBe("normal");
    expect(resolveVerbosity({})).toBe("normal");
  });

  it("returns 'quiet' when --quiet flag is set", () => {
    expect(resolveVerbosity({ quiet: true })).toBe("quiet");
  });

  it("returns 'verbose' when --verbose flag is set", () => {
    expect(resolveVerbosity({ verbose: true })).toBe("verbose");
  });

  it("quiet wins when both --quiet and --verbose are set", () => {
    expect(resolveVerbosity({ quiet: true, verbose: true })).toBe("quiet");
  });

  it("reads PIXELCHECK_VERBOSITY env when no flags", () => {
    process.env.PIXELCHECK_VERBOSITY = "verbose";
    expect(resolveVerbosity()).toBe("verbose");

    process.env.PIXELCHECK_VERBOSITY = "quiet";
    expect(resolveVerbosity()).toBe("quiet");

    process.env.PIXELCHECK_VERBOSITY = "normal";
    expect(resolveVerbosity()).toBe("normal");
  });

  it("env is case-insensitive", () => {
    process.env.PIXELCHECK_VERBOSITY = "VERBOSE";
    expect(resolveVerbosity()).toBe("verbose");

    process.env.PIXELCHECK_VERBOSITY = "Quiet";
    expect(resolveVerbosity()).toBe("quiet");
  });

  it("ignores invalid env values and falls back to default", () => {
    process.env.PIXELCHECK_VERBOSITY = "turbo";
    expect(resolveVerbosity()).toBe("normal");
  });

  it("flag takes priority over env (flag > env > default)", () => {
    process.env.PIXELCHECK_VERBOSITY = "quiet";
    expect(resolveVerbosity({ verbose: true })).toBe("verbose");

    process.env.PIXELCHECK_VERBOSITY = "verbose";
    expect(resolveVerbosity({ quiet: true })).toBe("quiet");
  });
});

// ─────────────────────────────────────────────────────────────
// verbosityToLogLevel
// ─────────────────────────────────────────────────────────────

describe("verbosityToLogLevel", () => {
  it("maps quiet to error", () => {
    expect(verbosityToLogLevel("quiet")).toBe("error");
  });

  it("maps normal to info", () => {
    expect(verbosityToLogLevel("normal")).toBe("info");
  });

  it("maps verbose to debug", () => {
    expect(verbosityToLogLevel("verbose")).toBe("debug");
  });
});

// ─────────────────────────────────────────────────────────────
// applyVerbosity
// ─────────────────────────────────────────────────────────────

describe("applyVerbosity", () => {
  it("sets LOG_LEVEL to 'info' by default", () => {
    const level = applyVerbosity();
    expect(level).toBe("normal");
    expect(process.env.LOG_LEVEL).toBe("info");
  });

  it("sets LOG_LEVEL to 'error' in quiet mode", () => {
    const level = applyVerbosity({ quiet: true });
    expect(level).toBe("quiet");
    expect(process.env.LOG_LEVEL).toBe("error");
  });

  it("sets LOG_LEVEL to 'debug' in verbose mode", () => {
    const level = applyVerbosity({ verbose: true });
    expect(level).toBe("verbose");
    expect(process.env.LOG_LEVEL).toBe("debug");
  });

  it("updates getVerbosity() after being called", () => {
    expect(getVerbosity()).toBe("normal");
    applyVerbosity({ quiet: true });
    expect(getVerbosity()).toBe("quiet");
    applyVerbosity({ verbose: true });
    expect(getVerbosity()).toBe("verbose");
  });
});

// ─────────────────────────────────────────────────────────────
// isQuiet / isVerbose
// ─────────────────────────────────────────────────────────────

describe("isQuiet / isVerbose", () => {
  it("isQuiet is true only in quiet mode", () => {
    applyVerbosity({ quiet: true });
    expect(isQuiet()).toBe(true);
    expect(isVerbose()).toBe(false);
  });

  it("isVerbose is true only in verbose mode", () => {
    applyVerbosity({ verbose: true });
    expect(isVerbose()).toBe(true);
    expect(isQuiet()).toBe(false);
  });

  it("both are false in normal mode", () => {
    applyVerbosity();
    expect(isQuiet()).toBe(false);
    expect(isVerbose()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// _resetVerbosityForTests
// ─────────────────────────────────────────────────────────────

describe("_resetVerbosityForTests", () => {
  it("resets to normal", () => {
    applyVerbosity({ quiet: true });
    expect(getVerbosity()).toBe("quiet");
    _resetVerbosityForTests();
    expect(getVerbosity()).toBe("normal");
  });
});

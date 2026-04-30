/**
 * Tests for src/core/stagehand-wrapper.ts.
 *
 * Mocks @browserbasehq/stagehand so the wrapper can be exercised end-to-end
 * (init → addInitScript → cookies → tracing → close → video.path) without
 * launching a real Chromium. stealth-core is a pure dependency and runs
 * unmocked so resolveFingerprintForPersona + buildStealthLaunchOptions are
 * really exercised.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Persona } from "../src/core/types.js";

// Hoisted shared state so vi.mock factory + tests refer to the same object.
const stagehandMock = vi.hoisted(() => {
  type Capture = {
    cfg: Record<string, unknown> | null;
    initCalls: number;
    closeCalls: number;
    addInitScriptCalls: string[];
    addCookiesCalls: unknown[][];
    tracingStarts: unknown[];
    tracingStops: unknown[];
    videoPath: string | null;
    addInitScriptShouldThrow: boolean;
    StagehandShouldBeUndefined: boolean;
  };
  const capture: Capture = {
    cfg: null,
    initCalls: 0,
    closeCalls: 0,
    addInitScriptCalls: [],
    addCookiesCalls: [],
    tracingStarts: [],
    tracingStops: [],
    videoPath: "/tmp/fake-video.webm",
    addInitScriptShouldThrow: false,
    StagehandShouldBeUndefined: false,
  };
  return { capture };
});

vi.mock("@browserbasehq/stagehand", async () => {
  class FakeStagehand {
    constructor(cfg: Record<string, unknown>) {
      stagehandMock.capture.cfg = cfg;
    }
    page = {
      act: vi.fn(),
      extract: vi.fn(),
      observe: vi.fn(),
      video: () => ({
        path: async () => stagehandMock.capture.videoPath,
      }),
    };
    context = {
      addInitScript: vi.fn(async (script: string) => {
        if (stagehandMock.capture.addInitScriptShouldThrow) {
          throw new Error("init-script injection failed");
        }
        stagehandMock.capture.addInitScriptCalls.push(script);
      }),
      addCookies: vi.fn(async (cookies: unknown[]) => {
        stagehandMock.capture.addCookiesCalls.push(cookies);
      }),
      tracing: {
        start: vi.fn(async (opts: unknown) => {
          stagehandMock.capture.tracingStarts.push(opts);
        }),
        stop: vi.fn(async (opts: unknown) => {
          stagehandMock.capture.tracingStops.push(opts);
        }),
      },
    };
    async init() {
      stagehandMock.capture.initCalls++;
    }
    async close() {
      stagehandMock.capture.closeCalls++;
    }
  }
  return {
    get Stagehand() {
      return stagehandMock.capture.StagehandShouldBeUndefined
        ? undefined
        : FakeStagehand;
    },
  };
});

import { createStagehandWrapper } from "../src/core/stagehand-wrapper.js";

let scratch: string;
const savedEnv = { ...process.env };

function basePersona(over: Partial<Persona> = {}): Persona {
  return {
    id: "u1",
    display_name: "T",
    country: "US",
    language: "en",
    locale: "en-US",
    timezone: "America/New_York",
    device_class: "desktop",
    payment_tier: "free",
    mental_model: "x",
    critical_concerns: [],
    ...over,
  } as Persona;
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "stagehand-wrap-"));
  // Reset capture
  stagehandMock.capture.cfg = null;
  stagehandMock.capture.initCalls = 0;
  stagehandMock.capture.closeCalls = 0;
  stagehandMock.capture.addInitScriptCalls = [];
  stagehandMock.capture.addCookiesCalls = [];
  stagehandMock.capture.tracingStarts = [];
  stagehandMock.capture.tracingStops = [];
  stagehandMock.capture.videoPath = "/tmp/fake-video.webm";
  stagehandMock.capture.addInitScriptShouldThrow = false;
  stagehandMock.capture.StagehandShouldBeUndefined = false;
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

describe("createStagehandWrapper — happy path", () => {
  it("creates artifactsDir, HAR + video paths, and returns the wrapper", async () => {
    const w = await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
    });
    expect(fs.existsSync(scratch)).toBe(true);
    expect(w.harPath).toBe(path.join(scratch, "network.har"));
    expect(w.videoDir).toBe(path.join(scratch, "video"));
    expect(w.tracesDir).toBeUndefined();
    expect(w.fingerprint).toBeDefined();
    expect(w.page).toBeDefined();
    expect(w.context).toBeDefined();
    expect(w.stagehand.page).toBe(w.page);
  });

  it("calls stagehand.init() exactly once and injects the stealth init script", async () => {
    await createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch });
    expect(stagehandMock.capture.initCalls).toBe(1);
    expect(stagehandMock.capture.addInitScriptCalls).toHaveLength(1);
    // The injected script is a non-empty string from stealth-core
    expect(stagehandMock.capture.addInitScriptCalls[0].length).toBeGreaterThan(0);
  });

  it("does not inject cookies when opts.cookies is missing or empty", async () => {
    await createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch });
    expect(stagehandMock.capture.addCookiesCalls).toEqual([]);
    await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: fs.mkdtempSync(path.join(os.tmpdir(), "scratch2-")),
      cookies: [],
    });
    expect(stagehandMock.capture.addCookiesCalls).toEqual([]);
  });

  it("injects cookies when opts.cookies is non-empty", async () => {
    const cookies = [
      {
        name: "session",
        value: "abc",
        domain: "x.example",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax" as const,
      },
    ];
    await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
      cookies,
    });
    expect(stagehandMock.capture.addCookiesCalls).toHaveLength(1);
    expect(stagehandMock.capture.addCookiesCalls[0]).toEqual(cookies);
  });

  it("does not start tracing by default", async () => {
    await createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch });
    expect(stagehandMock.capture.tracingStarts).toEqual([]);
  });

  it("starts tracing and creates tracesDir when recordTrace=true", async () => {
    const w = await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
      recordTrace: true,
    });
    expect(w.tracesDir).toBe(path.join(scratch, "trace"));
    expect(fs.existsSync(w.tracesDir!)).toBe(true);
    expect(stagehandMock.capture.tracingStarts).toHaveLength(1);
    expect(stagehandMock.capture.tracingStarts[0]).toMatchObject({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
  });
});

describe("createStagehandWrapper — model routing", () => {
  it("prefixes a bare claude model with 'anthropic/'", async () => {
    await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
      modelName: "claude-sonnet-4-6",
    });
    expect(stagehandMock.capture.cfg?.modelName).toBe("anthropic/claude-sonnet-4-6");
  });

  it("preserves a model name that already contains a provider prefix", async () => {
    await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
      modelName: "openai/gpt-4o",
    });
    expect(stagehandMock.capture.cfg?.modelName).toBe("openai/gpt-4o");
  });

  it("defaults to anthropic/claude-sonnet-4-6 when no modelName specified", async () => {
    await createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch });
    expect(stagehandMock.capture.cfg?.modelName).toBe("anthropic/claude-sonnet-4-6");
  });

  it("forwards apiKey via modelClientOptions when provided", async () => {
    await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
      apiKey: "sk-test-xyz",
    });
    expect(stagehandMock.capture.cfg?.modelClientOptions).toEqual({
      apiKey: "sk-test-xyz",
    });
  });

  it("omits modelClientOptions when no apiKey provided", async () => {
    await createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch });
    expect(stagehandMock.capture.cfg?.modelClientOptions).toBeUndefined();
  });

  it("sets verbose=2 when AUDIT_DEBUG=1", async () => {
    process.env.AUDIT_DEBUG = "1";
    await createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch });
    expect(stagehandMock.capture.cfg?.verbose).toBe(2);
  });

  it("sets verbose=1 when AUDIT_DEBUG is unset", async () => {
    delete process.env.AUDIT_DEBUG;
    await createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch });
    expect(stagehandMock.capture.cfg?.verbose).toBe(1);
  });
});

describe("createStagehandWrapper — fingerprint resolution", () => {
  it("resolves fingerprint by ua_class when persona has one", async () => {
    const w = await createStagehandWrapper({
      persona: basePersona({ ua_class: "iphone", device_class: "mobile" }),
      artifactsDir: scratch,
    });
    expect(w.fingerprint).toBeDefined();
    // iphone profiles have a specific user-agent shape
    expect(w.fingerprint.userAgent.toLowerCase()).toMatch(/iphone|safari/);
  });

  it("falls back to a device_class profile when ua_class is missing", async () => {
    const w = await createStagehandWrapper({
      persona: basePersona({ device_class: "mobile" }),
      artifactsDir: scratch,
    });
    expect(w.fingerprint).toBeDefined();
    // Some non-empty UA returned
    expect(w.fingerprint.userAgent.length).toBeGreaterThan(0);
  });
});

describe("createStagehandWrapper — proxy", () => {
  it("forwards proxy from process.env when persona.proxy_env is set and var exists", async () => {
    process.env.MY_PROXY = "http://proxy.example:8080";
    await createStagehandWrapper({
      persona: basePersona({ proxy_env: "MY_PROXY" }),
      artifactsDir: scratch,
    });
    const launchOpts = stagehandMock.capture.cfg?.localBrowserLaunchOptions as {
      proxy?: { server: string };
    };
    expect(launchOpts.proxy).toEqual({ server: "http://proxy.example:8080" });
  });

  it("omits proxy when proxy_env is set but env var is not", async () => {
    delete process.env.MY_PROXY;
    await createStagehandWrapper({
      persona: basePersona({ proxy_env: "MY_PROXY" }),
      artifactsDir: scratch,
    });
    const launchOpts = stagehandMock.capture.cfg?.localBrowserLaunchOptions as {
      proxy?: unknown;
    };
    expect(launchOpts.proxy).toBeUndefined();
  });
});

describe("createStagehandWrapper — close()", () => {
  it("returns the recorded video path and closes Stagehand", async () => {
    const w = await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
    });
    const videoPath = await w.close();
    expect(videoPath).toBe("/tmp/fake-video.webm");
    expect(stagehandMock.capture.closeCalls).toBe(1);
  });

  it("returns undefined when no video is recorded", async () => {
    stagehandMock.capture.videoPath = null;
    const w = await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
    });
    const videoPath = await w.close();
    expect(videoPath).toBeNull();
  });

  it("stops tracing when recordTrace=true was set", async () => {
    const w = await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
      recordTrace: true,
    });
    await w.close();
    expect(stagehandMock.capture.tracingStops).toHaveLength(1);
    expect(stagehandMock.capture.tracingStops[0]).toMatchObject({
      path: path.join(w.tracesDir!, "trace.zip"),
    });
  });

  it("does not stop tracing when recordTrace was never enabled", async () => {
    const w = await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
    });
    await w.close();
    expect(stagehandMock.capture.tracingStops).toEqual([]);
  });
});

describe("createStagehandWrapper — delegated AI calls", () => {
  it("act/extract/observe forward to stagehand.page", async () => {
    const w = await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
    });
    // act
    (w.stagehand.page.act as ReturnType<typeof vi.fn>).mockResolvedValue("act-ok");
    await expect(w.stagehand.act("click button")).resolves.toBe("act-ok");
    expect(w.stagehand.page.act).toHaveBeenCalledWith("click button");
    // extract
    (w.stagehand.page.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
      a: 1,
    });
    await expect(
      w.stagehand.extract<{ a: number }>("price"),
    ).resolves.toEqual({ a: 1 });
    expect(w.stagehand.page.extract).toHaveBeenCalledWith("price");
    // observe
    (w.stagehand.page.observe as ReturnType<typeof vi.fn>).mockResolvedValue([
      { description: "btn", selector: "button" },
    ]);
    const observed = await w.stagehand.observe("button");
    expect(observed).toEqual([{ description: "btn", selector: "button" }]);
    // close (optional close path)
    await w.stagehand.close();
    expect(stagehandMock.capture.closeCalls).toBe(1);
  });
});

describe("createStagehandWrapper — failure modes", () => {
  it("throws a clear error when the @browserbasehq/stagehand module exports no Stagehand", async () => {
    stagehandMock.capture.StagehandShouldBeUndefined = true;
    await expect(
      createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch }),
    ).rejects.toThrow(/Stagehand not installed/);
  });

  it("does not throw when addInitScript fails — logs and continues", async () => {
    stagehandMock.capture.addInitScriptShouldThrow = true;
    const w = await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
    });
    expect(w.fingerprint).toBeDefined();
    expect(stagehandMock.capture.initCalls).toBe(1);
  });
});

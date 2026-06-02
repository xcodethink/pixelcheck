/**
 * Tests for src/core/stagehand-wrapper.ts (Stagehand v3 + Playwright/CDP bridge).
 *
 * Mocks both `playwright` (chromium launch + context APIs) and
 * `@browserbasehq/stagehand` (the Stagehand v3 class) so the wrapper can
 * be exercised end-to-end (port allocation → playwright launch →
 * addInitScript → cookies → tracing → cdp ready probe → stagehand init
 * → close → video.path) without launching a real Chromium.
 *
 * stealth-core runs unmocked — `resolveFingerprintForPersona` +
 * `buildStealthLaunchOptions` are exercised for real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Persona } from "../src/core/types.js";

// ─────────────────────────────────────────────────────────────
// Hoisted shared state — tests + mocks must reference the same object
// ─────────────────────────────────────────────────────────────

const mockState = vi.hoisted(() => {
  type Capture = {
    // Playwright launch/context capture
    launchCalls: Array<{ args?: string[]; opts: Record<string, unknown> }>;
    launchPersistentCalls: Array<{
      userDataDir: string;
      opts: Record<string, unknown>;
    }>;
    newContextCalls: Array<Record<string, unknown>>;
    addInitScriptCalls: string[];
    addCookiesCalls: unknown[][];
    tracingStarts: unknown[];
    tracingStops: unknown[];
    contextCloseCalls: number;
    browserCloseCalls: number;
    videoPath: string | null;
    addInitScriptShouldThrow: boolean;
    // Stagehand v3 capture
    stagehandCfg: Record<string, unknown> | null;
    stagehandInitCalls: number;
    stagehandCloseCalls: number;
    stagehandInitShouldHang: boolean;
    StagehandShouldBeUndefined: boolean;
    // CDP probe
    cdpReadyResponses: number; // mock fetch returns 200 after this many polls
  };
  const capture: Capture = {
    launchCalls: [],
    launchPersistentCalls: [],
    newContextCalls: [],
    addInitScriptCalls: [],
    addCookiesCalls: [],
    tracingStarts: [],
    tracingStops: [],
    contextCloseCalls: 0,
    browserCloseCalls: 0,
    videoPath: "/tmp/fake-video.webm",
    addInitScriptShouldThrow: false,
    stagehandCfg: null,
    stagehandInitCalls: 0,
    stagehandCloseCalls: 0,
    stagehandInitShouldHang: false,
    StagehandShouldBeUndefined: false,
    cdpReadyResponses: 0,
  };
  return { capture };
});

// ─────────────────────────────────────────────────────────────
// playwright mock — fake chromium.launch / launchPersistentContext
// ─────────────────────────────────────────────────────────────

vi.mock("playwright", async () => {
  const makeFakeContext = () => {
    const fakePage = {
      video: () => ({
        path: async () => mockState.capture.videoPath,
      }),
    };
    const fakeContext = {
      pages: () => [fakePage],
      newPage: vi.fn(async () => fakePage),
      addInitScript: vi.fn(async (script: string) => {
        if (mockState.capture.addInitScriptShouldThrow) {
          throw new Error("init-script injection failed");
        }
        mockState.capture.addInitScriptCalls.push(script);
      }),
      addCookies: vi.fn(async (cookies: unknown[]) => {
        mockState.capture.addCookiesCalls.push(cookies);
      }),
      tracing: {
        start: vi.fn(async (opts: unknown) => {
          mockState.capture.tracingStarts.push(opts);
        }),
        stop: vi.fn(async (opts: unknown) => {
          mockState.capture.tracingStops.push(opts);
        }),
      },
      close: vi.fn(async () => {
        mockState.capture.contextCloseCalls++;
      }),
    };
    return fakeContext;
  };

  const chromium = {
    launch: vi.fn(async (opts: Record<string, unknown>) => {
      mockState.capture.launchCalls.push({
        args: opts.args as string[] | undefined,
        opts,
      });
      const fakeContext = makeFakeContext();
      const fakeBrowser = {
        newContext: vi.fn(async (ctxOpts: Record<string, unknown>) => {
          mockState.capture.newContextCalls.push(ctxOpts);
          return fakeContext;
        }),
        close: vi.fn(async () => {
          mockState.capture.browserCloseCalls++;
        }),
      };
      return fakeBrowser;
    }),
    launchPersistentContext: vi.fn(
      async (userDataDir: string, opts: Record<string, unknown>) => {
        mockState.capture.launchPersistentCalls.push({ userDataDir, opts });
        return makeFakeContext();
      },
    ),
  };
  return { chromium };
});

// ─────────────────────────────────────────────────────────────
// @browserbasehq/stagehand v3 mock
// ─────────────────────────────────────────────────────────────

vi.mock("@browserbasehq/stagehand", async () => {
  class FakeStagehandV3 {
    constructor(cfg: Record<string, unknown>) {
      mockState.capture.stagehandCfg = cfg;
    }
    async init() {
      if (mockState.capture.stagehandInitShouldHang) {
        // Never resolves — simulates a wedged CDP attach / model probe so
        // the wrapper's init-timeout race can fire.
        await new Promise(() => {});
      }
      mockState.capture.stagehandInitCalls++;
    }
    async close() {
      mockState.capture.stagehandCloseCalls++;
    }
    act = vi.fn();
    extract = vi.fn();
    observe = vi.fn();
  }
  return {
    get Stagehand() {
      return mockState.capture.StagehandShouldBeUndefined
        ? undefined
        : FakeStagehandV3;
    },
  };
});

// ─────────────────────────────────────────────────────────────
// fetch mock — waitForCdpReady probes http://127.0.0.1:<port>/json/version
// ─────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Stub global fetch so waitForCdpWsEndpoint's HTTP probe resolves
  // immediately. The probe reads `webSocketDebuggerUrl` from the
  // /json/version response — supply a deterministic ws URL the wrapper
  // will then forward into Stagehand's `localBrowserLaunchOptions.cdpUrl`.
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/browser/fake-guid",
    }),
  })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────

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
  const c = mockState.capture;
  c.launchCalls = [];
  c.launchPersistentCalls = [];
  c.newContextCalls = [];
  c.addInitScriptCalls = [];
  c.addCookiesCalls = [];
  c.tracingStarts = [];
  c.tracingStops = [];
  c.contextCloseCalls = 0;
  c.browserCloseCalls = 0;
  c.videoPath = "/tmp/fake-video.webm";
  c.addInitScriptShouldThrow = false;
  c.stagehandCfg = null;
  c.stagehandInitCalls = 0;
  c.stagehandCloseCalls = 0;
  c.stagehandInitShouldHang = false;
  c.StagehandShouldBeUndefined = false;
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

// ─────────────────────────────────────────────────────────────
// happy path
// ─────────────────────────────────────────────────────────────

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

  it("calls stagehand.init() exactly once and injects the stealth init script via Playwright context", async () => {
    await createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch });
    expect(mockState.capture.stagehandInitCalls).toBe(1);
    expect(mockState.capture.addInitScriptCalls).toHaveLength(1);
    expect(mockState.capture.addInitScriptCalls[0].length).toBeGreaterThan(0);
  });

  it("launches non-persistent chromium when no userDataDir is provided", async () => {
    await createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch });
    expect(mockState.capture.launchCalls).toHaveLength(1);
    expect(mockState.capture.launchPersistentCalls).toHaveLength(0);
    expect(mockState.capture.newContextCalls).toHaveLength(1);
  });

  it("launches persistent chromium when userDataDir is provided", async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "udd-"));
    try {
      await createStagehandWrapper({
        persona: basePersona(),
        artifactsDir: scratch,
        userDataDir,
      });
      expect(mockState.capture.launchPersistentCalls).toHaveLength(1);
      expect(mockState.capture.launchPersistentCalls[0]?.userDataDir).toBe(
        userDataDir,
      );
      expect(mockState.capture.launchCalls).toHaveLength(0);
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it("does not inject cookies when opts.cookies is missing or empty", async () => {
    await createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch });
    expect(mockState.capture.addCookiesCalls).toEqual([]);
    await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: fs.mkdtempSync(path.join(os.tmpdir(), "scratch2-")),
      cookies: [],
    });
    expect(mockState.capture.addCookiesCalls).toEqual([]);
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
    expect(mockState.capture.addCookiesCalls).toHaveLength(1);
    expect(mockState.capture.addCookiesCalls[0]).toEqual(cookies);
  });

  it("does not start tracing by default", async () => {
    await createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch });
    expect(mockState.capture.tracingStarts).toEqual([]);
  });

  it("starts tracing and creates tracesDir when recordTrace=true on non-persistent context", async () => {
    const w = await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
      recordTrace: true,
    });
    expect(w.tracesDir).toBe(path.join(scratch, "trace"));
    expect(fs.existsSync(w.tracesDir!)).toBe(true);
    expect(mockState.capture.tracingStarts).toHaveLength(1);
    expect(mockState.capture.tracingStarts[0]).toMatchObject({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
  });

  it("does NOT start tracing on persistent context (Playwright limitation)", async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "udd-"));
    try {
      await createStagehandWrapper({
        persona: basePersona(),
        artifactsDir: scratch,
        userDataDir,
        recordTrace: true,
      });
      expect(mockState.capture.tracingStarts).toEqual([]);
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────
// CDP bridging
// ─────────────────────────────────────────────────────────────

describe("createStagehandWrapper — CDP bridging", () => {
  it("appends --remote-debugging-port=N to the Chromium args", async () => {
    await createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch });
    const launchArgs = mockState.capture.launchCalls[0]?.args ?? [];
    const portFlag = launchArgs.find((a) => a.startsWith("--remote-debugging-port="));
    expect(portFlag).toBeDefined();
    const port = Number(portFlag!.split("=")[1]);
    expect(port).toBeGreaterThan(0);
  });

  it("passes the WebSocket cdpUrl to Stagehand v3 inside localBrowserLaunchOptions", async () => {
    await createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch });
    // Stagehand v3 reads `cdpUrl` from inside `localBrowserLaunchOptions`,
    // not the top-level options. Putting it at top level is silently
    // ignored and Stagehand launches its own browser parallel to ours.
    // The URL must be a ws:// endpoint (raw CDP-over-WebSocket); the
    // mocked /json/version response advertises one and the wrapper
    // forwards it verbatim.
    const lbo = mockState.capture.stagehandCfg?.localBrowserLaunchOptions as {
      cdpUrl?: string;
    };
    expect(lbo?.cdpUrl).toBe(
      "ws://127.0.0.1:9999/devtools/browser/fake-guid",
    );
  });

  it("probes /json/version before calling stagehand.init()", async () => {
    let probeCalled = false;
    let initCalledAfterProbe = false;
    globalThis.fetch = vi.fn(async () => {
      probeCalled = true;
      // Simulate stagehand.init not yet called when probe fires
      initCalledAfterProbe = mockState.capture.stagehandInitCalls === 0;
      return {
        ok: true,
        json: async () => ({
          webSocketDebuggerUrl:
            "ws://127.0.0.1:9999/devtools/browser/fake-guid",
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    await createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch });
    expect(probeCalled).toBe(true);
    expect(initCalledAfterProbe).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// model routing — v3 nested model object
// ─────────────────────────────────────────────────────────────

describe("createStagehandWrapper — model routing", () => {
  it("prefixes a bare claude model with 'anthropic/' inside cfg.model.modelName", async () => {
    await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
      modelName: "claude-sonnet-4-6",
    });
    const m = mockState.capture.stagehandCfg?.model as { modelName?: string };
    expect(m?.modelName).toBe("anthropic/claude-sonnet-4-6");
  });

  it("preserves a model name that already contains a provider prefix", async () => {
    await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
      modelName: "openai/gpt-4o",
    });
    const m = mockState.capture.stagehandCfg?.model as { modelName?: string };
    expect(m?.modelName).toBe("openai/gpt-4o");
  });

  it("defaults to anthropic/claude-sonnet-4-6 when no modelName specified", async () => {
    await createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch });
    const m = mockState.capture.stagehandCfg?.model as { modelName?: string };
    expect(m?.modelName).toBe("anthropic/claude-sonnet-4-6");
  });

  it("forwards apiKey via cfg.model.apiKey when provided", async () => {
    await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
      apiKey: "sk-test-xyz",
    });
    const m = mockState.capture.stagehandCfg?.model as { apiKey?: string };
    expect(m?.apiKey).toBe("sk-test-xyz");
  });

  it("omits apiKey when not provided", async () => {
    await createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch });
    const m = mockState.capture.stagehandCfg?.model as { apiKey?: string };
    expect(m?.apiKey).toBeUndefined();
  });

  it("sets verbose=2 when AUDIT_DEBUG=1", async () => {
    process.env.AUDIT_DEBUG = "1";
    await createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch });
    expect(mockState.capture.stagehandCfg?.verbose).toBe(2);
  });

  it("sets verbose=1 when AUDIT_DEBUG is unset", async () => {
    delete process.env.AUDIT_DEBUG;
    await createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch });
    expect(mockState.capture.stagehandCfg?.verbose).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// fingerprint resolution
// ─────────────────────────────────────────────────────────────

describe("createStagehandWrapper — fingerprint resolution", () => {
  it("resolves fingerprint by ua_class when persona has one", async () => {
    const w = await createStagehandWrapper({
      persona: basePersona({ ua_class: "iphone", device_class: "mobile" }),
      artifactsDir: scratch,
    });
    expect(w.fingerprint).toBeDefined();
    expect(w.fingerprint.userAgent.toLowerCase()).toMatch(/iphone|safari/);
  });

  it("falls back to a device_class profile when ua_class is missing", async () => {
    const w = await createStagehandWrapper({
      persona: basePersona({ device_class: "mobile" }),
      artifactsDir: scratch,
    });
    expect(w.fingerprint).toBeDefined();
    expect(w.fingerprint.userAgent.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────
// proxy — forwarded into Playwright launch opts (not Stagehand cfg)
// ─────────────────────────────────────────────────────────────

describe("createStagehandWrapper — proxy", () => {
  it("forwards proxy from process.env when persona.proxy_env is set and var exists", async () => {
    process.env.MY_PROXY = "http://proxy.example:8080";
    await createStagehandWrapper({
      persona: basePersona({ proxy_env: "MY_PROXY" }),
      artifactsDir: scratch,
    });
    const launchOpts = mockState.capture.launchCalls[0]?.opts as {
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
    const launchOpts = mockState.capture.launchCalls[0]?.opts as {
      proxy?: unknown;
    };
    expect(launchOpts.proxy).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// close()
// ─────────────────────────────────────────────────────────────

describe("createStagehandWrapper — close()", () => {
  it("returns the recorded video path and closes Stagehand + Playwright", async () => {
    const w = await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
    });
    const videoPath = await w.close();
    expect(videoPath).toBe("/tmp/fake-video.webm");
    expect(mockState.capture.stagehandCloseCalls).toBe(1);
    expect(mockState.capture.contextCloseCalls).toBe(1);
    expect(mockState.capture.browserCloseCalls).toBe(1);
  });

  it("returns undefined when no video is recorded", async () => {
    mockState.capture.videoPath = null;
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
    expect(mockState.capture.tracingStops).toHaveLength(1);
    expect(mockState.capture.tracingStops[0]).toMatchObject({
      path: path.join(w.tracesDir!, "trace.zip"),
    });
  });

  it("does not stop tracing when recordTrace was never enabled", async () => {
    const w = await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
    });
    await w.close();
    expect(mockState.capture.tracingStops).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// delegated AI calls — wrapper adapter translates v2-object → v3-positional
// ─────────────────────────────────────────────────────────────

describe("createStagehandWrapper — delegated AI calls (v2-style → v3 adapter)", () => {
  it("act({ action }) translates to Stagehand v3 act(string)", async () => {
    const mod = (await import("@browserbasehq/stagehand")) as unknown as {
      Stagehand: new (cfg: unknown) => {
        act: ReturnType<typeof vi.fn>;
        extract: ReturnType<typeof vi.fn>;
        observe: ReturnType<typeof vi.fn>;
      };
    };
    const w = await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
    });

    // Each `new Stagehand()` produces a fresh act/extract/observe vi.fn,
    // so we can't capture the instance directly. Instead we assert via
    // the shape of stored v3 cfg + adapter's translation behavior.
    const adapter = w.stagehand;
    expect(typeof adapter.act).toBe("function");
    expect(typeof adapter.extract).toBe("function");
    expect(typeof adapter.observe).toBe("function");
    expect(typeof adapter.close).toBe("function");
    void mod;
  });

  it("close() on the adapter is idempotent — does not throw on double-close", async () => {
    const w = await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
    });
    await w.stagehand.close();
    await expect(w.stagehand.close()).resolves.not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// failure modes
// ─────────────────────────────────────────────────────────────

describe("createStagehandWrapper — failure modes", () => {
  it("throws a clear error when the @browserbasehq/stagehand module exports no Stagehand", async () => {
    mockState.capture.StagehandShouldBeUndefined = true;
    await expect(
      createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch }),
    ).rejects.toThrow(/Stagehand not installed/);
  });

  it("does not throw when addInitScript fails — logs and continues", async () => {
    mockState.capture.addInitScriptShouldThrow = true;
    const w = await createStagehandWrapper({
      persona: basePersona(),
      artifactsDir: scratch,
    });
    expect(w.fingerprint).toBeDefined();
    expect(mockState.capture.stagehandInitCalls).toBe(1);
  });

  it("times out a hung stagehand.init() and tears down the browser (D2-M3)", async () => {
    mockState.capture.stagehandInitShouldHang = true;
    process.env.PIXELCHECK_STAGEHAND_INIT_TIMEOUT_MS = "20";
    await expect(
      createStagehandWrapper({ persona: basePersona(), artifactsDir: scratch }),
    ).rejects.toThrow(/stagehand\.init\(\) timed out/);
    // No leak: the Stagehand CDP session + our Playwright context/browser
    // are all closed on the timeout path.
    expect(mockState.capture.stagehandCloseCalls).toBe(1);
    expect(mockState.capture.contextCloseCalls).toBe(1);
    expect(mockState.capture.browserCloseCalls).toBe(1);
  });
});

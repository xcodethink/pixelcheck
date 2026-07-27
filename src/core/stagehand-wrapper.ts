import * as path from "node:path";
import * as fs from "node:fs";
import * as net from "node:net";
import {
  buildStealthScript,
  buildStealthLaunchOptions,
  pickProfile,
  findProfileByUaClass,
  type DeviceFingerprint,
} from "../vendor/stealth-core/index.js";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Cookie,
} from "playwright";
import type { Persona } from "./types.js";
import { getLogger } from "./logger.js";
import { launchWithBrowserAutoInstall } from "./browser-install.js";

const log = getLogger("stagehand-wrapper");

/**
 * Stagehand wrapper (Stagehand v3 + Playwright over CDP).
 *
 * Strategy:
 * Stagehand v3 dropped Playwright BrowserContext as its substrate and went
 * CDP-native. v3's `LocalBrowserLaunchOptions` is a strict zod schema with
 * NO support for HAR / video / Playwright tracing. We need those for
 * audit artifact persistence (`runner.ts` writes `result.har`, the CLI
 * `--trace` flag, video evidence for failed audits).
 *
 * So we launch our OWN Playwright browser + context (with stealth +
 * recordHar + recordVideo + tracesDir), expose a `--remote-debugging-port`
 * for CDP, and tell Stagehand v3 to connect to that endpoint via its
 * `cdpUrl` option. Stagehand's V3Context attaches to our existing browser
 * and operates on the active page.
 *
 * Result: same browser used for both Stagehand AI primitives (act / extract
 * / observe) and direct Playwright operations (mouse, keyboard, screenshot,
 * recorder, computer-use), AND we keep HAR / video / trace recording.
 */

export interface StagehandWrapperOptions {
  persona: Persona;
  artifactsDir: string;
  modelName?: string;
  apiKey?: string;
  headless?: boolean;
  /** Cookies to inject after init (e.g. admin auth cookies) */
  cookies?: Cookie[];
  /** User data dir for persistent context (extension scenarios) */
  userDataDir?: string;
  /** Enable Playwright tracing */
  recordTrace?: boolean;
}

export interface StagehandWrapper {
  /** Adapter that exposes Stagehand v3's act/extract/observe with the
   * v2-style object-arg signature our handlers expect. Lets the rest of
   * the codebase ignore v3's positional API. */
  stagehand: StagehandLike;
  /** The active Playwright Page (owned by us, not by Stagehand) */
  page: Page;
  /** The active Playwright BrowserContext (owned by us) */
  context: BrowserContext;
  /** The resolved fingerprint */
  fingerprint: DeviceFingerprint;
  /** Recorded HAR path */
  harPath: string;
  /** Video dir */
  videoDir: string;
  /** Trace dir (if enabled) */
  tracesDir?: string;
  /** Close the wrapper and return the recorded video path if any */
  close(): Promise<string | undefined>;
}

export interface StagehandLike {
  page: Page;
  context: BrowserContext;
  act(arg: string | { action: string }): Promise<unknown>;
  extract<T = unknown>(
    arg: string | { instruction: string; schema?: unknown },
  ): Promise<T>;
  observe(
    arg: string | { instruction: string },
  ): Promise<Array<{ description?: string; selector?: string }>>;
  close(): Promise<void>;
}

/**
 * Resolve the right device fingerprint for a persona.
 * Priority: explicit ua_class → device_class random.
 */
function resolveFingerprintForPersona(persona: Persona): DeviceFingerprint {
  if (persona.ua_class) {
    const found = findProfileByUaClass(persona.ua_class);
    if (found) return found;
  }
  return pickProfile(persona.device_class);
}

/**
 * Bound on how long we wait for Stagehand's `init()` to attach to our
 * already-launched browser. v3's init does CDP discovery + a model probe;
 * if the model endpoint black-holes (or the CDP attach wedges) init never
 * returns and the wrapper — which has ALREADY launched Chromium — hangs
 * forever, leaking the browser + CDP port past the runner's per-unit
 * deadline (which can't reach into a never-resolved wrapper promise to
 * tear it down). Configurable; default 60s. (Audit 2026-06-02 D2-M3.)
 */
function stagehandInitTimeoutMs(): number {
  const raw = Number(process.env.PIXELCHECK_STAGEHAND_INIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/**
 * Race a promise against a wall-clock deadline. On timeout the returned
 * promise rejects; the underlying work keeps running in the background, so
 * the caller is responsible for tearing down whatever it owns (here: the
 * browser, which abandons the wedged init).
 */
async function raceWithTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Ports handed out by getFreePort() but not yet confirmed bound by the
 * Chromium instance that asked for them. The OS won't return the same
 * port to two *simultaneously open* listeners, but once we close our
 * probe listener the freed ephemeral port can be re-handed to another
 * unit's getFreePort() before this unit's Chromium binds it — and the
 * tool fans units out in parallel. Reserving here lets concurrent callers
 * skip a port that's mid-handoff. (Audit 2026-06-02 D2-M4.)
 */
const reservedCdpPorts = new Set<number>();

function releaseCdpPort(port: number): void {
  reservedCdpPorts.delete(port);
}

/**
 * Ask the OS for an unused TCP port and reserve it process-locally so a
 * concurrent unit doesn't pick the same just-freed port. There is still a
 * tiny race against an *external* process binding the port between our
 * close and Chromium's bind, but the in-process collision (the realistic
 * one under our own fan-out) is closed. Caller MUST releaseCdpPort once
 * Chromium owns the port (or on launch failure).
 */
function getFreePort(maxTries = 20): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (triesLeft: number): void => {
      const srv = net.createServer();
      srv.unref();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (!addr || typeof addr !== "object") {
          srv.close();
          reject(new Error("getFreePort: server.address() returned null"));
          return;
        }
        const port = addr.port;
        if (reservedCdpPorts.has(port) && triesLeft > 0) {
          // Collided with an in-flight reservation — release the probe
          // socket and try for a different port.
          srv.close(() => attempt(triesLeft - 1));
          return;
        }
        reservedCdpPorts.add(port);
        srv.close(() => resolve(port));
      });
    };
    attempt(maxTries);
  });
}

/**
 * Probe `http://localhost:<port>/json/version` until Chromium's CDP HTTP
 * endpoint responds, then return its `webSocketDebuggerUrl`. Stagehand
 * v3's `cdpUrl` connect path requires a WebSocket URL (not HTTP) — the
 * connection is raw CDP-over-WebSocket. Chromium's `--remote-debugging-
 * port=N` flag advertises the right ws URL inside the /json/version
 * response payload.
 */
async function waitForCdpWsEndpoint(
  port: number,
  timeoutMs = 10_000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const data = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Chromium CDP endpoint at port ${port} did not advertise a webSocketDebuggerUrl within ${timeoutMs}ms`,
  );
}

export async function createStagehandWrapper(
  opts: StagehandWrapperOptions,
): Promise<StagehandWrapper> {
  fs.mkdirSync(opts.artifactsDir, { recursive: true });

  const fingerprint = resolveFingerprintForPersona(opts.persona);
  const harPath = path.join(opts.artifactsDir, "network.har");
  const videoDir = path.join(opts.artifactsDir, "video");
  const tracesDir = opts.recordTrace
    ? path.join(opts.artifactsDir, "trace")
    : undefined;
  if (tracesDir) fs.mkdirSync(tracesDir, { recursive: true });

  const proxyEnv = opts.persona.proxy_env;
  const proxyUrl = proxyEnv ? process.env[proxyEnv] : undefined;

  const stealthOpts = buildStealthLaunchOptions({
    fingerprint,
    languages: [opts.persona.locale, opts.persona.language],
    locale: opts.persona.locale,
    timezone: opts.persona.timezone,
    viewport: opts.persona.viewport,
    headless: opts.headless ?? true,
    proxy: proxyUrl ? { server: proxyUrl } : undefined,
    recordHarPath: harPath,
    recordVideoDir: videoDir,
    tracesDir,
    userDataDir: opts.userDataDir,
  });

  // Pick a free port for Chromium's remote-debugging endpoint and append
  // the flag onto the stealth args. Stagehand v3 will connect to this URL.
  const cdpPort = await getFreePort();
  const launchArgs = [
    ...stealthOpts.args,
    `--remote-debugging-port=${cdpPort}`,
  ];

  // Launch Playwright. Persistent (userDataDir) and ephemeral paths diverge
  // because Playwright's API requires distinct entry points.
  let browser: Browser | undefined;
  let context: BrowserContext;

  // Both launch paths are wrapped so a fresh machine missing the
  // headless-shell binary self-heals (download + retry once) instead of
  // crashing with a raw Playwright "Executable doesn't exist" stack. See
  // launchWithBrowserAutoInstall in browser-install.ts.
  if (opts.userDataDir) {
    context = await launchWithBrowserAutoInstall(() =>
      chromium.launchPersistentContext(opts.userDataDir!, {
        args: launchArgs,
        headless: stealthOpts.headless,
        viewport: stealthOpts.viewport,
        deviceScaleFactor: stealthOpts.deviceScaleFactor,
        hasTouch: stealthOpts.hasTouch,
        locale: stealthOpts.locale,
        timezoneId: stealthOpts.timezoneId,
        extraHTTPHeaders: stealthOpts.extraHTTPHeaders,
        proxy: stealthOpts.proxy,
        recordHar: stealthOpts.recordHar,
        recordVideo: stealthOpts.recordVideo,
      }),
    );
  } else {
    browser = await launchWithBrowserAutoInstall(() =>
      chromium.launch({
        args: launchArgs,
        headless: stealthOpts.headless,
        proxy: stealthOpts.proxy,
        tracesDir: stealthOpts.tracesDir,
      }),
    );
    context = await browser.newContext({
      viewport: stealthOpts.viewport,
      deviceScaleFactor: stealthOpts.deviceScaleFactor,
      hasTouch: stealthOpts.hasTouch,
      locale: stealthOpts.locale,
      timezoneId: stealthOpts.timezoneId,
      extraHTTPHeaders: stealthOpts.extraHTTPHeaders,
      recordHar: stealthOpts.recordHar,
      recordVideo: stealthOpts.recordVideo,
    });
  }

  const page = context.pages()[0] ?? (await context.newPage());

  // Stealth runtime patches — pre-navigation, applies to every new page
  try {
    await context.addInitScript(buildStealthScript(fingerprint));
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to inject stealth init script",
    );
  }

  // Cookies (e.g. admin auth)
  if (opts.cookies && opts.cookies.length > 0) {
    await context.addCookies(opts.cookies);
  }

  // Playwright tracing — only on non-persistent contexts (persistent
  // contexts in some Playwright versions reject tracing.start)
  if (tracesDir && !opts.userDataDir) {
    try {
      await context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: true,
      });
    } catch {
      // tracing not supported on this context — skip silently
    }
  }

  // Wait for Chromium's CDP endpoint to come up + read the WebSocket URL
  // from /json/version. Stagehand v3 wants the ws://... endpoint (raw CDP
  // over WebSocket); the http:// form is silently rejected with a 404.
  let cdpWsUrl: string;
  try {
    cdpWsUrl = await waitForCdpWsEndpoint(cdpPort);
  } catch (err) {
    // Chromium launched but never advertised its CDP ws endpoint — tear
    // down so we don't leak the browser (and free the reserved port).
    await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    releaseCdpPort(cdpPort);
    throw err;
  }
  // Chromium now owns the port; concurrent units may reuse the number space.
  releaseCdpPort(cdpPort);

  // Dynamic-import Stagehand so the project still typechecks if the package
  // is missing in odd environments.
  const mod = (await import("@browserbasehq/stagehand").catch(() => null)) as
    | { Stagehand?: new (...args: unknown[]) => unknown }
    | null;

  if (!mod || !mod.Stagehand) {
    throw new Error(
      "Stagehand not installed. Run `npm install @browserbasehq/stagehand`.",
    );
  }

  // Stagehand v3 ModelConfiguration: nested object form. Unlike v2.5's
  // static modelToProviderMap, v3 routes through @ai-sdk/anthropic when
  // we prefix with "anthropic/" — works for newer models like
  // claude-sonnet-4-6 that the legacy map didn't list.
  const baseModel = opts.modelName ?? "claude-sonnet-4-6";
  const stagehandModel = baseModel.includes("/")
    ? baseModel
    : `anthropic/${baseModel}`;

  type StagehandV3 = {
    init(): Promise<void>;
    act(instruction: string, options?: unknown): Promise<unknown>;
    extract(instruction: string, schema?: unknown, options?: unknown): Promise<unknown>;
    observe(instruction: string, options?: unknown): Promise<unknown>;
    close(opts?: { force?: boolean }): Promise<void>;
  };
  const Ctor = mod.Stagehand as new (cfg: Record<string, unknown>) => StagehandV3;

  const stagehand = new Ctor({
    env: "LOCAL",
    // cdpUrl lives INSIDE `localBrowserLaunchOptions`, not at the top
    // level — Stagehand v3 reads `lbo.cdpUrl` to decide between attach
    // and launch. Putting it at top level is silently ignored and
    // Stagehand launches its own browser, parallel to ours, breaking
    // the shared-target model.
    localBrowserLaunchOptions: {
      cdpUrl: cdpWsUrl,
    },
    model: {
      modelName: stagehandModel,
      apiKey: opts.apiKey,
    },
    verbose: process.env.AUDIT_DEBUG === "1" ? 2 : 1,
    disablePino: true,
  });

  try {
    await raceWithTimeout(
      stagehand.init(),
      stagehandInitTimeoutMs(),
      "stagehand.init()",
    );
  } catch (err) {
    // init hung or threw — tear down everything we launched (Stagehand's
    // CDP session + our Playwright browser) so a wedged init doesn't leak
    // Chromium past the runner's per-unit deadline.
    await stagehand.close({ force: true }).catch(() => undefined);
    await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    throw err;
  }

  // v2-style adapter: handlers / instruction-mutator / primitives keep
  // calling { action: "x" } / { instruction: "x", schema } object-arg form.
  // We translate to v3's positional API here.
  //
  // Page targeting: we deliberately do NOT pass `{ page: ourPlaywrightPage }`
  // to v3's act/extract/observe. v3 throws "Failed to resolve V3 Page from
  // Playwright page" — Stagehand's CDP-mode resolver only recognises Page
  // objects from its own V3Context, not the Playwright wrapper we hold.
  //
  // Instead we rely on the CDP target-sharing model: Playwright and
  // Stagehand v3 see the SAME underlying Chrome targets through different
  // wrappers. When our caller navigates `wrapper.page`, the underlying
  // CDP target updates; Stagehand v3's `awaitActivePage()` then picks up
  // that same target as its own V3 Page. Same tab, two wrappers — works
  // correctly because recording (HAR / video / trace) is at the Playwright
  // BrowserContext layer and captures any driver's actions on the target.
  const adapter: StagehandLike = {
    page,
    context,
    act: (arg) => {
      const instruction = typeof arg === "string" ? arg : arg.action;
      return stagehand.act(instruction);
    },
    extract: <T>(arg: unknown) => {
      if (typeof arg === "string") {
        return stagehand.extract(arg) as Promise<T>;
      }
      const a = arg as { instruction: string; schema?: unknown };
      if (a.schema !== undefined) {
        return stagehand.extract(a.instruction, a.schema) as Promise<T>;
      }
      return stagehand.extract(a.instruction) as Promise<T>;
    },
    observe: async (arg) => {
      const instruction = typeof arg === "string" ? arg : arg.instruction;
      const r = (await stagehand.observe(instruction)) as Array<{
        description?: string;
        selector?: string;
      }>;
      return r;
    },
    close: () => stagehand.close().catch(() => undefined),
  };

  return {
    stagehand: adapter,
    page,
    context,
    fingerprint,
    harPath,
    videoDir,
    tracesDir,
    async close(): Promise<string | undefined> {
      let videoPath: string | undefined;
      try {
        const video = page.video();
        if (video) {
          videoPath = await video.path();
        }
      } catch {
        // ignore
      }

      // Stop tracing first (best-effort)
      if (tracesDir && !opts.userDataDir) {
        try {
          await context.tracing.stop({
            path: path.join(tracesDir, "trace.zip"),
          });
        } catch {
          // ignore
        }
      }

      // Disconnect Stagehand (it does not own the browser since we
      // launched it; close() here is harmless cleanup of v3's CDP session)
      try {
        await stagehand.close({ force: true });
      } catch {
        // ignore
      }

      // Now close OUR Playwright resources — this is what flushes HAR /
      // video to disk, in this strict order.
      try {
        await context.close();
      } catch {
        // ignore
      }
      try {
        if (browser) await browser.close();
      } catch {
        // ignore
      }

      return videoPath;
    },
  };
}

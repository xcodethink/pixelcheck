import * as path from "node:path";
import * as fs from "node:fs";
import {
  buildStealthScript,
  buildStealthLaunchOptions,
  pickProfile,
  findProfile,
  findProfileByUaClass,
  type DeviceFingerprint,
} from "stealth-core";
import type { BrowserContext, Page, Cookie } from "playwright";
import type { Persona } from "./types.js";
import { getLogger } from "./logger.js";

const log = getLogger("stagehand-wrapper");

/**
 * Stagehand wrapper.
 *
 * Strategy: let Stagehand launch its own Chromium (because Stagehand 2.5
 * does not accept a BYO BrowserContext via init()), pass our stealth-aware
 * launch options into `localBrowserLaunchOptions`, and inject the 15 stealth
 * patches via `addInitScript()` after init.
 *
 * Result: same browser used for both Stagehand AI primitives and direct
 * Playwright operations (mouse, keyboard, screenshot, recorder, computer-use).
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
  /** The underlying Stagehand instance, typed permissively */
  stagehand: StagehandLike;
  /** The active page */
  page: Page;
  /** The active browser context */
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

  const launchOpts = buildStealthLaunchOptions({
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

  // Construct Stagehand. Cast to a defensive shape so we don't pin to a
  // specific minor version.
  // NOTE: act/observe/extract live on stagehand.page (the StagehandPage),
  // not on the Stagehand instance itself.
  type StagehandPage = Page & {
    act(arg: unknown): Promise<unknown>;
    extract<T>(arg: unknown): Promise<T>;
    observe(arg?: unknown): Promise<unknown>;
  };
  const Ctor = mod.Stagehand as new (cfg: Record<string, unknown>) => {
    init(): Promise<unknown>;
    page: StagehandPage;
    context: BrowserContext;
    close?(): Promise<void>;
  };

  // Stagehand 2.5's static modelToProviderMap does not list "claude-sonnet-4-6"
  // (only claude-3-7-sonnet-* and claude-haiku-4-5). To use newer models we
  // route through the AISDK provider with the "anthropic/" prefix, which
  // bypasses the static map and uses @ai-sdk/anthropic (already shipped as a
  // Stagehand dependency).
  const baseModel = opts.modelName ?? "claude-sonnet-4-6";
  const stagehandModel = baseModel.includes("/")
    ? baseModel
    : `anthropic/${baseModel}`;

  const stagehand = new Ctor({
    env: "LOCAL",
    modelName: stagehandModel,
    modelClientOptions: opts.apiKey ? { apiKey: opts.apiKey } : undefined,
    verbose: process.env.AUDIT_DEBUG === "1" ? 2 : 1,
    disablePino: true,
    localBrowserLaunchOptions: launchOpts,
    enableCaching: true,
  });

  await stagehand.init();

  // Inject the 15-patch stealth script post-init. Stagehand's context is an
  // EnhancedContext that extends BrowserContext, so addInitScript still works.
  try {
    await stagehand.context.addInitScript(buildStealthScript(fingerprint));
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      `failed to inject stealth init script`,
    );
  }

  // Inject cookies if provided (e.g. admin auth)
  if (opts.cookies && opts.cookies.length > 0) {
    await stagehand.context.addCookies(opts.cookies);
  }

  // Start tracing if requested
  if (tracesDir) {
    try {
      await stagehand.context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: true,
      });
    } catch {
      // tracing may not be supported on persistent contexts
    }
  }

  const sp = stagehand.page;
  const wrapper: StagehandLike = {
    page: sp,
    context: stagehand.context,
    act: (arg) => sp.act(arg),
    extract: <T>(arg: unknown) => sp.extract(arg) as Promise<T>,
    observe: (arg) =>
      sp.observe(arg) as Promise<
        Array<{ description?: string; selector?: string }>
      >,
    close: () => (stagehand.close ? stagehand.close() : Promise.resolve()),
  };

  return {
    stagehand: wrapper,
    page: stagehand.page,
    context: stagehand.context,
    fingerprint,
    harPath,
    videoDir,
    tracesDir,
    async close(): Promise<string | undefined> {
      let videoPath: string | undefined;
      try {
        const video = stagehand.page.video();
        if (video) {
          videoPath = await video.path();
        }
      } catch {
        // ignore
      }
      // Stop tracing first
      if (tracesDir) {
        try {
          await stagehand.context.tracing.stop({
            path: path.join(tracesDir, "trace.zip"),
          });
        } catch {
          // ignore
        }
      }
      try {
        if (stagehand.close) await stagehand.close();
      } catch {
        // ignore
      }
      return videoPath;
    },
  };
}

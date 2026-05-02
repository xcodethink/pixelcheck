import {
  chromium,
  type Browser,
  type BrowserContext,
  type LaunchOptions,
  type BrowserContextOptions,
} from "playwright";
import {
  pickProfile,
  findProfile,
  type DeviceClass,
  type DeviceFingerprint,
} from "./fingerprints.js";
import { buildStealthScript } from "./stealth-script.js";

export interface StealthLaunchOptions {
  /** Use headless browser (default true). Set false for visible window debugging. */
  headless?: boolean;
  /** Extra Chromium launch args */
  extraArgs?: string[];
  /** Slow motion for debugging (ms) */
  slowMo?: number;
}

export interface StealthContextOptions {
  /** Specific fingerprint profile ID. If absent, picks random by deviceClass */
  profileId?: string;
  /** Device class to pick a random profile from */
  deviceClass?: DeviceClass;
  /** Override languages (e.g. ['ja-JP', 'ja']) */
  languages?: string[];
  /** Override locale (e.g. 'ja-JP') */
  locale?: string;
  /** Override timezone (e.g. 'Asia/Tokyo') */
  timezone?: string;
  /** Optional viewport override */
  viewport?: { width: number; height: number };
  /** Proxy config */
  proxy?: { server: string; username?: string; password?: string };
  /** Cookies to inject */
  cookies?: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  }>;
  /** Storage state file path for persistence */
  storageStatePath?: string;
  /** Enable HAR recording, with output path */
  recordHar?: { path: string; mode?: "minimal" | "full" };
  /** Enable video recording, with output dir */
  recordVideo?: { dir: string; size?: { width: number; height: number } };
}

const DEFAULT_LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-infobars",
  "--disable-dev-shm-usage",
];

/**
 * Launch a Chromium browser with stealth-friendly defaults.
 */
export async function launchStealthBrowser(
  opts: StealthLaunchOptions = {},
): Promise<Browser> {
  const launchOpts: LaunchOptions = {
    headless: opts.headless ?? true,
    args: [...DEFAULT_LAUNCH_ARGS, ...(opts.extraArgs ?? [])],
  };
  if (opts.slowMo) {
    launchOpts.slowMo = opts.slowMo;
  }
  return await chromium.launch(launchOpts);
}

/**
 * Create a new BrowserContext with a stealth fingerprint, locale, timezone,
 * and the 15 anti-detection patches injected as init script.
 *
 * Returns the context and the resolved fingerprint so callers can persist
 * it in audit reports.
 */
export async function createStealthContext(
  browser: Browser,
  opts: StealthContextOptions = {},
): Promise<{ context: BrowserContext; fingerprint: DeviceFingerprint }> {
  const fp = resolveFingerprint(opts);

  const languages = opts.languages ?? fp.languages;
  const acceptLanguage = languages
    .map((l, i) => (i === 0 ? l : `${l};q=${(0.9 - i * 0.1).toFixed(1)}`))
    .join(",");

  const ctxOpts: BrowserContextOptions = {
    viewport: opts.viewport ?? fp.viewport,
    deviceScaleFactor: fp.deviceScaleFactor,
    userAgent: fp.userAgent,
    locale: opts.locale ?? languages[0] ?? "en-US",
    timezoneId: opts.timezone ?? "America/Los_Angeles",
    hasTouch: fp.maxTouchPoints > 0,
    isMobile: fp.class === "mobile",
    extraHTTPHeaders: {
      "Accept-Language": acceptLanguage,
      "sec-ch-ua":
        '"Chromium";v="131", "Google Chrome";v="131", "Not.A/Brand";v="24"',
      "sec-ch-ua-mobile": fp.class === "mobile" ? "?1" : "?0",
      "sec-ch-ua-platform": `"${fp.chPlatform}"`,
    },
  };

  if (opts.proxy) {
    ctxOpts.proxy = opts.proxy;
  }
  if (opts.storageStatePath) {
    ctxOpts.storageState = opts.storageStatePath;
  }
  if (opts.recordHar) {
    ctxOpts.recordHar = opts.recordHar;
  }
  if (opts.recordVideo) {
    ctxOpts.recordVideo = opts.recordVideo;
  }

  const context = await browser.newContext(ctxOpts);

  // Inject the 15-patch stealth script
  const fingerprintForScript: DeviceFingerprint = {
    ...fp,
    languages,
  };
  await context.addInitScript(buildStealthScript(fingerprintForScript));

  // Inject cookies if provided
  if (opts.cookies && opts.cookies.length > 0) {
    await context.addCookies(opts.cookies);
  }

  return { context, fingerprint: fp };
}

function resolveFingerprint(opts: StealthContextOptions): DeviceFingerprint {
  if (opts.profileId) {
    const found = findProfile(opts.profileId);
    if (!found) {
      throw new Error(`Unknown stealth profile id: ${opts.profileId}`);
    }
    return found;
  }
  return pickProfile(opts.deviceClass ?? "desktop");
}

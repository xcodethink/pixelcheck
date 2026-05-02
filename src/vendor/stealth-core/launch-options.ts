import type { DeviceFingerprint } from "./fingerprints.js";

/**
 * Stealth-friendly launch options shaped for Playwright `chromium.launch()`
 * AND Stagehand's `localBrowserLaunchOptions`.
 *
 * The output is intentionally a plain object (not Playwright-typed) so it
 * can be passed directly into Stagehand's constructor without a structural
 * mismatch on the version it pins internally.
 */

export interface BuildStealthLaunchOptionsInput {
  fingerprint: DeviceFingerprint;
  /** Override languages, e.g. ['ja-JP', 'ja'] */
  languages?: string[];
  /** Override locale, e.g. 'ja-JP' */
  locale?: string;
  /** Timezone, e.g. 'Asia/Tokyo' */
  timezone?: string;
  /** Viewport override (defaults to fingerprint's viewport) */
  viewport?: { width: number; height: number };
  /** Headless flag (default true) */
  headless?: boolean;
  /** Proxy config */
  proxy?: { server: string; username?: string; password?: string };
  /** Persistent user data dir for extension loading / state */
  userDataDir?: string;
  /** Path to record HAR */
  recordHarPath?: string;
  /** Dir to record video */
  recordVideoDir?: string;
  /** Dir to record Playwright trace */
  tracesDir?: string;
  /** Extra Chromium args to append */
  extraArgs?: string[];
}

export interface StealthLaunchOptions {
  args: string[];
  headless: boolean;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  hasTouch: boolean;
  locale: string;
  timezoneId: string;
  extraHTTPHeaders: Record<string, string>;
  proxy?: { server: string; username?: string; password?: string };
  recordHar?: { path: string; mode: "minimal" | "full" };
  recordVideo?: { dir: string; size?: { width: number; height: number } };
  userDataDir?: string;
  tracesDir?: string;
}

const DEFAULT_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-infobars",
  "--disable-dev-shm-usage",
];

/**
 * Build a Stealth-friendly LaunchOptions object that can feed Playwright OR
 * Stagehand. Critical: we put the user-agent into Chromium's `--user-agent`
 * arg because Stagehand's localBrowserLaunchOptions does not expose userAgent
 * directly, but Chromium's CLI flag is honored at every level.
 */
export function buildStealthLaunchOptions(
  input: BuildStealthLaunchOptionsInput,
): StealthLaunchOptions {
  const fp = input.fingerprint;
  const languages = input.languages ?? fp.languages;
  const acceptLanguage = languages
    .map((l, i) => (i === 0 ? l : `${l};q=${(0.9 - i * 0.1).toFixed(1)}`))
    .join(",");

  const args: string[] = [
    ...DEFAULT_ARGS,
    `--user-agent=${fp.userAgent}`,
    `--lang=${languages[0] ?? "en-US"}`,
    ...(input.extraArgs ?? []),
  ];

  const opts: StealthLaunchOptions = {
    args,
    headless: input.headless ?? true,
    viewport: input.viewport ?? fp.viewport,
    deviceScaleFactor: fp.deviceScaleFactor,
    hasTouch: fp.maxTouchPoints > 0,
    locale: input.locale ?? languages[0] ?? "en-US",
    timezoneId: input.timezone ?? "America/Los_Angeles",
    extraHTTPHeaders: {
      "Accept-Language": acceptLanguage,
      "sec-ch-ua":
        '"Chromium";v="131", "Google Chrome";v="131", "Not.A/Brand";v="24"',
      "sec-ch-ua-mobile": fp.class === "mobile" ? "?1" : "?0",
      "sec-ch-ua-platform": `"${fp.chPlatform}"`,
    },
  };

  if (input.proxy) opts.proxy = input.proxy;
  if (input.recordHarPath) {
    opts.recordHar = { path: input.recordHarPath, mode: "minimal" };
  }
  if (input.recordVideoDir) {
    opts.recordVideo = { dir: input.recordVideoDir };
  }
  if (input.userDataDir) opts.userDataDir = input.userDataDir;
  if (input.tracesDir) opts.tracesDir = input.tracesDir;

  return opts;
}

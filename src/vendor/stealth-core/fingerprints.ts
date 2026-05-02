/**
 * Real device fingerprint profiles.
 *
 * Each profile is a self-consistent snapshot of a real browser session.
 * All values within a profile must be internally consistent — e.g. a
 * Windows machine must NOT report "MacIntel" as platform, and an iPhone
 * must NOT report 8 CPU cores.
 *
 * The stealth script picks the profile that matches the requested device
 * class, so desktop/tablet/mobile each get a believable identity.
 */

export type DeviceClass = "desktop" | "tablet" | "mobile";

export type UserAgentClass =
  | "macbook"
  | "windows"
  | "ipad"
  | "android-tablet"
  | "iphone"
  | "android";

export interface DeviceFingerprint {
  /** Stable identifier */
  id: string;
  /** Human label for logs */
  label: string;
  /** Device class */
  class: DeviceClass;
  /** UA class for selection */
  uaClass: UserAgentClass;
  /** navigator.userAgent */
  userAgent: string;
  /** navigator.platform */
  platform: string;
  /** navigator.languages — should be overridden by persona locale */
  languages: string[];
  /** navigator.hardwareConcurrency */
  cores: number;
  /** navigator.deviceMemory (GB) */
  memory: number;
  /** Viewport for rendering */
  viewport: { width: number; height: number };
  /** screen.width x screen.height */
  screen: { width: number; height: number; colorDepth: number };
  /** WebGL UNMASKED_VENDOR_WEBGL */
  webglVendor: string;
  /** WebGL UNMASKED_RENDERER_WEBGL */
  webglRenderer: string;
  /** Device scale factor */
  deviceScaleFactor: number;
  /** Touch support */
  maxTouchPoints: number;
  /** Sec-CH-UA-Platform value */
  chPlatform: string;
}

// ─── Desktop Profiles ───────────────────────────────────────

export const DESKTOP_PROFILES: DeviceFingerprint[] = [
  {
    id: "macbook-pro-14-m1",
    label: 'MacBook Pro 14" — Chrome 131 — macOS Sonoma',
    class: "desktop",
    uaClass: "macbook",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    platform: "MacIntel",
    languages: ["en-US", "en"],
    cores: 10,
    memory: 16,
    viewport: { width: 1512, height: 945 },
    screen: { width: 1512, height: 982, colorDepth: 30 },
    webglVendor: "Google Inc. (Apple)",
    webglRenderer: "ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)",
    deviceScaleFactor: 2,
    maxTouchPoints: 0,
    chPlatform: "macOS",
  },
  {
    id: "macbook-air-13-m2",
    label: 'MacBook Air 13" — Chrome 130 — macOS Ventura',
    class: "desktop",
    uaClass: "macbook",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    platform: "MacIntel",
    languages: ["en-US", "en"],
    cores: 8,
    memory: 8,
    viewport: { width: 1440, height: 900 },
    screen: { width: 1440, height: 900, colorDepth: 30 },
    webglVendor: "Google Inc. (Apple)",
    webglRenderer: "ANGLE (Apple, Apple M2, OpenGL 4.1)",
    deviceScaleFactor: 2,
    maxTouchPoints: 0,
    chPlatform: "macOS",
  },
  {
    id: "windows-11-intel",
    label: "Windows 11 Desktop — Chrome 131 — Intel UHD",
    class: "desktop",
    uaClass: "windows",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    platform: "Win32",
    languages: ["en-US", "en"],
    cores: 8,
    memory: 8,
    viewport: { width: 1920, height: 1040 },
    screen: { width: 1920, height: 1080, colorDepth: 24 },
    webglVendor: "Google Inc. (Intel)",
    webglRenderer: "ANGLE (Intel, Intel(R) UHD Graphics 770, D3D11)",
    deviceScaleFactor: 1,
    maxTouchPoints: 0,
    chPlatform: "Windows",
  },
  {
    id: "windows-11-nvidia",
    label: "Windows 11 — Chrome 131 — NVIDIA RTX",
    class: "desktop",
    uaClass: "windows",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    platform: "Win32",
    languages: ["en-US", "en"],
    cores: 12,
    memory: 16,
    viewport: { width: 2560, height: 1400 },
    screen: { width: 2560, height: 1440, colorDepth: 24 },
    webglVendor: "Google Inc. (NVIDIA)",
    webglRenderer:
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    deviceScaleFactor: 1,
    maxTouchPoints: 0,
    chPlatform: "Windows",
  },
];

// ─── Tablet Profiles ────────────────────────────────────────

export const TABLET_PROFILES: DeviceFingerprint[] = [
  {
    id: "ipad-pro-11",
    label: 'iPad Pro 11" — Safari 17 — iPadOS 17',
    class: "tablet",
    uaClass: "ipad",
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    platform: "iPad",
    languages: ["en-US", "en"],
    cores: 6,
    memory: 8,
    viewport: { width: 1024, height: 768 },
    screen: { width: 1194, height: 834, colorDepth: 24 },
    webglVendor: "Apple Inc.",
    webglRenderer: "Apple GPU",
    deviceScaleFactor: 2,
    maxTouchPoints: 5,
    chPlatform: "iOS",
  },
  {
    id: "galaxy-tab-s9",
    label: "Samsung Galaxy Tab S9 — Chrome 131 — Android 14",
    class: "tablet",
    uaClass: "android-tablet",
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    platform: "Linux armv81",
    languages: ["en-US", "en"],
    cores: 8,
    memory: 8,
    viewport: { width: 800, height: 1280 },
    screen: { width: 1340, height: 800, colorDepth: 24 },
    webglVendor: "Qualcomm",
    webglRenderer: "Adreno (TM) 740",
    deviceScaleFactor: 2,
    maxTouchPoints: 5,
    chPlatform: "Android",
  },
];

// ─── Mobile Profiles ────────────────────────────────────────

export const MOBILE_PROFILES: DeviceFingerprint[] = [
  {
    id: "iphone-15-pro",
    label: "iPhone 15 Pro — Safari 17 — iOS 17.4",
    class: "mobile",
    uaClass: "iphone",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
    languages: ["en-US", "en"],
    cores: 6,
    memory: 6,
    viewport: { width: 393, height: 852 },
    screen: { width: 393, height: 852, colorDepth: 24 },
    webglVendor: "Apple Inc.",
    webglRenderer: "Apple GPU",
    deviceScaleFactor: 3,
    maxTouchPoints: 5,
    chPlatform: "iOS",
  },
  {
    id: "galaxy-s24",
    label: "Samsung Galaxy S24 — Chrome 131 — Android 14",
    class: "mobile",
    uaClass: "android",
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv81",
    languages: ["en-US", "en"],
    cores: 8,
    memory: 8,
    viewport: { width: 360, height: 780 },
    screen: { width: 360, height: 780, colorDepth: 24 },
    webglVendor: "Qualcomm",
    webglRenderer: "Adreno (TM) 750",
    deviceScaleFactor: 3,
    maxTouchPoints: 5,
    chPlatform: "Android",
  },
  {
    id: "pixel-8",
    label: "Pixel 8 — Chrome 131 — Android 14",
    class: "mobile",
    uaClass: "android",
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv81",
    languages: ["en-US", "en"],
    cores: 8,
    memory: 8,
    viewport: { width: 412, height: 915 },
    screen: { width: 412, height: 915, colorDepth: 24 },
    webglVendor: "ARM",
    webglRenderer: "Mali-G715",
    deviceScaleFactor: 2.625,
    maxTouchPoints: 5,
    chPlatform: "Android",
  },
];

export const ALL_PROFILES: DeviceFingerprint[] = [
  ...DESKTOP_PROFILES,
  ...TABLET_PROFILES,
  ...MOBILE_PROFILES,
];

/** Pick a random profile from the right category */
export function pickProfile(deviceClass: DeviceClass): DeviceFingerprint {
  const pool =
    deviceClass === "mobile"
      ? MOBILE_PROFILES
      : deviceClass === "tablet"
        ? TABLET_PROFILES
        : DESKTOP_PROFILES;
  const idx = Math.floor(Math.random() * pool.length);
  // Cast: pool is non-empty by construction
  return pool[idx] as DeviceFingerprint;
}

/** Find a profile by ID, or undefined */
export function findProfile(id: string): DeviceFingerprint | undefined {
  return ALL_PROFILES.find((p) => p.id === id);
}

/** Find a profile by UA class, picking the first match */
export function findProfileByUaClass(
  uaClass: UserAgentClass,
): DeviceFingerprint | undefined {
  return ALL_PROFILES.find((p) => p.uaClass === uaClass);
}

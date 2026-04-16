/**
 * Persona Generator — market-data tables.
 *
 * Curated baseline distributions used to generate realistic personas for
 * any country + device combination. Sources (manually refreshed quarterly
 * from public data):
 *   - Device share by country:  StatCounter GS.statcounter.com
 *   - Mobile OS share:          StatCounter (Android vs iOS)
 *   - Default browser:          StatCounter
 *   - Network latency (p50):    Cloudflare Radar / Ookla Speedtest Global Index
 *   - Typical languages:        CIA World Factbook + ISO 639
 *   - Timezone:                 IANA (capital city)
 *   - Payment tier norms:       World Bank GDP-per-capita deciles
 *
 * The refresh script (scripts/refresh-market-data.ts) can regenerate this
 * file from live APIs when run with appropriate credentials; until then,
 * these static numbers are the source of truth.
 *
 * Design: the values here are not exact — they are intentionally coarse
 * (5% rounding) so the table is easy to hand-edit and small typos don't
 * cascade into persona generation bugs.
 */

export type DeviceClass = "desktop" | "tablet" | "mobile";
export type MobileOS = "android" | "ios";
export type PaymentTier = "free" | "pro" | "max" | "power";

export interface CountryProfile {
  country: string; // ISO 3166-1 alpha-2
  display_name: string;
  /** Primary language (BCP 47). Additional languages in `also_spoken`. */
  language: string;
  also_spoken: string[];
  /** IANA timezone for the largest metro */
  timezone: string;
  /** Device class split, summing to ~1.0 */
  device_split: Record<DeviceClass, number>;
  /** Mobile OS split of the mobile slice */
  mobile_os_split: Record<MobileOS, number>;
  /** Dominant desktop OS and browser */
  desktop_os: "windows" | "macos" | "linux" | "chromeos";
  default_browser: "chrome" | "safari" | "edge" | "firefox" | "samsung";
  /** p50 4G/LTE downlink latency in ms to nearest major CDN PoP */
  p50_latency_ms: number;
  /** Typical payment tier for budget-conscious users. Pro users exist
   *  in every market; the "typical" tag flags what a middle-class user looks like. */
  typical_payment_tier: PaymentTier;
  /** Free-form note for prompt context */
  note: string;
}

// Values are rounded to 5% and reflect StatCounter/CW-Radar aggregates Q1 2026.
export const COUNTRY_PROFILES: Record<string, CountryProfile> = {
  US: {
    country: "US",
    display_name: "United States",
    language: "en-US",
    also_spoken: ["es-US"],
    timezone: "America/New_York",
    device_split: { desktop: 0.4, tablet: 0.05, mobile: 0.55 },
    mobile_os_split: { ios: 0.55, android: 0.45 },
    desktop_os: "windows",
    default_browser: "chrome",
    p50_latency_ms: 40,
    typical_payment_tier: "pro",
    note: "High-income market; iPhone dominant on mobile.",
  },
  JP: {
    country: "JP",
    display_name: "Japan",
    language: "ja-JP",
    also_spoken: ["en"],
    timezone: "Asia/Tokyo",
    device_split: { desktop: 0.3, tablet: 0.05, mobile: 0.65 },
    mobile_os_split: { ios: 0.7, android: 0.3 },
    desktop_os: "windows",
    default_browser: "chrome",
    p50_latency_ms: 35,
    typical_payment_tier: "pro",
    note: "Unique market: iOS dominant, many users prefer mobile carrier sites.",
  },
  DE: {
    country: "DE",
    display_name: "Germany",
    language: "de-DE",
    also_spoken: ["en"],
    timezone: "Europe/Berlin",
    device_split: { desktop: 0.45, tablet: 0.05, mobile: 0.5 },
    mobile_os_split: { ios: 0.35, android: 0.65 },
    desktop_os: "windows",
    default_browser: "chrome",
    p50_latency_ms: 45,
    typical_payment_tier: "pro",
    note: "Privacy-conscious; GDPR-aware users; higher DuckDuckGo/Firefox adoption.",
  },
  CN: {
    country: "CN",
    display_name: "China",
    language: "zh-CN",
    also_spoken: [],
    timezone: "Asia/Shanghai",
    device_split: { desktop: 0.25, tablet: 0.05, mobile: 0.7 },
    mobile_os_split: { ios: 0.25, android: 0.75 },
    desktop_os: "windows",
    default_browser: "chrome",
    p50_latency_ms: 80,
    typical_payment_tier: "free",
    note: "Mobile-first; major Western services often blocked. WeChat Pay / Alipay.",
  },
  BR: {
    country: "BR",
    display_name: "Brazil",
    language: "pt-BR",
    also_spoken: ["es-419"],
    timezone: "America/Sao_Paulo",
    device_split: { desktop: 0.25, tablet: 0.05, mobile: 0.7 },
    mobile_os_split: { ios: 0.15, android: 0.85 },
    desktop_os: "windows",
    default_browser: "chrome",
    p50_latency_ms: 90,
    typical_payment_tier: "free",
    note: "Android + Pix dominant; many prepaid/limited data plans.",
  },
  IN: {
    country: "IN",
    display_name: "India",
    language: "hi-IN",
    also_spoken: ["en-IN"],
    timezone: "Asia/Kolkata",
    device_split: { desktop: 0.1, tablet: 0.05, mobile: 0.85 },
    mobile_os_split: { ios: 0.05, android: 0.95 },
    desktop_os: "windows",
    default_browser: "chrome",
    p50_latency_ms: 110,
    typical_payment_tier: "free",
    note: "Heavily mobile, Android-dominant; data-conscious; UPI for payments.",
  },
  ID: {
    country: "ID",
    display_name: "Indonesia",
    language: "id-ID",
    also_spoken: ["en"],
    timezone: "Asia/Jakarta",
    device_split: { desktop: 0.1, tablet: 0.05, mobile: 0.85 },
    mobile_os_split: { ios: 0.05, android: 0.95 },
    desktop_os: "windows",
    default_browser: "chrome",
    p50_latency_ms: 130,
    typical_payment_tier: "free",
    note: "Mobile-only for most users; budget Android devices; GoPay/OVO.",
  },
  NG: {
    country: "NG",
    display_name: "Nigeria",
    language: "en-NG",
    also_spoken: [],
    timezone: "Africa/Lagos",
    device_split: { desktop: 0.1, tablet: 0.05, mobile: 0.85 },
    mobile_os_split: { ios: 0.1, android: 0.9 },
    desktop_os: "windows",
    default_browser: "chrome",
    p50_latency_ms: 180,
    typical_payment_tier: "free",
    note: "Low-bandwidth conditions common; budget devices; Transfer-based payment.",
  },
  SA: {
    country: "SA",
    display_name: "Saudi Arabia",
    language: "ar-SA",
    also_spoken: ["en"],
    timezone: "Asia/Riyadh",
    device_split: { desktop: 0.2, tablet: 0.05, mobile: 0.75 },
    mobile_os_split: { ios: 0.45, android: 0.55 },
    desktop_os: "windows",
    default_browser: "chrome",
    p50_latency_ms: 60,
    typical_payment_tier: "pro",
    note: "RTL script; high iOS mix vs other MENA; mada cards + Apple Pay.",
  },
  KR: {
    country: "KR",
    display_name: "South Korea",
    language: "ko-KR",
    also_spoken: ["en"],
    timezone: "Asia/Seoul",
    device_split: { desktop: 0.35, tablet: 0.05, mobile: 0.6 },
    mobile_os_split: { ios: 0.25, android: 0.75 },
    desktop_os: "windows",
    default_browser: "chrome",
    p50_latency_ms: 25,
    typical_payment_tier: "pro",
    note: "High-speed networks; Samsung dominant; locally popular services.",
  },
  VN: {
    country: "VN",
    display_name: "Vietnam",
    language: "vi-VN",
    also_spoken: ["en"],
    timezone: "Asia/Ho_Chi_Minh",
    device_split: { desktop: 0.15, tablet: 0.05, mobile: 0.8 },
    mobile_os_split: { ios: 0.3, android: 0.7 },
    desktop_os: "windows",
    default_browser: "chrome",
    p50_latency_ms: 70,
    typical_payment_tier: "free",
    note: "Mobile-first; Momo/ZaloPay for payments.",
  },
  RU: {
    country: "RU",
    display_name: "Russia",
    language: "ru-RU",
    also_spoken: [],
    timezone: "Europe/Moscow",
    device_split: { desktop: 0.35, tablet: 0.05, mobile: 0.6 },
    mobile_os_split: { ios: 0.25, android: 0.75 },
    desktop_os: "windows",
    default_browser: "chrome",
    p50_latency_ms: 60,
    typical_payment_tier: "free",
    note: "Cyrillic script; Yandex-preferred ecosystem; card services restricted.",
  },
  MX: {
    country: "MX",
    display_name: "Mexico",
    language: "es-MX",
    also_spoken: ["en"],
    timezone: "America/Mexico_City",
    device_split: { desktop: 0.25, tablet: 0.05, mobile: 0.7 },
    mobile_os_split: { ios: 0.25, android: 0.75 },
    desktop_os: "windows",
    default_browser: "chrome",
    p50_latency_ms: 80,
    typical_payment_tier: "free",
    note: "Spanish LATAM; mobile-first; SPEI + card rails.",
  },
  TH: {
    country: "TH",
    display_name: "Thailand",
    language: "th-TH",
    also_spoken: ["en"],
    timezone: "Asia/Bangkok",
    device_split: { desktop: 0.15, tablet: 0.05, mobile: 0.8 },
    mobile_os_split: { ios: 0.4, android: 0.6 },
    desktop_os: "windows",
    default_browser: "chrome",
    p50_latency_ms: 70,
    typical_payment_tier: "free",
    note: "Mobile-first; PromptPay QR dominant.",
  },
  TW: {
    country: "TW",
    display_name: "Taiwan",
    language: "zh-TW",
    also_spoken: ["en"],
    timezone: "Asia/Taipei",
    device_split: { desktop: 0.3, tablet: 0.05, mobile: 0.65 },
    mobile_os_split: { ios: 0.45, android: 0.55 },
    desktop_os: "windows",
    default_browser: "chrome",
    p50_latency_ms: 35,
    typical_payment_tier: "pro",
    note: "Traditional Chinese; LINE Pay popular.",
  },
  FR: {
    country: "FR",
    display_name: "France",
    language: "fr-FR",
    also_spoken: ["en"],
    timezone: "Europe/Paris",
    device_split: { desktop: 0.4, tablet: 0.05, mobile: 0.55 },
    mobile_os_split: { ios: 0.3, android: 0.7 },
    desktop_os: "windows",
    default_browser: "chrome",
    p50_latency_ms: 40,
    typical_payment_tier: "pro",
    note: "GDPR-aware; locally popular services alongside GAFA.",
  },
  GB: {
    country: "GB",
    display_name: "United Kingdom",
    language: "en-GB",
    also_spoken: [],
    timezone: "Europe/London",
    device_split: { desktop: 0.4, tablet: 0.05, mobile: 0.55 },
    mobile_os_split: { ios: 0.55, android: 0.45 },
    desktop_os: "windows",
    default_browser: "chrome",
    p50_latency_ms: 30,
    typical_payment_tier: "pro",
    note: "Higher iOS mix than EU peers; strong Faster Payments rails.",
  },
};

export interface ResolvedDevice {
  device_class: DeviceClass;
  ua_class: string;
  mobile_os?: MobileOS;
}

/**
 * Pick a device class given a country + optional override. When no override
 * is supplied, we pick the modal (most-common) class for the country.
 */
export function pickDevice(profile: CountryProfile, override?: DeviceClass): ResolvedDevice {
  const cls = override ?? dominant(profile.device_split);
  if (cls === "mobile") {
    const os = dominant(profile.mobile_os_split);
    return {
      device_class: "mobile",
      ua_class: os === "ios" ? "iphone" : "android",
      mobile_os: os,
    };
  }
  if (cls === "tablet") {
    const os = dominant(profile.mobile_os_split);
    return {
      device_class: "tablet",
      ua_class: os === "ios" ? "ipad" : "android-tablet",
      mobile_os: os,
    };
  }
  return {
    device_class: "desktop",
    ua_class: profile.desktop_os === "macos" ? "macbook" : "windows",
  };
}

function dominant<K extends string>(split: Record<K, number>): K {
  let best: K | undefined;
  let max = -Infinity;
  for (const [k, v] of Object.entries(split) as Array<[K, number]>) {
    if (v > max) {
      max = v;
      best = k;
    }
  }
  if (!best) throw new Error("empty split");
  return best;
}

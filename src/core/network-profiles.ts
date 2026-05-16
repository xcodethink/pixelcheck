/**
 * Network condition profiles for persona-based throttling.
 *
 * Applied via Chrome DevTools Protocol (CDP) `Network.emulateNetworkConditions`.
 * Values sourced from Chrome DevTools presets and real-world measurements.
 */

export interface NetworkProfile {
  /** Human-readable label */
  label: string;
  /** Download throughput in bytes/sec (-1 = disabled) */
  downloadThroughput: number;
  /** Upload throughput in bytes/sec (-1 = disabled) */
  uploadThroughput: number;
  /** Minimum latency in ms */
  latency: number;
  /** Whether the connection is "offline" */
  offline: boolean;
}

/**
 * Built-in network profiles. Keys match the `network_profile` field in persona YAML.
 */
export const NETWORK_PROFILES: Record<string, NetworkProfile> = {
  /** No throttling — default for desktop/broadband personas */
  broadband: {
    label: "Broadband (no throttle)",
    downloadThroughput: -1,
    uploadThroughput: -1,
    latency: 0,
    offline: false,
  },

  /** Typical 4G LTE — good urban mobile */
  "4g": {
    label: "4G LTE (4 Mbps / 3 Mbps, 20ms)",
    downloadThroughput: 4 * 1024 * 1024 / 8, // 4 Mbps
    uploadThroughput: 3 * 1024 * 1024 / 8,   // 3 Mbps
    latency: 20,
    offline: false,
  },

  /** 3G — emerging market mobile, rural areas */
  "3g": {
    label: "3G (1.6 Mbps / 750 Kbps, 300ms)",
    downloadThroughput: 1.6 * 1024 * 1024 / 8,  // 1.6 Mbps
    uploadThroughput: 750 * 1024 / 8,             // 750 Kbps
    latency: 300,
    offline: false,
  },

  /** Slow 3G — worst-case mobile in developing regions */
  "slow-3g": {
    label: "Slow 3G (500 Kbps / 500 Kbps, 2000ms)",
    downloadThroughput: 500 * 1024 / 8,
    uploadThroughput: 500 * 1024 / 8,
    latency: 2000,
    offline: false,
  },
};

/**
 * Resolve a network profile name to its definition.
 * Returns `undefined` if the name is not recognized (no throttling applied).
 */
export function resolveNetworkProfile(name: string | undefined): NetworkProfile | undefined {
  if (!name || name === "broadband") return undefined;
  return NETWORK_PROFILES[name];
}

export {
  ALL_PROFILES,
  DESKTOP_PROFILES,
  TABLET_PROFILES,
  MOBILE_PROFILES,
  pickProfile,
  findProfile,
  findProfileByUaClass,
  type DeviceClass,
  type UserAgentClass,
  type DeviceFingerprint,
} from "./fingerprints.js";

export { buildStealthScript } from "./stealth-script.js";

export {
  launchStealthBrowser,
  createStealthContext,
  type StealthLaunchOptions as DirectStealthLaunchOptions,
  type StealthContextOptions,
} from "./browser.js";

export {
  buildStealthLaunchOptions,
  type BuildStealthLaunchOptionsInput,
  type StealthLaunchOptions,
} from "./launch-options.js";

export {
  withRetry,
  defaultClassifier,
  RetryError,
  type RetryOptions,
  type RetryDecision,
} from "./retry.js";

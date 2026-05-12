import type { Cookie } from "playwright";

/**
 * Build admin auth cookies for a target origin from env.
 */
export function buildAdminCookies(adminUrl: string | undefined): Cookie[] {
  if (!adminUrl) return [];
  const cookieValue = process.env.SCAMLENS_ADMIN_COOKIE;
  if (!cookieValue) return [];

  const url = new URL(adminUrl);
  // Cookie value can be either "name=value" or "name=value; name2=value2"
  const cookies: Cookie[] = [];
  for (const pair of cookieValue.split(";")) {
    const [name, ...rest] = pair.trim().split("=");
    if (!name || rest.length === 0) continue;
    cookies.push({
      name: name.trim(),
      value: rest.join("=").trim(),
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "Lax",
      expires: -1,
    });
  }
  return cookies;
}

/**
 * Substitute secret placeholders in scenario step values.
 *
 * Supported placeholders:
 *   ${env.VAR_NAME}        — direct env lookup
 *   ${persona.field}       — persona field (handled elsewhere)
 *   ${stripe.card_number}  — Stripe test card number
 *   ${stripe.exp}          — Stripe test card expiration
 *   ${stripe.cvc}          — Stripe test card CVC
 *   ${stripe.pk_test}      — Stripe test publishable key
 *
 * The Stripe placeholders read from STRIPE_TEST_* env vars.
 */
export function getStripeSecrets(): Record<string, string> {
  return {
    "stripe.card_number": process.env.STRIPE_TEST_CARD_NUMBER ?? "4242424242424242",
    "stripe.exp": process.env.STRIPE_TEST_CARD_EXP ?? "12/30",
    "stripe.cvc": process.env.STRIPE_TEST_CARD_CVC ?? "123",
    "stripe.pk_test": process.env.STRIPE_TEST_PUBLISHABLE_KEY ?? "",
  };
}

/**
 * Build the redact pattern list — combine config patterns with auto-detected
 * secrets from env (so test passwords / cookies don't leak into reports).
 */
export function buildRedactPatterns(configPatterns: string[]): string[] {
  const patterns = new Set<string>(configPatterns);

  // Auto-add any non-empty secret env vars
  const secretEnvKeys = [
    "ANTHROPIC_API_KEY",
    "SCAMLENS_ADMIN_COOKIE",
    "STRIPE_TEST_PUBLISHABLE_KEY",
    "TEST_GOOGLE_US_PASSWORD",
    "TEST_GOOGLE_JP_PASSWORD",
    "TEST_GOOGLE_DE_PASSWORD",
    "TEST_GOOGLE_CN_PASSWORD",
    "SLACK_WEBHOOK",
    "TELEGRAM_BOT_TOKEN",
  ];
  for (const k of secretEnvKeys) {
    const v = process.env[k];
    if (v && v.length >= 4) patterns.add(v);
  }
  return Array.from(patterns);
}

/**
 * Apply redaction to a string by replacing each pattern with [REDACTED].
 */
export function redact(input: string, patterns: string[]): string {
  let out = input;
  for (const p of patterns) {
    if (!p) continue;
    // Case-sensitive substring replace
    out = out.split(p).join("[REDACTED]");
  }
  return out;
}

/**
 * Recursively redact strings inside an arbitrary JSON-shaped object.
 */
export function redactDeep<T>(value: T, patterns: string[]): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return redact(value, patterns) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, patterns)) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(value)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k] = redactDeep(v, patterns);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Default sensitive-key substrings used by the WhiteboxCollector to
 * redact cookie / localStorage / sessionStorage values when the *key
 * name* contains any of these tokens. Case-insensitive substring match.
 *
 * Complements {@link redact} (which redacts by *value* substring). The
 * two systems handle different scenarios:
 *   - {@link redact} catches secrets you registered up front (env var
 *     values, known API keys) wherever they appear.
 *   - {@link DEFAULT_SENSITIVE_KEY_PATTERNS} catches secrets whose
 *     *value* you don't know in advance but whose *key name* gives
 *     them away (e.g. `localStorage.password = '<unknown>'`,
 *     `cookies.session = '<server-issued>'`).
 *
 * Callers may extend this list via project config (`redact_key_patterns`).
 */
export const DEFAULT_SENSITIVE_KEY_PATTERNS = [
  "password",
  "token",
  "secret",
  "auth",
  "session",
  "api_key",
  "apikey",
  "credit",
  "card",
  "ssn",
  "private",
  "bearer",
  "csrf",
  "xsrf",
] as const;

/**
 * Redact entries in a key-value map when the key contains any of the
 * sensitive substrings. Returns a NEW object — does not mutate input.
 *
 * Used by WhiteboxCollector for cookie values and storage values where
 * the value is server-issued and we don't know it ahead of time, but
 * the key name signals sensitivity.
 *
 * @param map - the key-value map to scan
 * @param keyPatterns - case-insensitive substrings that mark a key as sensitive
 * @returns new map with sensitive values replaced by `[REDACTED]`
 */
export function redactByKey<V>(
  map: Record<string, V>,
  keyPatterns: readonly string[],
): Record<string, V | string> {
  const lowered = keyPatterns.map((p) => p.toLowerCase());
  const out: Record<string, V | string> = {};
  for (const [k, v] of Object.entries(map)) {
    const kLower = k.toLowerCase();
    const isSensitive = lowered.some((p) => kLower.includes(p));
    out[k] = isSensitive ? "[REDACTED]" : v;
  }
  return out;
}

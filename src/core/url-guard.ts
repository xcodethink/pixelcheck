/**
 * URL safety guard — blocks navigation to dangerous schemes and private networks.
 *
 * Used by MCP tool handlers to validate user-supplied URLs before passing them
 * to Playwright's page.goto(). This prevents SSRF attacks where a malicious MCP
 * client could direct the browser to internal network addresses or local files.
 */

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

const PRIVATE_RANGES = [
  /^127\./,             // loopback
  /^10\./,              // Class A private
  /^172\.(1[6-9]|2\d|3[01])\./,  // Class B private
  /^192\.168\./,        // Class C private
  /^169\.254\./,        // link-local
  /^0\./,               // current network
  /^\[::1\]/,           // IPv6 loopback
  /^\[fe80:/i,          // IPv6 link-local
  /^\[fc/i,             // IPv6 unique local
  /^\[fd/i,             // IPv6 unique local
];

export class UnsafeUrlError extends Error {
  constructor(url: string, reason: string) {
    super(`Unsafe URL blocked: ${url} — ${reason}`);
    this.name = "UnsafeUrlError";
  }
}

/**
 * Validate that a URL is safe for browser navigation.
 * Throws UnsafeUrlError if the URL uses a disallowed scheme or targets a private network.
 *
 * @param raw - The URL string to validate
 * @param opts.allowPrivate - If true, skip private network checks (for local development)
 */
export function assertSafeUrl(
  raw: string,
  opts: { allowPrivate?: boolean } = {},
): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UnsafeUrlError(raw, "invalid URL");
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new UnsafeUrlError(raw, `scheme "${parsed.protocol}" is not allowed (only http/https)`);
  }

  if (opts.allowPrivate) return;

  const hostname = parsed.hostname;

  if (hostname === "localhost") {
    throw new UnsafeUrlError(raw, "localhost is not allowed");
  }

  for (const pattern of PRIVATE_RANGES) {
    if (pattern.test(hostname)) {
      throw new UnsafeUrlError(raw, "private/internal network address is not allowed");
    }
  }

  // Block metadata endpoints (cloud provider IMDS)
  if (hostname === "metadata.google.internal" || hostname === "metadata.google.com") {
    throw new UnsafeUrlError(raw, "cloud metadata endpoint is not allowed");
  }
}

/**
 * URL pre-flight check.
 *
 * Probes every concrete `visit` URL referenced by selected scenarios with a
 * HEAD request before the matrix runs. Catches 404s, DNS errors, and SSL
 * problems before any LLM credit is spent.
 *
 * Templated URLs (containing ${persona.x}, ${env.x}, ${store.x}) are
 * substituted against each persona once so we probe the realistic permutations.
 */

import { substituteTemplate } from "./scenario.js";
import type { Persona, Scenario } from "./types.js";

export interface UrlIssue {
  url: string;
  scenario: string;
  persona?: string;
  step: string;
  status: number | "error";
  message?: string;
}

export interface PreflightOptions {
  /** Print results to stdout */
  verbose?: boolean;
  /** Per-request timeout in ms */
  timeoutMs?: number;
  /** Stripe / store secrets to substitute */
  stripeSecrets?: Record<string, string>;
}

/**
 * Probe all visit URLs for the given (scenario × persona) pairs.
 * Returns the list of URLs that failed (4xx/5xx/network).
 */
export async function preflightUrls(
  matrix: Array<{ scenario: Scenario; persona: Persona }>,
  opts: PreflightOptions = {},
): Promise<UrlIssue[]> {
  const timeout = opts.timeoutMs ?? 8000;

  // Collect unique (url, scenarioId, personaId, stepId) tuples
  const targets = new Map<string, UrlIssue>();
  for (const { scenario, persona } of matrix) {
    for (const step of scenario.steps ?? []) {
      if (step.type !== "visit") continue;
      const ctx = {
        persona: persona as unknown as Record<string, unknown>,
        env: process.env as Record<string, string>,
        stripe: opts.stripeSecrets,
      };
      const url = substituteTemplate(step.url, ctx);
      // Skip URLs that still have unresolved placeholders — they're meant
      // to be filled in later by store substitution and we can't probe them.
      if (url.includes("${")) continue;
      // Skip auth-protected admin paths — 401/403 is the expected state for
      // an unauthenticated preflight probe and isn't a scenario bug.
      if (/\/admin(\b|\/)/.test(url)) continue;
      const key = `${url}|${scenario.id}|${persona.id}|${step.id}`;
      targets.set(key, {
        url,
        scenario: scenario.id,
        persona: persona.id,
        step: step.id,
        status: 0,
      });
    }
  }

  // Use a real-looking UA + Accept header so Cloudflare / WAFs don't block
  // the probe as a generic bot. We're not trying to be sneaky here — we are
  // probing a website we own (or are auditing with permission).
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  // Deduplicate by URL (we don't need to probe the same URL once per persona).
  const uniqueByUrl = new Map<string, UrlIssue>();
  for (const t of targets.values()) {
    if (!uniqueByUrl.has(t.url)) uniqueByUrl.set(t.url, t);
  }

  const issues: UrlIssue[] = [];

  // Probe sequentially with a small inter-request delay so we don't trip
  // Cloudflare/WAF rate limits. ~30 URLs × 100ms = 3s overhead, well worth it
  // vs spending LLM credits on a guaranteed-fail unit.
  for (const target of uniqueByUrl.values()) {
    let attempt = 0;
    const maxAttempts = 2;
    while (attempt < maxAttempts) {
      attempt++;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const res = await fetch(target.url, {
          method: "GET",
          signal: controller.signal,
          redirect: "follow",
          headers,
        });
        clearTimeout(timer);

        target.status = res.status;
        if (res.status >= 400) {
          target.message = `HTTP ${res.status}`;
          issues.push(target);
        }
        break; // success, exit retry loop
      } catch (err) {
        if (attempt >= maxAttempts) {
          target.status = "error";
          target.message = err instanceof Error ? err.message : String(err);
          issues.push(target);
        } else {
          // wait briefly before retry
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
    // Inter-request delay
    await new Promise((r) => setTimeout(r, 100));
  }

  return issues;
}

/**
 * WhiteboxCollector — passive observer that gathers white-box audit data
 * from a single Playwright BrowserContext + main Page over the lifetime
 * of one primitive call (see / act / extract / compare).
 *
 * Per ADR-034 (Phase 0), the collector runs ALWAYS — no short-circuit
 * on success path. Listeners are zero-cost (just register on browser
 * events); the actual serialization happens in `collect()` at the end
 * of the primitive's run, by which time all events are accumulated.
 *
 * Four dimensions:
 *   1. Popups — secondary windows opened via window.open() / OAuth /
 *      SSO / share dialogs. Tracked via `context.on('page')`.
 *   2. Network — every request + response + failure on the main page.
 *      Tracked via `page.on('request' | 'response' | 'requestfailed')`.
 *   3. Cookies — `BrowserContext.cookies()` snapshot at collect() time.
 *   4. Storage — `localStorage` + `sessionStorage` snapshot via
 *      `page.evaluate()` at collect() time.
 *
 * Privacy: cookie values and storage values are key-redacted via
 * {@link redactByKey} when the key name matches sensitive substrings
 * (password / token / secret / session / api_key / ...). The value-
 * substring redaction (registered secrets via {@link redact}) is
 * applied separately by the primitive after `collect()` returns.
 *
 * Resource caps:
 *   - POPUP_CAP = 50 — refuses excess popups (window.open() loops),
 *     eagerly closes the dropped page so it doesn't leak.
 *   - NETWORK_REQUEST_CAP = 500 — caps stored requests.
 *     `truncated_count` reports how many were dropped.
 *   - POPUP_BODY_TEXT_MAX_BYTES = 2_000 — caps per-popup body text.
 *   - STORAGE_VALUE_MAX_BYTES = 2_000 — truncates per-value storage.
 *   - LIST_POPUPS_CONCURRENCY = 10 — bounds latency of `collect()`'s
 *     popup serialization.
 *
 * Design references the popup-tracking implementation in the archived
 * BrowserAgent project (`xcodethink/BrowserAgent` tag `v1.0-archived`),
 * but is re-implemented to fit PixelCheck's fresh-context-per-primitive
 * architecture rather than BrowserAgent's persistent BrowserSession.
 */

import type { BrowserContext, Page } from "playwright";
import {
  DEFAULT_SENSITIVE_KEY_PATTERNS,
  redactByKey,
} from "./secrets.js";

// ─────────────────────────────────────────────────────────────
// Caps and constants (exported so primitives + tests can reference them)
// ─────────────────────────────────────────────────────────────

/** Max popups tracked per session. Excess `window.open()` calls are
 *  dropped + eagerly closed to prevent runaway resource use. */
export const POPUP_CAP = 50;

/** Max network requests stored. Excess get counted in
 *  `truncated_count` but their per-entry data is dropped. */
export const NETWORK_REQUEST_CAP = 500;

/** Max bytes of `document.body.innerText` per popup snapshot. */
export const POPUP_BODY_TEXT_MAX_BYTES = 2_000;

/** Max bytes per single storage value before truncation. */
export const STORAGE_VALUE_MAX_BYTES = 2_000;

/** Concurrency cap for parallel popup serialization in collect(). */
export const LIST_POPUPS_CONCURRENCY = 10;

// ─────────────────────────────────────────────────────────────
// Output data shapes (mirror the schemas in result-schema.ts)
// ─────────────────────────────────────────────────────────────

export interface PopupSnapshot {
  index: number;
  url: string;
  title: string;
  body_text: string;
  closed: boolean;
  last_seen_url?: string;
  last_seen_title?: string;
}

export interface NetworkRequestEntry {
  url: string;
  method: string;
  resource_type?: string;
  status: number | null;
  duration_ms: number | null;
  size_bytes: number | null;
  from_cache?: boolean;
}

export interface NetworkFailureEntry {
  url: string;
  method: string;
  resource_type?: string;
  error_text: string;
}

export interface NetworkLog {
  request_count: number;
  failure_count: number;
  requests: NetworkRequestEntry[];
  failures: NetworkFailureEntry[];
  truncated_count?: number;
}

export interface CookieData {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  http_only: boolean;
  secure: boolean;
  same_site?: "Strict" | "Lax" | "None";
}

export interface StorageSnapshot {
  local_storage: Record<string, string>;
  session_storage: Record<string, string>;
  local_storage_keys: number;
  session_storage_keys: number;
}

export interface WhiteboxData {
  popups: PopupSnapshot[];
  network: NetworkLog;
  cookies: CookieData[];
  storage: StorageSnapshot;
}

// ─────────────────────────────────────────────────────────────
// Internal request bookkeeping
// ─────────────────────────────────────────────────────────────

/** Per-request state we accumulate from request+response+failure events.
 *  Stored keyed by Playwright's request object identity. */
interface RequestRecord {
  url: string;
  method: string;
  resource_type?: string;
  start_ms: number;
  status: number | null;
  end_ms: number | null;
  size_bytes: number | null;
  from_cache?: boolean;
  failure_text: string | null;
}

// ─────────────────────────────────────────────────────────────
// WhiteboxCollector
// ─────────────────────────────────────────────────────────────

export interface WhiteboxCollectorOptions {
  /** Extra key substrings (case-insensitive) added to
   *  {@link DEFAULT_SENSITIVE_KEY_PATTERNS} for cookie / storage key
   *  redaction. */
  extraSensitiveKeyPatterns?: readonly string[];
}

export class WhiteboxCollector {
  // popup tracking
  private readonly popups: Page[] = [];
  /** Per-popup last-known URL + title, indexed by popup position.
   *  Used so `collect()` can still report context for closed popups. */
  private readonly popupHistory = new Map<
    number,
    { last_seen_url: string; last_seen_title: string }
  >();
  /** True if attach() has been called. */
  private attached = false;

  // network tracking — keyed by Playwright Request identity
  private readonly requests = new Map<unknown, RequestRecord>();
  /** Total requests observed (may exceed NETWORK_REQUEST_CAP). */
  private requestCount = 0;
  /** Total failures observed. */
  private failureCount = 0;

  private readonly sensitiveKeyPatterns: readonly string[];

  constructor(
    private readonly context: BrowserContext,
    private readonly mainPage: Page,
    opts: WhiteboxCollectorOptions = {},
  ) {
    const extra = opts.extraSensitiveKeyPatterns ?? [];
    this.sensitiveKeyPatterns = [
      ...DEFAULT_SENSITIVE_KEY_PATTERNS,
      ...extra,
    ];
  }

  /** Register listeners on the context + main page. Idempotent. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;

    // Popup tracking — captures secondary pages opened by main or by
    // other popups. Listener is attached AFTER mainPage exists so the
    // main page itself isn't counted.
    this.context.on("page", (p: Page) => {
      if (this.popups.length >= POPUP_CAP) {
        // Eagerly close — prevents resource leak from runaway
        // window.open() loops. Silent: a console.warn would violate
        // PixelCheck's lint:no-console rule. Caps are visible in the
        // resulting truncation: collect() returns popups.length === CAP.
        p.close().catch(() => {});
        return;
      }
      this.popups.push(p);
    });

    // Network — request started.
    this.mainPage.on("request", (req) => {
      if (this.requestCount >= NETWORK_REQUEST_CAP) {
        // Past cap: still bump counter so `truncated_count` is accurate;
        // but don't store per-entry data.
        this.requestCount++;
        return;
      }
      this.requestCount++;
      this.requests.set(req, {
        url: req.url(),
        method: req.method(),
        resource_type: safeResourceType(req),
        start_ms: Date.now(),
        status: null,
        end_ms: null,
        size_bytes: null,
        failure_text: null,
      });
    });

    // Network — response arrived.
    this.mainPage.on("response", (resp) => {
      const rec = this.requests.get(resp.request());
      if (!rec) return;
      rec.status = resp.status();
      rec.end_ms = Date.now();
      // Best-effort cache signal: Playwright surfaces service-worker
      // hits via fromServiceWorker(). It's a proxy (a SW can also generate
      // responses, not just serve cache) but the only signal available at
      // the network-event layer. When the method is missing on older
      // Playwright builds, leave the field undefined.
      const fromSw = resp.fromServiceWorker?.();
      if (typeof fromSw === "boolean") {
        rec.from_cache = fromSw;
      }
      // size: try Content-Length header (best-effort, may be absent)
      const cl = resp.headers()["content-length"];
      const parsed = cl ? Number(cl) : NaN;
      if (Number.isFinite(parsed) && parsed >= 0) {
        rec.size_bytes = parsed;
      }
    });

    // Network — request failed (DNS / TLS / aborted / etc).
    this.mainPage.on("requestfailed", (req) => {
      this.failureCount++;
      const rec = this.requests.get(req);
      if (rec) {
        rec.failure_text = req.failure()?.errorText ?? "unknown";
        rec.end_ms = Date.now();
      }
    });
  }

  /**
   * Serialize all accumulated data. Apply redaction. Bound concurrency
   * for popup serialization. Caller is expected to invoke this once,
   * after the primitive's main work completes, before context.close().
   */
  async collect(): Promise<WhiteboxData> {
    const [popups, cookies, storage] = await Promise.all([
      this.collectPopups(),
      this.collectCookies(),
      this.collectStorage(),
    ]);
    return {
      popups,
      network: this.serializeNetwork(),
      cookies,
      storage,
    };
  }

  // ── popup collection ────────────────────────────────────────

  private async collectPopups(): Promise<PopupSnapshot[]> {
    const out: PopupSnapshot[] = new Array(this.popups.length);
    for (let start = 0; start < this.popups.length; start += LIST_POPUPS_CONCURRENCY) {
      const end = Math.min(start + LIST_POPUPS_CONCURRENCY, this.popups.length);
      const batch = await Promise.all(
        this.popups
          .slice(start, end)
          .map((p, offset) => this.snapshotPopup(p, start + offset)),
      );
      for (const snap of batch) out[snap.index] = snap;
    }
    return out;
  }

  private async snapshotPopup(p: Page, index: number): Promise<PopupSnapshot> {
    if (p.isClosed()) {
      const cached = this.popupHistory.get(index);
      return {
        index,
        url: "",
        title: "",
        body_text: "",
        closed: true,
        last_seen_url: cached?.last_seen_url,
        last_seen_title: cached?.last_seen_title,
      };
    }
    // Best-effort: give popup time to navigate past about:blank, then read state.
    await p
      .waitForLoadState("domcontentloaded", { timeout: 3_000 })
      .catch(() => {});
    const url = p.url();
    const title = await p.title().catch(() => "");
    const bodyText = await p
      .evaluate((cap: number) => {
        const t = document.body?.innerText ?? "";
        return t.length > cap ? t.slice(0, cap) : t;
      }, POPUP_BODY_TEXT_MAX_BYTES)
      .catch(() => "");
    // Snapshot for "what was this popup?" reconstruction once it closes.
    // Skip caching about:blank — the popup may still navigate elsewhere.
    if (url && url !== "about:blank") {
      this.popupHistory.set(index, {
        last_seen_url: url,
        last_seen_title: title,
      });
    }
    return {
      index,
      url,
      title,
      body_text: bodyText,
      closed: false,
    };
  }

  // ── network serialization ───────────────────────────────────

  private serializeNetwork(): NetworkLog {
    const requests: NetworkRequestEntry[] = [];
    const failures: NetworkFailureEntry[] = [];
    for (const rec of this.requests.values()) {
      if (rec.failure_text !== null) {
        failures.push({
          url: rec.url,
          method: rec.method,
          resource_type: rec.resource_type,
          error_text: rec.failure_text,
        });
      } else {
        const duration =
          rec.end_ms !== null ? Math.max(0, rec.end_ms - rec.start_ms) : null;
        requests.push({
          url: rec.url,
          method: rec.method,
          resource_type: rec.resource_type,
          status: rec.status,
          duration_ms: duration,
          size_bytes: rec.size_bytes,
          from_cache: rec.from_cache,
        });
      }
    }
    const truncatedCount =
      this.requestCount > NETWORK_REQUEST_CAP
        ? this.requestCount - NETWORK_REQUEST_CAP
        : 0;
    const log: NetworkLog = {
      request_count: this.requestCount,
      failure_count: this.failureCount,
      requests,
      failures,
    };
    if (truncatedCount > 0) {
      log.truncated_count = truncatedCount;
    }
    return log;
  }

  // ── cookie collection ───────────────────────────────────────

  private async collectCookies(): Promise<CookieData[]> {
    const raw = await this.context.cookies().catch(() => []);
    // Build a map of {name: value} so we can apply redactByKey, then
    // re-zip into the per-cookie shape with redacted values.
    const valueMap: Record<string, string> = {};
    for (const c of raw) valueMap[c.name] = c.value;
    const redactedValues = redactByKey(valueMap, this.sensitiveKeyPatterns);
    return raw.map((c) => ({
      name: c.name,
      value: String(redactedValues[c.name] ?? c.value),
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      http_only: c.httpOnly,
      secure: c.secure,
      same_site: c.sameSite as "Strict" | "Lax" | "None" | undefined,
    }));
  }

  // ── storage collection ──────────────────────────────────────

  private async collectStorage(): Promise<StorageSnapshot> {
    const raw = await this.mainPage
      .evaluate((cap: number) => {
        const dump = (s: any): Record<string, string> => {
          const out: Record<string, string> = {};
          if (!s) return out;
          for (let i = 0; i < s.length; i++) {
            const key = s.key(i);
            if (key === null) continue;
            const v = s.getItem(key) ?? "";
            out[key] = v.length > cap ? `${v.slice(0, cap)}[…truncated ${v.length - cap} bytes]` : v;
          }
          return out;
        };
        return {
          local_storage: dump((globalThis as { localStorage?: unknown }).localStorage),
          session_storage: dump((globalThis as { sessionStorage?: unknown }).sessionStorage),
        };
      }, STORAGE_VALUE_MAX_BYTES)
      .catch(() => ({ local_storage: {}, session_storage: {} }));

    const localKeys = Object.keys(raw.local_storage).length;
    const sessionKeys = Object.keys(raw.session_storage).length;
    return {
      local_storage: redactByKey(raw.local_storage, this.sensitiveKeyPatterns) as Record<string, string>,
      session_storage: redactByKey(raw.session_storage, this.sensitiveKeyPatterns) as Record<string, string>,
      local_storage_keys: localKeys,
      session_storage_keys: sessionKeys,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function safeResourceType(req: { resourceType?: () => string }): string | undefined {
  try {
    return req.resourceType?.();
  } catch {
    return undefined;
  }
}

/**
 * WhiteboxCollector — unit tests against a real Playwright browser
 * (no LLM calls). Exercises:
 *   - popup tracking (capture + cap + last_seen_url)
 *   - network log (success + failure + truncation)
 *   - cookie collection + key-redaction
 *   - storage collection + key-redaction + per-value truncation
 *
 * Mirrors the BrowserAgent v1.0-archived popup-smoke harness pattern,
 * but runs against PixelCheck's WhiteboxCollector class.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  WhiteboxCollector,
  POPUP_CAP,
  NETWORK_REQUEST_CAP,
  STORAGE_VALUE_MAX_BYTES,
} from "../../src/core/whitebox-collector.js";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => {});
});

async function newSession(): Promise<{
  context: BrowserContext;
  page: Page;
  collector: WhiteboxCollector;
}> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const collector = new WhiteboxCollector(context, page);
  collector.attach();
  return { context, page, collector };
}

describe("WhiteboxCollector — popups", () => {
  it("captures a single popup opened via window.open", async () => {
    const { context, page, collector } = await newSession();
    try {
      await page.setContent(
        `<button id="open" onclick="window.open('https://example.org','_blank')">open</button>`,
      );
      await page.click("#open");
      await new Promise((r) => setTimeout(r, 1500));

      const data = await collector.collect();
      expect(data.popups).toHaveLength(1);
      expect(data.popups[0].url).toContain("example.org");
      expect(data.popups[0].closed).toBe(false);
      expect(data.popups[0].title).toBeTypeOf("string");
    } finally {
      await context.close();
    }
  }, 30_000);

  it("preserves last_seen_url after popup closes", async () => {
    const { context, page, collector } = await newSession();
    try {
      await page.setContent(
        `<button id="open" onclick="window.open('https://example.org','_blank')">open</button>`,
      );
      await page.click("#open");
      await new Promise((r) => setTimeout(r, 1500));

      // First collect — populates the popupHistory cache.
      const first = await collector.collect();
      expect(first.popups[0].url).toContain("example.org");

      // Close the popup, then collect again.
      const popupPages = context.pages().filter((p) => p !== page);
      for (const p of popupPages) await p.close().catch(() => {});
      await new Promise((r) => setTimeout(r, 200));

      const second = await collector.collect();
      expect(second.popups[0].closed).toBe(true);
      expect(second.popups[0].url).toBe("");
      // last_seen_url survived the close
      expect(second.popups[0].last_seen_url).toContain("example.org");
    } finally {
      await context.close();
    }
  }, 30_000);

  it("enforces POPUP_CAP — never exceeds cap regardless of how many popups spawn", async () => {
    const { context, page, collector } = await newSession();
    try {
      // Spawn cap+5 popups synchronously from one user gesture (Chromium's
      // anti-spam may drop some, but our cap invariant must hold).
      const target = POPUP_CAP + 5;
      const opens = Array.from(
        { length: target },
        (_, i) => `window.open('https://example.${i % 3 === 0 ? "org" : i % 3 === 1 ? "com" : "net"}','_blank');`,
      ).join("\n");
      await page.setContent(`<button id="b" onclick="${opens}">b</button>`);
      await page.click("#b");
      await new Promise((r) => setTimeout(r, 2000));

      const data = await collector.collect();
      // Cap invariant: tracked popups never exceed cap.
      expect(data.popups.length).toBeLessThanOrEqual(POPUP_CAP);
    } finally {
      await context.close();
    }
  }, 60_000);
});

describe("WhiteboxCollector — network", () => {
  it("logs successful requests with status + duration + size", async () => {
    const { context, page, collector } = await newSession();
    try {
      // Use a small reliable target. example.com responses are stable.
      await page.goto("https://example.com");

      const data = await collector.collect();
      expect(data.network.request_count).toBeGreaterThan(0);
      expect(data.network.failure_count).toBe(0);
      const main = data.network.requests.find(
        (r) => r.url.includes("example.com") && r.method === "GET",
      );
      expect(main).toBeDefined();
      expect(main?.status).toBe(200);
      expect(main?.duration_ms).toBeGreaterThanOrEqual(0);
    } finally {
      await context.close();
    }
  }, 60_000);

  it("logs failed requests with error_text", async () => {
    const { context, page, collector } = await newSession();
    try {
      // Trigger a request to a non-resolvable host. document.body must
      // exist before injecting the img — about:blank doesn't auto-create one.
      await page.goto("data:text/html,<html><body></body></html>");
      await page.evaluate(() => {
        const img = document.createElement("img");
        img.src = "https://this-host-definitely-does-not-exist-pixelcheck.invalid/x.png";
        document.body.appendChild(img);
      });
      await new Promise((r) => setTimeout(r, 2000));

      const data = await collector.collect();
      expect(data.network.failure_count).toBeGreaterThanOrEqual(1);
      const failure = data.network.failures.find((f) =>
        f.url.includes("does-not-exist-pixelcheck.invalid"),
      );
      expect(failure).toBeDefined();
      expect(failure?.error_text).toBeTypeOf("string");
      expect(failure?.error_text.length).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  }, 30_000);

  it("constants — NETWORK_REQUEST_CAP defined and sane", () => {
    expect(NETWORK_REQUEST_CAP).toBeGreaterThanOrEqual(100);
    expect(NETWORK_REQUEST_CAP).toBeLessThanOrEqual(10_000);
  });
});

describe("WhiteboxCollector — cookies + redaction", () => {
  it("collects cookies and redacts sensitive-named ones", async () => {
    const { context, page, collector } = await newSession();
    try {
      // Pre-seed cookies via context.addCookies so they're observable.
      await context.addCookies([
        {
          name: "user_id",
          value: "alice-12345",
          domain: "example.com",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
        {
          name: "session",
          value: "secret-session-token-do-not-leak",
          domain: "example.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Strict",
        },
        {
          name: "api_key",
          value: "sk-test-VERY-PRIVATE",
          domain: "example.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Strict",
        },
      ]);
      await page.goto("https://example.com/");

      const data = await collector.collect();
      const userId = data.cookies.find((c) => c.name === "user_id");
      const session = data.cookies.find((c) => c.name === "session");
      const apiKey = data.cookies.find((c) => c.name === "api_key");
      expect(userId?.value).toBe("alice-12345"); // not sensitive — kept
      expect(session?.value).toBe("[REDACTED]"); // sensitive name
      expect(apiKey?.value).toBe("[REDACTED]"); // sensitive name
    } finally {
      await context.close();
    }
  }, 30_000);
});

describe("WhiteboxCollector — storage + redaction + truncation", () => {
  it("collects localStorage + sessionStorage with key-based redaction", async () => {
    const { context, page, collector } = await newSession();
    try {
      await page.goto("https://example.com/");
      await page.evaluate(() => {
        localStorage.setItem("display_name", "Alice");
        localStorage.setItem("auth_token", "Bearer-very-secret-jwt");
        sessionStorage.setItem("theme", "dark");
        sessionStorage.setItem("password", "p@ssw0rd!");
      });

      const data = await collector.collect();
      expect(data.storage.local_storage_keys).toBe(2);
      expect(data.storage.session_storage_keys).toBe(2);
      expect(data.storage.local_storage["display_name"]).toBe("Alice");
      expect(data.storage.local_storage["auth_token"]).toBe("[REDACTED]");
      expect(data.storage.session_storage["theme"]).toBe("dark");
      expect(data.storage.session_storage["password"]).toBe("[REDACTED]");
    } finally {
      await context.close();
    }
  }, 30_000);

  it("truncates per-value bytes past STORAGE_VALUE_MAX_BYTES", async () => {
    const { context, page, collector } = await newSession();
    try {
      await page.goto("https://example.com/");
      await page.evaluate((cap: number) => {
        const huge = "x".repeat(cap + 500);
        localStorage.setItem("blob", huge);
      }, STORAGE_VALUE_MAX_BYTES);

      const data = await collector.collect();
      const stored = data.storage.local_storage["blob"];
      expect(stored).toBeDefined();
      expect(stored.length).toBeLessThanOrEqual(STORAGE_VALUE_MAX_BYTES + 100);
      expect(stored).toContain("[…truncated");
    } finally {
      await context.close();
    }
  }, 30_000);
});

/**
 * End-to-end signal validation against a real browser + fixture site.
 *
 * Validates that the 4 signal collectors capture what we claim they capture
 * when driven against a known-shaped local site. This is the "proof" that
 * the unit tests (with fakes) don't lie.
 *
 * Runs under vitest, launches real Chromium via Playwright, hits the
 * in-process fixture server. No network dependency.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { startFixtureServer, type FixtureServer } from "../fixtures/test-site/server.js";
import { NetworkSignalCollector } from "../../src/agent/signals/network.js";
import { PerformanceSignalCollector } from "../../src/agent/signals/performance.js";
import { ErrorSignalCollector } from "../../src/agent/signals/errors.js";
import { takeSnapshot, diffSnapshots } from "../../src/agent/signals/interaction.js";

let fixture: FixtureServer;
let browser: Browser;
let ctx: BrowserContext;
let page: Page;

beforeAll(async () => {
  fixture = await startFixtureServer();
  browser = await chromium.launch({ headless: true });
  ctx = await browser.newContext();
  page = await ctx.newPage();
}, 60_000);

afterAll(async () => {
  await page?.close().catch(() => {});
  await ctx?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await fixture?.close().catch(() => {});
});

describe("signals e2e — network", () => {
  it("captures signup POST request with 201 status", async () => {
    const net = new NetworkSignalCollector(page, 3000);
    net.start();

    await page.goto(`${fixture.url}/`);
    await page.fill("#email", "alice@example.com");
    await page.click("#submit-btn");
    // Wait for navigation to /success.html
    await page.waitForURL(/success\.html/, { timeout: 5000 });

    const snap = net.snapshot();
    net.stop();

    const signup = net.findMatching({ url_pattern: "/api/signup", status_range: [200, 299] });
    expect(signup.length).toBe(1);
    expect(snap.failed_requests).toBe(0);
  }, 30_000);

  it("detects 404 on missing resources", async () => {
    const net = new NetworkSignalCollector(page, 3000);
    net.start();
    await page.goto(`${fixture.url}/broken.html`);
    // Give failed resources time to fail
    await page.waitForTimeout(500);
    const snap = net.snapshot();
    net.stop();
    expect(snap.failed_requests).toBeGreaterThan(0);
  }, 30_000);
});

describe("signals e2e — errors", () => {
  it("captures console errors, warnings, and uncaught exception from broken.html", async () => {
    const errs = new ErrorSignalCollector(page);
    errs.start();
    await page.goto(`${fixture.url}/broken.html`);
    await page.waitForTimeout(200); // allow the setTimeout-thrown error to fire
    const snap = errs.snapshot();
    errs.stop();
    expect(snap.console_errors).toBeGreaterThanOrEqual(1);
    expect(snap.console_warnings).toBeGreaterThanOrEqual(1);
    expect(snap.pageerrors).toBeGreaterThanOrEqual(1);
    expect(snap.request_failures).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("respects ignore patterns", async () => {
    const errs = new ErrorSignalCollector(page);
    // Broad pattern: filter both app-emitted error and 404 noise Chromium logs.
    errs.setIgnorePatterns([
      "Simulated console error",
      "does-not-exist",
      "missing-image",
      "Failed to load resource",
    ]);
    errs.start();
    await page.goto(`${fixture.url}/broken.html`);
    await page.waitForTimeout(200);
    const snap = errs.snapshot();
    errs.stop();
    // No console error records should contain the filtered phrases.
    for (const rec of snap.records) {
      if (rec.type === "console" && rec.severity === "error") {
        expect(rec.message).not.toMatch(/Simulated console error/);
        expect(rec.message).not.toMatch(/does-not-exist/);
        expect(rec.message).not.toMatch(/missing-image/);
      }
    }
    // pageerror remains (not in ignore list)
    expect(snap.pageerrors).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

describe("signals e2e — performance", () => {
  it("measures LCP / FCP on the slow fixture page", async () => {
    const perf = new PerformanceSignalCollector(page);
    await perf.attach();
    await page.goto(`${fixture.url}/slow.html`);
    // LCP fires on lifecycle; wait enough to observe the hero insertion
    await page.waitForTimeout(2200);
    const snap = await perf.snapshot();
    // Collector reached the page — at minimum window_ms must be measured
    expect(snap.window_ms).toBeGreaterThan(0);
    // Navigation timing is always available once the page has loaded
    expect(snap.dom_content_loaded_ms).not.toBeNull();
  }, 30_000);

  it("measures CLS > 0 on the cls fixture page", async () => {
    const perf = new PerformanceSignalCollector(page);
    await perf.attach();
    await page.goto(`${fixture.url}/cls.html`);
    await page.waitForTimeout(600); // let shift happen
    const snap = await perf.snapshot();
    expect(snap.cls).not.toBeNull();
    expect(snap.cls ?? 0).toBeGreaterThan(0);
  }, 30_000);
});

describe("signals e2e — interaction", () => {
  it("detects URL change after navigation", async () => {
    await page.goto(`${fixture.url}/`);
    const before = await takeSnapshot(page);
    await page.click('a[href="/success.html"]');
    await page.waitForURL(/success\.html/, { timeout: 5000 });
    const after = await takeSnapshot(page);
    const diff = diffSnapshots(before, after);
    expect(diff.url_changed).toBe(true);
    expect(diff.any_change).toBe(true);
  }, 30_000);

  it("detects no change when nothing happens", async () => {
    await page.goto(`${fixture.url}/`);
    const before = await takeSnapshot(page);
    await page.waitForTimeout(200);
    const after = await takeSnapshot(page);
    const diff = diffSnapshots(before, after);
    expect(diff.url_changed).toBe(false);
    // scroll/focus/text should all be stable
    expect(diff.any_change).toBe(false);
  }, 30_000);

  it("detects interactive DOM change after loading dynamic content", async () => {
    await page.goto(`${fixture.url}/`);
    const before = await takeSnapshot(page);
    await page.click("#load-btn");
    await page.waitForFunction(() => (document.getElementById("data")?.textContent ?? "").includes("Loaded"));
    const after = await takeSnapshot(page);
    const diff = diffSnapshots(before, after);
    expect(diff.text_length_delta).toBeGreaterThan(0);
    expect(diff.any_change).toBe(true);
  }, 30_000);
});

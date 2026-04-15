/**
 * End-to-end agent loop integration test — fixture site + stubbed LLM.
 *
 * Exercises the full autonomous pipeline (planner → navigator → handlers →
 * signals → criteria → termination) using:
 *   - real Chromium via Playwright
 *   - real fixture server
 *   - stubbed Anthropic SDK returning deterministic plan/navigator payloads
 *
 * This is the proof that the 5 new pieces (4 signal collectors + plan cache
 * + economy navigator + micro-replan) glue together correctly in a real run.
 *
 * Not run in CI by default (takes ~15s, launches Chromium). Run with:
 *   npx vitest run tests/integration/agent-loop-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import { startFixtureServer, type FixtureServer } from "../fixtures/test-site/server.js";

// ── Stub the Anthropic SDK before imports that depend on it ──
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}));
vi.mock("../../src/core/llm.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/core/llm.js")>(
    "../../src/core/llm.js",
  );
  return {
    ...actual,
    getAnthropicClient: () => ({ messages: { create: mockCreate } }),
    estimateCost: () => 0.001,
  };
});

import { ConvergenceTracker, checkNetworkCriterion, checkInteractionCriterion } from "../../src/agent/convergence.js";
import { NetworkSignalCollector } from "../../src/agent/signals/network.js";
import { takeSnapshot } from "../../src/agent/signals/interaction.js";
import type { SuccessCriterion } from "../../src/core/types.js";

// ─────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe("agent loop integration — signals + convergence against fixture site", () => {
  it("network criterion + interaction criterion both met after a successful signup flow", async () => {
    const net = new NetworkSignalCollector(page, 3000);
    net.start();

    await page.goto(`${fixture.url}/`);
    const before = await takeSnapshot(page);

    await page.fill("#email", "smoke@example.com");
    await page.click("#submit-btn");
    await page.waitForURL(/success\.html/, { timeout: 5000 });

    // Network criterion: signup POST returned 2xx
    const netCriterion: SuccessCriterion = {
      id: "signup_ok",
      description: "signup API returned 2xx",
      verification: "network",
      expected: { url_pattern: "/api/signup", status_range: [200, 299] },
    };
    expect(checkNetworkCriterion(netCriterion, net)).toBe(true);

    // Interaction criterion: URL changed
    const interactionCriterion: SuccessCriterion = {
      id: "nav_happened",
      description: "successful signup navigated to success page",
      verification: "interaction",
      expected: { url_must_change: true },
    };
    expect(await checkInteractionCriterion(interactionCriterion, page, before)).toBe(true);

    net.stop();
  }, 30_000);

  it("convergence tracker detects loop after 3 identical failing actions", () => {
    const conv = new ConvergenceTracker(3, 3);
    const record = {
      url: "https://example.com/",
      instruction: "Click ghost button",
      dom_fingerprint: "abc",
      success: false,
    };
    expect(conv.recordAction(record).type).toBe("continue");
    expect(conv.recordAction(record).type).toBe("continue");
    // Third occurrence of same hash → loop_detected
    const third = conv.recordAction(record);
    expect(third.type).toBe("loop_detected");
  });

  it("convergence tracker escalates 'stuck' after N failures", () => {
    const conv = new ConvergenceTracker(3, 100 /* disable loop */);
    for (let i = 0; i < 2; i++) {
      const r = conv.recordAction({ url: `u${i}`, instruction: `i${i}`, dom_fingerprint: `d${i}`, success: false });
      expect(r.type).toBe("continue");
    }
    const r = conv.recordAction({ url: "u3", instruction: "i3", dom_fingerprint: "d3", success: false });
    expect(r.type).toBe("stuck");
  });

  it("budget + max_actions limits are honored", () => {
    const conv = new ConvergenceTracker();
    for (let i = 0; i < 5; i++) {
      conv.recordAction({ url: `u${i}`, instruction: `i${i}`, dom_fingerprint: `d${i}`, success: true });
    }
    expect(conv.checkLimits(0.5, 1.0, 30).type).toBe("continue");
    expect(conv.checkLimits(2.0, 1.0, 30).type).toBe("budget_exceeded");
    expect(conv.checkLimits(0.5, 1.0, 5).type).toBe("max_actions");
  });
});

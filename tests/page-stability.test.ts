/**
 * Tests for src/core/page-stability.ts — Layer 1 stability gate.
 * Mocks Playwright's Page object so tests run instantly without launching
 * Chromium. Each phase (network idle / DOM stable / hydration) has its own
 * test path covering happy path + timeout + closed-page error + assumed-stable
 * fallback.
 */

import { describe, it, expect, vi } from "vitest";
import { waitForPageStable } from "../src/core/page-stability.js";
import type { Page } from "playwright";

interface PageMockHooks {
  waitForLoadState?: (state: string, opts?: unknown) => Promise<void>;
  evaluate?: (...args: unknown[]) => Promise<unknown>;
}

function makePage(hooks: PageMockHooks = {}): Page {
  return {
    waitForLoadState: hooks.waitForLoadState ?? (async () => undefined),
    evaluate: hooks.evaluate ?? (async () => true),
  } as unknown as Page;
}

describe("waitForPageStable — happy path", () => {
  it("returns all-true when every phase resolves green", async () => {
    const page = makePage({
      waitForLoadState: async () => undefined,
      evaluate: async () => true,
    });
    const r = await waitForPageStable(page);
    expect(r.networkIdle).toBe(true);
    expect(r.domStable).toBe(true);
    expect(r.hydrated).toBe(true);
    expect(r.totalMs).toBeGreaterThanOrEqual(0);
  });
});

describe("waitForPageStable — networkIdle phase", () => {
  it("flags networkIdle=false when waitForLoadState rejects (timeout)", async () => {
    const page = makePage({
      waitForLoadState: async () => {
        throw new Error("Timeout 2666ms exceeded");
      },
      evaluate: async () => true,
    });
    const r = await waitForPageStable(page);
    expect(r.networkIdle).toBe(false);
    // Other phases still ran
    expect(r.domStable).toBe(true);
    expect(r.hydrated).toBe(true);
  });

  it("skips networkIdle when skipNetwork=true", async () => {
    const calls: string[] = [];
    const page = makePage({
      waitForLoadState: async (state: string) => {
        calls.push(state);
      },
    });
    const r = await waitForPageStable(page, { skipNetwork: true });
    expect(calls).toEqual([]);
    expect(r.networkIdle).toBe(false);
  });
});

describe("waitForPageStable — DOM phase", () => {
  it("reflects evaluate() returning true (DOM settled)", async () => {
    const page = makePage({ evaluate: async () => true });
    const r = await waitForPageStable(page, { skipNetwork: true, skipHydration: true });
    expect(r.domStable).toBe(true);
  });

  it("reflects evaluate() returning false (DOM kept mutating until deadline)", async () => {
    let callIdx = 0;
    const page = makePage({
      evaluate: async () => {
        callIdx++;
        // First call = DOM phase → return false (mutating)
        if (callIdx === 1) return false;
        // Second call = hydration phase → return true
        return true;
      },
    });
    const r = await waitForPageStable(page, { skipNetwork: true });
    expect(r.domStable).toBe(false);
    expect(r.hydrated).toBe(true);
  });

  it("reports domStable=false when page is closed mid-evaluate", async () => {
    let callIdx = 0;
    const page = makePage({
      evaluate: async () => {
        callIdx++;
        if (callIdx === 1) {
          throw new Error("Target page, context or browser has been closed");
        }
        return true;
      },
    });
    const r = await waitForPageStable(page, { skipNetwork: true });
    expect(r.domStable).toBe(false);
  });

  it("assumes domStable=true when evaluate throws unrelated error", async () => {
    let callIdx = 0;
    const page = makePage({
      evaluate: async () => {
        callIdx++;
        if (callIdx === 1) throw new Error("CSP blocked unsafe-eval");
        return true;
      },
    });
    const r = await waitForPageStable(page, { skipNetwork: true });
    expect(r.domStable).toBe(true);
  });

  it("skips DOM phase when skipDom=true", async () => {
    let domCalls = 0;
    const page = makePage({
      evaluate: async () => {
        domCalls++;
        return true;
      },
    });
    const r = await waitForPageStable(page, {
      skipNetwork: true,
      skipDom: true,
    });
    // Only the hydration evaluate ran
    expect(domCalls).toBe(1);
    expect(r.domStable).toBe(false);
  });
});

describe("waitForPageStable — hydration phase", () => {
  it("reflects evaluate() return value", async () => {
    let idx = 0;
    const page = makePage({
      evaluate: async () => {
        idx++;
        if (idx === 1) return true; // DOM
        return false; // hydration says not hydrated
      },
    });
    const r = await waitForPageStable(page, { skipNetwork: true });
    expect(r.hydrated).toBe(false);
  });

  it("assumes hydrated=true when hydration evaluate throws", async () => {
    let idx = 0;
    const page = makePage({
      evaluate: async () => {
        idx++;
        if (idx === 1) return true; // DOM ok
        throw new Error("Execution context was destroyed");
      },
    });
    const r = await waitForPageStable(page, { skipNetwork: true });
    expect(r.hydrated).toBe(true);
  });

  it("skips hydration when skipHydration=true", async () => {
    let calls = 0;
    const page = makePage({
      evaluate: async () => {
        calls++;
        return true;
      },
    });
    const r = await waitForPageStable(page, {
      skipNetwork: true,
      skipDom: true,
      skipHydration: true,
    });
    expect(calls).toBe(0);
    expect(r.hydrated).toBe(false);
  });
});

describe("waitForPageStable — totalMs accounting", () => {
  it("totalMs is non-negative and bounded by deltas of Date.now", async () => {
    const page = makePage();
    const before = Date.now();
    const r = await waitForPageStable(page, {
      skipNetwork: true,
      skipDom: true,
      skipHydration: true,
    });
    const after = Date.now();
    expect(r.totalMs).toBeGreaterThanOrEqual(0);
    expect(r.totalMs).toBeLessThanOrEqual(after - before + 50);
  });
});

describe("waitForPageStable — phase timeout division", () => {
  it("forwards a phase timeout = floor(opt.timeout / 3) to waitForLoadState", async () => {
    let captured = -1;
    const page = makePage({
      waitForLoadState: async (_state: string, opts?: unknown) => {
        captured = (opts as { timeout: number }).timeout;
      },
      evaluate: async () => true,
    });
    await waitForPageStable(page, { timeout: 9000 });
    expect(captured).toBe(3000);
  });

  it("forwards waitMs to the DOM evaluate (= phaseTimeout)", async () => {
    const page = makePage({
      evaluate: vi.fn(async () => true),
    });
    await waitForPageStable(page, { timeout: 9000, skipNetwork: true });
    const evalMock = page.evaluate as unknown as ReturnType<typeof vi.fn>;
    // First call is DOM phase: (fn, waitMs)
    expect(evalMock.mock.calls[0][1]).toBe(3000);
  });
});

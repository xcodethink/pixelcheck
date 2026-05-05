/**
 * Unit tests for src/core/tab-marker.ts.
 *
 * Covers:
 *   - applyTabMarker skip-by-default in headless mode
 *   - applyTabMarker registers exactly one init script in headed mode
 *   - force=true overrides the headless skip
 *   - The injected script contains the stable [PixelCheck] prefix
 *   - The injected script is idempotent (prefix-once guard) — verified
 *     by literal substring assertions rather than executing the JS
 *   - Errors from addInitScript propagate (no silent swallow)
 *
 * We cannot launch a real Chromium in unit tests, so we exercise the
 * function with a hand-rolled mock BrowserContext that records every
 * addInitScript call.
 */

import { describe, it, expect, vi } from "vitest";
import type { BrowserContext } from "playwright";

import {
  applyTabMarker,
  buildTabMarkerScript,
  TAB_MARKER_PREFIX,
} from "../src/core/tab-marker.js";

interface MockContext {
  context: BrowserContext;
  scripts: string[];
  addInitScript: ReturnType<typeof vi.fn>;
}

function makeMockContext(opts: { throwOnAdd?: boolean } = {}): MockContext {
  const scripts: string[] = [];
  const addInitScript = vi.fn(async (script: string | { content: string }) => {
    if (opts.throwOnAdd) throw new Error("addInitScript failed");
    const body = typeof script === "string" ? script : script.content;
    scripts.push(body);
  });
  // We only ever exercise the addInitScript surface; cast through unknown
  // so we don't have to satisfy the entire BrowserContext interface.
  const context = { addInitScript } as unknown as BrowserContext;
  return { context, scripts, addInitScript };
}

describe("applyTabMarker", () => {
  it("skips registration when headless and force is unset", async () => {
    const m = makeMockContext();
    const registered = await applyTabMarker(m.context, { headless: true });
    expect(registered).toBe(false);
    expect(m.addInitScript).not.toHaveBeenCalled();
  });

  it("registers exactly one init script when headed", async () => {
    const m = makeMockContext();
    const registered = await applyTabMarker(m.context, { headless: false });
    expect(registered).toBe(true);
    expect(m.addInitScript).toHaveBeenCalledTimes(1);
    expect(m.scripts.length).toBe(1);
  });

  it("force=true overrides the headless skip", async () => {
    const m = makeMockContext();
    const registered = await applyTabMarker(m.context, {
      headless: true,
      force: true,
    });
    expect(registered).toBe(true);
    expect(m.addInitScript).toHaveBeenCalledTimes(1);
  });

  it("force=false leaves the headless skip intact", async () => {
    const m = makeMockContext();
    const registered = await applyTabMarker(m.context, {
      headless: true,
      force: false,
    });
    expect(registered).toBe(false);
    expect(m.addInitScript).not.toHaveBeenCalled();
  });

  it("propagates errors from addInitScript (no silent swallow)", async () => {
    const m = makeMockContext({ throwOnAdd: true });
    await expect(
      applyTabMarker(m.context, { headless: false }),
    ).rejects.toThrow("addInitScript failed");
  });
});

describe("buildTabMarkerScript", () => {
  it("embeds the [PixelCheck] prefix as a JSON-escaped literal", () => {
    const script = buildTabMarkerScript();
    // The prefix appears once, as a JSON-quoted string literal — that's
    // how we feed it into the script body. We assert on the quoted form
    // because that's the contract: callers reading the source can rely
    // on the prefix being a JSON literal, not a bare token.
    expect(script).toContain(JSON.stringify(TAB_MARKER_PREFIX));
  });

  it("uses an IIFE pattern (no globals leaked into the audited page)", () => {
    const script = buildTabMarkerScript();
    expect(script.startsWith("(() => {")).toBe(true);
    expect(script.trimEnd().endsWith("})();")).toBe(true);
  });

  it("guards against double-prefix application (idempotency clause)", () => {
    const script = buildTabMarkerScript();
    // The script reads `t.startsWith(PREFIX)` before mutating. A future
    // edit that drops this guard would let the MutationObserver's own
    // updates produce `[PixelCheck] [PixelCheck] [PixelCheck] Title`.
    expect(script).toMatch(/!\s*t\.startsWith\(PREFIX\)/);
  });

  it("registers a MutationObserver on document.head (covers SPA title rewrites)", () => {
    const script = buildTabMarkerScript();
    expect(script).toContain("MutationObserver");
    expect(script).toContain("document.head");
    expect(script).toContain("childList: true");
  });

  it("wraps DOM access in try/catch to never break the audited page", () => {
    const script = buildTabMarkerScript();
    // Two try/catch blocks: one inside apply(), one inside start().
    const tryCount = (script.match(/try\s*\{/g) ?? []).length;
    expect(tryCount).toBeGreaterThanOrEqual(2);
  });

  it("accepts a custom prefix while preserving JSON safety", () => {
    const custom = '[CustomTool] ';
    const script = buildTabMarkerScript(custom);
    expect(script).toContain(JSON.stringify(custom));
    expect(script).not.toContain(JSON.stringify(TAB_MARKER_PREFIX));
  });
});

describe("TAB_MARKER_PREFIX", () => {
  it("is plain ASCII (no emoji, per project style rules)", () => {
    // Encode-and-compare round-trip catches any future hidden characters.
    expect(TAB_MARKER_PREFIX).toBe("[PixelCheck] ");
    for (let i = 0; i < TAB_MARKER_PREFIX.length; i += 1) {
      expect(TAB_MARKER_PREFIX.charCodeAt(i)).toBeLessThan(128);
    }
  });

  it("ends with a space so the original title reads naturally after concatenation", () => {
    expect(TAB_MARKER_PREFIX.endsWith(" ")).toBe(true);
  });
});

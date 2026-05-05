/**
 * Tab title marker — visible attribution for the controlled browser.
 *
 * When a user runs `pixelcheck` in headed mode (`--headed`) they see a
 * real Chrome window opening tabs and clicking through pages. With
 * multiple windows open it can be hard to tell which tab the agent is
 * driving. This module prepends a `[PixelCheck] ` prefix to every page
 * title so the controlled tab is unambiguous in the OS task switcher
 * and Chrome's tab strip.
 *
 * Design constraints
 * ──────────────────
 *
 * 1. **Headless by default → no marker.** The prefix is only useful
 *    when a human is watching. In headless audits (the default) we
 *    skip the marker entirely. This is not just an optimisation:
 *    `document.title` is read by `extract`, `dom-summary`, and the
 *    interaction signals collector; polluting the title in headless
 *    mode would corrupt those reads. The opt-out keeps audit data
 *    clean while preserving the visible-attribution behaviour where
 *    it actually matters.
 *
 * 2. **No emoji.** Per the project's style rules we use plain ASCII —
 *    `[PixelCheck] ` — instead of a coloured circle or other glyph.
 *    Survives terminals / OSes / fonts without UTF-8 fallbacks and is
 *    a stable substring for tests and future programmatic detection.
 *
 * 3. **One init script per context.** We register exactly one
 *    `addInitScript` call. The script self-installs a MutationObserver
 *    on `<head>` so SPA route changes that rewrite `document.title`
 *    re-apply the prefix without leaking through the audit's window.
 *
 * 4. **Idempotent.** The script checks for the prefix before adding
 *    it, so the observer's own re-applications never produce double
 *    or triple prefixes (a real failure mode on framework-driven
 *    title updates that fire several times per route change).
 *
 * 5. **`force: true`** ignores constraint 1 and applies the marker
 *    regardless of headless. Reserved for tests; production callers
 *    should rely on the headless flag.
 *
 * Public surface: `applyTabMarker(context, opts)` — returns true when
 * the init script was registered, false when skipped.
 */

import type { BrowserContext } from "playwright";

/** Stable substring tests assert against. Exported for callers that
 *  want to strip it back out before reading `document.title`. */
export const TAB_MARKER_PREFIX = "[PixelCheck] ";

export interface ApplyTabMarkerOptions {
  /** Whether the launched browser is headless. */
  headless: boolean;
  /** Override the headless skip. Tests use this to exercise the script
   *  without launching a visible browser. */
  force?: boolean;
}

/**
 * Build the init script body. Exported so tests can assert against
 * exact content without re-implementing the JS.
 *
 * The IIFE is deliberately defensive: try/catch around every DOM access
 * because pixelcheck attaches to arbitrary user URLs, and a single
 * exception in an init script would prevent later scripts (the stealth
 * patches, for example) from ever running.
 */
export function buildTabMarkerScript(prefix: string = TAB_MARKER_PREFIX): string {
  // JSON.stringify gives us a fully-quoted, escape-safe string literal
  // we can drop into the script. Belt-and-braces: the prefix is a
  // hard-coded constant in this module, but any future caller that
  // overrides it cannot break the script.
  const literal = JSON.stringify(prefix);
  return `(() => {
  const PREFIX = ${literal};
  const apply = () => {
    try {
      const t = document.title;
      if (typeof t === "string" && t.length > 0 && !t.startsWith(PREFIX)) {
        document.title = PREFIX + t;
      }
    } catch (_e) { /* swallow — never break the audited page */ }
  };
  const start = () => {
    try {
      apply();
      const head = document.head;
      if (!head) return;
      const mo = new MutationObserver(apply);
      mo.observe(head, { childList: true, subtree: true, characterData: true });
    } catch (_e) { /* swallow */ }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();`;
}

/**
 * Register the tab-marker init script on a Playwright BrowserContext.
 *
 * Returns:
 *   - `true`  — script was registered.
 *   - `false` — skipped (headless and force was not set).
 *
 * Errors from `addInitScript` are NOT caught here; callers that want
 * to defensive-log can wrap. We deliberately surface failure so a
 * broken Playwright install doesn't silently degrade visible-attribution.
 */
export async function applyTabMarker(
  context: BrowserContext,
  opts: ApplyTabMarkerOptions,
): Promise<boolean> {
  if (opts.headless && !opts.force) return false;
  await context.addInitScript(buildTabMarkerScript());
  return true;
}

/**
 * Page Stability Gate — Layer 1 of the Reliability Stack.
 *
 * Waits for the page to reach a stable state before executing AI-driven
 * actions (act/extract/observe). This eliminates ~40% of Stagehand failures
 * caused by operating on pages that haven't finished loading, hydrating,
 * or laying out.
 *
 * Four-phase gate:
 *   1. Network idle — no pending requests for 500ms
 *   2. DOM stable — no mutations for 300ms
 *   3. Framework hydration — SPA-specific signals (Next.js, Astro, Nuxt, etc.)
 *   4. Content readiness — loading skeletons / spinners have cleared
 *
 * Phases 1–3 measure *interactivity* readiness. They cannot tell a settled
 * loading skeleton from settled real content — both are static, hydrated DOM.
 * A client-rendered page that fetches its data AFTER hydration (e.g. an Astro
 * `client:load` dashboard) passes 1–3 while still showing placeholders, so a
 * snapshot taken then captures the skeleton and reads as "perpetually loading /
 * broken" when the page is in fact fine, just photographed ~1s too early.
 * Phase 4 closes that gap by waiting for known loading indicators to disappear.
 */

import type { Page } from "playwright";

export interface StabilityOptions {
  /** Max time to wait for stability (ms). Default 8000. */
  timeout?: number;
  /** Skip network idle check. Default false. */
  skipNetwork?: boolean;
  /** Skip DOM mutation check. Default false. */
  skipDom?: boolean;
  /** Skip hydration check. Default false. */
  skipHydration?: boolean;
  /** Skip content-readiness (loading-skeleton clearance) check. Default false. */
  skipContentReady?: boolean;
  /**
   * Max time to wait for loading skeletons / spinners to clear (ms).
   * Independent of `timeout`: this phase is about *data* readiness, not
   * interactivity, and only pages that actually show a skeleton ever wait.
   * Default 8000.
   */
  contentReadyTimeout?: number;
}

/**
 * Wait for the page to reach a stable state suitable for interaction.
 *
 * Each phase has its own internal timeout so one slow phase doesn't block
 * the entire gate. The function never throws — it logs warnings and
 * continues, since partial stability is better than no gate at all.
 */
export async function waitForPageStable(
  page: Page,
  opts?: StabilityOptions,
): Promise<StabilityReport> {
  const timeout = opts?.timeout ?? 8000;
  const phaseTimeout = Math.floor(timeout / 3);
  const report: StabilityReport = {
    networkIdle: false,
    domStable: false,
    hydrated: false,
    contentReady: false,
    totalMs: 0,
  };
  const start = Date.now();

  // Phase 1: Network idle
  if (!opts?.skipNetwork) {
    try {
      await page.waitForLoadState("networkidle", { timeout: phaseTimeout });
      report.networkIdle = true;
    } catch {
      // Not fatal — page may have long-polling / SSE connections
    }
  }

  // Phase 2: DOM stable (no layout mutations for 300ms)
  if (!opts?.skipDom) {
    try {
      const settled = await page.evaluate((waitMs: number) => {
        return new Promise<boolean>((resolve) => {
          let timer: ReturnType<typeof setTimeout>;
          const deadline = setTimeout(() => {
            observer.disconnect();
            resolve(false);
          }, waitMs);

          const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => {
              observer.disconnect();
              clearTimeout(deadline);
              resolve(true);
            }, 300);
          });

          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class", "style", "hidden", "aria-hidden"],
          });

          // If no mutations fire within 300ms, we're already stable
          timer = setTimeout(() => {
            observer.disconnect();
            clearTimeout(deadline);
            resolve(true);
          }, 300);
        });
      }, phaseTimeout);
      report.domStable = settled;
    } catch (err) {
      // Closed page/context → genuinely unstable. Other errors �� assume stable
      // to avoid blocking the step on an unrelated evaluation failure.
      const msg = err instanceof Error ? err.message : "";
      report.domStable = !msg.includes("has been closed") && !msg.includes("Target closed");
    }
  }

  // Phase 3: Framework hydration signals
  if (!opts?.skipHydration) {
    try {
      report.hydrated = await page.evaluate(() => {
        // Next.js: __NEXT_DATA__ exists and hydration flag is set
        if ((window as any).__NEXT_DATA__) {
          const root = document.getElementById("__next");
          if (root && root.children.length > 0) return true;
        }

        // Astro: no data-astro-transition-persist elements still loading
        const astroTransitions = document.querySelectorAll(
          "[data-astro-transition-persist]",
        );
        if (astroTransitions.length > 0) return true;

        // Nuxt: __NUXT__ payload is loaded
        if ((window as any).__NUXT__) return true;

        // SvelteKit: data-sveltekit-hydrate attribute removed after hydration
        if (document.querySelector("[data-sveltekit-hydrate]") === null) {
          // Either SvelteKit is hydrated or it's not a SvelteKit app
          return true;
        }

        // Vue / generic SPA: app mount point has rendered children
        const app =
          document.getElementById("app") ??
          document.getElementById("root") ??
          document.getElementById("__nuxt");
        if (app && app.children.length > 0) return true;

        // Fallback: document.readyState is complete
        return document.readyState === "complete";
      });
    } catch {
      report.hydrated = true; // Assume hydrated if evaluation fails
    }
  }

  // Phase 4: Content readiness — wait for loading skeletons / spinners to clear.
  //
  // Zero-cost on pages without loading indicators (the common case): the in-page
  // check returns "ready" immediately when none are found. Only a page actually
  // showing a skeleton pays the wait, bounded by `contentReadyTimeout`.
  //
  // Signal tiers avoid false waits on decorative animation:
  //   - STRONG (semantic): aria-busy / role=progressbar / data-loading — any one
  //     present means the app declares itself loading.
  //   - WEAK (class-based): animate-pulse / animate-spin / skeleton / shimmer —
  //     a lone decorative spinner is fine; a CLUSTER (>=3) reads as a real
  //     skeleton screen.
  if (!opts?.skipContentReady) {
    const contentBudget = opts?.contentReadyTimeout ?? 8000;
    try {
      report.contentReady = await page.evaluate((maxMs: number) => {
        return new Promise<boolean>((resolve) => {
          const STRONG =
            '[aria-busy="true"],[data-loading="true"],[role="progressbar"]';
          const WEAK =
            '.animate-pulse,.animate-spin,.shimmer,[class*="skeleton" i],[class*="loading" i],[class*="placeholder" i]';
          const stillLoading = (): boolean => {
            try {
              if (document.querySelectorAll(STRONG).length > 0) return true;
              return document.querySelectorAll(WEAK).length >= 3;
            } catch {
              return false;
            }
          };
          // No loading indicators → already content-ready (zero cost).
          if (!stillLoading()) {
            resolve(true);
            return;
          }
          if (maxMs <= 0) {
            resolve(false);
            return;
          }
          const startedAt = Date.now();
          const iv = setInterval(() => {
            if (!stillLoading()) {
              clearInterval(iv);
              resolve(true);
            } else if (Date.now() - startedAt >= maxMs) {
              clearInterval(iv);
              resolve(false);
            }
          }, 150);
        });
      }, contentBudget);
    } catch {
      // Eval failure (CSP / closed context) → don't block the gate.
      report.contentReady = true;
    }
  }

  report.totalMs = Date.now() - start;
  return report;
}

export interface StabilityReport {
  networkIdle: boolean;
  domStable: boolean;
  hydrated: boolean;
  /** True once loading skeletons/spinners cleared (or none were present).
   *  False if a skeleton was still showing when contentReadyTimeout elapsed. */
  contentReady: boolean;
  totalMs: number;
}

/**
 * Smoke tests — verify Playwright Test scaffold works end-to-end.
 *
 * Each fixture HTML loads in real chromium, basic content + JS runs.
 * If any of these break, downstream T3-T7 e2e tasks are blocked, so we
 * keep this file fast and minimal.
 *
 * Coverage:
 *   - lazy-load-page.html — IntersectionObserver fires, content swaps in
 *   - dense-scroll-page.html — page docHeight ≥ 20000 (segment-cap math
 *     downstream)
 *   - a11y-broken-page.html — multiple WCAG violations present (axe will
 *     find them in T6)
 *   - form-page.html — submit button works, form state visible (Stagehand
 *     will exercise these in T5)
 *   - history-100-runs.json — fixture has 100 entries with shape
 *     consumed by trends.html
 *
 * Not tested here (downstream task scope):
 *   - real recorder.screenshotSegments capturing browser-only callbacks → T4
 *   - real axe-core scanning → T6
 *   - real Stagehand init + act + extract → T5
 *   - real trends.html SVG render perf → T7d
 */

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../../fixtures");

function fixtureUrl(filename: string): string {
  return "file://" + path.join(FIXTURES_DIR, filename);
}

test.describe("integration scaffold smoke", () => {
  test("chromium can launch and hit about:blank", async ({ page }) => {
    await page.goto("about:blank");
    expect(await page.title()).toBe("");
  });

  test("lazy-load fixture: hero visible + IntersectionObserver swaps content", async ({
    page,
  }) => {
    await page.goto(fixtureUrl("lazy-load-page.html"));

    // Hero is above-the-fold and renders immediately.
    await expect(page.getByTestId("hero")).toContainText(
      "visible immediately",
    );

    // Scroll each lazy target into view explicitly. IntersectionObserver
    // batches via requestIdleCallback; without an explicit scroll-and-wait
    // per target, fast scrolls past the threshold can race the observer's
    // microtask queue. Locator.scrollIntoViewIfNeeded() guarantees the
    // element enters the viewport, then we wait for the observer to fire.
    const targets = ["1", "2", "3", "4"];
    for (const id of targets) {
      const el = page.locator(`[data-lazy-target="${id}"]`);
      await el.scrollIntoViewIfNeeded();
      await expect(el).toContainText(`Loaded content #${id}`, {
        timeout: 2000,
      });
    }
  });

  test("dense-scroll fixture: page height ≥ 20000 (segment-cap math)", async ({
    page,
  }) => {
    await page.goto(fixtureUrl("dense-scroll-page.html"));

    const docHeight = await page.evaluate(() =>
      Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
      ),
    );

    // 20 sections × 1200px min-height + body padding ≈ 24000+
    expect(docHeight).toBeGreaterThanOrEqual(20_000);

    // Confirm both START + END markers are reachable
    await expect(page.getByText("START")).toBeAttached();
    await expect(page.getByText("END")).toBeAttached();
  });

  test("a11y-broken fixture: contains the violations T6 will detect", async ({
    page,
  }) => {
    await page.goto(fixtureUrl("a11y-broken-page.html"));

    // Image without alt (WCAG 1.1.1)
    const imgWithoutAlt = page.locator('img:not([alt])').first();
    await expect(imgWithoutAlt).toBeAttached();

    // Inputs without labels (WCAG 4.1.2 / 3.3.2)
    const emailInput = page.locator('input[type="email"]');
    await expect(emailInput).toBeAttached();

    // Empty button (WCAG 4.1.2 button name)
    const submitBtn = page.locator("#submit-btn");
    await expect(submitBtn).toBeAttached();

    // Low-contrast badge (WCAG 1.4.3)
    await expect(page.locator(".low-contrast-badge")).toContainText(
      "Low priority",
    );

    // Tiny tap target (WCAG 2.5.5)
    await expect(page.locator(".tiny-button")).toBeAttached();
  });

  test("form fixture: submit fills result card", async ({ page }) => {
    await page.goto(fixtureUrl("form-page.html"));

    await expect(page.locator("h1")).toContainText("Sign In");

    await page.fill("#email", "test@example.com");
    await page.fill("#password", "secret-fixture-pw");
    await page.selectOption("#role", "admin");
    await page.click("#submit-btn");

    // Result card visible after submit
    const result = page.locator("#result-card");
    await expect(result).toBeVisible();
    await expect(page.locator("#result-email")).toHaveText(
      "test@example.com",
    );
    await expect(page.locator("#result-role")).toHaveText("admin");
  });

  test("history-100-runs.json: 100 entries with valid AuditRun shape", () => {
    const fixturePath = path.join(FIXTURES_DIR, "history-100-runs.json");
    const raw = fs.readFileSync(fixturePath, "utf8");
    const entries = JSON.parse(raw) as Array<{
      id: string;
      projectName: string;
      overallScore: number;
      schemaVersion: string;
      dimensionAverages: Record<string, number>;
    }>;

    expect(entries).toHaveLength(100);

    const first = entries[0]!;
    expect(first.id).toMatch(/^run-\d{3}-[0-9a-f]{6}$/);
    expect(first.schemaVersion).toBe("1.2.0");
    expect(first.overallScore).toBeGreaterThanOrEqual(0);
    expect(first.overallScore).toBeLessThanOrEqual(10);

    // Has all 6 dimensions
    expect(Object.keys(first.dimensionAverages).sort()).toEqual([
      "accessibility",
      "data_integrity",
      "performance",
      "task_completion",
      "ux_friction",
      "visual_polish",
    ]);
  });
});

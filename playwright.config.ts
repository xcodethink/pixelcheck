/**
 * Playwright Test config — integration test runner.
 *
 * Why a second test runner alongside vitest:
 *   - vitest = unit + module integration (fast, mocked browser via Page mock)
 *   - Playwright Test = real browser integration (chromium spawn, real DOM,
 *     real intersection observer / lazy load / network)
 *
 * The two runners are complementary and never overlap:
 *   - tests/*.test.ts                   → vitest (default suite)
 *   - tests/integration/*.test.ts       → vitest (integration, except race)
 *   - tests/integration/file-lock-race.test.ts → vitest (forks pool, M9-3.2)
 *   - tests/integration/playwright/**.test.ts  → Playwright Test (this config)
 *
 * Tests under this config exercise things that mocked Page can't:
 *   - recorder.ts page.evaluate inner browser-only callbacks (T4)
 *   - Stagehand init() + act() / extract() against real DOM (T5)
 *   - real axe-core scanning a real a11y-broken page (T6)
 *   - reporter-pdf.ts real chromium PDF export (T4)
 *   - audit_url full pipeline against fixture URL (T7b MCP stdio e2e)
 *   - reporter-trends.ts SVG render of 100-row history loaded in real
 *     browser (T7d 100-run perf)
 *
 * To run:
 *   npm run test:integration:playwright
 *
 * To run a single test:
 *   npx playwright test tests/integration/playwright/smoke.test.ts
 *
 * To debug interactively:
 *   npx playwright test --headed --debug
 */

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/integration/playwright",

  // Each test gets up to 30s. Cold chromium spawn ~1s; downstream tasks
  // (real Stagehand init, full audit) may need longer — they bump per-test.
  timeout: 30_000,

  // Retry once on flake. Real-browser tests can be flaky from network
  // jitter / GC / OS scheduling; one retry catches transient noise without
  // hiding real bugs (any test that needs >1 retry is a real flake → fix).
  retries: 2,

  // Cap workers low to avoid cross-fixture interference. We have ~5 fixture
  // pages; running many in parallel can cause file:// or webserver
  // contention that masks real bugs.
  workers: 2,

  // Fail fast on CI: if 5 tests fail, stop. On local, keep running so
  // developers see the full picture.
  maxFailures: process.env.CI ? 5 : undefined,

  // Reporter: list (one line per test) for CI legibility; html for local
  // debugging via `npx playwright show-report`.
  reporter: process.env.CI
    ? [["list"], ["github"]]
    : [["list"], ["html", { open: "never" }]],

  use: {
    // No baseURL — fixture pages use file:// or are explicitly targeted
    // per test with full URL. Future tasks may add a webServer (e.g.,
    // for tests that need http:// to load module scripts).
    headless: true,

    // Trace on first retry: lets us debug flakes via
    // `npx playwright show-trace` without recording every run.
    trace: "on-first-retry",

    // Screenshot on failure: stored at test-results/<test>/test-failed-1.png
    screenshot: "only-on-failure",

    // Video on retry: high signal for race conditions
    video: "on-first-retry",

    // Default viewport — matches reporter-pdf.ts production defaults so
    // PDF render tests behave the same as production audits.
    viewport: { width: 1280, height: 720 },
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    // Future: { name: "firefox" } / { name: "webkit" } when M4-* lands
  ],

  // Outputs go to test-results/ (gitignored)
  outputDir: "test-results/",
});

# Playwright integration tests

Real-browser integration tests scoped to **what mocked Page can't cover**.
For unit / module tests, use vitest under `tests/`.

## When to add tests here

- A bug or feature requires real `page.evaluate()` execution against a real
  DOM (intersection observer, scroll behaviour, layout, etc.)
- A primitive needs end-to-end validation (Stagehand init, real chromium
  PDF export, real axe-core scan)
- A regression slipped past unit tests because mocked Page returned
  fake data

## When NOT to add tests here

- Pure logic that can be unit-tested with mocked Page → `tests/<module>.test.ts`
- Anything testable with vitest at the module boundary
- "Happy path" smoke that won't catch the bugs you're worried about

## How to run

```bash
npm run test:integration:playwright          # full suite
npx playwright test smoke                    # single file
npx playwright test --headed --debug         # interactive debug
npx playwright show-report                   # open last HTML report
npx playwright show-trace test-results/...   # view trace on failure
```

## Fixtures

All fixture HTML files live under `tests/fixtures/`. **Only static HTML +
inline JS** — no build step, no external network, no LLM calls. This keeps
fixtures reproducible across machines + CI.

If you need an HTTP server (e.g., for tests that require module scripts or
service workers), add a `webServer` config to `playwright.config.ts` —
don't reach for `fetch()` on remote URLs.

## Fixture inventory

| File | Purpose | Used by |
|---|---|---|
| `tests/fixtures/lazy-load-page.html` | IntersectionObserver lazy load | T4 (recorder browser-only) |
| `tests/fixtures/dense-scroll-page.html` | docHeight ≥ 20000 (segment-cap) | T4 |
| `tests/fixtures/a11y-broken-page.html` | Multi-WCAG violations | T6 (real axe + SARIF) |
| `tests/fixtures/form-page.html` | Login form for act+extract | T5 (Stagehand smoke) |
| `tests/fixtures/history-100-runs.json` | 100 fake AuditRun history | T7d (trends perf) |

To regenerate `history-100-runs.json`: `npx tsx scripts/gen-history-fixture.ts`
(deterministic seed, byte-for-byte reproducible).

## Why a separate runner from vitest

vitest is great for unit + module-boundary tests, but mocking Playwright's
Page is fundamentally limited:

- `page.evaluate(() => { ... })` runs in chromium — jsdom can't replicate
  intersection observer, layout, or browser-only async APIs (e.g.
  `requestAnimationFrame`, `MutationObserver` on real DOM mutations).
- Real Stagehand spawns Chromium with a 5s cold-start; running it inside
  vitest worker threads is slow and flaky.
- Real `axe-core` scans a real DOM — we want to verify our wcag.ts catalog
  matches what axe actually emits.

Playwright Test is the dedicated runner for these. It manages browser
lifecycle, parallelism, screenshots, traces, and retries.

## Adding a new test

1. If it needs a new fixture, add HTML to `tests/fixtures/`.
2. Update `tests/fixtures/` table above + the fixture inventory.
3. Write `tests/integration/playwright/<name>.test.ts`.
4. Run `npm run test:integration:playwright` to verify.
5. Update [CONTRIBUTING.md](../../../CONTRIBUTING.md) if a new fixture
   pattern emerges.

## CI integration

Playwright Test runs on `ubuntu-latest` only (chromium pre-installed via
`actions/setup-node`). The default `npm test` does NOT include this suite —
it's `npm run test:integration:playwright` for explicit invocation. CI gate
configured in `.github/workflows/integration.yml` (T26 task).

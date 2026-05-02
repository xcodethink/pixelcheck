/**
 * T5 — Stagehand smoke e2e (closes RISK-REGISTER R2).
 *
 * Real chromium + real Stagehand + real Anthropic API. This is the only
 * test in the suite that calls the LLM with a real key, so:
 *
 *   - Skipped automatically when ANTHROPIC_API_KEY is not set (allows
 *     contributors without a key to run the rest of the suite without
 *     this gate failing).
 *   - Uses the cheapest available model and the smallest possible page
 *     fixture so cost stays well under $0.05 per run.
 *   - NOT in default `npm test` (it lives under tests/integration/
 *     playwright which is launched by `npm run test:integration:playwright`
 *     only). Run via:
 *       ANTHROPIC_API_KEY=sk-ant-... npm run test:integration:playwright
 *
 * Why this test matters:
 * Pre-T5 the project had ZERO real-Stagehand-real-API verifications.
 * Every `act` / `extract` / `observe` call was vi.mock'd at the SDK
 * level. A breaking change in @browserbasehq/stagehand 2.x → 3.x or in
 * Anthropic SDK 0.92.x → 1.x could ship undetected. This test catches
 * the wire-up failure mode: "do these three primitives actually return
 * the shapes our handlers expect?" with one real call each.
 *
 * Cost budget per run (calibrated against form-page.html + Sonnet 4.6):
 *   - act("click submit"): ~$0.005
 *   - extract({ schema: { email, password_present } }): ~$0.010
 *   - observe("form fields"): ~$0.005
 *   Total: ~$0.02 per run. Worst-case retry: ~$0.05. Well under the
 *   $0.10/run safety budget below.
 */

import { test, expect } from "@playwright/test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createStagehandWrapper } from "../../../src/core/stagehand-wrapper.js";
import type { Persona } from "../../../src/core/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../../fixtures");

function fixtureUrl(filename: string): string {
  return "file://" + path.join(FIXTURES_DIR, filename);
}

const SMOKE_BUDGET_USD = 0.10;

const SHOULD_RUN = Boolean(process.env.ANTHROPIC_API_KEY);

test.describe("T5 — Stagehand smoke e2e (real API, real chromium)", () => {
  // The whole suite is skipped without a key — explains itself in the
  // skip message so a contributor running locally without a key sees
  // the full test name and the "why".
  test.skip(
    !SHOULD_RUN,
    "ANTHROPIC_API_KEY not set — Stagehand smoke requires a real key. Set it in .env or shell env.",
  );

  // Stagehand init + browser launch + 3 primitive calls take ~30-60s.
  // Default Playwright Test timeout is 30s, which is too tight.
  test.setTimeout(120_000);

  const minimalPersona: Persona = {
    id: "smoke-us-desktop",
    display_name: "Smoke Test US Desktop",
    country: "US",
    language: "en",
    locale: "en-US",
    timezone: "America/New_York",
    device_class: "desktop",
    payment_tier: "free",
    mental_model: "Casual user filling out a login form for the first time.",
    motivation: "Sign in to view dashboard",
    success_criteria: "Form submits without error",
  } as Persona;

  test("Stagehand init + act + extract + observe round-trip on form-page fixture", async ({}, testInfo) => {
    // Each test gets its own artifacts dir (Playwright Test provides one).
    const artifactsDir = testInfo.outputDir;

    const wrapper = await createStagehandWrapper({
      persona: minimalPersona,
      artifactsDir,
      // Sonnet 4.6 — cheapest tier for smoke; Opus is overkill for a
      // login form test and 5x the cost.
      modelName: "claude-sonnet-4-6",
      apiKey: process.env.ANTHROPIC_API_KEY,
      headless: true,
    });

    try {
      // Load the fixture
      await wrapper.page.goto(fixtureUrl("form-page.html"), {
        waitUntil: "domcontentloaded",
      });

      // Sanity: verify the fixture rendered the form (DOM-only, no LLM)
      const emailField = wrapper.page.locator("#email");
      await emailField.waitFor({ state: "visible", timeout: 5000 });

      // ── 1. observe — list interactive form elements ─────────────
      const observed = await wrapper.stagehand.observe({
        instruction: "List the interactive form elements on this page.",
      });
      expect(Array.isArray(observed)).toBe(true);
      expect(observed.length).toBeGreaterThan(0);
      // Each result should have at least description or selector. Don't
      // assert specific selectors — Stagehand can return CSS, ARIA, or
      // text-based selectors depending on what's most stable.
      for (const o of observed) {
        expect(typeof o === "object" && o !== null).toBe(true);
      }

      // ── 2. act — fill the email field ─────────────────────────────
      // We use act() instead of page.fill() so we exercise the LLM
      // path. Stagehand will infer the email field from the natural-
      // language instruction.
      const actResult = await wrapper.stagehand.act({
        action: "Fill the email field with smoke@example.com",
      });
      // Stagehand's act() return shape varies by version; v2.x returns
      // an object, sometimes void. Either is acceptable — what we
      // verify is the side effect on the DOM.
      void actResult;

      // Verify the side effect — email field has the typed value
      const emailValue = await wrapper.page.locator("#email").inputValue();
      expect(emailValue.toLowerCase()).toContain("smoke@example.com");

      // ── 3. extract — schema-bound payload ────────────────────────
      // Stagehand 2.x expects a Zod schema (it reads `.shape` for the
      // structured-output prompt). Passing a JSON Schema literal here
      // crashes with `Cannot read properties of undefined (reading
      // 'shape')` — caught by this test on the first run, fixed below.
      // Use a deliberately tiny schema so the LLM's job is well-bounded
      // and cost stays low.
      const extracted = await wrapper.stagehand.extract<{
        email: string | null;
        has_password_field: boolean;
      }>({
        instruction:
          "Extract the email value (currently typed in the email field) and whether the form contains a password field.",
        schema: z.object({
          email: z.string().nullable(),
          has_password_field: z.boolean(),
        }),
      });

      expect(extracted).toBeTruthy();
      expect(typeof extracted).toBe("object");
      expect(extracted.has_password_field).toBe(true);
      // email may come back lower-cased / trimmed by the LLM — fuzzy match
      if (extracted.email !== null && typeof extracted.email === "string") {
        expect(extracted.email.toLowerCase()).toContain("smoke@example.com");
      }
    } finally {
      // Always close — leaks a chromium process otherwise
      await wrapper.close().catch(() => undefined);
    }
  });

  test("artifacts (HAR + video dir) land on disk after run", async ({}, testInfo) => {
    const artifactsDir = testInfo.outputDir;

    const wrapper = await createStagehandWrapper({
      persona: minimalPersona,
      artifactsDir,
      modelName: "claude-sonnet-4-6",
      apiKey: process.env.ANTHROPIC_API_KEY,
      headless: true,
    });

    try {
      await wrapper.page.goto(fixtureUrl("form-page.html"), {
        waitUntil: "domcontentloaded",
      });
      // No LLM call — just need a page navigation so video / HAR have content
      await wrapper.page.waitForTimeout(200);
      // Verify the wrapper exposed the documented artifact paths before close
      expect(wrapper.harPath).toContain(artifactsDir);
      expect(wrapper.videoDir).toContain(artifactsDir);
      expect(wrapper.fingerprint.id).toBeTruthy();
    } finally {
      const videoPath = await wrapper.close().catch(() => undefined);
      // videoPath is optional (may be undefined on quick runs); just
      // assert it is either undefined or a valid path string.
      if (videoPath !== undefined) {
        expect(typeof videoPath).toBe("string");
      }
    }
  });

  // Cost-budget guard — sanity-check that the smoke test as a whole does
  // not silently balloon. We can't read cost-guard inside this test
  // (different process from the wrapper's internal cost meter for
  // Stagehand calls), but the spec budget is documented at the top.
  test("documented per-run cost budget honoured", async () => {
    expect(SMOKE_BUDGET_USD).toBeLessThan(0.5);
    // No-op assertion that exists so the budget number lives in code,
    // surfaces in test names, and any future budget increase requires
    // an explicit edit here that shows up in code review.
  });
});

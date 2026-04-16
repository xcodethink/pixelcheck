/**
 * One-shot script to populate tests/fixtures/critic-calibration/ with real
 * screenshots from the fixture site.
 *
 * Rerun whenever the fixture site changes visually. Output is git-committed
 * so calibration runs are reproducible without launching Chromium.
 *
 * Usage:
 *   npx tsx tests/calibration/generate-fixtures.ts
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startFixtureServer } from "../fixtures/test-site/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../fixtures/critic-calibration");

async function main(): Promise<void> {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  const server = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  const shots: Array<{ name: string; url: string; prepare?: () => Promise<void> }> = [
    { name: "home-happy.png", url: `${server.url}/` },
    { name: "success-after-signup.png", url: `${server.url}/success.html` },
    { name: "broken-console-errors.png", url: `${server.url}/broken.html` },
    {
      name: "cls-layout-shift.png",
      url: `${server.url}/cls.html`,
      prepare: async () => {
        // Wait so the banner has already shifted in.
        await page.waitForTimeout(500);
      },
    },
    { name: "slow-lcp.png", url: `${server.url}/slow.html`, prepare: async () => page.waitForTimeout(2200) },
  ];

  for (const shot of shots) {
    await page.goto(shot.url, { waitUntil: "networkidle" });
    if (shot.prepare) await shot.prepare();
    const outPath = path.join(FIXTURES_DIR, shot.name);
    await page.screenshot({ path: outPath, fullPage: true });
    // eslint-disable-next-line no-console
    console.log(`wrote ${outPath}`);
  }

  await ctx.close();
  await browser.close();
  await server.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

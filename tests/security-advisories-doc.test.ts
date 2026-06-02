import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

/**
 * G4 regression: the CI comment used to claim "0 vulnerabilities" while
 * `npm audit` actually reports 17 LOW advisories. These guards keep the docs
 * honest so that claim can't silently return.
 */
describe("security advisories documentation (G4)", () => {
  it("SECURITY.md documents the known low advisories + their single root cause", () => {
    const sec = read("SECURITY.md");
    expect(sec).toMatch(/Known low advisories/);
    expect(sec).toContain("@ai-sdk/provider-utils");
    // the dev-only moderate is disclosed too
    expect(sec).toContain("brace-expansion");
  });

  it("the ci.yml audit step no longer claims a bare 'reports 0 vulnerabilities'", () => {
    const ci = read(".github/workflows/ci.yml");
    // The audit step must qualify its claim to "moderate-or-higher" and point
    // at the SECURITY.md advisory disclosure.
    expect(ci).not.toMatch(/reports\s+\*?0 vulnerabilities/i);
    expect(ci).toMatch(/0 MODERATE-or-higher/);
    expect(ci).toMatch(/17 LOW advisories/);
    expect(ci).toContain("SECURITY.md");
  });

  it("SECURITY.md's post-v3 result line is qualified, not an absolute zero claim", () => {
    const sec = read("SECURITY.md");
    expect(sec).toMatch(/0 moderate-or-higher findings/);
  });
});

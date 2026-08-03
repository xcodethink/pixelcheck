import { describe, it, expect } from "vitest";
import { BANNED, EXEMPT_SELF_TEST } from "../scripts/check-no-internal-refs.js";

/**
 * The gate that keeps internal identifiers out of a public repository, tested
 * against the shapes that actually occur.
 *
 * It had no test, and that is how the gap survived. The header of the script
 * records the same failure once already: the first version banned only the
 * hyphenated forms someone expected, so it reported clean while the real
 * identifiers went past it into a published tarball. It was then fixed for the
 * `R`, `T` and `M` shapes — and still missed `G` and `B`, which is what the
 * repository was actually using. Twenty-two occurrences were sitting in it:
 * test names, a `SECURITY.md` paragraph, two workflow comments, and five
 * comments in `src/`, which matter most because `tsconfig.json` does not set
 * `removeComments` and every source comment compiles into `dist` and ships.
 *
 * A gate written from memory of the naming scheme will keep missing whichever
 * prefix nobody thought of. What this pins is both directions: the shapes in
 * use are caught, and the things that merely look like them are not — because
 * a gate that flags real content trains people to widen the exemption list,
 * and the next real identifier goes through with it.
 */

function offenders(text: string): string[] {
  return BANNED.filter((b) => b.pattern.test(text)).map((b) => b.label);
}

describe("identifiers the gate must catch", () => {
  it.each([
    ["G3", 'describe("observer dashboards (G3)", () => {'],
    ["G4", 'describe("security advisories documentation (G4)", () => {'],
    ["B1", "* B1 fix (v1.0.1): every loadPersonas() call site goes through this"],
    ["B2", " * B2 regression: every URL-taking MCP tool must run the SSRF guard"],
    ["B5", '* personas in its post-scaffold message (B5 fix: was hardcoded "(6)").'],
    ["two at once", 'describe("MCP meta tool: get_last_report (G3 / B3 path sandbox)"'],
  ])("flags %s", (_label, line) => {
    expect(offenders(line)).toContain("internal workstream id");
  });

  it("still flags the shapes it already knew about", () => {
    // The G/B pattern was added alongside these; a mistake in it must not
    // quietly disable the others.
    expect(offenders("T22 covers this")).toContain("internal task id");
    expect(offenders("R36 in the register")).toContain("risk id");
    expect(offenders("landed in M9-4")).toContain("milestone label");
    expect(offenders("Wave 3 shipped it")).toContain("iteration label");
  });
});

describe("things that only look like identifiers", () => {
  it("does not flag B64, which means base64", () => {
    // Measured: with the digit count left at `\d{1,2}` this matched the
    // literal `B64` in a vision test. Widening a gate until it flags real
    // content, then editing the content to quieten it, is the wrong way
    // round — so the pattern narrowed instead.
    expect(offenders('await p.vision("B64", "describe", {')).not.toContain(
      "internal workstream id",
    );
  });

  it("does not flag B2B", () => {
    expect(offenders("the B2B checkout flow")).not.toContain("internal workstream id");
  });

  it("does not flag a hex colour", () => {
    expect(offenders("background: #B3D9FF;")).not.toContain("internal workstream id");
  });

  it("does not flag a word ending in G or B", () => {
    expect(offenders("the SVG2 spec")).not.toContain("internal workstream id");
    expect(offenders("in debug2 mode")).not.toContain("internal workstream id");
  });

  it("leaves ADR numbers alone — they are public and meant to be cited", () => {
    expect(offenders("see ADR-004 for the reasoning")).toEqual([]);
  });

  it("leaves an ISO timestamp alone", () => {
    // The date/time separator would otherwise read as task T04, which is in
    // every release record.
    expect(offenders("2026-07-29T04:43:43Z")).toEqual([]);
  });

  it("leaves CVE and version identifiers alone", () => {
    expect(offenders("CVE-2026-1234 affects v1.4.4")).toEqual([]);
  });
});

describe("the repository itself", () => {
  it("has no pattern that matches the empty string", () => {
    // A pattern that matches everything would make the gate report every file
    // and be switched off, which is worse than the gap it was meant to close.
    for (const b of BANNED) expect(b.pattern.test("")).toBe(false);
  });

  it("exempts exactly this file, and nothing else", () => {
    // This file has to contain the identifiers it tests for, so the gate
    // skips it. That is a hole, and a hole that grows stops being a gate —
    // hence an exact path rather than a prefix, and this assertion on the
    // length. A second entry here needs its own reason.
    expect(EXEMPT_SELF_TEST).toEqual(["tests/internal-refs-gate.test.ts"]);
  });

  it("gives every rule a replacement to use instead", () => {
    // Being told a name is banned without being told what to write is how the
    // banned name ends up in the exemption list.
    for (const b of BANNED) expect(b.instead.length).toBeGreaterThan(0);
  });
});

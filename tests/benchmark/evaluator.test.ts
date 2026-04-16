/**
 * Tests for the deterministic evaluator predicates.
 * The program_html path is exercised separately against the fixture site.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateStringMatch,
  evaluateUrlMatch,
  evaluateExactMatch,
} from "../../src/benchmark/evaluator.js";

describe("evaluateStringMatch", () => {
  it("returns false when no refs provided", () => {
    expect(evaluateStringMatch("hi", undefined).passed).toBe(false);
  });

  it("matches must_include (case insensitive)", () => {
    const r = evaluateStringMatch("The Laptop costs $400", { must_include: ["laptop", "$400"] });
    expect(r.passed).toBe(true);
  });

  it("fails on missing must_include", () => {
    const r = evaluateStringMatch("only price shown", { must_include: ["laptop"] });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/laptop/);
  });

  it("fails on must_exclude hit", () => {
    const r = evaluateStringMatch("Error: failed to pay", { must_exclude: ["error"] });
    expect(r.passed).toBe(false);
  });

  it("exact_match strict", () => {
    expect(evaluateStringMatch("yes", { exact_match: "yes" }).passed).toBe(true);
    expect(evaluateStringMatch("yes please", { exact_match: "yes" }).passed).toBe(false);
  });

  it("fuzzy_match requires >= half of keywords", () => {
    const refs = { fuzzy_match: ["red", "blue", "green", "yellow"] };
    expect(evaluateStringMatch("it's red and blue", refs).passed).toBe(true); // 2/4
    expect(evaluateStringMatch("it's red only", refs).passed).toBe(false); // 1/4
  });
});

describe("evaluateUrlMatch", () => {
  it("exact mode ignores trailing slash and query", () => {
    const r = evaluateUrlMatch("https://x.com/cart/?utm=abc", {
      reference_url: "https://x.com/cart",
      reference_url_match: "exact",
    });
    expect(r.passed).toBe(true);
  });

  it("prefix mode", () => {
    const r = evaluateUrlMatch("https://x.com/cart/item/123", {
      reference_url: "https://x.com/cart",
      reference_url_match: "prefix",
    });
    expect(r.passed).toBe(true);
  });

  it("substring mode", () => {
    const r = evaluateUrlMatch("https://x.com/success.html", {
      reference_url: "/success.html",
      reference_url_match: "substring",
    });
    expect(r.passed).toBe(true);
  });

  it("returns failure with no reference_url", () => {
    const r = evaluateUrlMatch("https://x.com/", { reference_url_match: "exact" });
    expect(r.passed).toBe(false);
  });
});

describe("evaluateExactMatch", () => {
  it("strips surrounding whitespace", () => {
    expect(evaluateExactMatch("  42  ", "42").passed).toBe(true);
  });

  it("fails on case difference (intentional — exact)", () => {
    expect(evaluateExactMatch("Yes", "yes").passed).toBe(false);
  });

  it("returns false when expected is undefined", () => {
    expect(evaluateExactMatch("anything", undefined).passed).toBe(false);
  });
});

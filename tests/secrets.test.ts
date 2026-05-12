/**
 * Tests for src/core/secrets.ts — admin cookies, Stripe env defaults,
 * redact patterns, and string + deep redaction. Restores process.env in
 * afterEach so test order is independent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildAdminCookies,
  buildRedactPatterns,
  getStripeSecrets,
  redact,
  redactDeep,
} from "../src/core/secrets.js";

const savedEnv = { ...process.env };

beforeEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

describe("buildAdminCookies", () => {
  it("returns [] when adminUrl is undefined", () => {
    expect(buildAdminCookies(undefined)).toEqual([]);
  });

  it("returns [] when SCAMLENS_ADMIN_COOKIE env is unset", () => {
    delete process.env.SCAMLENS_ADMIN_COOKIE;
    expect(buildAdminCookies("https://admin.example.com")).toEqual([]);
  });

  it("parses a single name=value cookie", () => {
    process.env.SCAMLENS_ADMIN_COOKIE = "session=abc123";
    const cookies = buildAdminCookies("https://admin.example.com/login");
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe("session");
    expect(cookies[0].value).toBe("abc123");
    expect(cookies[0].domain).toBe("admin.example.com");
    expect(cookies[0].path).toBe("/");
    expect(cookies[0].httpOnly).toBe(true);
    expect(cookies[0].secure).toBe(true);
    expect(cookies[0].sameSite).toBe("Lax");
  });

  it("parses multiple semicolon-separated cookies", () => {
    process.env.SCAMLENS_ADMIN_COOKIE = "a=1; b=2; c=3";
    const cookies = buildAdminCookies("https://x.example/");
    expect(cookies.map((c) => `${c.name}=${c.value}`)).toEqual([
      "a=1",
      "b=2",
      "c=3",
    ]);
  });

  it("preserves '=' inside the cookie value", () => {
    process.env.SCAMLENS_ADMIN_COOKIE = "token=abc=def==";
    const cookies = buildAdminCookies("https://x.example/");
    expect(cookies[0].name).toBe("token");
    expect(cookies[0].value).toBe("abc=def==");
  });

  it("marks cookies non-secure for http://", () => {
    process.env.SCAMLENS_ADMIN_COOKIE = "s=1";
    const cookies = buildAdminCookies("http://localhost:3000/");
    expect(cookies[0].secure).toBe(false);
    expect(cookies[0].domain).toBe("localhost");
  });

  it("skips malformed pairs (no '=' or empty name)", () => {
    process.env.SCAMLENS_ADMIN_COOKIE = "a=1; bad-pair; =empty; c=3";
    const cookies = buildAdminCookies("https://x.example/");
    expect(cookies.map((c) => c.name)).toEqual(["a", "c"]);
  });
});

describe("getStripeSecrets", () => {
  it("returns env values when set", () => {
    process.env.STRIPE_TEST_CARD_NUMBER = "4000000000000077";
    process.env.STRIPE_TEST_CARD_EXP = "01/29";
    process.env.STRIPE_TEST_CARD_CVC = "999";
    process.env.STRIPE_TEST_PUBLISHABLE_KEY = "pk_test_xyz";
    expect(getStripeSecrets()).toEqual({
      "stripe.card_number": "4000000000000077",
      "stripe.exp": "01/29",
      "stripe.cvc": "999",
      "stripe.pk_test": "pk_test_xyz",
    });
  });

  it("falls back to documented defaults when env is unset", () => {
    delete process.env.STRIPE_TEST_CARD_NUMBER;
    delete process.env.STRIPE_TEST_CARD_EXP;
    delete process.env.STRIPE_TEST_CARD_CVC;
    delete process.env.STRIPE_TEST_PUBLISHABLE_KEY;
    expect(getStripeSecrets()).toEqual({
      "stripe.card_number": "4242424242424242",
      "stripe.exp": "12/30",
      "stripe.cvc": "123",
      "stripe.pk_test": "",
    });
  });
});

describe("buildRedactPatterns", () => {
  it("returns the config patterns when no secrets in env", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.SCAMLENS_ADMIN_COOKIE;
    delete process.env.SLACK_WEBHOOK;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.STRIPE_TEST_PUBLISHABLE_KEY;
    delete process.env.TEST_GOOGLE_US_PASSWORD;
    delete process.env.TEST_GOOGLE_JP_PASSWORD;
    delete process.env.TEST_GOOGLE_DE_PASSWORD;
    delete process.env.TEST_GOOGLE_CN_PASSWORD;
    expect(buildRedactPatterns(["custom-pattern"])).toEqual(["custom-pattern"]);
  });

  it("auto-adds non-empty secret env vars (≥ 8 chars)", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-1234567890abcdef";
    process.env.SLACK_WEBHOOK = "https://hooks.slack.com/aaaa";
    const patterns = buildRedactPatterns([]);
    expect(patterns).toContain("sk-ant-1234567890abcdef");
    expect(patterns).toContain("https://hooks.slack.com/aaaa");
  });

  it("ignores secrets shorter than 4 chars", () => {
    process.env.ANTHROPIC_API_KEY = "abc";
    expect(buildRedactPatterns([])).toEqual([]);
  });

  it("includes secrets with 4+ chars", () => {
    process.env.ANTHROPIC_API_KEY = "abcd";
    expect(buildRedactPatterns([])).toEqual(["abcd"]);
  });

  it("dedupes via Set semantics — same secret only once", () => {
    process.env.ANTHROPIC_API_KEY = "supersecret-12345";
    const patterns = buildRedactPatterns(["supersecret-12345"]);
    expect(patterns.filter((p) => p === "supersecret-12345")).toHaveLength(1);
  });
});

describe("redact", () => {
  it("returns input unchanged when no patterns match", () => {
    expect(redact("hello world", ["xyz"])).toBe("hello world");
  });

  it("replaces every occurrence of each pattern", () => {
    expect(redact("a-secret-a", ["a"])).toBe("[REDACTED]-secret-[REDACTED]");
  });

  it("applies multiple patterns sequentially", () => {
    expect(
      redact("password=hunter2 token=abc", ["hunter2", "abc"]),
    ).toBe("password=[REDACTED] token=[REDACTED]");
  });

  it("ignores empty pattern entries", () => {
    expect(redact("hello", ["", "h"])).toBe("[REDACTED]ello");
  });

  it("is case-sensitive", () => {
    expect(redact("Secret SECRET secret", ["secret"])).toBe("Secret SECRET [REDACTED]");
  });
});

describe("redactDeep", () => {
  const patterns = ["topsecret"];

  it("redacts plain strings", () => {
    expect(redactDeep("contains topsecret value", patterns)).toBe(
      "contains [REDACTED] value",
    );
  });

  it("preserves null and undefined", () => {
    expect(redactDeep(null, patterns)).toBe(null);
    expect(redactDeep(undefined, patterns)).toBe(undefined);
  });

  it("preserves numbers and booleans", () => {
    expect(redactDeep(42, patterns)).toBe(42);
    expect(redactDeep(true, patterns)).toBe(true);
  });

  it("recurses into arrays", () => {
    expect(
      redactDeep(["topsecret", "ok", ["nested topsecret"]], patterns),
    ).toEqual(["[REDACTED]", "ok", ["nested [REDACTED]"]]);
  });

  it("recurses into plain objects", () => {
    const out = redactDeep(
      {
        a: "topsecret",
        nested: { b: "more topsecret here", c: 1 },
        arr: ["topsecret"],
      },
      patterns,
    );
    expect(out).toEqual({
      a: "[REDACTED]",
      nested: { b: "more [REDACTED] here", c: 1 },
      arr: ["[REDACTED]"],
    });
  });

  it("does not mutate the input object", () => {
    const input = { a: "topsecret", b: { c: "topsecret" } };
    const before = JSON.stringify(input);
    redactDeep(input, patterns);
    expect(JSON.stringify(input)).toBe(before);
  });
});

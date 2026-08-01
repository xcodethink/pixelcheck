import { describe, it, expect } from "vitest";
import { redact, redactDeep } from "../src/core/secrets.js";

/**
 * A prefix in `redact_patterns` must redact the whole credential.
 *
 * The gap this closes was invisible because the tests and the product used
 * different configurations. `tests/ci-reporters.test.ts` sets
 * `redact_patterns: ["sk-ant-secret-9999"]` — the complete value — so the
 * substring replace removed all of it and the assertion passed. The config
 * `init` scaffolds for every new project sets prefixes instead:
 *
 *   redact_patterns:
 *     - sk-ant-
 *     - pk_test_
 *     - pk_live_
 *
 * With those, `sk-ant-api03-REALKEY` became `[REDACTED]api03-REALKEY`. The
 * secret survived; only the marker a scanner greps for was removed. So the
 * suite exercised a configuration the product does not ship, and reported the
 * feature as working.
 */

const SCAFFOLDED_PATTERNS = ["sk-ant-", "pk_test_", "pk_live_"];

describe("redact — prefix patterns", () => {
  it("removes the credential, not just the prefix", () => {
    const out = redact(
      "Your session token is sk-ant-api03-REALKEY1234 — keep it private.",
      SCAFFOLDED_PATTERNS,
    );

    expect(out).not.toContain("api03");
    expect(out).not.toContain("REALKEY1234");
    expect(out).toContain("[REDACTED]");
    // The surrounding prose is untouched: over-redaction of ordinary text
    // would make reports unreadable and push people to turn this off.
    expect(out).toBe("Your session token is [REDACTED] — keep it private.");
  });

  it.each([
    ["sk-ant-", "sk-ant-api03-abc_DEF-123"],
    ["pk_test_", "pk_test_51H8sK2eZvKYlo2C"],
    ["pk_live_", "pk_live_51H8sK2eZvKYlo2C"],
  ])("consumes the full token after %s", (_prefix, secret) => {
    const out = redact(`value=${secret};`, SCAFFOLDED_PATTERNS);
    expect(out).toBe("value=[REDACTED];");
  });

  it("still fully redacts a pattern given as a complete value", () => {
    // The environment-variable path adds whole secrets, and that behaviour
    // must not change.
    const key = "sk-ant-secret-9999";
    expect(redact(`Saw token ${key} in the page`, [key])).toBe(
      "Saw token [REDACTED] in the page",
    );
  });

  it("stops at characters that cannot belong to a token", () => {
    const out = redact(
      'header: "sk-ant-abc123", trailing text',
      SCAFFOLDED_PATTERNS,
    );
    expect(out).toBe('header: "[REDACTED]", trailing text');
  });

  it("redacts every occurrence, not only the first", () => {
    const out = redact("a sk-ant-one b sk-ant-two c", SCAFFOLDED_PATTERNS);
    expect(out).toBe("a [REDACTED] b [REDACTED] c");
  });

  it("leaves text alone when no pattern matches", () => {
    const text = "Nothing sensitive here: user@example.com, 192.0.2.1";
    expect(redact(text, SCAFFOLDED_PATTERNS)).toBe(text);
  });

  it("treats the pattern literally, never as a regex", () => {
    // A config value may contain any character. Interpreting it would make a
    // stray `.` or `*` silently over- or under-match.
    expect(redact("a.c and abc", ["a.c"])).toBe("[REDACTED] and abc");
  });

  it("skips empty pattern entries instead of matching everywhere", () => {
    // An empty pattern matches at every index; without the guard the scan
    // would never advance.
    expect(redact("abc", [""])).toBe("abc");
    // And a real pattern still takes its trailing token with it.
    expect(redact("abc", ["", "b"])).toBe("a[REDACTED]");
  });
});

describe("redactDeep — the shape reports actually pass through", () => {
  it("reaches nested strings inside a report payload", () => {
    const payload = {
      issue: "Saw sk-ant-api03-LEAK on the dashboard",
      results: [{ steps: [{ error: "pk_live_51ABCdef failed" }] }],
    };

    const out = redactDeep(payload, SCAFFOLDED_PATTERNS);

    const blob = JSON.stringify(out);
    expect(blob).not.toContain("api03");
    expect(blob).not.toContain("LEAK");
    expect(blob).not.toContain("51ABCdef");
  });
});

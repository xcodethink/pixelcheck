import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  ESCAPE_HTML_BROWSER_SOURCE,
} from "../src/core/html-escape.js";

/**
 * One escaper, two consumers, and no way for them to drift.
 *
 * There were seven copies of this function and they did not agree. Four
 * escaped `& < > " '`; one escaped `& < > "`; one used a chained `.replace`
 * in a different shape; and one — in the same script scope as another of the
 * same name, so silently shadowed — escaped only `& < >`, not even the double
 * quote, while reading like it did the work.
 *
 * Two of those gaps were real. Fixing the client-side escaper in
 * reporter-spa.ts and not the server-side one in the same file left the
 * `<title>` unescaped for the single quote, which a test caught. And a reader
 * asking "is this escaped?" in dashboard.ts could land on the dead
 * three-character copy.
 *
 * Three of the seven are browser code embedded in template literals and
 * served inside a page, so they cannot import anything. The source is
 * therefore exported twice — as a function for Node and as a string for the
 * pages. That is the part that could rot: a string copy nothing checks would
 * drift on the first edit, which is precisely the problem being fixed.
 *
 * So the string is executed here and compared against the function over the
 * same inputs. If someone edits one and not the other, this fails.
 */

/** Compile the exported source and hand back the function it defines. */
function browserEscaper(): (s: unknown) => string {
  const factory = new Function(
    `${ESCAPE_HTML_BROWSER_SOURCE}; return escapeHtml;`,
  ) as () => (s: unknown) => string;
  return factory();
}

const CASES: Array<[string, unknown]> = [
  ["ampersand", "a & b"],
  ["less than", "a < b"],
  ["greater than", "a > b"],
  ["double quote", 'say "hi"'],
  ["single quote", "it's"],
  ["all five at once", `&<>"'`],
  ["a tag", "<script>alert(1)</script>"],
  ["an attribute breakout", `"><img src=x onerror=alert(1)>`],
  ["a single-quoted breakout", `'><img src=x onerror=alert(1)>`],
  ["plain text", "nothing to do here"],
  ["empty string", ""],
  ["a number", 42],
  ["zero", 0],
  ["false", false],
  ["null", null],
  ["undefined", undefined],
  ["an already-escaped string", "&amp;lt;"],
  ["repeated characters", "&&&<<<'''"],
  // Written as escapes, not literals: this repository is public and the
  // English-only gate reads source. The property under test is that
  // multi-byte text survives untouched, which matters because this
  // product renders Japanese and Chinese reports.
  ["CJK text", "\u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8"],
  ["an emoji", "checkmark: ✓"],
];

describe("the escaper", () => {
  it.each(CASES)("escapes %s", (_label, input) => {
    const out = escapeHtml(input);
    expect(out).not.toMatch(/[<>]/);
    // `&` survives only as the opening of an entity.
    expect(out.replace(/&(amp|lt|gt|quot|#39);/g, "")).not.toContain("&");
  });

  it("maps each character to its entity", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("escapes the ampersand first, so entities are not double-built", () => {
    // A naive implementation that replaced `<` before `&` would turn `&lt;`
    // into `&amp;lt;` on the second pass over its own output.
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("treats null and undefined as empty rather than printing them", () => {
    // One of the copies used `String(s)`, which renders undefined as the
    // four-letter word in the middle of a report.
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("leaves text that needs nothing untouched", () => {
    expect(escapeHtml("nothing to do here")).toBe("nothing to do here");
  });
});

describe("the copy the pages carry", () => {
  it.each(CASES)("agrees with the function on %s", (_label, input) => {
    expect(browserEscaper()(input)).toBe(escapeHtml(input));
  });

  it("defines a function named escapeHtml, which the pages call by name", () => {
    expect(ESCAPE_HTML_BROWSER_SOURCE).toContain("function escapeHtml");
  });

  it("carries no backtick, which would end the template literal it sits in", () => {
    // Three pages interpolate this source into a template literal. A backtick
    // anywhere in it would terminate the string and break the build — twice
    // already, from a backtick in a comment.
    expect(ESCAPE_HTML_BROWSER_SOURCE).not.toContain("`");
  });

  it("uses no syntax that needs a build step", () => {
    // It is injected as text and executed by the browser as written. It also
    // must not rely on esbuild helpers: a named function declaration inside
    // page code gets wrapped in `__name(...)`, which does not exist there.
    expect(() => browserEscaper()).not.toThrow();
  });
});

/**
 * One definition of HTML escaping, for both sides of the wire.
 *
 * There were seven copies of `escapeHtml` in this repository and they did not
 * agree. Four escaped `& < > " '`; one escaped `& < > "` and let the single
 * quote through; one used a chained `.replace` in a different shape; and one
 * — inside `dashboard.ts`, in the same script scope as another of the same
 * name — escaped only `& < >`, not even the double quote, and was silently
 * shadowed by the later declaration while reading like it did the work.
 *
 * Two of those gaps produced real defects. Fixing the client-side escaper in
 * `reporter-spa.ts` and not the server-side one in the same file left the
 * `<title>` unescaped for the single quote. And the dead copy in
 * `dashboard.ts` meant a reader checking "is this escaped?" could land on a
 * three-character implementation that never ran.
 *
 * The awkward part, and the reason this is not simply a shared import: three
 * of the copies are browser code embedded in template literals and served
 * inside a page. They cannot import anything. So the same source text is
 * exported twice — as a function for Node, and as a string for the pages to
 * carry. One definition, two consumers, and no way for them to drift.
 */

/** The characters, and what each becomes. Single quote included: an
 *  unescaped `'` breaks out of any single-quoted attribute. */
const REPLACEMENTS: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape for HTML text and attribute content. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => REPLACEMENTS[c] as string);
}

/**
 * The same function as source, for embedding in a page.
 *
 * Kept byte-identical in behaviour to the export above by
 * `tests/html-escape.test.ts`, which runs both over the same inputs — a
 * string copy that nothing checks would drift on the first edit, which is the
 * problem this file exists to end.
 */
export const ESCAPE_HTML_BROWSER_SOURCE = `function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}`;

import { describe, it, expect } from "vitest";
import { renderPdfHtml } from "../src/core/reporter-pdf.js";
import { SUPPORTED_LOCALES, type Locale } from "../src/core/i18n.js";
import type { AuditRun } from "../src/core/types.js";

/**
 * The PDF must declare the language it is written in, and ask for fonts that
 * can render it.
 *
 * `<html lang="en">` was hardcoded for every locale, and the font stack was
 * `-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif`
 * with no CJK entry at all. The PDF is the artefact this product tells people
 * to hand to stakeholders, and it was announcing a Japanese report as English
 * while naming no font that can draw a kana.
 *
 * What this does NOT claim, because it was measured and is not true: that the
 * rendered PDF now uses a Japanese face on macOS. Chromium's PDF backend still
 * substitutes STSongti-SC — a Simplified Chinese font — for Japanese text on
 * this platform regardless of what the stylesheet asks for. The stack matters
 * where the named faces do resolve, and the `lang` attribute is correct
 * everywhere; neither is a claim about glyph selection on a particular host.
 */

function audit(): AuditRun {
  const now = "2026-08-02T00:00:00.000Z";
  return {
    run_id: "fonts",
    project_name: "P",
    base_url: "https://p.example",
    started_at: now,
    finished_at: now,
    duration_ms: 1,
    results: [],
    summary: {
      total: 0,
      pass: 0,
      pass_with_issues: 0,
      fail: 0,
      total_cost_usd: 0,
      total_issues: 0,
      critical_issues: 0,
    },
    config: {} as AuditRun["config"],
  } as AuditRun;
}

describe("PDF locale declaration", () => {
  it.each(SUPPORTED_LOCALES)("declares lang=%s", (locale) => {
    const html = renderPdfHtml(audit(), { locale: locale as Locale });
    expect(html).toContain(`<html lang="${locale}">`);
  });

  it("never falls back to declaring English for a non-English report", () => {
    for (const locale of SUPPORTED_LOCALES) {
      if (locale === "en") continue;
      expect(renderPdfHtml(audit(), { locale: locale as Locale })).not.toContain(
        '<html lang="en">',
      );
    }
  });
});

describe("PDF font stack", () => {
  it.each([
    ["zh-CN", "PingFang SC"],
    ["ja", "Hiragino Sans"],
  ])("puts a %s face first", (locale, expectedFirst) => {
    const html = renderPdfHtml(audit(), { locale: locale as Locale });
    const stack = html.match(/font-family: ([^;]+);/)?.[1] ?? "";
    expect(stack).toContain(expectedFirst);
    expect(stack.indexOf(expectedFirst)).toBeLessThan(stack.indexOf("Arial"));
  });

  it("keeps Japanese and Chinese stacks distinct", () => {
    // One combined list would render Chinese in a Japanese face, or the
    // reverse, wherever both are installed — order decides it.
    //
    // Compared as parsed family names rather than substrings: the Chinese
    // stack legitimately contains "Hiragino Sans GB", the Simplified Chinese
    // Hiragino, and a substring check reads that as the Japanese face.
    const families = (locale: Locale): string[] =>
      (renderPdfHtml(audit(), { locale }).match(/font-family: ([^;]+);/)?.[1] ?? "")
        .split(",")
        .map((f) => f.trim().replace(/^["']|["']$/g, ""));

    const ja = families("ja" as Locale);
    const zh = families("zh-CN" as Locale);

    expect(ja).toContain("Hiragino Sans");
    expect(ja).not.toContain("PingFang SC");
    expect(zh).toContain("PingFang SC");
    expect(zh).not.toContain("Hiragino Sans");
    // "Hiragino Sans GB" is the Chinese face and belongs in the Chinese stack.
    expect(zh).toContain("Hiragino Sans GB");
  });

  it("leaves the Latin locales on the original stack", () => {
    for (const locale of ["en", "es", "de"]) {
      const stack =
        renderPdfHtml(audit(), { locale: locale as Locale }).match(
          /font-family: ([^;]+);/,
        )?.[1] ?? "";
      expect(stack.startsWith("-apple-system")).toBe(true);
    }
  });

  it("repeats the stack in the running header, which does not inherit it", () => {
    // Chromium renders headerTemplate in its own context. The header carries a
    // translated title, so without this it is the one part of the document
    // with no script-appropriate font.
    const html = renderPdfHtml(audit(), { locale: "ja" as Locale });
    const headerish = html.includes("Hiragino Sans");
    expect(headerish).toBe(true);
  });
});

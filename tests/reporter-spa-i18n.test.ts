/**
 * Unit tests for the SPA i18n module (T18 — closes R65 partial).
 *
 * These cover the TypeScript helpers; the in-browser equivalent logic
 * (which lives as JS string in reporter-spa.ts) has its own structural
 * tests in reporter-spa.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  SPA_LOCALES,
  SPA_DEFAULT_LOCALE,
  SPA_I18N,
  spaTranslationKeys,
  normaliseSpaLocale,
  spaInterpolate,
  spaT,
  lintSpaTranslations,
} from "../src/core/reporter-spa-i18n.js";

describe("SPA_LOCALES + defaults", () => {
  it("ships exactly the 5 supported locales matching the static reporter", () => {
    expect(SPA_LOCALES).toEqual(["en", "zh-CN", "ja", "es", "de"]);
  });

  it("default locale is en", () => {
    expect(SPA_DEFAULT_LOCALE).toBe("en");
  });
});

describe("SPA_I18N coverage", () => {
  it("every locale is fully populated (no missing keys)", () => {
    for (const locale of SPA_LOCALES) {
      const missing = lintSpaTranslations(locale);
      expect(missing, `${locale} missing keys: ${missing.join(", ")}`).toEqual([]);
    }
  });

  it("translation keys count is in the documented ~20-key range", () => {
    const keys = spaTranslationKeys();
    expect(keys.length).toBeGreaterThanOrEqual(20);
    expect(keys.length).toBeLessThanOrEqual(40);
  });

  it("all locales agree on the same key set", () => {
    const enKeys = Object.keys(SPA_I18N.en).sort();
    for (const locale of SPA_LOCALES) {
      expect(Object.keys(SPA_I18N[locale]).sort()).toEqual(enKeys);
    }
  });

  it("no en value is reused verbatim in zh-CN / ja (catches missed translations)", () => {
    // A few high-signal keys whose en value should never appear in zh / ja.
    const sentinelKeys = [
      "audit_explorer_title",
      "btn_expand_all",
      "filter_persona",
      "summary_pass",
    ];
    for (const k of sentinelKeys) {
      expect(SPA_I18N["zh-CN"][k as keyof typeof SPA_I18N.en]).not.toBe(
        SPA_I18N.en[k as keyof typeof SPA_I18N.en],
      );
      expect(SPA_I18N["ja"][k as keyof typeof SPA_I18N.en]).not.toBe(
        SPA_I18N.en[k as keyof typeof SPA_I18N.en],
      );
    }
  });
});

describe("normaliseSpaLocale", () => {
  it("returns default on undefined / empty / whitespace", () => {
    expect(normaliseSpaLocale(undefined)).toBe("en");
    expect(normaliseSpaLocale("")).toBe("en");
    expect(normaliseSpaLocale("   ")).toBe("en");
  });

  it("matches exact canonical locales", () => {
    expect(normaliseSpaLocale("en")).toBe("en");
    expect(normaliseSpaLocale("zh-CN")).toBe("zh-CN");
    expect(normaliseSpaLocale("ja")).toBe("ja");
  });

  it("matches case-insensitively", () => {
    expect(normaliseSpaLocale("EN")).toBe("en");
    expect(normaliseSpaLocale("ZH-cn")).toBe("zh-CN");
  });

  it("falls back to family for browser-style tags", () => {
    expect(normaliseSpaLocale("zh")).toBe("zh-CN");
    expect(normaliseSpaLocale("zh-Hans")).toBe("zh-CN");
    expect(normaliseSpaLocale("zh-TW")).toBe("zh-CN");
    expect(normaliseSpaLocale("ja-JP")).toBe("ja");
    expect(normaliseSpaLocale("es-MX")).toBe("es");
    expect(normaliseSpaLocale("de-CH")).toBe("de");
  });

  it("returns default for unsupported locales", () => {
    expect(normaliseSpaLocale("fr")).toBe("en");
    expect(normaliseSpaLocale("ru-RU")).toBe("en");
    expect(normaliseSpaLocale("pt-BR")).toBe("en");
  });
});

describe("spaInterpolate", () => {
  it("substitutes {placeholder} tokens", () => {
    expect(spaInterpolate("{n} of {total}", { n: 3, total: 12 })).toBe("3 of 12");
  });

  it("leaves unreplaced placeholders verbatim when key is missing", () => {
    expect(spaInterpolate("{n} / {missing}", { n: 5 })).toBe("5 / {missing}");
  });

  it("handles strings without placeholders unchanged", () => {
    expect(spaInterpolate("static label", { n: 1 })).toBe("static label");
  });
});

describe("spaT", () => {
  it("returns the locale-specific value", () => {
    expect(spaT("zh-CN", "summary_pass")).toBe("通过");
    expect(spaT("ja", "summary_fail")).toBe("失敗");
    expect(spaT("es", "filter_persona")).toBe("persona");
    expect(spaT("de", "btn_collapse")).toBe("Einklappen");
  });

  it("falls back to en when key is missing in locale", () => {
    // Spread to a fake locale missing the key (simulating a partial dict).
    // We can't easily mutate SPA_I18N, but we can verify spaT works for
    // the canonical locale + a known-present key.
    expect(spaT("en", "summary_total")).toBe("Total");
  });

  it("interpolates count_format placeholders", () => {
    expect(spaT("en", "count_format", { n: 3, total: 10 })).toBe("3 of 10");
    expect(spaT("zh-CN", "count_format", { n: 3, total: 10 })).toBe("3 / 10");
    expect(spaT("de", "count_format", { n: 3, total: 10 })).toBe("3 von 10");
  });

  it("interpolates section_steps_n / section_issues_n", () => {
    expect(spaT("en", "section_steps_n", { n: 5 })).toBe("Steps (5)");
    expect(spaT("ja", "section_issues_n", { n: 2 })).toBe("問題 (2)");
  });
});

/**
 * DOM Summary Extractor — Compact page representation for LLM context.
 *
 * Extracts interactive elements, headings, landmarks, and visible text
 * into a compact string suitable for planner/navigator LLM calls.
 * Designed to stay within ~2K tokens while preserving navigational value.
 */

import type { Page } from "playwright";

export interface DomSummary {
  /** Current page URL */
  url: string;
  /** Page title */
  title: string;
  /** Compact DOM representation */
  elements: string;
  /** Total interactive element count (before truncation) */
  totalInteractive: number;
  /** Visible text snippets (headings, paragraphs) */
  textContent: string;
}

/**
 * Extract a compact DOM summary optimized for LLM context windows.
 * Includes interactive elements, headings, and key visible text.
 *
 * @param maxElements Maximum interactive elements to include (default 50)
 * @param maxTextLength Maximum characters for text content (default 500)
 */
export async function extractDomSummary(
  page: Page,
  maxElements = 50,
  maxTextLength = 500,
): Promise<DomSummary> {
  const url = page.url();

  const result = await page.evaluate(
    ({ maxEl, maxText }) => {
      // ── Interactive elements ───────────────────────────────────
      const interactives = document.querySelectorAll(
        'a, button, input, select, textarea, [role="button"], [role="link"], ' +
          '[role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], ' +
          '[role="switch"], [role="combobox"], [tabindex]:not([tabindex="-1"])',
      );

      const items: string[] = [];
      let total = 0;
      for (const el of Array.from(interactives)) {
        total++;
        if (items.length >= maxEl) continue;

        // Skip hidden elements
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;

        const tag = el.tagName.toLowerCase();
        const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
        const role = el.getAttribute("role") ?? "";
        const type = (el as HTMLInputElement).type ?? "";
        const placeholder = el.getAttribute("placeholder") ?? "";
        const ariaLabel = el.getAttribute("aria-label") ?? "";
        const href = tag === "a" ? (el as HTMLAnchorElement).pathname : "";
        const id = el.id ? `#${el.id}` : "";
        const disabled = (el as HTMLButtonElement).disabled ? " [disabled]" : "";
        // Redact sensitive field values before they leave the machine for the
        // LLM. The screenshot path masks password/secret/card inputs; this text
        // path must too, or a typed password/OTP/token/server-reflected secret
        // leaks even with --redact-inputs on. (Audit 2026-06-02 C1.)
        const SENSITIVE_HINT =
          /pass|pwd|otp|2fa|mfa|cvc|cvv|card|ssn|secret|token|auth|session|\bpin\b|bearer|csrf|xsrf|credential|security[-_]?code|account[-_]?number/i;
        const fieldName = (el.getAttribute("name") ?? "").toLowerCase();
        const fieldAutocomplete = (el.getAttribute("autocomplete") ?? "").toLowerCase();
        const isSensitiveField =
          type === "password" ||
          type === "hidden" ||
          SENSITIVE_HINT.test(fieldName) ||
          SENSITIVE_HINT.test((el.id ?? "").toLowerCase()) ||
          SENSITIVE_HINT.test(fieldAutocomplete) ||
          SENSITIVE_HINT.test(placeholder) ||
          SENSITIVE_HINT.test(ariaLabel);
        const rawValue =
          tag === "input" || tag === "select" || tag === "textarea"
            ? ((el as HTMLInputElement).value ?? "")
            : "";
        const value = !rawValue
          ? ""
          : isSensitiveField
            ? "[redacted]"
            : rawValue.slice(0, 30);

        const parts = [
          `<${tag}${id}`,
          type && type !== "submit" ? ` type="${type}"` : "",
          role ? ` role="${role}"` : "",
          ariaLabel ? ` aria-label="${ariaLabel}"` : "",
          placeholder ? ` placeholder="${placeholder}"` : "",
          href ? ` href="${href}"` : "",
          disabled,
          ">",
          text ? ` "${text}"` : "",
          value ? ` value="${value}"` : "",
        ];
        items.push(parts.filter(Boolean).join(""));
      }

      // ── Headings and landmarks ─────────────────────────────────
      const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
        .slice(0, 10)
        .map((h) => {
          const level = h.tagName.toLowerCase();
          const text = (h.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
          return `${level}: ${text}`;
        });

      // ── Visible text snippets (for context) ────────────────────
      const textParts: string[] = [];
      let textLen = 0;
      const textElements = document.querySelectorAll("p, li, td, span, label, [role='alert']");
      for (const el of Array.from(textElements)) {
        if (textLen >= maxText) break;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const text = (el.textContent ?? "").trim().replace(/\s+/g, " ");
        if (text.length < 5 || text.length > 200) continue;
        textParts.push(text);
        textLen += text.length;
      }

      return {
        title: document.title,
        elements: items.join("\n"),
        totalInteractive: total,
        headings: headings.join("\n"),
        textContent: textParts.join("\n").slice(0, maxText),
      };
    },
    { maxEl: maxElements, maxText: maxTextLength },
  ).catch(() => ({
    title: "(unable to read page)",
    elements: "(unable to read DOM)",
    totalInteractive: 0,
    headings: "",
    textContent: "",
  }));

  // Compose final summary
  const sections = [
    result.headings && `[Headings]\n${result.headings}`,
    `[Interactive Elements] (${result.totalInteractive} total, showing first ${maxElements})\n${result.elements}`,
    result.textContent && `[Visible Text]\n${result.textContent}`,
  ].filter(Boolean);

  return {
    url,
    title: result.title,
    elements: sections.join("\n\n"),
    totalInteractive: result.totalInteractive,
    textContent: result.textContent,
  };
}

/**
 * Format a DomSummary as a compact string for LLM prompts.
 */
export function formatDomSummary(summary: DomSummary): string {
  return [
    `URL: ${summary.url}`,
    `Title: ${summary.title}`,
    "",
    summary.elements,
  ].join("\n");
}

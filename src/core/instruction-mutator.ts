/**
 * Instruction Mutator — Layer 2 of the Reliability Stack.
 *
 * When a Stagehand semantic action fails, instead of retrying with the
 * identical instruction (which fails the same way), this module generates
 * mutated variants:
 *
 *   1. More specific — uses visible DOM context to target the exact element
 *   2. Decomposed — breaks a complex instruction into 2-3 atomic steps
 *   3. Alternative phrasing — uses different verbs/descriptions
 *
 * This eliminates ~20% of Stagehand failures caused by ambiguous or
 * overly broad instructions.
 */

import type { Page } from "playwright";

/**
 * Extract a compact DOM summary of interactive elements on the current page.
 * This is sent as context for rephrase/decompose mutations.
 */
async function getInteractiveElements(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      const interactives = document.querySelectorAll(
        'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [tabindex]',
      );
      const items: string[] = [];
      for (const el of Array.from(interactives).slice(0, 30)) {
        const tag = el.tagName.toLowerCase();
        const text = (el.textContent ?? "").trim().slice(0, 60);
        const role = el.getAttribute("role") ?? "";
        const type = el.getAttribute("type") ?? "";
        const placeholder = el.getAttribute("placeholder") ?? "";
        const ariaLabel = el.getAttribute("aria-label") ?? "";
        const id = el.id ? `#${el.id}` : "";
        const cls = el.className
          ? `.${String(el.className).split(" ").slice(0, 2).join(".")}`
          : "";

        const desc = [
          `<${tag}${id}${cls}`,
          type && `type="${type}"`,
          role && `role="${role}"`,
          ariaLabel && `aria-label="${ariaLabel}"`,
          placeholder && `placeholder="${placeholder}"`,
          `>`,
          text && `"${text}"`,
        ]
          .filter(Boolean)
          .join(" ");
        items.push(desc);
      }
      return items.join("\n");
    });
  } catch {
    return "(unable to read DOM)";
  }
}

export interface MutationResult {
  /** The type of mutation applied */
  type: "rephrase" | "decompose" | "specific";
  /** The mutated instruction(s). For decompose, multiple strings. */
  instructions: string[];
}

/**
 * Generate a more specific version of the instruction using DOM context.
 */
export function mutateSpecific(
  original: string,
  domContext: string,
): MutationResult {
  // Find the most likely target element by fuzzy matching keywords
  const keywords = original
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const lines = domContext.split("\n");
  let bestLine = "";
  let bestScore = 0;

  for (const line of lines) {
    const lower = line.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = line;
    }
  }

  if (bestLine && bestScore >= 1) {
    return {
      type: "specific",
      instructions: [
        `${original}. The target element is: ${bestLine.trim()}`,
      ],
    };
  }

  return { type: "rephrase", instructions: [rephrase(original)] };
}

/**
 * Decompose a complex instruction into simpler atomic steps.
 */
export function mutateDecompose(original: string): MutationResult {
  const lower = original.toLowerCase();

  // Pattern: "X and then Y" / "X, then Y"
  const thenMatch = original.match(/^(.+?)(?:\s*,?\s*then\s+)(.+)$/i);
  if (thenMatch) {
    return {
      type: "decompose",
      instructions: [thenMatch[1].trim(), thenMatch[2].trim()],
    };
  }

  // Pattern: "X and Y" (two distinct verbs)
  const andMatch = original.match(
    /^((?:click|type|select|check|toggle|scroll|hover|press).+?)\s+and\s+((?:click|type|select|check|toggle|scroll|hover|press).+)$/i,
  );
  if (andMatch) {
    return {
      type: "decompose",
      instructions: [andMatch[1].trim(), andMatch[2].trim()],
    };
  }

  // Pattern: "Fill in the form with X" → click field, type value
  if (
    lower.includes("fill") ||
    lower.includes("enter") ||
    lower.includes("type")
  ) {
    const fieldMatch = original.match(
      /(?:fill|enter|type)\s+(?:in\s+)?(?:the\s+)?(.+?)\s+(?:with|as|:)\s+(.+)/i,
    );
    if (fieldMatch) {
      return {
        type: "decompose",
        instructions: [
          `Click on the ${fieldMatch[1].trim()} field`,
          `Type "${fieldMatch[2].trim()}"`,
        ],
      };
    }
  }

  // Pattern: "Select X from the Y dropdown"
  if (lower.includes("select") && lower.includes("dropdown")) {
    const selectMatch = original.match(
      /select\s+(.+?)\s+from\s+(?:the\s+)?(.+?)\s*dropdown/i,
    );
    if (selectMatch) {
      return {
        type: "decompose",
        instructions: [
          `Click on the ${selectMatch[2].trim()} dropdown`,
          `Click on "${selectMatch[1].trim()}"`,
        ],
      };
    }
  }

  // No decomposition pattern matched — rephrase instead
  return { type: "rephrase", instructions: [rephrase(original)] };
}

/**
 * Rephrase an instruction using alternative verbs and structure.
 */
function rephrase(original: string): string {
  const lower = original.toLowerCase();

  const verbSwaps: Array<[RegExp, string]> = [
    [/^click\s+(on\s+)?/i, "Press "],
    [/^press\s+/i, "Click on "],
    [/^tap\s+(on\s+)?/i, "Click on "],
    [/^select\s+/i, "Choose "],
    [/^choose\s+/i, "Select "],
    [/^navigate\s+to\s+/i, "Go to "],
    [/^go\s+to\s+/i, "Navigate to "],
    [/^open\s+/i, "Click on "],
    [/^find\s+/i, "Locate and click "],
    [/^enter\s+/i, "Type "],
    [/^type\s+/i, "Enter "],
    [/^scroll\s+down\s+to\s+/i, "Find "],
    [/^look\s+for\s+/i, "Find and click "],
  ];

  for (const [pattern, replacement] of verbSwaps) {
    if (pattern.test(original)) {
      return original.replace(pattern, replacement);
    }
  }

  // If no verb swap matches, add context hint
  if (lower.includes("button")) {
    return `${original}. Look for it in the visible area of the page.`;
  }
  if (lower.includes("link")) {
    return `${original}. It should be a clickable text or anchor element.`;
  }

  return `${original}. Try a different approach to locate and interact with this element.`;
}

/**
 * Generate all mutation variants for a failed instruction.
 * Returns them in priority order (specific > decompose > rephrase).
 */
export async function generateMutations(
  original: string,
  page: Page,
): Promise<MutationResult[]> {
  const domContext = await getInteractiveElements(page);
  const results: MutationResult[] = [];

  // 1. Specific mutation (uses DOM context)
  const specific = mutateSpecific(original, domContext);
  if (specific.type === "specific") {
    results.push(specific);
  }

  // 2. Decompose mutation (structural)
  const decomposed = mutateDecompose(original);
  if (decomposed.type === "decompose") {
    results.push(decomposed);
  }

  // 3. Rephrase mutation (always available as last resort)
  results.push({ type: "rephrase", instructions: [rephrase(original)] });

  return results;
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "then",
  "into",
  "click",
  "press",
  "tap",
  "find",
  "look",
  "page",
  "button",
  "link",
]);

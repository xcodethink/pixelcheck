/**
 * Instruction Mutator — Layer 2 of the Reliability Stack.
 *
 * When a Stagehand semantic action fails, instead of retrying with the
 * identical instruction (which fails the same way), this module generates
 * mutated variants using two strategies:
 *
 *   1. Local mutations (zero cost, instant):
 *      - Specific — uses visible DOM context to target the exact element
 *      - Decomposed — breaks a complex instruction into 2-3 atomic steps
 *      - Rephrase — uses different verbs/descriptions
 *
 *   2. LLM rewrite (Haiku — ~$0.001/call, ~200ms):
 *      - Sends the failed instruction + DOM context to Haiku for intelligent rewrite
 *      - Only used when local mutations are exhausted or as a high-priority variant
 *
 * This eliminates ~20% of Stagehand failures caused by ambiguous or
 * overly broad instructions.
 */

import type { Page } from "playwright";
import { getAnthropicClient, estimateCost } from "./llm.js";
import { getCostGuard } from "./cost-guard.js";
import { RESULT_SCHEMA_VERSION } from "./result-schema.js";

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
  /** Result schema version (SemVer). Stamped by `generateMutations`. */
  schema_version?: string;
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
 * Use Haiku to intelligently rewrite a failed instruction based on DOM context.
 * Cost: ~$0.001 per call. Latency: ~200-500ms.
 *
 * Returns null if LLM call fails (non-fatal — local mutations are still available).
 */
async function llmRewrite(
  original: string,
  domContext: string,
  cost: { value: number },
): Promise<MutationResult | null> {
  try {
    const client = getAnthropicClient();
    const guard = getCostGuard();
    guard.checkBudget();
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system:
        "You are a browser automation expert. A Stagehand semantic action failed. " +
        "Rewrite the instruction to be more specific and actionable. " +
        "Return ONLY the rewritten instruction, nothing else. No quotes, no explanation.",
      messages: [
        {
          role: "user",
          content: `The action "${original}" failed on a page with these interactive elements:\n\n${domContext.slice(0, 1500)}\n\nRewrite the instruction to precisely target the correct element. Be very specific about which element to interact with.`,
        },
      ],
    });

    guard.recordUsage(
      "claude-haiku-4-5-20251001",
      response.usage.input_tokens,
      response.usage.output_tokens,
    );
    cost.value += estimateCost(
      "claude-haiku-4-5-20251001",
      response.usage.input_tokens,
      response.usage.output_tokens,
    );

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("")
      .trim();

    if (text && text !== original) {
      return { type: "rephrase", instructions: [text] };
    }
    return null;
  } catch {
    // LLM call failed — not fatal, local mutations are still available
    return null;
  }
}

/**
 * Auto-discover candidate selectors by running Stagehand observe() on the page.
 * Returns CSS selectors for elements matching the original instruction.
 */
export async function autoDiscoverSelectors(
  original: string,
  stagehand: {
    observe(arg: { instruction: string }): Promise<Array<{ description?: string; selector?: string }>>;
  },
): Promise<string[]> {
  try {
    const observations = await stagehand.observe({
      instruction: `Find all interactive elements that could match: "${original}"`,
    });
    return observations
      .map((o) => o.selector)
      .filter((s): s is string => !!s && s.length > 0)
      .slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * Generate all mutation variants for a failed instruction.
 * Returns them in priority order: LLM rewrite > specific > decompose > rephrase.
 *
 * @param cost - Mutable cost accumulator for LLM rewrite tracking
 */
export async function generateMutations(
  original: string,
  page: Page,
  cost?: { value: number },
): Promise<MutationResult[]> {
  const domContext = await getInteractiveElements(page);
  const results: MutationResult[] = [];

  // 1. LLM rewrite (highest quality, ~$0.001 per call)
  if (cost) {
    const llmResult = await llmRewrite(original, domContext, cost);
    if (llmResult) {
      results.push(llmResult);
    }
  }

  // 2. Specific mutation (uses DOM context, zero cost)
  const specific = mutateSpecific(original, domContext);
  if (specific.type === "specific") {
    results.push(specific);
  }

  // 3. Decompose mutation (structural, zero cost)
  const decomposed = mutateDecompose(original);
  if (decomposed.type === "decompose") {
    results.push(decomposed);
  }

  // 4. Rephrase mutation (only if not already included via fallback or LLM)
  const hasRephrase = results.some((r) => r.type === "rephrase");
  if (!hasRephrase) {
    results.push({ type: "rephrase", instructions: [rephrase(original)] });
  }

  // Stamp the schema version on every result before returning. Done once
  // here rather than at each individual return site so all mutation paths
  // (LLM rewrite, specific, decompose, rephrase fallback) carry the version.
  for (const r of results) {
    if (!r.schema_version) r.schema_version = RESULT_SCHEMA_VERSION;
  }

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

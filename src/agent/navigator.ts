/**
 * Navigator — Per-action decision maker for the autonomous agent.
 *
 * Given a planned step + current page state, produces a concrete action
 * that maps to an existing Step type for the handlers to execute.
 *
 * Uses Sonnet for complex actions, Haiku for simple navigations.
 */

import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, estimateCost, extractJson } from "../core/llm.js";
import type { Persona, Hint, Step } from "../core/types.js";
import type { PlannedStep } from "./planner.js";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface NavigatorInput {
  planned_step: PlannedStep;
  persona: Persona;
  current_screenshot_base64?: string;
  dom_summary: string;
  page_url: string;
  hints: Hint[];
}

export interface NavigatorDecision {
  action_type: string;
  instruction: string;
  reasoning: string;
  confidence: number; // 0-1
  needs_replan: boolean;
}

// ─────────────────────────────────────────────────────────────
// Navigator Implementation
// ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a browser action navigator. Given a planned step and the current page state, decide the exact action to take.

RULES:
1. Output a single concrete action — not a plan, just one action.
2. If the planned step is impossible from the current page state (e.g., element doesn't exist, wrong page), set needs_replan to true.
3. For "act" type: write a specific natural language instruction (e.g., "Click the blue 'Sign Up' button in the top-right corner").
4. For "visit" type: include the full URL.
5. Confidence: 1.0 if certain, 0.5 if unsure, 0.0 if clearly wrong state.

OUTPUT FORMAT:
{
  "action_type": "act",
  "instruction": "Click the Sign Up button",
  "reasoning": "The signup button is visible in the navigation bar",
  "confidence": 0.9,
  "needs_replan": false
}`;

/**
 * Decide the concrete action for a planned step given current page state.
 */
export async function navigatorDecide(
  input: NavigatorInput,
  model: string,
  cost: { value: number },
): Promise<NavigatorDecision> {
  const client = getAnthropicClient();

  // Build user prompt
  const parts: string[] = [];
  parts.push(`## Planned Step`);
  parts.push(`Action type: ${input.planned_step.action_type}`);
  parts.push(`Instruction: ${input.planned_step.instruction}`);
  parts.push(`Reasoning: ${input.planned_step.reasoning}`);

  parts.push(`\n## Current Page`);
  parts.push(`URL: ${input.page_url}`);
  parts.push(`\n## DOM Summary\n${input.dom_summary.slice(0, 2500)}`);

  if (input.hints.length > 0) {
    parts.push(`\n## Hints`);
    for (const h of input.hints) {
      parts.push(`- When: "${h.condition}" → ${h.suggestion}${h.selector ? ` (selector: ${h.selector})` : ""}`);
    }
  }

  const userPrompt = parts.join("\n");

  const content: Anthropic.Messages.ContentBlockParam[] = [];
  if (input.current_screenshot_base64) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: input.current_screenshot_base64,
      },
    });
  }
  content.push({ type: "text", text: userPrompt });

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });

  const costUsd = estimateCost(
    model,
    response.usage.input_tokens,
    response.usage.output_tokens,
  );
  cost.value += costUsd;

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");

  const parsed = extractJson<{
    action_type?: string;
    instruction?: string;
    reasoning?: string;
    confidence?: number;
    needs_replan?: boolean;
  }>(text);

  return {
    action_type: parsed.action_type ?? input.planned_step.action_type,
    instruction: parsed.instruction ?? input.planned_step.instruction,
    reasoning: parsed.reasoning ?? "",
    confidence: parsed.confidence ?? 0.5,
    needs_replan: parsed.needs_replan ?? false,
  };
}

/**
 * Convert a NavigatorDecision into a Step object for the existing handlers.
 */
export function buildStepFromDecision(
  decision: NavigatorDecision,
  stepIndex: number,
): Step {
  const baseId = `auto-${stepIndex}`;

  switch (decision.action_type) {
    case "visit":
      return {
        type: "visit",
        id: baseId,
        url: decision.instruction,
        wait_until: "domcontentloaded",
        critical: false,
        critical_review: false,
        retry: 1,
      };

    case "extract":
      return {
        type: "extract",
        id: baseId,
        instruction: decision.instruction,
        critical: false,
        critical_review: false,
        retry: 1,
      };

    case "observe":
      return {
        type: "observe",
        id: baseId,
        instruction: decision.instruction,
        critical: false,
        critical_review: false,
        retry: 1,
      };

    case "wait":
      return {
        type: "wait_for",
        id: baseId,
        ms: 2000,
        critical: false,
        critical_review: false,
        retry: 0,
      };

    case "scroll":
      // Map scroll to an act instruction
      return {
        type: "act",
        id: baseId,
        instruction: decision.instruction.toLowerCase().includes("scroll")
          ? decision.instruction
          : `Scroll down the page`,
        critical: false,
        critical_review: false,
        retry: 1,
      };

    case "assert_visual":
      return {
        type: "assert_visual",
        id: baseId,
        instruction: decision.instruction,
        dimensions: ["visual_polish", "localization"],
        critical: false,
        critical_review: false,
        retry: 0,
      };

    case "assert_dom":
      return {
        type: "assert_dom",
        id: baseId,
        selector: decision.instruction,
        critical: false,
        critical_review: false,
        retry: 0,
      };

    case "act":
    default:
      // Default to "act" — enters the 5-layer reliability stack
      return {
        type: "act",
        id: baseId,
        instruction: decision.instruction,
        critical: false,
        critical_review: false,
        retry: 2,
      };
  }
}

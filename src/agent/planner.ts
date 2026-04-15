/**
 * Planner — Goal-based step plan generation using Claude.
 *
 * Two-tier:
 *   - createPlan(): Opus for initial plans (complex reasoning about multi-step flows)
 *   - revisePlan(): Sonnet for revisions (cheaper, uses failure context)
 *
 * The planner receives: goal, success criteria, hints, screenshot, DOM summary,
 * action history (for replanning), and remaining budget.
 *
 * Output: PlannedStep[] — ordered action list that maps to existing step types.
 */

import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, estimateCost, extractJson } from "../core/llm.js";
import type { Persona, SuccessCriterion, Hint } from "../core/types.js";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface PlannedStep {
  index: number;
  action_type: "visit" | "act" | "extract" | "observe" | "wait" | "scroll" | "assert_visual" | "assert_dom";
  instruction: string;
  reasoning: string;
  /** Which success criteria this step works toward */
  targets_criteria: string[];
}

export interface Plan {
  id: string;
  created_at: string;
  steps: PlannedStep[];
  reasoning: string;
}

export interface PlannerInput {
  goal: string;
  success_criteria: SuccessCriterion[];
  hints: Hint[];
  persona: Persona;
  current_url: string;
  current_screenshot_base64?: string;
  dom_summary: string;
  /** Past actions for replanning context */
  history: Array<{ instruction: string; result: string; success: boolean }>;
  /** Previously failed plans */
  failed_plans: Plan[];
  remaining_budget_usd: number;
}

export interface PlannerResult {
  plan: Plan;
  costUsd: number;
}

// ─────────────────────────────────────────────────────────────
// Planner Implementation
// ─────────────────────────────────────────────────────────────

let planCounter = 0;

function buildSystemPrompt(persona: Persona): string {
  return `You are an expert web testing agent planner. You create step-by-step plans to achieve goals in a web browser.

You are testing a web application as this persona:
- Name: ${persona.display_name}
- Country: ${persona.country}, Language: ${persona.language}
- Device: ${persona.device_class}, Payment tier: ${persona.payment_tier}
- Mental model: ${persona.mental_model}
${persona.critical_concerns.length > 0 ? `- Critical concerns: ${persona.critical_concerns.join(", ")}` : ""}

RULES:
1. Generate a focused, minimal plan to achieve the goal and verify success criteria.
2. Each step must map to one of these action types: visit, act, extract, observe, wait, scroll, assert_visual, assert_dom.
3. "act" is for clicking, typing, selecting — use natural language instructions (e.g., "Click the Sign Up button", "Type 'test@example.com' in the email field").
4. Keep plans short (5-15 steps). Longer plans cost more and are more fragile.
5. Consider the persona's language and device when writing instructions.
6. If budget is low, produce a minimal plan.
7. Reference which success criteria each step works toward.

OUTPUT FORMAT: Return a JSON object with this exact structure:
{
  "reasoning": "Brief explanation of your plan strategy",
  "steps": [
    {
      "index": 0,
      "action_type": "visit",
      "instruction": "Navigate to the homepage",
      "reasoning": "Start from the landing page",
      "targets_criteria": ["criterion-id-1"]
    }
  ]
}`;
}

function buildUserPrompt(input: PlannerInput): string {
  const parts: string[] = [];

  parts.push(`## Goal\n${input.goal}`);

  parts.push(`\n## Success Criteria`);
  for (const c of input.success_criteria) {
    parts.push(`- [${c.id}] ${c.description} (verify: ${c.verification})`);
  }

  if (input.hints.length > 0) {
    parts.push(`\n## Hints`);
    for (const h of input.hints) {
      parts.push(`- When: "${h.condition}" → ${h.suggestion}`);
    }
  }

  parts.push(`\n## Current State`);
  parts.push(`URL: ${input.current_url}`);
  parts.push(`\n## Page DOM Summary\n${input.dom_summary.slice(0, 3000)}`);

  if (input.history.length > 0) {
    parts.push(`\n## Action History (${input.history.length} actions taken so far)`);
    for (const h of input.history.slice(-10)) {
      const status = h.success ? "OK" : "FAILED";
      parts.push(`- [${status}] ${h.instruction} → ${h.result.slice(0, 80)}`);
    }
  }

  if (input.failed_plans.length > 0) {
    parts.push(`\n## Previously Failed Plans (${input.failed_plans.length})`);
    for (const fp of input.failed_plans.slice(-2)) {
      parts.push(`- Plan "${fp.reasoning.slice(0, 80)}..." with ${fp.steps.length} steps — FAILED`);
    }
    parts.push(`Do NOT repeat the same approach. Try a different strategy.`);
  }

  parts.push(`\n## Budget: $${input.remaining_budget_usd.toFixed(2)} remaining. Each action costs ~$0.02. Keep plan short if budget is low.`);

  return parts.join("\n");
}

/**
 * Create an initial plan using the planner model (default: Opus).
 */
export async function createPlan(
  input: PlannerInput,
  model: string,
  cost: { value: number },
): Promise<PlannerResult> {
  const client = getAnthropicClient();
  const systemPrompt = buildSystemPrompt(input.persona);
  const userPrompt = buildUserPrompt(input);

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
    max_tokens: 4096,
    system: systemPrompt,
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
    reasoning: string;
    steps: Array<{
      index: number;
      action_type: string;
      instruction: string;
      reasoning: string;
      targets_criteria?: string[];
    }>;
  }>(text);

  const plan: Plan = {
    id: `plan-${++planCounter}`,
    created_at: new Date().toISOString(),
    reasoning: parsed.reasoning ?? "",
    steps: (parsed.steps ?? []).map((s, i) => ({
      index: i,
      action_type: validateActionType(s.action_type),
      instruction: s.instruction,
      reasoning: s.reasoning ?? "",
      targets_criteria: s.targets_criteria ?? [],
    })),
  };

  return { plan, costUsd };
}

/**
 * Revise a plan using the replan model (default: Sonnet, cheaper).
 * Same prompt structure but includes failure context.
 */
export async function revisePlan(
  input: PlannerInput,
  model: string,
  cost: { value: number },
): Promise<PlannerResult> {
  // Reuse the same logic — the failure context is already in the input
  return createPlan(input, model, cost);
}

function validateActionType(type: string): PlannedStep["action_type"] {
  const valid: PlannedStep["action_type"][] = [
    "visit", "act", "extract", "observe", "wait", "scroll", "assert_visual", "assert_dom",
  ];
  if (valid.includes(type as PlannedStep["action_type"])) {
    return type as PlannedStep["action_type"];
  }
  // Default to "act" for unrecognized types — the reliability stack handles it
  return "act";
}

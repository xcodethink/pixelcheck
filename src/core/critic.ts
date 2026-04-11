import { z } from "zod";
import { callVision, extractJson, type VisionResponse } from "./llm.js";
import { compressForVision } from "./image.js";
import type { Persona, Scenario, StepResult, DimensionScore, Issue } from "./types.js";

const VisionVerdictSchema = z.object({
  scores: z
    .array(
      z.object({
        dimension: z.string(),
        score: z.number().min(0).max(10),
        justification: z.string(),
      }),
    )
    .default([]),
  issues: z
    .array(
      z.object({
        severity: z.enum(["critical", "high", "medium", "low"]),
        dimension: z.string().optional(),
        description: z.string(),
        recommendation: z.string(),
      }),
    )
    .default([]),
  passed: z.boolean().optional(),
  violations: z
    .array(
      z.object({
        text: z.string(),
        location: z.string().optional(),
      }),
    )
    .optional(),
});

export type VisionVerdict = z.infer<typeof VisionVerdictSchema>;

export interface CriticOptions {
  model: string;
  persona: Persona;
  scenario: Scenario;
  instruction: string;
  /**
   * One or more raw screenshot buffers. When multiple are passed (typical
   * use: viewport-segmented full-page captures), each is compressed
   * independently and sent in order so the model sees a stitched view.
   */
  imageBuffers: Buffer[];
  stepId: string;
}

export interface CriticResult {
  verdict: VisionVerdict;
  scores: DimensionScore[];
  issues: Issue[];
  costUsd: number;
  raw: VisionResponse;
}

/**
 * Run a vision critic against a screenshot.
 */
export async function runCritic(opts: CriticOptions): Promise<CriticResult> {
  const systemPrompt = buildSystemPrompt(opts.persona, opts.scenario);
  const userPrompt = buildUserPrompt(opts.instruction, opts.scenario);

  // Compress each segment to fit within Anthropic vision API limits
  const images = await Promise.all(
    opts.imageBuffers.map(async (buf, i) => {
      const c = await compressForVision(buf);
      return {
        base64: c.base64,
        mediaType: c.mediaType,
        label:
          opts.imageBuffers.length > 1
            ? `Viewport ${i + 1} of ${opts.imageBuffers.length} (scroll segment):`
            : undefined,
      };
    }),
  );

  const response = await callVision({
    model: opts.model,
    systemPrompt,
    userPrompt,
    images,
    // 4096 is enough for 20+ violations × full justifications without truncation
    maxTokens: 4096,
  });

  let verdict: VisionVerdict;
  try {
    const json = extractJson<unknown>(response.text);
    verdict = VisionVerdictSchema.parse(json);
  } catch (err) {
    // Critic failed to return JSON — record as a warning issue but don't crash.
    return {
      verdict: { scores: [], issues: [] },
      scores: [],
      issues: [
        {
          severity: "low",
          step_id: opts.stepId,
          description: `Vision critic returned malformed JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
          recommendation: "Review critic prompt or model output stability.",
        },
      ],
      costUsd: response.costUsd,
      raw: response,
    };
  }

  const scores: DimensionScore[] = verdict.scores.map((s) => ({
    dimension: s.dimension,
    score: s.score,
    justification: s.justification,
  }));

  const issues: Issue[] = verdict.issues.map((i) => ({
    severity: i.severity,
    step_id: opts.stepId,
    dimension: i.dimension,
    description: i.description,
    recommendation: i.recommendation,
  }));

  // If the verdict has explicit "violations" (e.g. localization audit), turn them into issues.
  if (verdict.violations && verdict.violations.length > 0) {
    for (const v of verdict.violations) {
      issues.push({
        severity: "high",
        step_id: opts.stepId,
        dimension: "localization",
        description: `Foreign-language text found: "${v.text}"${
          v.location ? ` at ${v.location}` : ""
        }`,
        recommendation: "Translate or remove this text in the relevant locale file.",
      });
    }
  }

  return {
    verdict,
    scores,
    issues,
    costUsd: response.costUsd,
    raw: response,
  };
}

function buildSystemPrompt(persona: Persona, scenario: Scenario): string {
  return `You are a senior product manager and UX reviewer auditing a commercial-grade web product.

You evaluate from the perspective of:
${persona.mental_model}

Persona context:
- Country: ${persona.country}
- Language: ${persona.language} (locale: ${persona.locale})
- Device: ${persona.device_class}
- Tier: ${persona.payment_tier}

Critical concerns for this persona:
${persona.critical_concerns.map((c) => `  - ${c}`).join("\n") || "  (none specified)"}

The user is attempting: ${scenario.goal}

You MUST return a single valid JSON object matching this schema:
{
  "scores": [
    { "dimension": string, "score": number 0-10, "justification": string }
  ],
  "issues": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "dimension": string (optional),
      "description": string,
      "recommendation": string
    }
  ],
  "passed": boolean (optional),
  "violations": [{ "text": string, "location": string }] (optional, for localization audits)
}

CRITICAL ANTI-HALLUCINATION RULES:
- ONLY report text you can ACTUALLY READ in the screenshot. Never guess, never fill in "what a typical SaaS landing page would have", never list strings like "Get Started" or "Sara M." unless you literally see those exact characters rendered in the image.
- If you are not 100% certain a string exists, OMIT it. False positives are worse than missing one issue.
- Quote the exact rendered text in your "violations[].text" field — character for character.
- "location" must describe a physical area you can see (e.g. "footer column 2", "top right of hero section"), NOT an inferred section name.
- If a region is too small/blurry to read, say so in your justification rather than fabricating contents.

Guidelines:
- "visual_polish" must be benchmarked against Stripe / Linear / Vercel / Notion.
- "localization" must check for any non-${persona.language} text. Brand names ("ScamLens", "OrangeDuck"), well-known acronyms (URL, AI, API, GDPR, OFAC, USDT, KYC, DeFi), and ISO currency codes are exempt.
- Be honest. A 7 means "good but improvable", not "passing".
- Limit to the 10 most important issues. Group similar issues into one entry instead of listing each instance.
- Limit "violations" to 10 most representative items. List the pattern once, don't enumerate every instance.
- Justifications: max 1 sentence each. Recommendations: max 1 sentence each.
- Return ONLY the JSON, no prose, no code fences. The JSON must parse cleanly.`;
}

function buildUserPrompt(instruction: string, scenario: Scenario): string {
  const dims = scenario.scoring_dimensions.join(", ");
  return `${instruction}

Score the screenshot on these dimensions: ${dims}

Return JSON only.`;
}

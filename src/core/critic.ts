import { z } from "zod";
import { callVision, extractJson, type VisionResponse } from "./llm.js";
import { compressForVision } from "./image.js";
import type { Persona, Scenario, DimensionScore, Issue } from "./types.js";
import { RESULT_SCHEMA_VERSION } from "./result-schema.js";

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
  /** Result schema version (SemVer). Stamped by `runCritic`. */
  schema_version?: string;
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

  // Compress each image to fit within Anthropic vision API limits.
  //
  // Convention: when more than one image is sent, the FIRST is treated as the
  // full-page thumbnail (macro context) and the rest are viewport segments
  // in scroll order (micro context). Labels reflect that.
  const images = await Promise.all(
    opts.imageBuffers.map(async (buf, i) => {
      const c = await compressForVision(buf);
      let label: string | undefined;
      if (opts.imageBuffers.length === 1) {
        label = undefined;
      } else if (i === 0) {
        label =
          "FULL-PAGE THUMBNAIL (macro context — entire scrollable page at low resolution; use this to understand layout and locate sections; do NOT cite tiny text from this image — use the segments below for exact text):";
      } else {
        const segNum = i;
        const total = opts.imageBuffers.length - 1;
        label = `VIEWPORT SEGMENT ${segNum} of ${total} (high-res scroll snapshot, ~20% overlap with neighboring segments — use these for exact text reading):`;
      }
      return {
        base64: c.base64,
        mediaType: c.mediaType,
        label,
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
      schema_version: RESULT_SCHEMA_VERSION,
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
    schema_version: RESULT_SCHEMA_VERSION,
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

CRITICAL ANTI-HALLUCINATION RULES (read carefully — false positives are worse than misses):
- ONLY report text you can ACTUALLY READ in the high-res segment images. Never guess, never fabricate "what a typical SaaS landing page would have", never list strings like "Get Started", "Sara M.", "$29.99", "Trusted by Security Professionals" unless you literally see those exact characters rendered.
- The FIRST image is a low-res thumbnail for macro context only. Do NOT cite tiny text from the thumbnail — only use it to understand layout. Cite text only from the segment images (image 2 onwards).
- If you are not 100% certain a string exists, OMIT it. The cost of one missed issue is far less than the cost of one fabricated string that the dev team can't find.
- Quote rendered text character for character in "violations[].text". Do not normalize, lowercase, or paraphrase.
- "location" must describe a physical area you can see (e.g. "footer column 2", "top right of hero section", "viewport segment 3, lower-left card"), NOT an inferred section name from your training data.
- If a region is too small/blurry to read, say so in your justification rather than fabricating contents.

CRITICAL DATA-EXPOSURE CHECKS (always run):
- Flag any visible text that looks like a raw i18n key, enum value, or internal identifier. Examples of patterns to flag at HIGH severity:
  * /^[a-z_]+\\.[a-z_]+(\\.[a-z_]+)*$/ — e.g. "report.trust_score_label", "footer.cta.title"
  * UPPER_SNAKE_CASE constants visible in the UI: "RISK_HIGH", "STATUS_ACTIVE"
  * Database row IDs that look like UUIDs or numeric primary keys exposed in user-facing copy
  * Source/provider keys like "src_europol", "provider_phishtank"
- Flag any data inconsistency where two widgets on the same page disagree:
  * Stats counter shows N but visible content shows a clearly different count
  * Color-coded score (e.g. green "Trusted") but accompanying copy describes high risk ("stop interacting immediately")
  * Numeric breakdown that doesn't add up (17/20 safe but "3 suspicious" elsewhere)
- Flag any product roadmap / internal team language exposed to end users:
  * "the biggest next step is..."
  * "future work includes..."
  * "TODO" / "FIXME" / "WIP" in user copy
- Flag any UI state that contradicts the data:
  * SSL certificate marked "expired" for a well-known domain (google.com / cloudflare.com)
  * "0 results" stats counters when the content area clearly shows multiple items

Guidelines:
- "visual_polish" must be benchmarked against Stripe / Linear / Vercel / Notion.
- "localization" must check for any non-${persona.language} text. The product's own brand names (e.g. the audited site's brand and trademarks), well-known acronyms (URL, AI, API, GDPR, OFAC, USDT, KYC, DeFi, SDK, SaaS, B2B, B2C, NFT), and ISO currency codes are exempt.
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

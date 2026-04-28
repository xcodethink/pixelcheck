import Anthropic from "@anthropic-ai/sdk";
import { getCostGuard } from "./cost-guard.js";

let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error("ANTHROPIC_API_KEY not set");
    }
    client = new Anthropic({ apiKey: key });
  }
  return client;
}

export interface VisionImage {
  base64: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  /** Optional human label that's prepended in the prompt before this image */
  label?: string;
}

export interface VisionRequest {
  model: string;
  systemPrompt?: string;
  userPrompt: string;
  /** Single-image legacy field */
  imageBase64?: string;
  imageMediaType?: "image/png" | "image/jpeg" | "image/webp";
  /** Multi-image input. If both imageBase64 and images are set, images wins. */
  images?: VisionImage[];
  maxTokens?: number;
}

export interface VisionResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Send one or more images + prompt to Claude vision.
 *
 * Pricing reference (USD per million tokens, as of late 2025):
 *   Sonnet 4.6: $3 input / $15 output
 *   Opus 4.6:   $15 input / $75 output
 */
export async function callVision(req: VisionRequest): Promise<VisionResponse> {
  const c = getAnthropicClient();

  const images: VisionImage[] =
    req.images && req.images.length > 0
      ? req.images
      : req.imageBase64
        ? [
            {
              base64: req.imageBase64,
              mediaType: req.imageMediaType ?? "image/png",
            },
          ]
        : [];

  if (images.length === 0) {
    throw new Error("callVision requires at least one image");
  }

  const content: Anthropic.Messages.ContentBlockParam[] = [];
  for (const img of images) {
    if (img.label) {
      content.push({ type: "text", text: img.label });
    }
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mediaType,
        data: img.base64,
      },
    });
  }
  content.push({ type: "text", text: req.userPrompt });

  const guard = getCostGuard();
  guard.checkBudget();
  const response = await c.messages.create({
    model: req.model,
    max_tokens: req.maxTokens ?? 2048,
    system: req.systemPrompt,
    messages: [{ role: "user", content }],
  });

  const text = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  guard.recordUsage(
    req.model,
    response.usage.input_tokens,
    response.usage.output_tokens,
  );
  const costUsd = estimateCost(
    req.model,
    response.usage.input_tokens,
    response.usage.output_tokens,
  );

  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    costUsd,
  };
}

const PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-4-6": { in: 15, out: 75 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5-20251001": { in: 0.8, out: 4 },
};

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = PRICING[model] ?? PRICING["claude-sonnet-4-6"]!;
  return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
}

/**
 * Extract a JSON object from text that may include code fences or prose.
 * Falls back to a "best-effort" close-the-braces repair for truncated output
 * (e.g. when max_tokens cuts the model off mid-array).
 * Throws if nothing salvageable.
 */
export function extractJson<T = unknown>(text: string): T {
  // Try fenced first
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1]) as T;
    } catch {
      // try repair
      const repaired = repairTruncatedJson(fenced[1]);
      if (repaired !== null) {
        try {
          return JSON.parse(repaired) as T;
        } catch {
          // fall through
        }
      }
    }
  }

  // Try to find first { ... } balanced
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            return JSON.parse(candidate) as T;
          } catch {
            break;
          }
        }
      }
    }

    // If we got here, the brace stack never closed — try repair on the rest
    const tail = text.slice(start);
    const repaired = repairTruncatedJson(tail);
    if (repaired !== null) {
      try {
        return JSON.parse(repaired) as T;
      } catch {
        // fall through
      }
    }
  }

  throw new Error(`No valid JSON found in response: ${text.slice(0, 200)}...`);
}

/**
 * Best-effort repair for JSON output that was truncated mid-stream.
 * Strategy:
 *   1. Find the last fully-formed value (string, number, boolean, object, array)
 *   2. Drop everything after it
 *   3. Close any open arrays / objects with matching brackets
 *
 * Returns repaired string or null if unrecoverable.
 */
function repairTruncatedJson(input: string): string | null {
  // Walk forward, tracking the bracket stack and the position of the last
  // "complete" structural element.
  const stack: Array<"{" | "["> = [];
  let inStr = false;
  let escape = false;
  let lastSafeEnd = -1;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      if (!inStr) lastSafeEnd = i + 1;
      continue;
    }
    if (inStr) continue;
    if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}") {
      if (stack[stack.length - 1] === "{") {
        stack.pop();
        lastSafeEnd = i + 1;
      }
    } else if (ch === "]") {
      if (stack[stack.length - 1] === "[") {
        stack.pop();
        lastSafeEnd = i + 1;
      }
    } else if (ch === "," || ch === ":" || /\s/.test(ch ?? "")) {
      // structural punctuation — don't update lastSafeEnd
    } else {
      // value char (number, true, false, null) — accept up to comma
      lastSafeEnd = i + 1;
    }
  }

  if (lastSafeEnd <= 0) return null;

  // Trim to last safe end, then strip any trailing partial element after a comma
  let truncated = input.slice(0, lastSafeEnd);
  // If the truncation ended with a partial number/identifier, walk back to last , or [ or {
  // (lastSafeEnd accounting above already handles strings and full structural values)

  // Drop trailing commas
  truncated = truncated.replace(/,\s*$/, "");

  // Re-walk the stack on the truncated portion to count what's still open
  const closeStack: string[] = [];
  let inStr2 = false;
  let escape2 = false;
  for (let i = 0; i < truncated.length; i++) {
    const ch = truncated[i];
    if (escape2) {
      escape2 = false;
      continue;
    }
    if (ch === "\\") {
      escape2 = true;
      continue;
    }
    if (ch === '"') {
      inStr2 = !inStr2;
      continue;
    }
    if (inStr2) continue;
    if (ch === "{") closeStack.push("}");
    else if (ch === "[") closeStack.push("]");
    else if (ch === "}" || ch === "]") closeStack.pop();
  }

  if (inStr2) {
    // we're inside an unterminated string — close it and the structure
    truncated += '"';
  }
  // Close all open structures in reverse
  while (closeStack.length > 0) {
    truncated += closeStack.pop();
  }
  return truncated;
}

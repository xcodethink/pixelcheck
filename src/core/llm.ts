import Anthropic from "@anthropic-ai/sdk";
import { getCostGuard } from "./cost-guard.js";

let client: Anthropic | null = null;

/**
 * Per-request timeout for Anthropic calls. The SDK default is 10 minutes, so a
 * black-holed connection stalls the whole agent loop for that long before it
 * even retries — the loop has no other wall-clock guard. Bound it to a
 * configurable default (120s) so a hung request fails fast and the run can
 * proceed/abort instead of wedging. (Audit 2026-06-02 D2-C2.)
 */
export function llmTimeoutMs(): number {
  const raw = Number(process.env.PIXELCHECK_LLM_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

export function getAnthropicClient(): Anthropic {
  if (!client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error("ANTHROPIC_API_KEY not set");
    }
    client = new Anthropic({
      apiKey: key,
      timeout: llmTimeoutMs(),
      maxRetries: 2,
    });
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

// Most-expensive known rate — the conservative fallback for unknown model ids.
// Falling back to a cheap rate (previously Sonnet) silently UNDER-counts spend
// for a typo'd/new model, weakening every budget cap. Over-estimating an
// unknown model is the safe direction for a guard. (Audit 2026-06-02 E5.)
const HIGHEST_RATE = Object.values(PRICING).reduce((hi, x) =>
  x.in + x.out > hi.in + hi.out ? x : hi,
);

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = PRICING[model] ?? HIGHEST_RATE;
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
  // True while scanning an unterminated bare value (number / true / false /
  // null). We do NOT advance lastSafeEnd over its characters: a bare value
  // is only trustworthy once a delimiter proves it's complete. A number cut
  // mid-digit (e.g. `123` of `12345`) would otherwise close into
  // structurally-valid-but-WRONG JSON that silently "passes". (Audit
  // 2026-06-02 D2-M5/D3-M1 — implements the walk-back this function's own
  // comment always promised but never did.)
  let inBareValue = false;
  // lastSafeEnd as it stood just before the most recently-closed string. A
  // closing quote optimistically marks a safe end (good for a string VALUE),
  // but if the very next structural char is `:` the string was actually a
  // KEY — `{"k"` is not resumable — so we roll lastSafeEnd back to here.
  let safeEndBeforeString = -1;

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
      // A string starts/ends here — any pending bare value is terminated by
      // it and is therefore complete up to this point.
      if (inBareValue) {
        lastSafeEnd = i;
        inBareValue = false;
      }
      inStr = !inStr;
      if (!inStr) {
        // String just closed — remember where we'd fall back to if this
        // turns out to be a key (see the `:` handler below).
        safeEndBeforeString = lastSafeEnd;
        lastSafeEnd = i + 1;
      }
      continue;
    }
    if (inStr) continue;

    // A delimiter terminates (and thus confirms) a pending bare value: the
    // value occupies [start, i); the delimiter at i is excluded.
    const isStructural =
      ch === "{" ||
      ch === "[" ||
      ch === "}" ||
      ch === "]" ||
      ch === "," ||
      ch === ":";
    if (inBareValue && (isStructural || /\s/.test(ch ?? ""))) {
      lastSafeEnd = i;
      inBareValue = false;
    }

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
    } else if (ch === ":") {
      // The string immediately before this colon was a KEY, not a value, so
      // its closing quote should not have counted as a safe end (`{"k"` is
      // not resumable). Roll back to before that key.
      lastSafeEnd = safeEndBeforeString;
    } else if (ch === "," || /\s/.test(ch ?? "")) {
      // structural punctuation — don't update lastSafeEnd
    } else {
      // First char of a bare value (number, true, false, null). Provisional
      // only — lastSafeEnd stays put until a delimiter terminates the token.
      inBareValue = true;
    }
  }

  // An unterminated bare value at end-of-input is dropped: lastSafeEnd was
  // never advanced over it, so we fall back to the last delimiter-confirmed
  // position.
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

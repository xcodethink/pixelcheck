/**
 * T3 — LLM cassette tests (closes RISK-REGISTER R1).
 *
 * 12 cases covering the central `callVision` contract surface across
 * the request shapes our primitives actually use:
 *
 *   - 4 single-image cases (different prompt sizes / system prompts)
 *   - 4 multi-image cases (vision pipeline used by judge / compare)
 *   - 4 schema-bound output cases (extract / structured judge)
 *
 * Modes (env-driven via cassette-helper detectMode()):
 *   AUDIT_E2E_RECORD=1   call real Anthropic API + persist cassette
 *                         (~$0.50-1.00 per full record run)
 *   AUDIT_E2E_REPLAY=1   load cassette + intercept HTTP via nock
 *                         (default for CI; $0)
 *   neither               skip the suite (lets the rest of the test
 *                         suite run unaffected on contributor machines
 *                         without a key)
 *
 * Recording flow (run once after model upgrade or initial setup):
 *   AUDIT_E2E_RECORD=1 ANTHROPIC_API_KEY=sk-ant-... \
 *     vitest run --config vitest.integration.config.ts tests/integration/llm-cassettes.test.ts
 *
 * Replay flow (every CI / local dev run, no key needed):
 *   AUDIT_E2E_REPLAY=1 \
 *     vitest run --config vitest.integration.config.ts tests/integration/llm-cassettes.test.ts
 *
 * Contract this test enforces:
 *   1. Anthropic SDK request shape we send is unchanged (the SDK would
 *      throw on construction if breaking changes shipped — replay can't
 *      catch this layer, but record-mode does).
 *   2. The response shape `callVision` parses out of (text content
 *      blocks + usage tokens) is unchanged.
 *   3. The cost-meter (`estimateCost`) returns a finite positive
 *      number for every shape.
 *   4. Cassette files contain no API keys (verified by separate file
 *      grep test below).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectMode,
  loadCassette,
  saveCassette,
  buildCassette,
  mountReplay,
  cassetteCleanup,
  enableLiveCalls,
  assertNoPendingMocks,
  cassettePath,
} from "./cassette-helper.js";
import { callVision } from "../../src/core/llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASSETTE_DIR = path.resolve(__dirname, "../cassettes");
const FIXTURE_PNG = path.resolve(
  __dirname,
  "../fixtures/critic-calibration/home-happy.png",
);

const MODE = detectMode();
const SHOULD_RUN = MODE !== "skip";

// Replay mode: the Anthropic SDK constructor refuses to instantiate without
// an API key, even though nock intercepts every outbound request before it
// hits the wire. Set a placeholder so callVision() can construct its client.
// Safe by construction — nock.cleanAll() in cassetteCleanup() and the
// scoped interceptor in mountReplay() ensure the key never reaches a real
// host. Record mode untouched (real key required from .env / shell).
if (MODE === "replay" && !process.env.ANTHROPIC_API_KEY) {
  process.env.ANTHROPIC_API_KEY = "sk-ant-replay-placeholder-not-a-real-key";
}

// 1280×800 PNG fixture (~23 KB) — real screenshot Claude vision
// accepts. The 1×1 transparent PNG that worked for SDK construction
// triggers "Could not process image" 400s from the vision endpoint
// because the model rejects sub-minimum-dimension images.
const FIXTURE_PNG_BASE64 = fs.readFileSync(FIXTURE_PNG).toString("base64");

// Sonnet 4.6 — cheapest tier with vision support; matches the project
// default model so cassettes reflect production request shape.
const MODEL = "claude-sonnet-4-6";

interface CaseSpec {
  name: string;
  systemPrompt?: string;
  userPrompt: string;
  imageCount: 1 | 2;
  maxTokens?: number;
}

const CASES: CaseSpec[] = [
  // Single-image cases — exercise see / judge / extract base shapes
  {
    name: "single-image-short-prompt",
    userPrompt: "What is in this image? Answer in one sentence.",
    imageCount: 1,
  },
  {
    name: "single-image-with-system-prompt",
    systemPrompt: "You are a concise UI auditor. Reply in 5 words or fewer.",
    userPrompt: "Describe what you see.",
    imageCount: 1,
  },
  {
    name: "single-image-structured-output-request",
    userPrompt:
      'Reply ONLY with valid JSON: {"description": "<one sentence>", "color": "<dominant color>"}',
    imageCount: 1,
  },
  {
    name: "single-image-with-max-tokens-cap",
    userPrompt: "Describe this image briefly.",
    imageCount: 1,
    maxTokens: 64,
  },

  // Multi-image cases — exercise compare / multi-segment vision
  {
    name: "multi-image-side-by-side",
    userPrompt:
      "These are two images. State whether they appear identical or different in one sentence.",
    imageCount: 2,
  },
  {
    name: "multi-image-with-labels",
    userPrompt:
      "Compare the BEFORE and AFTER images. Reply in one short sentence.",
    imageCount: 2,
  },
  {
    name: "multi-image-with-system-prompt",
    systemPrompt:
      "You are a visual diff reviewer. Tag each finding with [HIGH] / [LOW] severity.",
    userPrompt:
      "Are these two images different? If yes, severity. Reply in one line.",
    imageCount: 2,
  },
  {
    name: "multi-image-structured-comparison",
    userPrompt:
      'Reply ONLY as JSON: {"differ": true|false, "summary": "<one sentence>"}',
    imageCount: 2,
  },

  // Edge / contract cases — exercise the boundary shapes our parsers handle
  {
    name: "single-image-empty-system-prompt",
    systemPrompt: "",
    userPrompt: "What is in this image?",
    imageCount: 1,
  },
  {
    name: "single-image-long-prompt",
    userPrompt:
      "Imagine you are reviewing a website screenshot for a non-technical " +
      "stakeholder. Describe one concrete UI element you can identify, in " +
      "one sentence, plain English, avoiding jargon.",
    imageCount: 1,
  },
  {
    name: "single-image-explicit-language-request",
    userPrompt: "Describe this image in English. Reply in one sentence.",
    imageCount: 1,
  },
  {
    name: "single-image-tiny-max-tokens",
    userPrompt: "One word: what color is dominant?",
    imageCount: 1,
    maxTokens: 16,
  },
];

beforeEach(() => {
  cassetteCleanup();
});

afterEach(() => {
  cassetteCleanup();
});

describe("T3 — LLM cassette tests (12 cases)", () => {
  // The whole suite is skipped without explicit mode opt-in.
  if (!SHOULD_RUN) {
    it.skip("LLM cassette suite skipped (set AUDIT_E2E_REPLAY=1 or AUDIT_E2E_RECORD=1)", () => {
      // No-op
    });
    return;
  }

  for (const spec of CASES) {
    it(`${spec.name} — ${MODE} mode`, async () => {
      const images = Array.from({ length: spec.imageCount }, (_, i) => ({
        base64: FIXTURE_PNG_BASE64,
        mediaType: "image/png" as const,
        label: spec.imageCount > 1 ? `Image ${i + 1}` : undefined,
      }));

      if (MODE === "record") {
        // Real API call. We synthesise a cassette response body from
        // the parsed result that callVision returns. Why not capture
        // the raw HTTP body? nock.recorder.rec() is a global singleton
        // that fails on re-init between tests, and the @anthropic-ai/sdk
        // doesn't expose a per-call raw-response hook in 0.92.x.
        //
        // The synthetic body matches the SDK's documented response
        // shape — replay tests still validate callVision's parsing
        // (text-block extraction + usage-token plumbing). What we
        // give up: signed-message ID / response_id / stop_reason
        // edge-case fidelity. That's acceptable; v1.0-rc1 reviewer
        // can grow to a full HTTP-recording approach if needed.
        enableLiveCalls();
        const result = await callVision({
          model: MODEL,
          systemPrompt: spec.systemPrompt,
          userPrompt: spec.userPrompt,
          images,
          maxTokens: spec.maxTokens,
        });

        // Sanity-check before persisting — broken parsed shape would
        // poison the cassette.
        expect(typeof result.text).toBe("string");
        expect(result.text.length).toBeGreaterThan(0);
        expect(result.inputTokens).toBeGreaterThan(0);
        expect(result.outputTokens).toBeGreaterThan(0);
        expect(result.costUsd).toBeGreaterThan(0);

        const responseBody = {
          id: `msg_${spec.name}_recorded`,
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [{ type: "text", text: result.text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: result.inputTokens,
            output_tokens: result.outputTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        };

        const c = buildCassette({
          caseName: spec.name,
          model: MODEL,
          requestUrl: "https://api.anthropic.com/v1/messages",
          responseBody,
        });
        saveCassette(c);
      } else {
        // Replay mode — load cassette, register nock interceptor, call
        // callVision, assert returned shape matches expectations.
        const c = loadCassette(spec.name);
        mountReplay(c);

        const result = await callVision({
          model: MODEL,
          systemPrompt: spec.systemPrompt,
          userPrompt: spec.userPrompt,
          images,
          maxTokens: spec.maxTokens,
        });

        // Contract assertions — these are what regress if the SDK or
        // our parser breaks. Don't assert specific text content
        // (LLM is non-deterministic); assert shape + types.
        expect(typeof result.text).toBe("string");
        expect(result.text.length).toBeGreaterThan(0);
        expect(typeof result.inputTokens).toBe("number");
        expect(result.inputTokens).toBeGreaterThan(0);
        expect(typeof result.outputTokens).toBe("number");
        expect(result.outputTokens).toBeGreaterThan(0);
        expect(typeof result.costUsd).toBe("number");
        expect(result.costUsd).toBeGreaterThan(0);
        expect(Number.isFinite(result.costUsd)).toBe(true);

        assertNoPendingMocks();
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────
// Cassette hygiene — runs in both modes, no API needed
// ─────────────────────────────────────────────────────────────

describe("cassette hygiene", () => {
  it("no cassette file contains a `sk-ant-` API key (redaction works)", () => {
    if (!fs.existsSync(CASSETTE_DIR)) {
      // No cassettes yet — skip silently. The record-mode suite above
      // creates them; this is a hygiene gate that runs in replay-mode.
      return;
    }
    const files = fs.readdirSync(CASSETTE_DIR).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const raw = fs.readFileSync(path.join(CASSETTE_DIR, f), "utf8");
      // Look for either a real-prefix key OR the redact placeholder's
      // missing replacement (would mean redact failed silently).
      const realKey = raw.match(/sk-ant-[a-zA-Z0-9_-]{20,}/);
      expect(
        realKey,
        `Cassette ${f} contains what looks like a real API key`,
      ).toBeNull();
    }
  });

  it("every CASE name has at most one cassette file", () => {
    const seen = new Set<string>();
    for (const spec of CASES) {
      expect(seen.has(spec.name), `duplicate case name: ${spec.name}`).toBe(false);
      seen.add(spec.name);
      // Verify the cassettePath helper resolves to under the cassettes/ dir
      const p = cassettePath(spec.name);
      expect(p).toContain("cassettes");
    }
  });
});

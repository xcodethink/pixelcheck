/**
 * Tests for src/core/critic.ts — Vision Critic.
 *
 * Mocks `./llm.js` so callVision is deterministic. compressForVision runs
 * for real (sharp + magic-byte detect — already covered in image.test.ts)
 * so the integration of compress → vision → JSON parse → score/issue
 * mapping is exercised end-to-end. Uses a captured-arg approach so we can
 * assert on the prompts the critic sends to the model (anti-hallucination
 * rules / persona context / scoring-dimensions plumbing).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as crypto from "node:crypto";
import sharp from "sharp";
import type { Persona, Scenario } from "../src/core/types.js";
import type { VisionResponse } from "../src/core/llm.js";

// vi.mock factory must not capture variables from outer scope; use vi.hoisted.
const llmMock = vi.hoisted(() => {
  const captures: { lastReq: unknown } = { lastReq: null };
  const next: { value: VisionResponse | Error | null } = { value: null };
  return {
    captures,
    next,
    callVision: vi.fn(async (req: unknown) => {
      captures.lastReq = req;
      const v = next.value;
      if (v instanceof Error) throw v;
      if (!v) {
        return {
          text: "{}",
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        };
      }
      return v;
    }),
  };
});

vi.mock("../src/core/llm.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/llm.js")>(
    "../src/core/llm.js",
  );
  return {
    ...actual, // keep extractJson real
    callVision: llmMock.callVision,
  };
});

// Import AFTER vi.mock so the critic picks up the mocked callVision.
import { runCritic } from "../src/core/critic.js";
import { RESULT_SCHEMA_VERSION } from "../src/core/result-schema.js";

async function makePngBytes(width = 32, height = 32): Promise<Buffer> {
  // Random pixels so different calls produce distinguishable outputs.
  return sharp(crypto.randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  })
    .png()
    .toBuffer();
}

function basePersona(over: Partial<Persona> = {}): Persona {
  return {
    id: "u1",
    display_name: "Tester",
    country: "JP",
    language: "ja",
    locale: "ja-JP",
    timezone: "Asia/Tokyo",
    device_class: "desktop",
    payment_tier: "free",
    mental_model: "Detail-oriented Japanese power user; cares about typography",
    critical_concerns: ["typography", "localization"],
    ...over,
  };
}

function baseScenario(over: Partial<Scenario> = {}): Scenario {
  return {
    id: "s1",
    name: "Hero localization smoke",
    priority: "P0",
    goal: "Verify the homepage renders fully in Japanese",
    applies_to: { personas: ["u1"] },
    scoring_dimensions: ["completion", "localization", "visual_polish"],
    mode: "scripted",
    steps: [
      {
        id: "v1",
        type: "visit",
        url: "https://x.example/",
        wait_until: "domcontentloaded",
        critical: false,
        critical_review: false,
        retry: 2,
      },
    ],
    persistent_storage: false,
    ...(over as object),
  } as Scenario;
}

beforeEach(() => {
  llmMock.callVision.mockClear();
  llmMock.next.value = null;
  llmMock.captures.lastReq = null;
});

// ─────────────────────────────────────────────────────────────
// Single-image happy path
// ─────────────────────────────────────────────────────────────

describe("runCritic — happy path (single image)", () => {
  it("returns scores + issues + cost from a well-formed vision response", async () => {
    llmMock.next.value = {
      text: JSON.stringify({
        scores: [
          {
            dimension: "completion",
            score: 8.5,
            justification: "Flow completed.",
          },
          {
            dimension: "localization",
            score: 7,
            justification: "All text is Japanese.",
          },
        ],
        issues: [
          {
            severity: "medium",
            dimension: "visual_polish",
            description: "Hero CTA contrast is below 4.5:1.",
            recommendation: "Bump button background to a darker green.",
          },
        ],
      }),
      inputTokens: 1234,
      outputTokens: 456,
      costUsd: 0.018,
    };

    const result = await runCritic({
      model: "claude-sonnet-4-6",
      persona: basePersona(),
      scenario: baseScenario(),
      instruction: "Review the homepage hero.",
      imageBuffers: [await makePngBytes()],
      stepId: "step-1",
    });

    expect(result.schema_version).toBe(RESULT_SCHEMA_VERSION);
    expect(result.costUsd).toBe(0.018);
    expect(result.scores).toEqual([
      {
        dimension: "completion",
        score: 8.5,
        justification: "Flow completed.",
      },
      {
        dimension: "localization",
        score: 7,
        justification: "All text is Japanese.",
      },
    ]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toEqual({
      severity: "medium",
      step_id: "step-1",
      dimension: "visual_polish",
      description: "Hero CTA contrast is below 4.5:1.",
      recommendation: "Bump button background to a darker green.",
    });
    expect(result.raw.text).toContain("scores");
  });

  it("does not attach a label when only one image is sent", async () => {
    llmMock.next.value = { text: "{}", inputTokens: 0, outputTokens: 0, costUsd: 0 };
    await runCritic({
      model: "x",
      persona: basePersona(),
      scenario: baseScenario(),
      instruction: "i",
      imageBuffers: [await makePngBytes()],
      stepId: "s",
    });
    const req = llmMock.captures.lastReq as { images: { label?: string }[] };
    expect(req.images).toHaveLength(1);
    expect(req.images[0].label).toBeUndefined();
  });

  it("forwards maxTokens=4096 to support 20+ violations without truncation", async () => {
    llmMock.next.value = { text: "{}", inputTokens: 0, outputTokens: 0, costUsd: 0 };
    await runCritic({
      model: "x",
      persona: basePersona(),
      scenario: baseScenario(),
      instruction: "i",
      imageBuffers: [await makePngBytes()],
      stepId: "s",
    });
    const req = llmMock.captures.lastReq as { maxTokens: number };
    expect(req.maxTokens).toBe(4096);
  });

  it("accepts code-fenced ```json ... ``` responses (extractJson handles fence)", async () => {
    llmMock.next.value = {
      text: '```json\n{"scores":[{"dimension":"x","score":6,"justification":"j"}],"issues":[]}\n```',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    const result = await runCritic({
      model: "x",
      persona: basePersona(),
      scenario: baseScenario(),
      instruction: "i",
      imageBuffers: [await makePngBytes()],
      stepId: "s",
    });
    expect(result.scores[0].dimension).toBe("x");
  });
});

// ─────────────────────────────────────────────────────────────
// Multi-image label convention
// ─────────────────────────────────────────────────────────────

describe("runCritic — multi-image label convention", () => {
  it("labels image 0 as full-page thumbnail and rest as viewport segments N of M", async () => {
    llmMock.next.value = { text: "{}", inputTokens: 0, outputTokens: 0, costUsd: 0 };
    await runCritic({
      model: "x",
      persona: basePersona(),
      scenario: baseScenario(),
      instruction: "i",
      imageBuffers: [
        await makePngBytes(),
        await makePngBytes(),
        await makePngBytes(),
        await makePngBytes(),
      ],
      stepId: "s",
    });
    const req = llmMock.captures.lastReq as { images: { label?: string }[] };
    expect(req.images).toHaveLength(4);
    expect(req.images[0].label).toMatch(/FULL-PAGE THUMBNAIL/);
    expect(req.images[0].label).toMatch(/macro context/);
    expect(req.images[1].label).toMatch(/^VIEWPORT SEGMENT 1 of 3 /);
    expect(req.images[2].label).toMatch(/^VIEWPORT SEGMENT 2 of 3 /);
    expect(req.images[3].label).toMatch(/^VIEWPORT SEGMENT 3 of 3 /);
  });

  it("preserves image ordering — first PNG buffer maps to label index 0", async () => {
    llmMock.next.value = { text: "{}", inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const buf0 = await makePngBytes(20, 20); // distinct sizes so base64 differs
    const buf1 = await makePngBytes(40, 40);
    await runCritic({
      model: "x",
      persona: basePersona(),
      scenario: baseScenario(),
      instruction: "i",
      imageBuffers: [buf0, buf1],
      stepId: "s",
    });
    const req = llmMock.captures.lastReq as { images: { base64: string }[] };
    expect(req.images[0].base64).toBe(buf0.toString("base64"));
    expect(req.images[1].base64).toBe(buf1.toString("base64"));
  });
});

// ─────────────────────────────────────────────────────────────
// Verdict.violations — localization audit shape
// ─────────────────────────────────────────────────────────────

describe("runCritic — verdict.violations mapping", () => {
  it("turns each violation into a high-severity localization issue", async () => {
    llmMock.next.value = {
      text: JSON.stringify({
        scores: [],
        issues: [],
        violations: [
          { text: "Get Started", location: "hero CTA" },
          { text: "Learn more" },
        ],
      }),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0.001,
    };
    const result = await runCritic({
      model: "x",
      persona: basePersona(),
      scenario: baseScenario(),
      instruction: "i",
      imageBuffers: [await makePngBytes()],
      stepId: "step-violations",
    });

    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]).toEqual({
      severity: "high",
      step_id: "step-violations",
      dimension: "localization",
      description: 'Foreign-language text found: "Get Started" at hero CTA',
      recommendation:
        "Translate or remove this text in the relevant locale file.",
    });
    expect(result.issues[1].description).toBe(
      'Foreign-language text found: "Learn more"',
    );
    expect(result.issues[1].description).not.toMatch(/ at /);
  });

  it("ignores empty violations array", async () => {
    llmMock.next.value = {
      text: JSON.stringify({ scores: [], issues: [], violations: [] }),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    const result = await runCritic({
      model: "x",
      persona: basePersona(),
      scenario: baseScenario(),
      instruction: "i",
      imageBuffers: [await makePngBytes()],
      stepId: "s",
    });
    expect(result.issues).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Malformed JSON fallback
// ─────────────────────────────────────────────────────────────

describe("runCritic — malformed-JSON resilience", () => {
  it("returns a low-severity issue when the vision response is unparseable", async () => {
    llmMock.next.value = {
      text: "the model wrote prose instead of JSON",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.005,
    };
    const result = await runCritic({
      model: "x",
      persona: basePersona(),
      scenario: baseScenario(),
      instruction: "i",
      imageBuffers: [await makePngBytes()],
      stepId: "step-bad-json",
    });

    expect(result.scores).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      severity: "low",
      step_id: "step-bad-json",
      description: expect.stringMatching(/malformed JSON/),
    });
    // Cost is still recorded — we paid for the wasted call
    expect(result.costUsd).toBe(0.005);
    // Verdict is empty defaults
    expect(result.verdict).toEqual({ scores: [], issues: [] });
    expect(result.schema_version).toBe(RESULT_SCHEMA_VERSION);
  });

  it("returns malformed-JSON issue when JSON parses but fails schema validation", async () => {
    llmMock.next.value = {
      text: JSON.stringify({
        scores: [{ dimension: "x", score: 99, justification: "j" }], // 99 > max 10
      }),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    const result = await runCritic({
      model: "x",
      persona: basePersona(),
      scenario: baseScenario(),
      instruction: "i",
      imageBuffers: [await makePngBytes()],
      stepId: "s-schema-fail",
    });
    expect(result.issues[0].severity).toBe("low");
    expect(result.issues[0].description).toMatch(/malformed JSON/);
  });

  it("propagates the underlying parse error message in the issue description", async () => {
    llmMock.next.value = {
      text: "totally not json at all",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    const result = await runCritic({
      model: "x",
      persona: basePersona(),
      scenario: baseScenario(),
      instruction: "i",
      imageBuffers: [await makePngBytes()],
      stepId: "s",
    });
    // extractJson throws "No JSON object found" — the description quotes that
    expect(result.issues[0].description).toMatch(/JSON/i);
  });
});

// ─────────────────────────────────────────────────────────────
// Schema-default plumbing
// ─────────────────────────────────────────────────────────────

describe("runCritic — verdict defaults & optional fields", () => {
  it("treats missing scores/issues arrays as empty", async () => {
    // VisionVerdictSchema sets default: [] for scores and issues
    llmMock.next.value = {
      text: JSON.stringify({}), // empty object
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    const result = await runCritic({
      model: "x",
      persona: basePersona(),
      scenario: baseScenario(),
      instruction: "i",
      imageBuffers: [await makePngBytes()],
      stepId: "s",
    });
    expect(result.scores).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(result.verdict.passed).toBeUndefined();
  });

  it("retains issue.dimension when provided", async () => {
    llmMock.next.value = {
      text: JSON.stringify({
        scores: [],
        issues: [
          {
            severity: "critical",
            dimension: "completion",
            description: "Modal blocks main flow.",
            recommendation: "Close on outside click.",
          },
        ],
      }),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    const result = await runCritic({
      model: "x",
      persona: basePersona(),
      scenario: baseScenario(),
      instruction: "i",
      imageBuffers: [await makePngBytes()],
      stepId: "step-9",
    });
    expect(result.issues[0]).toMatchObject({
      severity: "critical",
      dimension: "completion",
      step_id: "step-9",
    });
  });

  it("issue.dimension stays undefined when absent in the vision response", async () => {
    llmMock.next.value = {
      text: JSON.stringify({
        scores: [],
        issues: [
          {
            severity: "low",
            description: "Low-priority cleanup.",
            recommendation: "Address later.",
          },
        ],
      }),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    const result = await runCritic({
      model: "x",
      persona: basePersona(),
      scenario: baseScenario(),
      instruction: "i",
      imageBuffers: [await makePngBytes()],
      stepId: "s",
    });
    expect(result.issues[0].dimension).toBeUndefined();
  });

  it("preserves verdict.passed when the model sets it", async () => {
    llmMock.next.value = {
      text: JSON.stringify({ scores: [], issues: [], passed: false }),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    const result = await runCritic({
      model: "x",
      persona: basePersona(),
      scenario: baseScenario(),
      instruction: "i",
      imageBuffers: [await makePngBytes()],
      stepId: "s",
    });
    expect(result.verdict.passed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// Prompt construction (anti-hallucination + persona context)
// ─────────────────────────────────────────────────────────────

describe("runCritic — system prompt", () => {
  it("embeds persona mental_model + country + language + locale + device + tier", async () => {
    llmMock.next.value = { text: "{}", inputTokens: 0, outputTokens: 0, costUsd: 0 };
    await runCritic({
      model: "x",
      persona: basePersona({
        mental_model: "Veteran QA reviewer fluent in Japanese",
        country: "JP",
        language: "ja",
        locale: "ja-JP",
        device_class: "mobile",
        payment_tier: "pro",
      }),
      scenario: baseScenario(),
      instruction: "i",
      imageBuffers: [await makePngBytes()],
      stepId: "s",
    });
    const req = llmMock.captures.lastReq as { systemPrompt: string };
    expect(req.systemPrompt).toMatch(/Veteran QA reviewer fluent in Japanese/);
    expect(req.systemPrompt).toMatch(/Country: JP/);
    expect(req.systemPrompt).toMatch(/Language: ja \(locale: ja-JP\)/);
    expect(req.systemPrompt).toMatch(/Device: mobile/);
    expect(req.systemPrompt).toMatch(/Tier: pro/);
  });

  it("lists each critical concern as a bullet", async () => {
    llmMock.next.value = { text: "{}", inputTokens: 0, outputTokens: 0, costUsd: 0 };
    await runCritic({
      model: "x",
      persona: basePersona({
        critical_concerns: ["typography", "color contrast", "spacing rhythm"],
      }),
      scenario: baseScenario(),
      instruction: "i",
      imageBuffers: [await makePngBytes()],
      stepId: "s",
    });
    const req = llmMock.captures.lastReq as { systemPrompt: string };
    expect(req.systemPrompt).toMatch(/  - typography/);
    expect(req.systemPrompt).toMatch(/  - color contrast/);
    expect(req.systemPrompt).toMatch(/  - spacing rhythm/);
  });

  it("emits '(none specified)' when critical_concerns is empty", async () => {
    llmMock.next.value = { text: "{}", inputTokens: 0, outputTokens: 0, costUsd: 0 };
    await runCritic({
      model: "x",
      persona: basePersona({ critical_concerns: [] }),
      scenario: baseScenario(),
      instruction: "i",
      imageBuffers: [await makePngBytes()],
      stepId: "s",
    });
    const req = llmMock.captures.lastReq as { systemPrompt: string };
    expect(req.systemPrompt).toMatch(/\(none specified\)/);
  });

  it("includes the scenario goal in the system prompt", async () => {
    llmMock.next.value = { text: "{}", inputTokens: 0, outputTokens: 0, costUsd: 0 };
    await runCritic({
      model: "x",
      persona: basePersona(),
      scenario: baseScenario({ goal: "Sign up via Google OAuth and reach the dashboard." }),
      instruction: "i",
      imageBuffers: [await makePngBytes()],
      stepId: "s",
    });
    const req = llmMock.captures.lastReq as { systemPrompt: string };
    expect(req.systemPrompt).toMatch(
      /attempting: Sign up via Google OAuth and reach the dashboard\./,
    );
  });

  it("contains anti-hallucination guidance and data-exposure rules", async () => {
    llmMock.next.value = { text: "{}", inputTokens: 0, outputTokens: 0, costUsd: 0 };
    await runCritic({
      model: "x",
      persona: basePersona(),
      scenario: baseScenario(),
      instruction: "i",
      imageBuffers: [await makePngBytes()],
      stepId: "s",
    });
    const req = llmMock.captures.lastReq as { systemPrompt: string };
    expect(req.systemPrompt).toMatch(/ANTI-HALLUCINATION RULES/);
    expect(req.systemPrompt).toMatch(/DATA-EXPOSURE CHECKS/);
    expect(req.systemPrompt).toMatch(/Stripe \/ Linear \/ Vercel \/ Notion/);
    // Localization brand-name carve-out reflects persona.language
    expect(req.systemPrompt).toMatch(/non-ja text/);
  });
});

describe("runCritic — user prompt", () => {
  it("joins scenario.scoring_dimensions with ', ' and embeds the instruction", async () => {
    llmMock.next.value = { text: "{}", inputTokens: 0, outputTokens: 0, costUsd: 0 };
    await runCritic({
      model: "x",
      persona: basePersona(),
      scenario: baseScenario({
        scoring_dimensions: ["completion", "localization", "trust"],
      }),
      instruction: "Review the pricing tier card.",
      imageBuffers: [await makePngBytes()],
      stepId: "s",
    });
    const req = llmMock.captures.lastReq as { userPrompt: string };
    expect(req.userPrompt).toMatch(/^Review the pricing tier card\./);
    expect(req.userPrompt).toMatch(
      /Score the screenshot on these dimensions: completion, localization, trust/,
    );
    expect(req.userPrompt).toMatch(/Return JSON only\.$/);
  });
});

// ─────────────────────────────────────────────────────────────
// callVision propagation
// ─────────────────────────────────────────────────────────────

describe("runCritic — callVision propagation", () => {
  it("propagates errors thrown by callVision (no swallow)", async () => {
    llmMock.next.value = new Error("ANTHROPIC_API_KEY not set");
    await expect(
      runCritic({
        model: "x",
        persona: basePersona(),
        scenario: baseScenario(),
        instruction: "i",
        imageBuffers: [await makePngBytes()],
        stepId: "s",
      }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("forwards the model name to callVision unchanged", async () => {
    llmMock.next.value = { text: "{}", inputTokens: 0, outputTokens: 0, costUsd: 0 };
    await runCritic({
      model: "claude-opus-4-6",
      persona: basePersona(),
      scenario: baseScenario(),
      instruction: "i",
      imageBuffers: [await makePngBytes()],
      stepId: "s",
    });
    const req = llmMock.captures.lastReq as { model: string };
    expect(req.model).toBe("claude-opus-4-6");
  });

  it("preserves the raw VisionResponse in result.raw for replay/debugging", async () => {
    llmMock.next.value = {
      text: '{"scores":[],"issues":[]}',
      inputTokens: 12,
      outputTokens: 34,
      costUsd: 0.0042,
    };
    const result = await runCritic({
      model: "x",
      persona: basePersona(),
      scenario: baseScenario(),
      instruction: "i",
      imageBuffers: [await makePngBytes()],
      stepId: "s",
    });
    expect(result.raw).toEqual({
      text: '{"scores":[],"issues":[]}',
      inputTokens: 12,
      outputTokens: 34,
      costUsd: 0.0042,
    });
  });
});

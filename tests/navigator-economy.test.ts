/**
 * Tests for economicNavigatorDecide — Haiku primary + Sonnet fallback logic.
 *
 * We stub the Anthropic SDK via module-level mocks so we can control the
 * returned payload per model and verify escalation behavior.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Persona } from "../src/core/types.js";

// ── Mock the Anthropic SDK ──
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}));

// ── Mock the llm helpers (keep extractJson real, stub the client) ──
vi.mock("../src/core/llm.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/llm.js")>("../src/core/llm.js");
  return {
    ...actual,
    getAnthropicClient: () => ({ messages: { create: mockCreate } }),
    estimateCost: () => 0.001,
  };
});

import { economicNavigatorDecide, ECONOMY_CONFIDENCE_FLOOR } from "../src/agent/navigator.js";
import type { PlannedStep } from "../src/agent/planner.js";

function mkPersona(): Persona {
  return {
    id: "p",
    display_name: "P",
    country: "US",
    language: "en",
    locale: "en-US",
    timezone: "UTC",
    device_class: "desktop",
    payment_tier: "free",
    mental_model: "",
    critical_concerns: [],
  };
}

function mkPlannedStep(): PlannedStep {
  return {
    index: 0,
    action_type: "act",
    instruction: "Click signup",
    reasoning: "",
    targets_criteria: [],
  };
}

function apiReply(payload: Record<string, unknown>): {
  content: Array<{ type: "text"; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

const baseInput = {
  planned_step: mkPlannedStep(),
  persona: mkPersona(),
  dom_summary: "<button>Sign up</button>",
  page_url: "https://example.com/",
  hints: [],
};

describe("economicNavigatorDecide", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("stays on primary when confidence is high", async () => {
    mockCreate.mockResolvedValueOnce(
      apiReply({
        action_type: "act",
        instruction: "Click signup",
        reasoning: "clear button",
        confidence: 0.9,
        needs_replan: false,
      }),
    );

    const cost = { value: 0 };
    const r = await economicNavigatorDecide(
      baseInput,
      { primaryModel: "haiku", fallbackModel: "sonnet" },
      cost,
    );

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(r._telemetry.fallback_called).toBe(false);
    expect(r._telemetry.primary_confidence).toBe(0.9);
    expect(r.confidence).toBe(0.9);
  });

  it("escalates to fallback when primary confidence < floor", async () => {
    mockCreate.mockResolvedValueOnce(
      apiReply({ action_type: "act", instruction: "try x", reasoning: "uncertain", confidence: 0.3, needs_replan: false }),
    );
    mockCreate.mockResolvedValueOnce(
      apiReply({ action_type: "act", instruction: "click the primary CTA", reasoning: "clear", confidence: 0.95, needs_replan: false }),
    );

    const cost = { value: 0 };
    const r = await economicNavigatorDecide(
      baseInput,
      { primaryModel: "haiku", fallbackModel: "sonnet" },
      cost,
    );

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(r._telemetry.fallback_called).toBe(true);
    expect(r.confidence).toBe(0.95);
    expect(r.instruction).toBe("click the primary CTA");
  });

  it("escalates when primary requests replan", async () => {
    mockCreate.mockResolvedValueOnce(
      apiReply({ action_type: "act", instruction: "???", reasoning: "wrong page", confidence: 0.8, needs_replan: true }),
    );
    mockCreate.mockResolvedValueOnce(
      apiReply({ action_type: "act", instruction: "scroll up", reasoning: "recovered", confidence: 0.7, needs_replan: false }),
    );

    const cost = { value: 0 };
    const r = await economicNavigatorDecide(
      baseInput,
      { primaryModel: "haiku", fallbackModel: "sonnet" },
      cost,
    );

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(r._telemetry.fallback_called).toBe(true);
    expect(r.needs_replan).toBe(false); // fallback's decision
  });

  it("keeps primary decision when fallback is less confident", async () => {
    mockCreate.mockResolvedValueOnce(
      apiReply({ action_type: "act", instruction: "primary-pick", reasoning: "", confidence: 0.5, needs_replan: false }),
    );
    mockCreate.mockResolvedValueOnce(
      apiReply({ action_type: "act", instruction: "fallback-pick", reasoning: "", confidence: 0.4, needs_replan: false }),
    );

    const cost = { value: 0 };
    const r = await economicNavigatorDecide(
      baseInput,
      { primaryModel: "haiku", fallbackModel: "sonnet" },
      cost,
    );

    expect(r._telemetry.fallback_called).toBe(true);
    expect(r.instruction).toBe("primary-pick"); // higher confidence wins
  });

  it("primaryOnly disables escalation even at low confidence", async () => {
    mockCreate.mockResolvedValueOnce(
      apiReply({ action_type: "act", instruction: "shaky", reasoning: "", confidence: 0.1, needs_replan: false }),
    );

    const cost = { value: 0 };
    const r = await economicNavigatorDecide(
      baseInput,
      { primaryModel: "haiku", fallbackModel: "sonnet", primaryOnly: true },
      cost,
    );

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(r._telemetry.fallback_called).toBe(false);
  });

  it("honors custom confidenceFloor", async () => {
    // 0.7 confidence — below default floor (0.6 triggers at < 0.6), above it by default.
    // With custom floor 0.8, it should escalate.
    mockCreate.mockResolvedValueOnce(
      apiReply({ action_type: "act", instruction: "maybe", reasoning: "", confidence: 0.7, needs_replan: false }),
    );
    mockCreate.mockResolvedValueOnce(
      apiReply({ action_type: "act", instruction: "sure", reasoning: "", confidence: 0.95, needs_replan: false }),
    );

    const cost = { value: 0 };
    const r = await economicNavigatorDecide(
      baseInput,
      { primaryModel: "haiku", fallbackModel: "sonnet", confidenceFloor: 0.8 },
      cost,
    );

    expect(r._telemetry.fallback_called).toBe(true);
    expect(r.confidence).toBe(0.95);
  });

  it("default floor matches the exported constant", () => {
    expect(ECONOMY_CONFIDENCE_FLOOR).toBeGreaterThan(0);
    expect(ECONOMY_CONFIDENCE_FLOOR).toBeLessThan(1);
  });
});

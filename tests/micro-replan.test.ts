/**
 * Tests for microReplan — cheap single-step recovery.
 *
 * Stubs the Anthropic SDK client to return canned JSON payloads per kind.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Persona } from "../src/core/types.js";
import type { PlannedStep } from "../src/agent/planner.js";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}));
vi.mock("../src/core/llm.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/llm.js")>("../src/core/llm.js");
  return {
    ...actual,
    getAnthropicClient: () => ({ messages: { create: mockCreate } }),
    estimateCost: () => 0.002,
  };
});

import { microReplan } from "../src/agent/planner.js";

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

function mkStep(): PlannedStep {
  return {
    index: 2,
    action_type: "act",
    instruction: "Click the 'Sign up' button",
    reasoning: "to begin signup",
    targets_criteria: ["signup_done"],
  };
}

function apiReply(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    usage: { input_tokens: 200, output_tokens: 80 },
  };
}

const baseInput = {
  failed_step: mkStep(),
  failure_reason: "Stagehand could not find the button",
  current_url: "https://example.com/",
  dom_summary: "<form><button>Register</button></form>",
  persona: mkPersona(),
  hints: [],
};

describe("microReplan", () => {
  beforeEach(() => mockCreate.mockReset());

  it("returns 'rewrite' with a replacement step when LLM chooses it", async () => {
    mockCreate.mockResolvedValueOnce(
      apiReply({
        kind: "rewrite",
        replacement: {
          action_type: "act",
          instruction: "Click the 'Register' button",
          reasoning: "DOM shows Register not Sign up",
        },
      }),
    );
    const cost = { value: 0 };
    const r = await microReplan(baseInput, "haiku", cost);
    expect(r.kind).toBe("rewrite");
    if (r.kind === "rewrite") {
      expect(r.replacement.instruction).toBe("Click the 'Register' button");
      expect(r.replacement.index).toBe(2);
      expect(r.replacement.targets_criteria).toEqual(["signup_done"]);
    }
    expect(cost.value).toBeGreaterThan(0);
  });

  it("returns 'skip' when LLM judges the step unnecessary", async () => {
    mockCreate.mockResolvedValueOnce(
      apiReply({ kind: "skip", reason: "user is already logged in" }),
    );
    const cost = { value: 0 };
    const r = await microReplan(baseInput, "haiku", cost);
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.reason).toBe("user is already logged in");
  });

  it("returns 'escalate' when LLM requests a full replan", async () => {
    mockCreate.mockResolvedValueOnce(
      apiReply({ kind: "escalate", reason: "login flow has changed" }),
    );
    const cost = { value: 0 };
    const r = await microReplan(baseInput, "haiku", cost);
    expect(r.kind).toBe("escalate");
  });

  it("escalates when LLM output is unparseable", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "not JSON at all" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const cost = { value: 0 };
    const r = await microReplan(baseInput, "haiku", cost);
    expect(r.kind).toBe("escalate");
  });

  it("escalates when 'rewrite' payload is missing instruction", async () => {
    mockCreate.mockResolvedValueOnce(
      apiReply({ kind: "rewrite", replacement: { action_type: "act" } }),
    );
    const cost = { value: 0 };
    const r = await microReplan(baseInput, "haiku", cost);
    expect(r.kind).toBe("escalate");
  });

  it("preserves targets_criteria and index in rewrites", async () => {
    mockCreate.mockResolvedValueOnce(
      apiReply({
        kind: "rewrite",
        replacement: { action_type: "visit", instruction: "https://example.com/signup", reasoning: "direct URL" },
      }),
    );
    const cost = { value: 0 };
    const r = await microReplan(baseInput, "haiku", cost);
    expect(r.kind).toBe("rewrite");
    if (r.kind === "rewrite") {
      expect(r.replacement.index).toBe(baseInput.failed_step.index);
      expect(r.replacement.targets_criteria).toEqual(baseInput.failed_step.targets_criteria);
      expect(r.replacement.action_type).toBe("visit");
    }
  });
});

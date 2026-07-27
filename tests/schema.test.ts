import { describe, it, expect } from "vitest";
import {
  ScenarioSchema,
  SuccessCriterionSchema,
  HintSchema,
  AgentConfigSchema,
  ProjectConfigSchema,
} from "../src/core/types.js";

describe("SuccessCriterionSchema", () => {
  it("validates minimal criterion", () => {
    const result = SuccessCriterionSchema.safeParse({
      id: "c1",
      description: "Page loads",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verification).toBe("visual"); // default
    }
  });

  it("validates dom criterion with selector", () => {
    const result = SuccessCriterionSchema.safeParse({
      id: "c2",
      description: "Nav visible",
      verification: "dom",
      selector: "nav.main",
      expected: { visible: true },
    });
    expect(result.success).toBe(true);
  });

  it("validates extract criterion", () => {
    const result = SuccessCriterionSchema.safeParse({
      id: "c3",
      description: "No errors",
      verification: "extract",
      extract_instruction: "Count errors",
      expected_pattern: "^0$",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing id", () => {
    const result = SuccessCriterionSchema.safeParse({ description: "test" });
    expect(result.success).toBe(false);
  });

  it("validates network criterion", () => {
    const result = SuccessCriterionSchema.safeParse({
      id: "signup_ok",
      description: "signup endpoint returns 2xx within 3s",
      verification: "network",
      expected: {
        url_pattern: "/api/signup",
        method: "POST",
        status_range: [200, 299],
        max_duration_ms: 3000,
      },
    });
    expect(result.success).toBe(true);
  });

  it("validates performance criterion", () => {
    const result = SuccessCriterionSchema.safeParse({
      id: "core_vitals",
      description: "Core Web Vitals pass",
      verification: "performance",
      expected: { lcp_max_ms: 2500, cls_max: 0.1, inp_max_ms: 200 },
    });
    expect(result.success).toBe(true);
  });

  it("validates error criterion with ignore_patterns", () => {
    const result = SuccessCriterionSchema.safeParse({
      id: "no_errors",
      description: "no uncaught errors",
      verification: "error",
      expected: { console_error_max: 0, pageerror_max: 0, ignore_patterns: ["Third-party"] },
    });
    expect(result.success).toBe(true);
  });

  it("validates interaction criterion", () => {
    const result = SuccessCriterionSchema.safeParse({
      id: "nav_happened",
      description: "action caused navigation",
      verification: "interaction",
      expected: { url_must_change: true, min_text_length_delta: 50 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown verification value", () => {
    const result = SuccessCriterionSchema.safeParse({
      id: "x",
      description: "",
      verification: "made-up-kind",
    });
    expect(result.success).toBe(false);
  });
});

describe("HintSchema", () => {
  it("validates complete hint", () => {
    const result = HintSchema.safeParse({
      condition: "cookie banner appears",
      suggestion: "Accept all cookies",
      selector: ".cookie-accept",
    });
    expect(result.success).toBe(true);
  });

  it("validates hint without selector", () => {
    const result = HintSchema.safeParse({
      condition: "login page",
      suggestion: "Use test credentials",
    });
    expect(result.success).toBe(true);
  });
});

describe("AgentConfigSchema", () => {
  it("provides correct defaults", () => {
    const result = AgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_actions).toBe(30);
      expect(result.data.replan_threshold).toBe(3);
      expect(result.data.max_replans).toBe(3);
      expect(result.data.screenshot_frequency).toBe("every_action");
      expect(result.data.persona_reasoning).toBe(true);
    }
  });

  it("accepts custom values", () => {
    const result = AgentConfigSchema.safeParse({
      max_actions: 50,
      replan_threshold: 5,
      max_replans: 2,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_actions).toBe(50);
    }
  });
});

describe("ScenarioSchema", () => {
  // ── Scripted mode (backward compat) ─────────────────────────

  it("parses existing scripted scenario", () => {
    const result = ScenarioSchema.safeParse({
      id: "smoke",
      name: "Smoke Test",
      priority: "P0",
      goal: "Verify site loads",
      applies_to: { personas: ["us-english-free-mobile"] },
      steps: [
        { type: "visit", id: "v1", url: "https://example.com" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("scripted"); // default
    }
  });

  it("rejects scripted scenario without steps", () => {
    const result = ScenarioSchema.safeParse({
      id: "bad",
      name: "Bad",
      priority: "P0",
      goal: "Test",
      applies_to: { personas: ["us"] },
      mode: "scripted",
      // no steps
    });
    expect(result.success).toBe(false);
  });

  // ── Autonomous mode ─────────────────────────────────────────

  it("parses autonomous scenario", () => {
    const result = ScenarioSchema.safeParse({
      id: "auto-signup",
      name: "Auto Signup",
      priority: "P0",
      goal: "Sign up for an account",
      mode: "autonomous",
      start_url: "https://example.com",
      applies_to: { personas: ["us-english-free-mobile"] },
      success_criteria: [
        { id: "c1", description: "Dashboard visible", verification: "visual" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("autonomous");
      expect(result.data.success_criteria).toHaveLength(1);
      expect(result.data.start_url).toBe("https://example.com");
    }
  });

  it("parses autonomous scenario with hints and agent_config", () => {
    const result = ScenarioSchema.safeParse({
      id: "auto-full",
      name: "Full Auto",
      priority: "P0",
      goal: "Complete checkout",
      mode: "autonomous",
      start_url: "https://shop.example.com",
      applies_to: { personas: ["us-english-free-mobile"] },
      success_criteria: [
        { id: "c1", description: "Order confirmed", verification: "visual" },
      ],
      hints: [
        { condition: "cookie banner", suggestion: "Accept cookies" },
      ],
      agent_config: {
        max_actions: 20,
        replan_threshold: 2,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hints).toHaveLength(1);
      expect(result.data.agent_config?.max_actions).toBe(20);
    }
  });

  it("rejects autonomous scenario without success_criteria", () => {
    const result = ScenarioSchema.safeParse({
      id: "bad-auto",
      name: "Bad Auto",
      priority: "P0",
      goal: "Test",
      mode: "autonomous",
      start_url: "https://example.com",
      applies_to: { personas: ["us"] },
      // no success_criteria
    });
    expect(result.success).toBe(false);
  });

  it("rejects autonomous scenario without start_url", () => {
    const result = ScenarioSchema.safeParse({
      id: "bad-auto2",
      name: "Bad Auto 2",
      priority: "P0",
      goal: "Test",
      mode: "autonomous",
      applies_to: { personas: ["us"] },
      success_criteria: [{ id: "c1", description: "test" }],
      // no start_url
    });
    expect(result.success).toBe(false);
  });

  it("rejects autonomous scenario with empty success_criteria", () => {
    const result = ScenarioSchema.safeParse({
      id: "bad-auto3",
      name: "Bad Auto 3",
      priority: "P0",
      goal: "Test",
      mode: "autonomous",
      start_url: "https://example.com",
      applies_to: { personas: ["us"] },
      success_criteria: [], // empty
    });
    expect(result.success).toBe(false);
  });
});

describe("ProjectConfigSchema", () => {
  it("parses config with new model fields", () => {
    const result = ProjectConfigSchema.safeParse({
      project_name: "test",
      base_url: "https://example.com",
      models: {
        planner: "claude-opus-4-6",
        navigator: "claude-sonnet-4-6",
        replan: "claude-sonnet-4-6",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.models.planner).toBe("claude-opus-4-6");
      expect(result.data.models.navigator).toBe("claude-sonnet-4-6");
      // Defaults for non-specified fields
      expect(result.data.models.default).toBe("claude-sonnet-4-6");
      expect(result.data.models.critic).toBe("claude-sonnet-4-6");
    }
  });

  it("parses config with agent section", () => {
    const result = ProjectConfigSchema.safeParse({
      project_name: "test",
      base_url: "https://example.com",
      agent: {
        default_max_actions: 50,
        criteria_check_interval: 5,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agent?.default_max_actions).toBe(50);
      expect(result.data.agent?.criteria_check_interval).toBe(5);
    }
  });

  it("parses config with observer section", () => {
    const result = ProjectConfigSchema.safeParse({
      project_name: "test",
      base_url: "https://example.com",
      observer: {
        port: 4000,
        persist_events: false,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.observer?.port).toBe(4000);
      expect(result.data.observer?.persist_events).toBe(false);
    }
  });

  it("backward compatible: parses old config without new fields", () => {
    const result = ProjectConfigSchema.safeParse({
      project_name: "test",
      base_url: "https://example.com",
      // No models, no agent, no observer
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.models.planner).toBe("claude-opus-4-6");
      expect(result.data.agent).toBeUndefined();
      expect(result.data.observer).toBeUndefined();
    }
  });
});

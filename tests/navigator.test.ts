import { describe, it, expect } from "vitest";
import { buildStepFromDecision, type NavigatorDecision } from "../src/agent/navigator.js";

function makeDecision(overrides?: Partial<NavigatorDecision>): NavigatorDecision {
  return {
    action_type: "act",
    instruction: "Click the login button",
    reasoning: "Login button is visible",
    confidence: 0.9,
    needs_replan: false,
    ...overrides,
  };
}

describe("buildStepFromDecision", () => {
  it("builds act step with correct properties", () => {
    const step = buildStepFromDecision(makeDecision(), 0);

    expect(step.type).toBe("act");
    expect(step.id).toBe("auto-0");
    if (step.type === "act") {
      expect(step.instruction).toBe("Click the login button");
    }
    expect(step.critical).toBe(false);
    expect(step.retry).toBe(2);
  });

  it("builds visit step", () => {
    const step = buildStepFromDecision(
      makeDecision({ action_type: "visit", instruction: "https://example.com" }),
      1,
    );

    expect(step.type).toBe("visit");
    expect(step.id).toBe("auto-1");
    if (step.type === "visit") {
      expect(step.url).toBe("https://example.com");
      expect(step.wait_until).toBe("domcontentloaded");
    }
  });

  it("builds extract step", () => {
    const step = buildStepFromDecision(
      makeDecision({ action_type: "extract", instruction: "Get the page title" }),
      2,
    );

    expect(step.type).toBe("extract");
    if (step.type === "extract") {
      expect(step.instruction).toBe("Get the page title");
    }
  });

  it("builds observe step", () => {
    const step = buildStepFromDecision(
      makeDecision({ action_type: "observe", instruction: "Find all buttons" }),
      3,
    );

    expect(step.type).toBe("observe");
  });

  it("builds wait step", () => {
    const step = buildStepFromDecision(
      makeDecision({ action_type: "wait", instruction: "Wait for page" }),
      4,
    );

    expect(step.type).toBe("wait_for");
    if (step.type === "wait_for") {
      expect(step.ms).toBe(2000);
    }
  });

  it("builds scroll step as act", () => {
    const step = buildStepFromDecision(
      makeDecision({ action_type: "scroll", instruction: "Scroll down to footer" }),
      5,
    );

    expect(step.type).toBe("act");
    if (step.type === "act") {
      expect(step.instruction).toContain("Scroll down to footer");
    }
  });

  it("builds assert_visual step with dimensions", () => {
    const step = buildStepFromDecision(
      makeDecision({ action_type: "assert_visual", instruction: "Check page looks correct" }),
      6,
    );

    expect(step.type).toBe("assert_visual");
    if (step.type === "assert_visual") {
      expect(step.dimensions).toEqual(["visual_polish", "localization"]);
      expect(step.instruction).toBe("Check page looks correct");
    }
  });

  it("builds assert_dom step", () => {
    const step = buildStepFromDecision(
      makeDecision({ action_type: "assert_dom", instruction: "nav.main-menu" }),
      7,
    );

    expect(step.type).toBe("assert_dom");
    if (step.type === "assert_dom") {
      expect(step.selector).toBe("nav.main-menu");
    }
  });

  it("defaults unknown action type to act", () => {
    const step = buildStepFromDecision(
      makeDecision({ action_type: "unknown_thing" as string }),
      8,
    );

    expect(step.type).toBe("act");
  });

  it("uses stepIndex in id", () => {
    const step = buildStepFromDecision(makeDecision(), 42);
    expect(step.id).toBe("auto-42");
  });

  it("all steps have critical=false and critical_review=false", () => {
    const types = ["act", "visit", "extract", "observe", "wait", "scroll", "assert_visual", "assert_dom"];
    for (const type of types) {
      const step = buildStepFromDecision(makeDecision({ action_type: type }), 0);
      expect(step.critical).toBe(false);
      expect(step.critical_review).toBe(false);
    }
  });
});

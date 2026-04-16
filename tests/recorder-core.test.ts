/**
 * Tests for recorder-core — the pure logic the Chrome extension uses to
 * compile captured actions into a scenario YAML.
 */

import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  compileScenario,
  toYaml,
  toSteps,
  dedupeConsecutive,
  deriveSelector,
  type RecordedAction,
  type MinimalElement,
} from "../extensions/scenario-recorder/src/recorder-core.js";
import { ScenarioSchema } from "../src/core/types.js";

function a(kind: RecordedAction["kind"], overrides: Partial<RecordedAction> = {}): RecordedAction {
  return {
    kind,
    timestamp: 1,
    url: "https://x.example/",
    ...overrides,
  };
}

describe("dedupeConsecutive", () => {
  it("removes back-to-back identical actions", () => {
    const actions = [
      a("click", { selector: "#btn", label: "Go" }),
      a("click", { selector: "#btn", label: "Go" }),
      a("click", { selector: "#btn2", label: "Next" }),
    ];
    const out = dedupeConsecutive(actions);
    expect(out).toHaveLength(2);
  });

  it("keeps distinct actions in order", () => {
    const actions = [
      a("click", { selector: "#a" }),
      a("click", { selector: "#b" }),
      a("click", { selector: "#a" }),
    ];
    expect(dedupeConsecutive(actions)).toHaveLength(3);
  });
});

describe("toSteps", () => {
  it("emits a visit step for the first URL and dedupes repeated visits", () => {
    const steps = toSteps([
      a("visit"),
      a("visit"),
      a("navigation", { url: "https://x.example/next" }),
    ]);
    const visits = steps.filter((s) => s.type === "visit");
    expect(visits).toHaveLength(2);
    expect((visits[0] as Record<string, unknown>).url).toBe("https://x.example/");
  });

  it("maps click/fill/submit/key into act steps", () => {
    const steps = toSteps([
      a("visit"),
      a("click", { selector: "#submit", label: "Submit", role: "button" }),
      a("fill", { selector: "#email", label: "Email", value: "alice@example.com", role: "input" }),
      a("submit", { selector: "#form" }),
      a("key", { key: "Enter" }),
    ]);
    expect(steps.map((s) => s.type)).toEqual([
      "visit",
      "act",
      "act",
      "act",
      "act",
      "assert_visual",
    ]);
    expect((steps[1] as Record<string, unknown>).instruction).toMatch(/Submit.*button/);
    expect((steps[2] as Record<string, unknown>).instruction).toMatch(/alice@example/);
    expect((steps[3] as Record<string, unknown>).instruction).toBe("Submit the form");
  });

  it("appends an assert_visual when there's content", () => {
    const steps = toSteps([a("visit"), a("click", { selector: "#x", label: "X" })]);
    expect(steps[steps.length - 1]!.type).toBe("assert_visual");
  });

  it("emits no assert_visual when action list is empty", () => {
    expect(toSteps([])).toEqual([]);
  });
});

describe("deriveSelector", () => {
  function el(opts: Partial<MinimalElement>): MinimalElement {
    return {
      tagName: "DIV",
      getAttribute: (name: string) => (opts as Record<string, string | undefined>)[name] ?? null,
      textContent: opts.textContent,
      ...opts,
    };
  }

  it("prefers data-testid when present", () => {
    expect(
      deriveSelector(el({ tagName: "BUTTON", "data-testid": "signup-btn" } as Partial<MinimalElement>)),
    ).toBe('[data-testid="signup-btn"]');
  });

  it("uses id when stable-looking", () => {
    expect(deriveSelector(el({ tagName: "A", id: "main-cta" }))).toBe("#main-cta");
  });

  it("skips id that looks generated", () => {
    const result = deriveSelector(el({ tagName: "BUTTON", id: "btn-12345", textContent: "Go" }));
    expect(result).not.toBe("#btn-12345");
  });

  it("falls back to aria-label", () => {
    const result = deriveSelector(el({ tagName: "BUTTON", "aria-label": "Close menu" } as Partial<MinimalElement>));
    expect(result).toBe('button[aria-label="Close menu"]');
  });

  it("uses text-based :has-text fallback", () => {
    const result = deriveSelector(el({ tagName: "A", textContent: "Read more" }));
    expect(result).toBe('a:has-text("Read more")');
  });
});

describe("compileScenario + toYaml", () => {
  it("produces a scenario that round-trips through ScenarioSchema", () => {
    const scenario = compileScenario(
      [
        a("visit"),
        a("fill", { selector: "#email", label: "Email", value: "x@y.z", role: "input" }),
        a("click", { selector: "#submit", label: "Sign up", role: "button" }),
      ],
      { scenario_id: "test", goal: "Sign up with email", persona_id: "us-desktop-pro" },
    );
    const yaml = toYaml(scenario);
    const roundTrip = parseYaml(yaml);
    const parsed = ScenarioSchema.safeParse(roundTrip);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.steps!.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("generated YAML is well-formed (no runtime errors, keys present)", () => {
    const scenario = compileScenario(
      [a("visit"), a("click", { selector: "#x", label: "X", role: "button" })],
      { scenario_id: "t", goal: "do it", persona_id: "us" },
    );
    const yaml = toYaml(scenario);
    expect(yaml).toContain("id: t");
    expect(yaml).toContain("mode: scripted");
    expect(yaml).toContain("steps:");
  });
});

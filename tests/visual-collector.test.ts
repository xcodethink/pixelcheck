/**
 * VisualCollector — unit tests with a stubbed vision call (no LLM cost).
 *
 * The collector itself wraps `runJudgeVision` from judge.ts, which is
 * already covered by tests/primitives/judge.test.ts. These tests focus
 * on the new envelope-shaping logic introduced in PR-D:
 *   - shouldScore() decision matrix (off / auto+goal / auto-no-goal / eager)
 *   - skip() returns a properly-shaped VisualScoring envelope
 *   - score() round-trips a successful vision response into VisualScoring
 *   - score() degrades to a `vision_error` envelope when the call throws
 *   - score() drops verdicts whose criterion_id is not in the rubric
 *   - buildVisualScoring() produces a self-contained envelope (label + kind
 *     attached so consumers do not need the rubric to render it)
 */

import { describe, it, expect } from "vitest";
import {
  VisualCollector,
  buildVisualScoring,
  shouldScore,
  type VisualScoringMode,
} from "../src/core/visual-collector.js";
import { VisualScoringSchema } from "../src/core/result-schema.js";
import type { VisionRequest, VisionResponse } from "../src/core/llm.js";

function makeStubVision(text: string, opts: { costUsd?: number } = {}) {
  return async (_req: VisionRequest): Promise<VisionResponse> => ({
    model: "stub-vision",
    text,
    costUsd: opts.costUsd ?? 0.005,
    usage: { input_tokens: 100, output_tokens: 50 },
  });
}

describe("shouldScore — decision matrix", () => {
  const cases: Array<{
    mode: VisualScoringMode | undefined;
    hasGoal: boolean;
    expected: { run: boolean; reason?: string };
  }> = [
    { mode: undefined, hasGoal: false, expected: { run: false, reason: "config_off" } },
    { mode: undefined, hasGoal: true, expected: { run: false, reason: "config_off" } },
    { mode: "off", hasGoal: false, expected: { run: false, reason: "config_off" } },
    { mode: "off", hasGoal: true, expected: { run: false, reason: "config_off" } },
    { mode: "auto", hasGoal: false, expected: { run: false, reason: "no_goal" } },
    { mode: "auto", hasGoal: true, expected: { run: true } },
    { mode: "eager", hasGoal: false, expected: { run: true } },
    { mode: "eager", hasGoal: true, expected: { run: true } },
  ];

  for (const c of cases) {
    it(`mode=${c.mode ?? "undefined"} hasGoal=${c.hasGoal} → run=${c.expected.run}${
      c.expected.reason ? ` reason=${c.expected.reason}` : ""
    }`, () => {
      const got = shouldScore({ mode: c.mode, hasGoal: c.hasGoal });
      expect(got.run).toBe(c.expected.run);
      if (got.run === false) {
        expect(got.reason).toBe(c.expected.reason);
      }
    });
  }
});

describe("VisualCollector.skip — envelope shape", () => {
  it("returns a parseable VisualScoring with scored=false and the supplied reason", () => {
    const c = new VisualCollector();
    const env = c.skip("config_off");
    expect(() => VisualScoringSchema.parse(env)).not.toThrow();
    expect(env.scored).toBe(false);
    expect(env.skip_reason).toBe("config_off");
    expect(env.verdicts).toEqual([]);
    expect(env.findings).toEqual([]);
    expect(env.overall_score).toBeNull();
    expect(env.summary).toBeNull();
    expect(env.cost_usd).toBe(0);
    expect(env.duration_ms).toBe(0);
  });

  it("propagates each VisualSkipReason value", () => {
    const c = new VisualCollector();
    for (const reason of [
      "config_off",
      "no_goal",
      "no_api_key",
      "cost_cap",
      "no_screenshot",
      "vision_error",
    ] as const) {
      expect(c.skip(reason).skip_reason).toBe(reason);
    }
  });
});

describe("VisualCollector.score — happy path", () => {
  it("round-trips a vision response into a VisualScoring envelope", async () => {
    const vision = makeStubVision(
      JSON.stringify({
        verdicts: [
          {
            criterion_id: "visual_hierarchy",
            score: 8,
            rationale: "Clear H1 dominance.",
            evidence: ["H1 'Welcome'"],
          },
          {
            criterion_id: "typography",
            score: 7,
            rationale: "Readable body type.",
            evidence: [],
          },
        ],
        findings: [
          {
            severity: "low",
            criterion_id: "typography",
            description: "Body text is slightly small.",
            location: "below the fold",
            recommendation: "Bump to 16px.",
          },
        ],
        summary: "Strong page with one minor typography issue.",
      }),
      { costUsd: 0.013 },
    );

    const c = new VisualCollector({ callVisionImpl: vision });
    const env = await c.score(Buffer.from([0xff, 0xd8, 0xff])); // any non-empty buffer

    expect(() => VisualScoringSchema.parse(env)).not.toThrow();
    expect(env.scored).toBe(true);
    expect(env.skip_reason).toBeUndefined();
    expect(env.rubrics).toEqual(["aesthetic"]);
    expect(env.verdicts.length).toBeGreaterThanOrEqual(2);
    const hierarchy = env.verdicts.find((v) => v.criterion_id === "visual_hierarchy");
    expect(hierarchy).toBeDefined();
    expect(hierarchy?.label).toBe("Visual hierarchy");
    expect(hierarchy?.kind).toBe("aesthetic");
    expect(hierarchy?.score).toBe(8);
    expect(env.findings).toHaveLength(1);
    expect(env.findings[0].severity).toBe("low");
    expect(env.summary).toContain("Strong page");
    expect(env.cost_usd).toBe(0.013);
    expect(env.duration_ms).toBeGreaterThanOrEqual(0);
    expect(env.model).toBeTypeOf("string");
    expect(env.overall_score).not.toBeNull();
  });

  it("drops verdicts whose criterion_id is not in the rubric", async () => {
    const vision = makeStubVision(
      JSON.stringify({
        verdicts: [
          {
            criterion_id: "visual_hierarchy",
            score: 9,
            rationale: "Good.",
            evidence: [],
          },
          {
            criterion_id: "totally_made_up_id", // not in aesthetic rubric
            score: 5,
            rationale: "Bogus.",
            evidence: [],
          },
        ],
        findings: [],
        summary: null,
      }),
    );
    const c = new VisualCollector({ callVisionImpl: vision });
    const env = await c.score(Buffer.from([0]));
    const ids = env.verdicts.map((v) => v.criterion_id);
    expect(ids).toContain("visual_hierarchy");
    expect(ids).not.toContain("totally_made_up_id");
  });
});

describe("VisualCollector.score — error degradation", () => {
  it("emits a vision_error envelope when the vision call throws", async () => {
    const c = new VisualCollector({
      callVisionImpl: async () => {
        throw new Error("upstream-503");
      },
    });
    const env = await c.score(Buffer.from([0]));
    expect(() => VisualScoringSchema.parse(env)).not.toThrow();
    expect(env.scored).toBe(false);
    expect(env.skip_reason).toBe("vision_error");
    expect(env.verdicts).toEqual([]);
    expect(env.findings).toEqual([]);
    // duration is still recorded so observability has the failure latency
    expect(env.duration_ms).toBeGreaterThanOrEqual(0);
    // model + rubrics still surfaced so consumers know what was attempted
    expect(env.model).toBeTypeOf("string");
    expect(env.rubrics).toContain("aesthetic");
  });

  it("emits vision_error when no rubric resolves (defensive)", async () => {
    // Force `resolveCriteria` to throw by passing rubrics: [] AND no custom.
    // That branch is normally unreachable because both upstream callers
    // (judge / collector defaults) supply at least one rubric, but the
    // collector should still degrade rather than crash if it ever happens.
    const c = new VisualCollector({
      rubrics: [],
      customCriteria: [],
      callVisionImpl: makeStubVision(JSON.stringify({ verdicts: [], findings: [] })),
    });
    const env = await c.score(Buffer.from([0]));
    expect(env.scored).toBe(false);
    expect(env.skip_reason).toBe("vision_error");
  });
});

describe("buildVisualScoring — self-contained envelope", () => {
  it("attaches label + kind to each verdict (no rubric join needed downstream)", () => {
    const env = buildVisualScoring({
      raw: {
        verdicts: [
          {
            criterion_id: "visual_hierarchy",
            score: 6,
            rationale: "OK.",
            evidence: [],
          },
        ],
        findings: [],
        summary: null,
        costUsd: 0.002,
      },
      criteria: [
        {
          id: "visual_hierarchy",
          label: "Visual hierarchy",
          description: "Does the page lead the eye?",
          kind: "aesthetic",
        },
      ],
      rubrics: ["aesthetic"],
      model: "claude-sonnet-4-6",
      durationMs: 1234,
    });

    expect(env.scored).toBe(true);
    expect(env.verdicts).toHaveLength(1);
    expect(env.verdicts[0].label).toBe("Visual hierarchy");
    expect(env.verdicts[0].kind).toBe("aesthetic");
    expect(env.cost_usd).toBe(0.002);
    expect(env.duration_ms).toBe(1234);
    expect(env.overall_score).toBe(6);
  });

  it("computes overall_score as the mean of verdict scores", () => {
    const env = buildVisualScoring({
      raw: {
        verdicts: [
          {
            criterion_id: "visual_hierarchy",
            score: 8,
            rationale: "",
            evidence: [],
          },
          {
            criterion_id: "typography",
            score: 6,
            rationale: "",
            evidence: [],
          },
        ],
        findings: [],
        summary: null,
        costUsd: 0,
      },
      criteria: [
        {
          id: "visual_hierarchy",
          label: "Visual hierarchy",
          description: "x",
          kind: "aesthetic",
        },
        {
          id: "typography",
          label: "Typography",
          description: "x",
          kind: "aesthetic",
        },
      ],
      rubrics: ["aesthetic"],
      model: "stub",
      durationMs: 0,
    });
    expect(env.overall_score).toBe(7);
  });
});

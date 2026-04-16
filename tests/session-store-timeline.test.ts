/**
 * Unit tests for deriveTimeline / eventsInRange / screenshotAt.
 */

import { describe, it, expect } from "vitest";
import type { AgentEvent } from "../src/agent/events.js";
import {
  deriveTimeline,
  eventsInRange,
  screenshotAt,
} from "../src/observer/session-store.js";

function mkEvent(
  sequence: number,
  type: AgentEvent["type"],
  data: Record<string, unknown> = {},
): AgentEvent {
  return {
    type,
    timestamp: new Date(Date.UTC(2026, 3, 16, 10, 0, sequence)).toISOString(),
    session_id: "sess",
    sequence,
    data,
  };
}

describe("deriveTimeline", () => {
  it("pairs action:start / action:complete into one ok step", () => {
    const events: AgentEvent[] = [
      mkEvent(0, "action:start", { action_id: "a1", instruction: "Click signup" }),
      mkEvent(1, "action:complete", { action_id: "a1", status: "pass", duration_ms: 250 }),
    ];
    const timeline = deriveTimeline(events);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      id: "a1",
      status: "ok",
      label: "Click signup",
      kind: "action",
    });
    expect(timeline[0]!.event_sequences).toEqual([0, 1]);
    expect(timeline[0]!.meta.duration_ms).toBe(250);
  });

  it("marks fail when action:failed is received", () => {
    const events: AgentEvent[] = [
      mkEvent(0, "action:start", { action_id: "a1", instruction: "Click ghost" }),
      mkEvent(1, "action:failed", { action_id: "a1", error: "not found" }),
    ];
    const timeline = deriveTimeline(events);
    expect(timeline[0]!.status).toBe("fail");
    expect(timeline[0]!.meta.error).toBe("not found");
  });

  it("reports pending for unclosed actions", () => {
    const events: AgentEvent[] = [
      mkEvent(0, "action:start", { action_id: "a1", instruction: "Hang" }),
    ];
    expect(deriveTimeline(events)[0]!.status).toBe("pending");
  });

  it("creates plan entries with from_cache flag", () => {
    const events: AgentEvent[] = [
      mkEvent(0, "plan:created", { plan_id: "p1", steps: [1, 2, 3], from_cache: true, reasoning: "cached" }),
    ];
    const timeline = deriveTimeline(events);
    expect(timeline[0]!.kind).toBe("plan");
    expect(timeline[0]!.meta.from_cache).toBe(true);
    expect(timeline[0]!.label).toContain("3 steps");
  });

  it("captures micro-replan revisions separately from full replans", () => {
    const events: AgentEvent[] = [
      mkEvent(0, "plan:revised", { plan_id: "p1", kind: "micro_rewrite", reasoning: "rewrote step 2" }),
    ];
    const timeline = deriveTimeline(events);
    expect(timeline[0]!.label).toContain("micro_rewrite");
  });

  it("maps convergence events with correct statuses", () => {
    const events: AgentEvent[] = [
      mkEvent(0, "convergence:goal_met", { criteria_met: ["c1"] }),
      mkEvent(1, "convergence:budget_exceeded", { spent: 2.0, cap: 1.0 }),
    ];
    const timeline = deriveTimeline(events);
    expect(timeline.find((t) => t.label === "goal_met")!.status).toBe("ok");
    expect(timeline.find((t) => t.label === "budget_exceeded")!.status).toBe("warn");
  });

  it("timeline is sorted by sequence", () => {
    const events: AgentEvent[] = [
      mkEvent(0, "action:start", { action_id: "a" }),
      mkEvent(10, "plan:revised", { kind: "full" }),
      mkEvent(1, "action:complete", { action_id: "a", status: "pass" }),
    ];
    const timeline = deriveTimeline(events);
    const seqs = timeline.map((t) => t.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

describe("eventsInRange", () => {
  const events: AgentEvent[] = [
    mkEvent(0, "action:start"),
    mkEvent(5, "action:complete"),
    mkEvent(10, "action:start"),
    mkEvent(15, "action:failed"),
  ];

  it("returns events within [start, end] inclusive", () => {
    expect(eventsInRange(events, 5, 10).map((e) => e.sequence)).toEqual([5, 10]);
  });

  it("returns empty when range is before session", () => {
    expect(eventsInRange(events, -5, -1)).toHaveLength(0);
  });

  it("returns empty when range is after session", () => {
    expect(eventsInRange(events, 20, 30)).toHaveLength(0);
  });
});

describe("screenshotAt", () => {
  const events: AgentEvent[] = [
    mkEvent(0, "action:start"),
    mkEvent(5, "observation:screenshot", { path: "step-5.png" }),
    mkEvent(10, "action:complete"),
    mkEvent(15, "observation:screenshot", { path: "step-15.png" }),
    mkEvent(20, "action:complete"),
  ];

  it("returns the most recent screenshot before or at the given sequence", () => {
    expect(screenshotAt(events, 7)).toBe("step-5.png");
    expect(screenshotAt(events, 15)).toBe("step-15.png");
    expect(screenshotAt(events, 25)).toBe("step-15.png");
  });

  it("returns null when no screenshots yet", () => {
    expect(screenshotAt(events, 3)).toBeNull();
  });
});

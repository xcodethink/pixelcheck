import { describe, it, expect, vi } from "vitest";
import { AgentEventBus, attachConsoleLogger, type AgentEvent } from "../src/agent/events.js";

describe("AgentEventBus", () => {
  it("emits typed events with auto-incrementing sequence", () => {
    const bus = new AgentEventBus("test-session");
    const events: AgentEvent[] = [];
    bus.on("*", (e: AgentEvent) => events.push(e));

    bus.emitEvent("session:start", { scenario_id: "s1" });
    bus.emitEvent("step:start", { step_id: "step-1" });
    bus.emitEvent("step:complete", { step_id: "step-1" });

    expect(events).toHaveLength(3);
    expect(events[0].sequence).toBe(0);
    expect(events[1].sequence).toBe(1);
    expect(events[2].sequence).toBe(2);
    expect(events[0].type).toBe("session:start");
    expect(events[0].session_id).toBe("test-session");
    expect(events[0].data.scenario_id).toBe("s1");
  });

  it("wildcard listener receives all event types", () => {
    const bus = new AgentEventBus("test");
    const collected: string[] = [];
    bus.on("*", (e: AgentEvent) => collected.push(e.type));

    bus.emitEvent("session:start", {});
    bus.emitEvent("plan:created", {});
    bus.emitEvent("action:start", {});
    bus.emitEvent("action:complete", {});
    bus.emitEvent("session:end", {});

    expect(collected).toEqual([
      "session:start",
      "plan:created",
      "action:start",
      "action:complete",
      "session:end",
    ]);
  });

  it("specific type listener only receives its type", () => {
    const bus = new AgentEventBus("test");
    const stepStarts: AgentEvent[] = [];
    bus.on("step:start", (e: AgentEvent) => stepStarts.push(e));

    bus.emitEvent("step:start", { step_id: "a" });
    bus.emitEvent("step:complete", { step_id: "a" });
    bus.emitEvent("step:start", { step_id: "b" });

    expect(stepStarts).toHaveLength(2);
    expect(stepStarts[0].data.step_id).toBe("a");
    expect(stepStarts[1].data.step_id).toBe("b");
  });

  it("emitEvent returns the event object", () => {
    const bus = new AgentEventBus("test");
    const event = bus.emitEvent("session:start", { foo: "bar" });

    expect(event.type).toBe("session:start");
    expect(event.session_id).toBe("test");
    expect(event.data.foo).toBe("bar");
    expect(typeof event.timestamp).toBe("string");
  });

  it("events have ISO 8601 timestamps", () => {
    const bus = new AgentEventBus("test");
    const event = bus.emitEvent("session:start", {});
    // ISO 8601 pattern check
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // ── Pause / Resume ──────────────────────────────────────────

  it("pause/resume blocks and unblocks waitIfPaused", async () => {
    const bus = new AgentEventBus("test");

    bus.pause();
    expect(bus.paused).toBe(true);

    let resolved = false;
    const waiting = bus.waitIfPaused().then(() => {
      resolved = true;
    });

    // Should not resolve yet
    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false);

    bus.resume();
    await waiting;
    expect(resolved).toBe(true);
    expect(bus.paused).toBe(false);
  });

  it("waitIfPaused resolves immediately when not paused", async () => {
    const bus = new AgentEventBus("test");
    await bus.waitIfPaused(); // Should not hang
  });

  it("resume releases ALL concurrent waiters, not just the last (D2-M1)", async () => {
    const bus = new AgentEventBus("test");
    bus.pause();

    // Two checkpoints await the same pause gate concurrently. A single-slot
    // resolver would orphan the first waiter forever.
    const resolved = [false, false];
    const first = bus.waitIfPaused().then(() => {
      resolved[0] = true;
    });
    const second = bus.waitIfPaused().then(() => {
      resolved[1] = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toEqual([false, false]);

    bus.resume();
    await Promise.all([first, second]);
    expect(resolved).toEqual([true, true]);
  });

  it("pause emits pause:requested event", () => {
    const bus = new AgentEventBus("test");
    const events: string[] = [];
    bus.on("*", (e: AgentEvent) => events.push(e.type));

    bus.pause();
    bus.resume();

    expect(events).toContain("pause:requested");
    expect(events).toContain("pause:resumed");
  });

  // ── Takeover ────────────────────────────────────────────────

  it("takeover/release blocks and unblocks", async () => {
    const bus = new AgentEventBus("test");

    bus.startTakeover();
    expect(bus.takeover).toBe(true);

    let resolved = false;
    const waiting = bus.waitForTakeoverEnd().then(() => {
      resolved = true;
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false);

    bus.endTakeover();
    await waiting;
    expect(resolved).toBe(true);
    expect(bus.takeover).toBe(false);
  });

  it("endTakeover releases ALL concurrent waiters (D2-M1)", async () => {
    const bus = new AgentEventBus("test");
    bus.startTakeover();

    const resolved = [false, false];
    const first = bus.waitForTakeoverEnd().then(() => {
      resolved[0] = true;
    });
    const second = bus.waitForTakeoverEnd().then(() => {
      resolved[1] = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toEqual([false, false]);

    bus.endTakeover();
    await Promise.all([first, second]);
    expect(resolved).toEqual([true, true]);
  });

  it("takeover emits events", () => {
    const bus = new AgentEventBus("test");
    const events: string[] = [];
    bus.on("*", (e: AgentEvent) => events.push(e.type));

    bus.startTakeover();
    bus.endTakeover();

    expect(events).toContain("takeover:start");
    expect(events).toContain("takeover:end");
  });

  // ── Checkpoint ──────────────────────────────────────────────

  it("checkpoint resolves immediately when neither paused nor takeover", async () => {
    const bus = new AgentEventBus("test");
    await bus.checkpoint(); // Should not hang
  });

  it("checkpoint waits for takeover then pause", async () => {
    const bus = new AgentEventBus("test");

    bus.startTakeover();

    let checkpointDone = false;
    const waiting = bus.checkpoint().then(() => {
      checkpointDone = true;
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(checkpointDone).toBe(false);

    bus.endTakeover();
    await waiting;
    expect(checkpointDone).toBe(true);
  });

  // ── Double operations are no-ops ────────────────────────────

  it("double pause/resume does not throw", () => {
    const bus = new AgentEventBus("test");
    bus.pause();
    bus.pause(); // no-op
    bus.resume();
    bus.resume(); // no-op
    expect(bus.paused).toBe(false);
  });

  it("double takeover/release does not throw", () => {
    const bus = new AgentEventBus("test");
    bus.startTakeover();
    bus.startTakeover(); // no-op
    bus.endTakeover();
    bus.endTakeover(); // no-op
    expect(bus.takeover).toBe(false);
  });
});

describe("attachConsoleLogger", () => {
  it("does not throw for any event type", () => {
    const bus = new AgentEventBus("test");
    // Suppress console output during test
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    attachConsoleLogger(bus, true);

    const allTypes = [
      "session:start", "session:end",
      "plan:created", "plan:revised",
      "step:start", "step:complete", "step:failed",
      "action:start", "action:complete", "action:failed",
      "thought:reasoning", "thought:decision",
      "convergence:stuck", "convergence:loop_detected",
      "convergence:goal_met", "convergence:budget_exceeded",
      "criterion:checked", "criterion:met",
      "pause:requested", "pause:resumed",
      "takeover:start", "takeover:end",
    ] as const;

    for (const type of allTypes) {
      expect(() => bus.emitEvent(type, { test: true })).not.toThrow();
    }

    spy.mockRestore();
  });
});

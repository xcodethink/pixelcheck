/**
 * Tests for SessionRegistry — demux of a run-level AgentEventBus into
 * per-session SessionStores.
 */

import { describe, it, expect } from "vitest";
import { AgentEventBus } from "../src/agent/events.js";
import { SessionRegistry } from "../src/observer/session-registry.js";

describe("SessionRegistry", () => {
  it("creates separate stores per session_id", () => {
    const bus = new AgentEventBus("run-1");
    const reg = new SessionRegistry("run-1");
    reg.attach(bus);

    // Emit from two child sessions via wildcard forwarding (direct emit)
    bus.emit("*", {
      type: "session:start",
      timestamp: new Date().toISOString(),
      session_id: "unit-a",
      sequence: 0,
      data: { persona_id: "us-desktop", scenario_id: "signup" },
    });
    bus.emit("*", {
      type: "session:start",
      timestamp: new Date().toISOString(),
      session_id: "unit-b",
      sequence: 0,
      data: { persona_id: "jp-mobile", scenario_id: "signup" },
    });
    bus.emit("*", {
      type: "action:complete",
      timestamp: new Date().toISOString(),
      session_id: "unit-a",
      sequence: 1,
      data: { action_id: "x", status: "pass", duration_ms: 100 },
    });

    const entries = reg.entries();
    expect(entries).toHaveLength(2);
    const a = reg.getEntry("unit-a")!;
    const b = reg.getEntry("unit-b")!;
    expect(a.store.events).toHaveLength(2);
    expect(b.store.events).toHaveLength(1);
    expect(a.label).toBe("us-desktop / signup");
    expect(b.label).toBe("jp-mobile / signup");
  });

  it("gridSnapshot reports per-session timeline_count and last_step", () => {
    const bus = new AgentEventBus("run-2");
    const reg = new SessionRegistry("run-2");
    reg.attach(bus);

    bus.emit("*", {
      type: "session:start",
      timestamp: new Date().toISOString(),
      session_id: "u",
      sequence: 0,
      data: { persona_id: "p", scenario_id: "s" },
    });
    bus.emit("*", {
      type: "action:start",
      timestamp: new Date().toISOString(),
      session_id: "u",
      sequence: 1,
      data: { action_id: "a", instruction: "click" },
    });
    bus.emit("*", {
      type: "action:complete",
      timestamp: new Date().toISOString(),
      session_id: "u",
      sequence: 2,
      data: { action_id: "a", status: "pass" },
    });

    const snap = reg.gridSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.timeline_count).toBeGreaterThanOrEqual(2); // session:start + action
    expect(snap[0]!.last_step?.kind).toBe("action");
    expect(snap[0]!.state.actions_completed).toBe(1);
  });

  it("entries() is sorted by session_id for stable UI", () => {
    const bus = new AgentEventBus("run-3");
    const reg = new SessionRegistry("run-3");
    reg.attach(bus);
    for (const id of ["zzz", "aaa", "mmm"]) {
      bus.emit("*", {
        type: "session:start",
        timestamp: new Date().toISOString(),
        session_id: id,
        sequence: 0,
        data: {},
      });
    }
    expect(reg.entries().map((e) => e.session_id)).toEqual(["aaa", "mmm", "zzz"]);
  });

  it("ignores events without session_id", () => {
    const bus = new AgentEventBus("run-4");
    const reg = new SessionRegistry("run-4");
    reg.attach(bus);
    bus.emit("*", {
      type: "pause:requested",
      timestamp: new Date().toISOString(),
      session_id: "",
      sequence: 0,
      data: {},
    });
    expect(reg.entries()).toHaveLength(0);
  });
});

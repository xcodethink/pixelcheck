import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AgentEventBus } from "../src/agent/events.js";
import { SessionStore, loadEventsFromNdjson } from "../src/observer/session-store.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "session-store-test-"));
}

describe("SessionStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes with running state", async () => {
    const store = new SessionStore("test-session");
    expect(store.state.session_id).toBe("test-session");
    expect(store.state.status).toBe("running");
    expect(store.state.actions_completed).toBe(0);
    expect(store.state.events_count).toBe(0);
    await store.close();
  });

  it("records events and updates state", async () => {
    const store = new SessionStore("test-session");

    store.recordEvent({
      type: "session:start",
      timestamp: new Date().toISOString(),
      session_id: "test-session",
      sequence: 0,
      data: { scenario_id: "smoke", persona_id: "us-free" },
    });

    expect(store.state.scenario_id).toBe("smoke");
    expect(store.state.persona_id).toBe("us-free");
    expect(store.state.events_count).toBe(1);
    expect(store.events).toHaveLength(1);
    await store.close();
  });

  it("tracks action counts", async () => {
    const store = new SessionStore("test");

    store.recordEvent({
      type: "step:complete",
      timestamp: new Date().toISOString(),
      session_id: "test",
      sequence: 0,
      data: { step_id: "s1" },
    });
    store.recordEvent({
      type: "step:complete",
      timestamp: new Date().toISOString(),
      session_id: "test",
      sequence: 1,
      data: { step_id: "s2" },
    });
    store.recordEvent({
      type: "step:failed",
      timestamp: new Date().toISOString(),
      session_id: "test",
      sequence: 2,
      data: { step_id: "s3" },
    });

    expect(store.state.actions_completed).toBe(2);
    expect(store.state.actions_failed).toBe(1);
    await store.close();
  });

  it("updates status on pause/resume/takeover", async () => {
    const store = new SessionStore("test");

    store.recordEvent({
      type: "pause:requested",
      timestamp: new Date().toISOString(),
      session_id: "test",
      sequence: 0,
      data: {},
    });
    expect(store.state.status).toBe("paused");

    store.recordEvent({
      type: "pause:resumed",
      timestamp: new Date().toISOString(),
      session_id: "test",
      sequence: 1,
      data: {},
    });
    expect(store.state.status).toBe("running");

    store.recordEvent({
      type: "takeover:start",
      timestamp: new Date().toISOString(),
      session_id: "test",
      sequence: 2,
      data: {},
    });
    expect(store.state.status).toBe("takeover");

    store.recordEvent({
      type: "takeover:end",
      timestamp: new Date().toISOString(),
      session_id: "test",
      sequence: 3,
      data: {},
    });
    expect(store.state.status).toBe("running");
    await store.close();
  });

  it("persists events to NDJSON file", async () => {
    const store = new SessionStore("test", tmpDir);

    store.recordEvent({
      type: "session:start",
      timestamp: "2026-04-14T10:00:00Z",
      session_id: "test",
      sequence: 0,
      data: { scenario_id: "smoke" },
    });
    store.recordEvent({
      type: "step:complete",
      timestamp: "2026-04-14T10:00:01Z",
      session_id: "test",
      sequence: 1,
      data: { step_id: "s1" },
    });

    await store.close();

    // Read and verify NDJSON
    const ndjsonPath = path.join(tmpDir, "events.ndjson");
    expect(fs.existsSync(ndjsonPath)).toBe(true);

    const content = fs.readFileSync(ndjsonPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const event1 = JSON.parse(lines[0]);
    expect(event1.type).toBe("session:start");
    expect(event1.data.scenario_id).toBe("smoke");

    const event2 = JSON.parse(lines[1]);
    expect(event2.type).toBe("step:complete");
  });

  it("strips screenshot_base64 from persisted events", async () => {
    const store = new SessionStore("test", tmpDir);

    store.recordEvent({
      type: "observation:screenshot",
      timestamp: "2026-04-14T10:00:00Z",
      session_id: "test",
      sequence: 0,
      data: { screenshot_base64: "huge-base64-data-here", path: "/tmp/screenshot.png" },
    });

    await store.close();

    const content = fs.readFileSync(path.join(tmpDir, "events.ndjson"), "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.data.screenshot_base64).toBe("(omitted)");
    expect(parsed.data.path).toBe("/tmp/screenshot.png");
  });

  it("attaches to AgentEventBus and records automatically", async () => {
    const bus = new AgentEventBus("test");
    const store = new SessionStore("test");
    store.attach(bus);

    bus.emitEvent("session:start", { scenario_id: "s1" });
    bus.emitEvent("step:complete", { step_id: "step1" });

    expect(store.state.events_count).toBe(2);
    expect(store.state.actions_completed).toBe(1);
    await store.close();
  });
});

describe("loadEventsFromNdjson", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads valid NDJSON", () => {
    const filePath = path.join(tmpDir, "events.ndjson");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "session:start", timestamp: "2026-04-14T10:00:00Z", session_id: "t", sequence: 0, data: {} }),
        JSON.stringify({ type: "session:end", timestamp: "2026-04-14T10:01:00Z", session_id: "t", sequence: 1, data: {} }),
      ].join("\n"),
    );

    const events = loadEventsFromNdjson(filePath);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("session:start");
    expect(events[1].type).toBe("session:end");
  });

  it("skips malformed lines gracefully", () => {
    const filePath = path.join(tmpDir, "events.ndjson");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "session:start", timestamp: "2026-04-14T10:00:00Z", session_id: "t", sequence: 0, data: {} }),
        "THIS IS NOT JSON",
        JSON.stringify({ type: "session:end", timestamp: "2026-04-14T10:01:00Z", session_id: "t", sequence: 1, data: {} }),
      ].join("\n"),
    );

    const events = loadEventsFromNdjson(filePath);
    expect(events).toHaveLength(2); // Skips the bad line
  });

  it("returns empty array for non-existent file", () => {
    const events = loadEventsFromNdjson("/non/existent/path.ndjson");
    expect(events).toEqual([]);
  });

  it("returns empty array for empty file", () => {
    const filePath = path.join(tmpDir, "empty.ndjson");
    fs.writeFileSync(filePath, "");
    const events = loadEventsFromNdjson(filePath);
    expect(events).toEqual([]);
  });
});

/**
 * SessionStore — In-memory session state + NDJSON file persistence.
 *
 * Tracks the current state of an agent session (running/paused/complete)
 * and persists all events as newline-delimited JSON for replay.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentEvent, AgentEventBus } from "../agent/events.js";

export interface SessionState {
  session_id: string;
  status: "running" | "paused" | "takeover" | "complete" | "failed";
  scenario_id?: string;
  persona_id?: string;
  current_url?: string;
  actions_completed: number;
  actions_failed: number;
  cost_usd: number;
  events_count: number;
  last_event_type?: string;
  last_screenshot_path?: string;
}

export class SessionStore {
  private _state: SessionState;
  private _events: AgentEvent[] = [];
  private _writeStream: fs.WriteStream | null = null;

  constructor(sessionId: string, outputDir?: string) {
    this._state = {
      session_id: sessionId,
      status: "running",
      actions_completed: 0,
      actions_failed: 0,
      cost_usd: 0,
      events_count: 0,
    };

    if (outputDir) {
      fs.mkdirSync(outputDir, { recursive: true });
      const ndjsonPath = path.join(outputDir, "events.ndjson");
      this._writeStream = fs.createWriteStream(ndjsonPath, { flags: "a" });
    }
  }

  get state(): Readonly<SessionState> {
    return this._state;
  }

  get events(): ReadonlyArray<AgentEvent> {
    return this._events;
  }

  /**
   * Attach to an AgentEventBus — automatically tracks all events.
   */
  attach(bus: AgentEventBus): void {
    bus.on("*", (event: AgentEvent) => {
      this.recordEvent(event);
    });
  }

  /**
   * Record a single event. Updates in-memory state and persists to NDJSON.
   */
  recordEvent(event: AgentEvent): void {
    this._events.push(event);
    this._state.events_count++;
    this._state.last_event_type = event.type;

    // Update state based on event type
    switch (event.type) {
      case "session:start":
        this._state.status = "running";
        this._state.scenario_id = event.data.scenario_id as string;
        this._state.persona_id = event.data.persona_id as string;
        break;
      case "session:end":
        this._state.status = event.data.status === "fail" ? "failed" : "complete";
        this._state.cost_usd = (event.data.cost_usd as number) ?? this._state.cost_usd;
        break;
      case "step:complete":
      case "action:complete":
        this._state.actions_completed++;
        break;
      case "step:failed":
      case "action:failed":
        this._state.actions_failed++;
        break;
      case "pause:requested":
        this._state.status = "paused";
        break;
      case "pause:resumed":
        this._state.status = "running";
        break;
      case "takeover:start":
        this._state.status = "takeover";
        break;
      case "takeover:end":
        this._state.status = "running";
        break;
      case "observation:screenshot":
        this._state.last_screenshot_path = event.data.path as string;
        break;
    }

    // Persist to NDJSON (flush immediately for crash safety)
    if (this._writeStream) {
      // Strip large binary data from persisted events
      const persistEvent = { ...event };
      if (persistEvent.data.screenshot_base64) {
        persistEvent.data = {
          ...persistEvent.data,
          screenshot_base64: "(omitted)",
        };
      }
      this._writeStream.write(JSON.stringify(persistEvent) + "\n");
    }
  }

  /**
   * Close the NDJSON write stream. Returns a promise that resolves when fully flushed.
   */
  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this._writeStream) {
        const stream = this._writeStream;
        this._writeStream = null;
        stream.end(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

/**
 * Load events from a persisted NDJSON file for replay.
 */
export function loadEventsFromNdjson(filePath: string): AgentEvent[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  const events: AgentEvent[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as AgentEvent);
    } catch {
      // Skip malformed lines (crash recovery)
    }
  }
  return events;
}

// ─────────────────────────────────────────────────────────────
// Derived views for timeline UI
// ─────────────────────────────────────────────────────────────

/** One "step" on the timeline scrubber — an observable unit of work. */
export interface TimelineStep {
  id: string;
  /** Monotonic index across the session */
  sequence: number;
  /** Step / action / plan — the kind of work this represents */
  kind: "action" | "plan" | "criterion" | "thought" | "session" | "other";
  label: string;
  status: "ok" | "warn" | "fail" | "pending";
  timestamp: string; // ISO
  /** Related events' sequence numbers for details panel */
  event_sequences: number[];
  /** Extra data useful to the UI (reasoning, error, etc.) */
  meta: Record<string, unknown>;
}

/**
 * Query API over a SessionStore's events.
 *
 * Exposed as plain functions (not SessionStore methods) so tests can pass
 * synthetic event arrays without instantiating a store.
 */

export function deriveTimeline(events: ReadonlyArray<AgentEvent>): TimelineStep[] {
  const steps: TimelineStep[] = [];

  // Track open action/step brackets by id
  type Open = {
    id: string;
    sequence: number;
    label: string;
    startEvent: AgentEvent;
    relatedSeqs: number[];
  };
  const openActions = new Map<string, Open>();

  for (const event of events) {
    switch (event.type) {
      case "action:start":
      case "step:start": {
        const id = String(event.data.action_id ?? event.data.step_id ?? event.sequence);
        const instruction = String(event.data.instruction ?? event.data.description ?? id);
        openActions.set(id, {
          id,
          sequence: event.sequence,
          label: instruction,
          startEvent: event,
          relatedSeqs: [event.sequence],
        });
        break;
      }
      case "action:complete":
      case "action:failed":
      case "step:complete":
      case "step:failed": {
        const id = String(event.data.action_id ?? event.data.step_id ?? event.sequence);
        const open = openActions.get(id);
        if (!open) break;
        open.relatedSeqs.push(event.sequence);
        const failed = event.type === "action:failed" || event.type === "step:failed";
        const isWarn = !failed && event.data.status === "warn";
        steps.push({
          id,
          sequence: open.sequence,
          kind: "action",
          label: open.label,
          status: failed ? "fail" : isWarn ? "warn" : "ok",
          timestamp: event.timestamp,
          event_sequences: open.relatedSeqs,
          meta: {
            duration_ms: event.data.duration_ms,
            execution_method: event.data.execution_method,
            error: event.data.error,
          },
        });
        openActions.delete(id);
        break;
      }
      case "plan:created":
      case "plan:revised":
        steps.push({
          id: `plan-${event.sequence}`,
          sequence: event.sequence,
          kind: "plan",
          label:
            event.type === "plan:created"
              ? `Plan created (${Array.isArray(event.data.steps) ? event.data.steps.length : 0} steps)`
              : `Plan revised (${String(event.data.kind ?? "full")})`,
          status: "ok",
          timestamp: event.timestamp,
          event_sequences: [event.sequence],
          meta: {
            plan_id: event.data.plan_id,
            reasoning: event.data.reasoning,
            from_cache: event.data.from_cache,
            kind: event.data.kind,
          },
        });
        break;
      case "criterion:met":
        steps.push({
          id: `criterion-${event.data.id ?? event.sequence}`,
          sequence: event.sequence,
          kind: "criterion",
          label: `[OK] ${String(event.data.description ?? event.data.id)}`,
          status: "ok",
          timestamp: event.timestamp,
          event_sequences: [event.sequence],
          meta: { id: event.data.id },
        });
        break;
      case "convergence:goal_met":
      case "convergence:budget_exceeded":
      case "convergence:loop_detected":
      case "convergence:stuck":
        steps.push({
          id: `conv-${event.sequence}`,
          sequence: event.sequence,
          kind: "other",
          label: event.type.replace("convergence:", ""),
          status: event.type === "convergence:goal_met" ? "ok" : "warn",
          timestamp: event.timestamp,
          event_sequences: [event.sequence],
          meta: { ...event.data },
        });
        break;
      case "session:start":
      case "session:end":
        steps.push({
          id: `session-${event.type === "session:start" ? "start" : "end"}`,
          sequence: event.sequence,
          kind: "session",
          label: event.type === "session:start" ? "Session started" : "Session ended",
          status: "ok",
          timestamp: event.timestamp,
          event_sequences: [event.sequence],
          meta: { ...event.data },
        });
        break;
    }
  }

  // Close any actions that didn't receive a terminal event
  for (const open of openActions.values()) {
    steps.push({
      id: open.id,
      sequence: open.sequence,
      kind: "action",
      label: open.label,
      status: "pending",
      timestamp: open.startEvent.timestamp,
      event_sequences: open.relatedSeqs,
      meta: {},
    });
  }

  return steps.sort((a, b) => a.sequence - b.sequence);
}

/**
 * Events that occurred within a time range [startSeq, endSeq] (inclusive).
 */
export function eventsInRange(
  events: ReadonlyArray<AgentEvent>,
  startSeq: number,
  endSeq: number,
): AgentEvent[] {
  return events.filter((e) => e.sequence >= startSeq && e.sequence <= endSeq);
}

/**
 * The most recent screenshot path at or before the given sequence number.
 */
export function screenshotAt(
  events: ReadonlyArray<AgentEvent>,
  sequence: number,
): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.sequence > sequence) continue;
    if (e.type === "observation:screenshot" && typeof e.data.path === "string") {
      return e.data.path;
    }
  }
  return null;
}

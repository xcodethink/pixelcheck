/**
 * SessionRegistry — Aggregates multiple child SessionStores for the
 * multi-session grid view.
 *
 * Each (persona × scenario) unit in a run gets its own SessionStore. The
 * registry routes events based on their `session_id` so the dashboard can
 * render an N-up grid with each cell showing one unit's state in real time.
 *
 * The registry is a passive observer: it listens to the run-level event bus
 * and demultiplexes by session_id, never mutating the upstream bus.
 */

import type { AgentEvent, AgentEventBus } from "../agent/events.js";
import { SessionStore, deriveTimeline, type SessionState, type TimelineStep } from "./session-store.js";

export interface RegistryEntry {
  session_id: string;
  store: SessionStore;
  /** Human label: "persona_id / scenario_id" */
  label: string;
}

export class SessionRegistry {
  private _entries = new Map<string, RegistryEntry>();

  constructor(private _rootSessionId: string, private _outputDir?: string) {}

  /** Subscribe to a run-level event bus. Auto-registers sessions by session_id. */
  attach(bus: AgentEventBus): void {
    bus.on("*", (event: AgentEvent) => {
      if (!event.session_id) return;
      let entry = this._entries.get(event.session_id);
      if (!entry) {
        entry = this._createEntry(event.session_id);
        this._entries.set(event.session_id, entry);
      }
      entry.store.recordEvent(event);
      // Keep label up-to-date when we see session:start
      if (event.type === "session:start") {
        const personaId = event.data.persona_id as string | undefined;
        const scenarioId = event.data.scenario_id as string | undefined;
        if (personaId || scenarioId) {
          entry.label = `${personaId ?? "?"} / ${scenarioId ?? "?"}`;
        }
      }
    });
  }

  get rootSessionId(): string {
    return this._rootSessionId;
  }

  /** All currently-known sessions, sorted by id for stable UI ordering. */
  entries(): RegistryEntry[] {
    return Array.from(this._entries.values()).sort((a, b) =>
      a.session_id.localeCompare(b.session_id),
    );
  }

  getEntry(sessionId: string): RegistryEntry | undefined {
    return this._entries.get(sessionId);
  }

  /** A compact grid payload — one object per known session. */
  gridSnapshot(): Array<{
    session_id: string;
    label: string;
    state: SessionState;
    last_event_timestamp?: string;
    timeline_count: number;
    last_step?: TimelineStep;
  }> {
    return this.entries().map((entry) => {
      const events = entry.store.events;
      const timeline = deriveTimeline(events);
      return {
        session_id: entry.session_id,
        label: entry.label,
        state: entry.store.state,
        last_event_timestamp: events.length > 0 ? events[events.length - 1]!.timestamp : undefined,
        timeline_count: timeline.length,
        last_step: timeline[timeline.length - 1],
      };
    });
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this._entries.values()).map((e) => e.store.close()));
  }

  private _createEntry(sessionId: string): RegistryEntry {
    const perSessionDir = this._outputDir
      ? `${this._outputDir}/sessions/${sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")}`
      : undefined;
    return {
      session_id: sessionId,
      store: new SessionStore(sessionId, perSessionDir),
      label: sessionId,
    };
  }
}

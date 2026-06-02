/**
 * AgentEventBus — Shared event infrastructure for Autonomous Explorer + Live Observer.
 *
 * All agent actions, thoughts, plans, and state changes are emitted as typed events.
 * Subscribers include: ConsoleLogger, SessionStore (NDJSON), ObserverServer (WebSocket),
 * RecorderBridge.
 *
 * Also provides pause/resume/takeover primitives for interactive observation.
 */

import { EventEmitter } from "node:events";

// ─────────────────────────────────────────────────────────────
// Event Types
// ─────────────────────────────────────────────────────────────

export type AgentEventType =
  // Session lifecycle
  | "session:start"
  | "session:end"
  // Planning
  | "plan:created"
  | "plan:revised"
  // Step-level (works for both scripted and autonomous)
  | "step:start"
  | "step:complete"
  | "step:failed"
  // Action-level (autonomous mode: navigator decisions)
  | "action:start"
  | "action:complete"
  | "action:failed"
  // Observations
  | "observation:screenshot"
  | "observation:dom"
  // Agent reasoning (autonomous mode)
  | "thought:reasoning"
  | "thought:decision"
  // Convergence signals (autonomous mode)
  | "convergence:stuck"
  | "convergence:loop_detected"
  | "convergence:no_progress"
  | "convergence:goal_met"
  | "convergence:budget_exceeded"
  // Success criteria (autonomous mode)
  | "criterion:checked"
  | "criterion:met"
  // Interactive control
  | "pause:requested"
  | "pause:resumed"
  | "takeover:start"
  | "takeover:end";

export interface AgentEvent {
  type: AgentEventType;
  timestamp: string; // ISO 8601
  session_id: string;
  sequence: number; // monotonically increasing per session
  data: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────
// AgentEventBus
// ─────────────────────────────────────────────────────────────

export class AgentEventBus extends EventEmitter {
  private _sequence = 0;
  private _paused = false;
  private _takeover = false;
  // Multiple loop checkpoints can await the same pause/takeover gate
  // concurrently (e.g. agent loop + a sub-task both at a checkpoint), so
  // we hold every waiter, not just the last one. A single-slot resolver
  // would orphan all but the most-recent waiter on resume — a permanent
  // hang (D2-M1).
  private _pauseResolvers: Array<() => void> = [];
  private _takeoverResolvers: Array<() => void> = [];

  constructor(public readonly sessionId: string) {
    super();
    this.setMaxListeners(20);
  }

  /**
   * Emit a typed agent event. Fires both the specific event type and "*" (wildcard).
   */
  emitEvent(type: AgentEventType, data: Record<string, unknown> = {}): AgentEvent {
    const event: AgentEvent = {
      type,
      timestamp: new Date().toISOString(),
      session_id: this.sessionId,
      sequence: this._sequence++,
      data,
    };
    this.emit(type, event);
    this.emit("*", event);
    return event;
  }

  // ── Pause / Resume ──────────────────────────────────────────

  get paused(): boolean {
    return this._paused;
  }

  /**
   * Pause the agent. The agent loop should call `waitIfPaused()` at checkpoints.
   */
  pause(): void {
    if (this._paused) return;
    this._paused = true;
    this.emitEvent("pause:requested");
  }

  /**
   * Resume a paused agent.
   */
  resume(): void {
    if (!this._paused) return;
    this._paused = false;
    this.emitEvent("pause:resumed");
    // Atomic swap: snapshot then clear before resolving so every pending
    // waiter is released and a resolver that re-enters waitIfPaused()
    // can't be dropped.
    const resolvers = this._pauseResolvers;
    this._pauseResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  /**
   * Await at agent loop checkpoints. Resolves immediately if not paused.
   */
  async waitIfPaused(): Promise<void> {
    if (!this._paused) return;
    return new Promise<void>((resolve) => {
      this._pauseResolvers.push(resolve);
    });
  }

  // ── Manual Takeover ─────────────────────────────────────────

  get takeover(): boolean {
    return this._takeover;
  }

  /**
   * Start manual takeover — agent pauses, user controls the browser.
   */
  startTakeover(): void {
    if (this._takeover) return;
    this._takeover = true;
    this.emitEvent("takeover:start");
  }

  /**
   * End manual takeover — agent re-observes and continues.
   */
  endTakeover(): void {
    if (!this._takeover) return;
    this._takeover = false;
    this.emitEvent("takeover:end");
    // Atomic swap: snapshot then clear before resolving so every pending
    // waiter is released (see resume() for the single-resolver hazard).
    const resolvers = this._takeoverResolvers;
    this._takeoverResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  /**
   * Await until manual takeover ends. Resolves immediately if not in takeover.
   */
  async waitForTakeoverEnd(): Promise<void> {
    if (!this._takeover) return;
    return new Promise<void>((resolve) => {
      this._takeoverResolvers.push(resolve);
    });
  }

  // ── Convenience Helpers ─────────────────────────────────────

  /**
   * Check if agent should yield control (pause or takeover).
   * Call at the top of each loop iteration.
   */
  async checkpoint(): Promise<void> {
    if (this._takeover) {
      await this.waitForTakeoverEnd();
    }
    if (this._paused) {
      await this.waitIfPaused();
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Console Logger Subscriber
// ─────────────────────────────────────────────────────────────

import { getLogger } from "../core/logger.js";

const log = getLogger("agent.events");

const EVENT_TAGS: Partial<Record<AgentEventType, string>> = {
  "session:start": "session",
  "session:end": "session",
  "step:start": "step",
  "step:complete": "step",
  "step:failed": "step",
  "action:start": "action",
  "action:complete": "action",
  "action:failed": "action",
  "plan:created": "plan",
  "plan:revised": "plan",
  "thought:reasoning": "think",
  "thought:decision": "decide",
  "convergence:stuck": "convergence",
  "convergence:loop_detected": "convergence",
  "convergence:no_progress": "convergence",
  "convergence:goal_met": "convergence",
  "convergence:budget_exceeded": "convergence",
  "criterion:met": "criterion",
  "pause:requested": "pause",
  "pause:resumed": "pause",
  "takeover:start": "takeover",
  "takeover:end": "takeover",
};

/**
 * Attach a structured-log subscriber to the event bus. Each agent event
 * becomes a structured log line tagged with `event` (raw type), `category`
 * (grouping), and a per-event payload.
 */
export function attachConsoleLogger(bus: AgentEventBus, verbose = false): void {
  bus.on("*", (event: AgentEvent) => {
    const category = EVENT_TAGS[event.type];
    if (!category) return;

    const base = {
      event: event.type,
      category,
      sessionId: event.session_id,
      seq: event.sequence,
    };

    switch (event.type) {
      case "session:start":
        log.info(
          {
            ...base,
            scenarioId: event.data.scenario_id ?? null,
            personaId: event.data.persona_id ?? null,
          },
          `session started`,
        );
        break;
      case "session:end":
        log.info(
          {
            ...base,
            status: event.data.status ?? null,
            totalActions: event.data.total_actions ?? 0,
            costUsd: Number((event.data.cost_usd as number ?? 0).toFixed(3)),
          },
          `session ended`,
        );
        break;
      case "step:start":
        log.info(
          {
            ...base,
            stepId: event.data.step_id ?? null,
            stepType: event.data.step_type ?? null,
            instruction: event.data.instruction
              ? String(event.data.instruction).slice(0, 200)
              : null,
          },
          `step started`,
        );
        break;
      case "step:complete":
        log.info(
          {
            ...base,
            stepId: event.data.step_id ?? null,
            status: event.data.status ?? "pass",
            durationMs: event.data.duration_ms ?? 0,
          },
          `step complete`,
        );
        break;
      case "step:failed":
        log.warn(
          {
            ...base,
            stepId: event.data.step_id ?? null,
            error: String(event.data.error ?? "unknown error").slice(0, 200),
          },
          `step failed`,
        );
        break;
      case "plan:created":
      case "plan:revised":
        log.info(
          {
            ...base,
            stepCount: (event.data.steps as unknown[])?.length ?? 0,
            reasoning: String(event.data.reasoning ?? "").slice(0, 200),
          },
          event.type === "plan:created" ? `plan created` : `plan revised`,
        );
        break;
      case "thought:decision":
        if (verbose) {
          log.debug(
            {
              ...base,
              text: String(event.data.instruction ?? event.data.thought ?? "").slice(
                0,
                200,
              ),
            },
            `decision`,
          );
        }
        break;
      case "convergence:goal_met":
        log.info(base, `all success criteria met`);
        break;
      case "convergence:stuck":
        log.warn(
          { ...base, reason: String(event.data.reason ?? "max failures") },
          `agent stuck`,
        );
        break;
      case "convergence:budget_exceeded":
        log.warn(
          {
            ...base,
            spentUsd: Number((event.data.spent as number ?? 0).toFixed(3)),
          },
          `budget exceeded`,
        );
        break;
      case "criterion:met":
        log.info(
          {
            ...base,
            criterionId: event.data.id ?? null,
            description: event.data.description ?? null,
          },
          `criterion met`,
        );
        break;
      default:
        if (verbose) {
          log.debug({ ...base, data: event.data }, `event`);
        }
    }
  });
}

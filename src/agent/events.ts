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
  private _pauseResolve: (() => void) | null = null;
  private _takeoverResolve: (() => void) | null = null;

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
    // Atomic swap: grab resolve before nulling to avoid race with waitIfPaused()
    const resolve = this._pauseResolve;
    this._pauseResolve = null;
    if (resolve) resolve();
  }

  /**
   * Await at agent loop checkpoints. Resolves immediately if not paused.
   */
  async waitIfPaused(): Promise<void> {
    if (!this._paused) return;
    return new Promise<void>((resolve) => {
      this._pauseResolve = resolve;
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
    // Atomic swap: grab resolve before nulling to avoid race
    const resolve = this._takeoverResolve;
    this._takeoverResolve = null;
    if (resolve) resolve();
  }

  /**
   * Await until manual takeover ends. Resolves immediately if not in takeover.
   */
  async waitForTakeoverEnd(): Promise<void> {
    if (!this._takeover) return;
    return new Promise<void>((resolve) => {
      this._takeoverResolve = resolve;
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

import chalk from "chalk";

const EVENT_TAGS: Partial<Record<AgentEventType, { tag: string; color: typeof chalk.green }>> = {
  "session:start": { tag: "SESSION", color: chalk.cyan },
  "session:end": { tag: "SESSION", color: chalk.cyan },
  "step:start": { tag: "STEP", color: chalk.blue },
  "step:complete": { tag: "STEP", color: chalk.green },
  "step:failed": { tag: "STEP", color: chalk.red },
  "action:start": { tag: "ACTION", color: chalk.blue },
  "action:complete": { tag: "ACTION", color: chalk.green },
  "action:failed": { tag: "ACTION", color: chalk.red },
  "plan:created": { tag: "PLAN", color: chalk.magenta },
  "plan:revised": { tag: "REPLAN", color: chalk.yellow },
  "thought:reasoning": { tag: "THINK", color: chalk.gray },
  "thought:decision": { tag: "DECIDE", color: chalk.white },
  "convergence:stuck": { tag: "STUCK", color: chalk.red },
  "convergence:loop_detected": { tag: "LOOP", color: chalk.red },
  "convergence:goal_met": { tag: "GOAL", color: chalk.green },
  "convergence:budget_exceeded": { tag: "BUDGET", color: chalk.yellow },
  "criterion:met": { tag: "CRITERIA", color: chalk.green },
  "pause:requested": { tag: "PAUSE", color: chalk.yellow },
  "pause:resumed": { tag: "RESUME", color: chalk.green },
  "takeover:start": { tag: "TAKEOVER", color: chalk.yellow },
  "takeover:end": { tag: "RELEASE", color: chalk.green },
};

/**
 * Attach a console logger to the event bus. Prints human-readable event summaries.
 */
export function attachConsoleLogger(bus: AgentEventBus, verbose = false): void {
  bus.on("*", (event: AgentEvent) => {
    const entry = EVENT_TAGS[event.type];
    if (!entry) return;

    const { tag, color } = entry;
    const prefix = color(`[${tag}]`);

    switch (event.type) {
      case "session:start":
        console.log(
          prefix,
          `${event.data.scenario_id ?? "?"} x ${event.data.persona_id ?? "?"}`,
          chalk.gray(`(session ${event.session_id})`),
        );
        break;
      case "session:end":
        console.log(
          prefix,
          `ended`,
          chalk.gray(
            `status=${event.data.status ?? "?"} actions=${event.data.total_actions ?? 0} cost=$${(event.data.cost_usd as number ?? 0).toFixed(3)}`,
          ),
        );
        break;
      case "step:start":
        console.log(
          prefix,
          chalk.gray(`${event.data.step_id ?? "?"} (${event.data.step_type ?? "?"})`),
          event.data.instruction ? String(event.data.instruction).slice(0, 80) : "",
        );
        break;
      case "step:complete":
        console.log(
          prefix,
          chalk.gray(`${event.data.step_id ?? "?"}`),
          `status=${event.data.status ?? "pass"}`,
          chalk.gray(`${event.data.duration_ms ?? 0}ms`),
        );
        break;
      case "step:failed":
        console.log(
          prefix,
          chalk.gray(`${event.data.step_id ?? "?"}`),
          String(event.data.error ?? "unknown error").slice(0, 100),
        );
        break;
      case "plan:created":
      case "plan:revised":
        console.log(
          prefix,
          `${(event.data.steps as unknown[])?.length ?? 0} steps`,
          chalk.gray(String(event.data.reasoning ?? "").slice(0, 80)),
        );
        break;
      case "thought:decision":
        if (verbose) {
          console.log(
            prefix,
            String(event.data.instruction ?? event.data.thought ?? "").slice(0, 100),
          );
        }
        break;
      case "convergence:goal_met":
        console.log(prefix, "All success criteria met");
        break;
      case "convergence:stuck":
        console.log(prefix, String(event.data.reason ?? "max failures"));
        break;
      case "convergence:budget_exceeded":
        console.log(prefix, `$${(event.data.spent as number ?? 0).toFixed(3)} >= cap`);
        break;
      case "criterion:met":
        console.log(prefix, `${event.data.id ?? "?"}: ${event.data.description ?? ""}`);
        break;
      default:
        if (verbose) {
          console.log(prefix, JSON.stringify(event.data).slice(0, 120));
        }
    }
  });
}

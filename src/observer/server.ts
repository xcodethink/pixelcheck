/**
 * Observer Server — HTTP + WebSocket server for live agent observation.
 *
 * Serves the dashboard HTML and provides real-time event/frame streaming
 * via WebSocket. Binds to 127.0.0.1 only for security.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentEvent, AgentEventBus } from "../agent/events.js";
import type { SessionStore } from "./session-store.js";
import { getDashboardHtml } from "./dashboard.js";
import { deriveTimeline, eventsInRange, screenshotAt } from "./session-store.js";

export interface ObserverServerOptions {
  port: number;
  eventBus: AgentEventBus;
  sessionStore: SessionStore;
}

export class ObserverServer {
  private _httpServer: Server;
  private _wss: WebSocketServer;
  private _clients = new Set<WebSocket>();
  private _eventBus: AgentEventBus;
  private _sessionStore: SessionStore;
  private _port: number;

  constructor(opts: ObserverServerOptions) {
    this._eventBus = opts.eventBus;
    this._sessionStore = opts.sessionStore;
    this._port = opts.port;

    // HTTP server — serves dashboard
    this._httpServer = createServer(this._handleHttp.bind(this));

    // WebSocket server — upgrades from HTTP
    this._wss = new WebSocketServer({ server: this._httpServer });
    this._wss.on("connection", this._handleWsConnection.bind(this));

    // Subscribe to event bus — broadcast events to all WS clients
    this._eventBus.on("*", (event: AgentEvent) => {
      this._broadcast({ type: "event", payload: event });
    });
  }

  /**
   * Start listening. Returns when the server is ready.
   */
  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this._httpServer.listen(this._port, "127.0.0.1", () => {
        console.log(
          `  [observer] Dashboard: http://localhost:${this._port}`,
        );
        resolve();
      });
      this._httpServer.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(
            `Observer port ${this._port} is already in use. Try --observe-port <port> with a different port.`,
          ));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Stop the server and close all connections.
   */
  async stop(): Promise<void> {
    for (const client of this._clients) {
      client.close(1001, "Server shutting down");
    }
    this._clients.clear();
    this._wss.close();
    return new Promise<void>((resolve) => {
      this._httpServer.close(() => resolve());
    });
  }

  /**
   * Send a screencast frame to all connected clients.
   */
  broadcastFrame(base64Data: string): void {
    // Send frame as binary (more efficient than JSON-wrapping base64)
    const buffer = Buffer.from(base64Data, "base64");
    for (const client of this._clients) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(buffer, (err) => {
          if (err) this._clients.delete(client);
        });
      }
    }
  }

  // ── Private ─────────────────────────────────────────────────

  private _handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";

    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getDashboardHtml());
      return;
    }

    if (url === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this._sessionStore.state));
      return;
    }

    if (url === "/api/events") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this._sessionStore.events.slice(-100)));
      return;
    }

    // Full event history for timeline scrubbing (bounded by MAX_EVENT_FETCH).
    if (url.startsWith("/api/events/all")) {
      const parsed = new URL(url, `http://127.0.0.1:${this._port}`);
      const start = Number(parsed.searchParams.get("start") ?? "0");
      const end = Number(parsed.searchParams.get("end") ?? String(Number.MAX_SAFE_INTEGER));
      const events = eventsInRange(this._sessionStore.events, start, end).slice(0, 2000);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(events));
      return;
    }

    if (url === "/api/timeline") {
      const timeline = deriveTimeline(this._sessionStore.events);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(timeline));
      return;
    }

    if (url.startsWith("/api/screenshot")) {
      const parsed = new URL(url, `http://127.0.0.1:${this._port}`);
      const seq = Number(parsed.searchParams.get("seq") ?? "0");
      const path = screenshotAt(this._sessionStore.events, seq);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path }));
      return;
    }

    // 404 for everything else
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }

  private _handleWsConnection(ws: WebSocket): void {
    this._clients.add(ws);

    // Send current state as initial payload
    ws.send(
      JSON.stringify({
        type: "init",
        payload: {
          state: this._sessionStore.state,
          recentEvents: this._sessionStore.events.slice(-50),
        },
      }),
    );

    // Handle commands from dashboard (validated against allowlist)
    const ALLOWED_COMMANDS = new Set(["pause", "resume", "takeover", "release"]);
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { command: string };
        if (!ALLOWED_COMMANDS.has(msg.command)) return;
        switch (msg.command) {
          case "pause":
            this._eventBus.pause();
            break;
          case "resume":
            this._eventBus.resume();
            break;
          case "takeover":
            this._eventBus.startTakeover();
            break;
          case "release":
            this._eventBus.endTakeover();
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      this._clients.delete(ws);
    });
  }

  private _broadcast(msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg);
    for (const client of this._clients) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(data, (err) => {
          if (err) this._clients.delete(client);
        });
      }
    }
  }
}

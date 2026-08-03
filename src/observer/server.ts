/**
 * Observer Server — HTTP + WebSocket server for live agent observation.
 *
 * Serves the dashboard HTML and provides real-time event/frame streaming
 * via WebSocket. Binds to 127.0.0.1 only for security.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentEvent, AgentEventBus } from "../agent/events.js";
import type { SessionStore } from "./session-store.js";
import { getDashboardHtml } from "./dashboard.js";
import { getGridHtml } from "./grid-dashboard.js";
import { deriveTimeline, eventsInRange, screenshotAt } from "./session-store.js";
import type { SessionRegistry } from "./session-registry.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("observer.server");

export interface ObserverServerOptions {
  port: number;
  eventBus: AgentEventBus;
  sessionStore: SessionStore;
  /** Optional multi-session registry — when present, /grid route is enabled */
  registry?: SessionRegistry;
}

export class ObserverServer {
  private _httpServer: Server;
  private _wss: WebSocketServer;
  private _clients = new Set<WebSocket>();
  private _eventBus: AgentEventBus;
  private _sessionStore: SessionStore;
  private _registry?: SessionRegistry;
  private _port: number;
  private _token: string;

  /** The bearer token required for API/WS access. Printed at startup. */
  get token(): string { return this._token; }

  /** The port actually bound. Differs from the requested one when that was 0. */
  get boundPort(): number {
    const addr = this._httpServer.address();
    return addr && typeof addr === "object" ? addr.port : this._port;
  }

  /**
   * The address to open, token included. The pages read the token from their
   * own query string, so an address without it loads a dashboard that cannot
   * open its WebSocket or read any route.
   */
  get url(): string {
    return `http://localhost:${this.boundPort}/?token=${this._token}`;
  }

  constructor(opts: ObserverServerOptions) {
    this._eventBus = opts.eventBus;
    this._sessionStore = opts.sessionStore;
    this._registry = opts.registry;
    this._port = opts.port;
    this._token = randomBytes(16).toString("hex");

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
        log.info(
          {
            port: this.boundPort,
            // Without the token, deliberately. The logger redacts a field
            // named `token`, and putting the same value inside a URL here
            // would route around that for anyone who shares a log file.
            url: `http://localhost:${this.boundPort}/`,
            token: this._token,
          },
          `observer dashboard listening`,
        );
        // The user needs the whole address, token and all, or the feature is
        // unusable. Kept out of the structured log above and written here as
        // human-facing output instead.
        process.stderr.write(`  Observer dashboard: ${this.url}\n`);
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
   * How many dashboard clients are currently attached.
   *
   * A broadcast to zero clients is silently a no-op, which makes "did the
   * client connect yet" and "did the broadcast work" indistinguishable from
   * the outside. Tests were bridging that with a fixed sleep before
   * broadcasting, which is a guess at a duration rather than a check of the
   * condition, and it failed on a loaded CI runner.
   */
  get connectedClientCount(): number {
    return this._clients.size;
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

  private _checkAuth(req: IncomingMessage): boolean {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this._port}`);
    const tokenParam = url.searchParams.get("token");
    if (tokenParam === this._token) return true;
    const authHeader = req.headers.authorization;
    if (authHeader === `Bearer ${this._token}`) return true;
    return false;
  }

  private _handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";
    // Match routes on the PATHNAME, not the raw url — req.url includes the
    // query string, so a bare `url === "/api/state"` failed to resolve
    // "/api/state?token=…" (it 404'd). Parsing the pathname makes ?token=
    // auth work the same as the Authorization header. (audit follow-up)
    const pathname = new URL(url, `http://127.0.0.1:${this._port}`).pathname;

    // Dashboard pages are served without auth (token is embedded in WS/API URLs)
    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getDashboardHtml());
      return;
    }

    // Every /api/* route requires auth, and this has to come before the
    // route table rather than partway down it. `/api/grid` and
    // `/api/session/:id` used to be matched above the check and returned
    // early, so both answered unauthenticated — `/api/session/:id` with the
    // session's state and its last 200 events, which carry the URLs visited
    // and the instructions given. Measured: a request with no token returned
    // an event containing `Type hunter2-REAL-PASSWORD into the password
    // field`. Those two routes were exempted because the grid page called
    // them without a token; the token now reaches the page instead.
    if (pathname.startsWith("/api/") && !this._checkAuth(req)) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized — pass ?token=<token> or Authorization: Bearer <token>");
      return;
    }

    // Multi-session grid dashboard (only enabled when registry is attached)
    if ((pathname === "/grid" || pathname === "/grid/") && this._registry) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getGridHtml());
      return;
    }

    if (pathname === "/api/grid" && this._registry) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this._registry.gridSnapshot()));
      return;
    }

    if (pathname.startsWith("/api/session/") && this._registry) {
      const sid = decodeURIComponent(url.replace("/api/session/", "").split("?")[0]!);
      const entry = this._registry.getEntry(sid);
      if (!entry) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          state: entry.store.state,
          timeline: deriveTimeline(entry.store.events),
          events: entry.store.events.slice(-200),
        }),
      );
      return;
    }

    if (pathname === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this._sessionStore.state));
      return;
    }

    if (pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this._sessionStore.events.slice(-100)));
      return;
    }

    // Full event history for timeline scrubbing (bounded by MAX_EVENT_FETCH).
    if (pathname.startsWith("/api/events/all")) {
      const parsed = new URL(url, `http://127.0.0.1:${this._port}`);
      const start = Number(parsed.searchParams.get("start") ?? "0");
      const end = Number(parsed.searchParams.get("end") ?? String(Number.MAX_SAFE_INTEGER));
      const events = eventsInRange(this._sessionStore.events, start, end).slice(0, 2000);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(events));
      return;
    }

    if (pathname === "/api/timeline") {
      const timeline = deriveTimeline(this._sessionStore.events);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(timeline));
      return;
    }

    if (pathname.startsWith("/api/screenshot")) {
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

  private _handleWsConnection(ws: WebSocket, req: IncomingMessage): void {
    // Verify token from query string
    const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${this._port}`);
    if (reqUrl.searchParams.get("token") !== this._token) {
      ws.close(4001, "Unauthorized");
      return;
    }
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

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { WebSocket } from "ws";
import type { Server } from "node:http";
import { ObserverServer } from "../src/observer/server.js";
import { AgentEventBus } from "../src/agent/events.js";
import { SessionStore } from "../src/observer/session-store.js";
import { SessionRegistry } from "../src/observer/session-registry.js";

/** Read the OS-assigned port (server bound to :0) off the running instance. */
function portOf(server: ObserverServer): number {
  const http = (server as unknown as { _httpServer: Server })._httpServer;
  const addr = http.address();
  if (addr && typeof addr === "object" && addr.port) return addr.port;
  throw new Error("observer server has no bound port");
}

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

describe("observer HTTP/WS server", () => {
  let bus: AgentEventBus;
  let store: SessionStore;
  let server: ObserverServer;
  let base: string;
  let wsBase: string;
  let token: string;

  beforeAll(async () => {
    bus = new AgentEventBus("test-session");
    store = new SessionStore("test-session");
    const registry = new SessionRegistry("test-root");
    server = new ObserverServer({ port: 0, eventBus: bus, sessionStore: store, registry });
    await server.start();
    const p = portOf(server);
    base = `http://127.0.0.1:${p}`;
    wsBase = `ws://127.0.0.1:${p}`;
    token = server.token;
  });

  afterAll(async () => {
    await server.stop();
  });

  it("mints a 32-hex bearer token", () => {
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("serves the dashboard at / without auth", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<!DOCTYPE html>");
  });

  it("serves the grid page itself without a token — it is only a shell", async () => {
    // The HTML carries no data. It reads the token out of its own query
    // string and every request it then makes is authenticated.
    const grid = await fetch(`${base}/grid`);
    expect(grid.status).toBe(200);
    expect(await grid.text()).toContain("PixelCheck");
  });

  it("refuses /api/grid without a token", async () => {
    // This route, and /api/session/:id below, used to be matched above the
    // auth check and returned early, so both answered unauthenticated. They
    // were exempted because the grid page polled them without a token; the
    // token now reaches the page instead.
    expect((await fetch(`${base}/api/grid`)).status).toBe(401);
  });

  it("serves /api/grid with a token", async () => {
    const snap = await fetch(`${base}/api/grid?token=${token}`);
    expect(snap.status).toBe(200);
    expect(Array.isArray(await snap.json())).toBe(true);
  });

  it("refuses an unknown session id without a token, rather than 404ing it", async () => {
    // Answering 404 unauthenticated is already an answer: it tells a caller
    // with no token which session ids exist.
    expect((await fetch(`${base}/api/session/nope`)).status).toBe(401);
  });

  it("404s an unknown session id once authenticated", async () => {
    expect((await fetch(`${base}/api/session/nope?token=${token}`)).status).toBe(404);
  });

  it("refuses a known session id without a token", async () => {
    // The measured leak: this route returns the session state and its last
    // 200 events, which carry the URLs visited and the instructions given.
    // A request with no token returned an event containing
    // "Type hunter2-REAL-PASSWORD into the password field".
    bus.emitEvent("session:start", { persona_id: "p", scenario_id: "s" });
    expect((await fetch(`${base}/api/session/test-session`)).status).toBe(401);
  });

  it("requires a token for /api/* data routes", async () => {
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
  });

  it("serves all data routes with ?token= (routing matches on pathname)", async () => {
    // Routes match on the pathname, so the query string (?token=) no longer
    // breaks the exact-match routes — they resolve the same as the
    // startsWith ones. (Regression guard for the audit routing fix.)
    for (const route of [
      "/api/state",
      "/api/events",
      "/api/timeline",
      "/api/events/all?start=0",
      "/api/screenshot?seq=0",
    ]) {
      const sep = route.includes("?") ? "&" : "?";
      const res = await fetch(`${base}${route}${sep}token=${token}`);
      expect(res.status, route).toBe(200);
    }
  });

  it("also accepts the Authorization: Bearer header", async () => {
    const hdr = { headers: { authorization: `Bearer ${token}` } };
    expect((await fetch(`${base}/api/state`, hdr)).status).toBe(200);
  });

  it("404s unknown routes", async () => {
    expect((await fetch(`${base}/totally-unknown`)).status).toBe(404);
  });

  it("closes a WS connection that presents a bad token (code 4001)", async () => {
    const ws = new WebSocket(`${wsBase}/ws?token=WRONG`);
    const code = await new Promise<number>((resolve) => {
      ws.on("close", (c) => resolve(c));
      ws.on("error", () => {});
    });
    expect(code).toBe(4001);
  });

  it("sends an init payload to a good-token WS client", async () => {
    // Attach the message listener synchronously at construction — the server
    // sends `init` immediately on connect, so awaiting `open` first can race
    // past the first frame.
    const ws = new WebSocket(`${wsBase}/ws?token=${token}`);
    try {
      const msg = await new Promise<{ type: string; payload: Record<string, unknown> }>(
        (resolve, reject) => {
          ws.on("message", (d) => resolve(JSON.parse(d.toString())));
          ws.on("error", reject);
        },
      );
      expect(msg.type).toBe("init");
      expect(msg.payload).toHaveProperty("state");
      expect(msg.payload).toHaveProperty("recentEvents");
    } finally {
      ws.close();
    }
  });

  it("dispatches an allowlisted command to the event bus, ignores unknown ones", async () => {
    const pauseSpy = vi.spyOn(bus, "pause");
    const ws = await openWs(`${wsBase}/ws?token=${token}`);
    try {
      ws.send(JSON.stringify({ command: "nonsense" }));
      ws.send(JSON.stringify({ command: "pause" }));
      // Wait for the dispatch to land, not for a duration. The 120ms sleep
      // this replaces was the single most frequent CI flake: the assertion
      // fired before a loaded runner had processed the frame.
      await vi.waitFor(() => expect(pauseSpy).toHaveBeenCalledTimes(1));
      // ...and the unknown command still must not have reached the bus.
      expect(pauseSpy).toHaveBeenCalledTimes(1);
    } finally {
      ws.close();
      pauseSpy.mockRestore();
    }
  });

  it("broadcasts a screencast frame as binary to connected clients", async () => {
    const ws = await openWs(`${wsBase}/ws?token=${token}`);
    ws.binaryType = "nodebuffer";
    try {
      const binary = new Promise<Buffer>((resolve) => {
        ws.on("message", (d, isBinary) => {
          if (isBinary) resolve(d as Buffer);
        });
      });
      // A broadcast to zero clients is a silent no-op, so wait for the server
      // to have actually registered this connection rather than assuming a
      // tick is enough.
      await vi.waitFor(() => expect(server.connectedClientCount).toBe(1));
      server.broadcastFrame(Buffer.from("frame-bytes").toString("base64"));
      expect((await binary).toString()).toBe("frame-bytes");
    } finally {
      ws.close();
    }
  });

  it("relays event-bus events to connected clients", async () => {
    const ws = await openWs(`${wsBase}/ws?token=${token}`);
    try {
      const eventMsg = new Promise<{ type: string }>((resolve) => {
        ws.on("message", (d, isBinary) => {
          if (isBinary) return;
          const m = JSON.parse(d.toString());
          if (m.type === "event") resolve(m);
        });
      });
      await vi.waitFor(() => expect(server.connectedClientCount).toBe(1));
      // emitEvent does the dual-emit (type + "*"); the server listens on "*".
      bus.emitEvent("session:start", {});
      const m = await eventMsg;
      expect(m.type).toBe("event");
    } finally {
      ws.close();
    }
  });
});

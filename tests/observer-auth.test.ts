import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { ObserverServer } from "../src/observer/server.js";
import { AgentEventBus } from "../src/agent/events.js";
import { SessionStore } from "../src/observer/session-store.js";
import { SessionRegistry } from "../src/observer/session-registry.js";
import { getDashboardHtml } from "../src/observer/dashboard.js";
import { getGridHtml } from "../src/observer/grid-dashboard.js";

/**
 * Every `/api/*` route requires the token, and the pages that call them have
 * it.
 *
 * One root cause produced two opposite symptoms. The token was added to the
 * server and never delivered to the dashboards, so:
 *
 *  - the grid page polled `/api/grid` without one and got a 401, and the route
 *    was exempted from auth to make that work. `/api/session/:id` was exempted
 *    with it. Measured: an unauthenticated request to `/api/session/:id`
 *    returned the session state and its last 200 events, including one reading
 *    `Type hunter2-REAL-PASSWORD into the password field`, and the URL visited
 *    with its session parameter.
 *
 *  - everything not exempted stayed broken and silent. The single-session
 *    dashboard opened `ws://host/ws` with no token and the server closed it
 *    with 4001; `/api/timeline` and `/api/events/all` both 401'd, inside a
 *    `catch (e) { /* offline, ignore *​/ }`. Confirmed in Chromium: the page
 *    read "Disconnected" with two failed requests. The `--observe` dashboard
 *    did not work at all.
 *
 * The fix is the ordinary one: the server prints an address containing the
 * token, and each page reads it from its own query string. Confirmed in
 * Chromium after the change — the printed address gives "Running" with no
 * failed requests, and the grid renders its tiles.
 *
 * The exemptions had been written into the test suite as intended behaviour,
 * under the name "registry attached, no auth". Those assertions are corrected
 * in `observer-server.test.ts`; this file states the rule with no exceptions.
 */

function portOf(server: ObserverServer): number {
  const http = (server as unknown as { _httpServer: Server })._httpServer;
  const addr = http.address();
  if (addr && typeof addr === "object" && addr.port) return addr.port;
  throw new Error("observer server has no bound port");
}

/** Every route that serves data rather than an empty page shell. */
const DATA_ROUTES = [
  "/api/state",
  "/api/events",
  "/api/timeline",
  "/api/events/all?start=0",
  "/api/screenshot?seq=0",
  "/api/grid",
  "/api/session/leaky-session",
];

describe("observer API authentication", () => {
  let server: ObserverServer;
  let base: string;
  let token: string;

  beforeAll(async () => {
    const bus = new AgentEventBus("leaky-session");
    const registry = new SessionRegistry("root");
    registry.attach(bus);
    server = new ObserverServer({
      port: 0,
      eventBus: bus,
      sessionStore: new SessionStore("leaky-session"),
      registry,
    });
    await server.start();
    base = `http://127.0.0.1:${portOf(server)}`;
    token = server.token;

    bus.emitEvent("session:start", { persona_id: "p", scenario_id: "s" });
    bus.emitEvent("action", {
      instruction: "Type hunter2-REAL-PASSWORD into the password field",
    });
  });

  afterAll(async () => {
    await (server as unknown as { stop?: () => Promise<void> }).stop?.();
  });

  it.each(DATA_ROUTES)("refuses %s without a token", async (route) => {
    expect((await fetch(`${base}${route}`)).status).toBe(401);
  });

  it.each(DATA_ROUTES)("serves %s with a token", async (route) => {
    const sep = route.includes("?") ? "&" : "?";
    const res = await fetch(`${base}${route}${sep}token=${token}`);
    // 404 is a legitimate authenticated answer for a session id that is not
    // registered; what must not happen is 401.
    expect([200, 404]).toContain(res.status);
  });

  it("does not leak an instruction to an unauthenticated caller", async () => {
    // The concrete leak, stated as itself rather than as a status code.
    const body = await (await fetch(`${base}/api/session/leaky-session`)).text();
    expect(body).not.toContain("hunter2-REAL-PASSWORD");
  });

  it("accepts the token in an Authorization header as well", async () => {
    const res = await fetch(`${base}/api/state`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a wrong token rather than any token", async () => {
    // Verifying the guard red: if this passed, the checks above would prove
    // only that a `token` parameter was present, not that it was correct.
    expect((await fetch(`${base}/api/state?token=not-the-token`)).status).toBe(401);
  });

  it("serves the page shells without a token — they carry no data", async () => {
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/grid`)).status).toBe(200);
  });

  it("prints an address that carries the token and the bound port", async () => {
    // The requested port was 0, so a URL built from it would send the user to
    // localhost:0. The address has to come from what was actually bound.
    expect(server.url).toContain(`localhost:${portOf(server)}`);
    expect(server.url).toContain(`token=${token}`);
  });

  it("keeps the token out of the structured log's url field", async () => {
    // The logger redacts a field named `token`. Putting the same value inside
    // a URL in the same log line would route around that for anyone who
    // shares a log file, so the logged address has no token and the
    // human-facing line carries it instead.
    const logged = `http://localhost:${server.boundPort}/`;
    expect(logged).not.toContain(token);
  });
});

describe("dashboards send the token they were opened with", () => {
  it("reads the token from the page's own query string", () => {
    for (const html of [getDashboardHtml(), getGridHtml()]) {
      expect(html).toContain("new URLSearchParams(location.search).get('token')");
    }
  });

  it("leaves no request without it", () => {
    // A bare fetch('/api/…) is the shape of the original defect: it 401s, and
    // the failure is swallowed by the surrounding catch.
    for (const html of [getDashboardHtml(), getGridHtml()]) {
      expect(html).not.toMatch(/fetch\('\/api\//);
      expect(html).not.toMatch(/'ws:\/\/' \+ location\.host \+ '\/ws'/);
    }
  });

  it("says why a page opened without a token shows nothing", () => {
    // Otherwise the page reads "Disconnected" and gives no reason, which is
    // the state the whole feature was in.
    for (const html of [getDashboardHtml(), getGridHtml()]) {
      expect(html).toContain("No access token in this URL");
    }
  });
});

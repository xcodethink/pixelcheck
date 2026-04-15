/**
 * Unit tests for NetworkSignalCollector using a fake Page.
 *
 * We avoid launching a real browser in unit tests — the Playwright Page
 * contract surface we need is tiny (on/off + request/response events).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { NetworkSignalCollector } from "../../src/agent/signals/network.js";

// ─────────────────────────────────────────────────────────────
// Fake Playwright primitives
// ─────────────────────────────────────────────────────────────

interface FakeRequest {
  url(): string;
  method(): string;
  resourceType(): string;
  failure(): { errorText: string } | null;
}

interface FakeResponse {
  status(): number;
  request(): FakeRequest;
}

function makeRequest(overrides: Partial<{ url: string; method: string; type: string; failure: string | null }> = {}): FakeRequest {
  const o = {
    url: "https://api.example.com/ping",
    method: "GET",
    type: "xhr",
    failure: null as string | null,
    ...overrides,
  };
  return {
    url: () => o.url,
    method: () => o.method,
    resourceType: () => o.type,
    failure: () => (o.failure ? { errorText: o.failure } : null),
  };
}

function makeResponse(req: FakeRequest, status: number): FakeResponse {
  return { status: () => status, request: () => req };
}

class FakePage extends EventEmitter {}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe("NetworkSignalCollector", () => {
  let page: FakePage;
  let collector: NetworkSignalCollector;

  beforeEach(() => {
    page = new FakePage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    collector = new NetworkSignalCollector(page as any, 500);
    collector.start();
  });

  it("records a completed request with status", () => {
    const req = makeRequest({ url: "https://api.example.com/a" });
    page.emit("request", req);
    page.emit("response", makeResponse(req, 200));

    const snap = collector.snapshot();
    expect(snap.total_requests).toBe(1);
    expect(snap.failed_requests).toBe(0);
    expect(snap.status_counts["2xx"]).toBe(1);
    expect(snap.all[0].status).toBe(200);
  });

  it("counts 4xx / 5xx as failures", () => {
    const r1 = makeRequest({ url: "https://a.com/1" });
    const r2 = makeRequest({ url: "https://a.com/2" });
    page.emit("request", r1);
    page.emit("request", r2);
    page.emit("response", makeResponse(r1, 404));
    page.emit("response", makeResponse(r2, 500));

    const snap = collector.snapshot();
    expect(snap.failed_requests).toBe(2);
    expect(snap.status_counts["4xx"]).toBe(1);
    expect(snap.status_counts["5xx"]).toBe(1);
  });

  it("captures network-level failures", () => {
    const req = makeRequest({ url: "https://dead.example", failure: "net::ERR_NAME_NOT_RESOLVED" });
    page.emit("request", req);
    page.emit("requestfailed", req);

    const snap = collector.snapshot();
    expect(snap.failed_requests).toBe(1);
    expect(snap.status_counts.err).toBe(1);
    expect(snap.failures[0].failure_reason).toContain("ERR_NAME_NOT_RESOLVED");
  });

  it("flags slow requests above threshold", async () => {
    const req = makeRequest();
    page.emit("request", req);
    // Simulate delay
    await new Promise((r) => setTimeout(r, 600));
    page.emit("response", makeResponse(req, 200));

    const snap = collector.snapshot();
    expect(snap.slow_requests.length).toBe(1);
    expect(snap.slow_requests[0].duration_ms ?? 0).toBeGreaterThanOrEqual(500);
  });

  it("findMatching handles substring + regex + status_range + duration", () => {
    const r1 = makeRequest({ url: "https://api.example.com/signup", method: "POST" });
    const r2 = makeRequest({ url: "https://api.example.com/login", method: "POST" });
    const r3 = makeRequest({ url: "https://cdn.example.com/logo.png", method: "GET" });
    page.emit("request", r1);
    page.emit("request", r2);
    page.emit("request", r3);
    page.emit("response", makeResponse(r1, 201));
    page.emit("response", makeResponse(r2, 401));
    page.emit("response", makeResponse(r3, 200));

    expect(collector.findMatching({ url_pattern: "/signup" })).toHaveLength(1);
    expect(collector.findMatching({ url_pattern: "re:/(signup|login)$" })).toHaveLength(2);
    expect(
      collector.findMatching({ url_pattern: "/signup", status_range: [200, 299] }),
    ).toHaveLength(1);
    expect(
      collector.findMatching({ url_pattern: "/login", status_range: [200, 299] }),
    ).toHaveLength(0);
    expect(collector.findMatching({ method: "GET" })).toHaveLength(1);
  });

  it("reset clears records but keeps listening", () => {
    const r1 = makeRequest();
    page.emit("request", r1);
    page.emit("response", makeResponse(r1, 200));
    expect(collector.snapshot().total_requests).toBe(1);

    collector.reset();
    expect(collector.snapshot().total_requests).toBe(0);

    const r2 = makeRequest();
    page.emit("request", r2);
    page.emit("response", makeResponse(r2, 200));
    expect(collector.snapshot().total_requests).toBe(1);
  });

  it("stop is idempotent and detaches listeners", () => {
    const r1 = makeRequest();
    page.emit("request", r1);
    collector.stop();
    collector.stop(); // should not throw
    // Events after stop should be ignored
    const r2 = makeRequest();
    page.emit("request", r2);
    page.emit("response", makeResponse(r2, 200));
    const snap = collector.snapshot();
    // r1 was recorded before stop; r2 must not be
    expect(snap.all.some((x) => x.url === r2.url())).toBe(true);
    // Actually r1 and r2 have same URL from makeRequest defaults — verify by count
    // After stop, r2 should still be ignored — so total should be 1
    expect(snap.total_requests).toBe(1);
  });
});

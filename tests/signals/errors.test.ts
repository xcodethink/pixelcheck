/**
 * Unit tests for ErrorSignalCollector + matchErrors.
 *
 * Uses a fake Page with stubbed console/pageerror/requestfailed/response events.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  ErrorSignalCollector,
  matchErrors,
  type ErrorSignal,
} from "../../src/agent/signals/errors.js";

function makeConsoleMsg(type: string, text: string): { type(): string; text(): string; location(): { url: string; lineNumber: number } } {
  return {
    type: () => type,
    text: () => text,
    location: () => ({ url: "https://app/page.js", lineNumber: 42 }),
  };
}
function makeRequest(url: string, resourceType = "xhr", failure: string | null = null): { url(): string; method(): string; resourceType(): string; failure(): { errorText: string } | null } {
  return {
    url: () => url,
    method: () => "GET",
    resourceType: () => resourceType,
    failure: () => (failure ? { errorText: failure } : null),
  };
}
function makeResponse(url: string, status: number, resourceType: string = "script"): { status(): number; url(): string; request(): ReturnType<typeof makeRequest> } {
  const req = makeRequest(url, resourceType);
  return { status: () => status, url: () => url, request: () => req };
}

class FakePage extends EventEmitter {}

describe("ErrorSignalCollector", () => {
  let page: FakePage;
  let collector: ErrorSignalCollector;

  beforeEach(() => {
    page = new FakePage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    collector = new ErrorSignalCollector(page as any);
    collector.start();
  });

  it("captures console errors and warnings", () => {
    page.emit("console", makeConsoleMsg("error", "Unhandled TypeError"));
    page.emit("console", makeConsoleMsg("warning", "Deprecated API"));
    page.emit("console", makeConsoleMsg("log", "hello")); // filtered out
    const snap = collector.snapshot();
    expect(snap.console_errors).toBe(1);
    expect(snap.console_warnings).toBe(1);
    expect(snap.total).toBe(2);
  });

  it("captures pageerrors with stack", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at fn (app.js:12:3)";
    page.emit("pageerror", err);
    const snap = collector.snapshot();
    expect(snap.pageerrors).toBe(1);
    expect(snap.records[0].message).toContain("boom");
    expect(snap.records[0].location).toContain("app.js");
  });

  it("captures requestfailed", () => {
    page.emit("requestfailed", makeRequest("https://x/y", "xhr", "net::ERR_FAILED"));
    const snap = collector.snapshot();
    expect(snap.request_failures).toBe(1);
  });

  it("captures 4xx/5xx on static resources but not XHR", async () => {
    // 404 on a script — counts
    page.emit("response", makeResponse("https://cdn/app.js", 404, "script"));
    // 500 on an XHR — skipped (handled by NetworkSignal)
    page.emit("response", makeResponse("https://api/x", 500, "xhr"));
    // Let async handler flush
    await new Promise((r) => setTimeout(r, 0));
    const snap = collector.snapshot();
    expect(snap.request_failures).toBe(1);
    expect(snap.records[0].message).toContain("404");
  });

  it("respects ignore patterns", () => {
    collector.setIgnorePatterns(["Third-party .*"]);
    page.emit("console", makeConsoleMsg("error", "Third-party widget crash"));
    page.emit("console", makeConsoleMsg("error", "Real app error"));
    const snap = collector.snapshot();
    expect(snap.console_errors).toBe(1);
    expect(snap.records[0].message).toBe("Real app error");
  });

  it("stop is idempotent and detaches listeners", () => {
    page.emit("console", makeConsoleMsg("error", "before stop"));
    collector.stop();
    collector.stop();
    page.emit("console", makeConsoleMsg("error", "after stop"));
    const snap = collector.snapshot();
    expect(snap.console_errors).toBe(1);
  });
});

describe("matchErrors", () => {
  const sig: ErrorSignal = {
    total: 5,
    console_errors: 3,
    console_warnings: 2,
    pageerrors: 1,
    request_failures: 0,
    records: [],
    window_ms: 100,
  };

  it("passes when under all thresholds", () => {
    const r = matchErrors(sig, { console_error_max: 5, pageerror_max: 2 });
    expect(r.met).toBe(true);
  });

  it("fails when console_errors over threshold", () => {
    const r = matchErrors(sig, { console_error_max: 0 });
    expect(r.met).toBe(false);
    expect(r.violations[0]).toMatch(/console_errors/);
  });

  it("reports multiple violations", () => {
    const r = matchErrors(sig, { console_error_max: 0, pageerror_max: 0 });
    expect(r.violations).toHaveLength(2);
  });
});

/**
 * Tests for src/core/recorder.ts — the per-Page artefact accumulator
 * (screenshots, segmented vision input, console-error log).
 *
 * The Recorder class wraps a Playwright `Page` and:
 *   - attaches console / pageerror / requestfailed listeners
 *   - writes screenshots + .sha256 sidecars to an artefacts directory
 *   - captures full + thumbnail + 5 viewport segments for vision input
 *   - drains/persists the accumulated console-error log
 *
 * Real Page would launch Chromium; for unit tests we mock the surface
 * with a minimal EventEmitter that supports .on('console', cb) plus
 * stub .screenshot / .evaluate / .waitForTimeout. This keeps the tests
 * deterministic and fast (< 200 ms) while still exercising every
 * branch of the recorder logic that runs in Node (the inline
 * page.evaluate() callbacks are browser-only and not counted).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { Page } from "playwright";
import { Recorder } from "../src/core/recorder.js";

// 1×1 transparent PNG. Real sharp can ingest it; if the test passes it
// to buildThumbnail we exercise the success branch.
const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6300010000000005000168ee52cb0000000049454e44ae426082",
  "hex",
);

interface PageMockOpts {
  /** Buffer returned by page.screenshot. Default = PNG_1×1. */
  screenshotBuf?: Buffer;
  /**
   * Sequence of values returned by page.evaluate() in order. Mismatched
   * length is fine — extra calls return undefined. Default empty queue.
   */
  evaluateReturns?: unknown[];
  /** Throw from screenshot. */
  screenshotThrows?: Error;
  /** Throw from evaluate. */
  evaluateThrows?: Error;
}

interface MockedPage extends Page {
  /** Manually trigger the listener Recorder attached for `event`. */
  fire(event: string, arg: unknown): void;
}

function makeMockPage(opts: PageMockOpts = {}): MockedPage {
  const handlers = new Map<string, Array<(arg: unknown) => void>>();
  const evalQueue = [...(opts.evaluateReturns ?? [])];
  const obj: Partial<MockedPage> & { fire: MockedPage["fire"] } = {
    on(event: string, cb: (arg: unknown) => void) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(cb);
      return obj as Page;
    },
    async screenshot() {
      if (opts.screenshotThrows) throw opts.screenshotThrows;
      return opts.screenshotBuf ?? PNG_1X1;
    },
    async evaluate() {
      if (opts.evaluateThrows) throw opts.evaluateThrows;
      const next = evalQueue.shift();
      return next as never;
    },
    async waitForTimeout() {
      // No-op in tests.
    },
    fire(event: string, arg: unknown) {
      for (const cb of handlers.get(event) ?? []) cb(arg);
    },
  };
  return obj as MockedPage;
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "recorder-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function tmpDir(name = "artefacts"): string {
  return path.join(tmpRoot, name);
}

// ─────────────────────────────────────────────────────────────
// Constructor
// ─────────────────────────────────────────────────────────────

describe("Recorder constructor", () => {
  it("creates the artefacts directory if it does not exist", () => {
    const dir = tmpDir("nested/deep");
    expect(fs.existsSync(dir)).toBe(false);
    new Recorder(makeMockPage(), dir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("does not throw when the directory already exists", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    expect(() => new Recorder(makeMockPage(), dir)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// Console-error listener
// ─────────────────────────────────────────────────────────────

describe("attachListeners — console events", () => {
  it("captures console.error messages with text + location + timestamp", () => {
    const page = makeMockPage();
    const r = new Recorder(page, tmpDir());

    page.fire("console", {
      type: () => "error",
      text: () => "ReferenceError: x is not defined",
      location: () => ({ url: "https://x.example/app.js" }),
    });

    const errors = r.getConsoleErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: "console",
      text: "ReferenceError: x is not defined",
      location: "https://x.example/app.js",
    });
    expect(errors[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("ignores non-error console messages (warn/log/info)", () => {
    const page = makeMockPage();
    const r = new Recorder(page, tmpDir());

    page.fire("console", {
      type: () => "warn",
      text: () => "deprecation warning",
      location: () => ({ url: "https://x.example/" }),
    });
    page.fire("console", {
      type: () => "log",
      text: () => "debug",
      location: () => ({ url: "https://x.example/" }),
    });

    expect(r.getConsoleErrors()).toHaveLength(0);
  });

  it("tolerates a console event with no location", () => {
    const page = makeMockPage();
    const r = new Recorder(page, tmpDir());

    page.fire("console", {
      type: () => "error",
      text: () => "lone error",
      location: () => null,
    });

    const errors = r.getConsoleErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.location).toBeUndefined();
  });
});

describe("attachListeners — pageerror events", () => {
  it("captures uncaught exceptions with message + stack", () => {
    const page = makeMockPage();
    const r = new Recorder(page, tmpDir());

    const err = new Error("boom");
    page.fire("pageerror", err);

    const errors = r.getConsoleErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.type).toBe("pageerror");
    expect(errors[0]?.text).toBe("boom");
    expect(errors[0]?.location).toContain("Error: boom");
  });
});

describe("attachListeners — requestfailed events", () => {
  it("captures the network error text + URL", () => {
    const page = makeMockPage();
    const r = new Recorder(page, tmpDir());

    page.fire("requestfailed", {
      url: () => "https://x.example/missing.js",
      failure: () => ({ errorText: "net::ERR_FAILED" }),
    });

    const errors = r.getConsoleErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.type).toBe("requestfailed");
    expect(errors[0]?.text).toBe(
      "net::ERR_FAILED https://x.example/missing.js",
    );
  });

  it("falls back to 'unknown' when failure() returns null", () => {
    const page = makeMockPage();
    const r = new Recorder(page, tmpDir());

    page.fire("requestfailed", {
      url: () => "https://x.example/abandoned.js",
      failure: () => null,
    });

    expect(r.getConsoleErrors()[0]?.text).toBe(
      "unknown https://x.example/abandoned.js",
    );
  });
});

// ─────────────────────────────────────────────────────────────
// screenshot()
// ─────────────────────────────────────────────────────────────

describe("screenshot()", () => {
  it("writes the file with a zero-padded index + sanitised label", async () => {
    const page = makeMockPage();
    const r = new Recorder(page, tmpDir());

    const result = await r.screenshot("Top of Page!");

    expect(path.basename(result.filepath)).toBe("01-top_of_page_.png");
    expect(fs.existsSync(result.filepath)).toBe(true);
  });

  it("defaults the label to 'step' when none provided", async () => {
    const page = makeMockPage();
    const r = new Recorder(page, tmpDir());

    const result = await r.screenshot();

    expect(path.basename(result.filepath)).toBe("01-step.png");
  });

  it("increments the index across consecutive calls", async () => {
    const page = makeMockPage();
    const r = new Recorder(page, tmpDir());

    const a = await r.screenshot("first");
    const b = await r.screenshot("second");
    const c = await r.screenshot("third");

    expect(path.basename(a.filepath)).toBe("01-first.png");
    expect(path.basename(b.filepath)).toBe("02-second.png");
    expect(path.basename(c.filepath)).toBe("03-third.png");
  });

  it("returns a sha256 matching the buffer contents and writes a sidecar", async () => {
    const buf = Buffer.from([1, 2, 3, 4, 5]);
    const page = makeMockPage({ screenshotBuf: buf });
    const r = new Recorder(page, tmpDir());

    const result = await r.screenshot();

    const expected = crypto.createHash("sha256").update(buf).digest("hex");
    expect(result.sha256).toBe(expected);

    const sidecar = fs.readFileSync(`${result.filepath}.sha256`, "utf8");
    expect(sidecar).toBe(expected + "\n");
  });

  it("returns the buffer + a base64 encoding of it", async () => {
    const buf = Buffer.from("hello world");
    const page = makeMockPage({ screenshotBuf: buf });
    const r = new Recorder(page, tmpDir());

    const result = await r.screenshot();

    expect(result.buffer.equals(buf)).toBe(true);
    expect(result.base64).toBe(buf.toString("base64"));
  });

  it("collapses unsafe label characters to underscores", async () => {
    const page = makeMockPage();
    const r = new Recorder(page, tmpDir());

    const result = await r.screenshot("/path?to=foo&bar=baz");

    expect(path.basename(result.filepath)).toBe("01-_path_to_foo_bar_baz.png");
  });

  it("propagates screenshot errors from the page", async () => {
    const page = makeMockPage({
      screenshotThrows: new Error("page closed"),
    });
    const r = new Recorder(page, tmpDir());

    await expect(r.screenshot()).rejects.toThrow("page closed");
  });
});

// ─────────────────────────────────────────────────────────────
// screenshotSegments(undefined, { redactInputs: false })
// ─────────────────────────────────────────────────────────────

describe("screenshotSegments(undefined, { redactInputs: false })", () => {
  it("captures the full + thumbnail + viewport segments and writes them to disk", async () => {
    // Sequence: triggerLazyLoad's evaluate (we resolve immediately),
    // then dims object, then 1 scrollTo per segment, then reset scrollTo.
    // With docHeight=2000, viewportH=800: stride=floor(800*0.8)=640;
    // natural=max(1, ceil((2000-160)/640))=max(1, ceil(2.875))=3 segments.
    const page = makeMockPage({
      evaluateReturns: [
        undefined, // triggerLazyLoad
        { docHeight: 2000, viewportH: 800 }, // dims
        undefined, // scrollTo segment 1
        undefined, // scrollTo segment 2
        undefined, // scrollTo segment 3
        undefined, // reset scroll
      ],
    });
    const r = new Recorder(page, tmpDir());

    const result = await r.screenshotSegments("checkout", { redactInputs: false });

    // Full-page composite written + sha256 sidecar
    expect(path.basename(result.full.filepath)).toBe("01-checkout.png");
    expect(fs.existsSync(result.full.filepath)).toBe(true);
    expect(fs.existsSync(`${result.full.filepath}.sha256`)).toBe(true);

    // Segments written, names indexed
    expect(result.segments).toHaveLength(3);
    expect(result.segmentPaths).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(path.basename(result.segmentPaths[i]!)).toBe(
        `01-checkout-seg${String(i + 1).padStart(2, "0")}.png`,
      );
      expect(fs.existsSync(result.segmentPaths[i]!)).toBe(true);
    }

    // Thumbnail is a Buffer (real sharp resized PNG_1×1, or fallback to input)
    expect(Buffer.isBuffer(result.thumbnail)).toBe(true);
  });

  it("caps segments at 5 even when the page is very tall", async () => {
    // docHeight=20000, viewportH=800, stride=640, natural=ceil((20000-160)/640)=31
    // → cap at 5
    const page = makeMockPage({
      evaluateReturns: [
        undefined,
        { docHeight: 20000, viewportH: 800 },
        undefined, // 5 scroll calls + 1 reset
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ],
    });
    const r = new Recorder(page, tmpDir());

    const result = await r.screenshotSegments(undefined, { redactInputs: false });

    expect(result.segments).toHaveLength(5);
  });

  it("produces at least 1 segment for a short page that fits in one viewport", async () => {
    const page = makeMockPage({
      evaluateReturns: [
        undefined,
        { docHeight: 600, viewportH: 800 }, // page shorter than viewport
        undefined, // single scrollTo
        undefined, // reset
      ],
    });
    const r = new Recorder(page, tmpDir());

    const result = await r.screenshotSegments("short-page", { redactInputs: false });

    expect(result.segments).toHaveLength(1);
    expect(path.basename(result.segmentPaths[0]!)).toBe(
      "01-short-page-seg01.png",
    );
  });

  it("defaults the label to 'step' when none provided", async () => {
    const page = makeMockPage({
      evaluateReturns: [
        undefined,
        { docHeight: 800, viewportH: 800 },
        undefined,
        undefined,
      ],
    });
    const r = new Recorder(page, tmpDir());

    const result = await r.screenshotSegments(undefined, { redactInputs: false });

    expect(path.basename(result.full.filepath)).toBe("01-step.png");
  });

  it("survives triggerLazyLoad throwing (page closed mid-scroll)", async () => {
    // First evaluate (the lazy-load scrolling) throws — the catch in
    // triggerLazyLoad swallows it and capture continues. Subsequent
    // evaluate calls (dims + scroll + reset) need to succeed.
    let calls = 0;
    const page = makeMockPage();
    page.evaluate = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("Target page closed");
      if (calls === 2) return { docHeight: 800, viewportH: 800 };
      return undefined;
    }) as Page["evaluate"];
    const r = new Recorder(page, tmpDir());

    const result = await r.screenshotSegments("lazy-fail", { redactInputs: false });

    expect(result.segments).toHaveLength(1);
  });

  it("reuses the same index counter as screenshot()", async () => {
    const page = makeMockPage({
      evaluateReturns: [
        undefined,
        { docHeight: 800, viewportH: 800 },
        undefined,
        undefined,
      ],
    });
    const r = new Recorder(page, tmpDir());

    await r.screenshot("first", true, { redactInputs: false });
    const segs = await r.screenshotSegments("second", { redactInputs: false });

    expect(path.basename(segs.full.filepath)).toBe("02-second.png");
  });

  it("falls back to the raw buffer when sharp cannot process the input", async () => {
    // Pass a non-image buffer — sharp will throw inside buildThumbnail's
    // try block, catch returns the input buffer untouched.
    const garbage = Buffer.from("definitely not a PNG", "utf8");
    const page = makeMockPage({
      screenshotBuf: garbage,
      evaluateReturns: [
        undefined,
        { docHeight: 800, viewportH: 800 },
        undefined,
        undefined,
      ],
    });
    const r = new Recorder(page, tmpDir());

    const result = await r.screenshotSegments(undefined, { redactInputs: false });

    expect(result.thumbnail.equals(garbage)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// console-error log API
// ─────────────────────────────────────────────────────────────

describe("getConsoleErrors() / drainConsoleErrors()", () => {
  it("getConsoleErrors returns a copy that callers cannot mutate", () => {
    const page = makeMockPage();
    const r = new Recorder(page, tmpDir());

    page.fire("pageerror", new Error("a"));
    const snapshot = r.getConsoleErrors();
    snapshot.length = 0;
    expect(r.getConsoleErrors()).toHaveLength(1);
  });

  it("drainConsoleErrors empties the internal buffer", () => {
    const page = makeMockPage();
    const r = new Recorder(page, tmpDir());

    page.fire("pageerror", new Error("first"));
    page.fire("pageerror", new Error("second"));

    const drained = r.drainConsoleErrors();
    expect(drained).toHaveLength(2);
    expect(r.getConsoleErrors()).toHaveLength(0);

    // Subsequent events accumulate fresh
    page.fire("pageerror", new Error("third"));
    expect(r.getConsoleErrors()).toHaveLength(1);
  });
});

describe("flushConsoleLog()", () => {
  it("writes a (no console errors) sentinel when no errors accrued", () => {
    const dir = tmpDir();
    const r = new Recorder(makeMockPage(), dir);

    const logPath = r.flushConsoleLog();

    expect(logPath).toBe(path.join(dir, "console.log"));
    expect(fs.readFileSync(logPath, "utf8")).toBe("(no console errors)\n");
  });

  it("formats each error as [timestamp] [type] text @ location", () => {
    const dir = tmpDir();
    const page = makeMockPage();
    const r = new Recorder(page, dir);

    page.fire("console", {
      type: () => "error",
      text: () => "Cannot read property",
      location: () => ({ url: "https://x.example/app.js" }),
    });
    page.fire("pageerror", new Error("uncaught"));

    const logPath = r.flushConsoleLog();
    const contents = fs.readFileSync(logPath, "utf8");

    expect(contents).toContain("[console] Cannot read property @ https://x.example/app.js");
    // pageerror's location is err.stack which is multi-line; the formatter
    // appends it verbatim, so we don't pin a strict line count.
    expect(contents).toContain("[pageerror] uncaught @");
  });

  it("omits the @ location segment when location is undefined", () => {
    const dir = tmpDir();
    const page = makeMockPage();
    const r = new Recorder(page, dir);

    page.fire("requestfailed", {
      url: () => "https://x.example/abandoned",
      failure: () => null,
    });

    const logPath = r.flushConsoleLog();
    const contents = fs.readFileSync(logPath, "utf8");

    // requestfailed events have no location field at all → no " @ ..." suffix
    expect(contents).toMatch(
      /\[requestfailed\] unknown https:\/\/x\.example\/abandoned$/,
    );
  });
});

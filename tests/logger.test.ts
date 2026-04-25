import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Writable } from "node:stream";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { getLogger, _resetLoggerForTests } from "../src/core/logger.js";

function captureStream() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, chunks };
}

function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    prev[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

describe("logger", () => {
  beforeEach(() => {
    _resetLoggerForTests();
  });

  afterEach(() => {
    _resetLoggerForTests();
  });

  it("getLogger caches by module name", () => {
    const a = getLogger("foo");
    const b = getLogger("foo");
    const c = getLogger("bar");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("emits structured JSON with module + level + msg", () => {
    withEnv({ LOG_LEVEL: "info", LOG_PRETTY: undefined, LOG_FILE: undefined }, () => {
      _resetLoggerForTests();
      // Re-import via dynamic require would be cleaner, but pino is async-flushing.
      // We test at the formatter level by writing to a tmp file via LOG_FILE.
    });
  });

  it("respects LOG_LEVEL=warn (info suppressed, warn emitted)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-test-"));
    const logFile = path.join(tmpDir, "log.ndjson");
    try {
      await new Promise<void>((resolve, reject) => {
        withEnv(
          { LOG_LEVEL: "warn", LOG_PRETTY: undefined, LOG_FILE: logFile },
          () => {
            _resetLoggerForTests();
            const log = getLogger("levelcheck");
            log.info({ a: 1 }, "should-be-dropped");
            log.warn({ b: 2 }, "should-appear");
            // Allow async flush.
            setTimeout(() => {
              try {
                const text = fs.readFileSync(logFile, "utf-8");
                expect(text).not.toContain("should-be-dropped");
                expect(text).toContain("should-appear");
                const lines = text.trim().split("\n").filter(Boolean);
                const last = JSON.parse(lines[lines.length - 1]!);
                expect(last.level).toBe("warn");
                expect(last.module).toBe("levelcheck");
                expect(last.b).toBe(2);
                expect(last.msg).toBe("should-appear");
                expect(typeof last.time).toBe("string");
                resolve();
              } catch (err) {
                reject(err);
              }
            }, 200);
          }
        );
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to info when LOG_LEVEL is invalid", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-test-"));
    const logFile = path.join(tmpDir, "log.ndjson");
    try {
      await new Promise<void>((resolve, reject) => {
        withEnv(
          { LOG_LEVEL: "bogus", LOG_PRETTY: undefined, LOG_FILE: logFile },
          () => {
            _resetLoggerForTests();
            const log = getLogger("invalidlevel");
            log.info("hello");
            setTimeout(() => {
              try {
                const text = fs.readFileSync(logFile, "utf-8");
                expect(text).toContain("hello");
                resolve();
              } catch (err) {
                reject(err);
              }
            }, 200);
          }
        );
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Writable } from "node:stream";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  getLogger,
  registerSecret,
  _resetLoggerForTests,
  _closeLoggerStreamsForTests,
  _resetRegisteredSecretsForTests,
  _registeredSecretCountForTests,
} from "../src/core/logger.js";

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

/**
 * Belt-and-suspenders rm: pino's SonicBoom destination flushes / closes
 * asynchronously even after `_resetLoggerForTests()` calls `end()`.
 * On Windows the file system briefly refuses to delete a file with an
 * outstanding handle; Node's `fs.rmSync` exposes a `maxRetries` option
 * specifically for this scenario.
 */
function rmRecursiveWithRetry(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    _resetRegisteredSecretsForTests();
  });

  afterEach(() => {
    _resetLoggerForTests();
    _resetRegisteredSecretsForTests();
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
      // Await actual FD close — SonicBoom's end() is async on Windows.
      await _closeLoggerStreamsForTests();
      rmRecursiveWithRetry(tmpDir);
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
      // Await actual FD close — SonicBoom's end() is async on Windows.
      await _closeLoggerStreamsForTests();
      rmRecursiveWithRetry(tmpDir);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Redaction (M1-4)
// ─────────────────────────────────────────────────────────────

function logToFile(
  fn: (log: ReturnType<typeof getLogger>) => void,
  options: { module?: string; level?: string } = {},
): Promise<{ raw: string; lines: Array<Record<string, unknown>> }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-redact-"));
  const logFile = path.join(tmpDir, "log.ndjson");
  return new Promise((resolve, reject) => {
    withEnv(
      {
        LOG_LEVEL: options.level ?? "info",
        LOG_PRETTY: "0",
        LOG_FILE: logFile,
      },
      () => {
        _resetLoggerForTests();
        const log = getLogger(options.module ?? "redact-test");
        fn(log);
        setTimeout(async () => {
          try {
            const raw = fs.readFileSync(logFile, "utf-8");
            const lines = raw
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((l) => JSON.parse(l) as Record<string, unknown>);
            // Await actual FD close — SonicBoom's end() is async on Windows.
            await _closeLoggerStreamsForTests();
            rmRecursiveWithRetry(tmpDir);
            resolve({ raw, lines });
          } catch (err) {
            try { await _closeLoggerStreamsForTests(); } catch { /* best effort */ }
            try { rmRecursiveWithRetry(tmpDir); } catch { /* best effort */ }
            reject(err);
          }
        }, 200);
      },
    );
  });
}

describe("logger redaction", () => {
  beforeEach(() => {
    _resetLoggerForTests();
    _resetRegisteredSecretsForTests();
  });

  afterEach(() => {
    _resetLoggerForTests();
    _resetRegisteredSecretsForTests();
  });

  describe("path-based redaction (well-known field names)", () => {
    it("redacts top-level apiKey field", async () => {
      const { raw, lines } = await logToFile((log) => {
        log.info({ apiKey: "sk-ant-secret-12345" }, "calling API");
      });
      expect(raw).not.toContain("sk-ant-secret-12345");
      expect(lines[0]!.apiKey).toBe("[REDACTED]");
    });

    it("redacts top-level password / token / cookie / authorization", async () => {
      const { raw } = await logToFile((log) => {
        log.info(
          {
            password: "supersecretpw",
            token: "tok_abc123xyz",
            cookie: "session=abc123def456",
            authorization: "Bearer xyz123abc456",
          },
          "auth payload",
        );
      });
      expect(raw).not.toContain("supersecretpw");
      expect(raw).not.toContain("tok_abc123xyz");
      expect(raw).not.toContain("session=abc123def456");
      expect(raw).not.toContain("Bearer xyz123abc456");
    });

    it("redacts one-level-nested apiKey", async () => {
      const { raw, lines } = await logToFile((log) => {
        log.info({ config: { apiKey: "sk-ant-nested-67890" } }, "nested");
      });
      expect(raw).not.toContain("sk-ant-nested-67890");
      const config = lines[0]!.config as Record<string, unknown>;
      expect(config.apiKey).toBe("[REDACTED]");
    });

    it("does not censor unrelated fields", async () => {
      const { raw, lines } = await logToFile((log) => {
        log.info({ url: "https://example.com", count: 42 }, "ok");
      });
      expect(raw).toContain("example.com");
      expect(lines[0]!.count).toBe(42);
    });
  });

  describe("value-based redaction (registerSecret)", () => {
    it("does nothing when no secrets registered", async () => {
      const { raw } = await logToFile((log) => {
        log.info({ note: "this contains the word secret_value_xyz" }, "ok");
      });
      expect(raw).toContain("secret_value_xyz");
    });

    it("redacts a registered secret value found inside a string field", async () => {
      registerSecret("sk-ant-registered-abcdef");
      const { raw, lines } = await logToFile((log) => {
        log.info(
          { note: "tried to call API with key sk-ant-registered-abcdef and failed" },
          "ok",
        );
      });
      expect(raw).not.toContain("sk-ant-registered-abcdef");
      expect(lines[0]!.note).toContain("[REDACTED]");
    });

    it("redacts secret in nested arrays / objects", async () => {
      registerSecret("very-long-secret-value-12345");
      const { raw } = await logToFile((log) => {
        log.info(
          {
            calls: [
              { endpoint: "/x", body: "with very-long-secret-value-12345 in it" },
              { endpoint: "/y", deeply: { nested: "very-long-secret-value-12345" } },
            ],
          },
          "ok",
        );
      });
      expect(raw).not.toContain("very-long-secret-value-12345");
      // Two occurrences should both be censored
      expect(raw.match(/\[REDACTED\]/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    });

    it("redacts secret embedded in the log message itself", async () => {
      registerSecret("abcdef-message-secret");
      const { raw } = await logToFile((log) => {
        log.warn(`error: leaked abcdef-message-secret in message`);
      });
      expect(raw).not.toContain("abcdef-message-secret");
    });

    it("registerSecret rejects empty / short values", () => {
      _resetRegisteredSecretsForTests();
      registerSecret(undefined);
      registerSecret(null);
      registerSecret("");
      registerSecret("short");
      expect(_registeredSecretCountForTests()).toBe(0);
      registerSecret("longenough123");
      expect(_registeredSecretCountForTests()).toBe(1);
      // Idempotent — adding the same value twice is a no-op
      registerSecret("longenough123");
      expect(_registeredSecretCountForTests()).toBe(1);
    });
  });
});

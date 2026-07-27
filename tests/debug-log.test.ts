import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  DebugLogger,
  createDebugLogger,
  isDebugLogEnabled,
  readDebugLog,
  filterDebugLog,
  type DebugEntry,
} from "../src/core/debug-log.js";

describe("DebugLogger", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-log-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("lifecycle", () => {
    it("opens and creates the log file", () => {
      const logger = new DebugLogger(tmpDir, "run-1");
      logger.open();
      expect(logger.isOpen()).toBe(true);
      expect(fs.existsSync(logger.getPath())).toBe(true);
      logger.close();
    });

    it("writes lifecycle open event on open", () => {
      const logger = new DebugLogger(tmpDir, "run-1");
      logger.open();
      logger.close();

      const entries = readDebugLog(logger.getPath());
      const openEvent = entries.find((e) => e.event === "debug_log_opened");
      expect(openEvent).toBeDefined();
      expect(openEvent!.data.runId).toBe("run-1");
      expect(openEvent!.category).toBe("lifecycle");
    });

    it("writes lifecycle close event on close", () => {
      const logger = new DebugLogger(tmpDir, "run-1");
      logger.open();
      logger.close();

      const entries = readDebugLog(logger.getPath());
      const closeEvent = entries.find((e) => e.event === "debug_log_closed");
      expect(closeEvent).toBeDefined();
    });

    it("close is idempotent", () => {
      const logger = new DebugLogger(tmpDir, "run-1");
      logger.open();
      logger.close();
      logger.close(); // should not throw
      expect(logger.isOpen()).toBe(false);
    });

    it("isOpen returns false before open", () => {
      const logger = new DebugLogger(tmpDir, "run-1");
      expect(logger.isOpen()).toBe(false);
    });
  });

  describe("writing entries", () => {
    it("writes NDJSON entries", () => {
      const logger = new DebugLogger(tmpDir, "run-1");
      logger.open();
      logger.write("llm", "request", { model: "claude-3" });
      logger.write("browser", "navigate", { url: "https://example.com" });
      logger.close();

      const entries = readDebugLog(logger.getPath());
      // 2 entries + open + close = 4
      expect(entries).toHaveLength(4);
    });

    it("tracks entry count", () => {
      const logger = new DebugLogger(tmpDir, "run-1");
      logger.open();
      logger.write("step", "start", {});
      logger.write("step", "end", {});
      logger.write("step", "start", {});
      // 3 user writes + 1 open = 4
      expect(logger.getEntryCount()).toBe(4);
      logger.close();
    });

    it("no-op when not open", () => {
      const logger = new DebugLogger(tmpDir, "run-1");
      // Not opened — should not throw or create file
      logger.write("llm", "test", {});
      expect(fs.existsSync(logger.getPath())).toBe(false);
    });

    it("no-op after close", () => {
      const logger = new DebugLogger(tmpDir, "run-1");
      logger.open();
      logger.close();
      const countAfterClose = logger.getEntryCount();
      logger.write("llm", "should_not_appear", {});
      expect(logger.getEntryCount()).toBe(countAfterClose);
    });

    it("entries have ISO timestamp", () => {
      const logger = new DebugLogger(tmpDir, "run-1");
      logger.open();
      logger.write("config", "loaded", { key: "value" });
      logger.close();

      const entries = readDebugLog(logger.getPath());
      for (const entry of entries) {
        expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    });
  });

  describe("typed helpers", () => {
    it("llm() writes to llm category", () => {
      const logger = new DebugLogger(tmpDir, "run-1");
      logger.open();
      logger.llm("request", { model: "claude-3", promptTokens: 100, costUsd: 0.01 });
      logger.close();

      const entries = filterDebugLog(readDebugLog(logger.getPath()), "llm");
      expect(entries).toHaveLength(1);
      expect(entries[0].data.model).toBe("claude-3");
      expect(entries[0].data.costUsd).toBe(0.01);
    });

    it("browser() writes to browser category", () => {
      const logger = new DebugLogger(tmpDir, "run-1");
      logger.open();
      logger.browser("navigate", { url: "https://example.com", durationMs: 500 });
      logger.close();

      const entries = filterDebugLog(readDebugLog(logger.getPath()), "browser");
      expect(entries).toHaveLength(1);
      expect(entries[0].data.url).toBe("https://example.com");
    });

    it("step() writes to step category", () => {
      const logger = new DebugLogger(tmpDir, "run-1");
      logger.open();
      logger.step("complete", { stepIndex: 2, status: "pass", durationMs: 1200 });
      logger.close();

      const entries = filterDebugLog(readDebugLog(logger.getPath()), "step");
      expect(entries).toHaveLength(1);
      expect(entries[0].data.stepIndex).toBe(2);
    });

    it("error() captures stack trace", () => {
      const logger = new DebugLogger(tmpDir, "run-1");
      logger.open();
      const err = new Error("something broke");
      logger.error("uncaught", err, { stepIndex: 5 });
      logger.close();

      const entries = filterDebugLog(readDebugLog(logger.getPath()), "error");
      expect(entries).toHaveLength(1);
      expect(entries[0].data.message).toBe("something broke");
      expect(entries[0].data.stack).toContain("something broke");
      expect(entries[0].data.stepIndex).toBe(5);
    });
  });

  describe("isDebugLogEnabled", () => {
    const originalEnv = process.env.PIXELCHECK_DEBUG_LOG;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.PIXELCHECK_DEBUG_LOG;
      } else {
        process.env.PIXELCHECK_DEBUG_LOG = originalEnv;
      }
      delete process.env.AUDIT_DEBUG_LOG;
    });

    it("returns false by default", () => {
      delete process.env.PIXELCHECK_DEBUG_LOG;
      delete process.env.AUDIT_DEBUG_LOG;
      expect(isDebugLogEnabled()).toBe(false);
    });

    it("returns true when PIXELCHECK_DEBUG_LOG=1", () => {
      process.env.PIXELCHECK_DEBUG_LOG = "1";
      expect(isDebugLogEnabled()).toBe(true);
    });

    it("returns true when PIXELCHECK_DEBUG_LOG=true", () => {
      process.env.PIXELCHECK_DEBUG_LOG = "true";
      expect(isDebugLogEnabled()).toBe(true);
    });

    it("returns true for legacy AUDIT_DEBUG_LOG=1", () => {
      delete process.env.PIXELCHECK_DEBUG_LOG;
      process.env.AUDIT_DEBUG_LOG = "1";
      expect(isDebugLogEnabled()).toBe(true);
    });
  });

  describe("createDebugLogger", () => {
    const originalEnv = process.env.PIXELCHECK_DEBUG_LOG;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.PIXELCHECK_DEBUG_LOG;
      } else {
        process.env.PIXELCHECK_DEBUG_LOG = originalEnv;
      }
    });

    it("returns open logger when enabled", () => {
      process.env.PIXELCHECK_DEBUG_LOG = "1";
      const logger = createDebugLogger(tmpDir, "run-1");
      expect(logger.isOpen()).toBe(true);
      logger.close();
    });

    it("returns non-open logger when disabled", () => {
      delete process.env.PIXELCHECK_DEBUG_LOG;
      const logger = createDebugLogger(tmpDir, "run-1");
      expect(logger.isOpen()).toBe(false);
    });
  });

  describe("readDebugLog", () => {
    it("returns empty array for nonexistent file", () => {
      expect(readDebugLog("/nonexistent/path")).toEqual([]);
    });

    it("skips malformed lines", () => {
      const logPath = path.join(tmpDir, "malformed.log");
      fs.writeFileSync(logPath, '{"timestamp":"2026-01-01","category":"llm","event":"ok","data":{}}\nnot json\n{"timestamp":"2026-01-01","category":"step","event":"done","data":{}}\n');
      const entries = readDebugLog(logPath);
      expect(entries).toHaveLength(2);
      expect(entries[0].category).toBe("llm");
      expect(entries[1].category).toBe("step");
    });
  });

  describe("filterDebugLog", () => {
    it("filters by category", () => {
      const entries: DebugEntry[] = [
        { timestamp: "2026-01-01", category: "llm", event: "req", data: {} },
        { timestamp: "2026-01-01", category: "browser", event: "nav", data: {} },
        { timestamp: "2026-01-01", category: "llm", event: "res", data: {} },
      ];
      const llm = filterDebugLog(entries, "llm");
      expect(llm).toHaveLength(2);
      const browser = filterDebugLog(entries, "browser");
      expect(browser).toHaveLength(1);
    });
  });

  describe("directory creation", () => {
    it("creates nested output directory", () => {
      const nestedDir = path.join(tmpDir, "a", "b", "c");
      const logger = new DebugLogger(nestedDir, "run-nested");
      logger.open();
      expect(fs.existsSync(nestedDir)).toBe(true);
      logger.close();
    });
  });
});

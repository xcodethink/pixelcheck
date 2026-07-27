import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerPlugin,
  unregisterPlugin,
  getPlugins,
  clearPlugins,
  runBeforeAudit,
  runAfterAudit,
  runBeforeStep,
  runAfterStep,
  runOnIssue,
  runOnError,
  runTransform,
  type PixelCheckPlugin,
  type PluginContext,
} from "../src/core/plugin.js";
import type { AuditRun, StepResult, Issue } from "../src/core/types.js";

function makeCtx(overrides?: Partial<PluginContext>): PluginContext {
  return {
    runId: "test-run-1",
    outputRoot: "/tmp/test-output",
    ...overrides,
  };
}

function makePlugin(name: string, hooks?: Partial<PixelCheckPlugin>): PixelCheckPlugin {
  return { name, ...hooks };
}

describe("Plugin system", () => {
  beforeEach(() => {
    clearPlugins();
  });

  describe("registration", () => {
    it("registers a plugin", () => {
      registerPlugin(makePlugin("test-plugin"));
      expect(getPlugins()).toHaveLength(1);
      expect(getPlugins()[0].name).toBe("test-plugin");
    });

    it("rejects duplicate plugin names", () => {
      registerPlugin(makePlugin("dup"));
      expect(() => registerPlugin(makePlugin("dup"))).toThrow(
        'Plugin "dup" is already registered',
      );
    });

    it("rejects plugin without name", () => {
      expect(() => registerPlugin({ name: "" })).toThrow("Plugin must have a name");
    });

    it("unregisters a plugin by name", () => {
      registerPlugin(makePlugin("removable"));
      expect(unregisterPlugin("removable")).toBe(true);
      expect(getPlugins()).toHaveLength(0);
    });

    it("returns false for unknown plugin name", () => {
      expect(unregisterPlugin("nonexistent")).toBe(false);
    });

    it("clearPlugins removes all", () => {
      registerPlugin(makePlugin("a"));
      registerPlugin(makePlugin("b"));
      clearPlugins();
      expect(getPlugins()).toHaveLength(0);
    });

    it("getPlugins returns a snapshot (not mutable reference)", () => {
      registerPlugin(makePlugin("snap"));
      const snap = getPlugins();
      clearPlugins();
      expect(snap).toHaveLength(1); // snapshot unchanged
      expect(getPlugins()).toHaveLength(0); // actual registry cleared
    });
  });

  describe("beforeAudit / afterAudit hooks", () => {
    it("calls beforeAudit on all plugins in order", async () => {
      const order: string[] = [];
      registerPlugin(
        makePlugin("first", {
          beforeAudit: () => { order.push("first"); },
        }),
      );
      registerPlugin(
        makePlugin("second", {
          beforeAudit: () => { order.push("second"); },
        }),
      );
      await runBeforeAudit(makeCtx());
      expect(order).toEqual(["first", "second"]);
    });

    it("calls afterAudit with result", async () => {
      const received: AuditRun[] = [];
      registerPlugin(
        makePlugin("collector", {
          afterAudit: (_ctx, result) => { received.push(result); },
        }),
      );
      const fakeResult = { id: "run-1", scenarios: [] } as unknown as AuditRun;
      await runAfterAudit(makeCtx(), fakeResult);
      expect(received).toHaveLength(1);
      expect(received[0].id).toBe("run-1");
    });
  });

  describe("step-level hooks", () => {
    it("calls beforeStep and afterStep", async () => {
      const events: string[] = [];
      registerPlugin(
        makePlugin("step-watcher", {
          beforeStep: (_ctx, idx) => { events.push(`before:${idx}`); },
          afterStep: (_ctx, idx, _r) => { events.push(`after:${idx}`); },
        }),
      );
      const fakeStep = { status: "pass" } as unknown as StepResult;
      await runBeforeStep(makeCtx(), 0);
      await runAfterStep(makeCtx(), 0, fakeStep);
      expect(events).toEqual(["before:0", "after:0"]);
    });
  });

  describe("onIssue hook", () => {
    it("receives issue data", async () => {
      const issues: Issue[] = [];
      registerPlugin(
        makePlugin("issue-collector", {
          onIssue: (_ctx, issue) => { issues.push(issue); },
        }),
      );
      const fakeIssue = {
        id: "issue-1",
        severity: "high",
        dimension: "accessibility",
        title: "Missing alt text",
        description: "Image lacks alt attribute",
      } as unknown as Issue;
      await runOnIssue(makeCtx(), fakeIssue);
      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe("issue-1");
    });
  });

  describe("onError hook", () => {
    it("receives error", async () => {
      const errors: Error[] = [];
      registerPlugin(
        makePlugin("error-logger", {
          onError: (_ctx, err) => { errors.push(err); },
        }),
      );
      await runOnError(makeCtx(), new Error("test error"));
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe("test error");
    });
  });

  describe("transform hook", () => {
    it("pipelines result through plugins in order", async () => {
      registerPlugin(
        makePlugin("add-tag", {
          transform: (result) => ({
            ...result,
            tag: "tagged",
          }),
        }),
      );
      registerPlugin(
        makePlugin("add-version", {
          transform: (result) => ({
            ...result,
            version: "1.0",
          }),
        }),
      );
      const input = { id: "run-1" } as unknown as AuditRun;
      const output = await runTransform(input);
      expect((output as any).tag).toBe("tagged");
      expect((output as any).version).toBe("1.0");
    });

    it("skips broken transform but continues pipeline", async () => {
      registerPlugin(
        makePlugin("broken", {
          transform: () => { throw new Error("boom"); },
        }),
      );
      registerPlugin(
        makePlugin("good", {
          transform: (result) => ({ ...result, ok: true }),
        }),
      );
      const input = { id: "run-1" } as unknown as AuditRun;
      const output = await runTransform(input);
      expect((output as any).ok).toBe(true);
    });
  });

  describe("error isolation", () => {
    it("one plugin error does not block others", async () => {
      const called: string[] = [];
      registerPlugin(
        makePlugin("thrower", {
          beforeAudit: () => { throw new Error("plugin crash"); },
        }),
      );
      registerPlugin(
        makePlugin("survivor", {
          beforeAudit: () => { called.push("survived"); },
        }),
      );
      await runBeforeAudit(makeCtx());
      expect(called).toEqual(["survived"]);
    });
  });

  describe("async hooks", () => {
    it("awaits async plugin hooks", async () => {
      let resolved = false;
      registerPlugin(
        makePlugin("async-plugin", {
          beforeAudit: async () => {
            await new Promise((r) => setTimeout(r, 10));
            resolved = true;
          },
        }),
      );
      await runBeforeAudit(makeCtx());
      expect(resolved).toBe(true);
    });
  });

  describe("plugins without hooks", () => {
    it("no-op plugins are harmless", async () => {
      registerPlugin(makePlugin("empty-plugin"));
      // Should not throw
      await runBeforeAudit(makeCtx());
      await runAfterAudit(makeCtx(), {} as AuditRun);
      await runTransform({} as AuditRun);
    });
  });
});

/**
 * Tests for src/core/throttle.ts — per-origin task serialization.
 * Pure logic, no I/O.
 */

import { describe, it, expect } from "vitest";
import { OriginThrottle, originOf } from "../src/core/throttle.js";

describe("originOf", () => {
  it("extracts origin from a full URL", () => {
    expect(originOf("https://example.com/path?q=1")).toBe("https://example.com");
  });

  it("preserves port when non-default", () => {
    expect(originOf("http://localhost:3000/a")).toBe("http://localhost:3000");
  });

  it("returns 'default' for an unparseable URL", () => {
    expect(originOf("not a url")).toBe("default");
  });

  it("returns 'default' for empty string", () => {
    expect(originOf("")).toBe("default");
  });
});

describe("OriginThrottle", () => {
  it("runs a single task and returns its value", async () => {
    const t = new OriginThrottle();
    const out = await t.run("https://a", async () => 42);
    expect(out).toBe(42);
  });

  it("serializes tasks within the same origin", async () => {
    const t = new OriginThrottle();
    const order: string[] = [];

    const a = t.run("https://x", async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
      return "a";
    });
    // Submit b synchronously after a — it must wait for a.
    const b = t.run("https://x", async () => {
      order.push("b-start");
      return "b";
    });

    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  it("runs different origins in parallel", async () => {
    const t = new OriginThrottle();
    const order: string[] = [];

    const a = t.run("https://x", async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
      return "a";
    });
    const b = t.run("https://y", async () => {
      order.push("b-start");
      return "b";
    });

    await Promise.all([a, b]);
    // b for origin y should start before a finishes for origin x
    const aStart = order.indexOf("a-start");
    const bStart = order.indexOf("b-start");
    const aEnd = order.indexOf("a-end");
    expect(aStart).toBeLessThan(bStart);
    expect(bStart).toBeLessThan(aEnd);
  });

  it("propagates the task's rejection to its caller", async () => {
    const t = new OriginThrottle();
    await expect(
      t.run("https://x", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("does not block subsequent tasks on the same origin after a failure", async () => {
    const t = new OriginThrottle();
    await expect(
      t.run("https://x", async () => {
        throw new Error("first fails");
      }),
    ).rejects.toThrow("first fails");
    const out = await t.run("https://x", async () => "second-ok");
    expect(out).toBe("second-ok");
  });

  it("queues many tasks in submission order on the same origin", async () => {
    const t = new OriginThrottle();
    const seen: number[] = [];
    const promises = [1, 2, 3, 4, 5].map((n) =>
      t.run("https://x", async () => {
        seen.push(n);
        return n;
      }),
    );
    const results = await Promise.all(promises);
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it("isolates failures so one origin's reject doesn't block another", async () => {
    const t = new OriginThrottle();
    const failing = t.run("https://fail", async () => {
      throw new Error("fail-x");
    });
    const ok = t.run("https://ok", async () => "ok-y");
    await expect(failing).rejects.toThrow("fail-x");
    expect(await ok).toBe("ok-y");
  });
});

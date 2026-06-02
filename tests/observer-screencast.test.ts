import { describe, it, expect, vi } from "vitest";
import type { Page } from "playwright";
import { startScreencast } from "../src/observer/screencast.js";

/** Minimal fake CDP session: records sends, lets tests fire frame events. */
function makeFakeCdp() {
  const handlers: Record<string, (params: unknown) => void> = {};
  const send = vi.fn(async (_method: string, _params?: unknown) => {});
  const detach = vi.fn(async () => {});
  return {
    on: (evt: string, cb: (p: unknown) => void) => {
      handlers[evt] = cb;
    },
    send,
    detach,
    emitFrame: (params: unknown) => handlers["Page.screencastFrame"]?.(params),
  };
}

function makePage(cdp: ReturnType<typeof makeFakeCdp> | null): Page {
  return {
    context: () => ({
      newCDPSession: vi.fn(async () => {
        if (!cdp) throw new Error("CDP not available in this context");
        return cdp;
      }),
    }),
  } as unknown as Page;
}

describe("observer screencast (G3 follow-up)", () => {
  it("starts the CDP screencast with documented defaults", async () => {
    const cdp = makeFakeCdp();
    await startScreencast(makePage(cdp), () => {});
    const startCall = cdp.send.mock.calls.find((c) => c[0] === "Page.startScreencast");
    expect(startCall).toBeDefined();
    expect(startCall![1]).toEqual({
      format: "jpeg",
      quality: 50,
      maxWidth: 800,
      maxHeight: 600,
      everyNthFrame: 3,
    });
  });

  it("honors custom options", async () => {
    const cdp = makeFakeCdp();
    await startScreencast(makePage(cdp), () => {}, {
      format: "png",
      quality: 80,
      maxWidth: 1280,
      maxHeight: 720,
      everyNthFrame: 1,
    });
    const startCall = cdp.send.mock.calls.find((c) => c[0] === "Page.startScreencast");
    expect(startCall![1]).toEqual({
      format: "png",
      quality: 80,
      maxWidth: 1280,
      maxHeight: 720,
      everyNthFrame: 1,
    });
  });

  it("forwards each frame to onFrame and acks it", async () => {
    const cdp = makeFakeCdp();
    const frames: Array<{ data: string; ts: number }> = [];
    await startScreencast(makePage(cdp), (data, meta) => frames.push({ data, ts: meta.timestamp }));

    cdp.emitFrame({ data: "BASE64DATA", metadata: { timestamp: 1234 }, sessionId: "sess-1" });

    expect(frames).toEqual([{ data: "BASE64DATA", ts: 1234 }]);
    const ack = cdp.send.mock.calls.find((c) => c[0] === "Page.screencastFrameAck");
    expect(ack).toBeDefined();
    expect(ack![1]).toEqual({ sessionId: "sess-1" });
  });

  it("falls back to a timestamp when the frame metadata omits one", async () => {
    const cdp = makeFakeCdp();
    let ts: number | undefined;
    await startScreencast(makePage(cdp), (_d, meta) => {
      ts = meta.timestamp;
    });
    cdp.emitFrame({ data: "x", metadata: {}, sessionId: "s" });
    expect(typeof ts).toBe("number");
  });

  it("stop() stops the screencast and detaches the CDP session", async () => {
    const cdp = makeFakeCdp();
    const handle = await startScreencast(makePage(cdp), () => {});
    await handle.stop();
    expect(cdp.send.mock.calls.some((c) => c[0] === "Page.stopScreencast")).toBe(true);
    expect(cdp.detach).toHaveBeenCalledOnce();
  });

  it("degrades to a no-op when CDP is unavailable (no throw, no frames)", async () => {
    const onFrame = vi.fn();
    const handle = await startScreencast(makePage(null), onFrame);
    // Returns a usable handle whose stop() is safe to call.
    await expect(handle.stop()).resolves.toBeUndefined();
    expect(onFrame).not.toHaveBeenCalled();
  });
});

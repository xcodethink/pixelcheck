import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

/**
 * `close()` must not resolve until the file descriptor is released.
 *
 * The distinction is invisible on POSIX — a file can be unlinked while a
 * descriptor is open — so an implementation that resolves as soon as the data
 * is flushed looks correct everywhere it is developed. On Windows it is not:
 * a caller that awaited close() and then removed the directory got
 * "ENOTEMPTY: directory not empty", which is how CI surfaced it.
 *
 * A test that merely removes a temp directory after close() would therefore
 * pass on every platform the maintainers use and only fail on CI. This asserts
 * the property itself: a WriteStream emits "finish" (data handed to the OS)
 * before "close" (descriptor released), and close() must wait for the second.
 * Deterministic on any platform, and it fails if the implementation goes back
 * to resolving from the end() callback.
 *
 * `vi.mock` rather than `vi.spyOn`: an ESM module namespace is not
 * configurable, so spying on `fs.createWriteStream` throws outright.
 */

/** A WriteStream stand-in that separates "finish" from "close" by a tick. */
class FakeWriteStream extends EventEmitter {
  closed = false;
  write(): boolean {
    return true;
  }
  end(cb?: () => void): void {
    // Real streams call the end() callback on "finish" while the descriptor
    // stays open until "close" lands afterwards. Reproduce that ordering.
    setImmediate(() => {
      this.emit("finish");
      cb?.();
      setImmediate(() => {
        this.closed = true;
        this.emit("close");
      });
    });
  }
}

const fakes: FakeWriteStream[] = [];

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: () => undefined,
    createWriteStream: () => {
      const s = new FakeWriteStream();
      fakes.push(s);
      return s;
    },
  };
});

const { SessionStore } = await import("../src/observer/session-store.js");

describe("SessionStore.close", () => {
  it("resolves only after the descriptor is released, not merely flushed", async () => {
    fakes.length = 0;
    const store = new SessionStore("test", "/tmp/irrelevant");
    expect(fakes).toHaveLength(1);

    await store.close();

    // Resolving from the end() callback would leave this false: "finish" has
    // fired, but the descriptor is still open — and on Windows the directory
    // would refuse to be removed.
    expect(fakes[0]!.closed).toBe(true);
  });

  it("resolves immediately when there is no stream to close", async () => {
    const store = new SessionStore("test");
    await expect(store.close()).resolves.toBeUndefined();
  });

  it("is safe to call twice", async () => {
    fakes.length = 0;
    const store = new SessionStore("test", "/tmp/irrelevant");
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });
});

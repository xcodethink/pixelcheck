/**
 * Tests for src/core/email.ts — mail.tm temp-inbox client.
 * Mocks global fetch + uses vi.useFakeTimers for the polling waitForMessage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createTempInbox,
  listMessages,
  getMessage,
  waitForMessage,
  type TempInbox,
} from "../src/core/email.js";

const realFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const inbox: TempInbox = {
  address: "x@y.example",
  password: "p",
  token: "T",
  accountId: "id-1",
};

describe("createTempInbox", () => {
  it("creates an account using the first domain in the response and returns the auth token", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse([{ domain: "test1.example" }, { domain: "test2.example" }]),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "acct-99", address: "ignored" }))
      .mockResolvedValueOnce(jsonResponse({ token: "tok-xyz", id: "acct-99" }));

    const result = await createTempInbox();
    expect(result.token).toBe("tok-xyz");
    expect(result.accountId).toBe("acct-99");
    expect(result.address).toMatch(/^audit_\d+_[a-z0-9]+@test1\.example$/);
    expect(result.password.length).toBeGreaterThan(8);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/domains$/);
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/accounts$/);
    expect(fetchMock.mock.calls[2][0]).toMatch(/\/token$/);
  });

  it("handles the Hydra-collection response shape ({ 'hydra:member': [...] })", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ "hydra:member": [{ domain: "h.example" }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "a", address: "x" }))
      .mockResolvedValueOnce(jsonResponse({ token: "t", id: "a" }));
    const result = await createTempInbox();
    expect(result.address).toMatch(/@h\.example$/);
  });

  it("handles the JSON-LD 'member' shape ({ member: [...] })", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ member: [{ domain: "m.example" }] }))
      .mockResolvedValueOnce(jsonResponse({ id: "a", address: "x" }))
      .mockResolvedValueOnce(jsonResponse({ token: "t", id: "a" }));
    const result = await createTempInbox();
    expect(result.address).toMatch(/@m\.example$/);
  });

  it("throws when /domains returns an empty list", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await expect(createTempInbox()).rejects.toThrow(/no domains in response/);
  });

  it("throws when first domain entry has no .domain field", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse([{}]));
    await expect(createTempInbox()).rejects.toThrow(/has no .domain field/);
  });

  it("propagates HTTP errors from /domains", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "internal" }, 500));
    await expect(createTempInbox()).rejects.toThrow(
      /mail\.tm GET \/domains failed: 500/,
    );
  });
});

describe("listMessages", () => {
  it("returns messages from the plain-array response shape", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const msgs = [{ id: "m1" }, { id: "m2" }];
    fetchMock.mockResolvedValueOnce(jsonResponse(msgs));
    const result = await listMessages(inbox);
    expect(result.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("returns messages from the hydra:member response shape", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ "hydra:member": [{ id: "h1" }] }),
    );
    expect((await listMessages(inbox))[0].id).toBe("h1");
  });

  it("returns messages from the member response shape", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ member: [{ id: "x" }] }));
    expect((await listMessages(inbox))[0].id).toBe("x");
  });

  it("returns [] when response has neither shape", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ unrelated: 1 }));
    expect(await listMessages(inbox)).toEqual([]);
  });

  it("forwards Bearer auth header", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await listMessages(inbox);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      `Bearer ${inbox.token}`,
    );
  });
});

describe("getMessage", () => {
  it("fetches /messages/:id with the inbox token", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "m1",
        from: { address: "a@b" },
        subject: "S",
        intro: "i",
        receivedAt: "2026-04-30",
      }),
    );
    const m = await getMessage(inbox, "m1");
    expect(m.id).toBe("m1");
    expect(m.subject).toBe("S");
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/messages\/m1$/);
  });

  it("throws on 4xx", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ msg: "gone" }, 404));
    await expect(getMessage(inbox, "missing")).rejects.toThrow(/404/);
  });
});

describe("waitForMessage", () => {
  it("returns the matched message immediately when present in first poll", async () => {
    vi.useFakeTimers();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "m1",
            from: { address: "noreply@example" },
            subject: "Welcome",
            intro: "",
            receivedAt: "",
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "m1",
          from: { address: "noreply@example" },
          subject: "Welcome",
          intro: "",
          text: "Hi Alex",
          receivedAt: "",
        }),
      );
    const promise = waitForMessage(
      inbox,
      (m) => m.subject === "Welcome",
      30_000,
    );
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result?.id).toBe("m1");
    expect(result?.text).toBe("Hi Alex");
  });

  it("returns null after timeoutMs without a match", async () => {
    vi.useFakeTimers();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse([]));
    const promise = waitForMessage(inbox, () => true, 100);
    // Advance > the 3-second poll interval so the loop's deadline check
    // (Date.now() < deadline) trips and the function returns null.
    await vi.advanceTimersByTimeAsync(3500);
    const result = await promise;
    expect(result).toBeNull();
  });

  it("keeps polling through transient list errors", async () => {
    vi.useFakeTimers();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "ok",
            from: { address: "x@y" },
            subject: "OK",
            intro: "",
            receivedAt: "",
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ok",
          from: { address: "x@y" },
          subject: "OK",
          intro: "",
          receivedAt: "",
        }),
      );
    const promise = waitForMessage(inbox, () => true, 30_000);
    // First iteration rejects; second iteration after 3 s sleep matches.
    await vi.advanceTimersByTimeAsync(3500);
    const result = await promise;
    expect(result?.id).toBe("ok");
  });
});

/**
 * Tests for src/core/url-preflight.ts — pre-run URL HEAD/GET probe.
 * Mocks global fetch (test-scoped) so no real network is touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { preflightUrls } from "../src/core/url-preflight.js";
import type { Persona, Scenario } from "../src/core/types.js";

const persona: Persona = {
  id: "u1",
  display_name: "Tester",
  country: "JP",
  language: "ja",
  locale: "ja-JP",
  timezone: "Asia/Tokyo",
  device_class: "desktop",
  payment_tier: "free",
  mental_model: "casual user",
  critical_concerns: [],
};

function scriptedScenario(steps: Scenario["steps"]): Scenario {
  return {
    id: "s1",
    name: "S1",
    priority: "P0",
    goal: "test",
    applies_to: { personas: ["u1"] },
    scoring_dimensions: ["completion", "localization", "visual_polish"],
    mode: "scripted",
    steps,
    persistent_storage: false,
  } as Scenario;
}

const realFetch = global.fetch;

beforeEach(() => {
  // Default — every test sets its own mock
  global.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("preflightUrls", () => {
  it("returns no issues when every URL is 2xx", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 200,
    });
    const sc = scriptedScenario([
      { id: "v1", type: "visit", url: "https://ok.example/a", wait_until: "load", critical: false, critical_review: false, retry: 2 },
      { id: "v2", type: "visit", url: "https://ok.example/b", wait_until: "load", critical: false, critical_review: false, retry: 2 },
    ] as Scenario["steps"]);
    const issues = await preflightUrls([{ scenario: sc, persona }]);
    expect(issues).toEqual([]);
  });

  it("reports HTTP >= 400 as an issue", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 404,
    });
    const sc = scriptedScenario([
      { id: "v1", type: "visit", url: "https://broken.example/missing", wait_until: "load", critical: false, critical_review: false, retry: 2 },
    ] as Scenario["steps"]);
    const issues = await preflightUrls([{ scenario: sc, persona }]);
    expect(issues).toHaveLength(1);
    expect(issues[0].url).toBe("https://broken.example/missing");
    expect(issues[0].status).toBe(404);
    expect(issues[0].message).toBe("HTTP 404");
    expect(issues[0].scenario).toBe("s1");
    expect(issues[0].persona).toBe("u1");
    expect(issues[0].step).toBe("v1");
  });

  it("retries once on network failure then reports error", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValue(new Error("ENOTFOUND"));
    const sc = scriptedScenario([
      { id: "v1", type: "visit", url: "https://nope.invalid/x", wait_until: "load", critical: false, critical_review: false, retry: 2 },
    ] as Scenario["steps"]);
    const issues = await preflightUrls([{ scenario: sc, persona }]);
    expect(issues).toHaveLength(1);
    expect(issues[0].status).toBe("error");
    expect(issues[0].message).toBe("ENOTFOUND");
    // Two attempts were made (initial + 1 retry)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("recovers if the first attempt fails but the retry succeeds", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ status: 200 });
    const sc = scriptedScenario([
      { id: "v1", type: "visit", url: "https://flaky.example/x", wait_until: "load", critical: false, critical_review: false, retry: 2 },
    ] as Scenario["steps"]);
    const issues = await preflightUrls([{ scenario: sc, persona }]);
    expect(issues).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("substitutes templated URLs against the persona before probing", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ status: 200 });
    const sc = scriptedScenario([
      { id: "v1", type: "visit", url: "https://x.example/${persona.locale}", wait_until: "load", critical: false, critical_review: false, retry: 2 },
    ] as Scenario["steps"]);
    await preflightUrls([{ scenario: sc, persona }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://x.example/ja-JP");
  });

  it("skips URLs that still contain unresolved placeholders", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ status: 200 });
    const sc = scriptedScenario([
      { id: "v1", type: "visit", url: "https://x.example/${store.token}", wait_until: "load", critical: false, critical_review: false, retry: 2 },
    ] as Scenario["steps"]);
    const issues = await preflightUrls([{ scenario: sc, persona }]);
    expect(issues).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips /admin/* paths (auth-protected, expected 401/403)", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ status: 401 });
    const sc = scriptedScenario([
      { id: "v1", type: "visit", url: "https://x.example/admin", wait_until: "load", critical: false, critical_review: false, retry: 2 },
      { id: "v2", type: "visit", url: "https://x.example/admin/users", wait_until: "load", critical: false, critical_review: false, retry: 2 },
    ] as Scenario["steps"]);
    const issues = await preflightUrls([{ scenario: sc, persona }]);
    expect(issues).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips non-visit step types", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ status: 200 });
    const sc = scriptedScenario([
      { id: "a1", type: "act", instruction: "Click the CTA", critical: false, critical_review: false, retry: 2 },
      { id: "v1", type: "visit", url: "https://x.example/", wait_until: "load", critical: false, critical_review: false, retry: 2 },
    ] as Scenario["steps"]);
    await preflightUrls([{ scenario: sc, persona }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://x.example/");
  });

  it("deduplicates identical URLs across personas (probes each unique URL once)", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ status: 200 });
    const sc = scriptedScenario([
      { id: "v1", type: "visit", url: "https://x.example/", wait_until: "load", critical: false, critical_review: false, retry: 2 },
    ] as Scenario["steps"]);
    const otherPersona: Persona = { ...persona, id: "u2" };
    await preflightUrls([
      { scenario: sc, persona },
      { scenario: sc, persona: otherPersona },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("treats a slow request as an error after timeoutMs", async () => {
    // Mock that never resolves but respects the AbortSignal so the
    // controller's timeout cancels it.
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      }),
    );
    const sc = scriptedScenario([
      { id: "v1", type: "visit", url: "https://slow.example/", wait_until: "load", critical: false, critical_review: false, retry: 2 },
    ] as Scenario["steps"]);
    const issues = await preflightUrls([{ scenario: sc, persona }], {
      timeoutMs: 50,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].status).toBe("error");
  }, 10_000);

  it("substitutes Stripe secrets when provided", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ status: 200 });
    const sc = scriptedScenario([
      { id: "v1", type: "visit", url: "https://x.example/?card=${stripe.card_number}", wait_until: "load", critical: false, critical_review: false, retry: 2 },
    ] as Scenario["steps"]);
    await preflightUrls([{ scenario: sc, persona }], {
      stripeSecrets: { "stripe.card_number": "4242" },
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://x.example/?card=4242",
    );
  });

  it("returns an empty list for an empty matrix", async () => {
    expect(await preflightUrls([])).toEqual([]);
  });
});

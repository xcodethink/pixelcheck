/**
 * Tests for src/core/notify.ts — Slack incoming-webhook + Telegram bot
 * notification dispatch. Mocks global fetch + isolates env per test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { notifySlack, notifyTelegram } from "../src/core/notify.js";
import type { AuditRun } from "../src/core/types.js";

const realFetch = global.fetch;
const savedEnv = { ...process.env };

function makeAudit(
  override: Partial<AuditRun["summary"]> = {},
): AuditRun {
  return {
    run_id: "run-001",
    project_name: "pixelcheck-test",
    base_url: "https://x.example",
    started_at: new Date().toISOString(),
    duration_ms: 12_345,
    audits: [],
    summary: {
      total: 4,
      pass: 2,
      pass_with_issues: 1,
      fail: 1,
      critical_issues: 0,
      total_cost_usd: 1.234,
      ...override,
    },
  } as AuditRun;
}

beforeEach(() => {
  global.fetch = vi.fn() as unknown as typeof fetch;
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  delete process.env.SLACK_WEBHOOK;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

describe("notifySlack", () => {
  it("is a no-op when SLACK_WEBHOOK is not set", async () => {
    await notifySlack(makeAudit());
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("posts to the webhook with [PASS] tag when no fail/warn", async () => {
    process.env.SLACK_WEBHOOK = "https://hooks.slack.com/services/aaa";
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    await notifySlack(
      makeAudit({ pass: 4, pass_with_issues: 0, fail: 0 }),
    );
    expect(global.fetch).toHaveBeenCalledOnce();
    const [url, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/services/aaa");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.text).toMatch(/^\[PASS\]/);
    expect(body.text).toMatch(/run-001/);
    expect(body.text).toMatch(/Total cost.*1\.234/);
  });

  it("uses [WARN] tag when there are pass_with_issues but no fails", async () => {
    process.env.SLACK_WEBHOOK = "https://hooks.slack.com/services/bbb";
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    await notifySlack(
      makeAudit({ pass: 2, pass_with_issues: 1, fail: 0 }),
    );
    const [, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.text).toMatch(/^\[WARN\]/);
  });

  it("uses [FAIL] tag when fail count > 0", async () => {
    process.env.SLACK_WEBHOOK = "https://hooks.slack.com/services/ccc";
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    await notifySlack(makeAudit({ fail: 3 }));
    const [, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.text).toMatch(/^\[FAIL\]/);
  });

  it("swallows fetch errors (does not throw)", async () => {
    process.env.SLACK_WEBHOOK = "https://hooks.slack.com/services/err";
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("EAI_AGAIN"),
    );
    await expect(notifySlack(makeAudit())).resolves.toBeUndefined();
  });
});

describe("notifyTelegram", () => {
  it("is a no-op when TELEGRAM_BOT_TOKEN unset", async () => {
    process.env.TELEGRAM_CHAT_ID = "12345";
    await notifyTelegram(makeAudit());
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("is a no-op when TELEGRAM_CHAT_ID unset", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "token-x";
    await notifyTelegram(makeAudit());
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("posts to the Telegram sendMessage endpoint with chat_id + parse_mode HTML", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "BOT_T";
    process.env.TELEGRAM_CHAT_ID = "999";
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    await notifyTelegram(makeAudit({ pass: 2, fail: 0, pass_with_issues: 1 }));
    const [url, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.telegram.org/botBOT_T/sendMessage");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.chat_id).toBe("999");
    expect(body.parse_mode).toBe("HTML");
    expect(body.text).toMatch(/^\[WARN\]/);
  });

  it("tags [FAIL] for fail>0 and [PASS] for clean run", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "T2";
    process.env.TELEGRAM_CHAT_ID = "1";
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({});

    await notifyTelegram(makeAudit({ fail: 1 }));
    let body = JSON.parse(
      (fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string,
    );
    expect(body.text).toMatch(/^\[FAIL\]/);

    await notifyTelegram(
      makeAudit({ pass: 4, fail: 0, pass_with_issues: 0 }),
    );
    body = JSON.parse(
      (fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string,
    );
    expect(body.text).toMatch(/^\[PASS\]/);
  });

  it("swallows fetch errors", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "T";
    process.env.TELEGRAM_CHAT_ID = "1";
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network"),
    );
    await expect(notifyTelegram(makeAudit())).resolves.toBeUndefined();
  });
});

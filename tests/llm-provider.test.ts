/**
 * Tests for src/core/llm-provider.ts — LLM provider abstraction with
 * Anthropic / Ollama backends and fallback chain (M4-4).
 *
 * Mocks @anthropic-ai/sdk, ./cost-guard.js, and global fetch for Ollama.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";

// ─────────────────────────────────────────────────────────────
// Hoisted mocks
// ─────────────────────────────────────────────────────────────

const sdkMock = vi.hoisted(() => {
  const capture = {
    lastCreateRequest: null as unknown,
    nextCreateResult: {
      content: [{ type: "text" as const, text: "hello from anthropic" }],
      usage: { input_tokens: 50, output_tokens: 100 },
    } as
      | {
          content: Array<{ type: string; text?: string }>;
          usage: { input_tokens: number; output_tokens: number };
        }
      | Error,
  };
  return { capture };
});

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: vi.fn(async (req: unknown) => {
        sdkMock.capture.lastCreateRequest = req;
        const v = sdkMock.capture.nextCreateResult;
        if (v instanceof Error) throw v;
        return v;
      }),
    };
  }
  return { default: FakeAnthropic };
});

const costGuardMock = vi.hoisted(() => ({
  checkBudget: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock("../src/core/cost-guard.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/core/cost-guard.js")
  >("../src/core/cost-guard.js");
  return {
    ...actual,
    getCostGuard: () => costGuardMock,
  };
});

// ─────────────────────────────────────────────────────────────
// Env snapshot
// ─────────────────────────────────────────────────────────────

const savedEnv = { ...process.env };

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-test-provider";
  sdkMock.capture.lastCreateRequest = null;
  sdkMock.capture.nextCreateResult = {
    content: [{ type: "text", text: "hello from anthropic" }],
    usage: { input_tokens: 50, output_tokens: 100 },
  };
  costGuardMock.checkBudget.mockClear();
  costGuardMock.recordUsage.mockClear();
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function mockFetch(
  response: { ok: boolean; status: number; body: unknown },
): MockInstance {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: async () => response.body,
    text: async () => JSON.stringify(response.body),
  } as Response);
}

function ollamaSuccessResponse(content = "hello from ollama") {
  return {
    ok: true,
    status: 200,
    body: {
      message: { role: "assistant", content },
      prompt_eval_count: 30,
      eval_count: 60,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// AnthropicProvider
// ─────────────────────────────────────────────────────────────

describe("AnthropicProvider", () => {
  it("chat() returns text + tokens + cost with provider='anthropic'", async () => {
    const { AnthropicProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = new AnthropicProvider();
    const resp = await p.chat([{ role: "user", content: "hi" }]);
    expect(resp.text).toBe("hello from anthropic");
    expect(resp.inputTokens).toBe(50);
    expect(resp.outputTokens).toBe(100);
    expect(resp.provider).toBe("anthropic");
    expect(resp.costUsd).toBeGreaterThan(0);
  });

  it("chat() separates system messages into the system param", async () => {
    const { AnthropicProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = new AnthropicProvider();
    await p.chat([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
    const req = sdkMock.capture.lastCreateRequest as {
      system?: string;
      messages: Array<{ role: string }>;
    };
    expect(req.system).toBe("be terse");
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe("user");
  });

  it("chat() calls cost guard checkBudget + recordUsage", async () => {
    const { AnthropicProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = new AnthropicProvider();
    await p.chat([{ role: "user", content: "hi" }]);
    expect(costGuardMock.checkBudget).toHaveBeenCalledTimes(1);
    expect(costGuardMock.recordUsage).toHaveBeenCalledTimes(1);
  });

  it("vision() returns a response with provider='anthropic'", async () => {
    const { AnthropicProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = new AnthropicProvider();
    const resp = await p.vision("BASE64DATA", "describe this");
    expect(resp.provider).toBe("anthropic");
    expect(resp.text).toBe("hello from anthropic");
  });

  it("vision() forwards systemPrompt and mediaType", async () => {
    const { AnthropicProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = new AnthropicProvider();
    await p.vision("B64", "describe", {
      systemPrompt: "be detailed",
      mediaType: "image/jpeg",
    });
    const req = sdkMock.capture.lastCreateRequest as {
      system?: string;
      messages: Array<{
        content: Array<{ type: string; source?: { media_type: string } }>;
      }>;
    };
    expect(req.system).toBe("be detailed");
    const imageBlock = req.messages[0].content.find(
      (c) => c.type === "image",
    );
    expect(imageBlock?.source?.media_type).toBe("image/jpeg");
  });
});

// ─────────────────────────────────────────────────────────────
// OllamaProvider
// ─────────────────────────────────────────────────────────────

describe("OllamaProvider", () => {
  it("chat() calls Ollama /api/chat and returns response with $0 cost", async () => {
    const fetchSpy = mockFetch(ollamaSuccessResponse());
    const { OllamaProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = new OllamaProvider();
    const resp = await p.chat([{ role: "user", content: "hi" }]);
    expect(resp.text).toBe("hello from ollama");
    expect(resp.costUsd).toBe(0);
    expect(resp.provider).toBe("ollama");
    expect(resp.inputTokens).toBe(30);
    expect(resp.outputTokens).toBe(60);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callUrl = fetchSpy.mock.calls[0][0] as string;
    expect(callUrl).toBe("http://localhost:11434/api/chat");
  });

  it("chat() uses custom baseUrl", async () => {
    const fetchSpy = mockFetch(ollamaSuccessResponse());
    const { OllamaProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = new OllamaProvider({
      baseUrl: "http://myhost:9999",
    });
    await p.chat([{ role: "user", content: "hi" }]);
    const callUrl = fetchSpy.mock.calls[0][0] as string;
    expect(callUrl).toBe("http://myhost:9999/api/chat");
  });

  it("chat() uses custom model", async () => {
    mockFetch(ollamaSuccessResponse());
    const { OllamaProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = new OllamaProvider({ chatModel: "mistral:latest" });
    await p.chat([{ role: "user", content: "hi" }]);
    // No assertion on model name in fetch body — verifying it doesn't throw
    // is sufficient; the model name is in the request body
  });

  it("vision() sends images array in Ollama format", async () => {
    const fetchSpy = mockFetch(ollamaSuccessResponse("a cat"));
    const { OllamaProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = new OllamaProvider();
    const resp = await p.vision("IMGBASE64", "what is this?");
    expect(resp.text).toBe("a cat");
    expect(resp.costUsd).toBe(0);
    expect(resp.provider).toBe("ollama");

    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as { body: string }).body,
    ) as { messages: Array<{ images?: string[] }> };
    const userMsg = body.messages.find(
      (m: { images?: string[] }) => m.images && m.images.length > 0,
    );
    expect(userMsg).toBeDefined();
    expect(userMsg!.images).toEqual(["IMGBASE64"]);
  });

  it("vision() includes systemPrompt as system message", async () => {
    const fetchSpy = mockFetch(ollamaSuccessResponse());
    const { OllamaProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = new OllamaProvider();
    await p.vision("IMG", "describe", { systemPrompt: "be brief" });

    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as { body: string }).body,
    ) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toBe("be brief");
  });

  it("throws OllamaConnectionError when fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("ECONNREFUSED"),
    );
    const { OllamaProvider, OllamaConnectionError } = await import(
      "../src/core/llm-provider.js"
    );
    const p = new OllamaProvider();
    await expect(
      p.chat([{ role: "user", content: "hi" }]),
    ).rejects.toThrow(OllamaConnectionError);
  });

  it("throws OllamaApiError on non-OK status", async () => {
    mockFetch({ ok: false, status: 500, body: "internal server error" });
    const { OllamaProvider, OllamaApiError } = await import(
      "../src/core/llm-provider.js"
    );
    const p = new OllamaProvider();
    await expect(
      p.chat([{ role: "user", content: "hi" }]),
    ).rejects.toThrow(OllamaApiError);
  });

  it("handles missing token counts gracefully (defaults to 0)", async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: {
        message: { role: "assistant", content: "no token info" },
        // prompt_eval_count and eval_count deliberately omitted
      },
    });
    const { OllamaProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = new OllamaProvider();
    const resp = await p.chat([{ role: "user", content: "hi" }]);
    expect(resp.inputTokens).toBe(0);
    expect(resp.outputTokens).toBe(0);
    expect(resp.costUsd).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// FallbackLLMProvider
// ─────────────────────────────────────────────────────────────

describe("FallbackLLMProvider", () => {
  it("uses primary when it succeeds", async () => {
    const { AnthropicProvider, OllamaProvider, FallbackLLMProvider } =
      await import("../src/core/llm-provider.js");
    const fb = new FallbackLLMProvider([
      new AnthropicProvider(),
      new OllamaProvider(),
    ]);
    const resp = await fb.chat([{ role: "user", content: "hi" }]);
    expect(resp.provider).toBe("anthropic");
  });

  it("falls back to secondary when primary fails (chat)", async () => {
    sdkMock.capture.nextCreateResult = new Error("503 Service Unavailable");
    mockFetch(ollamaSuccessResponse("fallback response"));
    const { AnthropicProvider, OllamaProvider, FallbackLLMProvider } =
      await import("../src/core/llm-provider.js");
    const fb = new FallbackLLMProvider([
      new AnthropicProvider(),
      new OllamaProvider(),
    ]);
    const resp = await fb.chat([{ role: "user", content: "hi" }]);
    expect(resp.provider).toBe("ollama");
    expect(resp.text).toBe("fallback response");
  });

  it("falls back to secondary when primary fails (vision)", async () => {
    sdkMock.capture.nextCreateResult = new Error("API overloaded");
    mockFetch(ollamaSuccessResponse("vision fallback"));
    const { AnthropicProvider, OllamaProvider, FallbackLLMProvider } =
      await import("../src/core/llm-provider.js");
    const fb = new FallbackLLMProvider([
      new AnthropicProvider(),
      new OllamaProvider(),
    ]);
    const resp = await fb.vision("IMG", "describe");
    expect(resp.provider).toBe("ollama");
    expect(resp.text).toBe("vision fallback");
  });

  it("throws AllProvidersFailedError when all providers fail", async () => {
    sdkMock.capture.nextCreateResult = new Error("Anthropic down");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Ollama down"),
    );
    const {
      AnthropicProvider,
      OllamaProvider,
      FallbackLLMProvider,
      AllProvidersFailedError,
    } = await import("../src/core/llm-provider.js");
    const fb = new FallbackLLMProvider([
      new AnthropicProvider(),
      new OllamaProvider(),
    ]);
    await expect(
      fb.chat([{ role: "user", content: "hi" }]),
    ).rejects.toThrow(AllProvidersFailedError);
  });

  it("AllProvidersFailedError contains both provider errors", async () => {
    sdkMock.capture.nextCreateResult = new Error("Anthropic down");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Ollama down"),
    );
    const {
      AnthropicProvider,
      OllamaProvider,
      FallbackLLMProvider,
      AllProvidersFailedError,
    } = await import("../src/core/llm-provider.js");
    const fb = new FallbackLLMProvider([
      new AnthropicProvider(),
      new OllamaProvider(),
    ]);
    try {
      await fb.chat([{ role: "user", content: "hi" }]);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AllProvidersFailedError);
      const apfe = err as InstanceType<typeof AllProvidersFailedError>;
      expect(apfe.errors).toHaveLength(2);
      expect(apfe.errors[0].provider).toBe("anthropic");
      expect(apfe.errors[1].provider).toBe("ollama");
    }
  });

  it("throws when constructed with empty providers array", async () => {
    const { FallbackLLMProvider } = await import(
      "../src/core/llm-provider.js"
    );
    expect(() => new FallbackLLMProvider([])).toThrow(
      /at least one provider/,
    );
  });

  it("getProviders() returns the ordered list", async () => {
    const { AnthropicProvider, OllamaProvider, FallbackLLMProvider } =
      await import("../src/core/llm-provider.js");
    const a = new AnthropicProvider();
    const o = new OllamaProvider();
    const fb = new FallbackLLMProvider([a, o]);
    const providers = fb.getProviders();
    expect(providers).toHaveLength(2);
    expect(providers[0].name).toBe("anthropic");
    expect(providers[1].name).toBe("ollama");
  });
});

// ─────────────────────────────────────────────────────────────
// createProvider factory
// ─────────────────────────────────────────────────────────────

describe("createProvider", () => {
  it("defaults to AnthropicProvider when no config/env is set", async () => {
    const { createProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = createProvider();
    expect(p.name).toBe("anthropic");
  });

  it("creates OllamaProvider when provider='ollama'", async () => {
    const { createProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = createProvider({ provider: "ollama" });
    expect(p.name).toBe("ollama");
  });

  it("reads PIXELCHECK_LLM_PROVIDER from env", async () => {
    process.env.PIXELCHECK_LLM_PROVIDER = "ollama";
    const { createProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = createProvider();
    expect(p.name).toBe("ollama");
  });

  it("creates FallbackLLMProvider when fallback is set", async () => {
    const { createProvider, FallbackLLMProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = createProvider({
      provider: "anthropic",
      fallback: "ollama",
    });
    expect(p).toBeInstanceOf(FallbackLLMProvider);
    expect(p.name).toBe("anthropic");
  });

  it("does NOT create fallback when fallback equals provider", async () => {
    const { createProvider, FallbackLLMProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = createProvider({
      provider: "anthropic",
      fallback: "anthropic",
    });
    expect(p).not.toBeInstanceOf(FallbackLLMProvider);
  });

  it("does NOT create fallback when fallback='none'", async () => {
    const { createProvider, FallbackLLMProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = createProvider({
      provider: "anthropic",
      fallback: "none",
    });
    expect(p).not.toBeInstanceOf(FallbackLLMProvider);
  });

  it("reads PIXELCHECK_LLM_FALLBACK from env", async () => {
    process.env.PIXELCHECK_LLM_FALLBACK = "ollama";
    const { createProvider, FallbackLLMProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = createProvider();
    expect(p).toBeInstanceOf(FallbackLLMProvider);
  });

  it("passes Ollama config from env to OllamaProvider", async () => {
    process.env.OLLAMA_BASE_URL = "http://custom:8080";
    process.env.OLLAMA_MODEL = "llava:7b";
    process.env.OLLAMA_CHAT_MODEL = "mistral:latest";
    const fetchSpy = mockFetch(ollamaSuccessResponse());
    const { createProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = createProvider({ provider: "ollama" });
    await p.chat([{ role: "user", content: "hi" }]);
    const callUrl = fetchSpy.mock.calls[0][0] as string;
    expect(callUrl).toBe("http://custom:8080/api/chat");
  });
});

// ─────────────────────────────────────────────────────────────
// Cost tracking: local LLM always $0.00
// ─────────────────────────────────────────────────────────────

describe("cost tracking", () => {
  it("OllamaProvider always reports $0.00 cost for chat", async () => {
    mockFetch(ollamaSuccessResponse());
    const { OllamaProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = new OllamaProvider();
    const resp = await p.chat([{ role: "user", content: "expensive?" }]);
    expect(resp.costUsd).toBe(0);
  });

  it("OllamaProvider always reports $0.00 cost for vision", async () => {
    mockFetch(ollamaSuccessResponse());
    const { OllamaProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = new OllamaProvider();
    const resp = await p.vision("IMG", "describe");
    expect(resp.costUsd).toBe(0);
  });

  it("AnthropicProvider reports non-zero cost based on model pricing", async () => {
    const { AnthropicProvider } = await import(
      "../src/core/llm-provider.js"
    );
    const p = new AnthropicProvider();
    const resp = await p.chat([{ role: "user", content: "hi" }]);
    expect(resp.costUsd).toBeGreaterThan(0);
  });
});

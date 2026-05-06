/**
 * LLM Provider abstraction (M4-4) — pluggable LLM backends with fallback chain.
 *
 * When the Anthropic API is unavailable or too expensive, users can fall back
 * to a local LLM served by Ollama (localhost:11434).
 *
 * Configuration:
 *   PIXELCHECK_LLM_PROVIDER=anthropic|ollama   (default: anthropic)
 *   PIXELCHECK_LLM_FALLBACK=ollama|anthropic|none  (default: none)
 *   OLLAMA_BASE_URL=http://localhost:11434      (default)
 *   OLLAMA_MODEL=llava:latest                   (default for vision)
 *   OLLAMA_CHAT_MODEL=llama3:latest             (default for chat)
 *
 * Usage:
 *   const provider = createProvider();
 *   const resp = await provider.chat([{ role: "user", content: "hi" }]);
 *   const vis  = await provider.vision(imageB64, "describe this");
 */

import { callVision, estimateCost, type VisionRequest, type VisionResponse } from "./llm.js";
import { getAnthropicClient } from "./llm.js";
import { getCostGuard } from "./cost-guard.js";
import { getLogger } from "./logger.js";

const log = getLogger("llm-provider");

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

export type LLMProviderName = "anthropic" | "ollama";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  provider: LLMProviderName;
}

export interface VisionOptions {
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  mediaType?: "image/png" | "image/jpeg" | "image/webp";
}

export interface VisionProviderResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  provider: LLMProviderName;
}

export interface LLMProvider {
  readonly name: LLMProviderName;

  /** Send a chat completion request. */
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse>;

  /** Send an image + prompt for vision analysis. */
  vision(
    imageBase64: string,
    prompt: string,
    opts?: VisionOptions,
  ): Promise<VisionProviderResponse>;
}

export interface LLMProviderConfig {
  /** Primary provider. Default: "anthropic". */
  provider?: LLMProviderName;
  /** Fallback provider when primary fails. Default: none. */
  fallback?: LLMProviderName | "none";
  /** Ollama base URL. Default: "http://localhost:11434". */
  ollamaBaseUrl?: string;
  /** Ollama vision model. Default: "llava:latest". */
  ollamaModel?: string;
  /** Ollama chat model. Default: "llama3:latest". */
  ollamaChatModel?: string;
}

// ─────────────────────────────────────────────────────────────
// Anthropic provider — wraps existing callVision / messages.create
// ─────────────────────────────────────────────────────────────

const DEFAULT_ANTHROPIC_CHAT_MODEL = "claude-sonnet-4-6";
const DEFAULT_ANTHROPIC_VISION_MODEL = "claude-sonnet-4-6";

export class AnthropicProvider implements LLMProvider {
  readonly name: LLMProviderName = "anthropic";

  async chat(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): Promise<ChatResponse> {
    const model = opts?.model ?? DEFAULT_ANTHROPIC_CHAT_MODEL;
    const maxTokens = opts?.maxTokens ?? 2048;
    const client = getAnthropicClient();

    const systemMessages = messages.filter((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");
    const systemPrompt =
      systemMessages.length > 0
        ? systemMessages.map((m) => m.content).join("\n")
        : undefined;

    const guard = getCostGuard();
    guard.checkBudget();

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: nonSystemMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n");

    guard.recordUsage(
      model,
      response.usage.input_tokens,
      response.usage.output_tokens,
    );

    const costUsd = estimateCost(
      model,
      response.usage.input_tokens,
      response.usage.output_tokens,
    );

    return {
      text,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      costUsd,
      provider: "anthropic",
    };
  }

  async vision(
    imageBase64: string,
    prompt: string,
    opts?: VisionOptions,
  ): Promise<VisionProviderResponse> {
    const req: VisionRequest = {
      model: opts?.model ?? DEFAULT_ANTHROPIC_VISION_MODEL,
      systemPrompt: opts?.systemPrompt,
      userPrompt: prompt,
      imageBase64,
      imageMediaType: opts?.mediaType ?? "image/png",
      maxTokens: opts?.maxTokens,
    };
    const resp: VisionResponse = await callVision(req);
    return {
      ...resp,
      provider: "anthropic",
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Ollama provider — HTTP calls to localhost:11434
// ─────────────────────────────────────────────────────────────

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_VISION_MODEL = "llava:latest";
const DEFAULT_OLLAMA_CHAT_MODEL = "llama3:latest";

interface OllamaChatRequest {
  model: string;
  messages: Array<{
    role: string;
    content: string;
    images?: string[];
  }>;
  stream: false;
  options?: {
    num_predict?: number;
    temperature?: number;
  };
}

interface OllamaChatResponse {
  message: {
    role: string;
    content: string;
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider implements LLMProvider {
  readonly name: LLMProviderName = "ollama";
  private readonly baseUrl: string;
  private readonly visionModel: string;
  private readonly chatModel: string;

  constructor(opts?: {
    baseUrl?: string;
    visionModel?: string;
    chatModel?: string;
  }) {
    this.baseUrl = opts?.baseUrl ?? DEFAULT_OLLAMA_BASE_URL;
    this.visionModel = opts?.visionModel ?? DEFAULT_OLLAMA_VISION_MODEL;
    this.chatModel = opts?.chatModel ?? DEFAULT_OLLAMA_CHAT_MODEL;
  }

  async chat(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): Promise<ChatResponse> {
    const model = opts?.model ?? this.chatModel;
    const body: OllamaChatRequest = {
      model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      stream: false as const,
      options: {
        num_predict: opts?.maxTokens,
        temperature: opts?.temperature,
      },
    };

    const resp = await this.fetchOllama("/api/chat", body);
    const inputTokens = resp.prompt_eval_count ?? 0;
    const outputTokens = resp.eval_count ?? 0;

    return {
      text: resp.message.content,
      inputTokens,
      outputTokens,
      costUsd: 0,
      provider: "ollama",
    };
  }

  async vision(
    imageBase64: string,
    prompt: string,
    opts?: VisionOptions,
  ): Promise<VisionProviderResponse> {
    const model = opts?.model ?? this.visionModel;

    const messages: OllamaChatRequest["messages"] = [];
    if (opts?.systemPrompt) {
      messages.push({ role: "system", content: opts.systemPrompt });
    }
    messages.push({
      role: "user",
      content: prompt,
      images: [imageBase64],
    });

    const body: OllamaChatRequest = {
      model,
      messages,
      stream: false as const,
      options: {
        num_predict: opts?.maxTokens,
      },
    };

    const resp = await this.fetchOllama("/api/chat", body);
    const inputTokens = resp.prompt_eval_count ?? 0;
    const outputTokens = resp.eval_count ?? 0;

    return {
      text: resp.message.content,
      inputTokens,
      outputTokens,
      costUsd: 0,
      provider: "ollama",
    };
  }

  private async fetchOllama(
    path: string,
    body: OllamaChatRequest,
  ): Promise<OllamaChatResponse> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : String(err);
      throw new OllamaConnectionError(
        `Failed to connect to Ollama at ${this.baseUrl}: ${msg}`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new OllamaApiError(
        `Ollama API error ${response.status}: ${text}`,
        response.status,
      );
    }

    return (await response.json()) as OllamaChatResponse;
  }
}

// ─────────────────────────────────────────────────────────────
// Error classes
// ─────────────────────────────────────────────────────────────

export class OllamaConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaConnectionError";
  }
}

export class OllamaApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "OllamaApiError";
  }
}

export class AllProvidersFailedError extends Error {
  constructor(
    public readonly errors: Array<{
      provider: LLMProviderName;
      error: Error;
    }>,
  ) {
    const summary = errors
      .map((e) => `${e.provider}: ${e.error.message}`)
      .join("; ");
    super(`All LLM providers failed: ${summary}`);
    this.name = "AllProvidersFailedError";
  }
}

// ─────────────────────────────────────────────────────────────
// Fallback chain wrapper
// ─────────────────────────────────────────────────────────────

export class FallbackLLMProvider implements LLMProvider {
  readonly name: LLMProviderName;
  private readonly providers: LLMProvider[];

  constructor(providers: LLMProvider[]) {
    if (providers.length === 0) {
      throw new Error("FallbackLLMProvider requires at least one provider");
    }
    this.name = providers[0].name;
    this.providers = providers;
  }

  async chat(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): Promise<ChatResponse> {
    const errors: Array<{ provider: LLMProviderName; error: Error }> = [];

    for (const provider of this.providers) {
      try {
        return await provider.chat(messages, opts);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errors.push({ provider: provider.name, error });
        log.warn(
          { provider: provider.name, error: error.message },
          "chat failed, trying next provider",
        );
      }
    }

    throw new AllProvidersFailedError(errors);
  }

  async vision(
    imageBase64: string,
    prompt: string,
    opts?: VisionOptions,
  ): Promise<VisionProviderResponse> {
    const errors: Array<{ provider: LLMProviderName; error: Error }> = [];

    for (const provider of this.providers) {
      try {
        return await provider.vision(imageBase64, prompt, opts);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errors.push({ provider: provider.name, error });
        log.warn(
          { provider: provider.name, error: error.message },
          "vision failed, trying next provider",
        );
      }
    }

    throw new AllProvidersFailedError(errors);
  }

  /** Expose the ordered list of providers (useful for introspection/testing). */
  getProviders(): readonly LLMProvider[] {
    return this.providers;
  }
}

// ─────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────

function resolveConfig(cfg?: LLMProviderConfig): Required<LLMProviderConfig> {
  return {
    provider:
      cfg?.provider ??
      (process.env.PIXELCHECK_LLM_PROVIDER as LLMProviderName | undefined) ??
      "anthropic",
    fallback:
      cfg?.fallback ??
      (process.env.PIXELCHECK_LLM_FALLBACK as
        | LLMProviderName
        | "none"
        | undefined) ??
      "none",
    ollamaBaseUrl:
      cfg?.ollamaBaseUrl ??
      process.env.OLLAMA_BASE_URL ??
      DEFAULT_OLLAMA_BASE_URL,
    ollamaModel:
      cfg?.ollamaModel ??
      process.env.OLLAMA_MODEL ??
      DEFAULT_OLLAMA_VISION_MODEL,
    ollamaChatModel:
      cfg?.ollamaChatModel ??
      process.env.OLLAMA_CHAT_MODEL ??
      DEFAULT_OLLAMA_CHAT_MODEL,
  };
}

function buildProvider(
  name: LLMProviderName,
  cfg: Required<LLMProviderConfig>,
): LLMProvider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider();
    case "ollama":
      return new OllamaProvider({
        baseUrl: cfg.ollamaBaseUrl,
        visionModel: cfg.ollamaModel,
        chatModel: cfg.ollamaChatModel,
      });
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown LLM provider: ${_exhaustive}`);
    }
  }
}

/**
 * Create an LLM provider based on config / environment variables.
 *
 * If `fallback` is set and differs from `provider`, returns a
 * FallbackLLMProvider that tries the primary first, then the fallback.
 */
export function createProvider(cfg?: LLMProviderConfig): LLMProvider {
  const resolved = resolveConfig(cfg);

  const primary = buildProvider(resolved.provider, resolved);

  if (resolved.fallback === "none" || resolved.fallback === resolved.provider) {
    return primary;
  }

  const secondary = buildProvider(resolved.fallback, resolved);
  return new FallbackLLMProvider([primary, secondary]);
}

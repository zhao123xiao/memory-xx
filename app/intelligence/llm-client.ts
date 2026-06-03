import type { IntelligenceConfig } from "./config";
import type { FailureReason, LLMCallResult } from "./types";
import { SlidingWindowCircuitBreaker, type CircuitBreakerSnapshot } from "../shared/circuit-breaker";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

interface AnthropicMessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
}

let sharedCircuitKey = "";
let sharedPrimaryCircuit: SlidingWindowCircuitBreaker | null = null;
let sharedFallbackCircuit: SlidingWindowCircuitBreaker | null = null;

function circuitKey(config: IntelligenceConfig): string {
  return JSON.stringify({
    llmCircuit: config.llmCircuit,
    primary: {
      endpoint: config.endpoint,
      model: config.model,
      protocol: config.protocol,
    },
    fallback: {
      endpoint: config.fallbackEndpoint,
      model: config.fallbackModel,
      protocol: config.fallbackProtocol,
    },
  });
}

function getSharedCircuits(config: IntelligenceConfig): {
  readonly primary: SlidingWindowCircuitBreaker;
  readonly fallback: SlidingWindowCircuitBreaker;
} {
  const key = circuitKey(config);
  if (key !== sharedCircuitKey || !sharedPrimaryCircuit || !sharedFallbackCircuit) {
    sharedCircuitKey = key;
    sharedPrimaryCircuit = new SlidingWindowCircuitBreaker(config.llmCircuit);
    sharedFallbackCircuit = new SlidingWindowCircuitBreaker(config.llmCircuit);
  }
  return { primary: sharedPrimaryCircuit, fallback: sharedFallbackCircuit };
}

export function getIntelligenceLlmCircuitHealthSnapshot(): { readonly primary: CircuitBreakerSnapshot; readonly fallback: CircuitBreakerSnapshot } | null {
  if (!sharedPrimaryCircuit || !sharedFallbackCircuit) return null;
  return {
    primary: sharedPrimaryCircuit.snapshot(),
    fallback: sharedFallbackCircuit.snapshot(),
  };
}

function shouldDisableThinking(model: string, fallbackUsed: boolean): boolean {
  return !fallbackUsed && /qwen3/i.test(model);
}

function anthropicMessagesEndpoint(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  return /\/v1\/messages$/i.test(trimmed) ? trimmed : trimmed + "/v1/messages";
}

export class IntelligenceLLMClient {
  private readonly primaryCircuit: SlidingWindowCircuitBreaker;
  private readonly fallbackCircuit: SlidingWindowCircuitBreaker;

  constructor(private readonly config: IntelligenceConfig) {
    const shared = getSharedCircuits(config);
    this.primaryCircuit = shared.primary;
    this.fallbackCircuit = shared.fallback;
  }

  hasFallbackConfigured(): boolean {
    return Boolean(this.config.fallbackEndpoint && this.config.fallbackModel);
  }

  getCircuitHealthSnapshot(): { readonly primary: CircuitBreakerSnapshot; readonly fallback: CircuitBreakerSnapshot } {
    return {
      primary: this.primaryCircuit.snapshot(),
      fallback: this.fallbackCircuit.snapshot(),
    };
  }

  async call(systemPrompt: string, userPrompt: string): Promise<LLMCallResult> {
    const primary = await this.callPrimary(systemPrompt, userPrompt);
    if (primary.ok) return primary;
    return await this.callFallback(systemPrompt, userPrompt, primary.failure_reason ?? "unknown");
  }

  async callPrimary(systemPrompt: string, userPrompt: string): Promise<LLMCallResult> {
    if (!this.primaryCircuit.canExecute()) {
      this.primaryCircuit.recordFallback();
      return {
        ok: false,
        raw: "",
        parsed: null,
        model: this.config.model,
        latency_ms: 0,
        fallback_used: false,
        failure_reason: "circuit_open",
        error: "primary_circuit_open",
      };
    }
    let last: LLMCallResult | null = null;
    const attempts = Math.max(1, this.config.maxRetries);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await this.callEndpoint({
        endpoint: this.config.endpoint,
        apiKey: this.config.apiKey,
        model: this.config.model,
        protocol: this.config.protocol,
        timeoutMs: this.config.primaryTimeoutMs,
        fallbackUsed: false,
        systemPrompt,
        userPrompt,
      });
      if (result.ok) {
        this.primaryCircuit.recordSuccess();
        return result;
      }
      last = result;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 100 * 2 ** attempt)));
      }
    }
    this.primaryCircuit.recordFailure();
    return last!;
  }

  async callFallback(systemPrompt: string, userPrompt: string, reason: FailureReason): Promise<LLMCallResult> {
    if (!this.hasFallbackConfigured()) {
      return {
        ok: false,
        raw: "",
        parsed: null,
        model: this.config.fallbackModel || this.config.model,
        latency_ms: 0,
        fallback_used: false,
        failure_reason: "fallback_config_missing",
        error: "fallback_config_missing:" + reason,
      };
    }
    if (!this.fallbackCircuit.canExecute()) {
      this.fallbackCircuit.recordFallback();
      return {
        ok: false,
        raw: "",
        parsed: null,
        model: this.config.fallbackModel,
        latency_ms: 0,
        fallback_used: true,
        fallback_reason: reason,
        failure_reason: "circuit_open",
        error: "fallback_circuit_open",
      };
    }
    const result = await this.callEndpoint({
      endpoint: this.config.fallbackEndpoint,
      apiKey: this.config.fallbackApiKey,
      model: this.config.fallbackModel,
      protocol: this.config.fallbackProtocol,
      timeoutMs: this.config.fallbackTimeoutMs,
      fallbackUsed: true,
      fallbackReason: reason,
      systemPrompt,
      userPrompt,
    });
    if (result.ok) {
      this.fallbackCircuit.recordSuccess();
    } else {
      this.fallbackCircuit.recordFailure();
    }
    return result;
  }

  private async callEndpoint(input: {
    endpoint: string;
    apiKey: string;
    model: string;
    protocol: "openai" | "anthropic";
    timeoutMs: number;
    fallbackUsed: boolean;
    fallbackReason?: FailureReason;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<LLMCallResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const maxTokens = input.fallbackUsed ? Math.max(this.config.maxTokens * 4, 1024) : this.config.maxTokens;
      const request = input.protocol === "anthropic"
        ? this.buildAnthropicRequest(input.endpoint, input.apiKey, input.model, input.systemPrompt, input.userPrompt, maxTokens)
        : this.buildOpenAIRequest(input.endpoint, input.apiKey, input.model, input.systemPrompt, input.userPrompt, maxTokens, input.fallbackUsed);
      const response = await fetch(request.endpoint, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          ok: false,
          raw: await response.text().catch(() => ""),
          parsed: null,
          model: input.model,
          latency_ms: Date.now() - started,
          fallback_used: input.fallbackUsed,
          fallback_reason: input.fallbackReason,
          failure_reason: "http_error",
          error: "LLM HTTP 调用失败：" + response.status,
        };
      }
      const data = await response.json();
      const raw = input.protocol === "anthropic"
        ? this.extractAnthropicText(data as AnthropicMessagesResponse)
        : ((data as ChatCompletionResponse).choices?.[0]?.message?.content ?? "");
      const parsed = this.extractJson(raw);
      return {
        ok: parsed !== null,
        raw,
        parsed,
        model: input.model,
        latency_ms: Date.now() - started,
        fallback_used: input.fallbackUsed,
        fallback_reason: input.fallbackReason,
        ...(parsed === null ? { failure_reason: "parse_error" as const, error: "LLM 返回内容无法解析" } : {}),
      };
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      const message = error instanceof Error ? error.message : String(error);
      const failureReason = name === "AbortError"
        ? "timeout"
        : /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT/i.test(message)
          ? "network_error"
          : "unknown";
      return {
        ok: false,
        raw: "",
        parsed: null,
        model: input.model,
        latency_ms: Date.now() - started,
        fallback_used: input.fallbackUsed,
        fallback_reason: input.fallbackReason,
        failure_reason: failureReason,
        error: message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildOpenAIRequest(
    endpoint: string,
    apiKey: string,
    model: string,
    systemPrompt: string,
    userPrompt: string,
    maxTokens: number,
    fallbackUsed: boolean,
  ): { endpoint: string; headers: Record<string, string>; body: Record<string, unknown> } {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = "Bearer " + apiKey;
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      max_tokens: maxTokens,
    };
    if (shouldDisableThinking(model, fallbackUsed)) {
      body.chat_template_kwargs = { enable_thinking: false };
    }
    return { endpoint, headers, body };
  }

  private buildAnthropicRequest(
    endpoint: string,
    apiKey: string,
    model: string,
    systemPrompt: string,
    userPrompt: string,
    maxTokens: number,
  ): { endpoint: string; headers: Record<string, string>; body: Record<string, unknown> } {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (apiKey) {
      headers["x-api-key"] = apiKey;
      headers.Authorization = "Bearer " + apiKey;
    }
    return {
      endpoint: anthropicMessagesEndpoint(endpoint),
      headers,
      body: {
        model,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        temperature: 0,
        max_tokens: maxTokens,
      },
    };
  }

  private extractAnthropicText(data: AnthropicMessagesResponse): string {
    return (data.content ?? [])
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n")
      .trim();
  }

  extractJson(raw: string): unknown {
    if (!raw) return null;
    const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    try { return JSON.parse(withoutThink); } catch {}
    const objMatch = withoutThink.match(/\{[\s\S]*\}/);
    if (objMatch?.[0]) {
      try { return JSON.parse(objMatch[0]); } catch {}
    }
    return null;
  }
}


import assert from "node:assert/strict";
import test from "node:test";

import type { IntelligenceConfig } from "../app/intelligence/config";
import { getIntelligenceCompareObservationSnapshot, resetIntelligenceCompareObservationsForTest } from "../app/intelligence/compare-observation";
import { InMemoryWriteDatabase } from "../app";
import { IntelligenceLLMClient } from "../app/intelligence/llm-client";
import { IntelligenceService } from "../app/intelligence/service";
import type { LLMCallResult } from "../app/intelligence/types";

const baseConfig: IntelligenceConfig = {
  provider: "native",
  mem0Url: "http://mem0.invalid",
  mem0OfficialPath: "/memories/add",
  mem0PreferOfficial: true,
  mem0StrategyVersion: "v1",
  nativeFallback: true,
  compareSampleRate: 0,
  model: "qwen3-8b",
  endpoint: "http://primary.invalid/v3/chat/completions",
  protocol: "openai",
  apiKey: "",
  fallbackModel: "minimax/MiniMax-M2.7-highspeed",
  fallbackEndpoint: "http://fallback.invalid/v3/chat/completions",
  fallbackProtocol: "openai",
  fallbackApiKey: "",
  primaryTimeoutMs: 100,
  fallbackTimeoutMs: 100,
  maxRetries: 1,
  lowConfidenceThreshold: 0.75,
  maxTokens: 256,
  llmCircuit: {
    windowMs: 60_000,
    minCalls: 5,
    failureRate: 0.5,
    cooldownMs: 30_000,
  },
};

function result(parsed: unknown, model = "qwen3-8b", fallbackUsed = false, fallbackReason?: LLMCallResult["fallback_reason"]): LLMCallResult {
  return { ok: true, raw: JSON.stringify(parsed), parsed, model, latency_ms: 1, fallback_used: fallbackUsed, fallback_reason: fallbackReason };
}

class FakeClient {
  fallbackCalls = 0;
  primaryCalls = 0;
  constructor(
    private readonly primaryResult: LLMCallResult,
    private readonly fallbackResult: LLMCallResult,
    private readonly fallbackConfigured = true,
  ) {}
  hasFallbackConfigured(): boolean { return this.fallbackConfigured; }
  async call(): Promise<LLMCallResult> {
    this.primaryCalls += 1;
    return this.primaryResult;
  }
  async callPrimary(): Promise<LLMCallResult> {
    this.primaryCalls += 1;
    return this.primaryResult;
  }
  async callFallback(_systemPrompt?: string, _userPrompt?: string, reason?: LLMCallResult["fallback_reason"]): Promise<LLMCallResult> {
    this.fallbackCalls += 1;
    if (!this.fallbackConfigured) {
      return {
        ok: false,
        raw: "",
        parsed: null,
        model: "qwen3-8b",
        latency_ms: 0,
        fallback_used: false,
        failure_reason: "fallback_config_missing",
        error: "fallback_config_missing:parse_error",
      };
    }
    return { ...this.fallbackResult, fallback_reason: this.fallbackResult.fallback_reason ?? reason };
  }
}

class FakeMem0Client {
  constructor(private readonly extractionResult: LLMCallResult) {}
  async extract(): Promise<LLMCallResult> {
    return this.extractionResult;
  }
}

test("LLM client parses Qwen think-wrapper JSON", () => {
  const client = new IntelligenceLLMClient(baseConfig);
  assert.deepEqual(client.extractJson("<think>\n\n</think>\n\n{\"should_write\":false,\"confidence\":1,\"memories\":[]}"), {
    should_write: false,
    confidence: 1,
    memories: [],
  });
});

test("Qwen primary call disables thinking through chat template kwargs", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({
      choices: [{ message: { content: "{\"should_write\":false,\"confidence\":1,\"memories\":[]}" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const client = new IntelligenceLLMClient(baseConfig);
    const result = await client.callPrimary("system", "user");
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0]?.chat_template_kwargs, { enable_thinking: false });
    assert.equal(calls[0]?.max_tokens, 256);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM primary and fallback circuit breakers keep independent state", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    if (String(url).includes("primary-circuit.test")) {
      return new Response("primary down", { status: 500 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "{\"should_write\":false,\"confidence\":1,\"memories\":[]}" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const client = new IntelligenceLLMClient({
      ...baseConfig,
      endpoint: "http://primary-circuit.test/v3/chat/completions",
      fallbackEndpoint: "http://fallback-circuit.test/v3/chat/completions",
      llmCircuit: {
        windowMs: 12_345,
        minCalls: 1,
        failureRate: 1,
        cooldownMs: 600_000,
      },
    });

    const first = await client.call("system", "user");
    assert.equal(first.ok, true);
    assert.equal(first.fallback_used, true);
    let health = client.getCircuitHealthSnapshot();
    assert.equal(health.primary.state, "open");
    assert.equal(health.fallback.state, "closed");
    assert.equal(health.fallback.window_failures, 0);

    const second = await client.call("system", "user again");
    assert.equal(second.ok, true);
    assert.equal(second.fallback_used, true);
    health = client.getCircuitHealthSnapshot();
    assert.equal(health.primary.fallback_count, 1);
    assert.equal(calls.filter((url) => url.includes("primary-circuit.test")).length, 1);
    assert.equal(calls.filter((url) => url.includes("fallback-circuit.test")).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM circuit breaker state is isolated by backend identity", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const value = String(url);
    calls.push(value);
    if (value.includes("isolated-primary-a.test")) {
      return new Response("primary a down", { status: 500 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "{\"should_write\":false,\"confidence\":1,\"memories\":[]}" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const llmCircuit = {
    windowMs: 23_456,
    minCalls: 1,
    failureRate: 1,
    cooldownMs: 600_000,
  };

  try {
    const failingClient = new IntelligenceLLMClient({
      ...baseConfig,
      endpoint: "http://isolated-primary-a.test/v3/chat/completions",
      fallbackEndpoint: "http://isolated-fallback-a.test/v3/chat/completions",
      llmCircuit,
    });
    const isolatedClient = new IntelligenceLLMClient({
      ...baseConfig,
      endpoint: "http://isolated-primary-b.test/v3/chat/completions",
      fallbackEndpoint: "http://isolated-fallback-b.test/v3/chat/completions",
      llmCircuit,
    });

    const first = await failingClient.call("system", "user");
    assert.equal(first.ok, true);
    assert.equal(first.fallback_used, true);
    assert.equal(failingClient.getCircuitHealthSnapshot().primary.state, "open");

    const second = await isolatedClient.call("system", "user");
    assert.equal(second.ok, true);
    assert.equal(second.fallback_used, false);
    assert.equal(isolatedClient.getCircuitHealthSnapshot().primary.state, "closed");
    assert.equal(calls.some((url) => url.includes("isolated-primary-b.test")), true);
    assert.equal(calls.some((url) => url.includes("isolated-fallback-b.test")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic fallback call uses messages protocol and parses text content", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      headers: new Headers(init?.headers),
    });
    return new Response(JSON.stringify({
      content: [{ type: "text", text: "{\"should_write\":false,\"confidence\":1,\"memories\":[]}" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const client = new IntelligenceLLMClient({
      ...baseConfig,
      fallbackProtocol: "anthropic",
      fallbackEndpoint: "https://anthropic.test/api",
      fallbackApiKey: "test-key",
    });
    const result = await client.callFallback("system prompt", "user prompt", "low_confidence");
    assert.equal(result.ok, true);
    assert.equal(calls[0].url, "https://anthropic.test/api/v1/messages");
    assert.equal(calls[0].body.system, "system prompt");
    assert.deepEqual(calls[0].body.messages, [{ role: "user", content: "user prompt" }]);
    assert.equal(calls[0].headers.get("anthropic-version"), "2023-06-01");
    assert.equal(calls[0].headers.get("x-api-key"), "test-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic primary call uses messages protocol", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      headers: new Headers(init?.headers),
    });
    return new Response(JSON.stringify({
      content: [{ type: "text", text: "{\"should_write\":false,\"confidence\":1,\"memories\":[]}" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const client = new IntelligenceLLMClient({
      ...baseConfig,
      model: "MiniMax-M2.7-highspeed",
      endpoint: "https://df.dawnloadai.com:9888",
      protocol: "anthropic",
      apiKey: "test-key",
    });
    const result = await client.callPrimary("system prompt", "user prompt");
    assert.equal(result.ok, true);
    assert.equal(calls[0].url, "https://df.dawnloadai.com:9888/v1/messages");
    assert.equal(calls[0].body.model, "MiniMax-M2.7-highspeed");
    assert.equal(calls[0].headers.get("x-api-key"), "test-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("schema-invalid primary extraction falls back to MiniMax-compatible model", async () => {
  const fallback = result({
    should_write: true,
    confidence: 0.92,
    memories: [{ canonical_content: "用户偏好：报告先给结论。", memory_type: "preference", topic: "report-style", title: "报告偏好", confidence: 0.9 }],
  }, "minimax/MiniMax-M2.7-highspeed", true);
  const fake = new FakeClient(result({ bad: true }), fallback);
  const service = new IntelligenceService(baseConfig, fake as unknown as IntelligenceLLMClient);
  const extracted = await service.extract({ text: "以后报告先给结论", agent_id: "test", scope_hint: { scope_type: "project", scope_id: "p1" }, mode: "draft" });
  assert.equal(extracted.ok, true);
  assert.equal(extracted.fallback_used, true);
  assert.equal(extracted.fallback_reason, "schema_invalid");
  assert.equal(extracted.model.final, "minimax/MiniMax-M2.7-highspeed");
  assert.equal(extracted.memories[0].canonical_content, "用户偏好：报告先给结论。");
});

test("low-confidence primary extraction falls back", async () => {
  const primary = result({
    should_write: true,
    confidence: 0.4,
    memories: [{ canonical_content: "报告要短。", memory_type: "preference", topic: "report-style", title: "报告偏好", confidence: 0.4 }],
  });
  const fallback = result({
    should_write: true,
    confidence: 0.93,
    memories: [{ canonical_content: "用户偏好：报告应简洁。", memory_type: "preference", topic: "report-style", title: "报告偏好", confidence: 0.93 }],
  }, "minimax/MiniMax-M2.7-highspeed", true);
  const fake = new FakeClient(primary, fallback);
  const service = new IntelligenceService(baseConfig, fake as unknown as IntelligenceLLMClient);
  const extracted = await service.extract({ text: "报告短点", agent_id: "test", scope_hint: { scope_type: "project", scope_id: "p1" }, mode: "draft" });
  assert.equal(fake.fallbackCalls, 1);
  assert.equal(extracted.fallback_used, true);
  assert.equal(extracted.fallback_reason, "low_confidence");
  assert.equal(extracted.memories[0].canonical_content, "用户偏好：报告应简洁。");
});

test("fallback missing is explicit and not silently successful", async () => {
  const fake = new FakeClient({ ok: false, raw: "", parsed: null, model: "qwen3-8b", latency_ms: 1, fallback_used: false, failure_reason: "parse_error" }, result({}), false);
  const service = new IntelligenceService({ ...baseConfig, fallbackModel: "", fallbackEndpoint: "" }, fake as unknown as IntelligenceLLMClient);
  const extracted = await service.extract({ text: "记一下", agent_id: "test", scope_hint: { scope_type: "project", scope_id: "p1" }, mode: "draft" });
  assert.equal(extracted.ok, false);
  assert.equal(extracted.failure_reason, "fallback_config_missing");
});

test("negative memory intent skips the LLM", async () => {
  const fake = new FakeClient(
    result({
      should_write: true,
      confidence: 0.9,
      memories: [{ canonical_content: "bad", memory_type: "fact", topic: "bad", title: "bad", confidence: 0.9 }],
    }),
    result({}),
  );
  const service = new IntelligenceService(baseConfig, fake as unknown as IntelligenceLLMClient);
  const extracted = await service.extract({ text: "今天只是临时测试，不要写入长期记忆。", agent_id: "test", scope_hint: { scope_type: "project", scope_id: "p1" }, mode: "draft" });
  assert.equal(extracted.ok, true);
  assert.equal(extracted.should_write, false);
  assert.equal(fake.primaryCalls, 0);
});

test("explicit remember intent recovers when primary says not to write", async () => {
  const primary = result({ should_write: false, confidence: 0.1, memories: [] });
  const fallback = result({
    should_write: true,
    confidence: 0.94,
    memories: [{ canonical_content: "OpenClaw P4 reports should present the conclusion before evidence.", memory_type: "constraint", topic: "reporting-style", title: "P4 reporting rule", confidence: 0.94 }],
  }, "minimax/MiniMax-M2.7-highspeed", true);
  const fake = new FakeClient(primary, fallback);
  const service = new IntelligenceService(baseConfig, fake as unknown as IntelligenceLLMClient);
  const extracted = await service.extract({ text: "请记住：OpenClaw P4 报告应该先给结论，再给证据。", agent_id: "test", scope_hint: { scope_type: "project", scope_id: "p1" }, mode: "draft" });
  assert.equal(fake.fallbackCalls, 1);
  assert.equal(extracted.should_write, true);
  assert.equal(extracted.fallback_used, true);
  assert.equal(extracted.fallback_reason, "low_confidence");
  assert.equal(extracted.memories[0].canonical_content, "OpenClaw P4 reports should present the conclusion before evidence.");
});

test("Chinese question with soft should is no-op without explicit remember intent", async () => {
  const fake = new FakeClient(
    result({ should_write: true, confidence: 0.9, memories: [{
      canonical_content: "刚刚这个 run 应该写入。",
      memory_type: "constraint",
      topic: "audit",
      title: "Audit write",
      confidence: 0.9,
    }] }),
    result({ should_write: false, confidence: 1, memories: [] }),
  );
  const service = new IntelligenceService(baseConfig, fake as unknown as IntelligenceLLMClient);
  const extracted = await service.extract({
    text: "刚刚这个审计 run 是否应该写入？",
    agent_id: "test",
    scope_hint: { scope_type: "project", scope_id: "p1" },
    mode: "draft",
  });
  assert.equal(extracted.ok, true);
  assert.equal(extracted.should_write, false);
  assert.equal(extracted.strategy, "skip_guard");
  assert.equal(fake.primaryCalls, 0);
});

test("explicit remember intent uses deterministic memory when primary false and fallback is unavailable", async () => {
  const primary = result({ should_write: false, confidence: 0.1, memories: [] });
  const fake = new FakeClient(primary, result({}), false);
  const service = new IntelligenceService({ ...baseConfig, fallbackModel: "", fallbackEndpoint: "" }, fake as unknown as IntelligenceLLMClient);
  const extracted = await service.extract({ text: "请记住：OpenClaw P4 报告应该先给结论。", agent_id: "test", scope_hint: { scope_type: "project", scope_id: "p1" }, mode: "draft" });
  assert.equal(extracted.ok, true);
  assert.equal(extracted.should_write, true);
  assert.equal(extracted.memories[0].canonical_content, "OpenClaw P4 报告应该先给结论。");
  assert.equal(extracted.memories[0].memory_type, "constraint");
});

test("conflict resolution skips exact duplicate", async () => {
  const service = new IntelligenceService({ ...baseConfig, fallbackModel: "", fallbackEndpoint: "" });
  const memory = {
    content: "用户偏好：报告先给结论。",
    canonical_content: "用户偏好：报告先给结论。",
    memory_type: "preference" as const,
    topic: "report-style",
    title: "报告偏好",
    confidence: 0.9,
    dedupe_key: "project:p1:preference:report-style",
    scope_type: "project",
    scope_id: "p1",
    conflict_action: "create" as const,
  };
  const resolved = await service.resolveConflict(memory, { id: "m1", content: "用户偏好：报告先给结论。" });
  assert.equal(resolved.conflict_action, "skip");
  assert.equal(resolved.existing_memory_id, "m1");
});

test("default conflict strategies cover preference, fact, and procedure", async () => {
  const service = new IntelligenceService({ ...baseConfig, fallbackModel: "", fallbackEndpoint: "" });
  const base = {
    content: "new",
    canonical_content: "new",
    topic: "topic",
    title: "title",
    confidence: 0.9,
    dedupe_key: "project:p1:fact:topic",
    scope_type: "project",
    scope_id: "p1",
    conflict_action: "create" as const,
  };
  assert.equal((await service.resolveConflict({ ...base, memory_type: "preference" as const }, { id: "m1", content: "old" })).conflict_action, "merge");
  assert.equal((await service.resolveConflict({ ...base, memory_type: "fact" as const }, { id: "m1", content: "old" })).conflict_action, "supersede");
  assert.equal((await service.resolveConflict({ ...base, memory_type: "procedure" as const }, { id: "m1", content: "old" })).conflict_action, "create");
});

test("mem0 operation metadata maps no_change to skip and update to supersede", async () => {
  const noChange = result({
    should_write: true,
    confidence: 0.92,
    strategy: "update_conflict",
    operation: "no_change",
    memories: [{
      canonical_content: "memory-xx uses Postgres as the source of truth.",
      memory_type: "fact",
      topic: "memory-xx-storage",
      title: "memory-xx storage",
      operation: "no_change",
      confidence: 0.92,
      existing_memory_id: "m1",
    }],
  }, "mem0:test-model:official");
  const fakeNoChange = new FakeMem0Client(noChange);
  const noChangeService = new IntelligenceService({ ...baseConfig, provider: "mem0", mem0StrategyVersion: "v2" }, undefined, fakeNoChange as any);
  const noChangeExtracted = await noChangeService.extract({ text: "Remember: memory-xx uses Postgres as the source of truth.", agent_id: "test", scope_hint: { scope_type: "project", scope_id: "p1" }, mode: "draft" });
  assert.equal(noChangeExtracted.strategy, "update_conflict");
  assert.equal(noChangeExtracted.mem0_strategy_version, "v2");
  assert.equal(noChangeExtracted.mem0_mode, "official");
  assert.equal(noChangeExtracted.mem0_attempted, true);
  assert.equal(noChangeExtracted.mem0_success, true);
  assert.equal(noChangeExtracted.mem0_official_attempted, true);
  assert.equal(noChangeExtracted.mem0_official_success, true);
  assert.equal(noChangeExtracted.memories[0].operation, "no_change");
  assert.equal(noChangeExtracted.memories[0].conflict_action, "skip");

  const update = result({
    should_write: true,
    confidence: 0.92,
    strategy: "update_conflict",
    operation: "update",
    memories: [{
      canonical_content: "Qwen3-Reranker-8B-INT4 is the production reranker.",
      memory_type: "decision",
      topic: "reranker-model",
      title: "Reranker model decision",
      operation: "update",
      confidence: 0.92,
      existing_memory_id: "m2",
    }],
  }, "mem0:test-model:official");
  const fakeUpdate = new FakeMem0Client(update);
  const updateService = new IntelligenceService({ ...baseConfig, provider: "mem0", mem0StrategyVersion: "v2" }, undefined, fakeUpdate as any);
  const updateExtracted = await updateService.extract({ text: "Remember: old reranker is replaced by Qwen3-Reranker-8B-INT4.", agent_id: "test", scope_hint: { scope_type: "project", scope_id: "p1" }, mode: "draft" });
  assert.equal(updateExtracted.memories[0].operation, "update");
  assert.equal(updateExtracted.memories[0].conflict_action, "supersede");
});

test("deterministic type correction does not let soft should override decision intent", async () => {
  const extractedByMem0 = result({
    should_write: true,
    confidence: 0.92,
    operation: "add",
    memories: [{
      canonical_content: "For memory-xx, the reranker strategy should first use force_top1 for stress testing, while the default remains adaptive.",
      memory_type: "fact",
      topic: "reranker-strategy",
      title: "Reranker strategy",
      confidence: 0.92,
    }],
  }, "mem0:test-model:official");
  const fake = new FakeMem0Client(extractedByMem0);
  const service = new IntelligenceService({ ...baseConfig, provider: "mem0" }, undefined, fake as any);
  const extracted = await service.extract({
    text: "决定：memory-xx 的 reranker 策略先用 force_top1 做压测，默认仍保持 adaptive。",
    agent_id: "test",
    scope_hint: { scope_type: "project", scope_id: "p1" },
    mode: "draft",
  });

  assert.equal(extracted.memories[0].memory_type, "decision");
  assert.equal(extracted.memories[0].memory_type_corrected_from, "fact");
  assert.equal(extracted.memories[0].memory_type_correction_reason, "decision_keyword");
});

test("mem0 schema repair metadata is surfaced", async () => {
  const repaired = result({
    should_write: true,
    confidence: 0.91,
    strategy: "multi_add",
    operation: "add",
    schema_repair_applied: true,
    quality_flags: ["memory_type_inferred"],
    memories: [{
      content: "Reports should start with the conclusion.",
      type: "constraint",
      confidence: 0.91,
    }],
  }, "mem0:test-model");
  const fake = new FakeMem0Client(repaired);
  const service = new IntelligenceService({ ...baseConfig, provider: "mem0", mem0StrategyVersion: "v2" }, undefined, fake as any);
  const extracted = await service.extract({ text: "Remember: reports should start with the conclusion.", agent_id: "test", scope_hint: { scope_type: "project", scope_id: "p1" }, mode: "draft" });
  assert.equal(extracted.schema_repair_applied, true);
  assert.deepEqual(extracted.quality_flags, ["memory_type_inferred"]);
  assert.equal(extracted.memories[0].memory_type, "constraint");
});

test("mem0 transport failure falls back to native LLM instead of returning unavailable", async () => {
  const native = result({
    should_write: true,
    confidence: 0.93,
    memories: [{
      canonical_content: "本地 embedding 服务是 memory-xx 的默认写入向量提供方。",
      memory_type: "decision",
      topic: "embedding-provider",
      title: "本地 embedding 默认启用",
      confidence: 0.93,
    }],
  }, "qwen3-8b");
  const fakeLlm = new FakeClient(native, result({}));
  const fakeMem0 = new FakeMem0Client({
    ok: false,
    raw: "",
    parsed: null,
    model: "mem0:test-model:official",
    latency_ms: 2,
    fallback_used: false,
    failure_reason: "network_error",
    mem0_attempted_mode: "official",
    mem0_official_attempted: true,
    mem0_official_success: false,
    error: "connect ECONNREFUSED",
  });
  const service = new IntelligenceService({ ...baseConfig, provider: "mem0", nativeFallback: true }, fakeLlm as unknown as IntelligenceLLMClient, fakeMem0 as any);
  const extracted = await service.extract({ text: "记住：本地 embedding 服务是默认提供方。", agent_id: "test", scope_hint: { scope_type: "project", scope_id: "p1" }, mode: "draft" });

  assert.equal(extracted.ok, true);
  assert.equal(extracted.provider, "mem0");
  assert.equal(extracted.mem0_used, true);
  assert.equal(extracted.mem0_attempted, true);
  assert.equal(extracted.mem0_success, false);
  assert.equal(extracted.mem0_mode, "official");
  assert.equal(extracted.mem0_official_attempted, true);
  assert.equal(extracted.mem0_official_success, false);
  assert.equal(extracted.fallback_used, true);
  assert.equal(extracted.mem0_fallback_reason, "network_error");
  assert.equal(extracted.memories[0].canonical_content, "本地 embedding 服务是 memory-xx 的默认写入向量提供方。");
});

test("mem0 and native fallback failure returns safe no-write", async () => {
  const fakeLlm = new FakeClient({
    ok: false,
    raw: "",
    parsed: null,
    model: "qwen3-8b",
    latency_ms: 1,
    fallback_used: false,
    failure_reason: "timeout",
    error: "timeout",
  }, result({}), false);
  const fakeMem0 = new FakeMem0Client({
    ok: false,
    raw: "",
    parsed: null,
    model: "mem0:test-model",
    latency_ms: 2,
    fallback_used: false,
    failure_reason: "http_error",
    error: "503",
  });
  const service = new IntelligenceService({
    ...baseConfig,
    provider: "mem0",
    nativeFallback: true,
    fallbackModel: "",
    fallbackEndpoint: "",
  }, fakeLlm as unknown as IntelligenceLLMClient, fakeMem0 as any);
  const extracted = await service.extract({ text: "记住：失败时不要误写。", agent_id: "test", scope_hint: { scope_type: "project", scope_id: "p1" }, mode: "draft" });

  assert.equal(extracted.ok, false);
  assert.equal(extracted.should_write, false);
  assert.equal(extracted.mem0_used, true);
  assert.equal(extracted.fallback_used, true);
  assert.equal(extracted.memories.length, 0);
});

test("compare sampling records fallback observation without changing primary result", async () => {
  resetIntelligenceCompareObservationsForTest();
  const database = new InMemoryWriteDatabase();
  const primary = result({
    should_write: true,
    confidence: 0.9,
    memories: [{
      canonical_content: "Primary model remembers compact facts.",
      memory_type: "fact",
      topic: "compare",
      title: "Compare Primary",
      confidence: 0.9,
    }],
  }, "primary-model");
  const fallback = result({
    should_write: true,
    confidence: 0.5,
    memories: [],
  }, "fallback-model", true, "unknown");
  const fakeLlm = new FakeClient(primary, fallback);
  const service = new IntelligenceService(
    { ...baseConfig, compareSampleRate: 1 },
    fakeLlm as unknown as IntelligenceLLMClient,
    undefined,
    { compareObservationDatabase: database }
  );

  const extracted = await service.extract({ text: "Remember compare observation.", agent_id: "test", scope_hint: { scope_type: "project", scope_id: "p1" }, mode: "draft" });
  await new Promise((resolve) => setImmediate(resolve));
  const snapshot = getIntelligenceCompareObservationSnapshot();

  assert.equal(extracted.model.final, "primary-model");
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.high_diff_count, 1);
  assert.equal(snapshot.latest?.memory_count_diff, 1);
  const dbSnapshot = await database.snapshot();
  assert.equal(dbSnapshot.intelligenceCompareObservations.length, 1);
  assert.equal(dbSnapshot.intelligenceCompareObservations[0].memoryCountDiff, 1);
});

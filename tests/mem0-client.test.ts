import assert from "node:assert/strict";
import test from "node:test";

import type { IntelligenceConfig } from "../app/intelligence/config";
import { Mem0ExtractionClient } from "../app/intelligence/mem0-client";

const config: IntelligenceConfig = {
  provider: "mem0",
  mem0Url: "http://mem0.test",
  mem0OfficialPath: "/memories/add",
  mem0PreferOfficial: true,
  mem0StrategyVersion: "v2",
  nativeFallback: true,
  compareSampleRate: 0,
  model: "test-model",
  endpoint: "http://primary.invalid/v3/chat/completions",
  protocol: "openai",
  apiKey: "",
  fallbackModel: "",
  fallbackEndpoint: "",
  fallbackProtocol: "openai",
  fallbackApiKey: "",
  primaryTimeoutMs: 1000,
  fallbackTimeoutMs: 1000,
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

test("mem0 client uses official messages add payload first", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({
      memories: [{ memory: "Reports should start with the conclusion.", type: "constraint", confidence: 0.9 }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const client = new Mem0ExtractionClient(config);
    const result = await client.extract({
      text: "Remember: reports should start with the conclusion.",
      agent_id: "agent-a",
      user_id: "user-a",
      workspace_id: "workspace-a",
      scope_hint: { scope_type: "project", scope_id: "memory-xx" },
      mode: "draft",
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://mem0.test/memories/add");
    assert.deepEqual(calls[0].body.messages, [{ role: "user", content: "Remember: reports should start with the conclusion." }]);
    assert.equal(calls[0].body.infer, true);
    assert.equal(calls[0].body.user_id, "user-a");
    assert.equal((calls[0].body.metadata as Record<string, unknown>).source, "memory-xx");
    const policy = (calls[0].body.metadata as Record<string, unknown>).memory_xx_policy as Record<string, unknown>;
    assert.equal(policy.policy_version, "memory-policy-v1");
    assert.deepEqual(policy.memory_classes, [
      "long_term_fact",
      "preference",
      "constraint",
      "decision",
      "procedure",
      "operational_issue",
      "test_evidence",
      "audit_evidence",
      "runtime_noise",
      "ephemeral_task",
      "explicit_no_memory",
      "unknown_source_quarantine",
    ]);
    assert.equal(result.model, "mem0:test-model:official");
    assert.equal(result.mem0_attempted_mode, "official");
    assert.equal(result.mem0_official_attempted, true);
    assert.equal(result.mem0_official_success, true);
    assert.equal((result.parsed as Record<string, unknown>).should_write, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mem0 client falls back to legacy extract when official route is missing", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    calls.push({
      url,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    if (url.endsWith("/memories/add")) {
      return new Response(JSON.stringify({ ok: false, error: "not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      should_write: false,
      confidence: 0.98,
      memories: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const client = new Mem0ExtractionClient(config);
    const result = await client.extract({
      text: "只是临时测试，不要记住。",
      agent_id: "agent-a",
      scope_hint: { scope_type: "project", scope_id: "memory-xx" },
      mode: "draft",
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls.map((call) => call.url), ["http://mem0.test/memories/add", "http://mem0.test/extract"]);
    assert.equal(((calls[1].body.memory_xx_policy as Record<string, unknown>).storage_targets as string[]).includes("redis_ttl"), true);
    assert.equal(result.model, "mem0:test-model:legacy_extract");
    assert.equal(result.mem0_attempted_mode, "legacy_extract");
    assert.equal(result.mem0_official_attempted, true);
    assert.equal(result.mem0_official_success, false);
    assert.equal(result.mem0_fallback_reason, "http_error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mem0 official normalization preserves policy evidence fields", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    memories: [{
      memory: "Qdrant projector lag is a real synchronization issue.",
      type: "fact",
      confidence: 0.91,
      memory_class: "operational_issue",
      evidence_span: "Qdrant projector lag",
      why_long_term: "Tracks an unresolved runtime issue.",
      temporal_validity: "until_resolved",
      source_intent: "report_issue",
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

  try {
    const client = new Mem0ExtractionClient(config);
    const result = await client.extract({
      text: "Qdrant projector lag is a real synchronization issue.",
      agent_id: "agent-a",
      scope_hint: { scope_type: "project", scope_id: "memory-xx" },
      mode: "draft",
    });
    const memories = (result.parsed as { memories: Array<Record<string, unknown>> }).memories;
    assert.equal(memories[0].memory_class, "operational_issue");
    assert.equal(memories[0].evidence_span, "Qdrant projector lag");
    assert.equal(memories[0].why_long_term, "Tracks an unresolved runtime issue.");
    assert.equal(memories[0].temporal_validity, "until_resolved");
    assert.equal(memories[0].source_intent, "report_issue");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

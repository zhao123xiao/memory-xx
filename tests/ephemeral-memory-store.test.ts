import assert from "node:assert/strict";
import test from "node:test";

import { EphemeralMemoryStore } from "../app/cache/ephemeral-memory-store";

class FakeRedisClient {
  readonly store = new Map<string, string>();
  readonly expirations = new Map<string, number>();
  isOpen = false;

  async connect(): Promise<void> { this.isOpen = true; }
  async quit(): Promise<void> { this.isOpen = false; }
  async set(key: string, value: string, options?: { EX?: number }): Promise<string> {
    this.store.set(key, value);
    if (options?.EX) this.expirations.set(key, options.EX);
    return "OK";
  }
  async ping(): Promise<string> { return "PONG"; }
  on(): void {}
}

class FailingRedisClient extends FakeRedisClient {
  override async set(): Promise<string> {
    throw new Error("redis_down");
  }
}

test("ephemeral memory store writes scoped TTL keys to Redis", async () => {
  const client = new FakeRedisClient();
  const store = new EphemeralMemoryStore({
    config: {
      url: "redis://127.0.0.1:6379/0",
      prefix: "memory-xx-test",
      connect_timeout_ms: 50,
      empty_recall_ttl_seconds: 15,
      ttl_seconds: { search: 60, session: 60, recent: 60, startup_context: 60 },
    },
    client,
    now: () => new Date("2026-06-01T00:00:00.000Z"),
  });

  const result = await store.remember({
    scopeType: "project",
    scopeId: "p-1",
    content: "30 分钟后检查 qdrant projector 状态",
    ttlSeconds: 1800,
    metadata: { memory_class: "ephemeral_task", source: "conversation_ingest" },
  });

  assert.equal(result.status, "stored");
  assert.match(result.key ?? "", /^memory-xx-test:ephemeral-memory:project:p-1:[a-f0-9]{16}$/u);
  assert.equal(result.ttl_seconds, 1800);
  assert.equal(result.expires_at, "2026-06-01T00:30:00.000Z");
  assert.equal(client.expirations.get(result.key ?? ""), 1800);
  const payload = JSON.parse(client.store.get(result.key ?? "") ?? "{}") as Record<string, unknown>;
  assert.equal(payload.content, "30 分钟后检查 qdrant projector 状态");
  assert.equal(payload.scope_type, "project");
  assert.equal(payload.scope_id, "p-1");
});

test("ephemeral memory store skips cleanly when Redis is not configured", async () => {
  const store = new EphemeralMemoryStore({
    config: {
      prefix: "memory-xx-test",
      connect_timeout_ms: 50,
      empty_recall_ttl_seconds: 15,
      ttl_seconds: { search: 60, session: 60, recent: 60, startup_context: 60 },
    },
    now: () => new Date("2026-06-01T00:00:00.000Z"),
  });

  const result = await store.remember({
    scopeType: "task",
    scopeId: "t-1",
    content: "稍后提醒我继续检查",
    ttlSeconds: 900,
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "redis_not_configured");
  assert.equal(result.ttl_seconds, 900);
});

test("ephemeral memory store returns fallback when Redis write fails", async () => {
  const store = new EphemeralMemoryStore({
    config: {
      url: "redis://127.0.0.1:6379/0",
      prefix: "memory-xx-test",
      connect_timeout_ms: 50,
      empty_recall_ttl_seconds: 15,
      ttl_seconds: { search: 60, session: 60, recent: 60, startup_context: 60 },
    },
    client: new FailingRedisClient(),
    now: () => new Date("2026-06-01T00:00:00.000Z"),
  });

  const result = await store.remember({
    scopeType: "workspace",
    scopeId: "w-1",
    content: "30 minutes later inspect the temporary task",
    ttlSeconds: 1800,
  });

  assert.equal(result.status, "fallback");
  assert.match(result.reason ?? "", /redis_down/u);
  assert.equal(result.ttl_seconds, 1800);
});

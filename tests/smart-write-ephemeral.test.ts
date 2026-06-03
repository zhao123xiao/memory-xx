import assert from "node:assert/strict";
import test from "node:test";

import { processSmartWrite } from "../app/api/intelligence/handlers";
import { InMemoryWriteDatabase } from "../app/db/adapters/in-memory-write-database";
import type { SmartExtractionRequest, SmartExtractionResponse } from "../app/intelligence/types";

test("smart-write stores ephemeral policy results outside Postgres candidates", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-06-01T00:00:00.000Z");
  const fakeService = {
    async extract(_request: SmartExtractionRequest): Promise<SmartExtractionResponse> {
      return {
        ok: true,
        should_write: true,
        confidence: 0.91,
        memories: [{
          content: "30 分钟后检查 qdrant projector 状态",
          canonical_content: "30 分钟后检查 qdrant projector 状态",
          memory_type: "fact",
          topic: "ephemeral_task",
          title: "临时任务",
          confidence: 0.91,
          dedupe_key: "ephemeral:qdrant-projector-check",
          scope_type: "project",
          scope_id: "memory-xx",
          conflict_action: "create",
          operation: "add",
          memory_class: "ephemeral_task",
        }],
        model: { primary: "fake", final: "fake" },
        provider: "native",
        fallback_used: false,
      };
    },
    async resolveConflict() {
      throw new Error("resolveConflict should not be called for empty in-memory context");
    },
  };
  const fakeEphemeralStore = {
    async remember(input: { readonly ttlSeconds: number }) {
      return {
        key: "memory-xx:test:ephemeral-memory:project:memory-xx:abc",
        status: "stored" as const,
        ttl_seconds: input.ttlSeconds,
        expires_at: "2026-06-01T00:30:00.000Z",
      };
    },
  };

  const result = await processSmartWrite(
    {
      text: "30 分钟后检查 qdrant projector 状态",
      agent_id: "klee",
      mode: "write",
      scope_hint: { scope_type: "project", scope_id: "memory-xx" },
      metadata: { source: "conversation_ingest" },
    },
    false,
    undefined,
    "sync",
    undefined,
    database,
    { intelligenceService: fakeService as any, ephemeralMemoryStore: fakeEphemeralStore as any },
  );

  assert.equal(result.status, 200);
  const body = result.body as { created: Array<Record<string, unknown>> };
  assert.equal(body.created[0]?.action, "ephemeral_only");
  assert.equal(body.created[0]?.storage_target, "redis_ttl");
  assert.equal(body.created[0]?.ephemeral_key, "memory-xx:test:ephemeral-memory:project:memory-xx:abc");
  assert.equal(body.created[0]?.ttl_seconds, 1800);
  const snapshot = await database.snapshot();
  assert.equal(snapshot.memoryRecords.length, 0);
});

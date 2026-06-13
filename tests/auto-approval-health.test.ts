import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryWriteDatabase } from "../app/db/adapters/in-memory-write-database";
import { collectAutoApprovalOperationalHealth } from "../app/governance/auto-approval-health";
import { isInMemoryTransactionContext } from "../app/db/tx/write-transaction";
import { LifecycleStatus, ReviewState, ScopeType, type JsonObject } from "../app/shared/types";

test("auto approval health counts only effective recallable Postgres memories", async () => {
  const previousQdrantBaseUrl = process.env.MEMORY_XX_QDRANT_BASE_URL;
  const previousQdrantCollection = process.env.MEMORY_XX_QDRANT_COLLECTION;
  delete process.env.MEMORY_XX_QDRANT_BASE_URL;
  delete process.env.MEMORY_XX_QDRANT_COLLECTION;

  const database = new InMemoryWriteDatabase(() => "2026-06-05T00:00:00.000Z");
  await database.withTransaction((tx) => {
    assert.equal(isInMemoryTransactionContext(tx), true);
    if (!isInMemoryTransactionContext(tx)) return;
    tx.state.memoryRecords.push(
      memoryRecord("memory_record_default", { recall_policy: "default" }),
      memoryRecord("memory_record_test_only", { recall_policy: "test_only" }),
      memoryRecord("memory_record_audit_only", { recall_policy: "audit_only" })
    );
  });

  try {
    const health = await collectAutoApprovalOperationalHealth({ database });
    assert.equal(health.metrics.postgres_effective_recallable_count, 1);
    assert.equal(health.metrics.policy_test_only_current, 1);
    assert.equal(health.metrics.policy_audit_only_current, 1);
  } finally {
    if (previousQdrantBaseUrl === undefined) delete process.env.MEMORY_XX_QDRANT_BASE_URL;
    else process.env.MEMORY_XX_QDRANT_BASE_URL = previousQdrantBaseUrl;
    if (previousQdrantCollection === undefined) delete process.env.MEMORY_XX_QDRANT_COLLECTION;
    else process.env.MEMORY_XX_QDRANT_COLLECTION = previousQdrantCollection;
  }
});

function memoryRecord(id: string, metadata: JsonObject) {
  return {
    id,
    requestId: `request_${id}`,
    scopeType: ScopeType.Project,
    scopeId: "memory-xx",
    content: id,
    title: id,
    summary: null,
    metadata,
    contentEmbedding: null,
    dedupeKey: null,
    lifecycleStatus: LifecycleStatus.Approved,
    reviewState: ReviewState.SilentApproved,
    isCurrent: true,
    version: 1,
    createdBy: "test",
    updatedBy: "test",
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
    tenantId: "default",
    agentId: "codex",
    governanceStatus: "normal",
    visibility: "private",
    memoryType: "fact",
    embeddingGeneration: "generation-a",
    memoryLayer: "semantic",
    factStatus: "current",
    validAt: null,
    invalidAt: null,
    observedAt: null,
    expiresAt: null,
    episodeId: null,
    importance: 0.5,
    memoryStrength: 1,
    decayPolicy: "default",
  };
}

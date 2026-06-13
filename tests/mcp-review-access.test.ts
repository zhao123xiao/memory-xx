import assert from "node:assert/strict";
import test from "node:test";

import { listPendingMemories } from "../app/orchestrator/mcp-review-access";
import { createEmptyWriteDatabaseState } from "../app/db/schema/tables";
import type { PostgresWriteTransactionContext, WriteTransactionContext, WriteTransactionRunner } from "../app/db/tx/write-transaction";

class FakePostgresPendingRunner implements WriteTransactionRunner {
  snapshotCalls = 0;

  async withTransaction<TResult>(
    work: (tx: WriteTransactionContext) => TResult | Promise<TResult>
  ): Promise<TResult> {
    const tx: PostgresWriteTransactionContext = {
      backend: "postgres",
      now: () => "2026-06-07T07:30:00.000Z",
      nextId: () => "unused",
      query: async (sql) => {
        if (/count\(\*\)/iu.test(sql)) {
          return [{ total: "1" }] as never;
        }
        return [pendingMemoryRow] as never;
      },
    };
    return work(tx);
  }

  async snapshot() {
    this.snapshotCalls += 1;
    return createEmptyWriteDatabaseState();
  }

  async snapshotForMemoryIds() {
    return createEmptyWriteDatabaseState();
  }
}

const pendingMemoryRow = {
  id: "memory_record_00000000-0000-4000-8000-000000000901",
  request_id: "req-pending-901",
  scope_type: "project",
  scope_id: "mcp-user-flow-regression",
  content: "OpenClaw MCP L9 regression pending memory.",
  title: "L9 regression",
  summary: null,
  metadata: {
    source: "memory-xx-mcp-smart-write",
    memory_class: "test_evidence",
    recall_policy: "test_only",
  },
  content_embedding: null,
  dedupe_key: null,
  lifecycle_status: "candidate",
  review_state: "pending",
  is_current: true,
  version: 1,
  created_by: "l9-mcp-user-flow",
  updated_by: "l9-mcp-user-flow",
  created_at: "2026-06-07T07:30:00.000Z",
  updated_at: "2026-06-07T07:30:00.000Z",
  tenant_id: "default",
  agent_id: "l9-mcp-user-flow",
  governance_status: "normal",
  visibility: "scope_only",
  memory_type: "preference",
  embedding_generation: null,
  memory_layer: "audit",
  fact_status: "current",
  valid_at: null,
  invalid_at: null,
  observed_at: null,
  expires_at: null,
  episode_id: null,
  importance: 0.5,
  memory_strength: 1,
  decay_policy: "importance_weighted",
};

test("listPendingMemories queries current Postgres pending rows instead of capped snapshots", async () => {
  const database = new FakePostgresPendingRunner();

  const result = await listPendingMemories(database, {
    scope_type: "project",
    scope_id: "mcp-user-flow-regression",
    agent_id: "l9-mcp-user-flow",
    limit: 20,
  });

  assert.equal(database.snapshotCalls, 0);
  assert.equal(result.total, 1);
  assert.equal(result.memories[0]?.id, pendingMemoryRow.id);
  assert.equal(result.memories[0]?.memory_class, "test_evidence");
  assert.equal(result.memories[0]?.recall_policy, "test_only");
});

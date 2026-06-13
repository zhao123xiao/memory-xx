import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRelationRepository } from "../app/db/repositories/memory-relation-repository";
import { RelationTargetNotFoundError } from "../app/shared/errors/write-errors";
import type { QueryResultRow } from "pg";
import type { PostgresWriteTransactionContext } from "../app/db/tx/write-transaction";

test("memory relation createMany batches postgres inserts into one statement", async () => {
  const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  const tx: PostgresWriteTransactionContext = {
    backend: "postgres",
    now: () => "2026-06-06T00:00:00.000Z",
    nextId: (sequenceName) => `${sequenceName}_${queries.length}_${Math.random().toString(36).slice(2, 4)}`,
    async query<TResult extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<readonly TResult[]> {
      queries.push({ sql, params });
      return [
        {
          id: "memory_relation_1",
          memory_id: "memory-1",
          related_memory_id: "related-1",
          relation_type: "supports",
          direction: "outbound",
          weight: null,
          metadata: {},
          created_at: "2026-06-06T00:00:00.000Z",
          updated_at: "2026-06-06T00:00:00.000Z",
        },
        {
          id: "memory_relation_2",
          memory_id: "memory-1",
          related_memory_id: "related-2",
          relation_type: "contradicts",
          direction: "outbound",
          weight: 0.7,
          metadata: { reason: "test" },
          created_at: "2026-06-06T00:00:00.000Z",
          updated_at: "2026-06-06T00:00:00.000Z",
        },
      ] as unknown as readonly TResult[];
    },
  };

  const rows = await new MemoryRelationRepository().createMany(tx, "memory-1", [
    { relatedMemoryId: "related-1", relationType: "supports" },
    { relatedMemoryId: "related-2", relationType: "contradicts", weight: 0.7, metadata: { reason: "test" } },
  ]);

  assert.equal(queries.length, 1);
  assert.match(queries[0]?.sql ?? "", /VALUES\s+\(\$1, \$2, \$3/u);
  assert.match(queries[0]?.sql ?? "", /\(\$10, \$11, \$12/u);
  assert.equal(rows.length, 2);
});

test("memory relation createMany maps postgres relation target races to domain errors", async () => {
  const tx: PostgresWriteTransactionContext = {
    backend: "postgres",
    now: () => "2026-06-06T00:00:00.000Z",
    nextId: (sequenceName) => `${sequenceName}_1`,
    async query<TResult extends QueryResultRow = QueryResultRow>(): Promise<readonly TResult[]> {
      const error = Object.assign(new Error("insert or update on table \"memory_relations\" violates foreign key constraint"), {
        code: "23503",
        constraint: "memory_relations_related_memory_id_fkey"
      });
      throw error;
    },
  };

  await assert.rejects(
    () => new MemoryRelationRepository().createMany(tx, "memory-1", [
      { relatedMemoryId: "deleted-target", relationType: "supports" },
    ]),
    (error) => error instanceof RelationTargetNotFoundError &&
      error.message.includes("deleted-target")
  );
});

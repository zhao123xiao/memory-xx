import assert from "node:assert/strict";
import test from "node:test";

import type { QueryResultRow } from "pg";
import { MemorySourceRepository } from "../app/db/repositories/memory-source-repository";
import type { PostgresWriteTransactionContext } from "../app/db/tx/write-transaction";

test("memory source createMany batches postgres inserts into one statement", async () => {
  const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  const tx: PostgresWriteTransactionContext = {
    backend: "postgres",
    now: () => "2026-06-06T00:00:00.000Z",
    nextId: (sequenceName) => `${sequenceName}_${queries.length}_${Math.random().toString(36).slice(2, 4)}`,
    async query<TResult extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<readonly TResult[]> {
      queries.push({ sql, params });
      return [
        {
          id: "memory_source_1",
          memory_id: "memory-1",
          source_type: "doc",
          uri: "file://one.md",
          excerpt: "one",
          confidence: null,
          captured_at: null,
          metadata: {},
          created_at: "2026-06-06T00:00:00.000Z",
          updated_at: "2026-06-06T00:00:00.000Z",
        },
        {
          id: "memory_source_2",
          memory_id: "memory-1",
          source_type: "chat",
          uri: null,
          excerpt: "two",
          confidence: 0.8,
          captured_at: "2026-06-05T00:00:00.000Z",
          metadata: { channel: "codex" },
          created_at: "2026-06-06T00:00:00.000Z",
          updated_at: "2026-06-06T00:00:00.000Z",
        },
      ] as unknown as readonly TResult[];
    },
  };

  const rows = await new MemorySourceRepository().createMany(tx, "memory-1", [
    { sourceType: "doc", uri: "file://one.md", excerpt: "one" },
    { sourceType: "chat", excerpt: "two", confidence: 0.8, capturedAt: "2026-06-05T00:00:00.000Z", metadata: { channel: "codex" } },
  ]);

  assert.equal(queries.length, 1);
  assert.match(queries[0]?.sql ?? "", /VALUES\s+\(\$1, \$2, \$3/u);
  assert.match(queries[0]?.sql ?? "", /\(\$11, \$12, \$13/u);
  assert.equal(rows.length, 2);
});

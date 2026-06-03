import assert from "node:assert/strict";
import test from "node:test";
import { ProjectorEmbeddingResolver } from "../app/qdrant-sync/projector-embedding-resolver";
import type { WriteTransactionRunner, WriteTransactionContext } from "../app/db/tx/write-transaction";

function createFakeProvider(failAttempts: number[]) {
  let callCount = 0;
  return {
    provider: {
      async embed_query(input: { query: string; query_terms: string[] }) {
        callCount++;
        if (failAttempts.includes(callCount)) {
          throw new Error(`Embedding attempt ${callCount} failed`);
        }
        return { embedding: [0.1, 0.2, 0.3], audit: {} };
      },
    },
    get callCount() { return callCount; },
  };
}

function createFakeDatabase(writeBackFails: boolean[] = []): WriteTransactionRunner {
  let callCount = 0;
  const obj: WriteTransactionRunner = {
    async withTransaction<TResult>(
      _work: (tx: WriteTransactionContext) => TResult | Promise<TResult>
    ): Promise<TResult> {
      callCount++;
      if (writeBackFails[callCount - 1]) {
        throw new Error("write-back DB error");
      }
      return undefined as unknown as TResult;
    },
    async snapshot() { return undefined as unknown as Awaited<ReturnType<WriteTransactionRunner["snapshot"]>>; },
    async snapshotForMemoryIds() { return undefined as unknown as Awaited<ReturnType<WriteTransactionRunner["snapshotForMemoryIds"]>>; },
  };
  return obj;
}

test("embedding resolver succeeds on first attempt", async () => {
  const fake = createFakeProvider([]);
  const db = createFakeDatabase();
  const resolver = new ProjectorEmbeddingResolver({
    provider: fake.provider,
    database: db,
    retry: { maxAttempts: 3, baseDelayMs: 10 },
  });

  const result = await resolver.resolve({ memory: { id: "m1", content: "test content" }, snapshot: null });
  assert.deepEqual(result, [0.1, 0.2, 0.3]);
  assert.equal(fake.callCount, 1);
});

test("embedding resolver retries and succeeds on second attempt", async () => {
  const fake = createFakeProvider([1]);
  const db = createFakeDatabase();
  const resolver = new ProjectorEmbeddingResolver({
    provider: fake.provider,
    database: db,
    retry: { maxAttempts: 3, baseDelayMs: 10, backoffMultiplier: 1 },
  });

  const result = await resolver.resolve({ memory: { id: "m1", content: "test content" }, snapshot: null });
  assert.deepEqual(result, [0.1, 0.2, 0.3]);
  assert.equal(fake.callCount, 2);
});

test("embedding resolver returns null after all attempts exhausted", async () => {
  const fake = createFakeProvider([1, 2, 3]);
  const db = createFakeDatabase();
  const resolver = new ProjectorEmbeddingResolver({
    provider: fake.provider,
    database: db,
    retry: { maxAttempts: 3, baseDelayMs: 10, backoffMultiplier: 1 },
  });

  const result = await resolver.resolve({ memory: { id: "m1", content: "test content" }, snapshot: null });
  assert.equal(result, null);
  assert.equal(fake.callCount, 3);
});

test("embedding resolver returns null for empty content", async () => {
  const fake = createFakeProvider([]);
  const db = createFakeDatabase();
  const resolver = new ProjectorEmbeddingResolver({
    provider: fake.provider,
    database: db,
  });

  const result = await resolver.resolve({ memory: { id: "m1", content: "" }, snapshot: null });
  assert.equal(result, null);
  assert.equal(fake.callCount, 0);
});

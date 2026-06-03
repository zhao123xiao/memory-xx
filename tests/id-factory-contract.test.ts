import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryWriteDatabase } from "../app/db/adapters/in-memory-write-database";

test("in-memory write database defaults to production-shaped uuid ids", async () => {
  const database = new InMemoryWriteDatabase();

  const id = await database.withTransaction((tx) => tx.nextId("memory_record"));

  assert.match(id, /^memory_record_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.notEqual(id, "memory_record_000001");
});

test("in-memory write database supports explicit deterministic id factory injection", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-05-31T00:00:00.000Z", {
    idFactory: (sequenceName, nextValue) => `${sequenceName}_deterministic_${String(nextValue).padStart(2, "0")}`
  });

  const ids = await database.withTransaction((tx) => [
    tx.nextId("memory_record"),
    tx.nextId("memory_record")
  ]);

  assert.deepEqual(ids, ["memory_record_deterministic_01", "memory_record_deterministic_02"]);
});

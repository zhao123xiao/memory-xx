import assert from "node:assert/strict";
import test from "node:test";

import type { QueryResultRow } from "pg";

import { KnowledgeScopeGrantRepository } from "../app/db/repositories/knowledge-scope-grant-repository";
import { InMemoryWriteDatabase } from "../app/db/adapters/in-memory-write-database";
import { type PostgresWriteTransactionContext, withWriteTransaction } from "../app/db/tx/write-transaction";

test("knowledge grant postgres mapper treats boolean false strings as false", async () => {
  const tx: PostgresWriteTransactionContext = {
    backend: "postgres",
    now: () => "2026-05-20T10:00:00.000Z",
    nextId: () => "unused",
    async query<TResult extends QueryResultRow = QueryResultRow>(): Promise<readonly TResult[]> {
      return [{ ok: "f" }] as unknown as readonly TResult[];
    },
  };

  assert.equal(
    await new KnowledgeScopeGrantRepository().hasReadGrant(tx, {
      agentId: "agent-a",
      resourceType: "collection",
      resourceId: "docs",
    }),
    false
  );
});

test("knowledge write grants are distinct from read grants", async () => {
  const database = new InMemoryWriteDatabase();
  const repository = new KnowledgeScopeGrantRepository();

  await withWriteTransaction(database, async (tx) => {
    await repository.create(tx, {
      agentId: "agent-a",
      resourceType: "collection",
      resourceId: "docs",
      permissions: ["memory:read"],
      createdBy: "test",
    });
  });

  await withWriteTransaction(database, async (tx) => {
    assert.equal(await repository.hasReadGrant(tx, {
      agentId: "agent-a",
      resourceType: "collection",
      resourceId: "docs",
    }), true);
    assert.equal(await repository.hasWriteGrant(tx, {
      agentId: "agent-a",
      resourceType: "collection",
      resourceId: "docs",
    }), false);
  });
});

test("knowledge write grant accepts explicit write and admin wildcard grants", async () => {
  const database = new InMemoryWriteDatabase();
  const repository = new KnowledgeScopeGrantRepository();

  await withWriteTransaction(database, async (tx) => {
    await repository.create(tx, {
      agentId: "agent-a",
      resourceType: "collection",
      resourceId: "docs",
      permissions: ["memory:write"],
      createdBy: "test",
    });
    await repository.create(tx, {
      agentId: "agent-admin",
      resourceType: "repo",
      resourceId: "*",
      permissions: ["memory:admin"],
      createdBy: "test",
    });
  });

  await withWriteTransaction(database, async (tx) => {
    assert.equal(await repository.hasWriteGrant(tx, {
      agentId: "agent-a",
      resourceType: "collection",
      resourceId: "docs",
    }), true);
    assert.equal(await repository.hasWriteGrant(tx, {
      agentId: "agent-admin",
      resourceType: "repo",
      resourceId: "memory-xx",
    }), true);
  });
});

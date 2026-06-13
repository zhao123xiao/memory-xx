import assert from "node:assert/strict";
import test from "node:test";

import { executeGraphRelationRetargetPlan } from "../app/governance/graph-relation-repair-executor";
import { InMemoryWriteDatabase, LifecycleStatus, ReviewState, ScopeType } from "../app";
import type { GraphRelationRetargetApplyPlan } from "../app/governance/graph-relation-repair-plan";

const now = "2026-06-07T08:00:00.000Z";

function plan(overrides: Partial<GraphRelationRetargetApplyPlan> = {}): GraphRelationRetargetApplyPlan {
  return {
    kind: "graph_relation_retarget",
    relation_id: "rel-1",
    source_memory_id: "source-1",
    old_related_memory_id: "old-target",
    new_related_memory_id: "new-target",
    ...overrides,
  };
}

async function seedDatabase(): Promise<InMemoryWriteDatabase> {
  const database = new InMemoryWriteDatabase(() => now);
  await database.withTransaction((tx) => {
  if (tx.backend !== "memory") throw new Error("expected in-memory tx");
  tx.state.memoryRecords.push(
    {
      id: "source-1",
      requestId: "req-source",
      scopeType: ScopeType.Project,
      scopeId: "memory-xx",
      content: "source",
      title: null,
      summary: null,
      metadata: {},
      dedupeKey: null,
      lifecycleStatus: LifecycleStatus.Approved,
      reviewState: ReviewState.Approved,
      isCurrent: true,
      version: 1,
      createdBy: "test",
      updatedBy: "test",
      createdAt: now,
      updatedAt: now,
      tenantId: "default",
      agentId: "test",
      governanceStatus: "normal",
      visibility: "scope_only",
      memoryType: "fact",
      embeddingGeneration: null,
      memoryLayer: "semantic",
      factStatus: "current",
      validAt: now,
      invalidAt: null,
      observedAt: now,
      expiresAt: null,
      episodeId: null,
      importance: 0.5,
      memoryStrength: 1,
      decayPolicy: "importance_weighted",
    },
    {
      id: "old-target",
      requestId: "req-old",
      scopeType: ScopeType.Project,
      scopeId: "memory-xx",
      content: "old target",
      title: null,
      summary: null,
      metadata: {},
      dedupeKey: null,
      lifecycleStatus: LifecycleStatus.Superseded,
      reviewState: ReviewState.Approved,
      isCurrent: false,
      version: 1,
      createdBy: "test",
      updatedBy: "test",
      createdAt: now,
      updatedAt: now,
      tenantId: "default",
      agentId: "test",
      governanceStatus: "normal",
      visibility: "scope_only",
      memoryType: "fact",
      embeddingGeneration: null,
      memoryLayer: "semantic",
      factStatus: "historical",
      validAt: now,
      invalidAt: now,
      observedAt: now,
      expiresAt: null,
      episodeId: null,
      importance: 0.5,
      memoryStrength: 1,
      decayPolicy: "importance_weighted",
    },
    {
      id: "new-target",
      requestId: "req-new",
      scopeType: ScopeType.Project,
      scopeId: "memory-xx",
      content: "new target",
      title: null,
      summary: null,
      metadata: {},
      dedupeKey: null,
      lifecycleStatus: LifecycleStatus.Approved,
      reviewState: ReviewState.Approved,
      isCurrent: true,
      version: 1,
      createdBy: "test",
      updatedBy: "test",
      createdAt: now,
      updatedAt: now,
      tenantId: "default",
      agentId: "test",
      governanceStatus: "normal",
      visibility: "scope_only",
      memoryType: "fact",
      embeddingGeneration: null,
      memoryLayer: "semantic",
      factStatus: "current",
      validAt: now,
      invalidAt: null,
      observedAt: now,
      expiresAt: null,
      episodeId: null,
      importance: 0.5,
      memoryStrength: 1,
      decayPolicy: "importance_weighted",
    },
  );
  tx.state.memoryRelations.push({
    id: "rel-1",
    memoryId: "source-1",
    relatedMemoryId: "old-target",
    relationType: "supports",
    direction: "outbound",
    weight: 0.8,
    metadata: { existing: true },
    createdAt: now,
    updatedAt: now,
  });
  });
  return database;
}

test("executeGraphRelationRetargetPlan retargets a verified relation and records governance action", async () => {
  const database = await seedDatabase();

  const result = await executeGraphRelationRetargetPlan(database, {
    plan: plan(),
    actorId: "governance-test",
  });

  const snapshot = await database.snapshot();
  const relation = snapshot.memoryRelations.find((item) => item.id === "rel-1");
  assert.equal(result.ok, true);
  assert.equal(result.status, "applied");
  assert.equal(relation?.relatedMemoryId, "new-target");
  assert.equal(relation?.metadata.graph_relation_repair, "retarget_relation_to_successor");
  assert.equal(snapshot.memoryGovernanceActions.length, 1);
  assert.equal(snapshot.memoryGovernanceActions[0]?.actionType, "graph_relation_retarget");
  assert.equal(snapshot.memoryGovernanceActions[0]?.status, "applied");
});

test("executeGraphRelationRetargetPlan blocks when successor is not approved current", async () => {
  const database = await seedDatabase();
  await database.withTransaction((tx) => {
    if (tx.backend !== "memory") throw new Error("expected in-memory tx");
    const successor = tx.state.memoryRecords.find((item) => item.id === "new-target");
    assert.ok(successor);
    tx.state.memoryRecords[tx.state.memoryRecords.indexOf(successor)] = {
      ...successor,
      lifecycleStatus: LifecycleStatus.Candidate,
      reviewState: ReviewState.Pending,
    };
  });

  const result = await executeGraphRelationRetargetPlan(database, {
    plan: plan(),
    actorId: "governance-test",
  });

  const snapshot = await database.snapshot();
  const relation = snapshot.memoryRelations.find((item) => item.id === "rel-1");
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.blocked_reason, "successor_not_approved_current");
  assert.equal(relation?.relatedMemoryId, "old-target");
  assert.equal(snapshot.memoryGovernanceActions[0]?.status, "reported");
  assert.equal(snapshot.memoryGovernanceActions[0]?.evidence.blocked_reason, "successor_not_approved_current");
});

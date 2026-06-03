import assert from "node:assert/strict";
import test from "node:test";

import {
  createInMemoryCoordinationRuntime,
  CoordinationTaskStatus,
  CoordinationTaskType,
  GenerationKind,
  PriorityLane
} from "../../app/coordination";
import { ScopeType, OutboxEventType } from "../../app/shared";
import { OutboxDispatchStatus } from "../../app/shared/contracts/write";
import { resolveAllowedScopeSet } from "../../app/recall";
import type { OutboxEventRow } from "../../app/db/schema/tables";

function createOutboxEventRow(
  overrides: Partial<OutboxEventRow> & Pick<OutboxEventRow, "id" | "eventType" | "payload">
): OutboxEventRow {
  return {
    id: overrides.id,
    aggregateId: overrides.aggregateId ?? "mem-1",
    requestId: overrides.requestId ?? "req-1",
    eventType: overrides.eventType,
    payload: overrides.payload,
    payloadVersion: overrides.payloadVersion ?? 1,
    dispatchStatus: overrides.dispatchStatus ?? OutboxDispatchStatus.Pending,
    attempts: overrides.attempts ?? 0,
    createdAt: overrides.createdAt ?? "2026-04-13T00:00:00.000Z",
    dispatchedAt: overrides.dispatchedAt ?? null
  };
}

test("coordination runtime dispatches cache invalidation end-to-end and collapses duplicate events", async () => {
  const runtime = createInMemoryCoordinationRuntime({
    workerId: "worker-a"
  });
  const event = createOutboxEventRow({
    id: "evt-cache-1",
    eventType: OutboxEventType.CacheInvalidateRequested,
    payload: {
      scopes: [{ type: ScopeType.Project, id: "memory-xx" }],
      priority: PriorityLane.P0Critical
    }
  });

  const dispatched = await runtime.dispatchOutboxRow(event, 100);
  assert.equal(dispatched.status, "applied");
  assert.equal(dispatched.generationBumps.length, 1);
  assert.equal(dispatched.generationBumps[0].key.kind, GenerationKind.Scope);
  assert.equal(dispatched.tasks.length, 1);
  assert.equal(dispatched.tasks[0].accepted, true);

  const backlog = await runtime.getBacklogSnapshot(100);
  const criticalLane = backlog.lanes.find((lane) => lane.lane === PriorityLane.P0Critical);
  assert.equal(criticalLane?.readyCount, 1);

  const firstDrain = await runtime.drainOnce(101);
  const task = await runtime.store.getTask(`evt-cache-1:${CoordinationTaskType.CacheInvalidate}`);
  assert.equal(firstDrain.status, "succeeded");
  assert.equal(task?.status, CoordinationTaskStatus.Succeeded);

  const duplicate = await runtime.dispatchOutboxRow(event, 102);
  assert.equal(duplicate.status, "duplicate_succeeded");

  const generation = await runtime.store.getGeneration({
    kind: GenerationKind.Scope,
    scopeType: ScopeType.Project,
    scopeId: "memory-xx"
  });
  assert.equal(generation.value, 1);

  const afterDuplicateBacklog = await runtime.getBacklogSnapshot(102);
  const duplicatedCriticalLane = afterDuplicateBacklog.lanes.find(
    (lane) => lane.lane === PriorityLane.P0Critical
  );
  assert.equal(duplicatedCriticalLane?.readyCount, 0);
});

test("embedding refresh events only bump vector generation and do not enqueue runtime tasks", async () => {
  const runtime = createInMemoryCoordinationRuntime();
  const event = createOutboxEventRow({
    id: "evt-vector-1",
    eventType: OutboxEventType.MemoryEmbeddingRefreshed,
    payload: {
      scopes: [{ type: ScopeType.Workspace, id: "main" }]
    }
  });

  const dispatched = await runtime.dispatchOutboxRow(event, 200);
  assert.equal(dispatched.status, "applied");
  assert.equal(dispatched.tasks.length, 0);
  assert.equal(dispatched.generationBumps.length, 1);
  assert.equal(dispatched.generationBumps[0].key.kind, GenerationKind.Vector);

  const scopeGeneration = await runtime.store.getGeneration({
    kind: GenerationKind.Scope,
    scopeType: ScopeType.Workspace,
    scopeId: "main"
  });
  const vectorGeneration = await runtime.store.getGeneration({
    kind: GenerationKind.Vector,
    scopeType: ScopeType.Workspace,
    scopeId: "main"
  });
  assert.equal(scopeGeneration.value, 0);
  assert.equal(vectorGeneration.value, 1);
});

test("runtime scope adapter exposes TTL-only run/task scopes to recall scope resolution", async () => {
  let now = 0;
  const runtime = createInMemoryCoordinationRuntime({
    nowProvider: () => now
  });

  await runtime.startRun({
    runId: "run-1",
    ownerId: "worker-a",
    now,
    ttlMs: 1_000
  });
  await runtime.enqueueTask({
    taskId: "task-1",
    taskType: CoordinationTaskType.CacheInvalidate,
    scopes: [{ type: ScopeType.Project, id: "memory-xx" }],
    now,
    runId: "run-1",
    taskContextTtlMs: 500
  });

  const mixed = await resolveAllowedScopeSet(
    {
      query: "project state",
      scope_context: {
        project_ids: ["memory-xx"],
        runtime: {
          run_id: "run-1",
          task_id: "task-1"
        }
      }
    },
    {
      runtime_scope_adapter: runtime.runtimeScopeAdapter
    }
  );
  assert.deepEqual(mixed.runtime_scopes, [
    { type: ScopeType.Task, id: "task-1" },
    { type: ScopeType.Run, id: "run-1" }
  ]);

  now = 600;
  const afterTaskExpiry = await resolveAllowedScopeSet(
    {
      query: "project state",
      scope_context: {
        project_ids: ["memory-xx"],
        runtime: {
          run_id: "run-1",
          task_id: "task-1"
        }
      }
    },
    {
      runtime_scope_adapter: runtime.runtimeScopeAdapter
    }
  );
  assert.deepEqual(afterTaskExpiry.runtime_scopes, [
    { type: ScopeType.Run, id: "run-1" }
  ]);

  now = 1_200;
  const afterRunExpiry = await resolveAllowedScopeSet(
    {
      query: "project state",
      scope_context: {
        project_ids: ["memory-xx"],
        runtime: {
          run_id: "run-1",
          task_id: "task-1"
        }
      }
    },
    {
      runtime_scope_adapter: runtime.runtimeScopeAdapter
    }
  );
  assert.deepEqual(afterRunExpiry.runtime_scopes, []);
});

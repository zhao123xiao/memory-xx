import assert from "node:assert/strict";
import test from "node:test";

import { ScopeType } from "../app/shared";
import {
  CoordinationHandlerRegistry,
  CoordinationDlqManager,
  CoordinationRecoverySweeper,
  CoordinationTaskStatus,
  CoordinationWorker,
  GenerationKind,
  InMemoryCoordinationStore,
  LockScope,
  PresenceState,
  PriorityLane,
  coordinationKeys,
  createCoordinationTask
} from "../app/coordination";

test("coordination keys stay stable and encode scope identifiers", () => {
  assert.equal(
    coordinationKeys.queueLane(PriorityLane.P0Critical),
    "coord:queue:p0_critical:ready"
  );
  assert.equal(
    coordinationKeys.lock(LockScope.Cache, "workspace:alpha/cache"),
    "coord:lock:cache:workspace%3Aalpha%2Fcache"
  );
  assert.equal(
    coordinationKeys.generation({
      kind: GenerationKind.Scope,
      scopeType: ScopeType.Workspace,
      scopeId: "main repo"
    }),
    "coord:generation:scope:workspace:main%20repo"
  );
});

test("generation bump is monotonic and idempotent per source event", async () => {
  const store = new InMemoryCoordinationStore();
  const key = {
    kind: GenerationKind.Scope,
    scopeType: ScopeType.Project,
    scopeId: "memory-xx"
  } as const;

  const initial = await store.getGeneration(key);
  const first = await store.bump({
    key,
    now: 100,
    reason: "memory.updated",
    sourceEventId: "evt-1"
  });
  const duplicate = await store.bump({
    key,
    now: 101,
    reason: "memory.updated",
    sourceEventId: "evt-1"
  });
  const second = await store.bump({
    key,
    now: 102,
    reason: "memory.review.changed",
    sourceEventId: "evt-2"
  });

  assert.equal(initial.value, 0);
  assert.equal(first.value, 1);
  assert.equal(duplicate.value, 1);
  assert.equal(second.value, 2);
});

test("lease, lock, fencing, single-flight, and idempotency semantics hold", async () => {
  const store = new InMemoryCoordinationStore();
  await store.heartbeat({
    workerId: "worker-a",
    now: 0,
    ttlMs: 30_000,
    staleGraceMs: 10_000
  });

  const task = createCoordinationTask({
    taskId: "task-1",
    taskType: "cache.invalidate",
    scopes: [{ type: ScopeType.Workspace, id: "main" }],
    priority: PriorityLane.P1High,
    dedupeKey: "cache:workspace:main",
    idempotencyKey: "event:1",
    singleFlightKey: "cache.invalidate:workspace:main",
    now: 0
  });
  await store.enqueue({ task, now: 0 });

  const claimed = await store.claimNext({
    workerId: "worker-a",
    leaseTtlMs: 10_000,
    now: 1,
    requirePresence: true
  });
  assert.ok(claimed);

  const renewed = await store.renew({
    taskId: "task-1",
    leaseId: claimed!.lease.leaseId,
    ownerId: "worker-a",
    ttlMs: 5_000,
    now: 2_000
  });
  assert.equal(renewed.deadlineAt, 7_000);

  await assert.rejects(() =>
    store.renew({
      taskId: "task-1",
      leaseId: claimed!.lease.leaseId,
      ownerId: "worker-b",
      ttlMs: 5_000,
      now: 2_001
    })
  );

  const lockOne = await store.acquire({
    lockScope: LockScope.Cache,
    resourceId: "workspace:main",
    ownerId: "worker-a",
    ttlMs: 5_000,
    now: 10
  });
  assert.ok(lockOne);
  assert.equal(lockOne!.fencingToken, 1);
  const blocked = await store.acquire({
    lockScope: LockScope.Cache,
    resourceId: "workspace:main",
    ownerId: "worker-b",
    ttlMs: 5_000,
    now: 11
  });
  assert.equal(blocked, null);

  const lockTwo = await store.acquire({
    lockScope: LockScope.Cache,
    resourceId: "workspace:main",
    ownerId: "worker-b",
    ttlMs: 5_000,
    now: 6_100
  });
  assert.ok(lockTwo);
  assert.equal(lockTwo!.fencingToken, 2);
  assert.equal(
    await store.isCurrentToken({
      lockScope: LockScope.Cache,
      resourceId: "workspace:main",
      fencingToken: 1
    }),
    false
  );
  assert.equal(
    await store.isCurrentToken({
      lockScope: LockScope.Cache,
      resourceId: "workspace:main",
      fencingToken: 2
    }),
    true
  );

  const firstFlight = await store.claim({
    key: "cache.invalidate:workspace:main",
    ownerId: "worker-a",
    taskId: "task-1",
    ttlMs: 20_000,
    now: 20
  });
  const secondFlight = await store.claim({
    key: "cache.invalidate:workspace:main",
    ownerId: "worker-b",
    ttlMs: 20_000,
    now: 21
  });
  assert.equal(firstFlight.acquired, true);
  assert.equal(secondFlight.acquired, false);

  const started = await store.start({
    key: "event:1",
    ownerId: "worker-a",
    ttlMs: 20_000,
    now: 30
  });
  assert.equal(started.status, "processing");
  await store.succeed({
    key: "event:1",
    ownerId: "worker-a",
    now: 31,
    result: { ok: true }
  });
  const existing = await store.start({
    key: "event:1",
    ownerId: "worker-b",
    ttlMs: 20_000,
    now: 32
  });
  assert.equal(existing.status, "succeeded");
});

test("worker skeleton can claim, run, and ack a task", async () => {
  const store = new InMemoryCoordinationStore();
  const registry = new CoordinationHandlerRegistry();
  registry.register({
    taskType: "cache.invalidate",
    async handle() {
      return { kind: "succeeded", result: { invalidated: true } };
    }
  });

  await store.enqueue({
    task: createCoordinationTask({
      taskId: "task-worker",
      taskType: "cache.invalidate",
      scopes: [{ type: ScopeType.Workspace, id: "main" }],
      now: 0
    }),
    now: 0
  });

  const worker = new CoordinationWorker({
    workerId: "worker-a",
    handlers: registry,
    queue: store,
    leasePort: store,
    presencePort: store
  });

  const result = await worker.drainOnce(100);
  const task = await store.getTask("task-worker");

  assert.equal(result.status, "succeeded");
  assert.equal(task?.status, CoordinationTaskStatus.Succeeded);
});

test("recovery sweeper and DLQ manager provide minimal closed loop", async () => {
  const store = new InMemoryCoordinationStore();
  await store.heartbeat({
    workerId: "worker-a",
    now: 0,
    ttlMs: 2_000,
    staleGraceMs: 1_000
  });

  const task = createCoordinationTask({
    taskId: "task-recover",
    taskType: "projection.export",
    scopes: [{ type: ScopeType.Project, id: "memory-xx" }],
    priority: PriorityLane.P2Normal,
    maxAttempts: 2,
    now: 0
  });
  await store.enqueue({ task, now: 0 });
  const firstClaim = await store.claimNext({
    workerId: "worker-a",
    leaseTtlMs: 1_000,
    now: 10,
    requirePresence: true
  });
  assert.ok(firstClaim);
  await store.markRunning("task-recover", firstClaim!.lease.leaseId, "worker-a", 11);

  const sweeper = new CoordinationRecoverySweeper({
    queue: store,
    presencePort: store,
    runtimeContextPort: store,
    singleFlightPort: store
  });
  const firstSweep = await sweeper.sweep(1_200);
  const recovered = await store.getTask("task-recover");
  assert.equal(firstSweep.expiredLeaseTasks.length, 1);
  assert.equal(recovered!.status, CoordinationTaskStatus.Recovered);

  await store.heartbeat({
    workerId: "worker-a",
    now: 1_201,
    ttlMs: 2_000,
    staleGraceMs: 1_000
  });
  const secondClaim = await store.claimNext({
    workerId: "worker-a",
    leaseTtlMs: 1_000,
    now: 2_300,
    requirePresence: true
  });
  assert.ok(secondClaim);
  await store.markRunning("task-recover", secondClaim!.lease.leaseId, "worker-a", 2_301);

  await sweeper.sweep(3_500);
  const dlqTask = await store.getTask("task-recover");
  assert.equal(dlqTask!.status, CoordinationTaskStatus.Dlq);

  const dlq = new CoordinationDlqManager(store);
  const replayed = await dlq.replay("task-recover", 4_000, "ops", 500, "manual replay");
  assert.equal(replayed.status, CoordinationTaskStatus.Recovered);
  assert.equal(replayed.recovery?.reason, "dlq_replay");
});

test("presence and runtime context honor TTL-only runtime scope semantics", async () => {
  const store = new InMemoryCoordinationStore();
  await store.putRunContext({
    runId: "run-1",
    ownerId: "worker-a",
    scopes: [{ type: ScopeType.Run, id: "run-1" }],
    startedAt: 0,
    expiresAt: 1_000
  });
  await store.putTaskContext({
    taskId: "task-ctx-1",
    parentRunId: "run-1",
    scopes: [{ type: ScopeType.Task, id: "task-ctx-1" }],
    createdAt: 0,
    expiresAt: 1_000
  });
  await store.heartbeat({
    workerId: "worker-a",
    now: 0,
    ttlMs: 500,
    staleGraceMs: 500
  });

  assert.ok(await store.getRunContext("run-1", 100));
  assert.ok(await store.getTaskContext("task-ctx-1", 100));
  assert.equal((await store.getWorker("worker-a", 100))?.state, PresenceState.Alive);
  assert.equal((await store.getWorker("worker-a", 700))?.state, PresenceState.Stale);
  assert.equal((await store.getWorker("worker-a", 1_100))?.state, PresenceState.Offline);

  const purge = await store.purgeExpired(1_100);
  assert.equal(purge.runsPurged, 1);
  assert.equal(purge.tasksPurged, 1);
  assert.equal(await store.getRunContext("run-1", 1_100), null);
  assert.equal(await store.getTaskContext("task-ctx-1", 1_100), null);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  ArchiveMemoryService,
  CreateMemoryService,
  DatabaseQdrantSyncOutboxRepository,
  InMemoryWriteDatabase,
  LifecycleStatus,
  OutboxDispatchStatus,
  QdrantProjectorWorker,
  ReviewState,
  ScopeType,
  SupersedeMemoryService,
  type CreateMemoryCommand,
  type QdrantProjectionSyncResult
} from "../app";

function createApprovedCommand(
  requestId: string,
  overrides: Partial<CreateMemoryCommand> = {}
): CreateMemoryCommand {
  return {
    requestId,
    actorId: "tester",
    scopeType: ScopeType.Project,
    scopeId: "project-alpha",
    content: "Qdrant outbox worker should sync approved memories.",
    title: "Qdrant worker",
    summary: "outbox skeleton",
    lifecycleStatus: LifecycleStatus.Approved,
    reviewState: ReviewState.NotRequired,
    metadata: {
      embedding: [0.1, 0.2, 0.3]
    },
    sources: [],
    relations: [],
    ...overrides
  };
}

class RecordingProjectionSyncService {
  readonly calls: string[][] = [];

  constructor(
    private readonly behavior: (memoryIds: readonly string[]) => Promise<QdrantProjectionSyncResult>
  ) {}

  async syncMemoryIds(memoryIds: readonly string[]): Promise<QdrantProjectionSyncResult> {
    this.calls.push([...memoryIds]);
    return this.behavior(memoryIds);
  }
}

test("qdrant outbox worker drains pending create event and advances cursor", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T03:00:00.000Z");
  const createService = new CreateMemoryService({ database });
  const created = await createService.execute(createApprovedCommand("req-worker-create"));
  const outboxRepository = new DatabaseQdrantSyncOutboxRepository(database, () => "2026-04-16T03:05:00.000Z");
  const syncService = new RecordingProjectionSyncService(async (memoryIds) => ({
    items: memoryIds.map((memoryId) => ({
      memoryId,
      operation: "upsert",
      reason: "effective_recallable"
    }))
  }));
  const worker = new QdrantProjectorWorker({
    projectionSyncService: syncService,
    outboxRepository,
    clock: () => "2026-04-16T03:05:00.000Z"
  });

  const outcome = await worker.drainOnce();
  const snapshot = await database.snapshot();
  const outboxEvent = snapshot.outboxEvents[0];

  assert.equal(outcome.status, "synced");
  assert.equal(outcome.eventId, created.outboxEventId);
  assert.deepEqual(syncService.calls, [[created.memoryId]]);
  assert.equal(outboxEvent?.dispatchStatus, OutboxDispatchStatus.Dispatched);
  assert.equal(outboxEvent?.attempts, 1);
  assert.equal(outcome.cursor?.lastSuccessfulEventId, created.outboxEventId);
  assert.equal(outcome.cursor?.failureSummary, null);
});

test("qdrant outbox repository claim lock prevents duplicate dispatch accounting", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T03:10:00.000Z");
  const createService = new CreateMemoryService({ database });
  const created = await createService.execute(createApprovedCommand("req-worker-claim"));
  const outboxRepository = new DatabaseQdrantSyncOutboxRepository(database, () => "2026-04-16T03:15:00.000Z");

  const first = await outboxRepository.claimDispatch({
    eventId: created.outboxEventId,
    workerId: "worker-a",
    now: "2026-04-16T03:15:00.000Z",
  });
  const second = await outboxRepository.claimDispatch({
    eventId: created.outboxEventId,
    workerId: "worker-b",
    now: "2026-04-16T03:15:01.000Z",
  });
  const snapshot = await database.snapshot();

  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(snapshot.outboxEvents[0]?.dispatchedBy, "worker-a");
  assert.equal(snapshot.outboxEvents[0]?.dispatchStartedAt, "2026-04-16T03:15:00.000Z");
});

test("qdrant outbox repository atomically claims processable events", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T03:20:00.000Z");
  const createService = new CreateMemoryService({ database });
  const first = await createService.execute(createApprovedCommand("req-worker-atomic-1"));
  const second = await createService.execute(createApprovedCommand("req-worker-atomic-2", {
    content: "Qdrant outbox worker should atomically claim the next event.",
  }));
  const outboxRepository = new DatabaseQdrantSyncOutboxRepository(database, () => "2026-04-16T03:25:00.000Z");

  const claimedByA = await outboxRepository.claimProcessableEvents({
    exporterName: "qdrant_projector",
    workerId: "worker-a",
    limit: 1,
    now: "2026-04-16T03:25:00.000Z",
  });
  const claimedByB = await outboxRepository.claimProcessableEvents({
    exporterName: "qdrant_projector",
    workerId: "worker-b",
    limit: 2,
    now: "2026-04-16T03:25:01.000Z",
  });

  assert.deepEqual(claimedByA.map((event) => event.id), [first.outboxEventId]);
  assert.deepEqual(claimedByB.map((event) => event.id), [second.outboxEventId]);
  const snapshot = await database.snapshot();
  assert.equal(snapshot.outboxEvents.find((event) => event.id === first.outboxEventId)?.dispatchedBy, "worker-a");
  assert.equal(snapshot.outboxEvents.find((event) => event.id === second.outboxEventId)?.dispatchedBy, "worker-b");
});

test("qdrant outbox worker retries transient sync failures without advancing cursor", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T04:00:00.000Z");
  const createService = new CreateMemoryService({ database });
  const created = await createService.execute(createApprovedCommand("req-worker-retry"));
  const outboxRepository = new DatabaseQdrantSyncOutboxRepository(database, () => "2026-04-16T04:05:00.000Z");
  const worker = new QdrantProjectorWorker({
    projectionSyncService: new RecordingProjectionSyncService(async () => {
      throw new Error("qdrant temporarily unavailable");
    }),
    outboxRepository,
    maxAttempts: 3,
    retryDelayMs: 12_000,
    clock: () => "2026-04-16T04:05:00.000Z"
  });

  const outcome = await worker.drainOnce();
  const snapshot = await database.snapshot();
  const outboxEvent = snapshot.outboxEvents[0];

  assert.equal(outcome.status, "retried");
  assert.equal(outcome.eventId, created.outboxEventId);
  assert.equal(outcome.retryAfterMs, 12_000);
  assert.equal(outboxEvent?.dispatchStatus, OutboxDispatchStatus.Failed);
  assert.equal(outboxEvent?.attempts, 1);
  assert.equal(outcome.cursor?.lastSuccessfulEventId, null);
  assert.equal(outcome.cursor?.failureSummary, "qdrant temporarily unavailable");
});

test("qdrant outbox worker retries failed projection skips without advancing cursor", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T04:30:00.000Z");
  const createService = new CreateMemoryService({ database });
  const created = await createService.execute(createApprovedCommand("req-worker-failed-skip"));
  const outboxRepository = new DatabaseQdrantSyncOutboxRepository(database, () => "2026-04-16T04:35:00.000Z");
  const worker = new QdrantProjectorWorker({
    projectionSyncService: new RecordingProjectionSyncService(async (memoryIds) => ({
      items: memoryIds.map((memoryId) => ({
        memoryId,
        operation: "skip",
        reason: "embedding_missing",
      })),
    })),
    outboxRepository,
    maxAttempts: 3,
    clock: () => "2026-04-16T04:35:00.000Z"
  });

  const outcome = await worker.drainOnce();
  const snapshot = await database.snapshot();
  const outboxEvent = snapshot.outboxEvents[0];

  assert.equal(outcome.status, "retried");
  assert.equal(outcome.eventId, created.outboxEventId);
  assert.equal(outboxEvent?.dispatchStatus, OutboxDispatchStatus.Failed);
  assert.equal(outboxEvent?.projectionVerified, false);
  assert.equal(outboxEvent?.attempts, 1);
  assert.equal(outcome.cursor?.lastSuccessfulEventId, null);
  assert.match(outcome.error ?? "", /qdrant_projection_incomplete/);
});

test("qdrant outbox worker moves terminal failures to dead-letter boundary after max attempts", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T05:00:00.000Z");
  const createService = new CreateMemoryService({ database });
  const created = await createService.execute(createApprovedCommand("req-worker-dlq"));
  const outboxRepository = new DatabaseQdrantSyncOutboxRepository(database, () => "2026-04-16T05:05:00.000Z");
  const worker = new QdrantProjectorWorker({
    projectionSyncService: new RecordingProjectionSyncService(async () => {
      throw new Error("qdrant permanent failure");
    }),
    outboxRepository,
    maxAttempts: 1,
    clock: () => "2026-04-16T05:05:00.000Z"
  });

  const outcome = await worker.drainOnce();
  const snapshot = await database.snapshot();
  const outboxEvent = snapshot.outboxEvents[0];

  assert.equal(outcome.status, "dead_letter");
  assert.equal(outcome.eventId, created.outboxEventId);
  assert.equal(outboxEvent?.dispatchStatus, OutboxDispatchStatus.Failed);
  assert.equal(outboxEvent?.attempts, 1);
  assert.match(outcome.cursor?.failureSummary ?? "", /^dead-letter:/);
});

test("qdrant outbox worker syncs both superseded and replacement ids from outbox payload", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T06:00:00.000Z");
  const createService = new CreateMemoryService({ database });
  const seed = await createService.execute(createApprovedCommand("req-worker-supersede-seed"));
  const supersedeService = new SupersedeMemoryService({ database });
  await supersedeService.execute({
    requestId: "req-worker-supersede",
    actorId: "reviewer",
    memoryId: seed.memoryId,
    content: "Replacement content",
    title: "replacement",
    summary: null,
    metadata: { embedding: [0.9, 0.8, 0.7] },
    reviewState: ReviewState.NotRequired,
    sources: [],
    relations: []
  });

  const outboxRepository = new DatabaseQdrantSyncOutboxRepository(database, () => "2026-04-16T06:05:00.000Z");
  const calls: string[][] = [];
  const worker = new QdrantProjectorWorker({
    projectionSyncService: new RecordingProjectionSyncService(async (memoryIds) => {
      calls.push([...memoryIds]);
      return { items: [] };
    }),
    outboxRepository,
    clock: () => "2026-04-16T06:05:00.000Z"
  });

  const first = await worker.drainOnce();
  const second = await worker.drainOnce();

  assert.equal(first.status, "synced");
  assert.equal(second.status, "synced");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]?.length, 2);
  assert.equal(calls[1]?.[0], seed.memoryId);
  assert.notEqual(calls[1]?.[1], seed.memoryId);
});

test("qdrant outbox worker can process archive event after create cursor has advanced", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T07:00:00.000Z");
  const createService = new CreateMemoryService({ database });
  const created = await createService.execute(createApprovedCommand("req-worker-archive-seed"));
  const archiveService = new ArchiveMemoryService({ database });
  await archiveService.execute({
    requestId: "req-worker-archive",
    actorId: "reviewer",
    memoryId: created.memoryId
  });
  const calls: string[][] = [];
  const outboxRepository = new DatabaseQdrantSyncOutboxRepository(database, () => "2026-04-16T07:05:00.000Z");
  const worker = new QdrantProjectorWorker({
    projectionSyncService: new RecordingProjectionSyncService(async (memoryIds) => {
      calls.push([...memoryIds]);
      return { items: [] };
    }),
    outboxRepository,
    clock: () => "2026-04-16T07:05:00.000Z"
  });

  await worker.drainOnce();
  const outcome = await worker.drainOnce();

  assert.equal(outcome.status, "synced");
  assert.deepEqual(calls, [[created.memoryId], [created.memoryId]]);
});

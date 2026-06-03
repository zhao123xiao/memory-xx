import assert from "node:assert/strict";
import test from "node:test";

import {
  CreateMemoryService,
  DatabaseQdrantSyncOutboxRepository,
  InMemoryWriteDatabase,
  LifecycleStatus,
  OutboxDispatchStatus,
  RepairByMemoryIdService,
  ReplayQdrantExporterEventsService,
  ReplayQdrantOutboxEventService,
  ReviewState,
  ScopeType,
  SnapshotQdrantReplayRepairRepository,
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
    content: "Replay/repair should support explicit event_id repair.",
    title: "replay",
    summary: "repair",
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

test("qdrant replay by event_id repairs projection without mutating outbox state by default", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T08:00:00.000Z");
  const createService = new CreateMemoryService({ database });
  const created = await createService.execute(createApprovedCommand("req-replay-event"));
  const outboxRepository = new DatabaseQdrantSyncOutboxRepository(database, () => "2026-04-16T08:05:00.000Z");
  const replayRepository = new SnapshotQdrantReplayRepairRepository(database);
  const syncService = new RecordingProjectionSyncService(async (memoryIds) => ({
    items: memoryIds.map((memoryId) => ({
      memoryId,
      operation: "upsert",
      reason: "effective_recallable"
    }))
  }));
  const replayService = new ReplayQdrantOutboxEventService({
    projectionSyncService: syncService,
    replayRepository,
    outboxRepository,
    clock: () => "2026-04-16T08:05:00.000Z"
  });

  const outcome = await replayService.execute({ eventId: created.outboxEventId });
  const snapshot = await database.snapshot();
  const outboxEvent = snapshot.outboxEvents[0];
  const cursor = snapshot.exporterState[0];

  assert.equal(outcome.mode, "event_id");
  assert.equal(outcome.mutatedOutboxState, false);
  assert.equal(outcome.eventStatusBefore, OutboxDispatchStatus.Pending);
  assert.equal(outcome.attemptsBefore, 0);
  assert.deepEqual(syncService.calls, [[created.memoryId]]);
  assert.equal(outboxEvent?.dispatchStatus, OutboxDispatchStatus.Pending);
  assert.equal(outboxEvent?.attempts, 0);
  assert.equal(cursor, undefined);
});

test("qdrant replay by event_id can explicitly mark the exact event dispatched", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T09:00:00.000Z");
  const createService = new CreateMemoryService({ database });
  const created = await createService.execute(createApprovedCommand("req-replay-mark"));
  const outboxRepository = new DatabaseQdrantSyncOutboxRepository(database, () => "2026-04-16T09:05:00.000Z");
  const replayService = new ReplayQdrantOutboxEventService({
    projectionSyncService: new RecordingProjectionSyncService(async (memoryIds) => ({
      items: memoryIds.map((memoryId) => ({
        memoryId,
        operation: "upsert",
        reason: "effective_recallable"
      }))
    })),
    replayRepository: new SnapshotQdrantReplayRepairRepository(database),
    outboxRepository,
    clock: () => "2026-04-16T09:05:00.000Z"
  });

  const outcome = await replayService.execute({
    eventId: created.outboxEventId,
    markDispatched: true
  });
  const snapshot = await database.snapshot();
  const outboxEvent = snapshot.outboxEvents[0];
  const cursor = snapshot.exporterState[0];

  assert.equal(outcome.mutatedOutboxState, true);
  assert.equal(outboxEvent?.dispatchStatus, OutboxDispatchStatus.Dispatched);
  assert.equal(outboxEvent?.attempts, 1);
  assert.equal(cursor?.lastSuccessfulEventId, created.outboxEventId);
});

test("qdrant replay by exporter replays failed and pending events without mutating state by default", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T10:00:00.000Z");
  const createService = new CreateMemoryService({ database });
  const first = await createService.execute(createApprovedCommand("req-replay-batch-first"));
  const second = await createService.execute(
    createApprovedCommand("req-replay-batch-second", {
      content: "Replay/repair should also process a second distinct pending event."
    })
  );
  const outboxRepository = new DatabaseQdrantSyncOutboxRepository(database, () => "2026-04-16T10:05:00.000Z");
  await outboxRepository.markRetry({
    eventId: first.outboxEventId,
    failureMessage: "temporary qdrant failure",
    now: "2026-04-16T10:05:00.000Z"
  });
  const syncService = new RecordingProjectionSyncService(async (memoryIds) => ({
    items: memoryIds.map((memoryId) => ({
      memoryId,
      operation: "upsert",
      reason: "effective_recallable"
    }))
  }));
  const replayService = new ReplayQdrantExporterEventsService({
    projectionSyncService: syncService,
    replayRepository: new SnapshotQdrantReplayRepairRepository(database),
    outboxRepository,
    clock: () => "2026-04-16T10:06:00.000Z"
  });

  const outcome = await replayService.execute({
    statuses: [OutboxDispatchStatus.Failed, OutboxDispatchStatus.Pending],
    limit: 10
  });
  const snapshot = await database.snapshot();

  assert.equal(outcome.mode, "exporter_status");
  assert.equal(outcome.mutatedOutboxState, false);
  assert.equal(outcome.processedCount, 2);
  assert.deepEqual(syncService.calls, [[first.memoryId], [second.memoryId]]);
  assert.equal(snapshot.outboxEvents.find((row) => row.id === first.outboxEventId)?.dispatchStatus, OutboxDispatchStatus.Failed);
  assert.equal(snapshot.outboxEvents.find((row) => row.id === second.outboxEventId)?.dispatchStatus, OutboxDispatchStatus.Pending);
  assert.equal(snapshot.exporterState[0]?.lastSuccessfulEventId, null);
});

test("qdrant replay by exporter can explicitly mark replayed events dispatched", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T11:00:00.000Z");
  const createService = new CreateMemoryService({ database });
  const first = await createService.execute(createApprovedCommand("req-replay-batch-mark-first"));
  const second = await createService.execute(
    createApprovedCommand("req-replay-batch-mark-second", {
      content: "Replay/repair mark-dispatched should process the second distinct pending event."
    })
  );
  const outboxRepository = new DatabaseQdrantSyncOutboxRepository(database, () => "2026-04-16T11:05:00.000Z");
  const replayService = new ReplayQdrantExporterEventsService({
    projectionSyncService: new RecordingProjectionSyncService(async (memoryIds) => ({
      items: memoryIds.map((memoryId) => ({
        memoryId,
        operation: "upsert",
        reason: "effective_recallable"
      }))
    })),
    replayRepository: new SnapshotQdrantReplayRepairRepository(database),
    outboxRepository,
    clock: () => "2026-04-16T11:05:00.000Z"
  });

  const outcome = await replayService.execute({
    statuses: [OutboxDispatchStatus.Pending],
    limit: 2,
    markDispatched: true
  });
  const snapshot = await database.snapshot();

  assert.equal(outcome.processedCount, 2);
  assert.equal(outcome.mutatedOutboxState, true);
  assert.equal(snapshot.outboxEvents.every((row) => row.dispatchStatus === OutboxDispatchStatus.Dispatched), true);
  assert.equal(snapshot.outboxEvents.every((row) => row.attempts === 1), true);
  assert.equal(snapshot.exporterState[0]?.lastSuccessfulEventId, second.outboxEventId);
  assert.equal(snapshot.exporterState[0]?.cursor, second.outboxEventId);
  assert.equal(snapshot.exporterState[0]?.failureSummary, null);
});

test("qdrant repair by memory_id re-syncs only the requested memory without mutating outbox or cursor", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T09:30:00.000Z");
  const createService = new CreateMemoryService({ database });
  const created = await createService.execute(createApprovedCommand("req-repair-memory-id"));
  const syncService = new RecordingProjectionSyncService(async (memoryIds) => ({
    items: memoryIds.map((memoryId) => ({
      memoryId,
      operation: "upsert",
      reason: "effective_recallable"
    }))
  }));
  const repairService = new RepairByMemoryIdService({
    projectionSyncService: syncService
  });

  const outcome = await repairService.execute({
    memoryIds: [created.memoryId]
  });
  const snapshot = await database.snapshot();

  assert.equal(outcome.mode, "memory_id");
  assert.equal(outcome.mutatedOutboxState, false);
  assert.deepEqual(outcome.memoryIds, [created.memoryId]);
  assert.deepEqual(syncService.calls, [[created.memoryId]]);
  assert.equal(snapshot.outboxEvents[0]?.dispatchStatus, OutboxDispatchStatus.Pending);
  assert.equal(snapshot.outboxEvents[0]?.attempts, 0);
  assert.equal(snapshot.exporterState[0], undefined);
});

test("qdrant replay derives both superseded and replacement ids for explicit repair", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T10:00:00.000Z");
  const createService = new CreateMemoryService({ database });
  const seed = await createService.execute(createApprovedCommand("req-replay-supersede-seed"));
  const supersedeService = new SupersedeMemoryService({ database });
  const superseded = await supersedeService.execute({
    requestId: "req-replay-supersede",
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
  const replayService = new ReplayQdrantOutboxEventService({
    projectionSyncService: new RecordingProjectionSyncService(async (memoryIds) => ({
      items: memoryIds.map((memoryId) => ({
        memoryId,
        operation: "upsert",
        reason: "effective_recallable"
      }))
    })),
    replayRepository: new SnapshotQdrantReplayRepairRepository(database)
  });

  const outcome = await replayService.execute({ eventId: superseded.outboxEventId });

  assert.equal(outcome.memoryIds.length, 2);
  assert.equal(outcome.memoryIds.includes(seed.memoryId), true);
  assert.equal(
    outcome.memoryIds.some((memoryId) => memoryId !== seed.memoryId),
    true
  );
});

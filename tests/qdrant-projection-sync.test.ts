import assert from "node:assert/strict";
import test from "node:test";

import {
  ArchiveMemoryService,
  CreateMemoryService,
  InMemoryWriteDatabase,
  LifecycleStatus,
  QdrantProjectionSyncService,
  ReviewState,
  ScopeType,
  mapMemoryIdToQdrantPointId,
  projectionLifecycleOperation,
  SupersedeMemoryService,
  type CreateMemoryCommand,
  type QdrantPointUpsert,
  type ReviewLifecycleServiceDependencies,
  type WriteDatabaseState,
  type WriteTransactionContext
} from "../app";


function makeTestEmbedding(seed: number, dims = 4096): number[] {
  const vec = new Array<number>(dims);
  for (let i = 0; i < dims; i++) {
    vec[i] = Math.sin(seed + i * 0.001) * 0.1;
  }
  return vec;
}


class RecordingPointWriter {
  readonly upserts: QdrantPointUpsert[][] = [];
  readonly deletes: string[][] = [];
  readonly payloads = new Map<string, Record<string, unknown>>();

  async upsert(points: readonly QdrantPointUpsert[]): Promise<void> {
    this.upserts.push([...points]);
    for (const point of points) {
      this.payloads.set(point.id, point.payload as unknown as Record<string, unknown>);
    }
  }

  async delete(pointIds: readonly string[]): Promise<void> {
    this.deletes.push([...pointIds]);
    for (const pointId of pointIds) {
      this.payloads.delete(pointId);
    }
  }

  async retrieve(pointIds: readonly string[]): Promise<ReadonlyMap<string, { readonly payload?: Record<string, unknown> }>> {
    const rows = new Map<string, { readonly payload?: Record<string, unknown> }>();
    for (const pointId of pointIds) {
      const payload = this.payloads.get(pointId);
      if (payload) rows.set(pointId, { payload });
    }
    return rows;
  }
}

class FlakyVerifyPointWriter extends RecordingPointWriter {
  retrieveCalls = 0;
  constructor(private readonly failFirstCalls: number, private readonly mismatchAlways = false) {
    super();
  }

  override async retrieve(pointIds: readonly string[]): Promise<ReadonlyMap<string, { readonly payload?: Record<string, unknown> }>> {
    this.retrieveCalls++;
    if (this.retrieveCalls <= this.failFirstCalls) {
      throw new Error("temporary qdrant retrieve failure");
    }
    const rows = await super.retrieve(pointIds);
    if (!this.mismatchAlways) return rows;
    const mismatched = new Map<string, { readonly payload?: Record<string, unknown> }>();
    for (const [id, row] of rows.entries()) {
      mismatched.set(id, { payload: { ...(row.payload ?? {}), projection_hash: "wrong" } });
    }
    return mismatched;
  }
}

class SnapshotOnlyDatabase {
  constructor(private readonly state: WriteDatabaseState) {}

  async snapshot(): Promise<WriteDatabaseState> {
    return this.state;
  }

  async snapshotForMemoryIds(memoryIds: readonly string[]): Promise<WriteDatabaseState> {
    const idSet = new Set(memoryIds);
    return {
      memoryRecords: this.state.memoryRecords.filter((r) => idSet.has(r.id)),
      memorySources: this.state.memorySources.filter((r) => idSet.has(r.memoryId)),
      memoryRelations: this.state.memoryRelations.filter((r) => idSet.has(r.memoryId)),
      memoryEvents: [],
      ingestRequests: [],
      outboxEvents: [],
      migrationAudit: [],
      exporterState: [],
      lowConfidenceBuffer: [],
      writeTickets: [],
      writeTicketsArchive: [],
      memoryFeedbackEvents: [],
      recallTraces: [],
      recallFeedbackEvents: [],
      recallRepairQueue: [],
      cacheInvalidationRequests: [],
      knowledgeScopeGrants: [],
      intelligenceCompareObservations: [],
      scopeGenerations: [],
      trustedAgents: [],
      sequences: { ...this.state.sequences }
    };
  }

  async withTransaction<TResult>(
    _work: (tx: WriteTransactionContext) => TResult | Promise<TResult>
  ): Promise<TResult> {
    throw new Error("SnapshotOnlyDatabase does not support transactions.");
  }
}

function createApprovedCommand(
  requestId: string,
  overrides: Partial<CreateMemoryCommand> = {}
): CreateMemoryCommand {
  return {
    requestId,
    actorId: "tester",
    scopeType: ScopeType.Project,
    scopeId: "project-alpha",
    content: "Qdrant primary runtime should index approved memories.",
    title: "Qdrant sync",
    summary: "projection skeleton",
    lifecycleStatus: LifecycleStatus.Approved,
    reviewState: ReviewState.NotRequired,
    metadata: {
      tags: ["qdrant", "projection"],
      entity_names: ["memory-xx"],
      section: "ops/qdrant",
      canonical_section: "operations/qdrant",
      memory_type: "decision",
      embedding: makeTestEmbedding(1)
    },
    sources: [
      {
        sourceType: "doc",
        uri: "file://docs/qdrant-sync.md",
        excerpt: "approved memories should be projected"
      }
    ],
    relations: [],
    ...overrides
  };
}

test("qdrant projection sync upserts effective-recallable records with recall payload", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T02:00:00.000Z");
  const pointWriter = new RecordingPointWriter();
  const service = new CreateMemoryService({ database });
  const result = await service.execute(createApprovedCommand("req-qdrant-upsert"));

  const projector = new QdrantProjectionSyncService({
    database,
    pointWriter
  });
  const syncResult = await projector.syncWriteResult(result);

  assert.deepEqual(syncResult.items, [
    {
      memoryId: result.memoryId,
      operation: "upsert",
      reason: "effective_recallable"
    }
  ]);
  assert.equal(pointWriter.upserts.length, 1);
  assert.equal(pointWriter.deletes.length, 0);
  const upsert = pointWriter.upserts[0][0];
  assert.equal(upsert.id, mapMemoryIdToQdrantPointId(result.memoryId));
  assert.deepEqual(upsert.vector, makeTestEmbedding(1));
  assert.equal(upsert.payload.project_id, "project-alpha");
  assert.equal(upsert.payload.scope_type, ScopeType.Project);
  assert.equal(upsert.payload.source_path, "file://docs/qdrant-sync.md");
  assert.equal(upsert.payload.source_type, "doc");
  assert.equal(upsert.payload.trust_level, "legacy_unclassified");
  assert.deepEqual(upsert.payload.tags, ["qdrant", "projection"]);
  assert.equal(upsert.payload.lifecycle_status, LifecycleStatus.Approved);
  assert.equal(upsert.payload.relation_count, 0);
});

test("qdrant projection sync deletes approved records excluded from default recall policy", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T02:00:00.000Z");
  const pointWriter = new RecordingPointWriter();
  const service = new CreateMemoryService({ database });
  const result = await service.execute(createApprovedCommand("req-qdrant-explicit-only", {
    metadata: {
      embedding: makeTestEmbedding(2),
      memory_class: "operational_issue",
      recall_policy: "explicit_only",
    },
  }));

  const projector = new QdrantProjectionSyncService({
    database,
    pointWriter,
  });
  const syncResult = await projector.syncWriteResult(result);

  assert.deepEqual(syncResult.items, [
    {
      memoryId: result.memoryId,
      operation: "delete",
      reason: "not_effective_recallable",
    },
  ]);
  assert.equal(pointWriter.upserts.length, 0);
  assert.deepEqual(pointWriter.deletes, [[mapMemoryIdToQdrantPointId(result.memoryId)]]);
});

test("projection lifecycle treats non-default recall policy as non-recallable", () => {
  assert.equal(projectionLifecycleOperation({
    lifecycleStatus: LifecycleStatus.Approved,
    reviewState: ReviewState.SilentApproved,
    isCurrent: true,
    metadata: { recall_policy: "test_only" },
  }), "delete_point");
});

test("projector prefers live PG content_embedding over resolver and metadata fallbacks", async () => {
  const pointWriter = new RecordingPointWriter();
  const database = new SnapshotOnlyDatabase({
    ingestRequests: [],
    memoryRecords: [
      {
        id: "memory-live-pg",
        requestId: "req-live-pg",
        scopeType: ScopeType.Project,
        scopeId: "project-alpha",
        content: "Live PG embedding should drive Qdrant upsert.",
        title: "live PG embedding",
        summary: null,
        metadata: {
          embedding: makeTestEmbedding(9)
        },
        contentEmbedding: makeTestEmbedding(3),
        dedupeKey: null,
        lifecycleStatus: LifecycleStatus.Approved,
        reviewState: ReviewState.NotRequired,
        isCurrent: true,
        version: 1,
        createdBy: "tester",
        updatedBy: "tester",
        createdAt: "2026-04-16T02:00:00.000Z",
        updatedAt: "2026-04-16T02:00:00.000Z",
        tenantId: "default",
        agentId: "tester",
        governanceStatus: "normal",
        visibility: "scope_only",
        memoryType: null,
        embeddingGeneration: null,
        memoryLayer: "recall",
        factStatus: "current",
        validAt: null,
        invalidAt: null,
        observedAt: null,
        expiresAt: null,
        episodeId: null,
        importance: 0.5,
        memoryStrength: 1.0,
        decayPolicy: "importance_weighted"
      }
    ],
    memorySources: [],
    memoryRelations: [],
    memoryEvents: [],
    outboxEvents: [],
    migrationAudit: [],
      exporterState: [],
      lowConfidenceBuffer: [],
      writeTickets: [],
      writeTicketsArchive: [],
      memoryFeedbackEvents: [],
      recallTraces: [],
      recallFeedbackEvents: [],
      recallRepairQueue: [],
      cacheInvalidationRequests: [],
      knowledgeScopeGrants: [],
      intelligenceCompareObservations: [],
      scopeGenerations: [],
      sequences: {
        memory_record: 0,
        memory_source: 0,
        memory_relation: 0,
        memory_event: 0,
        outbox_event: 0,
        migration_audit: 0,
        low_confidence_buffer: 0,
        write_ticket: 0,
        memory_feedback_event: 0,
        recall_trace: 0,
        recall_feedback_event: 0,
        recall_repair_queue: 0,
        cache_invalidation_request: 0,
        knowledge_scope_grant: 0,
        intelligence_compare_observation: 0
      },
      trustedAgents: []
  });

  let resolverCalls = 0;
  const projector = new QdrantProjectionSyncService({
    database,
    pointWriter,
    embeddingResolver: {
      resolve: async () => {
        resolverCalls += 1;
        return [1.1, 1.2, 1.3];
      }
    }
  });

  const syncResult = await projector.syncMemoryIds(["memory-live-pg"]);

  assert.deepEqual(syncResult.items, [
    {
      memoryId: "memory-live-pg",
      operation: "upsert",
      reason: "effective_recallable"
    }
  ]);
  assert.equal(resolverCalls, 0);
  assert.deepEqual(pointWriter.upserts[0]?.[0]?.vector, makeTestEmbedding(3));
});

test("archive sync deletes the active qdrant point", async () => {
  const database = new InMemoryWriteDatabase();
  const pointWriter = new RecordingPointWriter();
  const projector = new QdrantProjectionSyncService({ database, pointWriter });
  const createService = new CreateMemoryService({ database });
  const created = await createService.execute(createApprovedCommand("req-qdrant-archive-seed"));

  const archiveService = new ArchiveMemoryService({ database });
  const archived = await archiveService.execute({
    requestId: "req-qdrant-archive",
    actorId: "governor",
    memoryId: created.memoryId
  });

  const syncResult = await projector.syncWriteResult(archived);
  assert.deepEqual(syncResult.items, [
    {
      memoryId: created.memoryId,
      operation: "delete",
      reason: "not_effective_recallable"
    }
  ]);
  assert.deepEqual(pointWriter.deletes, [[mapMemoryIdToQdrantPointId(created.memoryId)]]);
  assert.deepEqual(pointWriter.upserts, []);
});

test("supersede sync deletes old point and upserts replacement point", async () => {
  const database = new InMemoryWriteDatabase();
  const pointWriter = new RecordingPointWriter();
  const projector = new QdrantProjectionSyncService({ database, pointWriter });
  const createService = new CreateMemoryService({ database });
  const created = await createService.execute(createApprovedCommand("req-qdrant-supersede-seed"));

  const supersedeService = new SupersedeMemoryService({ database });
  const superseded = await supersedeService.execute({
    requestId: "req-qdrant-supersede",
    actorId: "governor",
    memoryId: created.memoryId,
    content: "Replacement memory content.",
    title: "Qdrant sync v2",
    summary: "replacement",
    metadata: {
      embedding: makeTestEmbedding(7),
      tags: ["replacement"]
    },
    reviewState: ReviewState.NotRequired,
    sources: [],
    relations: []
  });

  const syncResult = await projector.syncWriteResult(superseded);
  assert.equal(syncResult.items.length, 2);
  assert.deepEqual(syncResult.items[0], {
    memoryId: created.memoryId,
    operation: "delete",
    reason: "superseded"
  });
  assert.deepEqual(syncResult.items[1], {
    memoryId: superseded.memoryId,
    operation: "upsert",
    reason: "effective_recallable"
  });
  assert.deepEqual(pointWriter.deletes, [[mapMemoryIdToQdrantPointId(created.memoryId)]]);
  assert.equal(pointWriter.upserts.length, 1);
  assert.equal(pointWriter.upserts[0][0].id, mapMemoryIdToQdrantPointId(superseded.memoryId));
  assert.deepEqual(pointWriter.upserts[0][0].vector, makeTestEmbedding(7));
});

test("write-chain seam can invoke projection sync service after create commit", async () => {
  const database = new InMemoryWriteDatabase();
  const pointWriter = new RecordingPointWriter();
  const projectionSyncService = new QdrantProjectionSyncService({
    database,
    pointWriter
  });
  const createService = new CreateMemoryService({
    database,
    projectionSyncService
  });

  await createService.execute(createApprovedCommand("req-qdrant-seam"));

  assert.equal(pointWriter.upserts.length, 1);
  assert.equal(pointWriter.upserts[0].length, 1);
});

test("projection sync skips an upsert when qdrant already has the same projection hash", async () => {
  const database = new InMemoryWriteDatabase();
  const pointWriter = new RecordingPointWriter();
  const projector = new QdrantProjectionSyncService({ database, pointWriter });
  const createService = new CreateMemoryService({ database });
  const created = await createService.execute(createApprovedCommand("req-qdrant-idempotent"));

  const first = await projector.syncWriteResult(created);
  const second = await projector.syncWriteResult(created);

  assert.equal(first.items[0]?.operation, "upsert");
  assert.deepEqual(second.items, [
    {
      memoryId: created.memoryId,
      operation: "skip",
      reason: "projection_idempotent"
    }
  ]);
  assert.equal(pointWriter.upserts.length, 1);
});

test("projection verifyReadback retries transient retrieve failures", async () => {
  const database = new InMemoryWriteDatabase();
  const pointWriter = new FlakyVerifyPointWriter(1);
  process.env.MEMORY_XX_QDRANT_VERIFY_READBACK = "true";
  const projector = new QdrantProjectionSyncService({ database, pointWriter });
  delete process.env.MEMORY_XX_QDRANT_VERIFY_READBACK;
  const createService = new CreateMemoryService({ database });
  const created = await createService.execute(createApprovedCommand("req-qdrant-verify-retry"));

  const result = await projector.syncWriteResult(created);

  assert.equal(result.items[0]?.operation, "upsert");
  assert.equal(pointWriter.retrieveCalls, 2);
  assert.equal(pointWriter.upserts.length, 1);
});

test("projection verifyReadback marks only mismatched upserts as failed", async () => {
  const database = new InMemoryWriteDatabase();
  const pointWriter = new FlakyVerifyPointWriter(0, true);
  process.env.MEMORY_XX_QDRANT_VERIFY_READBACK = "true";
  const projector = new QdrantProjectionSyncService({ database, pointWriter });
  delete process.env.MEMORY_XX_QDRANT_VERIFY_READBACK;
  const createService = new CreateMemoryService({ database });
  const created = await createService.execute(createApprovedCommand("req-qdrant-verify-mismatch"));

  const result = await projector.syncWriteResult(created);

  assert.deepEqual(result.items, [
    {
      memoryId: created.memoryId,
      operation: "skip",
      reason: "projection_verify_failed",
    },
  ]);
  assert.equal(pointWriter.upserts.length, 1);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQdrantProjectionIssue,
  diffQdrantProjectionConsistency,
  evaluateMemoryAutoRepairPlan,
  LifecycleStatus,
  mapPostgresProjectionRow,
  mapMemoryIdToQdrantPointId,
  QdrantProjectionReconcileService,
  ReviewState,
  type PostgresProjectionMemorySnapshot,
  type QdrantProjectionPointSnapshot,
} from "../app";

function pgRow(
  id: string,
  overrides: Partial<PostgresProjectionMemorySnapshot> = {}
): PostgresProjectionMemorySnapshot {
  return {
    id,
    lifecycleStatus: LifecycleStatus.Approved,
    reviewState: ReviewState.Approved,
    isCurrent: true,
    embeddingGeneration: "generation-a",
    title: id,
    updatedAt: "2026-05-27T00:00:00.000Z",
    ...overrides,
  };
}

function qPoint(
  memoryId: string | null,
  overrides: Partial<QdrantProjectionPointSnapshot> = {}
): QdrantProjectionPointSnapshot {
  return {
    pointId: memoryId ? memoryId.replace(/^memory_record_/, "") : "orphan-point",
    memoryId,
    lifecycleStatus: LifecycleStatus.Approved,
    reviewState: ReviewState.Approved,
    isCurrent: true,
    embeddingGeneration: "generation-a",
    title: memoryId ?? "orphan",
    updatedAt: "2026-05-27T00:00:00.000Z",
    ...overrides,
  };
}

test("qdrant reconcile diff finds stale, missing, drifted, and orphan points", () => {
  const diff = diffQdrantProjectionConsistency(
    [
      pgRow("memory_record_ok"),
      pgRow("memory_record_missing"),
      pgRow("memory_record_stale", {
        lifecycleStatus: LifecycleStatus.Tombstone,
        reviewState: ReviewState.Rejected,
        isCurrent: false,
      }),
      pgRow("memory_record_drift", {
        reviewState: ReviewState.NotRequired,
      }),
    ],
    [
      qPoint("memory_record_ok"),
      qPoint("memory_record_stale"),
      qPoint("memory_record_drift", {
        reviewState: ReviewState.Approved,
      }),
      qPoint(null),
    ]
  );

  assert.equal(diff.qdrantPointCount, 4);
  assert.equal(diff.postgresEffectiveRecallableCount, 3);
  assert.deepEqual(diff.staleMemoryIds, ["memory_record_stale"]);
  assert.deepEqual(diff.missingMemoryIds, ["memory_record_missing"]);
  assert.deepEqual(diff.payloadDriftMemoryIds, ["memory_record_drift"]);
  assert.deepEqual(diff.orphanPointIds, ["orphan-point"]);
});

test("qdrant projection issue explains small safe projection residue", () => {
  const diff = diffQdrantProjectionConsistency(
    [
      pgRow("memory_record_ok"),
      pgRow("memory_record_stale", {
        lifecycleStatus: LifecycleStatus.Tombstone,
        reviewState: ReviewState.Rejected,
        isCurrent: false,
      }),
    ],
    [
      qPoint("memory_record_ok"),
      qPoint("memory_record_stale"),
      qPoint(null),
    ]
  );

  const issue = buildQdrantProjectionIssue(diff, {
    checkedAt: "2026-05-27T00:00:00.000Z",
    policy: { maxDrift: 100, maxDelete: 20, maxUpsert: 100 },
  });

  assert.equal(issue?.id, "qdrant_projection_drift");
  assert.equal(issue?.repairability, "auto_safe");
  assert.equal(issue?.severity, "degraded");
  assert.equal(issue?.evidence.stale_count, 1);
  assert.equal(issue?.evidence.orphan_count, 1);
});

test("auto repair policy blocks payload drift and unhealthy embedding generation", () => {
  const diff = diffQdrantProjectionConsistency(
    [
      pgRow("memory_record_drift", {
        reviewState: ReviewState.NotRequired,
      }),
    ],
    [
      qPoint("memory_record_drift", {
        reviewState: ReviewState.Approved,
      }),
    ]
  );
  const plan = evaluateMemoryAutoRepairPlan({
    checkedAt: "2026-05-27T00:00:00.000Z",
    embeddingGenerationOk: false,
    before: {
      ok: false,
      mode: "report",
      diff,
      plannedMemoryIds: ["memory_record_drift"],
      plannedOrphanPointIds: [],
      appliedMemoryIds: [],
      deletedOrphanPointIds: [],
      syncResults: [],
    },
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.can_apply, false);
  assert.match(plan.blocked_reasons.join(","), /payload_drift_requires_manual_review|embedding_generation_not_ok/);
  assert.ok(plan.issues.some((issue) => issue.id === "embedding_generation_mismatch"));
});

test("qdrant reconcile checks missing PG rows in bounded pages without retaining all qdrant ids", async () => {
  const totalRows = 10_000;
  const pageSize = 1_000;
  const missingId = idForIndex(totalRows - 1);
  const memoryIdByPointId = new Map<string, string>();
  for (let index = 0; index < totalRows; index += 1) {
    const memoryId = idForIndex(index);
    memoryIdByPointId.set(mapMemoryIdToQdrantPointId(memoryId), memoryId);
  }
  let maxPostgresPage = 0;
  let maxRetrieveBatch = 0;
  let retrieveCalls = 0;

  const pointWriter = {
    async upsert() {},
    async delete() {},
    async retrieve(pointIds: readonly string[]) {
      retrieveCalls += 1;
      maxRetrieveBatch = Math.max(maxRetrieveBatch, pointIds.length);
      const rows = new Map<string, { readonly payload?: Record<string, unknown> }>();
      for (const pointId of pointIds) {
        const memoryId = memoryIdByPointId.get(pointId);
        if (!memoryId || memoryId === missingId) continue;
        rows.set(pointId, { payload: qdrantPayload(memoryId) });
      }
      return rows;
    },
  };

  const service = new QdrantProjectionReconcileService({
    postgresConfig: {
      databaseUrl: "postgres://unused",
      schema: "public",
      applicationName: "test",
      maxConnections: 1,
      idleTimeoutMs: 1000,
      connectionTimeoutMs: 1000,
      ssl: false,
    },
    qdrantConfig: {
      enabled: true,
      base_url: "http://qdrant.test",
      collection_name: "memory",
    },
    projectionSyncService: {
      async syncMemoryIds() {
        return { items: [] };
      },
    },
    pointWriter,
    postgresRows: {
      async loadByIds(memoryIds) {
        return new Map(memoryIds.map((id) => [id, pgRow(id)]));
      },
      async *scanPages(size) {
        for (let index = 0; index < totalRows; index += size) {
          const page: PostgresProjectionMemorySnapshot[] = [];
          for (let item = index; item < Math.min(index + size, totalRows); item += 1) {
            page.push(pgRow(idForIndex(item)));
          }
          maxPostgresPage = Math.max(maxPostgresPage, page.length);
          yield page;
        }
      },
    },
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { limit?: number; offset?: number };
      const offset = body.offset ?? 0;
      const limit = body.limit ?? pageSize;
      const points = [];
      for (let index = offset; index < Math.min(offset + limit, totalRows - 1); index += 1) {
        const memoryId = idForIndex(index);
        points.push({
          id: mapMemoryIdToQdrantPointId(memoryId),
          payload: qdrantPayload(memoryId),
        });
      }
      const next = offset + limit < totalRows - 1 ? offset + limit : null;
      return new Response(JSON.stringify({ result: { points, next_page_offset: next } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch,
  });

  const result = await service.execute({ pageSize });

  assert.deepEqual(result.diff.missingMemoryIds, [missingId]);
  assert.equal(maxPostgresPage, pageSize);
  assert.equal(maxRetrieveBatch, pageSize);
  assert.equal(retrieveCalls, totalRows / pageSize);
});

test("qdrant reconcile maps postgres recall policy so test-only rows are not projected", () => {
  const row = mapPostgresProjectionRow({
    id: "memory_record_policy_corpus_test_only",
    lifecycle_status: LifecycleStatus.Approved,
    review_state: ReviewState.Approved,
    is_current: true,
    embedding_generation: "generation-a",
    title: "test-only eval row",
    updated_at: "2026-05-27T00:00:00.000Z",
    recall_policy: "test_only",
  });

  const diff = diffQdrantProjectionConsistency([row], []);

  assert.equal(row.recallPolicy, "test_only");
  assert.equal(diff.postgresEffectiveRecallableCount, 0);
  assert.deepEqual(diff.missingMemoryIds, []);
});

function idForIndex(index: number): string {
  return `memory_record_${String(index).padStart(6, "0")}`;
}

function qdrantPayload(memoryId: string): Record<string, unknown> {
  return {
    memory_id: memoryId,
    lifecycle_status: LifecycleStatus.Approved,
    review_state: ReviewState.Approved,
    is_current: true,
    embedding_generation: "generation-a",
    title: memoryId,
    updated_at: "2026-05-27T00:00:00.000Z",
  };
}

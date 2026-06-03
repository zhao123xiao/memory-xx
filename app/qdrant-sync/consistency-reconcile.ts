import { Pool } from "pg";

import {
  createPostgresPoolConfig,
  loadMemoryV2PostgresConfig,
  type MemoryV2PostgresConfig,
} from "../db/adapters/postgres-config";
import { loadMemoryV2QdrantConfig, type MemoryV2QdrantConfig } from "../recall/qdrant-config";
import { readPgBoolean } from "../db/row-value-readers";
import { isEffectiveRecallable } from "../shared/predicates";
import { LifecycleStatus, ReviewState } from "../shared/types";
import { mapMemoryIdToQdrantPointId, type QdrantPointWriter, type QdrantProjectionSyncResult } from "./projector";

export interface QdrantProjectionPointSnapshot {
  readonly pointId: string;
  readonly memoryId: string | null;
  readonly lifecycleStatus?: string;
  readonly reviewState?: string;
  readonly isCurrent?: boolean;
  readonly embeddingGeneration?: string;
  readonly title?: string;
  readonly updatedAt?: string;
}

export interface PostgresProjectionMemorySnapshot {
  readonly id: string;
  readonly lifecycleStatus: LifecycleStatus;
  readonly reviewState: ReviewState;
  readonly isCurrent: boolean;
  readonly recallPolicy?: string | null;
  readonly embeddingGeneration: string | null;
  readonly title: string | null;
  readonly updatedAt: string;
}

export interface QdrantProjectionConsistencyDiff {
  readonly qdrantPointCount: number;
  readonly qdrantMemoryIdCount: number;
  readonly postgresEffectiveRecallableCount: number;
  readonly staleMemoryIds: readonly string[];
  readonly missingMemoryIds: readonly string[];
  readonly payloadDriftMemoryIds: readonly string[];
  readonly orphanPointIds: readonly string[];
  readonly stale: readonly QdrantProjectionPointSnapshot[];
  readonly missing: readonly PostgresProjectionMemorySnapshot[];
  readonly payloadDrift: readonly {
    readonly memoryId: string;
    readonly postgres: PostgresProjectionMemorySnapshot;
    readonly qdrant: QdrantProjectionPointSnapshot;
  }[];
  readonly orphanPoints: readonly QdrantProjectionPointSnapshot[];
}

export interface QdrantProjectionReconcileOptions {
  readonly apply?: boolean;
  readonly limit?: number;
  readonly pageSize?: number;
}

export interface QdrantProjectionReconcileResult {
  readonly ok: boolean;
  readonly mode: "report" | "apply";
  readonly diff: QdrantProjectionConsistencyDiff;
  readonly plannedMemoryIds: readonly string[];
  readonly plannedOrphanPointIds: readonly string[];
  readonly appliedMemoryIds: readonly string[];
  readonly deletedOrphanPointIds: readonly string[];
  readonly syncResults: readonly QdrantProjectionSyncResult[];
}

export interface QdrantProjectionReconcileServiceOptions {
  readonly postgresConfig?: MemoryV2PostgresConfig;
  readonly qdrantConfig?: MemoryV2QdrantConfig;
  readonly projectionSyncService: {
    syncMemoryIds(memoryIds: readonly string[]): Promise<QdrantProjectionSyncResult>;
  };
  readonly pointWriter?: QdrantPointWriter;
  readonly fetchImpl?: typeof fetch;
  readonly postgresRows?: {
    loadByIds(memoryIds: readonly string[]): Promise<ReadonlyMap<string, PostgresProjectionMemorySnapshot>>;
    scanPages(pageSize: number): AsyncIterable<readonly PostgresProjectionMemorySnapshot[]>;
  };
}

const REPAIR_BATCH_SIZE = 50;
const DEFAULT_RECONCILE_PAGE_SIZE = 1000;

export class QdrantProjectionReconcileService {
  private readonly postgresConfig: MemoryV2PostgresConfig;
  private readonly qdrantConfig: MemoryV2QdrantConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: QdrantProjectionReconcileServiceOptions) {
    this.postgresConfig = options.postgresConfig ?? loadMemoryV2PostgresConfig();
    this.qdrantConfig = options.qdrantConfig ?? loadMemoryV2QdrantConfig();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute(input: QdrantProjectionReconcileOptions = {}): Promise<QdrantProjectionReconcileResult> {
    const diff = await this.diffStreaming(Math.max(1, input.pageSize ?? DEFAULT_RECONCILE_PAGE_SIZE));
    const plannedMemoryIds = unique([
      ...diff.staleMemoryIds,
      ...diff.missingMemoryIds,
      ...diff.payloadDriftMemoryIds,
    ]).slice(0, input.limit);
    const plannedOrphanPointIds = diff.orphanPointIds.slice(0, input.limit);
    const syncResults: QdrantProjectionSyncResult[] = [];
    const deletedOrphanPointIds: string[] = [];

    if (input.apply) {
      for (const batch of chunks(plannedMemoryIds, REPAIR_BATCH_SIZE)) {
        syncResults.push(await this.options.projectionSyncService.syncMemoryIds(batch));
      }
      if (plannedOrphanPointIds.length > 0) {
        if (!this.options.pointWriter) {
          throw new Error("删除 Qdrant 孤儿向量点需要配置 pointWriter。");
        }
        for (const batch of chunks(plannedOrphanPointIds, REPAIR_BATCH_SIZE)) {
          await this.options.pointWriter.delete(batch);
          deletedOrphanPointIds.push(...batch);
        }
      }
    }

    return {
      ok: diff.staleMemoryIds.length === 0 &&
        diff.missingMemoryIds.length === 0 &&
        diff.payloadDriftMemoryIds.length === 0 &&
        diff.orphanPointIds.length === 0,
      mode: input.apply ? "apply" : "report",
      diff,
      plannedMemoryIds,
      plannedOrphanPointIds,
      appliedMemoryIds: input.apply ? plannedMemoryIds : [],
      deletedOrphanPointIds,
      syncResults,
    };
  }

  private async diffStreaming(pageSize: number): Promise<QdrantProjectionConsistencyDiff> {
    let qdrantPointCount = 0;
    let qdrantMemoryIdCount = 0;
    const stale: QdrantProjectionPointSnapshot[] = [];
    const orphanPoints: QdrantProjectionPointSnapshot[] = [];
    const payloadDrift: {
      memoryId: string;
      postgres: PostgresProjectionMemorySnapshot;
      qdrant: QdrantProjectionPointSnapshot;
    }[] = [];

    for await (const page of this.scrollQdrantPointPages(pageSize)) {
      qdrantPointCount += page.length;
      const memoryIds = unique(page.map((point) => point.memoryId).filter((id): id is string => Boolean(id)));
      qdrantMemoryIdCount += memoryIds.length;
      const postgresById = await this.loadPostgresRowsByIds(memoryIds);
      for (const point of page) {
        if (!point.memoryId) {
          orphanPoints.push(point);
          continue;
        }
        const postgres = postgresById.get(point.memoryId);
        if (!postgres || !isEffectiveRecallable(postgres)) {
          stale.push(point);
          continue;
        }
        if (
          point.lifecycleStatus !== postgres.lifecycleStatus ||
          point.reviewState !== postgres.reviewState ||
          point.isCurrent !== postgres.isCurrent ||
          (postgres.embeddingGeneration && point.embeddingGeneration !== postgres.embeddingGeneration)
        ) {
          payloadDrift.push({ memoryId: point.memoryId, postgres, qdrant: point });
        }
      }
    }

    const missing: PostgresProjectionMemorySnapshot[] = [];
    let postgresEffectiveRecallableCount = 0;
    for await (const page of this.scanPostgresRows(pageSize)) {
      const effectiveRows = page.filter(isEffectiveRecallable);
      postgresEffectiveRecallableCount += effectiveRows.length;
      if (effectiveRows.length === 0) continue;
      const qdrantByMemoryId = await this.loadQdrantPointsByMemoryIds(effectiveRows.map((row) => row.id));
      for (const row of effectiveRows) {
        if (!qdrantByMemoryId.has(row.id)) {
          missing.push(row);
        }
      }
    }

    return {
      qdrantPointCount,
      qdrantMemoryIdCount,
      postgresEffectiveRecallableCount,
      staleMemoryIds: unique(stale.map((point) => point.memoryId).filter((id): id is string => Boolean(id))),
      missingMemoryIds: missing.map((row) => row.id),
      payloadDriftMemoryIds: payloadDrift.map((item) => item.memoryId),
      orphanPointIds: orphanPoints.map((point) => point.pointId),
      stale,
      missing,
      payloadDrift,
      orphanPoints,
    };
  }

  private async *scrollQdrantPointPages(pageSize: number): AsyncGenerator<readonly QdrantProjectionPointSnapshot[]> {
    if (!this.qdrantConfig.base_url || !this.qdrantConfig.collection_name) {
      throw new Error("Qdrant 对账需要配置 MEMORY_V2_QDRANT_BASE_URL 和 MEMORY_V2_QDRANT_COLLECTION。");
    }

    let offset: unknown = null;
    do {
      const response = await this.fetchImpl(
        `${this.qdrantConfig.base_url.replace(/\/$/, "")}/collections/${encodeURIComponent(this.qdrantConfig.collection_name)}/points/scroll`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.qdrantConfig.api_key ? { "api-key": this.qdrantConfig.api_key } : {}),
          },
          body: JSON.stringify({
            limit: pageSize,
            with_payload: true,
            with_vector: false,
            ...(offset ? { offset } : {}),
          }),
        }
      );
      if (!response.ok) {
        throw new Error(`Qdrant scroll failed with status ${response.status}`);
      }
      const body = await response.json() as {
        result?: {
          points?: readonly {
            id?: unknown;
            payload?: Record<string, unknown>;
          }[];
          next_page_offset?: unknown;
        };
      };
      yield (body.result?.points ?? []).map((point) => qdrantPayloadSnapshot(String(point.id ?? ""), point.payload));
      offset = body.result?.next_page_offset ?? null;
    } while (offset);
  }

  private async loadPostgresRowsByIds(memoryIds: readonly string[]): Promise<ReadonlyMap<string, PostgresProjectionMemorySnapshot>> {
    if (this.options.postgresRows) {
      return this.options.postgresRows.loadByIds(memoryIds);
    }
    if (memoryIds.length === 0) return new Map();
    const pool = new Pool(createPostgresPoolConfig(this.postgresConfig));
    try {
      const params = memoryIds.map((_, index) => `$${index + 1}`).join(", ");
      const rows = await pool.query<{
        id: string;
        lifecycle_status: string;
        review_state: string;
        is_current: boolean;
        recall_policy: string | null;
        embedding_generation: string | null;
        title: string | null;
        updated_at: Date | string;
      }>(
        `
          SELECT
            id,
            lifecycle_status,
            review_state,
            is_current,
            COALESCE(metadata->>'recall_policy', metadata->'auto_approval_policy'->'memory_policy'->>'recall_policy', 'default') AS recall_policy,
            embedding_generation,
            title,
            updated_at
          FROM ${quoteIdent(this.postgresConfig.schema)}.memory_records
          WHERE id IN (${params})
        `,
        [...memoryIds]
      );
      return new Map(rows.rows.map((row) => [row.id, mapPostgresProjectionRow(row)]));
    } finally {
      await pool.end();
    }
  }

  private async *scanPostgresRows(pageSize: number): AsyncGenerator<readonly PostgresProjectionMemorySnapshot[]> {
    if (this.options.postgresRows) {
      for await (const page of this.options.postgresRows.scanPages(pageSize)) {
        yield page;
      }
      return;
    }

    const pool = new Pool(createPostgresPoolConfig(this.postgresConfig));
    let afterId = "";
    try {
      while (true) {
        const rows = await pool.query<{
          id: string;
          lifecycle_status: string;
          review_state: string;
          is_current: boolean | string;
          recall_policy: string | null;
          embedding_generation: string | null;
          title: string | null;
          updated_at: Date | string;
        }>(
          `
            SELECT
              id,
              lifecycle_status,
              review_state,
              is_current,
              COALESCE(metadata->>'recall_policy', metadata->'auto_approval_policy'->'memory_policy'->>'recall_policy', 'default') AS recall_policy,
              embedding_generation,
              title,
              updated_at
            FROM ${quoteIdent(this.postgresConfig.schema)}.memory_records
            WHERE id > $1
            ORDER BY id ASC
            LIMIT $2
          `,
          [afterId, pageSize]
        );
        if (rows.rows.length === 0) break;
        yield rows.rows.map(mapPostgresProjectionRow);
        afterId = rows.rows[rows.rows.length - 1]!.id;
      }
    } finally {
      await pool.end();
    }
  }

  private async loadQdrantPointsByMemoryIds(memoryIds: readonly string[]): Promise<ReadonlyMap<string, QdrantProjectionPointSnapshot>> {
    if (memoryIds.length === 0) return new Map();
    const pointIds = memoryIds.map(mapMemoryIdToQdrantPointId);
    const rawPoints = this.options.pointWriter?.retrieve
      ? await this.options.pointWriter.retrieve(pointIds)
      : await this.retrieveQdrantPoints(pointIds);
    const byMemoryId = new Map<string, QdrantProjectionPointSnapshot>();
    for (const [pointId, point] of rawPoints) {
      const snapshot = qdrantPayloadSnapshot(pointId, point.payload);
      if (snapshot.memoryId) {
        byMemoryId.set(snapshot.memoryId, snapshot);
      }
    }
    return byMemoryId;
  }

  private async retrieveQdrantPoints(pointIds: readonly string[]): Promise<ReadonlyMap<string, { readonly payload?: Record<string, unknown> }>> {
    if (!this.qdrantConfig.base_url || !this.qdrantConfig.collection_name) {
      throw new Error("Qdrant 对账需要配置 MEMORY_V2_QDRANT_BASE_URL 和 MEMORY_V2_QDRANT_COLLECTION。");
    }
    const response = await this.fetchImpl(
      `${this.qdrantConfig.base_url.replace(/\/$/, "")}/collections/${encodeURIComponent(this.qdrantConfig.collection_name)}/points?consistency=all`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.qdrantConfig.api_key ? { "api-key": this.qdrantConfig.api_key } : {}),
        },
        body: JSON.stringify({ ids: pointIds, with_payload: true, with_vector: false }),
      }
    );
    if (!response.ok) {
      throw new Error(`Qdrant retrieve failed with status ${response.status}`);
    }
    const body = await response.json() as { result?: unknown };
    const rows = Array.isArray(body.result) ? body.result : [];
    const map = new Map<string, { readonly payload?: Record<string, unknown> }>();
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const record = row as { id?: unknown; payload?: unknown };
      if (record.id === undefined) continue;
      map.set(String(record.id), {
        payload: record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
          ? record.payload as Record<string, unknown>
          : undefined,
      });
    }
    return map;
  }
}

function qdrantPayloadSnapshot(pointId: string, payload: Record<string, unknown> | undefined): QdrantProjectionPointSnapshot {
  const safePayload = payload ?? {};
  return {
    pointId,
    memoryId: readString(safePayload.memory_id),
    lifecycleStatus: readString(safePayload.lifecycle_status) ?? undefined,
    reviewState: readString(safePayload.review_state) ?? undefined,
    isCurrent: readPayloadBoolean(safePayload.is_current),
    embeddingGeneration: readString(safePayload.embedding_generation) ?? undefined,
    title: readString(safePayload.title) ?? undefined,
    updatedAt: readString(safePayload.updated_at) ?? undefined,
  };
}

export function diffQdrantProjectionConsistency(
  postgresRows: readonly PostgresProjectionMemorySnapshot[],
  qdrantPoints: readonly QdrantProjectionPointSnapshot[]
): QdrantProjectionConsistencyDiff {
  const postgresById = new Map(postgresRows.map((row) => [row.id, row]));
  const effectivePostgresRows = postgresRows.filter(isEffectiveRecallable);
  const effectivePostgresIds = new Set(effectivePostgresRows.map((row) => row.id));
  const qdrantByMemoryId = new Map<string, QdrantProjectionPointSnapshot>();
  const stale: QdrantProjectionPointSnapshot[] = [];
  const orphanPoints: QdrantProjectionPointSnapshot[] = [];
  const payloadDrift: {
    memoryId: string;
    postgres: PostgresProjectionMemorySnapshot;
    qdrant: QdrantProjectionPointSnapshot;
  }[] = [];

  for (const point of qdrantPoints) {
    if (!point.memoryId) {
      orphanPoints.push(point);
      continue;
    }
    qdrantByMemoryId.set(point.memoryId, point);
    const postgres = postgresById.get(point.memoryId);
    if (!postgres || !isEffectiveRecallable(postgres)) {
      stale.push(point);
      continue;
    }
    if (
      point.lifecycleStatus !== postgres.lifecycleStatus ||
      point.reviewState !== postgres.reviewState ||
      point.isCurrent !== postgres.isCurrent ||
      (postgres.embeddingGeneration && point.embeddingGeneration !== postgres.embeddingGeneration)
    ) {
      payloadDrift.push({ memoryId: point.memoryId, postgres, qdrant: point });
    }
  }

  const missing = effectivePostgresRows.filter((row) => !qdrantByMemoryId.has(row.id));

  return {
    qdrantPointCount: qdrantPoints.length,
    qdrantMemoryIdCount: qdrantByMemoryId.size,
    postgresEffectiveRecallableCount: effectivePostgresRows.length,
    staleMemoryIds: unique(stale.map((point) => point.memoryId).filter((id): id is string => Boolean(id))),
    missingMemoryIds: missing.map((row) => row.id),
    payloadDriftMemoryIds: payloadDrift.map((item) => item.memoryId),
    orphanPointIds: orphanPoints.map((point) => point.pointId),
    stale,
    missing,
    payloadDrift,
    orphanPoints,
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readPayloadBoolean(value: unknown): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  return readPgBoolean(value, "qdrant.payload.is_current");
}

export function mapPostgresProjectionRow(row: {
  readonly id: string;
  readonly lifecycle_status: string;
  readonly review_state: string;
  readonly is_current: boolean | string;
  readonly recall_policy?: string | null;
  readonly embedding_generation: string | null;
  readonly title: string | null;
  readonly updated_at: Date | string;
}): PostgresProjectionMemorySnapshot {
  return {
    id: row.id,
    lifecycleStatus: row.lifecycle_status as LifecycleStatus,
    reviewState: row.review_state as ReviewState,
    isCurrent: readPgBoolean(row.is_current, "memory_records.is_current"),
    recallPolicy: readString(row.recall_policy),
    embeddingGeneration: row.embedding_generation,
    title: row.title,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`unsafe identifier: ${value}`);
  }
  return `"${value}"`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

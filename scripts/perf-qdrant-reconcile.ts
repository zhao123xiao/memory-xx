import {
  LifecycleStatus,
  QdrantProjectionReconcileService,
  ReviewState,
  type PostgresProjectionMemorySnapshot,
} from "../app";

interface PerfCase {
  readonly totalRows: number;
  readonly maxRssBytes: number;
}

const cases: readonly PerfCase[] = [
  { totalRows: 10_000, maxRssBytes: 200 * 1024 * 1024 },
  { totalRows: 100_000, maxRssBytes: 500 * 1024 * 1024 },
];

const PAGE_SIZE = 1_000;

async function main(): Promise<void> {
  for (const item of cases) {
    const result = await runCase(item.totalRows);
    const maxMb = Math.round(result.peakRssBytes / 1024 / 1024);
    const budgetMb = Math.round(item.maxRssBytes / 1024 / 1024);
    console.log(JSON.stringify({
      total_rows: item.totalRows,
      page_size: PAGE_SIZE,
      peak_rss_mb: maxMb,
      budget_mb: budgetMb,
      max_postgres_page: result.maxPostgresPage,
      max_qdrant_retrieve_batch: result.maxRetrieveBatch,
      missing_count: result.missingCount,
      ok: result.peakRssBytes < item.maxRssBytes &&
        result.maxPostgresPage <= PAGE_SIZE &&
        result.maxRetrieveBatch <= PAGE_SIZE &&
        result.missingCount === 1,
    }));
    if (
      result.peakRssBytes >= item.maxRssBytes ||
      result.maxPostgresPage > PAGE_SIZE ||
      result.maxRetrieveBatch > PAGE_SIZE ||
      result.missingCount !== 1
    ) {
      process.exitCode = 1;
    }
  }
}

async function runCase(totalRows: number): Promise<{
  readonly peakRssBytes: number;
  readonly maxPostgresPage: number;
  readonly maxRetrieveBatch: number;
  readonly missingCount: number;
}> {
  const missingId = idForIndex(totalRows - 1);
  let peakRssBytes = process.memoryUsage().rss;
  let maxPostgresPage = 0;
  let maxRetrieveBatch = 0;
  const sampleRss = (): void => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  };

  const service = new QdrantProjectionReconcileService({
    postgresConfig: {
      databaseUrl: "postgres://unused",
      schema: "public",
      applicationName: "perf",
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
    pointWriter: {
      async upsert() {},
      async delete() {},
      async retrieve(pointIds: readonly string[]) {
        sampleRss();
        maxRetrieveBatch = Math.max(maxRetrieveBatch, pointIds.length);
        const rows = new Map<string, { readonly payload?: Record<string, unknown> }>();
        for (const pointId of pointIds) {
          if (pointId === missingId) continue;
          rows.set(pointId, { payload: qdrantPayload(pointId) });
        }
        return rows;
      },
    },
    postgresRows: {
      async loadByIds(memoryIds) {
        sampleRss();
        return new Map(memoryIds.map((id) => [id, pgRow(id)]));
      },
      async *scanPages(size) {
        for (let index = 0; index < totalRows; index += size) {
          const page: PostgresProjectionMemorySnapshot[] = [];
          for (let item = index; item < Math.min(index + size, totalRows); item += 1) {
            page.push(pgRow(idForIndex(item)));
          }
          maxPostgresPage = Math.max(maxPostgresPage, page.length);
          sampleRss();
          yield page;
        }
      },
    },
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { limit?: number; offset?: number };
      const offset = body.offset ?? 0;
      const limit = body.limit ?? PAGE_SIZE;
      const points = [];
      for (let index = offset; index < Math.min(offset + limit, totalRows - 1); index += 1) {
        const memoryId = idForIndex(index);
        points.push({ id: memoryId, payload: qdrantPayload(memoryId) });
      }
      const next = offset + limit < totalRows - 1 ? offset + limit : null;
      sampleRss();
      return new Response(JSON.stringify({ result: { points, next_page_offset: next } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch,
  });

  const result = await service.execute({ pageSize: PAGE_SIZE });
  sampleRss();
  return {
    peakRssBytes,
    maxPostgresPage,
    maxRetrieveBatch,
    missingCount: result.diff.missingMemoryIds.length,
  };
}

function idForIndex(index: number): string {
  return `00000000-0000-5000-8000-${index.toString(16).padStart(12, "0")}`;
}

function pgRow(id: string): PostgresProjectionMemorySnapshot {
  return {
    id,
    lifecycleStatus: LifecycleStatus.Approved,
    reviewState: ReviewState.Approved,
    isCurrent: true,
    embeddingGeneration: "generation-a",
    title: id,
    updatedAt: "2026-05-27T00:00:00.000Z",
  };
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

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import {
  createConfiguredRecallRuntime
} from "../recall/postgres-runtime";
import { ResilientQueryEmbeddingProvider } from "../recall/query-embedding-resilience";
import { RedisQueryEmbeddingCache } from "../recall/redis-query-embedding-cache";
import {
  RedisRecallCache,
  NoopRecallCache,
  loadMemoryRedisConfig,
  type RecallCacheRuntime
} from "../cache";
import type { PostgresRecallRuntime } from "../recall/postgres-runtime";
import {
  loadMemoryXXQdrantConfig,
  resolveVectorRuntimeMode
} from "../recall/qdrant-config";
import { loadMemoryXXPostgresConfig } from "../db/adapters/postgres-config";
import { PostgresWriteDatabase } from "../db/adapters/postgres-write-database";
import { createLogger } from "../shared/logger";
import { QwenEmbeddingProviderWrapper, loadEmbeddingProviderRequestConfig } from "./embedding-provider";
import { QdrantProjectionSyncService } from "../qdrant-sync/projector";
import { HttpQdrantPointWriter } from "../qdrant-sync/qdrant-point-writer";
import { activatePendingRuntimeControlsSync, readRuntimeControlNumberSync } from "../runtime-control-settings";

const log = createLogger("runtime");

export let runtime: PostgresRecallRuntime | null = null;
export let recallCache: RecallCacheRuntime = new NoopRecallCache();
export let writeDatabase: PostgresWriteDatabase | null = null;
export let projectionSyncService: QdrantProjectionSyncService | null = null;
export let queryEmbeddingProvider: ResilientQueryEmbeddingProvider | null = null;

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function initRuntime(): Promise<void> {
  activatePendingRuntimeControlsSync([
    "cache.reranker.ttl_ms",
    "cache.query_embedding.ttl_ms",
    "write.ticket.ttl_seconds",
    "write.semantic_lock.ttl_ms",
    "write.semantic_lock.wait_timeout_ms",
    "recall.graph_health_ttl_ms",
    "recall.reranker.timeout_ms",
    "recall.fastpath.primary_timeout_ms",
    "recall.fastpath.shadow_timeout_ms",
    "health.projector_stale_after_ms",
    "health.outbox_blocker_threshold",
    "health.cache_invalidation_blocker_threshold",
    "health.qdrant_pg_diff_blocker_threshold",
    "database.connection.idle_timeout_ms",
  ]);
  const config = loadMemoryXXPostgresConfig();
  const qdrantConfig = loadMemoryXXQdrantConfig();
  const redisConfig = loadMemoryRedisConfig();
  const runtimeSelection = resolveVectorRuntimeMode(qdrantConfig);
  const embeddingRequestConfig = loadEmbeddingProviderRequestConfig();
  const sharedEmbeddingCache = new RedisQueryEmbeddingCache({
    url: redisConfig.url,
    prefix: redisConfig.prefix,
    connect_timeout_ms: redisConfig.connect_timeout_ms,
  });
  await sharedEmbeddingCache.connect();
  const embeddingProvider = new ResilientQueryEmbeddingProvider(
    new QwenEmbeddingProviderWrapper(),
    {
      max_retries: readPositiveInt("MEMORY_XX_QUERY_EMBEDDING_MAX_RETRIES", 0),
      retry_delay_ms: readPositiveInt("MEMORY_XX_QUERY_EMBEDDING_RETRY_DELAY_MS", 250),
      retry_backoff_multiplier: 2,
      cache_ttl_ms: readRuntimeControlNumberSync("cache.query_embedding.ttl_ms", 30 * 60 * 1000),
      allow_stale_on_error: true,
      max_cache_entries: 500,
      shared_cache: sharedEmbeddingCache,
      cache_key_context: {
        model: embeddingRequestConfig.model,
        dims: embeddingRequestConfig.dims,
        api_base: embeddingRequestConfig.api_base,
        version: process.env.MEMORY_XX_QUERY_EMBEDDING_CACHE_VERSION?.trim() || "query-embedding-v1",
      }
    }
  );
  queryEmbeddingProvider = embeddingProvider;
  recallCache = redisConfig.url ? new RedisRecallCache({ config: redisConfig }) : new NoopRecallCache();
  if (recallCache instanceof RedisRecallCache) {
    await recallCache.connect();
  }
  runtime = createConfiguredRecallRuntime({
    config,
    recall_cache: recallCache,
    query_embedding_provider: embeddingProvider,
    vector_column_name: "content_embedding",
    qdrant: qdrantConfig
  }).runtime;
  writeDatabase = new PostgresWriteDatabase({ config });

  if (qdrantConfig.base_url && qdrantConfig.collection_name) {
    const pointWriter = new HttpQdrantPointWriter({ config: qdrantConfig });
    projectionSyncService = new QdrantProjectionSyncService({
      database: writeDatabase,
      pointWriter
    });
  }

  const wrapperMode = process.env.MEMORY_XX_WRAPPER_MODE ?? "recall-only";
  log.info("Runtime initialised", { mode: wrapperMode, vector: runtimeSelection, redis: redisConfig.url ? "external" : "disabled", projection_sync: projectionSyncService !== null });
}

export async function closeRuntime(): Promise<void> {
  if (queryEmbeddingProvider) {
    await queryEmbeddingProvider.close();
    queryEmbeddingProvider = null;
  }
  if (writeDatabase) {
    await writeDatabase.close();
  writeDatabase = null;
  }
  if (runtime) {
    await runtime.close();
    runtime = null;
  }
  await recallCache.close();
  recallCache = new NoopRecallCache();
}

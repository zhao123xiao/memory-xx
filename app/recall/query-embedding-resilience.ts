import type {
  EmbedQueryResult,
  QueryEmbeddingProvider
} from "./retrievers/vector-retriever";

export interface ResilientQueryEmbeddingProviderOptions {
  readonly max_retries?: number;
  readonly retry_delay_ms?: number;
  readonly retry_backoff_multiplier?: number;
  readonly cache_ttl_ms?: number;
  readonly allow_stale_on_error?: boolean;
  readonly max_cache_entries?: number;
  readonly shared_cache?: QueryEmbeddingSharedCache;
  readonly cache_key_context?: QueryEmbeddingCacheKeyContext;
}

interface CachedEmbedding {
  readonly embedding: readonly number[];
  readonly expires_at: number;
}

export interface QueryEmbeddingCacheKeyContext {
  readonly model: string;
  readonly dims: number;
  readonly api_base: string;
  readonly version?: string;
}

export interface QueryEmbeddingSharedCacheResult {
  readonly status: "hit" | "miss" | "fallback" | "skipped";
  readonly embedding?: readonly number[];
  readonly error?: string;
}

export interface QueryEmbeddingSharedCache {
  get(cacheKey: string): Promise<QueryEmbeddingSharedCacheResult>;
  set(cacheKey: string, embedding: readonly number[], ttlSeconds: number): Promise<QueryEmbeddingSharedCacheResult>;
  getHealthSnapshot(): Record<string, unknown>;
  close?(): Promise<void>;
}

function normalizeKeyPart(value: string): string {
  return value.trim().toLowerCase();
}

function buildCacheKey(input: {
  query: string;
  query_terms: readonly string[];
}): string {
  const normalizedTerms = [...new Set(input.query_terms.map(normalizeKeyPart).filter(Boolean))]
    .sort()
    .join("|");
  return `${normalizeKeyPart(input.query)}\u0000${normalizedTerms}`;
}

function buildSharedCacheKey(
  localCacheKey: string,
  context: QueryEmbeddingCacheKeyContext
): string {
  return JSON.stringify({
    query: localCacheKey,
    model: context.model,
    dims: context.dims,
    api_base: context.api_base,
    version: context.version ?? "query-embedding-v1",
  });
}

function cloneEmbedding(embedding: readonly number[]): readonly number[] {
  return [...embedding];
}

function isUsableEmbedding(embedding: readonly number[] | null | undefined): embedding is readonly number[] {
  return Array.isArray(embedding) && embedding.length > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }

  return "UPSTREAM_ERROR";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "query_embedding_failed";
}

function sharedAuditFields(result?: QueryEmbeddingSharedCacheResult): {
  readonly redis_cache_status?: "hit" | "miss" | "stored" | "fallback" | "skipped";
  readonly redis_cache_error?: string;
} {
  if (!result || result.status === "skipped") return {};
  return {
    redis_cache_status: result.status,
    redis_cache_error: result.error,
  };
}

export class ResilientQueryEmbeddingProvider implements QueryEmbeddingProvider {
  private readonly baseProvider: QueryEmbeddingProvider;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly retryBackoffMultiplier: number;
  private readonly cacheTtlMs: number;
  private readonly allowStaleOnError: boolean;
  private readonly maxCacheEntries: number;
  private readonly sharedCache?: QueryEmbeddingSharedCache;
  private readonly cacheKeyContext: QueryEmbeddingCacheKeyContext;
  private readonly cache = new Map<string, CachedEmbedding>();
  private readonly inflight = new Map<string, Promise<EmbedQueryResult>>();
  private stats = {
    memory_hits: 0,
    stale_memory_hits: 0,
    redis_hits: 0,
    redis_misses: 0,
    redis_fallbacks: 0,
    upstream_successes: 0,
    upstream_failures: 0,
  };

  constructor(
    baseProvider: QueryEmbeddingProvider,
    options?: ResilientQueryEmbeddingProviderOptions
  ) {
    this.baseProvider = baseProvider;
    this.maxRetries = Math.max(0, options?.max_retries ?? 2);
    this.retryDelayMs = Math.max(0, options?.retry_delay_ms ?? 200);
    this.retryBackoffMultiplier = Math.max(1, options?.retry_backoff_multiplier ?? 2);
    this.cacheTtlMs = Math.max(0, options?.cache_ttl_ms ?? 10 * 60 * 1000);
    this.allowStaleOnError = options?.allow_stale_on_error ?? true;
    this.maxCacheEntries = Math.max(1, options?.max_cache_entries ?? 256);
    this.sharedCache = options?.shared_cache;
    this.cacheKeyContext = options?.cache_key_context ?? {
      model: "unknown",
      dims: 0,
      api_base: "unknown",
      version: "query-embedding-v1",
    };
  }

  async embed_query(input: {
    query: string;
    query_terms: string[];
  }): Promise<EmbedQueryResult> {
    const cacheKey = buildCacheKey(input);
    const cached = this.cache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.expires_at > now) {
      this.touchCacheEntry(cacheKey, cached);
      this.stats.memory_hits += 1;
      return {
        embedding: cloneEmbedding(cached.embedding),
        audit: {
          fresh_cache_hit: true,
          stale_cache_hit: false,
          attempt_count: 0
        }
      };
    }

    const sharedKey = buildSharedCacheKey(cacheKey, this.cacheKeyContext);
    const shared = await this.readSharedCache(sharedKey);
    if (shared.status === "hit" && isUsableEmbedding(shared.embedding)) {
      this.store(cacheKey, shared.embedding);
      this.stats.redis_hits += 1;
      return {
        embedding: cloneEmbedding(shared.embedding),
        audit: {
          fresh_cache_hit: true,
          stale_cache_hit: false,
          attempt_count: 0,
          cache_backend: "redis",
          redis_cache_status: "hit"
        }
      };
    }
    if (shared.status === "miss") this.stats.redis_misses += 1;
    if (shared.status === "fallback") this.stats.redis_fallbacks += 1;

    const existingInflight = this.inflight.get(cacheKey);
    if (existingInflight) {
      return existingInflight;
    }

    const task = this.resolveEmbedding(cacheKey, sharedKey, input, cached, shared);
    this.inflight.set(cacheKey, task);

    try {
      return await task;
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  private async resolveEmbedding(
    cacheKey: string,
    sharedKey: string,
    input: { query: string; query_terms: string[] },
    staleCache?: CachedEmbedding,
    sharedResult?: QueryEmbeddingSharedCacheResult
  ): Promise<EmbedQueryResult> {
    let delayMs = this.retryDelayMs;
    const totalAttempts = this.maxRetries + 1;
    let finalError: string | undefined;
    let errorCode: string | undefined;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      try {
        const result = await this.baseProvider.embed_query(input);
        const embedding = result.embedding;
        if (isUsableEmbedding(embedding)) {
          this.store(cacheKey, embedding);
          const writeResult = await this.writeSharedCache(sharedKey, embedding);
          this.stats.upstream_successes += 1;
          return {
            embedding: cloneEmbedding(embedding),
            audit: {
              fresh_cache_hit: false,
              stale_cache_hit: false,
              attempt_count: attempt,
              final_error: finalError ?? result.audit.final_error,
              error_code: errorCode ?? result.audit.error_code,
              ...(writeResult.status === "stored"
                ? { redis_cache_status: "stored" as const, redis_cache_error: writeResult.error }
                : sharedAuditFields(sharedResult))
            }
          };
        }

        finalError = result.audit.final_error ?? "query_embedding_empty";
        errorCode = result.audit.error_code ?? "UPSTREAM_NULL";
      } catch (error) {
        finalError = toErrorMessage(error);
        errorCode = toErrorCode(error);
      }

      if (attempt < totalAttempts && delayMs > 0) {
        await sleep(delayMs);
        delayMs = Math.max(
          this.retryDelayMs,
          Math.round(delayMs * this.retryBackoffMultiplier)
        );
      }
    }

    if (this.allowStaleOnError && staleCache && isUsableEmbedding(staleCache.embedding)) {
      this.touchCacheEntry(cacheKey, staleCache);
      this.stats.stale_memory_hits += 1;
      this.stats.upstream_failures += 1;
      return {
        embedding: cloneEmbedding(staleCache.embedding),
        audit: {
          fresh_cache_hit: false,
          stale_cache_hit: true,
          attempt_count: totalAttempts,
          final_error: finalError,
          error_code: errorCode,
          ...sharedAuditFields(sharedResult)
        }
      };
    }

    this.stats.upstream_failures += 1;
    return {
      embedding: null,
      audit: {
        fresh_cache_hit: false,
        stale_cache_hit: false,
        attempt_count: totalAttempts,
        final_error: finalError,
        error_code: errorCode,
        ...sharedAuditFields(sharedResult)
      }
    };
  }

  private async readSharedCache(cacheKey: string): Promise<QueryEmbeddingSharedCacheResult> {
    if (!this.sharedCache) return { status: "skipped" };
    try {
      return await this.sharedCache.get(cacheKey);
    } catch (error) {
      return { status: "fallback", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async writeSharedCache(cacheKey: string, embedding: readonly number[]): Promise<{
    readonly status: "stored" | "fallback" | "skipped";
    readonly error?: string;
  }> {
    if (!this.sharedCache || this.cacheTtlMs <= 0) return { status: "skipped" };
    try {
      const result = await this.sharedCache.set(cacheKey, embedding, Math.max(1, Math.ceil(this.cacheTtlMs / 1000)));
      return {
        status: result.status === "fallback" ? "fallback" : "stored",
        error: result.error
      };
    } catch (error) {
      return { status: "fallback", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private store(cacheKey: string, embedding: readonly number[]): void {
    const entry: CachedEmbedding = {
      embedding: cloneEmbedding(embedding),
      expires_at: Date.now() + this.cacheTtlMs
    };
    this.touchCacheEntry(cacheKey, entry);

    while (this.cache.size > this.maxCacheEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (typeof oldestKey !== "string") {
        break;
      }
      this.cache.delete(oldestKey);
    }
  }

  private touchCacheEntry(cacheKey: string, entry: CachedEmbedding): void {
    if (this.cache.has(cacheKey)) {
      this.cache.delete(cacheKey);
    }
    this.cache.set(cacheKey, entry);
  }

  getCacheHealthSnapshot(): Record<string, unknown> {
    const redisLookups = this.stats.redis_hits + this.stats.redis_misses;
    const redisHitRate = redisLookups > 0 ? this.stats.redis_hits / redisLookups : null;
    return {
      memory_cache_entries: this.cache.size,
      max_memory_cache_entries: this.maxCacheEntries,
      ttl_ms: this.cacheTtlMs,
      shared_cache: this.sharedCache?.getHealthSnapshot() ?? { configured: false },
      stats: {
        ...this.stats,
        redis_lookups: redisLookups,
        redis_hit_rate: redisHitRate,
      },
      key_context: {
        model: this.cacheKeyContext.model,
        dims: this.cacheKeyContext.dims,
        api_base_configured: this.cacheKeyContext.api_base.length > 0,
        version: this.cacheKeyContext.version ?? "query-embedding-v1",
      }
    };
  }

  async close(): Promise<void> {
    await this.sharedCache?.close?.();
  }
}

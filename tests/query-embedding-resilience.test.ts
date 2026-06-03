import assert from "node:assert/strict";
import test from "node:test";

import { ResilientQueryEmbeddingProvider } from "../app/recall/query-embedding-resilience";
import type { QueryEmbeddingSharedCache } from "../app/recall/query-embedding-resilience";
import type {
  EmbedQueryResult,
  QueryEmbeddingProvider
} from "../app/recall/retrievers/vector-retriever";

test("resilient embedding provider retries transient failures before giving up", async () => {
  let attempts = 0;
  const provider = new ResilientQueryEmbeddingProvider(
    {
      async embed_query(): Promise<EmbedQueryResult> {
        attempts += 1;
        if (attempts < 3) {
          return {
            embedding: null,
            audit: {
              fresh_cache_hit: false,
              stale_cache_hit: false,
              attempt_count: 1,
              final_error: "upstream_empty",
              error_code: "UPSTREAM_NULL"
            }
          };
        }
        return {
          embedding: [0.1, 0.2, 0.3],
          audit: {
            fresh_cache_hit: false,
            stale_cache_hit: false,
            attempt_count: 1
          }
        };
      }
    } satisfies QueryEmbeddingProvider,
    {
      max_retries: 2,
      retry_delay_ms: 1,
      cache_ttl_ms: 1000
    }
  );

  const result = await provider.embed_query({
    query: "memory framework",
    query_terms: ["memory", "framework"]
  });

  assert.deepEqual(result.embedding, [0.1, 0.2, 0.3]);
  assert.deepEqual(result.audit, {
    fresh_cache_hit: false,
    stale_cache_hit: false,
    attempt_count: 3,
    final_error: "upstream_empty",
    error_code: "UPSTREAM_NULL"
  });
  assert.equal(attempts, 3);
});

test("resilient embedding provider serves fresh cache hits without upstream call", async () => {
  let attempts = 0;
  const provider = new ResilientQueryEmbeddingProvider(
    {
      async embed_query(): Promise<EmbedQueryResult> {
        attempts += 1;
        return {
          embedding: [0.4, 0.5, 0.6],
          audit: {
            fresh_cache_hit: false,
            stale_cache_hit: false,
            attempt_count: 1
          }
        };
      }
    } satisfies QueryEmbeddingProvider,
    {
      cache_ttl_ms: 1000
    }
  );

  const first = await provider.embed_query({
    query: "cache me",
    query_terms: ["cache", "me"]
  });
  const second = await provider.embed_query({
    query: "cache me",
    query_terms: ["cache", "me"]
  });

  assert.deepEqual(first.embedding, [0.4, 0.5, 0.6]);
  assert.deepEqual(second.embedding, [0.4, 0.5, 0.6]);
  assert.deepEqual(second.audit, {
    fresh_cache_hit: true,
    stale_cache_hit: false,
    attempt_count: 0
  });
  assert.equal(attempts, 1);
});
test("resilient embedding provider reuses stale cached embedding when upstream later fails", async () => {
  let shouldFail = false;
  let attempts = 0;
  const provider = new ResilientQueryEmbeddingProvider(
    {
      async embed_query(): Promise<EmbedQueryResult> {
        attempts += 1;
        if (shouldFail) {
          return {
            embedding: null,
            audit: {
              fresh_cache_hit: false,
              stale_cache_hit: false,
              attempt_count: 1,
              final_error: "socket hang up",
              error_code: "ECONNRESET"
            }
          };
        }
        return {
          embedding: [0.9, 0.8, 0.7],
          audit: {
            fresh_cache_hit: false,
            stale_cache_hit: false,
            attempt_count: 1
          }
        };
      }
    } satisfies QueryEmbeddingProvider,
    {
      max_retries: 0,
      cache_ttl_ms: 5,
      allow_stale_on_error: true
    }
  );

  const initial = await provider.embed_query({
    query: "memory-system",
    query_terms: ["memory-system"]
  });
  assert.deepEqual(initial.embedding, [0.9, 0.8, 0.7]);

  await new Promise((resolve) => setTimeout(resolve, 10));
  shouldFail = true;

  const recovered = await provider.embed_query({
    query: "memory-system",
    query_terms: ["memory-system"]
  });

  assert.deepEqual(recovered.embedding, [0.9, 0.8, 0.7]);
  assert.deepEqual(recovered.audit, {
    fresh_cache_hit: false,
    stale_cache_hit: true,
    attempt_count: 1,
    final_error: "socket hang up",
    error_code: "ECONNRESET"
  });
  assert.equal(attempts, 2);
});

test("resilient embedding provider reports upstream exhaustion without stale cache", async () => {
  let attempts = 0;
  const provider = new ResilientQueryEmbeddingProvider(
    {
      async embed_query(): Promise<EmbedQueryResult> {
        attempts += 1;
        return {
          embedding: null,
          audit: {
            fresh_cache_hit: false,
            stale_cache_hit: false,
            attempt_count: 1,
            final_error: "socket hang up",
            error_code: "ECONNRESET"
          }
        };
      }
    } satisfies QueryEmbeddingProvider,
    {
      max_retries: 2,
      retry_delay_ms: 1,
      allow_stale_on_error: false
    }
  );

  const result = await provider.embed_query({
    query: "always fail",
    query_terms: ["always", "fail"]
  });

  assert.equal(result.embedding, null);
  assert.deepEqual(result.audit, {
    fresh_cache_hit: false,
    stale_cache_hit: false,
    attempt_count: 3,
    final_error: "socket hang up",
    error_code: "ECONNRESET"
  });
  assert.equal(attempts, 3);
});

test("resilient embedding provider serves Redis shared cache before upstream", async () => {
  let attempts = 0;
  const sharedCache: QueryEmbeddingSharedCache = {
    async get() {
      return { status: "hit", embedding: [0.7, 0.8, 0.9] };
    },
    async set() {
      return { status: "miss" };
    },
    getHealthSnapshot() {
      return { configured: true, available: true };
    }
  };
  const provider = new ResilientQueryEmbeddingProvider(
    {
      async embed_query(): Promise<EmbedQueryResult> {
        attempts += 1;
        return {
          embedding: [0.1],
          audit: { fresh_cache_hit: false, stale_cache_hit: false, attempt_count: 1 }
        };
      }
    } satisfies QueryEmbeddingProvider,
    {
      shared_cache: sharedCache,
      cache_key_context: { model: "m", dims: 3, api_base: "http://embedding" }
    }
  );

  const result = await provider.embed_query({ query: "redis hit", query_terms: [] });
  assert.deepEqual(result.embedding, [0.7, 0.8, 0.9]);
  assert.equal(result.audit.cache_backend, "redis");
  assert.equal(result.audit.redis_cache_status, "hit");
  assert.equal(attempts, 0);
});

test("resilient embedding provider reuses Redis cache across provider instances", async () => {
  let attempts = 0;
  const entries = new Map<string, readonly number[]>();
  const sharedCache: QueryEmbeddingSharedCache = {
    async get(key) {
      const embedding = entries.get(key);
      return embedding ? { status: "hit", embedding } : { status: "miss" };
    },
    async set(key, embedding) {
      entries.set(key, [...embedding]);
      return { status: "miss" };
    },
    getHealthSnapshot() {
      return { configured: true, available: true, stats: { hits: 1, misses: 1, stores: 1, fallbacks: 0 } };
    }
  };
  const baseProvider: QueryEmbeddingProvider = {
    async embed_query(): Promise<EmbedQueryResult> {
      attempts += 1;
      return {
        embedding: [0.2, 0.4, 0.6],
        audit: { fresh_cache_hit: false, stale_cache_hit: false, attempt_count: 1 }
      };
    }
  };
  const options = {
    shared_cache: sharedCache,
    cache_ttl_ms: 1000,
    cache_key_context: { model: "m", dims: 3, api_base: "http://embedding" }
  };

  const firstProvider = new ResilientQueryEmbeddingProvider(baseProvider, options);
  const first = await firstProvider.embed_query({ query: "cold start redis", query_terms: ["cold", "redis"] });
  const secondProvider = new ResilientQueryEmbeddingProvider(baseProvider, options);
  const second = await secondProvider.embed_query({ query: "cold start redis", query_terms: ["redis", "cold"] });

  assert.deepEqual(first.embedding, [0.2, 0.4, 0.6]);
  assert.deepEqual(second.embedding, [0.2, 0.4, 0.6]);
  assert.equal(second.audit.cache_backend, "redis");
  assert.equal(second.audit.redis_cache_status, "hit");
  assert.equal(attempts, 1);
});

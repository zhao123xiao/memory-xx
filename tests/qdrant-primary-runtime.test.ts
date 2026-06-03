import assert from "node:assert/strict";
import test from "node:test";

import {
  FilterMode,
  LifecycleStatus,
  ReviewState,
  ScopeType
} from "../app/shared";
import {
  createConfiguredRecallRuntime,
  loadMemoryV2QdrantConfig
} from "../app/recall";
import { RecallOrchestrator } from "../app/recall/orchestrator";
import { StubLexicalRetriever } from "../app/recall/retrievers/lexical-retriever";
import { StubVectorRetriever } from "../app/recall/retrievers/vector-retriever";
import { QdrantVectorRetriever } from "../app/recall/retrievers/qdrant-retriever";
import {
  QueryType,
  RetrievalStrategy,
  type RecallRecord
} from "../app/recall/types";

function createRecord(): RecallRecord {
  return {
    memory_id: "mem-qdrant-1",
    title: "Qdrant primary memory",
    content: "Qdrant is the primary ANN path and pgvector is the database fallback.",
    scope_type: ScopeType.Project,
    scope_id: "p-alpha",
    lifecycleStatus: LifecycleStatus.Approved,
    isCurrent: true,
    reviewState: ReviewState.Approved,
    project_id: "p-alpha",
    semantic_terms: ["qdrant", "primary", "ann"],
    lexical_terms: ["qdrant", "pgvector", "fallback"]
  };
}

test("qdrant retriever uses primary search results when configured", async () => {
  const record = createRecord();
  const retriever = new QdrantVectorRetriever({
    base_url: "http://qdrant:6333",
    collection_name: "memory-xx",
    query_embedding_provider: {
      async embed_query() {
        return {
          embedding: [0.1, 0.2, 0.3],
          audit: {
            fresh_cache_hit: false,
            stale_cache_hit: false,
            attempt_count: 1
          }
        };
      }
    },
    search_executor: async () => ({
      points: [
        {
          id: record.memory_id,
          score: 0.92,
          payload: {
            memory_id: record.memory_id,
            title: record.title,
            content: record.content,
            scope_type: record.scope_type,
            scope_id: record.scope_id,
            project_id: record.project_id,
            semantic_terms: record.semantic_terms,
            lexical_terms: record.lexical_terms,
            lifecycle_status: record.lifecycleStatus,
            review_state: record.reviewState,
            is_current: record.isCurrent
          }
        }
      ]
    })
  });

  const result = await retriever.retrieve({
    normalized_query: "qdrant ann primary path",
    query_terms: ["qdrant", "ann", "primary", "path"],
    allowed_scope_set: [{ type: ScopeType.Project, id: "p-alpha" }],
    filter_plan: {
      requested_mode: FilterMode.Default,
      applied_mode: FilterMode.Default,
      predicate_id: "effective_recallable",
      expression: "is recallable",
      sql_where_clause: "TRUE",
      evaluate: () => true
    },
    metadata: {
      project_ids: [],
      tags: [],
      entity_names: [],
      source_types: [],
      years: []
    },
    classification: {
      query_type: QueryType.ExploratorySemantic,
      confidence: 0.9,
      strategy_hint: RetrievalStrategy.Hybrid,
      top_k: 5,
      rerank_enabled: true,
      explain_detail: "basic",
      reasons: [],
      used_hint: false
    },
    limit: 5,
    offset: 0
  });

  assert.equal(result[0]?.memory_id, record.memory_id);
  assert.equal(result[0]?.source_retrievers.includes("qdrant"), true);
  assert.equal(result[0]?.why_matched.includes("qdrant_primary_ann"), true);
});

test("qdrant retriever falls back to pgvector-compatible retriever on primary failure", async () => {
  const record = createRecord();
  const fallbackRetriever = new StubVectorRetriever({ records: [record], minimum_score: 0 });
  const retriever = new QdrantVectorRetriever({
    base_url: "http://qdrant:6333",
    collection_name: "memory-xx",
    query_embedding_provider: {
      async embed_query() {
        return {
          embedding: [0.1, 0.2, 0.3],
          audit: {
            fresh_cache_hit: false,
            stale_cache_hit: false,
            attempt_count: 1
          }
        };
      }
    },
    fallback_retriever: fallbackRetriever,
    search_executor: async () => {
      throw new Error("qdrant unavailable");
    }
  });

  const result = await retriever.retrieve({
    normalized_query: "qdrant ann primary path",
    query_terms: ["qdrant", "ann", "primary", "path"],
    allowed_scope_set: [{ type: ScopeType.Project, id: "p-alpha" }],
    filter_plan: {
      requested_mode: FilterMode.Default,
      applied_mode: FilterMode.Default,
      predicate_id: "effective_recallable",
      expression: "is recallable",
      sql_where_clause: "TRUE",
      evaluate: () => true
    },
    metadata: {
      project_ids: [],
      tags: [],
      entity_names: [],
      source_types: [],
      years: []
    },
    classification: {
      query_type: QueryType.ExploratorySemantic,
      confidence: 0.9,
      strategy_hint: RetrievalStrategy.Hybrid,
      top_k: 5,
      rerank_enabled: true,
      explain_detail: "basic",
      reasons: [],
      used_hint: false
    },
    limit: 5,
    offset: 0
  });

  assert.equal(result[0]?.memory_id, record.memory_id);
  assert.equal(result[0]?.source_retrievers.includes("pgvector-fallback"), true);
  assert.equal(
    result[0]?.why_matched.some((reason) => reason.includes("vector_fallback:qdrant_backend_unavailable")),
    true
  );
});

test("qdrant retriever falls back when primary search exceeds timeout budget", async () => {
  const record = createRecord();
  const fallbackRetriever = new StubVectorRetriever({ records: [record], minimum_score: 0 });
  const retriever = new QdrantVectorRetriever({
    base_url: "http://qdrant:6333",
    collection_name: "memory-xx",
    timeout_ms: 5,
    query_embedding_provider: {
      async embed_query() {
        return {
          embedding: [0.1, 0.2, 0.3],
          audit: {
            fresh_cache_hit: false,
            stale_cache_hit: false,
            attempt_count: 1
          }
        };
      }
    },
    fallback_retriever: fallbackRetriever,
    search_executor: async () => new Promise(() => undefined)
  });

  const result = await retriever.retrieve({
    normalized_query: "qdrant ann primary path",
    query_terms: ["qdrant", "ann", "primary", "path"],
    allowed_scope_set: [{ type: ScopeType.Project, id: "p-alpha" }],
    filter_plan: {
      requested_mode: FilterMode.Default,
      applied_mode: FilterMode.Default,
      predicate_id: "effective_recallable",
      expression: "is recallable",
      sql_where_clause: "TRUE",
      evaluate: () => true
    },
    metadata: {
      project_ids: [],
      tags: [],
      entity_names: [],
      source_types: [],
      years: []
    },
    classification: {
      query_type: QueryType.ExploratorySemantic,
      confidence: 0.9,
      strategy_hint: RetrievalStrategy.Hybrid,
      top_k: 5,
      rerank_enabled: true,
      explain_detail: "basic",
      reasons: [],
      used_hint: false
    },
    limit: 5,
    offset: 0
  });

  assert.equal(result[0]?.memory_id, record.memory_id);
  assert.equal(
    result[0]?.why_matched.some((reason) => reason.includes("vector_fallback:qdrant_timeout")),
    true
  );
});

test("recall orchestrator reports degrade level 1 when qdrant falls back to pgvector", async () => {
  const record = createRecord();
  const vectorRetriever = new QdrantVectorRetriever({
    base_url: "http://qdrant:6333",
    collection_name: "memory-xx",
    query_embedding_provider: {
      async embed_query() {
        return {
          embedding: [0.1, 0.2, 0.3],
          audit: {
            fresh_cache_hit: false,
            stale_cache_hit: false,
            attempt_count: 1
          }
        };
      }
    },
    fallback_retriever: new StubVectorRetriever({ records: [record], minimum_score: 0 }),
    search_executor: async () => {
      throw new Error("qdrant unavailable");
    }
  });
  const orchestrator = new RecallOrchestrator({
    lexical_retriever: new StubLexicalRetriever(),
    vector_retriever: vectorRetriever
  });

  const response = await orchestrator.execute({
    query: "qdrant ann primary path",
    scope_context: { project_ids: ["p-alpha"] },
    limit: 5,
    debug: { enabled: true }
  });

  assert.equal(response.degraded, true);
  assert.equal(response.degrade_level, 1);
  assert.match(response.degrade_reason ?? "", /qdrant_fallback_pgvector/);
  assert.equal(response.results[0]?.memory_id, record.memory_id);
});

test("qdrant backend status exposes primary and fallback metadata", async () => {
  const retriever = new QdrantVectorRetriever({
    base_url: "http://127.0.0.1:6333",
    collection_name: "memory-xx",
    query_embedding_provider: {
      async embed_query() {
        return {
          embedding: [0.1, 0.2, 0.3],
          audit: {
            fresh_cache_hit: false,
            stale_cache_hit: false,
            attempt_count: 1
          }
        };
      }
    },
    fallback_retriever: new StubVectorRetriever()
  });

  const status = await retriever.get_backend_status();
  assert.equal(status.available, true);
  assert.equal(status.backend, "qdrant");
  assert.equal(status.primary_backend, "qdrant");
  assert.equal(status.fallback_backend, "stub-vector");
  assert.equal(status.fallback_available, true);
});

test("configured runtime prefers qdrant-primary when docker qdrant env is present", async () => {
  const config = loadMemoryV2QdrantConfig({
    MEMORY_V2_QDRANT_BASE_URL: "http://127.0.0.1:6333",
    MEMORY_V2_QDRANT_COLLECTION: "memory-xx-live"
  });

  const runtime = createConfiguredRecallRuntime({
    config: {
      databaseUrl: "postgres://postgres:postgres@127.0.0.1:55432/memory_xx",
      schema: "public",
      applicationName: "memory-xx-test",
      maxConnections: 1,
      idleTimeoutMs: 1000,
      connectionTimeoutMs: 1000,
      ssl: false
    },
    qdrant: config
  });

  assert.equal(runtime.vector_runtime_mode, "qdrant-primary");
  const status = await runtime.runtime.vector_retriever.get_backend_status();
  assert.equal(status.primary_backend, "qdrant");
  assert.equal(status.fallback_backend, "pgvector");
  await runtime.runtime.close();
});

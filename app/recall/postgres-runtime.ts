import { Pool } from "pg";

import type { RecallCacheRuntime } from "../cache";
import {
  createPostgresPoolConfig,
  type MemoryXXPostgresConfig
} from "../db/adapters/postgres-config";
import { RecallOrchestrator } from "./orchestrator";
import {
  PostgresLexicalRetriever
} from "./retrievers/lexical-retriever";
import { PostgresGraphRetriever } from "./retrievers/graph-retriever";
import {
  PostgresVectorRetriever,
  type PostgresVectorRetrieverOptions,
  type QueryEmbeddingProvider,
  type VectorRetriever
} from "./retrievers/vector-retriever";
import { QdrantVectorRetriever } from "./retrievers/qdrant-retriever";
import {
  type MemoryXXQdrantConfig,
  resolveVectorRuntimeMode
} from "./qdrant-config";
import {
  type RuntimeScopeContextAdapter,
  type ScopeAccessPolicy
} from "./scope-resolver";

export interface PostgresRecallRuntimeOptions {
  readonly config: MemoryXXPostgresConfig;
  readonly recall_cache?: RecallCacheRuntime;
  readonly runtime_scope_adapter?: RuntimeScopeContextAdapter;
  readonly scope_access_policy?: ScopeAccessPolicy;
  readonly query_embedding_provider?: QueryEmbeddingProvider;
  readonly vector_column_name?: string;
}

export interface QdrantPrimaryRecallRuntimeOptions
  extends PostgresRecallRuntimeOptions {
  readonly qdrant_base_url?: string;
  readonly qdrant_api_key?: string;
  readonly qdrant_collection_name?: string;
  readonly qdrant_minimum_score?: number;
}

export interface PostgresRecallRuntime {
  readonly orchestrator: RecallOrchestrator;
  readonly lexical_retriever: PostgresLexicalRetriever;
  readonly vector_retriever: VectorRetriever;
  readonly graph_retriever: PostgresGraphRetriever;
  close(): Promise<void>;
}

export interface ConfiguredRecallRuntime {
  readonly runtime: PostgresRecallRuntime;
  readonly vector_runtime_mode: "postgres-primary" | "qdrant-primary";
}

export function createPostgresRecallRuntime(
  options: PostgresRecallRuntimeOptions
): PostgresRecallRuntime {
  const pool = new Pool(createPostgresPoolConfig(options.config));
  const lexicalRetriever = new PostgresLexicalRetriever({
    config: options.config,
    pool
  });
  const vectorRetriever = new PostgresVectorRetriever({
    config: options.config,
    pool,
    query_embedding_provider: options.query_embedding_provider,
    vector_column_name: options.vector_column_name
  } satisfies PostgresVectorRetrieverOptions);
  const graphRetriever = new PostgresGraphRetriever({
    config: options.config,
    pool
  });

  return {
    lexical_retriever: lexicalRetriever,
    vector_retriever: vectorRetriever,
    graph_retriever: graphRetriever,
    orchestrator: new RecallOrchestrator({
      lexical_retriever: lexicalRetriever,
      vector_retriever: vectorRetriever,
      graph_retriever: graphRetriever,
      recall_cache: options.recall_cache,
      runtime_scope_adapter: options.runtime_scope_adapter,
      scope_access_policy: options.scope_access_policy,
      recent_approved_queryable: pool,
      recent_approved_schema: options.config.schema
    }),
    async close(): Promise<void> {
      await pool.end();
    }
  };
}

export function createQdrantPrimaryRecallRuntime(
  options: QdrantPrimaryRecallRuntimeOptions
): PostgresRecallRuntime {
  const pool = new Pool(createPostgresPoolConfig(options.config));
  const lexicalRetriever = new PostgresLexicalRetriever({
    config: options.config,
    pool
  });
  const pgFallbackRetriever = new PostgresVectorRetriever({
    config: options.config,
    pool,
    query_embedding_provider: options.query_embedding_provider,
    vector_column_name: options.vector_column_name
  } satisfies PostgresVectorRetrieverOptions);
  const vectorRetriever = new QdrantVectorRetriever({
    base_url: options.qdrant_base_url,
    api_key: options.qdrant_api_key,
    collection_name: options.qdrant_collection_name,
    query_embedding_provider: options.query_embedding_provider,
    fallback_retriever: pgFallbackRetriever,
    minimum_score: options.qdrant_minimum_score
  });
  const graphRetriever = new PostgresGraphRetriever({
    config: options.config,
    pool
  });

  return {
    lexical_retriever: lexicalRetriever,
    vector_retriever: vectorRetriever,
    graph_retriever: graphRetriever,
    orchestrator: new RecallOrchestrator({
      lexical_retriever: lexicalRetriever,
      vector_retriever: vectorRetriever,
      graph_retriever: graphRetriever,
      recall_cache: options.recall_cache,
      runtime_scope_adapter: options.runtime_scope_adapter,
      scope_access_policy: options.scope_access_policy,
      recent_approved_queryable: pool,
      recent_approved_schema: options.config.schema
    }),
    async close(): Promise<void> {
      await pool.end();
    }
  };
}

export function createConfiguredRecallRuntime(
  options: PostgresRecallRuntimeOptions & {
    readonly qdrant?: MemoryXXQdrantConfig;
  }
): ConfiguredRecallRuntime {
  const runtimeMode = resolveVectorRuntimeMode(options.qdrant ?? { enabled: false });
  const runtime =
    runtimeMode === "qdrant-primary"
      ? createQdrantPrimaryRecallRuntime({
          ...options,
          qdrant_base_url: options.qdrant?.base_url,
          qdrant_api_key: options.qdrant?.api_key,
          qdrant_collection_name: options.qdrant?.collection_name,
          qdrant_minimum_score: options.qdrant?.minimum_score
        })
      : createPostgresRecallRuntime(options);

  return {
    runtime,
    vector_runtime_mode: runtimeMode
  };
}

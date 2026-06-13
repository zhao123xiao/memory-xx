import assert from "node:assert/strict";
import test from "node:test";

import { PostgresVectorRetriever } from "../app/recall/retrievers/vector-retriever";
import { RecallError, RecallErrorCode } from "../app/recall/errors";
import {
  FilterMode,
  ScopeType
} from "../app/shared";
import {
  QueryType,
  RetrievalStrategy,
  type QueryConstraints
} from "../app/recall/types";

function constraints(): QueryConstraints {
  return {
    normalized_query: "vector safety",
    query_terms: ["vector", "safety"],
    allowed_scope_set: [{ type: ScopeType.Project, id: "project-1" }],
    filter_plan: {
      requested_mode: FilterMode.Default,
      applied_mode: FilterMode.Default,
      predicate_id: "test",
      expression: "TRUE",
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
      query_type: QueryType.ProjectContext,
      confidence: 1,
      strategy_hint: RetrievalStrategy.Hybrid,
      top_k: 10,
      rerank_enabled: true,
      explain_detail: "basic",
      reasons: [],
      used_hint: false
    },
    limit: 10,
    offset: 0
  };
}

test("Postgres vector retriever rejects non-finite query embedding values before SQL", async () => {
  let vectorSqlCalls = 0;
  const client = {
    query: async (sql: string) => {
      if (sql.includes("pg_extension")) {
        return { rows: [{ installed: true }] };
      }
      if (sql.includes("information_schema.columns")) {
        return { rows: [{ present: true }] };
      }
      if (sql.includes("<=>")) {
        vectorSqlCalls += 1;
      }
      return { rows: [] };
    },
    release: () => {}
  };
  const retriever = new PostgresVectorRetriever({
    config: {
      databaseUrl: "postgres://example",
      schema: "memory_v2_test",
      applicationName: "memory-xx-test",
      maxConnections: 1,
      idleTimeoutMs: 30_000,
      connectionTimeoutMs: 1000,
      ssl: false
    },
    pool: { connect: async () => client } as never,
    query_embedding_provider: {
      embed_query: () => ({
        embedding: [0.1, Number.NaN, 0.3],
        audit: {
          fresh_cache_hit: false,
          stale_cache_hit: false,
          attempt_count: 0
        }
      })
    }
  });

  await assert.rejects(
    () => retriever.retrieve(constraints()),
    (error) => error instanceof RecallError &&
      error.code === RecallErrorCode.BackendUnavailable &&
      /non-finite/i.test(error.message)
  );
  assert.equal(vectorSqlCalls, 0);
});

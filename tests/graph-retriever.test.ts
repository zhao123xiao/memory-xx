import assert from "node:assert/strict";
import test from "node:test";

import { PostgresGraphRetriever } from "../app/recall/retrievers/graph-retriever";
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
    normalized_query: "memory graph",
    query_terms: ["memory", "graph"],
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

test("Postgres graph retriever applies a bounded statement timeout before heavy graph SQL", async () => {
  const queries: Array<{ sql: string; params?: readonly unknown[] }> = [];
  const client = {
    query: async (sql: string, params?: readonly unknown[]) => {
      queries.push({ sql, params });
      return { rows: [] };
    },
    release: () => {}
  };
  const pool = {
    connect: async () => client
  };
  const retriever = new PostgresGraphRetriever({
    config: {
      databaseUrl: "postgres://example",
      schema: "memory_v2_test",
      applicationName: "memory-xx-test",
      maxConnections: 1,
      idleTimeoutMs: 30_000,
      connectionTimeoutMs: 1000,
      ssl: false
    },
    pool: pool as never
  });

  await retriever.retrieve(constraints());

  const timeoutCallIndex = queries.findIndex((query) => query.sql.includes("set_config('statement_timeout'"));
  const graphSqlIndex = queries.findIndex((query) => query.sql.includes("candidate_graph_ids"));
  assert.notEqual(timeoutCallIndex, -1);
  assert.notEqual(graphSqlIndex, -1);
  assert.ok(timeoutCallIndex < graphSqlIndex);
  assert.deepEqual(queries[timeoutCallIndex]?.params, ["2000"]);
});

test("Postgres graph retriever maps statement timeout cancellation to backend timeout", async () => {
  const client = {
    query: async (sql: string) => {
      if (sql.includes("candidate_graph_ids")) {
        throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
      }
      return { rows: [] };
    },
    release: () => {}
  };
  const pool = {
    connect: async () => client
  };
  const retriever = new PostgresGraphRetriever({
    config: {
      databaseUrl: "postgres://example",
      schema: "memory_v2_test",
      applicationName: "memory-xx-test",
      maxConnections: 1,
      idleTimeoutMs: 30_000,
      connectionTimeoutMs: 1000,
      ssl: false
    },
    pool: pool as never
  });

  await assert.rejects(
    () => retriever.retrieve(constraints()),
    (error) => error instanceof RecallError &&
      error.code === RecallErrorCode.BackendTimeout &&
      error.details?.timeout_ms === 2000
  );
});

test("Postgres graph retriever admits graph records when record text matches even if entity and relation labels do not", async () => {
  const queries: Array<{ sql: string; params?: readonly unknown[] }> = [];
  const client = {
    query: async (sql: string, params?: readonly unknown[]) => {
      queries.push({ sql, params });
      return { rows: [] };
    },
    release: () => {}
  };
  const pool = {
    connect: async () => client
  };
  const retriever = new PostgresGraphRetriever({
    config: {
      databaseUrl: "postgres://example",
      schema: "memory_v2_test",
      applicationName: "memory-xx-test",
      maxConnections: 1,
      idleTimeoutMs: 30_000,
      connectionTimeoutMs: 1000,
      ssl: false
    },
    pool: pool as never
  });

  await retriever.retrieve(constraints());

  const graphSql = queries.find((query) => query.sql.includes("candidate_graph_ids"))?.sql ?? "";
  assert.match(graphSql, /text_stats\.match_count > 0/su);
  assert.match(graphSql, /\(entity_stats\.total_count > 0 OR relation_stats\.total_count > 0\)/su);
  assert.doesNotMatch(graphSql, /AND \(entity_stats\.match_count > 0 OR relation_stats\.matched_count > 0\)\s+ORDER BY/su);
});

test("Postgres graph retriever separates candidate id selection from evidence hydration", async () => {
  const queries: Array<{ sql: string; params?: readonly unknown[] }> = [];
  const client = {
    query: async (sql: string, params?: readonly unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes("candidate_graph_ids")) {
        return { rows: [{ id: "memory-1", graph_score: 1.2, graph_rank_reason: "entity_exact", graph_text: "memory graph" }] };
      }
      return { rows: [] };
    },
    release: () => {}
  };
  const pool = {
    connect: async () => client
  };
  const retriever = new PostgresGraphRetriever({
    config: {
      databaseUrl: "postgres://example",
      schema: "memory_v2_test",
      applicationName: "memory-xx-test",
      maxConnections: 1,
      idleTimeoutMs: 30_000,
      connectionTimeoutMs: 1000,
      ssl: false
    },
    pool: pool as never
  });

  await retriever.retrieve(constraints());

  const candidateSqlIndex = queries.findIndex((query) => query.sql.includes("candidate_graph_ids"));
  const hydrationSqlIndex = queries.findIndex((query) => query.sql.includes("WHERE mr.id = ANY"));
  assert.notEqual(candidateSqlIndex, -1);
  assert.notEqual(hydrationSqlIndex, -1);
  assert.ok(candidateSqlIndex < hydrationSqlIndex);
  assert.match(queries[hydrationSqlIndex]?.sql ?? "", /WHERE mr\.id = ANY\(\$\d+::text\[\]\)/u);
  assert.doesNotMatch(queries[candidateSqlIndex]?.sql ?? "", /jsonb_agg\(jsonb_build_object/su);
});

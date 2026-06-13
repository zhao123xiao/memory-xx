import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";

import { fetchRecentApprovedPgFallback } from "../app/recall/recent-approved-pg-fallback";
import { FilterMode, LifecycleStatus, ReviewState, ScopeType } from "../app/shared/types";
import { QueryType, RetrievalStrategy, type QueryConstraints } from "../app/recall/types";

test("recent approved PG fallback seeds explicit memory ids without relying on recent window", async () => {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const result = await fetchRecentApprovedPgFallback({
    schema: "memory_v2",
    constraints: constraints({ memory_ids: ["memory_record_exact"] }),
    queryable: {
      async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
        queries.push({ sql, values: values ?? [] });
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: [{
            id: "memory_record_exact",
            scope_type: ScopeType.Project,
            scope_id: "memory-xx",
            content: "Exact memory id content",
            title: "Exact",
            summary: null,
            metadata: { recall_policy: "default", memory_type: "fact" },
            memory_type: "fact",
            memory_layer: "semantic",
            fact_status: "current",
            valid_at: null,
            invalid_at: null,
            observed_at: null,
            expires_at: null,
            importance: 0.5,
            memory_strength: 1,
            decay_policy: "default",
            created_at: "2026-06-01T00:00:00.000Z",
            updated_at: "2026-06-01T00:00:00.000Z",
            source_path: null,
            source_type: null,
          }],
        } as unknown as QueryResult<T>;
      },
    },
    env: {
      MEMORY_XX_RECENT_APPROVED_PG_FALLBACK_WINDOW_MS: "30000",
      MEMORY_XX_RECENT_APPROVED_PG_FALLBACK_LIMIT: "20",
    } as NodeJS.ProcessEnv,
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.memory_id, "memory_record_exact");
  assert.equal(result.audit.reason, "explicit_memory_ids");
  assert.match(queries[0]?.sql ?? "", /mr\.id = ANY/u);
  assert.doesNotMatch(queries[0]?.sql ?? "", /mr\.updated_at >= now/u);
  assert.equal(queries[0]?.values[0], 20);
});

test("recent approved PG fallback treats explicit memory ids as recallable across approved review states and policies", async () => {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const result = await fetchRecentApprovedPgFallback({
    schema: "memory_v2",
    constraints: constraints({
      memory_ids: ["memory_record_mcp_exact"],
      allowed_scope_set: [{ type: ScopeType.Project, id: "mcp-user-flow-test" }]
    }),
    queryable: {
      async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
        queries.push({ sql, values: values ?? [] });
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: [{
            id: "memory_record_mcp_exact",
            scope_type: ScopeType.Project,
            scope_id: "mcp-user-flow-test",
            content: "MCP exact recall should return this record even when query terms differ.",
            title: "MCP exact recall",
            summary: null,
            metadata: { recall_policy: "explicit_only", memory_type: "fact" },
            memory_type: "fact",
            memory_layer: "semantic",
            fact_status: "current",
            valid_at: null,
            invalid_at: null,
            observed_at: null,
            expires_at: null,
            importance: 0.5,
            memory_strength: 1,
            decay_policy: "default",
            created_at: "2026-06-01T00:00:00.000Z",
            updated_at: "2026-06-01T00:00:00.000Z",
            source_path: null,
            source_type: null,
          }],
        } as unknown as QueryResult<T>;
      },
    },
    env: {
      MEMORY_XX_RECENT_APPROVED_PG_FALLBACK_WINDOW_MS: "30000",
      MEMORY_XX_RECENT_APPROVED_PG_FALLBACK_LIMIT: "20",
    } as NodeJS.ProcessEnv,
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.memory_id, "memory_record_mcp_exact");
  assert.equal(result.candidates[0]?.score, 1);
  assert.deepEqual(result.candidates[0]?.why_matched, ["recent_approved_pg_fallback", "exact_memory_id"]);
  assert.doesNotMatch(queries[0]?.sql ?? "", /recall_policy'.*= 'default'/su);
});

function constraints(overrides: Partial<QueryConstraints> = {}): QueryConstraints {
  return {
    normalized_query: "exact",
    query_terms: ["exact"],
    allowed_scope_set: [{ type: ScopeType.Project, id: "memory-xx" }],
    scope_conflict_policy: "more_specific_wins",
    scope_precedence: {
      task: 6,
      run: 5,
      project: 4,
      workspace: 3,
      user: 2,
      global: 1,
    },
    filter_plan: {
      requested_mode: FilterMode.Default,
      applied_mode: FilterMode.Default,
      predicate_id: "effective_recallable",
      expression: "test",
      sql_where_clause: "TRUE",
      evaluate: (record) => record.lifecycleStatus === LifecycleStatus.Approved &&
        [ReviewState.Approved, ReviewState.NotRequired, ReviewState.SilentApproved].includes(record.reviewState as ReviewState) &&
        record.isCurrent !== false &&
        record.recallPolicy === "default",
    },
    metadata: {
      project_ids: [],
      tags: [],
      entity_names: [],
      source_types: [],
      years: [],
    },
    classification: {
      query_type: QueryType.ExactLookup,
      confidence: 1,
      strategy_hint: RetrievalStrategy.Hybrid,
      top_k: 5,
      rerank_enabled: false,
      explain_detail: "basic",
      reasons: [],
      used_hint: false,
    },
    limit: 5,
    offset: 0,
    force_model_rerank: false,
    query_context: {
      original_query: "exact",
      context_queries: [],
      expanded: false,
      token_cap: 256,
      char_cap: 500,
      terms: ["exact"],
    },
    ...overrides,
  };
}

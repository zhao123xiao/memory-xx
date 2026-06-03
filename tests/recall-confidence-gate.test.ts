import assert from "node:assert/strict";
import test from "node:test";

import { applyRecallConfidenceGate } from "../app/recall/confidence-gate";
import {
  FilterMode,
  LifecycleStatus,
  ReviewState,
  ScopeType
} from "../app/shared";
import {
  QueryType,
  RetrievalStrategy,
  type QueryConstraints,
  type RetrieverCandidate
} from "../app/recall/types";

function candidate(memoryId: string, rerankScore: number, score = 0.5): RetrieverCandidate {
  return {
    memory_id: memoryId,
    record: {
      memory_id: memoryId,
      title: memoryId,
      content: `content for ${memoryId}`,
      scope_type: ScopeType.Project,
      scope_id: "p-1",
      lifecycleStatus: LifecycleStatus.Approved,
      reviewState: ReviewState.Approved,
      isCurrent: true
    },
    score,
    rerank_score: rerankScore,
    matched_terms: [],
    why_matched: ["test"],
    source_retrievers: ["vector"]
  };
}

function constraints(queryType: QueryType): QueryConstraints {
  return {
    normalized_query: "unrelated query",
    query_terms: ["unrelated", "query"],
    allowed_scope_set: [{ type: ScopeType.Project, id: "p-1" }],
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
      query_type: queryType,
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

test("low confidence guard keeps one flagged semantic result for open-ended low scores", () => {
  const result = applyRecallConfidenceGate(
    [candidate("a", 0.01, 0.01), candidate("b", 0.02, 0.02)],
    constraints(QueryType.ExploratorySemantic),
    { model_used: true },
    { MEMORY_V2_RECALL_ABSOLUTE_MIN_SCORE: "0.03" }
  );

  assert.equal(result.audit.applied, true);
  assert.equal(result.audit.reason, "low_confidence_singleton");
  assert.equal(result.audit.low_confidence_returned, true);
  assert.equal(result.candidates.length, 1);
});

test("low confidence guard returns null for strict factual queries", () => {
  const result = applyRecallConfidenceGate(
    [candidate("a", 0.01, 0.01)],
    constraints(QueryType.ExactLookup),
    { model_used: true },
    { MEMORY_V2_RECALL_ABSOLUTE_MIN_SCORE: "0.03" }
  );

  assert.equal(result.audit.applied, true);
  assert.equal(result.audit.reason, "absolute_low_score");
  assert.equal(result.candidates.length, 0);
});

test("low confidence guard keeps model-confident semantic results", () => {
  const result = applyRecallConfidenceGate(
    [candidate("a", 0.2), candidate("b", 0.01)],
    constraints(QueryType.ExploratorySemantic),
    { model_used: true },
    { MEMORY_V2_RERANKER_NULL_GUARD_MIN_SCORE: "0.03" }
  );

  assert.equal(result.audit.applied, false);
  assert.equal(result.audit.reason, "confidence_passed");
  assert.equal(result.candidates.length, 2);
});

test("low confidence guard lets sufficiently scored exact lookups pass", () => {
  const result = applyRecallConfidenceGate(
    [candidate("a", 0.001)],
    constraints(QueryType.ExactLookup),
    { model_used: true },
    { MEMORY_V2_RERANKER_NULL_GUARD_MIN_SCORE: "0.03" }
  );

  assert.equal(result.audit.applied, false);
  assert.equal(result.audit.reason, "confidence_passed");
  assert.equal(result.candidates.length, 1);
});

test("low confidence guard suppresses direct secret value lookups", () => {
  const result = applyRecallConfidenceGate(
    [candidate("policy-row", 0.9)],
    {
      ...constraints(QueryType.ExactLookup),
      normalized_query: "家里的wifi密码"
    },
    { model_used: true },
    {}
  );

  assert.equal(result.audit.applied, true);
  assert.equal(result.audit.reason, "sensitive_value_lookup");
  assert.equal(result.candidates.length, 0);
});

test("low confidence guard keeps password policy and handling queries", () => {
  const result = applyRecallConfidenceGate(
    [candidate("policy-row", 0.9)],
    {
      ...constraints(QueryType.ExploratorySemantic),
      normalized_query: "如何确保记忆中不保存明文密码"
    },
    { model_used: true },
    {}
  );

  assert.equal(result.audit.applied, false);
  assert.equal(result.audit.reason, "confidence_passed");
  assert.equal(result.candidates.length, 1);
});

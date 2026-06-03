import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryWriteDatabase } from "../app/db/adapters/in-memory-write-database";
import { RecallFeedbackRepository } from "../app/db/repositories/recall-feedback-repository";
import { withWriteTransaction } from "../app/db/tx/write-transaction";
import {
  buildRecallQueryContext,
  buildMetadataConstraints,
  buildRecallFilterPlan,
  applyTemporalFilter,
  classifyTemporalQuery,
  computeRecallDegradeLevel,
  fuseRecallCandidatesRrf,
  normalizeGraphHealthCacheTtlMs,
  QueryType,
  RetrievalStrategy,
  rerankCandidates,
  type QueryClassification,
  type RetrieverCandidate
} from "../app/recall";
import {
  FilterMode,
  LifecycleStatus,
  ReviewState,
  ScopeType
} from "../app/shared";

function classification(queryType: QueryType): QueryClassification {
  return {
    query_type: queryType,
    confidence: 0.8,
    strategy_hint: RetrievalStrategy.Hybrid,
    top_k: 10,
    rerank_enabled: true,
    explain_detail: "basic",
    reasons: [],
    used_hint: false,
    strategy_weights: { lexical: 1, vector: 1, metadata: 0.8, temporal: 0.8, knowledge: 0.2 }
  };
}

function candidate(id: string, score: number, source: "lexical" | "vector" | "graph"): RetrieverCandidate {
  return {
    memory_id: id,
    record: {
      memory_id: id,
      title: id,
      content: `content ${id}`,
      scope_type: ScopeType.Project,
      scope_id: "p-1",
      lifecycleStatus: LifecycleStatus.Approved,
      reviewState: ReviewState.Approved,
      isCurrent: true
    },
    score,
    lexical_score: source === "lexical" ? score : undefined,
    vector_score: source === "vector" ? score : undefined,
    graph_score: source === "graph" ? score : undefined,
    matched_terms: [],
    why_matched: [source],
    source_retrievers: [source]
  };
}

test("RRF fusion uses k=20 and keeps rank signal visible", () => {
  const fused = fuseRecallCandidatesRrf({
    lexical: [candidate("lex-top", 0.1, "lexical"), candidate("shared", 0.05, "lexical")],
    vector: [candidate("shared", 0.9, "vector"), candidate("vec-second", 0.8, "vector")],
    classification: classification(QueryType.ProjectContext)
  });

  assert.equal(fused.audit.method, "rrf");
  assert.equal(fused.audit.k, 20);
  assert.equal(fused.candidates[0]?.memory_id, "shared");
  assert.equal(fused.candidates[0]?.lexical_rank, 2);
  assert.equal(fused.candidates[0]?.vector_rank, 1);
  assert.ok((fused.candidates[0]?.rrf_score ?? 0) > (fused.candidates[1]?.rrf_score ?? 0));
});

test("temporal guard preserves exact structural matches across memory layers", () => {
  const exact = {
    ...candidate("exact-episodic", 1, "lexical"),
    record: {
      ...candidate("exact-episodic", 1, "lexical").record,
      memory_layer: "episodic" as const,
      fact_status: "current" as const
    },
    why_matched: ["postgres_exact_title_match"]
  };
  const loose = {
    ...candidate("loose-episodic", 0.8, "lexical"),
    record: {
      ...candidate("loose-episodic", 0.8, "lexical").record,
      memory_layer: "episodic" as const,
      fact_status: "current" as const
    },
    why_matched: ["postgres_fts_match"]
  };

  const filtered = applyTemporalFilter(
    [exact, loose],
    classifyTemporalQuery(QueryType.DecisionLookup)
  );

  assert.deepEqual(filtered.filtered, ["exact-episodic"]);
  assert.equal(filtered.filtered_reasons.memory_layer, 1);
});

test("temporal guard keeps episodic evidence for timeline, project, and procedure queries", () => {
  const episodic = {
    ...candidate("phase-c2-episodic", 0.9, "lexical"),
    record: {
      ...candidate("phase-c2-episodic", 0.9, "lexical").record,
      memory_layer: "episodic" as const,
      fact_status: "current" as const
    },
    why_matched: ["postgres_fts_match"]
  };

  for (const queryType of [
    QueryType.TimelineHistory,
    QueryType.ProjectContext,
    QueryType.ProcedureQuery
  ]) {
    const filtered = applyTemporalFilter([episodic], classifyTemporalQuery(queryType));
    assert.deepEqual(filtered.filtered, ["phase-c2-episodic"], queryType);
  }
});

test("temporal guard keeps current-state queries focused on durable recallable layers", () => {
  const episodic = {
    ...candidate("noisy-current-episodic", 0.9, "lexical"),
    record: {
      ...candidate("noisy-current-episodic", 0.9, "lexical").record,
      memory_layer: "episodic" as const,
      fact_status: "current" as const
    },
    why_matched: ["postgres_fts_match"]
  };
  const semantic = {
    ...candidate("stable-current-semantic", 0.8, "lexical"),
    record: {
      ...candidate("stable-current-semantic", 0.8, "lexical").record,
      memory_layer: "semantic" as const,
      fact_status: "current" as const
    },
    why_matched: ["postgres_fts_match"]
  };

  const filtered = applyTemporalFilter(
    [episodic, semantic],
    classifyTemporalQuery(QueryType.CurrentStateQuery)
  );

  assert.deepEqual(filtered.filtered, ["stable-current-semantic"]);
  assert.equal(filtered.filtered_reasons.memory_layer, 1);
});

test("RRF fusion ranks graph candidates instead of appending them after hybrid fusion", () => {
  const fused = fuseRecallCandidatesRrf({
    lexical: [
      candidate("lex-only", 0.9, "lexical"),
      candidate("shared", 0.8, "lexical")
    ],
    vector: [
      candidate("vec-only", 0.9, "vector"),
      candidate("shared", 0.8, "vector")
    ],
    graph: [
      candidate("graph-evidence", 2.0, "graph"),
      candidate("shared", 1.0, "graph")
    ],
    classification: classification(QueryType.DecisionLookup)
  });

  assert.equal(fused.audit.graph_candidates, 2);
  assert.equal(fused.audit.graph_weight, 1.9);
  assert.equal(fused.candidates[0]?.memory_id, "shared");
  assert.equal(fused.candidates[0]?.graph_rank, 2);
  assert.ok(fused.candidates.slice(0, 3).some((item) => item.memory_id === "graph-evidence"));
  assert.ok(fused.candidates.find((item) => item.memory_id === "graph-evidence")?.source_retrievers.includes("graph"));
});

test("graph health guard cache TTL honors long configured windows", () => {
  assert.equal(normalizeGraphHealthCacheTtlMs(86_400_000), 86_400_000);
  assert.equal(normalizeGraphHealthCacheTtlMs(500), 1_000);
  assert.equal(normalizeGraphHealthCacheTtlMs(Number.NaN), 60_000);
});

test("minimal rerank preserves graph path evidence for project context queries", () => {
  const fused = fuseRecallCandidatesRrf({
    lexical: [
      candidate("lex-top", 0.95, "lexical"),
      candidate("lex-second", 0.85, "lexical")
    ],
    vector: [
      candidate("vec-top", 0.95, "vector"),
      candidate("vec-second", 0.85, "vector")
    ],
    graph: [
      {
        ...candidate("graph-path", 2.2, "graph"),
        matched_terms: ["doctor", "graph"],
        why_matched: ["graph_rank:entity_exact,relation_path,source_evidence"],
        record: {
          ...candidate("graph-path", 2.2, "graph").record,
          memory_strength: 1
        }
      }
    ],
    classification: classification(QueryType.ProjectContext)
  });

  const projectContext = classification(QueryType.ProjectContext);
  const ranked = rerankCandidates(fused.candidates, {
    normalized_query: "memory doctor graph modules",
    query_terms: ["memory", "doctor", "graph", "modules"],
    allowed_scope_set: [{ type: ScopeType.Project, id: "p-1" }],
    filter_plan: buildRecallFilterPlan({ requested_mode: FilterMode.Default }),
    metadata: buildMetadataConstraints({
      query: "memory doctor graph modules",
      classification: projectContext
    }),
    classification: projectContext,
    limit: 5,
    offset: 0
  });

  assert.ok(ranked.slice(0, 3).some((item) => item.memory_id === "graph-path"));
  assert.ok(ranked.find((item) => item.memory_id === "graph-path")?.why_matched.some((reason) => reason.startsWith("graph_path_bonus:")));
});

test("query context expands follow-up query with previous context and task goal", () => {
  const context = buildRecallQueryContext({
    query: "那台机器是不是内存不够",
    scope_context: { project_ids: ["memory-xx"], runtime: { task_id: "release-task" } },
    context_queries: ["Jenkins 构建一直失败"],
    current_goal: "发布流程排查",
    session_id: "s-1",
    turn_id: "t-2"
  });

  assert.equal(context.expanded, true);
  assert.match(context.expanded_query ?? "", /Jenkins/);
  assert.equal(context.task_id, "release-task");
  assert.equal(context.char_cap, 500);
  assert.equal(context.token_cap, 256);
});

test("degrade level separates qdrant fallback, vector loss, and total retriever loss", () => {
  assert.equal(computeRecallDegradeLevel({
    lexical_status: { name: "lexical", available: true },
    vector_status: { name: "vector", available: true, backend: "qdrant", primary_backend: "qdrant" },
    vector_candidates: [],
    degrade_reasons: []
  }), 0);

  assert.equal(computeRecallDegradeLevel({
    lexical_status: { name: "lexical", available: true },
    vector_status: { name: "vector", available: true, backend: "qdrant", primary_backend: "qdrant" },
    vector_candidates: [{ ...candidate("fallback", 0.8, "vector"), source_retrievers: ["vector", "pgvector-fallback"] }],
    degrade_reasons: []
  }), 1);

  assert.equal(computeRecallDegradeLevel({
    lexical_status: { name: "lexical", available: true },
    vector_status: { name: "vector", available: false, reason: "vector_backend_unavailable" },
    vector_candidates: [],
    degrade_reasons: ["vector_backend_unavailable"]
  }), 2);

  assert.equal(computeRecallDegradeLevel({
    lexical_status: { name: "lexical", available: false, reason: "lexical_backend_unavailable" },
    vector_status: { name: "vector", available: false, reason: "vector_backend_unavailable" },
    vector_candidates: [],
    degrade_reasons: ["lexical_backend_unavailable", "vector_backend_unavailable"]
  }), 3);
});

test("recall feedback repository records trace feedback and promotes repeated false-null repair", async () => {
  const db = new InMemoryWriteDatabase(() => "2026-05-19T00:00:00.000Z");
  const repository = new RecallFeedbackRepository();
  await withWriteTransaction(db, async (tx) => {
    await repository.addTrace(tx, {
      id: "trace-1",
      queryHash: "query-hash",
      queryExcerpt: "Jenkins failed",
      actorId: "agent-a",
      scopeContext: { project_ids: ["p-1"] },
      queryType: QueryType.ProjectContext,
      strategy: RetrievalStrategy.Hybrid,
      degradeLevel: 0,
      results: { memory_ids: ["mem-1"] },
      audit: { fusion: "rrf" }
    });
    const event = await repository.addFeedback(tx, {
      recallTraceId: "trace-1",
      memoryId: "mem-1",
      actorId: "agent-a",
      feedbackType: "used_in_context"
    });
    assert.equal(event.feedbackType, "used_in_context");
    let repairCount = 0;
    for (let i = 0; i < 5; i += 1) {
      const repair = await repository.upsertRepairQueue(tx, {
        queryHash: "query-hash",
        recallTraceId: "trace-1",
        issueType: "false_null",
        details: { attempt: i }
      });
      repairCount = repair.count;
    }
    assert.equal(repairCount, 5);
  });

  const snapshot = await db.snapshot();
  assert.equal(snapshot.recallTraces.length, 1);
  assert.equal(snapshot.recallFeedbackEvents.length, 1);
  assert.equal(snapshot.recallRepairQueue[0]?.count, 5);
  assert.equal(snapshot.recallRepairQueue[0]?.rootCauseType, "embedding_gap");
  assert.equal(snapshot.recallRepairQueue[0]?.details.query_hash, "query-hash");
  assert.deepEqual(snapshot.recallRepairQueue[0]?.details.scope, {});
  assert.deepEqual(snapshot.recallRepairQueue[0]?.details.suggested_values, {
    candidate_repair: "refresh_embedding_or_lexical_weight"
  });
  assert.equal(
    snapshot.recallRepairQueue[0]?.details.suggested_action,
    "reproject_then_consider_lexical_weight"
  );
});

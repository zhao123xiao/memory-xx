import assert from "node:assert/strict";
import test from "node:test";

import { rerankCandidatesWithOptionalModel } from "../app/recall/model-reranker";
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

function candidate(memoryId: string, score: number): RetrieverCandidate {
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
    lexical_score: score,
    matched_terms: [],
    why_matched: ["test"],
    source_retrievers: ["lexical"]
  };
}

function constraints(): QueryConstraints {
  return {
    normalized_query: "test query",
    query_terms: ["test", "query"],
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

test("model reranker calibrates local scores instead of replacing them", async () => {
  const outcome = await rerankCandidatesWithOptionalModel(
    [
      candidate("strong-local", 1),
      candidate("weak-local", 0.5),
      candidate("third", 0.49),
      candidate("fourth", 0.48)
    ],
    constraints(),
    {
      env: {
        MEMORY_V2_RERANKER_MODE: "model",
        MEMORY_V2_RERANKER_ENDPOINT: "http://reranker.test",
        MEMORY_V2_RERANKER_MODEL_WEIGHT: "0.03",
        MEMORY_V2_RERANKER_LOCAL_TOP3_GAP_THRESHOLD: "1"
      },
      fetchImpl: async () => new Response(JSON.stringify({
        results: [
          { memory_id: "strong-local", score: 0.01 },
          { memory_id: "weak-local", score: 1 }
        ]
      }))
    }
  );

  assert.equal(outcome.backend, "model");
  assert.equal(outcome.model_used, true);
  assert.equal(outcome.candidates[0]?.memory_id, "strong-local");
  assert.equal(outcome.candidates[1]?.memory_id, "weak-local");
});

test("model reranker timeout cap falls back to local ordering", async () => {
  const started = Date.now();
  const outcome = await rerankCandidatesWithOptionalModel(
    [
      candidate("first", 2),
      candidate("second", 1.95),
      candidate("third", 1.9),
      candidate("fourth", 1.85)
    ],
    constraints(),
    {
      env: {
        MEMORY_V2_RERANKER_MODE: "model",
        MEMORY_V2_RERANKER_ENDPOINT: "http://reranker.test",
        MEMORY_V2_RERANKER_TIMEOUT_MS: "30000",
        MEMORY_V2_RERANKER_TIMEOUT_CAP_MS: "5",
        MEMORY_V2_RERANKER_LOCAL_TOP3_GAP_THRESHOLD: "1"
      },
      fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      })
    }
  );

  assert.equal(outcome.backend, "local");
  assert.equal(outcome.reason, "model_timeout");
  assert.equal(outcome.candidates[0]?.memory_id, "first");
  assert.equal(Date.now() - started < 1000, true);
});

test("model reranker does not apply default timeout cap when cap is unset", async () => {
  let aborted = false;
  const outcome = await rerankCandidatesWithOptionalModel(
    [
      candidate("first", 2),
      candidate("second", 1.95),
      candidate("third", 1.9),
      candidate("fourth", 1.85)
    ],
    constraints(),
    {
      env: {
        MEMORY_V2_RERANKER_MODE: "model",
        MEMORY_V2_RERANKER_ENDPOINT: "http://reranker.test",
        MEMORY_V2_RERANKER_TIMEOUT_MS: "3000",
        MEMORY_V2_RERANKER_LOCAL_TOP3_GAP_THRESHOLD: "1"
      },
      fetchImpl: async (_url, init) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return new Response(JSON.stringify({
          results: [
            { memory_id: "first", score: 0.9 },
            { memory_id: "second", score: 0.8 }
          ]
        }));
      }
    }
  );

  assert.equal(outcome.backend, "model");
  assert.equal(aborted, false);
});

test("model reranker sends structured document fields for adapter compatibility", async () => {
  let requestBody: any;
  const outcome = await rerankCandidatesWithOptionalModel(
    [
      candidate("doc-1", 1),
      candidate("doc-2", 0.99),
      candidate("doc-3", 0.98),
      candidate("doc-4", 0.97)
    ],
    constraints(),
    {
      env: {
        MEMORY_V2_RERANKER_MODE: "model",
        MEMORY_V2_RERANKER_ENDPOINT: "http://reranker.test",
        MEMORY_V2_RERANKER_MODEL_WEIGHT: "0.25",
        MEMORY_V2_RERANKER_LOCAL_TOP3_GAP_THRESHOLD: "1"
      },
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          results: [
            { memory_id: "doc-1", score: 0.9 },
            { memory_id: "doc-2", score: 0.1 }
          ]
        }));
      }
    }
  );

  assert.equal(outcome.backend, "model");
  assert.equal(requestBody.documents[0].memory_id, "doc-1");
  assert.equal(requestBody.documents[0].title, "doc-1");
  assert.match(requestBody.documents[0].content, /content for doc-1/);
  assert.match(requestBody.documents[0].text, /content for doc-1/);
});

test("model reranker intentionally skips tiny candidate sets", async () => {
  const outcome = await rerankCandidatesWithOptionalModel(
    [candidate("first", 1), candidate("second", 0.99), candidate("third", 0.98)],
    constraints(),
    {
      env: {
        MEMORY_V2_RERANKER_MODE: "model",
        MEMORY_V2_RERANKER_ENDPOINT: "http://reranker.test",
      },
      fetchImpl: async () => {
        throw new Error("should not call model reranker");
      }
    }
  );

  assert.equal(outcome.backend, "local");
  assert.equal(outcome.model_attempted, false);
  assert.equal(outcome.reason, "not_enough_candidates");
});

test("force_top1 policy attempts model rerank for two candidates", async () => {
  let calls = 0;
  const outcome = await rerankCandidatesWithOptionalModel(
    [candidate("first", 1), candidate("second", 0.99)],
    constraints(),
    {
      env: {
        MEMORY_V2_RERANKER_MODE: "model",
        MEMORY_V2_RERANKER_ENDPOINT: "http://reranker.force-top1.test",
        MEMORY_V2_RERANKER_POLICY: "force_top1",
      },
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          results: [
            { memory_id: "second", score: 1 },
            { memory_id: "first", score: 0.1 }
          ]
        }));
      }
    }
  );

  assert.equal(calls, 1);
  assert.equal(outcome.backend, "model");
  assert.equal(outcome.model_used, true);
});

test("model reranker caches score maps for repeated candidate signatures", async () => {
  let calls = 0;
  const env = {
    MEMORY_V2_RERANKER_MODE: "model",
    MEMORY_V2_RERANKER_ENDPOINT: "http://reranker.cache.test",
    MEMORY_V2_RERANKER_LOCAL_TOP3_GAP_THRESHOLD: "1",
    MEMORY_V2_RERANKER_CACHE_TTL_MS: "60000",
  };
  const input = [
    candidate("first", 1),
    candidate("second", 0.99),
    candidate("third", 0.98),
    candidate("fourth", 0.97)
  ];
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      results: [
        { memory_id: "first", score: 0.8 },
        { memory_id: "second", score: 0.7 }
      ]
    }));
  };

  const first = await rerankCandidatesWithOptionalModel(input, constraints(), { env, fetchImpl });
  const second = await rerankCandidatesWithOptionalModel(input, constraints(), { env, fetchImpl });

  assert.equal(first.backend, "model");
  assert.equal(second.reason, "model_cache_hit");
  assert.equal(calls, 1);
});

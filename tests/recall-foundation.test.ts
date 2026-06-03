import assert from "node:assert/strict";
import test from "node:test";

import {
  FilterMode,
  LifecycleStatus,
  ReviewState,
  ScopeType,
  isEffectiveRecallable
} from "../app/shared";
import { createRecallRouteHandler } from "../app/api";
import {
  buildMetadataConstraints,
  buildRecallFilterPlan,
  classifyQuery,
  QueryType,
  RecallError,
  RecallErrorCode,
  RecallOrchestrator,
  resolveAllowedScopeSet,
  StubLexicalRetriever,
  StubVectorRetriever,
  type QueryEmbeddingAudit,
  type RecallRecord,
  type RecallScopeRef
} from "../app/recall";

function createRecord(overrides: Partial<RecallRecord>): RecallRecord {
  return {
    memory_id: overrides.memory_id ?? "mem-1",
    content: overrides.content ?? "Alice prefers markdown notes for project alpha.",
    scope_type: overrides.scope_type ?? ScopeType.Project,
    scope_id: overrides.scope_id ?? "p-alpha",
    lifecycleStatus:
      overrides.lifecycleStatus ?? LifecycleStatus.Approved,
    isCurrent: overrides.isCurrent ?? true,
    reviewState: overrides.reviewState ?? ReviewState.Approved,
    title: overrides.title ?? "Alpha preference",
    project_id: overrides.project_id ?? "p-alpha",
    source: overrides.source ?? {
      path: "memory/2026-04-12.md",
      source_type: "md"
    },
    tags: overrides.tags ?? ["urgent"],
    entity_names: overrides.entity_names ?? ["Alice Smith"],
    created_at: overrides.created_at ?? "2026-04-12T00:00:00.000Z",
    lexical_terms: overrides.lexical_terms ?? ["alice", "preference", "markdown"],
    semantic_terms: overrides.semantic_terms ?? ["alpha", "notes", "markdown"]
  };
}

test("query classifier covers main routing classes and hint override", () => {
  assert.equal(
    classifyQuery({ query: "What is request_id exact format?" }).query_type,
    QueryType.ExactLookup
  );
  assert.equal(
    classifyQuery({ query: "用户偏好是什么？" }).query_type,
    QueryType.PreferenceLookup
  );
  assert.equal(
    classifyQuery({ query: "这个项目现在到哪个阶段了？" }).query_type,
    QueryType.ProjectContext
  );
  assert.equal(
    classifyQuery({ query: "source:md 审计这个 path 的出处" }).query_type,
    QueryType.SourceAudit
  );
  assert.equal(
    classifyQuery({
      query: "debug recall degrade reason",
      query_type_hint: QueryType.TimelineHistory
    }).query_type,
    QueryType.TimelineHistory
  );
});

test("scope resolver gates access, adds runtime scopes, and degrades when runtime adapter fails", async () => {
  const longTermOnly = await resolveAllowedScopeSet({
    query: "project alpha",
    scope_context: {
      project_ids: ["p-alpha"],
      workspace_id: "ws-main"
    }
  });
  assert.deepEqual(longTermOnly.allowed_scope_set, [
    { type: ScopeType.Project, id: "p-alpha" },
    { type: ScopeType.Workspace, id: "ws-main" }
  ]);

  const mixed = await resolveAllowedScopeSet(
    {
      query: "project alpha",
      scope_context: {
        project_ids: ["p-alpha"],
        runtime: {
          run_id: "run-1",
          task_id: "task-7"
        }
      }
    },
    {
      runtime_scope_adapter: {
        async get_runtime_scopes(): Promise<RecallScopeRef[]> {
          return [
            { type: ScopeType.Run, id: "run-1" },
            { type: ScopeType.Task, id: "task-7" }
          ];
        }
      }
    }
  );
  assert.equal(mixed.allowed_scope_set.length, 3);
  assert.equal(mixed.degraded, false);

  const degraded = await resolveAllowedScopeSet(
    {
      query: "project alpha",
      scope_context: {
        project_ids: ["p-alpha"],
        runtime: {
          run_id: "run-1"
        }
      }
    },
    {
      runtime_scope_adapter: {
        async get_runtime_scopes(): Promise<RecallScopeRef[]> {
          throw new Error("redis down");
        }
      }
    }
  );
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.degrade_reasons.includes("runtime_scope_unavailable"), true);
  assert.deepEqual(degraded.allowed_scope_set, [
    { type: ScopeType.Project, id: "p-alpha" }
  ]);

  await assert.rejects(
    () =>
      resolveAllowedScopeSet(
        {
          query: "secret",
          scope_context: {
            project_ids: ["p-secret"]
          }
        },
        {
          access_policy: {
            get_forbidden_scopes(): RecallScopeRef[] {
              return [{ type: ScopeType.Project, id: "p-secret" }];
            }
          }
        }
      ),
    (error: unknown) =>
      error instanceof RecallError &&
      error.code === RecallErrorCode.ScopeForbidden
  );
});

test("scope resolver adds canonical memory-ledger workspace for MEMORY.md header lookups only", async () => {
  const headerLookup = await resolveAllowedScopeSet({
    query: "System Decisions",
    scope_context: {
      user_id: "current-instance-owner",
      workspace_id: "current-instance",
      project_ids: ["memory-system"],
      include_global: true
    }
  });

  assert.deepEqual(headerLookup.allowed_scope_set, [
    { type: ScopeType.User, id: "current-instance-owner" },
    { type: ScopeType.Project, id: "memory-system" },
    { type: ScopeType.Workspace, id: "current-instance" },
    { type: ScopeType.Workspace, id: "memory-ledger" },
    { type: ScopeType.Global, id: "global" }
  ]);

  const nonHeaderLookup = await resolveAllowedScopeSet({
    query: "Collaboration",
    scope_context: {
      workspace_id: "current-instance"
    }
  });

  assert.deepEqual(nonHeaderLookup.allowed_scope_set, [
    { type: ScopeType.Workspace, id: "current-instance" }
  ]);

  const alreadyCanonical = await resolveAllowedScopeSet({
    query: "Persona",
    scope_context: {
      workspace_id: "memory-ledger"
    }
  });

  assert.deepEqual(alreadyCanonical.allowed_scope_set, [
    { type: ScopeType.Workspace, id: "memory-ledger" }
  ]);
});

test("default filter plan stays exactly equal to effective_recallable truth table", () => {
  const plan = buildRecallFilterPlan({
    requested_mode: FilterMode.Default
  });

  const cases: RecallRecord[] = [
    createRecord({
      memory_id: "approved-visible"
    }),
    createRecord({
      memory_id: "approved-not-required",
      reviewState: ReviewState.NotRequired
    }),
    createRecord({
      memory_id: "candidate-hidden",
      lifecycleStatus: LifecycleStatus.Candidate,
      reviewState: ReviewState.Pending
    }),
    createRecord({
      memory_id: "archived-hidden",
      lifecycleStatus: LifecycleStatus.Archived
    }),
    createRecord({
      memory_id: "superseded-hidden",
      lifecycleStatus: LifecycleStatus.Superseded,
      isCurrent: false
    }),
    createRecord({
      memory_id: "review-pending-hidden",
      reviewState: ReviewState.Pending
    })
  ];

  for (const record of cases) {
    assert.equal(
      plan.evaluate(record),
      isEffectiveRecallable({
        lifecycleStatus: record.lifecycleStatus,
        isCurrent: record.isCurrent,
        reviewState: record.reviewState
      }),
      record.memory_id
    );
  }

  assert.equal(plan.predicate_id, "effective_recallable");
});

test("metadata filter builder extracts project, source, entity, tag, and year constraints", () => {
  const constraints = buildMetadataConstraints({
    query: 'project:p-alpha source:md #urgent "Alice Smith" 2026 roadmap',
    classification: classifyQuery({ query: "project:p-alpha roadmap" })
  });

  assert.deepEqual(constraints.project_ids, ["p-alpha"]);
  assert.deepEqual(constraints.source_types, ["md"]);
  assert.deepEqual(constraints.tags, ["urgent"]);
  assert.deepEqual(constraints.entity_names, ["Alice Smith"]);
  assert.deepEqual(constraints.years, [2026]);
});

test("metadata filter builder does not misclassify canonical MEMORY.md headers as entity names", () => {
  for (const query of ["System Decisions", "Project Index", "Persona"]) {
    const constraints = buildMetadataConstraints({
      query,
      classification: classifyQuery({ query })
    });

    assert.deepEqual(constraints.entity_names, [], query);
  }
});

test("orchestrator returns degraded and degrade_reason when hybrid query loses vector path", async () => {
  const record = createRecord({
    memory_id: "mem-alpha",
    content: "Project alpha context and markdown notes for Alice.",
    lexical_terms: ["project", "alpha", "notes"],
    semantic_terms: ["project", "alpha", "context", "notes"]
  });
  const orchestrator = new RecallOrchestrator({
    lexical_retriever: new StubLexicalRetriever({
      records: [record]
    }),
    vector_retriever: new StubVectorRetriever({
      records: [record],
      simulate_failure: "unavailable"
    })
  });

  const response = await orchestrator.execute({
    query: "project alpha context",
    scope_context: {
      project_ids: ["p-alpha"]
    },
    explain: true,
    debug: {
      include_strategy_plan: true
    }
  });

  assert.equal(response.filter_mode_applied, FilterMode.Default);
  assert.equal(response.degraded, true);
  assert.match(response.degrade_reason ?? "", /vector_backend_unavailable/);
  assert.match(response.audit_ref, /^audit:/);
  assert.equal(response.audit.audit_ref, response.audit_ref);
  assert.equal(response.audit.lexical_hits, 1);
  assert.equal(response.audit.vector_hits, 0);
  assert.equal(response.audit.returned_hits, 1);
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].memory_id, "mem-alpha");
  assert.equal(response.explain?.retrieval.rerank_applied, true);
  assert.equal(response.explain?.retrieval.merged_hits, 1);
  assert.equal(response.explain?.retrieval.returned_hits, 1);
});

test("explain and audit payloads expose the minimum observable fields for local integration evidence", async () => {
  const record = createRecord({
    memory_id: "mem-observable",
    title: "Alpha audit note",
    content: "Alpha rollout decision with governance-safe recall output.",
    lexical_terms: ["alpha", "audit", "decision"],
    semantic_terms: ["alpha", "rollout", "decision"]
  });
  const orchestrator = new RecallOrchestrator({
    lexical_retriever: new StubLexicalRetriever({
      records: [record]
    }),
    vector_retriever: new StubVectorRetriever({
      records: [record]
    })
  });

  const response = await orchestrator.execute({
    query: "Alpha audit note",
    scope_context: {
      project_ids: ["p-alpha"]
    },
    explain: true,
    debug: {
      include_strategy_plan: true
    }
  });

  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].memory_id, "mem-observable");
  assert.deepEqual(response.allowed_scope_set, [
    { type: ScopeType.Project, id: "p-alpha" }
  ]);
  assert.equal(response.audit.audit_ref, response.audit_ref);
  assert.equal(typeof response.audit.query_type, "string");
  assert.equal(typeof response.audit.strategy, "string");
  assert.equal(typeof response.audit.lexical_status.available, "boolean");
  assert.equal(typeof response.audit.vector_status.available, "boolean");
  assert.equal(typeof response.audit.lexical_hits, "number");
  assert.equal(typeof response.audit.vector_hits, "number");
  assert.equal(typeof response.audit.merged_hits, "number");
  assert.equal(typeof response.audit.returned_hits, "number");
  assert.equal(response.explain?.classification.query_type, response.audit.query_type);
  assert.equal(response.explain?.filter.applied_mode, response.filter_mode_applied);
  assert.equal(response.explain?.filter.predicate_id, "effective_recallable");
  assert.equal(typeof response.explain?.filter.sql_where_clause, "string");
  assert.equal(typeof response.explain?.strategy?.strategy_explain.length, "number");
  assert.equal(typeof response.explain?.retrieval.lexical_hits, "number");
  assert.equal(typeof response.explain?.retrieval.vector_hits, "number");
  assert.equal(typeof response.explain?.retrieval.merged_hits, "number");
  assert.equal(typeof response.explain?.retrieval.returned_hits, "number");
});

test("orchestrator exposes query embedding audit only on debug explain path", async () => {
  const record = createRecord({
    memory_id: "mem-embed-debug",
    semantic_terms: ["alpha", "context", "embedding"]
  });

  class DebugVectorRetriever extends StubVectorRetriever {
    get_last_query_embedding_audit(): QueryEmbeddingAudit {
      return {
        fresh_cache_hit: false,
        stale_cache_hit: false,
        attempt_count: 2,
        final_error: "socket hang up",
        error_code: "ECONNRESET"
      };
    }
  }

  const orchestrator = new RecallOrchestrator({
    lexical_retriever: new StubLexicalRetriever({ records: [record] }),
    vector_retriever: new DebugVectorRetriever({ records: [record], minimum_score: 0 })
  });

  const explained = await orchestrator.execute({
    query: "project alpha context",
    scope_context: {
      project_ids: ["p-alpha"]
    },
    explain: true,
    debug: {
      enabled: true,
      include_strategy_plan: true
    }
  });
  assert.deepEqual(explained.explain?.embedding, {
    fresh_cache_hit: false,
    stale_cache_hit: false,
    attempt_count: 2,
    final_error: "socket hang up",
    error_code: "ECONNRESET"
  });

  const nonExplained = await orchestrator.execute({
    query: "project alpha context",
    scope_context: {
      project_ids: ["p-alpha"]
    }
  });
  assert.equal(nonExplained.explain, undefined);
  assert.equal("embedding" in nonExplained.audit, false);
});

test("explicit memory_ids seed approved records without lexical term match", async () => {
  const record = createRecord({
    memory_id: "mem-explicit-1",
    title: "P4 report format",
    content: "Conclusion first, evidence second.",
    lexical_terms: [],
    semantic_terms: []
  });

  const orchestrator = new RecallOrchestrator({
    lexical_retriever: new StubLexicalRetriever({ records: [record] }),
    vector_retriever: new StubVectorRetriever({ records: [] })
  });

  const response = await orchestrator.execute({
    query: "unrelated query that does not match content",
    scope_context: {
      project_ids: ["p-alpha"],
      memory_ids: ["mem-explicit-1"]
    }
  });

  assert.deepEqual(response.results.map((item) => item.memory_id), ["mem-explicit-1"]);
  assert.deepEqual(response.results[0]?.source_retrievers, ["lexical"]);
});

test("route handler validates request DTO and returns structured errors", async () => {
  const orchestrator = new RecallOrchestrator({
    lexical_retriever: new StubLexicalRetriever(),
    vector_retriever: new StubVectorRetriever()
  });
  const handler = createRecallRouteHandler(orchestrator);

  const missingQuery = await handler.handle({
    body: {
      scope_context: {
        project_ids: ["p-alpha"]
      }
    }
  });
  assert.equal(missingQuery.status, 400);
  assert.equal("error" in missingQuery.body, true);
  if ("error" in missingQuery.body) {
    assert.equal(missingQuery.body.error.code, RecallErrorCode.QueryEmpty);
  }

  const invalidFilter = await handler.handle({
    body: {
      query: "alpha",
      scope_context: {
        project_ids: ["p-alpha"]
      },
      filter_mode: "bogus"
    }
  });
  assert.equal(invalidFilter.status, 400);
  if ("error" in invalidFilter.body) {
    assert.equal(
      invalidFilter.body.error.code,
      RecallErrorCode.InvalidFilterMode
    );
  }
});

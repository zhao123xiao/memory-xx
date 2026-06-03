import assert from "node:assert/strict";
import test from "node:test";

import {
  FilterMode,
  LifecycleStatus,
  ReviewState,
  ScopeType
} from "../app/shared";
import {
  QueryType,
  buildRetrievalQueryPolicy,
  classifyQuery,
  rerankCandidates,
  tokenizeRecallQuery,
  type QueryConstraints,
  type QueryClassification,
  type RecallRecord,
  type RetrieverCandidate
} from "../app/recall";
import { PostgresLexicalRetriever } from "../app/recall/retrievers/lexical-retriever";

function createRecord(overrides: Partial<RecallRecord>): RecallRecord {
  return {
    memory_id: overrides.memory_id ?? "mem-1",
    content: overrides.content ?? "memory-system status and rollback notes",
    scope_type: overrides.scope_type ?? ScopeType.Project,
    scope_id: overrides.scope_id ?? "p-alpha",
    lifecycleStatus:
      overrides.lifecycleStatus ?? LifecycleStatus.Approved,
    isCurrent: overrides.isCurrent ?? true,
    reviewState: overrides.reviewState ?? ReviewState.Approved,
    title: overrides.title ?? "Default title",
    project_id: overrides.project_id ?? "p-alpha",
    source: overrides.source ?? {
      path: "memory/2026-04-12.md",
      source_type: "md"
    },
    section: overrides.section,
    canonical_section: overrides.canonical_section,
    canonical_source_path: overrides.canonical_source_path,
    category: overrides.category,
    memory_type: overrides.memory_type,
    tags: overrides.tags ?? [],
    entity_names: overrides.entity_names ?? [],
    created_at: overrides.created_at ?? "2026-04-12T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-12T00:00:00.000Z",
    lexical_terms: overrides.lexical_terms ?? [],
    semantic_terms: overrides.semantic_terms ?? []
  };
}

function createCandidate(overrides: {
  memory_id: string;
  record: RecallRecord;
  score?: number;
  lexical_score?: number;
  vector_score?: number;
  matched_terms?: string[];
  why_matched?: string[];
  source_retrievers?: string[];
}): RetrieverCandidate {
  return {
    memory_id: overrides.memory_id,
    record: overrides.record,
    score: overrides.score ?? overrides.lexical_score ?? 0,
    lexical_score: overrides.lexical_score,
    vector_score: overrides.vector_score,
    matched_terms: overrides.matched_terms ?? [],
    why_matched: overrides.why_matched ?? ["stub_match"],
    source_retrievers: overrides.source_retrievers ?? ["lexical"]
  };
}

function createConstraints(input: {
  query: string;
  query_type?: QueryType;
  rerank_enabled?: boolean;
  query_terms?: string[];
}): QueryConstraints {
  const classified = classifyQuery({ query: input.query });
  const classification: QueryClassification = {
    ...classified,
    query_type: input.query_type ?? classified.query_type,
    rerank_enabled: input.rerank_enabled ?? true
  };

  return {
    normalized_query: input.query.trim().toLowerCase(),
    query_terms: input.query_terms ?? tokenizeRecallQuery(input.query),
    allowed_scope_set: [{ type: ScopeType.Project, id: "p-alpha" }],
    filter_plan: {
      requested_mode: FilterMode.Default,
      applied_mode: FilterMode.Default,
      predicate_id: "stub",
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
    classification,
    limit: 10,
    offset: 0
  };
}

test("retrieval policy disables generic ilike for document and Chinese natural-language queries", () => {
  const documentPolicy = buildRetrievalQueryPolicy(
    createConstraints({ query: "facts.md" })
  );
  const chinesePolicy = buildRetrievalQueryPolicy(
    createConstraints({ query: "我的安全边界是什么" })
  );
  const termPolicy = buildRetrievalQueryPolicy(
    createConstraints({ query: "embedding-provider" })
  );

  assert.equal(documentPolicy.mode, "document_lookup");
  assert.equal(documentPolicy.allow_ilike_fallback, false);
  assert.equal(documentPolicy.exact_source_basename_query, "facts.md");
  assert.equal(documentPolicy.exact_source_basename_queries.includes("facts.md"), true);

  assert.equal(chinesePolicy.mode, "natural_language");
  assert.equal(chinesePolicy.allow_ilike_fallback, false);

  assert.equal(termPolicy.allow_ilike_fallback, true);
  assert.equal(termPolicy.ilike_patterns.includes("%embedding-provider%"), true);
  assert.equal(termPolicy.ilike_patterns.includes("%md%"), false);
});

test("retrieval policy promotes alias-driven document direct channel targets", () => {
  const factsPolicy = buildRetrievalQueryPolicy(
    createConstraints({ query: "当前 OpenClaw 的运行环境" })
  );
  const lessonsPolicy = buildRetrievalQueryPolicy(
    createConstraints({ query: "lessons 里记录了什么教训" })
  );
  const constraintsPolicy = buildRetrievalQueryPolicy(
    createConstraints({ query: "constraints.md" })
  );
  const collaborationPolicy = buildRetrievalQueryPolicy(
    createConstraints({ query: "Collaboration" })
  );
  const personaPolicy = buildRetrievalQueryPolicy(
    createConstraints({ query: "Persona" })
  );
  const projectDocPolicy = buildRetrievalQueryPolicy(
    createConstraints({
      query:
        "memory-framework-9.5-execution 已完成 docs/memory-conflict-and-sensitive-rules-v1.md"
    })
  );

  assert.equal(factsPolicy.mode, "document_lookup");
  assert.equal(
    factsPolicy.exact_source_path_queries.includes("memory/facts.md"),
    true
  );
  assert.equal(
    factsPolicy.reasons.includes("document_lookup_alias:runtime-environment"),
    true
  );

  assert.equal(lessonsPolicy.mode, "document_lookup");
  assert.equal(
    lessonsPolicy.exact_source_path_queries.includes("memory/lessons.md"),
    true
  );
  assert.equal(
    lessonsPolicy.reasons.includes("document_lookup_alias:lessons"),
    true
  );

  assert.equal(constraintsPolicy.mode, "document_lookup");
  assert.equal(
    constraintsPolicy.exact_source_path_queries.includes("memory/constraints.md"),
    true
  );
  assert.equal(
    constraintsPolicy.exact_section_queries.includes("core constraints"),
    true
  );
  assert.equal(
    constraintsPolicy.reasons.includes("document_lookup_alias:constraints"),
    true
  );

  assert.equal(collaborationPolicy.mode, "document_lookup");
  assert.equal(
    collaborationPolicy.exact_section_queries.includes("collaboration"),
    true
  );
  assert.equal(
    collaborationPolicy.exact_source_path_queries.includes("memory.md"),
    true
  );
  assert.equal(
    collaborationPolicy.reasons.includes("document_lookup_alias:collaboration"),
    true
  );

  assert.equal(personaPolicy.mode, "document_lookup");
  assert.equal(personaPolicy.exact_section_queries.includes("persona"), true);
  assert.equal(personaPolicy.exact_source_path_queries.includes("memory.md"), true);
  assert.equal(
    personaPolicy.reasons.includes("document_lookup_alias:persona"),
    true
  );

  assert.equal(projectDocPolicy.mode, "document_lookup");
  assert.equal(
    projectDocPolicy.exact_title_queries.includes(
      "项目：memory framework 9 5 execution"
    ),
    true
  );
  assert.equal(
    projectDocPolicy.exact_title_queries.includes(
      "memory framework 9 5 execution 已完成 docs memory conflict and sensitive rules v1 md"
    ),
    true
  );
  assert.equal(
    projectDocPolicy.exact_source_path_queries.includes(
      "docs/memory-conflict-and-sensitive-rules-v1.md"
    ),
    true
  );
  assert.equal(
    projectDocPolicy.exact_source_basename_queries.includes(
      "memory-conflict-and-sensitive-rules-v1.md"
    ),
    true
  );
  assert.equal(
    projectDocPolicy.reasons.includes(
      "document_lookup_alias:memory-framework-9.5-execution"
    ),
    true
  );
});

test("postgres lexical retriever aligns exact-title normalization with alias direct-channel queries", async () => {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  const client = {
    query: async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
    release: () => {}
  };
  const pool = {
    connect: async () => client,
    end: async () => {}
  };

  const retriever = new PostgresLexicalRetriever({
    config: {
      databaseUrl: "postgres://unused",
      schema: "shadow_test",
      applicationName: "memory-xx-test",
      maxConnections: 1,
      idleTimeoutMs: 1_000,
      connectionTimeoutMs: 1_000,
      ssl: false
    },
    pool: pool as never
  });

  await retriever.retrieve(
    createConstraints({
      query:
        "memory-framework-9.5-execution 已完成 docs/memory-conflict-and-sensitive-rules-v1.md"
    })
  );

  const selectCall = calls.find((call) => call.sql.includes("WITH candidate_records AS"));
  assert.ok(selectCall, "expected lexical SELECT query to be issued");
  assert.equal(
    selectCall?.sql.includes(
      "regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(COALESCE(mr.title, ''))"
    ),
    true
  );
  assert.equal(
    selectCall?.sql.includes("mr.metadata ->> 'section_path'"),
    true
  );

  const params = selectCall?.params ?? [];
  const titleQueries = params.find(
    (value) =>
      Array.isArray(value) &&
      value.includes("项目：memory framework 9 5 execution")
  );
  const sourcePathQueries = params.find(
    (value) =>
      Array.isArray(value) &&
      value.includes("docs/memory-conflict-and-sensitive-rules-v1.md")
  );

  assert.ok(titleQueries, "expected normalized alias title query to be passed into SQL");
  assert.ok(sourcePathQueries, "expected embedded docs path to be passed into SQL");
});

test("reranker adds exact title and source-path bonuses for decisions.md lookups", () => {
  const constraints = createConstraints({ query: "decisions.md" });
  const canonicalDecision = createCandidate({
    memory_id: "decision-doc",
    record: createRecord({
      memory_id: "decision-doc",
      title: "decisions.md",
      content: "Canonical decision ledger entry.",
      source: {
        path: "memory/decisions.md",
        source_type: "md"
      },
      section: "decisions.md",
      canonical_section: "decisions.md",
      canonical_source_path: "memory/decisions.md"
    }),
    lexical_score: 0.18,
    matched_terms: ["decisions", "md"]
  });
  const nearbySibling = createCandidate({
    memory_id: "system-decision",
    record: createRecord({
      memory_id: "system-decision",
      title: "System Decisions",
      content: "Top-level decision index.",
      source: {
        path: "MEMORY.md",
        source_type: "md"
      },
      section: "System Decisions",
      canonical_section: "System Decisions",
      canonical_source_path: "MEMORY.md"
    }),
    lexical_score: 0.3,
    matched_terms: ["decisions"]
  });

  const reranked = rerankCandidates([nearbySibling, canonicalDecision], constraints);

  assert.equal(reranked[0]?.memory_id, "decision-doc");
  assert.equal(
    reranked[0]?.why_matched.includes("exact_title_match_bonus"),
    true
  );
  assert.equal(
    reranked[0]?.why_matched.includes("source_path_match_bonus"),
    true
  );
});

test("reranker adds section-header bonus for Project Index queries", () => {
  const constraints = createConstraints({ query: "Project Index" });
  const sectionMatched = createCandidate({
    memory_id: "project-index-section",
    record: createRecord({
      memory_id: "project-index-section",
      title: "Memory framework baseline status",
      content: "This row belongs to the top-level project index section.",
      source: {
        path: "MEMORY.md",
        source_type: "md"
      },
      section: "Project Index",
      canonical_section: "Project Index",
      canonical_source_path: "MEMORY.md"
    }),
    lexical_score: 0.12,
    matched_terms: ["project"]
  });
  const plainProjectHit = createCandidate({
    memory_id: "plain-project-hit",
    record: createRecord({
      memory_id: "plain-project-hit",
      title: "Project milestone note",
      content: "General project note without index semantics.",
      source: {
        path: "memory/2026-04-12.md",
        source_type: "md"
      }
    }),
    lexical_score: 0.22,
    matched_terms: ["project"]
  });

  const reranked = rerankCandidates([plainProjectHit, sectionMatched], constraints);

  assert.equal(reranked[0]?.memory_id, "project-index-section");
  assert.equal(
    reranked[0]?.why_matched.includes("section_header_match_bonus"),
    true
  );
});

test("reranker treats full canonical source paths as direct document hits", () => {
  const constraints = createConstraints({ query: "memory/preferences.md" });
  const canonicalPreferences = createCandidate({
    memory_id: "preferences-doc",
    record: createRecord({
      memory_id: "preferences-doc",
      title: "preferences.md",
      content: "Canonical preferences ledger entry.",
      source: {
        path: "memory:preferences-doc",
        source_type: "md"
      },
      section: "preferences.md",
      canonical_section: "preferences.md",
      canonical_source_path: "memory/preferences.md"
    }),
    lexical_score: 0.12,
    matched_terms: ["preferences"]
  });
  const nearbySibling = createCandidate({
    memory_id: "plain-preference-hit",
    record: createRecord({
      memory_id: "plain-preference-hit",
      title: "preference note",
      content: "General preference mention without canonical doc routing.",
      source: {
        path: "memory/2026-04-12.md",
        source_type: "md"
      }
    }),
    lexical_score: 0.22,
    matched_terms: ["preferences"]
  });

  const reranked = rerankCandidates([nearbySibling, canonicalPreferences], constraints);

  assert.equal(reranked[0]?.memory_id, "preferences-doc");
  assert.equal(
    reranked[0]?.why_matched.includes("source_path_match_bonus"),
    true
  );
});

test("reranker promotes canonical constraints doc on source-path-only document alias matches", () => {
  const constraints = createConstraints({ query: "constraints.md" });
  const constraintsDoc = createCandidate({
    memory_id: "constraints-doc",
    record: createRecord({
      memory_id: "constraints-doc",
      title: "Constraint ledger row",
      content: "Canonical constraints ledger entry.",
      source: {
        path: "memory:constraints-doc",
        source_type: "md"
      },
      canonical_source_path: "memory/constraints.md"
    }),
    lexical_score: 0.11,
    matched_terms: ["constraints"]
  });
  const plainHit = createCandidate({
    memory_id: "plain-constraints-hit",
    record: createRecord({
      memory_id: "plain-constraints-hit",
      title: "Constraint mention",
      content: "General constraint mention without canonical doc routing.",
      source: {
        path: "memory/2026-04-12.md",
        source_type: "md"
      }
    }),
    lexical_score: 0.22,
    matched_terms: ["constraints"]
  });

  const reranked = rerankCandidates([plainHit, constraintsDoc], constraints);

  assert.equal(reranked[0]?.memory_id, "constraints-doc");
  assert.equal(
    reranked[0]?.why_matched.includes("query_alias_bonus:constraints"),
    true
  );
  assert.equal(
    reranked[0]?.why_matched.includes("source_path_match_bonus"),
    true
  );
});

test("reranker adds section-header bonus for Collaboration queries", () => {
  const constraints = createConstraints({ query: "Collaboration" });
  const collaborationSection = createCandidate({
    memory_id: "collaboration-section",
    record: createRecord({
      memory_id: "collaboration-section",
      title: "Team working rules",
      content: "This row belongs to the collaboration section.",
      source: {
        path: "MEMORY.md",
        source_type: "md"
      },
      section: "Collaboration",
      canonical_section: "Collaboration",
      canonical_source_path: "MEMORY.md"
    }),
    lexical_score: 0.12,
    matched_terms: ["collaboration"]
  });
  const plainHit = createCandidate({
    memory_id: "plain-collab-hit",
    record: createRecord({
      memory_id: "plain-collab-hit",
      title: "Collaboration sync note",
      content: "General collaboration mention without header semantics.",
      source: {
        path: "memory/2026-04-12.md",
        source_type: "md"
      }
    }),
    lexical_score: 0.22,
    matched_terms: ["collaboration"]
  });

  const reranked = rerankCandidates([plainHit, collaborationSection], constraints);

  assert.equal(reranked[0]?.memory_id, "collaboration-section");
  assert.equal(
    reranked[0]?.why_matched.includes("section_header_match_bonus"),
    true
  );
  assert.equal(
    reranked[0]?.why_matched.includes("query_alias_bonus:collaboration"),
    true
  );
});

test("reranker promotes MEMORY header aliases even when canonical row only exposes source path", () => {
  const constraints = createConstraints({ query: "Persona" });
  const personaDoc = createCandidate({
    memory_id: "persona-doc",
    record: createRecord({
      memory_id: "persona-doc",
      title: "Operator profile row",
      content: "Canonical persona summary row.",
      source: {
        path: "memory:persona-doc",
        source_type: "md"
      },
      canonical_source_path: "MEMORY.md"
    }),
    lexical_score: 0.1,
    matched_terms: ["persona"]
  });
  const plainHit = createCandidate({
    memory_id: "plain-persona-hit",
    record: createRecord({
      memory_id: "plain-persona-hit",
      title: "Persona note",
      content: "General persona mention without header routing.",
      source: {
        path: "memory/2026-04-12.md",
        source_type: "md"
      }
    }),
    lexical_score: 0.22,
    matched_terms: ["persona"]
  });

  const reranked = rerankCandidates([plainHit, personaDoc], constraints);

  assert.equal(reranked[0]?.memory_id, "persona-doc");
  assert.equal(
    reranked[0]?.why_matched.includes("query_alias_bonus:persona"),
    true
  );
});

test("reranker applies rollback alias bonus from config-driven alias registry", () => {
  const constraints = createConstraints({ query: "rollback 策略是什么" });
  const rollbackCandidate = createCandidate({
    memory_id: "rollback-plan",
    record: createRecord({
      memory_id: "rollback-plan",
      title: "Legacy rollback window",
      content: "Rollback window remains open for the legacy deployment path.",
      source: {
        path: "memory/decisions.md",
        source_type: "md"
      },
      section: "decisions.md",
      canonical_section: "decisions.md",
      canonical_source_path: "memory/decisions.md"
    }),
    lexical_score: 0.16,
    matched_terms: ["rollback", "legacy"]
  });
  const unrelated = createCandidate({
    memory_id: "unrelated",
    record: createRecord({
      memory_id: "unrelated",
      title: "Release checklist",
      content: "Checklist without rollback guidance.",
      source: {
        path: "memory/todos.md",
        source_type: "md"
      }
    }),
    lexical_score: 0.2,
    matched_terms: []
  });

  const reranked = rerankCandidates([unrelated, rollbackCandidate], constraints);

  assert.equal(reranked[0]?.memory_id, "rollback-plan");
  assert.equal(
    reranked[0]?.why_matched.includes("query_alias_bonus:rollback"),
    true
  );
});

test("canonical project rows outrank fresher daily-log siblings for project-cluster lookups", () => {
  const constraints = createConstraints({
    query: "memory-system",
    query_type: QueryType.ProjectContext
  });
  const canonicalProjectRow = createCandidate({
    memory_id: "project-memory-system",
    record: createRecord({
      memory_id: "project-memory-system",
      title: "项目：memory-system",
      content: "Canonical project status row for memory-system.",
      source: {
        path: "memory/projects.md",
        source_type: "md"
      },
      section: "项目：memory-system",
      canonical_section: "项目：memory-system",
      canonical_source_path: "memory/projects.md",
      memory_type: "project-status",
      updated_at: "2026-04-10T00:00:00.000Z"
    }),
    lexical_score: 0.32,
    matched_terms: ["memory-system"]
  });
  const fresherDailyLog = createCandidate({
    memory_id: "memory-system-log",
    record: createRecord({
      memory_id: "memory-system-log",
      title: "完成 memory-system 回归检查",
      content: "Daily log fragment mentioning memory-system progress.",
      source: {
        path: "memory/2026-04-12.md",
        source_type: "md"
      },
      updated_at: "2026-04-13T00:00:00.000Z"
    }),
    lexical_score: 0.38,
    matched_terms: ["memory-system"]
  });

  const reranked = rerankCandidates([fresherDailyLog, canonicalProjectRow], constraints);

  assert.equal(reranked[0]?.memory_id, "project-memory-system");
  assert.equal(reranked[0]?.cluster_key, "alias:memory-system");
  assert.equal(
    reranked[0]?.why_matched.includes("query_alias_bonus:memory-system"),
    true
  );
  assert.equal(
    reranked[0]?.why_matched.includes("cluster_winner_selected"),
    true
  );
  assert.equal(
    reranked[0]?.why_matched.includes("canonical_cluster_bonus"),
    true
  );
  assert.equal(
    reranked[0]?.why_matched.includes("status_row_bonus"),
    true
  );
});

test("cluster-aware arbitration prefers canonical project status row for multi-agent-mode", () => {
  const constraints = createConstraints({
    query: "multi-agent-mode",
    query_type: QueryType.ProjectContext
  });
  const projectStatus = createCandidate({
    memory_id: "project-multi-agent-mode-status",
    record: createRecord({
      memory_id: "project-multi-agent-mode-status",
      title: "项目：multi-agent-mode",
      content: "Canonical status row for multi-agent-mode.",
      source: {
        path: "memory/projects.md",
        source_type: "md"
      },
      section: "项目：multi-agent-mode",
      canonical_section: "项目：multi-agent-mode",
      canonical_source_path: "memory/projects.md",
      memory_type: "project-status",
      updated_at: "2026-04-10T00:00:00.000Z"
    }),
    lexical_score: 0.3,
    matched_terms: ["multi-agent-mode"]
  });
  const unrelatedProjectRow = createCandidate({
    memory_id: "project-memory-system-status",
    record: createRecord({
      memory_id: "project-memory-system-status",
      title: "项目：memory-system",
      content: "Canonical status row for memory-system.",
      source: {
        path: "memory/projects.md",
        source_type: "md"
      },
      section: "项目：memory-system",
      canonical_section: "项目：memory-system",
      canonical_source_path: "memory/projects.md",
      memory_type: "project-status",
      updated_at: "2026-04-10T00:00:00.000Z"
    }),
    lexical_score: 0.34,
    matched_terms: []
  });
  const dailyLog = createCandidate({
    memory_id: "multi-agent-mode-log",
    record: createRecord({
      memory_id: "multi-agent-mode-log",
      title: "整理 multi-agent-mode 参考资料",
      content: "Daily log fragment mentioning multi-agent-mode.",
      source: {
        path: "memory/2026-04-12.md",
        source_type: "md"
      },
      updated_at: "2026-04-13T00:00:00.000Z"
    }),
    lexical_score: 0.37,
    matched_terms: ["multi-agent-mode"]
  });

  const reranked = rerankCandidates(
    [unrelatedProjectRow, dailyLog, projectStatus],
    constraints
  );

  assert.equal(reranked[0]?.memory_id, "project-multi-agent-mode-status");
  assert.equal(reranked[0]?.cluster_key, "alias:multi-agent-mode");
  assert.equal(
    reranked[0]?.why_matched.includes("status_row_bonus"),
    true
  );
  assert.equal(
    reranked.find((candidate) => candidate.memory_id === "project-memory-system-status")
      ?.why_matched.includes("query_alias_bonus:multi-agent-mode"),
    false
  );
});

test("cluster-aware arbitration prefers canonical execution status row for memory-framework-9.5-execution", () => {
  const constraints = createConstraints({
    query: "memory-framework-9.5-execution",
    query_type: QueryType.ProjectContext
  });
  const projectStatus = createCandidate({
    memory_id: "project-memory-framework-status",
    record: createRecord({
      memory_id: "project-memory-framework-status",
      title: "项目：memory-framework-9.5-execution",
      content: "Canonical execution status row.",
      source: {
        path: "memory/projects.md",
        source_type: "md"
      },
      section: "项目：memory-framework-9.5-execution",
      canonical_section: "项目：memory-framework-9.5-execution",
      canonical_source_path: "memory/projects.md",
      memory_type: "project-status",
      updated_at: "2026-04-10T00:00:00.000Z"
    }),
    lexical_score: 0.29,
    matched_terms: ["memory-framework-9.5-execution"]
  });
  const dailyLog = createCandidate({
    memory_id: "memory-framework-log",
    record: createRecord({
      memory_id: "memory-framework-log",
      title: "补跑 memory-framework-9.5-execution 验证",
      content: "Daily fragment for memory-framework-9.5-execution.",
      source: {
        path: "memory/2026-04-12.md",
        source_type: "md"
      },
      updated_at: "2026-04-13T00:00:00.000Z"
    }),
    lexical_score: 0.35,
    matched_terms: ["memory-framework-9.5-execution"]
  });

  const reranked = rerankCandidates([dailyLog, projectStatus], constraints);

  assert.equal(reranked[0]?.memory_id, "project-memory-framework-status");
  assert.equal(
    reranked[0]?.why_matched.includes("canonical_cluster_bonus"),
    true
  );
  assert.equal(reranked[0]?.cluster_key, "alias:memory-framework-9.5-execution");
});

test("reranker adds exact memory-id bonus for canonical id lookups", () => {
  const constraints = createConstraints({
    query: "memory-framework-9.5-execution",
    query_type: QueryType.ExactLookup,
    query_terms: ["memory-framework-9.5-execution"]
  });
  const exactIdCandidate = createCandidate({
    memory_id: "memory-framework-9.5-execution",
    record: createRecord({
      memory_id: "memory-framework-9.5-execution",
      title: "项目：memory-framework-9.5-execution",
      content: "Canonical project row that should win exact-id lookup.",
      source: {
        path: "memory/projects.md",
        source_type: "md"
      },
      canonical_source_path: "memory/projects.md",
      memory_type: "project-status"
    }),
    lexical_score: 0.2,
    matched_terms: ["memory-framework-9.5-execution"]
  });
  const nearbySibling = createCandidate({
    memory_id: "memory-framework-followup",
    record: createRecord({
      memory_id: "memory-framework-followup",
      title: "项目：memory-framework-9.5-execution",
      content: "Checklist sibling in the same cluster.",
      source: {
        path: "memory/2026-04-12.md",
        source_type: "md"
      },
      canonical_source_path: "memory/projects.md"
    }),
    lexical_score: 0.31,
    matched_terms: ["memory-framework-9.5-execution"]
  });

  const reranked = rerankCandidates([nearbySibling, exactIdCandidate], constraints);

  assert.equal(reranked[0]?.memory_id, "memory-framework-9.5-execution");
  assert.equal(
    reranked[0]?.why_matched.includes("exact_memory_id_match_bonus"),
    true
  );
});

test("same-title siblings keep canonical row on top after cluster arbitration", () => {
  const constraints = createConstraints({
    query: "后续优化（不阻塞记忆框架基线 100%）",
    query_type: QueryType.ExactLookup
  });
  const canonicalSibling = createCandidate({
    memory_id: "canonical-sibling",
    record: createRecord({
      memory_id: "canonical-sibling",
      title: "后续优化（不阻塞记忆框架基线 100%）",
      content: "Canonical summary row.",
      source: {
        path: "memory/todos.md",
        source_type: "md"
      },
      canonical_source_path: "memory/projects.md",
      memory_type: "stable-summary",
      updated_at: "2026-04-10T00:00:00.000Z"
    }),
    lexical_score: 0.25,
    matched_terms: ["后续优化", "基线"]
  });
  const fresherSibling = createCandidate({
    memory_id: "fresh-sibling",
    record: createRecord({
      memory_id: "fresh-sibling",
      title: "后续优化（不阻塞记忆框架基线 100%）",
      content: "Newer sibling fragment that should not win by recency alone.",
      source: {
        path: "memory/2026-04-12.md",
        source_type: "md"
      },
      updated_at: "2026-04-13T00:00:00.000Z"
    }),
    lexical_score: 0.31,
    matched_terms: ["后续优化", "基线"]
  });

  const reranked = rerankCandidates([fresherSibling, canonicalSibling], constraints);

  assert.equal(reranked[0]?.memory_id, "canonical-sibling");
  assert.equal(
    reranked[0]?.why_matched.includes("cluster_winner_selected"),
    true
  );
  assert.equal(
    reranked[1]?.why_matched.includes("same_cluster_exact_id_candidate"),
    true
  );
  assert.equal(reranked[0]?.cluster_key, "title:后续优化 不阻塞记忆框架基线 100%");
});

test("same-cluster content cue can elevate a matching memory-system sibling under canonical winner", () => {
  const constraints = createConstraints({
    query: "memory-system 下一步 持续优化",
    query_type: QueryType.ProjectContext,
    query_terms: ["memory-system", "下一步", "持续优化"]
  });
  const canonicalStatus = createCandidate({
    memory_id: "project-memory-system-status",
    record: createRecord({
      memory_id: "project-memory-system-status",
      title: "项目：memory-system",
      content: "项目 `memory-system` 当前阶段：稳定可用 + 持续优化。",
      source: {
        path: "memory/projects.md",
        source_type: "md"
      },
      canonical_source_path: "memory/projects.md",
      memory_type: "project-status"
    }),
    lexical_score: 0.34,
    matched_terms: ["memory-system"]
  });
  const nextStepSibling = createCandidate({
    memory_id: "project-memory-system-next-step",
    record: createRecord({
      memory_id: "project-memory-system-next-step",
      title: "项目：memory-system",
      content: "下一步（持续优化，不再计入框架基线完成度）：继续扩展 recall 验证。",
      source: {
        path: "memory/projects.md",
        source_type: "md"
      },
      canonical_source_path: "memory/projects.md",
      memory_type: "project"
    }),
    lexical_score: 0.3,
    matched_terms: ["memory-system", "下一步", "持续优化"]
  });
  const unrelatedSibling = createCandidate({
    memory_id: "project-memory-system-history",
    record: createRecord({
      memory_id: "project-memory-system-history",
      title: "项目：memory-system",
      content: "2026-03-18 已完成一轮运行态复查。",
      source: {
        path: "memory/projects.md",
        source_type: "md"
      },
      canonical_source_path: "memory/projects.md",
      memory_type: "project"
    }),
    lexical_score: 0.31,
    matched_terms: ["memory-system"]
  });

  const reranked = rerankCandidates(
    [canonicalStatus, unrelatedSibling, nextStepSibling],
    constraints
  );

  assert.equal(reranked[0]?.memory_id, "project-memory-system-status");
  assert.equal(reranked[1]?.memory_id, "project-memory-system-next-step");
  assert.equal(
    reranked[1]?.why_matched.includes("same_cluster_exact_id_candidate"),
    true
  );
  assert.equal(
    reranked[1]?.why_matched.includes("same_cluster_content_cue_bonus"),
    true
  );
});

test("stable plan row wins over stale checklist row in same cluster", () => {
  const constraints = createConstraints({
    query: "memory-system",
    query_type: QueryType.ProjectContext,
    query_terms: ["memory-system"]
  });
  const staleChecklistRow = createCandidate({
    memory_id: "stale-checklist-01",
    record: createRecord({
      memory_id: "stale-checklist-01",
      title: "项目：memory-system",
      content: "继续扩展 mem0 错误上账，补更细的错误分类、event_context 与 query/probe context 关联",
      source: {
        path: "memory/todos.md",
        source_type: "md"
      },
      canonical_source_path: "memory/projects.md",
      memory_type: "todo"
    }),
    lexical_score: 0.35,
    matched_terms: ["memory-system"]
  });
  const stablePlanRow = createCandidate({
    memory_id: "stable-plan-01",
    record: createRecord({
      memory_id: "stable-plan-01",
      title: "项目：memory-system",
      content: "已产出 `docs/memory-framework-definition-freeze-v1.md` 作为单一冻结页",
      source: {
        path: "memory/projects.md",
        source_type: "md"
      },
      canonical_source_path: "memory/projects.md",
      memory_type: "project"
    }),
    lexical_score: 0.32,
    matched_terms: ["memory-system"]
  });

  const reranked = rerankCandidates([staleChecklistRow, stablePlanRow], constraints);

  assert.equal(reranked[0]?.memory_id, "stable-plan-01");
});

test("stable conclusion row wins over newer stale checklist even with higher lexical score", () => {
  const constraints = createConstraints({
    query: "memory-framework-9.5-execution",
    query_type: QueryType.ProjectContext,
    query_terms: ["memory-framework-9.5-execution"]
  });
  const newerChecklist = createCandidate({
    memory_id: "checklist-newer",
    record: createRecord({
      memory_id: "checklist-newer",
      title: "项目：memory-framework-9.5-execution",
      content: "推进 T87~T94：评分维度、样本分类集与自动评分脚本继续收口",
      source: {
        path: "memory/projects.md",
        source_type: "md"
      },
      canonical_source_path: "memory/projects.md",
      memory_type: "project",
      updated_at: "2026-04-11T14:27:41.247285Z"
    }),
    lexical_score: 0.36,
    matched_terms: ["memory-framework-9.5-execution"]
  });
  const olderConclusion = createCandidate({
    memory_id: "conclusion-older",
    record: createRecord({
      memory_id: "conclusion-older",
      title: "项目：memory-framework-9.5-execution",
      content: "已完成 `docs/memory-conflict-and-sensitive-rules-v1.md`",
      source: {
        path: "memory/projects.md",
        source_type: "md"
      },
      canonical_source_path: "memory/projects.md",
      memory_type: "project",
      updated_at: "2026-04-11T09:54:50.111179Z"
    }),
    lexical_score: 0.33,
    matched_terms: ["memory-framework-9.5-execution"]
  });

  const reranked = rerankCandidates([newerChecklist, olderConclusion], constraints);

  assert.equal(reranked[0]?.memory_id, "conclusion-older");
});

test("cluster sibling packing keeps stable memory-framework conclusion ahead of stale checklist under canonical winner", () => {
  const constraints = createConstraints({
    query: "memory-framework-9.5-execution",
    query_type: QueryType.ProjectContext,
    query_terms: ["memory-framework-9.5-execution"]
  });
  const canonicalStatus = createCandidate({
    memory_id: "framework-status",
    record: createRecord({
      memory_id: "framework-status",
      title: "项目：memory-framework-9.5-execution",
      content: "项目 `memory-framework-9.5-execution` 当前阶段：M2｜联邦编排稳定 + P0 source integrity 已收口。",
      source: {
        path: "memory/projects.md",
        source_type: "md"
      },
      canonical_source_path: "memory/projects.md",
      memory_type: "project-status",
      updated_at: "2026-04-11T15:00:00.000Z"
    }),
    lexical_score: 0.38,
    matched_terms: ["memory-framework-9.5-execution"]
  });
  const staleChecklist = createCandidate({
    memory_id: "framework-stale-checklist",
    record: createRecord({
      memory_id: "framework-stale-checklist",
      title: "项目：memory-framework-9.5-execution",
      content: "推进 T87~T94：评分维度、样本分类集与自动评分脚本继续收口",
      source: {
        path: "memory/projects.md",
        source_type: "md"
      },
      canonical_source_path: "memory/projects.md",
      memory_type: "project",
      updated_at: "2026-04-11T14:27:41.247285Z"
    }),
    lexical_score: 0.36,
    matched_terms: ["memory-framework-9.5-execution"]
  });
  const stableConclusion = createCandidate({
    memory_id: "framework-stable-conclusion",
    record: createRecord({
      memory_id: "framework-stable-conclusion",
      title: "项目：memory-framework-9.5-execution",
      content: "已完成 `docs/memory-conflict-and-sensitive-rules-v1.md`，当前结论已稳定可复用。",
      source: {
        path: "memory/projects.md",
        source_type: "md"
      },
      canonical_source_path: "memory/projects.md",
      memory_type: "project",
      updated_at: "2026-04-11T09:54:50.111179Z"
    }),
    lexical_score: 0.33,
    matched_terms: ["memory-framework-9.5-execution"]
  });

  const reranked = rerankCandidates(
    [canonicalStatus, staleChecklist, stableConclusion],
    constraints
  );

  assert.equal(reranked[0]?.memory_id, "framework-status");
  assert.equal(reranked[1]?.memory_id, "framework-stable-conclusion");
  assert.equal(reranked[2]?.memory_id, "framework-stale-checklist");
  assert.equal(
    reranked[1]?.why_matched.includes("same_cluster_exact_id_candidate"),
    true
  );
});

// ─── Regression: same-cluster exact-id 定向增强 ─────────────────────────────────

test(
  "exact-alias boost: query containing memory-framework-9.5-execution " +
    "should pick the row whose memory_id exactly matches the alias token",
  () => {
    const constraints = createConstraints({
      query: "项目 memory-framework-9.5-execution 当前阶段 当前状态",
      query_type: QueryType.ProjectContext,
      query_terms: [
        "项目",
        "memory-framework-9.5-execution",
        "当前阶段",
        "当前状态"
      ]
    });
    // The canonical project-status row — this is the TARGET winner.
    const frameworkStatus = createCandidate({
      memory_id: "memory-framework-9.5-execution",
      record: createRecord({
        memory_id: "memory-framework-9.5-execution",
        title: "项目：memory-framework-9.5-execution",
        content:
          "项目 `memory-framework-9.5-execution` 当前阶段：M2｜联邦编排稳定 + " +
          "P0 source integrity 已收口，当前状态：推进验证收尾。",
        source: { path: "memory/projects.md", source_type: "md" },
        canonical_source_path: "memory/projects.md",
        memory_type: "project-status",
        updated_at: "2026-04-11T15:00:00.000Z"
      }),
      lexical_score: 0.35,
      matched_terms: ["memory-framework-9.5-execution", "当前阶段", "当前状态"]
    });
    // A sibling in the SAME alias cluster with a different memory_id.
    // Both candidates share title "项目：memory-framework-9.5-execution" so they
    // are in the same alias:memory-framework-9.5-execution cluster.  The
    // exactAliasMatchBoost (2.8) fires for frameworkStatus (memory_id matches
    // the query alias token) but NOT for siblingCandidate, pushing the correct
    // winner to the top even though siblingCandidate has a higher base score.
    const siblingCandidate = createCandidate({
      memory_id: "project_new_memory_architecture",
      record: createRecord({
        memory_id: "project_new_memory_architecture",
        title: "项目：memory-framework-9.5-execution",
        content:
          "项目 `memory-framework-9.5-execution` 当前阶段：规划中，" +
          "拟引入新的 memory 架构设计，当前状态：需求分析中。",
        source: { path: "memory/projects.md", source_type: "md" },
        canonical_source_path: "memory/projects.md",
        memory_type: "project",
        updated_at: "2026-04-12T10:00:00.000Z"
      }),
      // Intentionally higher base score to simulate the bug scenario.
      lexical_score: 0.44,
      matched_terms: ["memory-framework-9.5-execution", "当前阶段", "当前状态"]
    });

    const reranked = rerankCandidates(
      [siblingCandidate, frameworkStatus],
      constraints
    );

    // The exact-alias match on memory_id must override the higher base score.
    assert.equal(reranked[0]?.memory_id, "memory-framework-9.5-execution");
    assert.equal(
      reranked[0]?.why_matched.some((r) => r.includes("cluster_winner_selected")),
      true
    );
  }
);

test(
  "exact-alias boost: query 'memory-framework-9.5-execution 已完成 docs/...' " +
    "should surface the specific conclusion sibling within the framework cluster",
  () => {
    const constraints = createConstraints({
      query:
        "memory-framework-9.5-execution 已完成 docs/memory-conflict-and-sensitive-rules-v1.md",
      query_type: QueryType.ProjectContext,
      query_terms: [
        "memory-framework-9.5-execution",
        "已完成",
        "docs",
        "memory-conflict",
        "sensitive-rules",
        "v1"
      ]
    });
    // The canonical status row — should be the cluster winner.
    const frameworkStatus = createCandidate({
      memory_id: "memory-framework-9.5-execution",
      record: createRecord({
        memory_id: "memory-framework-9.5-execution",
        title: "项目：memory-framework-9.5-execution",
        content:
          "项目 `memory-framework-9.5-execution` 当前阶段：M2｜联邦编排稳定 + " +
          "P0 source integrity 已收口。",
        source: { path: "memory/projects.md", source_type: "md" },
        canonical_source_path: "memory/projects.md",
        memory_type: "project-status"
      }),
      lexical_score: 0.34,
      matched_terms: ["memory-framework-9.5-execution"]
    });
    // The specific conclusion sibling that matches the query's "已完成" + doc path.
    const conclusionSibling = createCandidate({
      memory_id: "framework-conclusion-doc",
      record: createRecord({
        memory_id: "framework-conclusion-doc",
        title: "项目：memory-framework-9.5-execution",
        content:
          "已完成 `docs/memory-conflict-and-sensitive-rules-v1.md`，" +
          "当前结论已稳定可复用。",
        source: { path: "memory/projects.md", source_type: "md" },
        canonical_source_path: "memory/projects.md",
        memory_type: "project"
      }),
      lexical_score: 0.28,
      matched_terms: [
        "memory-framework-9.5-execution",
        "已完成",
        "memory-conflict",
        "sensitive-rules"
      ]
    });
    // A stale checklist sibling that should NOT win.
    const staleChecklist = createCandidate({
      memory_id: "framework-stale-checklist",
      record: createRecord({
        memory_id: "framework-stale-checklist",
        title: "项目：memory-framework-9.5-execution",
        content: "推进 T87~T94：评分维度、样本分类集与自动评分脚本继续收口",
        source: { path: "memory/projects.md", source_type: "md" },
        canonical_source_path: "memory/projects.md",
        memory_type: "project"
      }),
      lexical_score: 0.36,
      matched_terms: ["memory-framework-9.5-execution"]
    });

    const reranked = rerankCandidates(
      [staleChecklist, frameworkStatus, conclusionSibling],
      constraints
    );

    // The canonical status row should be top (exactAliasMatch on memory_id + is_canonical_status_row).
    assert.equal(reranked[0]?.memory_id, "memory-framework-9.5-execution");
    // The conclusion sibling with the specific doc content should be ranked ahead
    // of the stale checklist, thanks to the extraCueCount bonus for "已完成" + doc terms.
    const conclusionRank = reranked.findIndex(
      (c) => c.memory_id === "framework-conclusion-doc"
    );
    const staleRank = reranked.findIndex(
      (c) => c.memory_id === "framework-stale-checklist"
    );
    assert.ok(
      conclusionRank < staleRank,
      `conclusion sibling (rank ${conclusionRank}) should rank ahead of stale checklist (rank ${staleRank})`
    );
  }
);

test(
  "exact-alias boost: query '记忆系统 当前状态 项目' should pick " +
    "the canonical memory-system status row, not a machine-maintenance entry",
  () => {
    const constraints = createConstraints({
      query: "记忆系统 当前状态 项目",
      query_type: QueryType.ProjectContext,
      query_terms: ["记忆系统", "当前状态", "项目"]
    });
    // The canonical project-status row for memory-system — this MUST win.
    const canonicalStatus = createCandidate({
      memory_id: "memory-system",
      record: createRecord({
        memory_id: "memory-system",
        title: "项目：memory-system",
        content:
          "项目 `memory-system` 当前阶段：稳定可用 + 持续优化，" +
          "当前状态：运行态复查已完成。",
        source: { path: "memory/projects.md", source_type: "md" },
        canonical_source_path: "memory/projects.md",
        memory_type: "project-status",
        updated_at: "2026-04-10T00:00:00.000Z"
      }),
      lexical_score: 0.31,
      matched_terms: ["记忆系统", "当前状态"]
    });
    // A machine-maintenance entry that merely mentions "memory-system" in its content.
    // This entry should NOT win the cluster even if it has a higher base score.
    const machineMaintenance = createCandidate({
      memory_id: "machine-maintenance-memory-system",
      record: createRecord({
        memory_id: "machine-maintenance-memory-system",
        title: "机器维护：memory-system 自动沉淀",
        content:
          "memory-system 自动沉淀检查：机器维护例行巡检。",
        source: { path: "memory/2026-04-12.md", source_type: "md" },
        memory_type: "note"
      }),
      // Higher base score to simulate the bug scenario.
      lexical_score: 0.42,
      matched_terms: ["memory-system", "自动沉淀"]
    });

    const reranked = rerankCandidates(
      [machineMaintenance, canonicalStatus],
      constraints
    );

    // The exact-alias match (memory_id = "memory-system" token in query) must
    // override the higher base score of the machine-maintenance entry.
    assert.equal(reranked[0]?.memory_id, "memory-system");
    assert.equal(
      reranked[0]?.why_matched.some((r) => r.includes("cluster_winner_selected")),
      true
    );
  }
);

test("intent evidence boost ranks cutover M4/M5 phase evidence above generic cutover mentions", () => {
  const constraints = createConstraints({
    query: "cutover 的阶段划分",
    query_type: QueryType.ProjectContext,
    query_terms: ["cutover", "阶段", "划分"]
  });
  const genericGatewayCutover = createCandidate({
    memory_id: "gateway-cutover",
    record: createRecord({
      memory_id: "gateway-cutover",
      title: "OpenClaw 已完成受控 gateway cutover",
      content: "完成一次受控 gateway cutover，Gateway reachable，Feishu ok。",
      memory_type: "project"
    }),
    score: 0.65,
    lexical_score: 0.65,
    vector_score: 0.65,
    matched_terms: ["cutover"]
  });
  const phasePlan = createCandidate({
    memory_id: "cutover-m4-m5",
    record: createRecord({
      memory_id: "cutover-m4-m5",
      title: "I7 Cutover 蓝图完成并进入 I8",
      content:
        "M4~M5 的切换蓝图已经收口为可执行主线：M4 只允许灰度切读，旧写仍为唯一写裁决方；" +
        "M5 只有在 Gate 与回滚演练通过后，才允许把新写切为唯一裁决方，并立即冻结旧写。",
      memory_type: "event-summary"
    }),
    score: 0.58,
    lexical_score: 0.58,
    vector_score: 0.58,
    matched_terms: ["cutover", "阶段"]
  });

  const reranked = rerankCandidates([genericGatewayCutover, phasePlan], constraints);

  assert.equal(reranked[0]?.memory_id, "cutover-m4-m5");
  assert.equal(
    reranked[0]?.why_matched.some((reason) => reason.startsWith("intent_evidence_bonus")),
    true
  );
});

test("intent evidence boost ranks review approve reject lifecycle procedure evidence", () => {
  const constraints = createConstraints({
    query: "review approve reject 相关流程",
    query_type: QueryType.ProcedureQuery,
    query_terms: ["review", "approve", "reject", "流程"]
  });
  const genericApprovalNote = createCandidate({
    memory_id: "generic-approval",
    record: createRecord({
      memory_id: "generic-approval",
      title: "审批提醒",
      content: "当前审批事件投递到 Web UI 可能存在延迟，审批类命令默认一次只发一条。",
      memory_type: "constraint"
    }),
    score: 0.62,
    lexical_score: 0.62,
    matched_terms: ["审批"]
  });
  const lifecycleProcedure = createCandidate({
    memory_id: "phase-c2-review-lifecycle",
    record: createRecord({
      memory_id: "phase-c2-review-lifecycle",
      title: "Phase C2 Review / Lifecycle 已合入主线并验证通过",
      content:
        "memory-xx 已补齐 approve / reject / archive / supersede / tombstone 命令、Review API 路由、" +
        "治理 lifecycle service，以及 memory_events / outbox_events 同事务写入。",
      memory_type: "event-summary"
    }),
    score: 0.55,
    lexical_score: 0.55,
    matched_terms: ["review", "approve", "reject"]
  });

  const reranked = rerankCandidates([genericApprovalNote, lifecycleProcedure], constraints);

  assert.equal(reranked[0]?.memory_id, "phase-c2-review-lifecycle");
  assert.equal(
    reranked[0]?.why_matched.some((reason) => reason.startsWith("intent_evidence_bonus")),
    true
  );
});

test("intent evidence boost ranks primary ledger evidence over generic memory-system status", () => {
  const constraints = createConstraints({
    query: "当前记忆系统的主账是什么",
    query_type: QueryType.CurrentStateQuery,
    query_terms: ["当前", "记忆系统", "主账"]
  });
  const genericProjectStatus = createCandidate({
    memory_id: "memory-system-status",
    record: createRecord({
      memory_id: "memory-system-status",
      title: "项目：memory-system",
      content: "记忆系统当前阶段：持续优化，最近完成定时巩固与自愈检查。",
      source: { path: "memory/projects.md", source_type: "md" },
      canonical_source_path: "memory/projects.md",
      memory_type: "project-status"
    }),
    score: 0.7,
    lexical_score: 0.7,
    matched_terms: ["记忆系统", "当前"]
  });
  const primaryLedger = createCandidate({
    memory_id: "primary-ledger",
    record: createRecord({
      memory_id: "primary-ledger",
      title: "decisions.md",
      content: "Markdown 文件主账是长期记忆唯一主账。",
      source: { path: "memory/decisions.md", source_type: "md" },
      canonical_source_path: "memory/decisions.md",
      memory_type: "decision"
    }),
    score: 0.55,
    lexical_score: 0.55,
    matched_terms: ["主账"]
  });

  const reranked = rerankCandidates([genericProjectStatus, primaryLedger], constraints);

  assert.equal(reranked[0]?.memory_id, "primary-ledger");
  assert.equal(
    reranked[0]?.why_matched.some((reason) => reason.startsWith("intent_evidence_bonus")),
    true
  );
});

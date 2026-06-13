import assert from "node:assert/strict";
import test from "node:test";

import {
  auditRecallContextPagingContract,
  buildRecallContextBundle,
  buildRecallContextBundleCacheContract,
  inferCognitiveType,
  QueryType,
  RecallOrchestrator,
  renderRecallContextPrompt,
  StubLexicalRetriever,
  StubVectorRetriever,
  type RecallResultItem,
} from "../app/recall";
import { FilterMode, LifecycleStatus, ReviewState, ScopeType } from "../app/shared";

function item(input: {
  id: string;
  title?: string;
  content: string;
  score?: number;
  scopeType?: ScopeType;
  memoryType?: string;
  memoryLayer?: string;
  recallPolicy?: string;
  sourceRetrievers?: string[];
  graphRelations?: string[];
  graphRelationEvidence?: RecallResultItem["graph_relation_evidence"];
  graphPathEvidence?: RecallResultItem["graph_path_evidence"];
}): RecallResultItem {
  return {
    memory_id: input.id,
    title: input.title ?? input.id,
    content: input.content,
    scope: { type: input.scopeType ?? ScopeType.Project, id: "memory-xx" },
    score: input.score ?? 0.8,
    source_retrievers: input.sourceRetrievers ?? ["lexical"],
    matched_terms: [],
    memory_type: input.memoryType,
    memory_layer: input.memoryLayer,
    recall_policy: input.recallPolicy ?? "default",
    graph_relations: input.graphRelations,
    graph_relation_evidence: input.graphRelationEvidence,
    graph_path_evidence: input.graphPathEvidence,
    cognitive_type: inferCognitiveType({
      memory_type: input.memoryType,
      memory_layer: input.memoryLayer,
      recall_policy: input.recallPolicy ?? "default",
    }),
  };
}

test("cognitive type inference separates durable facts, episodes, procedures, and audit-only evidence", () => {
  assert.equal(inferCognitiveType({ memory_layer: "semantic", memory_type: "decision" }), "semantic");
  assert.equal(inferCognitiveType({ memory_layer: "episodic", memory_type: "progress" }), "episodic");
  assert.equal(inferCognitiveType({ memory_type: "procedure" }), "procedural");
  assert.equal(inferCognitiveType({ memory_type: "ops_learning" }), "procedural");
  assert.equal(inferCognitiveType({ memory_class: "operational_issue", recall_policy: "explicit_only" }), "episodic");
  assert.equal(inferCognitiveType({ recall_policy: "audit_only", memory_type: "fact" }), "audit");
  assert.equal(inferCognitiveType({ recall_policy: "never", memory_layer: "semantic" }), "audit");
});

test("context bundle assigns L0-L3 layers with budgets and excludes non-default recall from resident layers", () => {
  const bundle = buildRecallContextBundle({
    queryType: QueryType.ProjectContext,
    results: [
      item({
        id: "user-language",
        content: "用户要求默认使用中文回复。",
        scopeType: ScopeType.User,
        memoryType: "preference",
        memoryLayer: "core",
        score: 0.99,
      }),
      item({
        id: "runtime-profile",
        content: "memory-xx 当前运行 profile 为 full，Qdrant active alias 正常。",
        memoryType: "constraint",
        memoryLayer: "semantic",
        score: 0.95,
      }),
      item({
        id: "tsx-runbook",
        content: "WSL 下运行 tsx 需要设置 TMPDIR=/tmp，避免 Windows 临时目录 socket 不兼容。",
        memoryType: "procedure",
        memoryLayer: "procedural",
        score: 0.92,
      }),
      item({
        id: "release-snapshot",
        content: "某次 GitHub CI job 仍在运行，这是阶段性进度。",
        memoryType: "status",
        memoryLayer: "episodic",
        score: 0.7,
      }),
      item({
        id: "audit-only",
        content: "外部开源发布审计材料，不应进入默认 prompt。",
        memoryType: "fact",
        memoryLayer: "audit",
        recallPolicy: "never",
        score: 0.9,
      }),
    ],
    tokenBudget: {
      l0AlwaysResident: 80,
      l1PinnedScopeFacts: 140,
      l2QueryWorkingSet: 180,
      l3ExpandableDeepMemory: 200,
    },
  });

  assert.equal(bundle.version, "context-bundle-v1");
  assert.equal(bundle.layers.l0_always_resident.items.map((entry) => entry.memory_id).join(","), "user-language");
  assert.deepEqual(bundle.layers.l1_pinned_scope_facts.items.map((entry) => entry.memory_id), [
    "runtime-profile",
  ]);
  assert.deepEqual(bundle.layers.l2_query_working_set.items.map((entry) => entry.memory_id), [
    "tsx-runbook",
  ]);
  assert.deepEqual(bundle.layers.l3_expandable_deep_memory.items.map((entry) => entry.memory_id), [
    "release-snapshot",
    "audit-only",
  ]);
  assert.equal(bundle.layers.l3_expandable_deep_memory.items[0]?.resident, false);
  assert.equal(bundle.layers.l3_expandable_deep_memory.items[0]?.inclusion_policy, "tool_expand_only");
  assert.ok(bundle.layers.l0_always_resident.used_tokens <= bundle.layers.l0_always_resident.token_budget);
  assert.ok(bundle.layers.l1_pinned_scope_facts.used_tokens <= bundle.layers.l1_pinned_scope_facts.token_budget);
  assert.ok(bundle.audit.paging_contract);
  assert.equal(bundle.audit.paging_contract.ok, true);
  assert.equal(bundle.audit.paging_contract.summary.layers, 4);
});

test("context paging contract audit verifies budget and resident/tool-expand boundaries", () => {
  const clean = buildRecallContextBundle({
    queryType: QueryType.ProjectContext,
    results: [
      item({
        id: "user-language",
        content: "用户要求默认使用中文回复。",
        scopeType: ScopeType.User,
        memoryType: "preference",
        memoryLayer: "core",
      }),
      item({
        id: "runtime-profile",
        content: "memory-xx 当前运行 profile 为 full。",
        memoryType: "constraint",
        memoryLayer: "semantic",
      }),
      item({
        id: "audit-only",
        content: "审计证据只能作为可展开引用。",
        memoryType: "fact",
        memoryLayer: "audit",
        recallPolicy: "never",
      }),
    ],
  });

  const cleanAudit = auditRecallContextPagingContract(clean);
  assert.equal(cleanAudit.ok, true);
  assert.deepEqual(cleanAudit.violations, []);
  assert.equal(cleanAudit.summary.layers, 4);
  assert.equal(cleanAudit.summary.resident_layers, 3);
  assert.equal(cleanAudit.summary.expandable_layers, 1);

  const bad = {
    ...clean,
    token_budget: {
      ...clean.token_budget,
      total: clean.token_budget.total + 1,
    },
    layers: {
      ...clean.layers,
      l1_pinned_scope_facts: {
        ...clean.layers.l1_pinned_scope_facts,
        used_tokens: clean.layers.l1_pinned_scope_facts.token_budget + 1,
        items: [
          {
            ...clean.layers.l3_expandable_deep_memory.items[0]!,
            resident: true,
            inclusion_policy: "tool_expand_only" as const,
            recall_policy: "never",
          },
        ],
      },
      l3_expandable_deep_memory: {
        ...clean.layers.l3_expandable_deep_memory,
        resident: true,
      },
    },
  };

  const badAudit = auditRecallContextPagingContract(bad);
  assert.equal(badAudit.ok, false);
  assert.equal(badAudit.summary.violations, 5);
  assert.equal(badAudit.violations.some((violation) => violation.reason === "token_budget_total_mismatch"), true);
  assert.equal(badAudit.violations.some((violation) => violation.reason === "layer_over_budget"), true);
  assert.equal(badAudit.violations.some((violation) => violation.reason === "expandable_layer_marked_resident"), true);
  assert.equal(badAudit.violations.some((violation) => violation.reason === "tool_expand_item_in_resident_layer"), true);
  assert.equal(badAudit.violations.some((violation) => violation.reason === "non_recallable_item_in_resident_layer"), true);
  assert.equal(badAudit.warnings.some((warning) => warning.reason === "truncated_items_visible"), false);
});

test("context bundle keeps episodic memories out of ProjectContext but admits them for timeline queries", () => {
  const project = buildRecallContextBundle({
    queryType: QueryType.ProjectContext,
    results: [
      item({
        id: "release-snapshot",
        content: "某次 release job 还在运行，这是阶段性进度。",
        memoryType: "status",
        memoryLayer: "episodic",
      }),
    ],
  });
  const timeline = buildRecallContextBundle({
    queryType: QueryType.TimelineHistory,
    results: [
      item({
        id: "release-snapshot",
        content: "某次 release job 还在运行，这是阶段性进度。",
        memoryType: "status",
        memoryLayer: "episodic",
      }),
    ],
  });

  assert.deepEqual(project.layers.l2_query_working_set.items.map((entry) => entry.memory_id), []);
  assert.deepEqual(project.layers.l3_expandable_deep_memory.items.map((entry) => entry.memory_id), ["release-snapshot"]);
  assert.equal(project.layers.l3_expandable_deep_memory.items[0]?.inclusion_policy, "tool_expand_only");
  assert.deepEqual(timeline.layers.l2_query_working_set.items.map((entry) => entry.memory_id), ["release-snapshot"]);
  assert.deepEqual(timeline.layers.l3_expandable_deep_memory.items.map((entry) => entry.memory_id), []);
});

test("context bundle cache contract fingerprints scope, policy, budget, and generation without leaking raw query", () => {
  const left = buildRecallContextBundleCacheContract({
    query: "memory-xx 现在运行在哪个端口，路径是什么？",
    queryType: QueryType.ProjectContext,
    allowedScopes: [
      { type: ScopeType.Project, id: "memory-xx" },
      { type: ScopeType.User, id: "xiaoxiao" },
    ],
    policyVersion: "policy-v1",
    mode: "full",
    tokenBudget: {
      l0AlwaysResident: 80,
      l1PinnedScopeFacts: 140,
      l2QueryWorkingSet: 180,
      l3ExpandableDeepMemory: 200,
    },
    recallPolicy: "default",
    filterMode: FilterMode.Default,
    generation: "memory-write-42",
  });
  const sameScopesDifferentOrder = buildRecallContextBundleCacheContract({
    query: "memory-xx 现在运行在哪个端口，路径是什么？",
    queryType: QueryType.ProjectContext,
    allowedScopes: [
      { type: ScopeType.User, id: "xiaoxiao" },
      { type: ScopeType.Project, id: "memory-xx" },
    ],
    policyVersion: "policy-v1",
    mode: "full",
    tokenBudget: {
      l3ExpandableDeepMemory: 200,
      l2QueryWorkingSet: 180,
      l1PinnedScopeFacts: 140,
      l0AlwaysResident: 80,
    },
    recallPolicy: "default",
    filterMode: FilterMode.Default,
    generation: "memory-write-42",
  });
  const changedBudget = buildRecallContextBundleCacheContract({
    query: "memory-xx 现在运行在哪个端口，路径是什么？",
    queryType: QueryType.ProjectContext,
    allowedScopes: [
      { type: ScopeType.Project, id: "memory-xx" },
      { type: ScopeType.User, id: "xiaoxiao" },
    ],
    policyVersion: "policy-v1",
    mode: "full",
    tokenBudget: {
      l0AlwaysResident: 81,
      l1PinnedScopeFacts: 140,
      l2QueryWorkingSet: 180,
      l3ExpandableDeepMemory: 200,
    },
    recallPolicy: "default",
    filterMode: FilterMode.Default,
    generation: "memory-write-42",
  });
  const changedGeneration = buildRecallContextBundleCacheContract({
    query: "memory-xx 现在运行在哪个端口，路径是什么？",
    queryType: QueryType.ProjectContext,
    allowedScopes: [
      { type: ScopeType.Project, id: "memory-xx" },
      { type: ScopeType.User, id: "xiaoxiao" },
    ],
    policyVersion: "policy-v1",
    mode: "full",
    tokenBudget: {
      l0AlwaysResident: 80,
      l1PinnedScopeFacts: 140,
      l2QueryWorkingSet: 180,
      l3ExpandableDeepMemory: 200,
    },
    recallPolicy: "default",
    filterMode: FilterMode.Default,
    generation: "memory-write-43",
  });

  assert.equal(left.cache_key, sameScopesDifferentOrder.cache_key);
  assert.equal(left.query_fingerprint, sameScopesDifferentOrder.query_fingerprint);
  assert.notEqual(left.cache_key, changedBudget.cache_key);
  assert.notEqual(left.cache_key, changedGeneration.cache_key);
  assert.equal(left.cache_scope, "session_local");
  assert.equal(left.enabled, false);
  assert.equal(left.policy_version, "policy-v1");
  assert.deepEqual(left.allowed_scope_keys, ["project:memory-xx", "user:xiaoxiao"]);
  assert.deepEqual(left.invalidation_rules, [
    "allowed_scope_set_change",
    "context_bundle_budget_change",
    "context_bundle_mode_change",
    "filter_mode_change",
    "memory_scope_generation_change",
    "policy_version_change",
    "query_fingerprint_change",
    "query_type_change",
    "recall_policy_change",
  ]);
  assert.doesNotMatch(left.cache_key, /memory-xx|端口|路径|xiaoxiao/u);
  assert.doesNotMatch(JSON.stringify(left), /memory-xx 现在运行在哪个端口/u);
});

test("context bundle exposes temporal graph chains as L3 expandable references without leaking them into resident prompt", () => {
  const bundle = buildRecallContextBundle({
    queryType: QueryType.CurrentStateQuery,
    results: [
      item({
        id: "api-port-current",
        title: "Current API port",
        content: "memory-xx API uses port 5100.",
        memoryType: "fact",
        memoryLayer: "semantic",
        graphRelations: ["supersedes"],
        graphRelationEvidence: [
          {
            id: "rel-supersedes",
            relation_type: "supersedes",
            source_memory_id: "api-port-current",
            target_memory_id: "api-port-old",
            match_reason: "relation_path",
          },
        ],
        graphPathEvidence: [
          {
            from: "api-port-current",
            to: "api-port-old",
            relation_type: "supersedes",
            evidence: "auto_supersede",
          },
        ],
      }),
    ],
  });

  const l1 = bundle.layers.l1_pinned_scope_facts.items[0];
  const l3 = bundle.layers.l3_expandable_deep_memory.items[0];
  const rendered = renderRecallContextPrompt(bundle);

  assert.equal(l1?.memory_id, "api-port-current");
  assert.equal(l3?.memory_id, "api-port-current");
  assert.equal(l3?.inclusion_policy, "tool_expand_only");
  assert.equal(l3?.temporal_chain?.relations[0]?.relation_type, "supersedes");
  assert.equal(l3?.temporal_chain?.paths[0]?.to, "api-port-old");
  assert.match(rendered.prompt, /memory-xx API uses port 5100/);
  assert.doesNotMatch(rendered.prompt, /api-port-old/);
  assert.match(rendered.expandable_references, /temporal_chain=supersedes/);
  assert.match(rendered.expandable_references, /api-port-current -supersedes-> api-port-old/);
});

test("context bundle prompt renderer includes resident layers and keeps L3 as expandable references", () => {
  const bundle = buildRecallContextBundle({
    queryType: QueryType.ProjectContext,
    results: [
      item({
        id: "user-language",
        content: "用户要求默认使用中文回复。",
        scopeType: ScopeType.User,
        memoryType: "preference",
        memoryLayer: "core",
      }),
      item({
        id: "runtime-profile",
        content: "memory-xx 当前运行 profile 为 full。",
        memoryType: "constraint",
        memoryLayer: "semantic",
      }),
      item({
        id: "tsx-runbook",
        content: "运行 tsx 前设置 TMPDIR=/tmp。",
        memoryType: "procedure",
        memoryLayer: "procedural",
      }),
      item({
        id: "audit-only",
        content: "这段审计正文不能进入 prompt。",
        memoryType: "fact",
        memoryLayer: "audit",
        recallPolicy: "never",
      }),
    ],
  });

  const rendered = renderRecallContextPrompt(bundle);

  assert.match(rendered.prompt, /L0 always-resident/);
  assert.match(rendered.prompt, /用户要求默认使用中文回复/);
  assert.match(rendered.prompt, /memory-xx 当前运行 profile 为 full/);
  assert.match(rendered.prompt, /运行 tsx 前设置 TMPDIR=\/tmp/);
  assert.doesNotMatch(rendered.prompt, /这段审计正文不能进入 prompt/);
  assert.match(rendered.expandable_references, /audit-only/);
  assert.match(rendered.expandable_references, /tool_expand_only/);
  assert.doesNotMatch(rendered.expandable_references, /这段审计正文不能进入 prompt/);
  assert.deepEqual(rendered.resident_memory_ids, ["user-language", "runtime-profile", "tsx-runbook"]);
  assert.deepEqual(rendered.expandable_memory_ids, ["audit-only"]);
});

test("recall orchestrator exposes context bundle and cognitive type in response", async () => {
  const orchestrator = new RecallOrchestrator({
    lexical_retriever: new StubLexicalRetriever({
      records: [
        {
          memory_id: "stable-project-fact",
          title: "memory-xx runtime",
          content: "memory-xx runtime profile is full and Qdrant active alias is healthy.",
          scope_type: ScopeType.Project,
          scope_id: "memory-xx",
          lifecycleStatus: LifecycleStatus.Approved,
          reviewState: ReviewState.Approved,
          isCurrent: true,
          memory_type: "constraint",
          memory_layer: "semantic",
          recallPolicy: "default",
        },
      ],
    }),
    vector_retriever: new StubVectorRetriever({ records: [] }),
  });

  const response = await orchestrator.execute({
    query: "memory-xx runtime status",
    scope_context: { project_ids: ["memory-xx"] },
    filter_mode: FilterMode.Default,
    query_type_hint: QueryType.ProjectContext,
    hybrid_mode: "separate",
    rerank: false,
    limit: 5,
  });

  assert.equal(response.results[0]?.cognitive_type, "semantic");
  assert.equal(response.results[0]?.memory_layer, "semantic");
  assert.equal(response.context_bundle?.version, "context-bundle-v1");
  assert.deepEqual(response.context_bundle?.layers.l1_pinned_scope_facts.items.map((entry) => entry.memory_id), [
    "stable-project-fact",
  ]);
  assert.equal(response.context_bundle?.audit.total_input_items, 1);
  assert.equal(response.audit.adaptive_retrieval?.applied, false);
  assert.equal(response.audit.adaptive_retrieval?.source, "runtime_observation_only");
  assert.equal(response.audit.adaptive_retrieval?.query_type, QueryType.ProjectContext);
  assert.deepEqual(response.audit.adaptive_retrieval?.scope_keys, ["project:memory-xx"]);
  assert.equal(response.audit.adaptive_retrieval?.threshold_decision.action, "hold");
  assert.equal(response.audit.adaptive_retrieval?.threshold_decision.audit.guardrails.report_only, true);
});

test("recall orchestrator applies adaptive retrieval confidence override", async () => {
  const orchestrator = new RecallOrchestrator({
    lexical_retriever: new StubLexicalRetriever({
      records: [
        {
          memory_id: "low-score-exact",
          title: "low score exact",
          content: "low score exact lookup candidate",
          scope_type: ScopeType.Project,
          scope_id: "memory-xx",
          lifecycleStatus: LifecycleStatus.Approved,
          reviewState: ReviewState.Approved,
          isCurrent: true,
        },
      ],
    }),
    vector_retriever: new StubVectorRetriever({ records: [] }),
    adaptive_retrieval_override_resolver: async (input) => {
      assert.equal(input.scope_keys.includes("project:memory-xx"), true);
      assert.equal(input.query_type, QueryType.ExactLookup);
      return {
        threshold: 0.19,
        source: "governance_policy_override",
        override_id: "override-1",
      };
    },
  });

  const response = await orchestrator.execute({
    query: "low score exact lookup candidate",
    scope_context: { project_ids: ["memory-xx"] },
    filter_mode: FilterMode.Default,
    query_type_hint: QueryType.ExactLookup,
    hybrid_mode: "separate",
    rerank: false,
    limit: 5,
  });

  assert.deepEqual(response.results.map((item) => item.memory_id), ["low-score-exact"]);
  assert.equal(response.audit.confidence_gate?.threshold, 0.19);
  assert.equal(response.audit.confidence_gate?.adaptive_override?.applied, true);
  assert.equal(response.audit.confidence_gate?.adaptive_override?.override_id, "override-1");
});

test("recall orchestrator honors context bundle mode and per-layer budgets", async () => {
  const orchestrator = new RecallOrchestrator({
    lexical_retriever: new StubLexicalRetriever({
      records: [
        {
          memory_id: "stable-project-fact",
          title: "memory-xx runtime",
          content: "memory-xx runtime profile is full and Qdrant active alias is healthy.",
          scope_type: ScopeType.Project,
          scope_id: "memory-xx",
          lifecycleStatus: LifecycleStatus.Approved,
          reviewState: ReviewState.Approved,
          isCurrent: true,
          memory_type: "constraint",
          memory_layer: "semantic",
          recallPolicy: "default",
        },
      ],
    }),
    vector_retriever: new StubVectorRetriever({ records: [] }),
  });

  const disabled = await orchestrator.execute({
    query: "memory-xx runtime status",
    scope_context: { project_ids: ["memory-xx"] },
    filter_mode: FilterMode.Default,
    query_type_hint: QueryType.ProjectContext,
    hybrid_mode: "separate",
    rerank: false,
    limit: 5,
    context_bundle: false,
  });
  assert.equal(disabled.context_bundle, undefined);
  assert.equal(disabled.audit.context_bundle?.mode, "disabled");

  const summary = await orchestrator.execute({
    query: "memory-xx runtime status",
    scope_context: { project_ids: ["memory-xx"] },
    filter_mode: FilterMode.Default,
    query_type_hint: QueryType.ProjectContext,
    hybrid_mode: "separate",
    rerank: false,
    limit: 5,
    context_bundle: "summary",
    context_bundle_budget: {
      l1PinnedScopeFacts: 24,
      l2QueryWorkingSet: 40,
    },
  });

  assert.equal(summary.context_bundle?.layers.l1_pinned_scope_facts.token_budget, 24);
  assert.equal(summary.context_bundle?.layers.l1_pinned_scope_facts.items.length, 0);
  assert.equal(summary.context_bundle?.audit.total_input_items, 1);
  assert.equal(summary.context_bundle?.audit.redacted_items, 1);
  assert.equal(summary.audit.context_bundle?.mode, "summary");
  assert.equal(summary.audit.context_bundle?.requested_mode, "summary");
  assert.equal(summary.audit.context_bundle?.requested_budgets.l1PinnedScopeFacts, 24);
  assert.equal(summary.audit.context_bundle?.applied_budgets.l0_always_resident, 320);
  assert.equal(summary.audit.context_bundle?.applied_budgets.l1_pinned_scope_facts, 24);
});

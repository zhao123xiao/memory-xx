import { promises as fs } from "node:fs";
import path from "node:path";

import type { RecallCacheAudit, RecallCacheRuntime } from "../cache";
import { readRuntimeControlNumberSync } from "../runtime-control-settings";
import { DEFAULT_FILTER_MODE } from "../shared";
import { buildRecallFilterPlan } from "./filter-builder";
import { buildRetrievalPlan } from "./hybrid-planner";
import {
  buildMetadataConstraints,
  tokenizeRecallQuery
} from "./metadata-filter-builder";
import { classifyQuery } from "./query-classifier";
import { rerankCandidatesWithOptionalModel } from "./model-reranker";
import { applyRecallConfidenceGate } from "./confidence-gate";
import { buildRecallQueryContext } from "./query-context";
import { fuseRecallCandidatesRrf } from "./fusion";
import { computeRecallDegradeLevel } from "./degrade-level";
import {
  resolveAllowedScopeSet,
  type RuntimeScopeContextAdapter,
  type ScopeAccessPolicy
} from "./scope-resolver";
import { type LexicalRetriever } from "./retrievers/lexical-retriever";
import { type VectorRetriever } from "./retrievers/vector-retriever";
import { type GraphRetriever } from "./retrievers/graph-retriever";
import { isRecallError } from "./errors";
import {
  type QueryConstraints,
  QueryType,
  type QueryEmbeddingAudit,
  type RecallRequest,
  type RecallResponse,
  type RecallResultItem,
  type RetrieverCandidate
} from "./types";
import { classifyTemporalQuery, applyTemporalFilter } from "./temporal-guard";
import { recordRerankerFallback } from "../observability/domain-metrics";
import {
  fetchRecentApprovedPgFallback,
  type PgQueryable
} from "./recent-approved-pg-fallback";

function buildAuditRef(request: RecallRequest, queryType: string): string {
  const queryPart = request.query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 24);
  return `audit:${queryType}:${queryPart || "query"}`;
}

function mergeCandidates(candidates: RetrieverCandidate[]): RetrieverCandidate[] {
  const merged = new Map<string, RetrieverCandidate>();

  for (const candidate of candidates) {
    const existing = merged.get(candidate.memory_id);
    if (!existing) {
      merged.set(candidate.memory_id, {
        ...candidate,
        matched_terms: [...candidate.matched_terms],
        why_matched: [...candidate.why_matched],
        source_retrievers: [...candidate.source_retrievers]
      });
      continue;
    }

    existing.score = Math.max(existing.score, candidate.score);
    existing.lexical_score = Math.max(
      existing.lexical_score ?? 0,
      candidate.lexical_score ?? 0
    );
    existing.vector_score = Math.max(
      existing.vector_score ?? 0,
      candidate.vector_score ?? 0
    );
    existing.graph_score = Math.max(
      existing.graph_score ?? 0,
      candidate.graph_score ?? 0
    );
    existing.graph_path_score = Math.max(
      existing.graph_path_score ?? 0,
      candidate.graph_path_score ?? 0
    );
    existing.graph_rank_reason = existing.graph_rank_reason ?? candidate.graph_rank_reason;
    existing.graph_entities = [...new Set([...(existing.graph_entities ?? []), ...(candidate.graph_entities ?? [])])];
    existing.graph_relations = [...new Set([...(existing.graph_relations ?? []), ...(candidate.graph_relations ?? [])])];
    existing.graph_evidence_sources = [...new Set([...(existing.graph_evidence_sources ?? []), ...(candidate.graph_evidence_sources ?? [])])];
    existing.graph_path = [...new Set([...(existing.graph_path ?? []), ...(candidate.graph_path ?? [])])];
    existing.graph_entity_evidence = existing.graph_entity_evidence ?? candidate.graph_entity_evidence;
    existing.graph_relation_evidence = existing.graph_relation_evidence ?? candidate.graph_relation_evidence;
    existing.graph_source_evidence = existing.graph_source_evidence ?? candidate.graph_source_evidence;
    existing.graph_path_evidence = existing.graph_path_evidence ?? candidate.graph_path_evidence;
    existing.matched_terms = [
      ...new Set([...existing.matched_terms, ...candidate.matched_terms])
    ];
    existing.why_matched = [
      ...new Set([...existing.why_matched, ...candidate.why_matched])
    ];
    existing.source_retrievers = [
      ...new Set([
        ...existing.source_retrievers,
        ...candidate.source_retrievers
      ])
    ];
  }

  return [...merged.values()].sort((left, right) => right.score - left.score);
}

function toResultItem(candidate: RetrieverCandidate): RecallResultItem {
  return {
    memory_id: candidate.memory_id,
    title: candidate.record.title,
    content: candidate.record.content,
    scope: {
      type: candidate.record.scope_type,
      id: candidate.record.scope_id
    },
    score: candidate.score,
    rerank_score: candidate.rerank_score,
    local_score: candidate.local_score,
    final_score: candidate.final_score,
    rrf_score: candidate.rrf_score,
    graph_score: candidate.graph_score,
    graph_path_score: candidate.graph_path_score,
    graph_rank_reason: candidate.graph_rank_reason,
    graph_entities: candidate.graph_entities,
    graph_relations: candidate.graph_relations,
    graph_evidence_sources: candidate.graph_evidence_sources,
    graph_path: candidate.graph_path,
    graph_entity_evidence: candidate.graph_entity_evidence,
    graph_relation_evidence: candidate.graph_relation_evidence,
    graph_source_evidence: candidate.graph_source_evidence,
    graph_path_evidence: candidate.graph_path_evidence,
    low_confidence: candidate.low_confidence,
    source_retrievers: candidate.source_retrievers,
    source_path: candidate.record.source?.path,
    source_type: candidate.record.source?.source_type,
    matched_terms: candidate.matched_terms
  };
}

type ScopeConflictPolicy = NonNullable<RecallRequest["scope_conflict_policy"]>;

const DEFAULT_SCOPE_CONFLICT_POLICY: ScopeConflictPolicy = "more_specific_wins";

function normalizeScopeConflictPolicy(policy: RecallRequest["scope_conflict_policy"]): ScopeConflictPolicy {
  return policy ?? DEFAULT_SCOPE_CONFLICT_POLICY;
}

function buildScopePrecedence(policy: ScopeConflictPolicy): Record<string, number> {
  if (policy === "higher_scope_wins") {
    return { global: 6, user: 5, workspace: 4, project: 3, run: 2, task: 1 };
  }
  return { task: 6, run: 5, project: 4, workspace: 3, user: 2, global: 1 };
}

function logicalConflictKey(candidate: RetrieverCandidate): string {
  const title = candidate.record.title?.replace(/\s+/g, " ").trim().toLowerCase();
  if (title) {
    return `title:${title}`;
  }
  return `content:${candidate.record.content.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 160)}`;
}

function timestampMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rankCandidatesByScopePolicy(
  candidates: readonly RetrieverCandidate[],
  policy: ScopeConflictPolicy,
  scopePrecedence: Record<string, number>
): RetrieverCandidate[] {
  const position = new Map(candidates.map((candidate, index) => [candidate.memory_id, index]));
  const groupCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = logicalConflictKey(candidate);
    groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
  }

  return [...candidates].sort((left, right) => {
    const leftKey = logicalConflictKey(left);
    const rightKey = logicalConflictKey(right);
    if (leftKey !== rightKey || (groupCounts.get(leftKey) ?? 0) <= 1) {
      return (position.get(left.memory_id) ?? 0) - (position.get(right.memory_id) ?? 0);
    }

    if (policy === "latest_wins") {
      const updatedDiff = timestampMs(right.record.updated_at) - timestampMs(left.record.updated_at);
      if (updatedDiff !== 0) return updatedDiff;
    } else {
      const scopeDiff =
        (scopePrecedence[right.record.scope_type] ?? 0) -
        (scopePrecedence[left.record.scope_type] ?? 0);
      if (scopeDiff !== 0) return scopeDiff;
    }

    const scoreDiff = (right.final_score ?? right.score) - (left.final_score ?? left.score);
    if (scoreDiff !== 0) return scoreDiff;
    return (position.get(left.memory_id) ?? 0) - (position.get(right.memory_id) ?? 0);
  });
}

function applyRecallCacheHints(
  candidates: readonly RetrieverCandidate[],
  input: {
    readonly sessionMemoryIds: ReadonlySet<string>;
    readonly recentScores: ReadonlyMap<string, number>;
  }
): RetrieverCandidate[] {
  if (input.sessionMemoryIds.size === 0 && input.recentScores.size === 0) {
    return [...candidates];
  }
  return candidates
    .map((candidate) => {
      const sessionHit = input.sessionMemoryIds.has(candidate.memory_id);
      const recentScore = input.recentScores.get(candidate.memory_id);
      if (!sessionHit && recentScore === undefined) return candidate;
      const sourceRetrievers = new Set(candidate.source_retrievers);
      const whyMatched = new Set(candidate.why_matched);
      let bonus = 0;
      if (sessionHit) {
        sourceRetrievers.add("session_cache");
        whyMatched.add("session_cache_hit");
        bonus += 0.03;
      }
      if (recentScore !== undefined) {
        sourceRetrievers.add("recent_cache");
        whyMatched.add("recent_cache_hit");
        bonus += Math.min(0.02, Math.max(0, recentScore) * 0.01);
      }
      return {
        ...candidate,
        score: candidate.score + bonus,
        recency_scope_bonus: (candidate.recency_scope_bonus ?? 0) + bonus,
        source_retrievers: [...sourceRetrievers],
        why_matched: [...whyMatched]
      };
    })
    .sort((left, right) => right.score - left.score);
}

function resolveVectorEmbeddingAudit(
  vectorRetriever: VectorRetriever,
  options: {
    include_debug: boolean;
    vector_executed: boolean;
  }
): QueryEmbeddingAudit | undefined {
  if (!options.include_debug || !options.vector_executed) {
    return undefined;
  }

  return vectorRetriever.get_last_query_embedding_audit?.();
}

type GraphGuardDecision = {
  readonly cap_weight: number;
  readonly reason: string;
};

let graphGuardCache: {
  readonly runtimeDir: string;
  readonly loadedAt: number;
  readonly decision: GraphGuardDecision | undefined;
} | null = null;

function configuredGraphWeightCap(): number {
  const parsed = Number.parseFloat(process.env.MEMORY_V2_GRAPH_WEIGHT_CAP ?? "0.85");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.85;
}

export function normalizeGraphHealthCacheTtlMs(ttlMs: number): number {
  return Math.max(Number.isFinite(ttlMs) ? ttlMs : 60_000, 1_000);
}

async function loadRuntimeGraphGuard(capWeight: number): Promise<GraphGuardDecision | undefined> {
  if (process.env.MEMORY_V2_GRAPH_GUARD_DISABLED === "true") {
    return undefined;
  }

  const runtimeDir = process.env.MEMORY_V2_RUNTIME_DIR?.trim() || path.join(process.cwd(), ".runtime");
  const envTtlMs = Number.parseInt(process.env.MEMORY_V2_GRAPH_HEALTH_TTL_MS ?? "86400000", 10);
  const ttlMs = readRuntimeControlNumberSync("recall.graph_health_ttl_ms", envTtlMs);
  const cacheTtlMs = normalizeGraphHealthCacheTtlMs(ttlMs);
  if (graphGuardCache && graphGuardCache.runtimeDir === runtimeDir && Date.now() - graphGuardCache.loadedAt < cacheTtlMs) {
    return graphGuardCache.decision;
  }
  try {
    const raw = await fs.readFile(path.join(runtimeDir, "graph-health-latest.json"), "utf8");
    const report = JSON.parse(raw) as {
      ok?: unknown;
      status?: unknown;
      generated_at?: unknown;
      blockers?: unknown;
      warnings?: unknown;
      guard?: { reasons?: unknown };
    };
    const reasons = [
      ...(Array.isArray(report.guard?.reasons) ? report.guard.reasons : []),
      ...(Array.isArray(report.blockers) ? report.blockers : []),
      ...(Array.isArray(report.warnings) ? report.warnings : [])
    ].filter((item): item is string => typeof item === "string");
    const generatedAt = typeof report.generated_at === "string" ? Date.parse(report.generated_at) : Number.NaN;
    let decision: GraphGuardDecision | undefined;
    if (Number.isFinite(generatedAt) && Number.isFinite(ttlMs) && Date.now() - generatedAt > ttlMs) {
      reasons.push("graph_health_stale");
    }
    if (report.ok === false || report.status === "blocked" || report.status === "degraded" || reasons.length > 0) {
      decision = {
        cap_weight: capWeight,
        reason: [...new Set(reasons)].slice(0, 4).join("+") || "graph_health_guard"
      };
    }
    graphGuardCache = { runtimeDir, loadedAt: Date.now(), decision };
    return decision;
  } catch {
    if (process.env.MEMORY_V2_GRAPH_GUARD_REQUIRE_HEALTH === "true") {
      const decision = { cap_weight: capWeight, reason: "graph_health_missing" };
      graphGuardCache = { runtimeDir, loadedAt: Date.now(), decision };
      return decision;
    }
  }
  graphGuardCache = { runtimeDir, loadedAt: Date.now(), decision: undefined };
  return undefined;
}

export interface RecallOrchestratorDependencies {
  lexical_retriever: LexicalRetriever;
  vector_retriever: VectorRetriever;
  graph_retriever?: GraphRetriever;
  recall_cache?: RecallCacheRuntime;
  runtime_scope_adapter?: RuntimeScopeContextAdapter;
  scope_access_policy?: ScopeAccessPolicy;
  recent_approved_queryable?: PgQueryable;
  recent_approved_schema?: string;
}

export class RecallOrchestrator {
  private readonly dependencies: RecallOrchestratorDependencies;

  constructor(dependencies: RecallOrchestratorDependencies) {
    this.dependencies = dependencies;
  }

  async execute(request: RecallRequest): Promise<RecallResponse> {
    const scopeConflictPolicy = normalizeScopeConflictPolicy(request.scope_conflict_policy);
    const scopePrecedence = buildScopePrecedence(scopeConflictPolicy);
    const allowedScopeSet = await resolveAllowedScopeSet(request, {
      runtime_scope_adapter: this.dependencies.runtime_scope_adapter,
      access_policy: this.dependencies.scope_access_policy
    });

    const classification = classifyQuery({
      query: request.query,
      query_type_hint: request.query_type_hint
    });
    const queryContext = buildRecallQueryContext(request);
    const effectiveQuery = queryContext.expanded_query ?? request.query;

    const cacheAudit: RecallCacheAudit = {
      search: { status: "skipped", reason: "cache_not_checked" },
      session: { status: "skipped", reason: "cache_not_checked" },
      recent: { status: "skipped", reason: "cache_not_checked" },
      startup_context: { status: "skipped", reason: "cache_not_checked" }
    };
    let sessionCacheHit = false;
    let recentCacheHit = false;
    let sessionMemoryIds = new Set<string>();
    let recentScores = new Map<string, number>();

    if (this.dependencies.recall_cache) {
      const startupHit = await this.dependencies.recall_cache.getStartupContext(request, classification);
      if (startupHit) {
        cacheAudit.startup_context = { status: "hit", key: startupHit.key };
        cacheAudit.search = { status: "skipped", reason: "startup_context_hit" };
        const sessionResult = await this.dependencies.recall_cache.rememberSession(request, startupHit.response);
        const recentResult = await this.dependencies.recall_cache.rememberRecent(allowedScopeSet.allowed_scope_set, startupHit.response);
        cacheAudit.session = sessionResult;
        cacheAudit.recent = recentResult;
        return {
          ...startupHit.response,
          audit: { ...startupHit.response.audit, cache: cacheAudit },
          explain: startupHit.response.explain
            ? { ...startupHit.response.explain, cache: cacheAudit }
            : startupHit.response.explain
        };
      }

      cacheAudit.startup_context = { status: "miss" };
      const searchHit = await this.dependencies.recall_cache.getSearch(request);
      if (searchHit) {
        cacheAudit.search = { status: "hit", key: searchHit.key };
        const sessionResult = await this.dependencies.recall_cache.rememberSession(request, searchHit.response);
        const recentResult = await this.dependencies.recall_cache.rememberRecent(allowedScopeSet.allowed_scope_set, searchHit.response);
        cacheAudit.session = sessionResult;
        cacheAudit.recent = recentResult;
        return {
          ...searchHit.response,
          audit: { ...searchHit.response.audit, cache: cacheAudit },
          explain: searchHit.response.explain
            ? { ...searchHit.response.explain, cache: cacheAudit }
            : searchHit.response.explain
        };
      }

      cacheAudit.search = { status: "miss" };
      const sessionHit = await this.dependencies.recall_cache.getSession(request);
      if (sessionHit) {
        sessionCacheHit = true;
        sessionMemoryIds = new Set(sessionHit.entry.result_memory_ids);
        cacheAudit.session = { status: "hit", key: sessionHit.key };
      } else {
        cacheAudit.session = { status: "miss" };
      }

      const recentHit = await this.dependencies.recall_cache.getRecent(allowedScopeSet.allowed_scope_set);
      if (recentHit) {
        recentCacheHit = recentHit.entries.length > 0;
        recentScores = new Map(recentHit.entries.map((entry) => [entry.memory_id, entry.score]));
        cacheAudit.recent = { status: "hit", key: recentHit.key };
      } else {
        cacheAudit.recent = { status: "miss" };
      }
    }

    const filterPlan = buildRecallFilterPlan({
      requested_mode: request.filter_mode ?? DEFAULT_FILTER_MODE,
      allow_privileged_filter_modes:
        request.debug?.allow_privileged_filter_modes ?? false
    });

    const metadata = buildMetadataConstraints({
      query: effectiveQuery,
      classification
    });
    const queryConstraints: QueryConstraints = {
      normalized_query: effectiveQuery.trim().toLowerCase(),
      query_terms: queryContext.terms.length > 0 ? [...queryContext.terms] : tokenizeRecallQuery(effectiveQuery),
      allowed_scope_set: allowedScopeSet.allowed_scope_set,
      scope_conflict_policy: scopeConflictPolicy,
      scope_precedence: scopePrecedence,
      filter_plan: filterPlan,
      metadata,
      classification,
      memory_ids: request.scope_context.memory_ids,
      limit: request.limit ?? classification.top_k,
      offset: request.offset ?? 0,
      force_model_rerank: request.rerank === true || request.hybrid_mode === "model_rerank",
      query_context: queryContext
    };
    const shouldExpandRetrievalWindow =
      classification.rerank_enabled &&
      (request.scope_context.project_ids?.length ?? 0) === 0;
    const retrievalWindow = shouldExpandRetrievalWindow
      ? Math.max(
          queryConstraints.limit + queryConstraints.offset,
          classification.top_k,
          30
        )
      : Math.max(queryConstraints.limit + queryConstraints.offset, 30);

    const retrievalConstraints: QueryConstraints = {
      ...queryConstraints,
      limit: retrievalWindow,
      offset: 0
    };

    const lexicalStatus =
      await this.dependencies.lexical_retriever.get_backend_status();
    const vectorStatus =
      await this.dependencies.vector_retriever.get_backend_status();
    const retrievalPlan = buildRetrievalPlan({
      classification,
      lexical_status: lexicalStatus,
      vector_status: vectorStatus
    });

    const degradeReasons = [
      ...allowedScopeSet.degrade_reasons,
      ...retrievalPlan.degrade_reasons
    ];

    const lexicalCandidates: RetrieverCandidate[] = [];
    const vectorCandidates: RetrieverCandidate[] = [];
    const graphCandidates: RetrieverCandidate[] = [];
    const recentApprovedPgFallback = await fetchRecentApprovedPgFallback({
      queryable: this.dependencies.recent_approved_queryable,
      schema: this.dependencies.recent_approved_schema,
      constraints: retrievalConstraints,
      enabled: vectorStatus.backend === "qdrant" || vectorStatus.primary_backend === "qdrant"
    }).catch((error) => ({
      candidates: [],
      audit: {
        enabled: process.env.MEMORY_V2_RECENT_APPROVED_PG_FALLBACK !== "false",
        window_ms: Number.parseInt(process.env.MEMORY_V2_RECENT_APPROVED_PG_FALLBACK_WINDOW_MS ?? "30000", 10),
        candidate_cap: Number.parseInt(process.env.MEMORY_V2_RECENT_APPROVED_PG_FALLBACK_LIMIT ?? "20", 10),
        candidate_count: 0,
        reason: error instanceof Error ? `error:${error.message}` : "error"
      }
    }));

    if (retrievalPlan.execute_lexical) {
      try {
        lexicalCandidates.push(
          ...(await this.dependencies.lexical_retriever.retrieve(
            retrievalConstraints
          ))
        );
      } catch (error) {
        if (!isRecallError(error)) {
          throw error;
        }

        degradeReasons.push(
          error.code === "backend_timeout"
            ? "lexical_backend_timeout"
            : "lexical_backend_unavailable"
        );
      }
    }

    if (retrievalPlan.execute_vector) {
      try {
        vectorCandidates.push(
          ...(await this.dependencies.vector_retriever.retrieve(
            retrievalConstraints
          ))
        );
      } catch (error) {
        if (!isRecallError(error)) {
          throw error;
        }

        degradeReasons.push(
          error.code === "backend_timeout"
            ? "vector_backend_timeout"
            : "vector_backend_unavailable"
        );
      }
    }

    if (this.dependencies.graph_retriever) {
      try {
        graphCandidates.push(
          ...(await this.dependencies.graph_retriever.retrieve(
            retrievalConstraints
          ))
        );
      } catch {
        degradeReasons.push("graph_retriever_unavailable");
      }
    }

    const graphGuard = await (async () => {
      const highGraphQuery = [
        QueryType.EntityProfile,
        QueryType.ProjectContext,
        QueryType.CurrentStateQuery,
        QueryType.EpisodeLookup,
        QueryType.DecisionLookup,
        QueryType.TimelineHistory,
        QueryType.HistoricalQuery,
        QueryType.DebugRecall,
        QueryType.DebugAuditQuery
      ].includes(classification.query_type);
      const minCandidates = Number.parseInt(process.env.MEMORY_V2_GRAPH_MIN_QUERY_CANDIDATES ?? "2", 10);
      const configuredCap = configuredGraphWeightCap();
      const runtimeGraphGuard = await loadRuntimeGraphGuard(configuredCap);
      if (runtimeGraphGuard) return runtimeGraphGuard;
      if (degradeReasons.includes("graph_retriever_unavailable")) {
        return { cap_weight: configuredCap, reason: "graph_retriever_unavailable" };
      }
      if (highGraphQuery && graphCandidates.length < minCandidates && (lexicalCandidates.length + vectorCandidates.length) > 0) {
        return { cap_weight: configuredCap, reason: "graph_sparse_for_query" };
      }
      return undefined;
    })();

    const queryEmbeddingAudit = resolveVectorEmbeddingAudit(
      this.dependencies.vector_retriever,
      {
        include_debug: request.debug?.enabled === true,
        vector_executed: retrievalPlan.execute_vector
      }
    );

    const fusion = fuseRecallCandidatesRrf({
      lexical: [...lexicalCandidates, ...recentApprovedPgFallback.candidates],
      vector: vectorCandidates,
      graph: graphCandidates,
      classification,
      graph_guard: graphGuard
    });
    const mergedCandidates = applyRecallCacheHints(
      mergeCandidates(fusion.candidates),
      { sessionMemoryIds, recentScores }
    );

    // P2: Temporal guard - filter candidates based on temporal classification
    const temporalClassification = classifyTemporalQuery(classification.query_type);
    const temporalFilterResult = applyTemporalFilter(
      mergedCandidates,
      temporalClassification,
      {
        override_temporal_scope: request.temporal_scope as any,
        override_layers: request.memory_layers as any,
      }
    );
    const temporalAllowedIds = new Set(temporalFilterResult.filtered);
    const temporallyFilteredCandidates = mergedCandidates.filter(
      (c) => temporalAllowedIds.has(c.memory_id)
    );

    const rerankOutcome = await rerankCandidatesWithOptionalModel(
      temporallyFilteredCandidates,
      queryConstraints
    );
    const policyRankedRerankCandidates = rankCandidatesByScopePolicy(
      rerankOutcome.candidates,
      scopeConflictPolicy,
      scopePrecedence
    );
    const confidenceGate = applyRecallConfidenceGate(
      policyRankedRerankCandidates,
      queryConstraints,
      rerankOutcome
    );
    const rerankedCandidates = rankCandidatesByScopePolicy(
      confidenceGate.candidates,
      scopeConflictPolicy,
      scopePrecedence
    );
    const returnedCandidates = rerankedCandidates.slice(
      queryConstraints.offset,
      queryConstraints.offset + queryConstraints.limit
    );
    const normalizedDegradeReasons = [...new Set(degradeReasons)];
    const degradeLevel = computeRecallDegradeLevel({
      lexical_status: lexicalStatus,
      vector_status: vectorStatus,
      vector_candidates: vectorCandidates,
      degrade_reasons: normalizedDegradeReasons
    });
    const finalDegradeReasons = normalizedDegradeReasons.length > 0
      ? normalizedDegradeReasons
      : degradeLevel === 1
        ? ["qdrant_fallback_pgvector"]
        : degradeLevel === 2
          ? ["vector_backend_unavailable"]
          : degradeLevel === 3
            ? ["all_retrievers_unavailable"]
            : [];
    const rerankDegraded = rerankOutcome.backend !== "model" && rerankOutcome.reason !== undefined && rerankOutcome.reason !== "query_profile_disabled_rerank";
    if (rerankDegraded) {
      recordRerankerFallback(rerankOutcome.reason ?? "unknown");
    }
    const auditRef = buildAuditRef(request, classification.query_type);
    const audit = {
      cache: cacheAudit,
      audit_ref: auditRef,
      query_type: classification.query_type,
      strategy: retrievalPlan.strategy,
      degraded: finalDegradeReasons.length > 0,
      degrade_level: degradeLevel,
      degrade_reasons: finalDegradeReasons,
      rerank_degraded: rerankDegraded,
      primary_backend: "node" as const,
      fallback_used: false,
      rerank: {
        backend: rerankOutcome.backend,
        model_attempted: rerankOutcome.model_attempted,
        model_used: rerankOutcome.model_used,
        reason: rerankOutcome.reason,
        latency_ms: rerankOutcome.latency_ms
      },
      confidence_gate: confidenceGate.audit,
      null_guard: confidenceGate.audit,
      fusion: fusion.audit,
      query_context: queryContext,
      temporal: temporalFilterResult,
      lexical_status: lexicalStatus,
      vector_status: vectorStatus,
      lexical_hits: lexicalCandidates.length,
      vector_hits: vectorCandidates.length,
      graph_hits: graphCandidates.length,
      recent_approved_pg_fallback: recentApprovedPgFallback.audit,
      graph_guard: graphGuard,
      merged_hits: mergedCandidates.length,
      returned_hits: returnedCandidates.length,
      session_cache_hit: sessionCacheHit,
      recent_cache_hit: recentCacheHit,
      scope_conflict_policy: scopeConflictPolicy,
      scope_precedence: scopePrecedence
    };

    const response: RecallResponse = {
      results: returnedCandidates.map(toResultItem),
      filter_mode_applied: filterPlan.applied_mode,
      allowed_scope_set: allowedScopeSet.allowed_scope_set,
      degraded: finalDegradeReasons.length > 0,
      degrade_reason:
        finalDegradeReasons.length > 0
          ? finalDegradeReasons.join(",")
          : undefined,
      degrade_level: degradeLevel,
      audit_ref: auditRef,
      audit,
      fusion: fusion.audit,
      null_guard: confidenceGate.audit,
      query_context: queryContext,
      feedback_contract: {
        expected_fields: ["recall_trace_id", "used_memory_ids", "agent_id"],
        validation_rules: ["trace_membership_check", "suspicious_feedback_thresholds"]
      },
      explain: request.explain
        ? {
            classification,
            strategy:
              request.debug?.include_strategy_plan ||
              classification.explain_detail === "full"
                ? retrievalPlan
                : undefined,
            metadata,
            filter: {
              requested_mode: filterPlan.requested_mode,
              applied_mode: filterPlan.applied_mode,
              predicate_id: filterPlan.predicate_id,
              sql_where_clause: filterPlan.sql_where_clause
            },
            retrieval: {
              lexical_hits: lexicalCandidates.length,
              vector_hits: vectorCandidates.length,
              graph_hits: graphCandidates.length,
              recent_approved_pg_fallback: recentApprovedPgFallback.audit,
              merged_hits: mergedCandidates.length,
              returned_hits: returnedCandidates.length,
              rerank_applied: classification.rerank_enabled,
              rerank_backend: rerankOutcome.backend,
              rerank_used_model: rerankOutcome.model_used,
              rerank_reason: rerankOutcome.reason,
              rerank_latency_ms: rerankOutcome.latency_ms,
              confidence_gate: confidenceGate.audit,
              fusion: fusion.audit
            },
            cache: cacheAudit,
            embedding: queryEmbeddingAudit,
            degrade_level: degradeLevel,
            rerank_degraded: rerankDegraded,
            fusion: fusion.audit,
            null_guard: confidenceGate.audit,
            query_context: queryContext,
            temporal: temporalFilterResult
          }
        : undefined
    };

    if (this.dependencies.recall_cache) {
      cacheAudit.search = await this.dependencies.recall_cache.setSearch(request, response);
      cacheAudit.startup_context = await this.dependencies.recall_cache.setStartupContext(request, classification, response);
      cacheAudit.session = await this.dependencies.recall_cache.rememberSession(request, response);
      cacheAudit.recent = await this.dependencies.recall_cache.rememberRecent(allowedScopeSet.allowed_scope_set, response);
      response.audit = { ...response.audit, cache: cacheAudit };
      if (response.explain) {
        response.explain = { ...response.explain, cache: cacheAudit };
      }
    }

    return response;
  }
}

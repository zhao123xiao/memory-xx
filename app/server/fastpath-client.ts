import { DEFAULT_FILTER_MODE, FilterMode, LifecycleStatus, ReviewState, ScopeType } from "../shared";
import { buildRecallFilterPlan } from "../recall/filter-builder";
import {
  buildMetadataConstraints,
  tokenizeRecallQuery
} from "../recall/metadata-filter-builder";
import { applyRecallConfidenceGate } from "../recall/confidence-gate";
import { fuseRecallCandidatesRrf } from "../recall/fusion";
import { classifyQuery } from "../recall/query-classifier";
import { rerankCandidatesWithOptionalModel } from "../recall/model-reranker";
import { resolveAllowedScopeSet } from "../recall/scope-resolver";
import { runtime } from "./runtime";
import * as serverRuntime from "./runtime";
import { readRuntimeControlNumberSync } from "../runtime-control-settings";
import { isPostgresTransactionContext, withWriteTransaction } from "../db/tx/write-transaction";
import { fetchRecentApprovedPgFallback } from "../recall/recent-approved-pg-fallback";
import {
  RetrievalStrategy,
  type QueryConstraints,
  type RecallFusionAudit,
  type RecallRecord,
  type RecallRequest,
  type RecallResponse,
  type RecallScopeRef,
  type RetrieverCandidate
} from "../recall/types";

export interface FastpathRecallAttempt {
  readonly attempted: boolean;
  readonly used: boolean;
  readonly reason?: string;
  readonly latency_ms?: number;
  readonly response?: RecallResponse;
}

interface FastpathCandidatePayload {
  readonly source_retrievers?: unknown;
  readonly vector_score?: unknown;
  readonly lexical_score?: unknown;
  readonly graph_score?: unknown;
  readonly memory_id?: unknown;
  readonly source_path?: unknown;
  readonly source_type?: unknown;
  readonly lifecycle_status?: unknown;
  readonly review_state?: unknown;
  readonly is_current?: unknown;
}

interface FastpathCandidate {
  readonly memory_id?: unknown;
  readonly title?: unknown;
  readonly content?: unknown;
  readonly summary?: unknown;
  readonly score?: unknown;
  readonly scope?: unknown;
  readonly memory_type?: unknown;
  readonly lifecycle_status?: unknown;
  readonly review_state?: unknown;
  readonly is_current?: unknown;
  readonly source?: unknown;
  readonly payload?: FastpathCandidatePayload;
}

interface FastpathResponse {
  readonly ok?: unknown;
  readonly mode?: unknown;
  readonly candidates?: unknown;
  readonly error?: unknown;
  readonly latency_breakdown?: unknown;
  readonly cache?: unknown;
}

interface FastpathScopeResult {
  readonly scope: RecallScopeRef;
  readonly candidates: RetrieverCandidate[];
  readonly error?: string;
}

function envFlag(name: string, expected: string): boolean {
  return (process.env[name] ?? "").trim().toLowerCase() === expected;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readRuntimePositiveInt(runtimeKey: string, envName: string, fallback: number): number {
  const envValue = readPositiveInt(envName, fallback);
  const runtimeValue = readRuntimeControlNumberSync(runtimeKey, envValue);
  return Number.isFinite(runtimeValue) && runtimeValue > 0 ? runtimeValue : envValue;
}

function readCappedPositiveInt(name: string, fallback: number, capName: string, capFallback: number): number {
  return Math.min(readPositiveInt(name, fallback), readPositiveInt(capName, capFallback));
}

async function withBudget<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutValue: T
): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fastpathBaseUrl(): string {
  return (process.env.MEMORY_XX_FASTPATH_URL ?? "http://127.0.0.1:5200").replace(/\/+$/, "");
}

function isDefaultFilter(request: RecallRequest): boolean {
  return (request.filter_mode ?? DEFAULT_FILTER_MODE) === FilterMode.Default;
}

function supportedScope(scope: RecallScopeRef): boolean {
  return [
    ScopeType.User,
    ScopeType.Project,
    ScopeType.Workspace,
    ScopeType.Global,
    ScopeType.Run,
    ScopeType.Task
  ].includes(scope.type as ScopeType);
}

function scopeKey(scope: RecallScopeRef): string {
  return `${scope.type}:${scope.id}`;
}

function scopePriority(scope: RecallScopeRef): number {
  if (scope.type === ScopeType.Run || scope.type === ScopeType.Task) {
    return 0;
  }
  if (scope.type === ScopeType.User) {
    return 1;
  }
  if (scope.type === ScopeType.Project) {
    return 2;
  }
  if (scope.type === ScopeType.Workspace && scope.id === "memory-ledger") {
    return 3;
  }
  if (scope.type === ScopeType.Workspace) {
    return 4;
  }
  if (scope.type === ScopeType.Global) {
    return 5;
  }
  return 9;
}

function uniqueOrderedScopes(scopes: readonly RecallScopeRef[]): RecallScopeRef[] {
  const seen = new Set<string>();
  return scopes.filter((scope) => {
    const key = scopeKey(scope);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function planFastpathScopeBatches(
  scopes: readonly RecallScopeRef[],
  options: {
    readonly initial_scope_count?: number;
    readonly max_scope_count?: number;
  } = {}
): RecallScopeRef[][] {
  const ordered = uniqueOrderedScopes(scopes)
    .map((scope, index) => ({ scope, index }))
    .sort((left, right) => {
      const priorityDelta = scopePriority(left.scope) - scopePriority(right.scope);
      return priorityDelta !== 0 ? priorityDelta : left.index - right.index;
    })
    .map((item) => item.scope);
  const maxScopeCount = Math.max(
    1,
    Math.min(
      ordered.length,
      options.max_scope_count ?? readPositiveInt("MEMORY_XX_FASTPATH_MAX_SCOPE_COUNT", 5)
    )
  );
  const selected = ordered.slice(0, maxScopeCount);
  const initialScopeCount = Math.max(
    1,
    Math.min(
      selected.length,
      options.initial_scope_count ?? readPositiveInt("MEMORY_XX_FASTPATH_INITIAL_SCOPE_COUNT", 5)
    )
  );
  const batches: RecallScopeRef[][] = [selected.slice(0, initialScopeCount)];
  for (const scope of selected.slice(initialScopeCount)) {
    batches.push([scope]);
  }
  return batches.filter((batch) => batch.length > 0);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readScope(value: unknown, fallback: RecallScopeRef): RecallScopeRef {
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const raw = value as Record<string, unknown>;
  return {
    type: readString(raw.type) as ScopeType ?? fallback.type,
    id: readString(raw.id) ?? fallback.id
  };
}

function readSourceRetrievers(candidate: FastpathCandidate): string[] {
  const raw = candidate.payload?.source_retrievers;
  if (Array.isArray(raw)) {
    const values = raw.filter((item): item is string => typeof item === "string" && item.trim() !== "");
    if (values.length > 0) {
      const expanded = values.includes("vector") && !values.includes("qdrant")
        ? [...values, "qdrant"]
        : values;
      return [...new Set(expanded)];
    }
  }

  const source = readString(candidate.source) ?? "";
  if (source.includes("hybrid") || source.includes("lexical")) {
    return source.includes("qdrant") || source.includes("vector")
      ? ["vector", "qdrant", "lexical"]
      : ["lexical"];
  }
  return source.includes("qdrant") ? ["vector", "qdrant"] : ["vector"];
}

function toCandidate(candidate: FastpathCandidate, scope: RecallScopeRef): RetrieverCandidate | null {
  const memoryId = readString(candidate.memory_id ?? candidate.payload?.memory_id);
  const content = readString(candidate.content);
  if (!memoryId || !content) {
    return null;
  }

  const resolvedScope = readScope(candidate.scope, scope);
  const sourcePath = readString(candidate.payload?.source_path);
  const sourceType = readString(candidate.payload?.source_type);
  const record: RecallRecord = {
    memory_id: memoryId,
    title: readString(candidate.title),
    content,
    scope_type: resolvedScope.type as ScopeType,
    scope_id: resolvedScope.id,
    source: sourcePath || sourceType ? { path: sourcePath ?? `memory:${memoryId}`, source_type: sourceType } : undefined,
    memory_type: readString(candidate.memory_type),
    lifecycleStatus: (readString(candidate.lifecycle_status ?? candidate.payload?.lifecycle_status) ?? LifecycleStatus.Approved) as LifecycleStatus,
    reviewState: (readString(candidate.review_state ?? candidate.payload?.review_state) ?? ReviewState.NotRequired) as ReviewState,
    isCurrent: readBoolean(candidate.is_current ?? candidate.payload?.is_current) ?? true
  };

  const lexicalScore = readNumber(candidate.payload?.lexical_score);
  const vectorScore = readNumber(candidate.payload?.vector_score);
  const graphScore = readNumber(candidate.payload?.graph_score);
  const score = readNumber(candidate.score) ?? Math.max(lexicalScore ?? 0, vectorScore ?? 0, graphScore ?? 0);
  const sourceRetrievers = readSourceRetrievers(candidate);
  return {
    memory_id: memoryId,
    record,
    score,
    lexical_score: lexicalScore,
    vector_score: vectorScore,
    graph_score: graphScore,
    matched_terms: [],
    why_matched: [`fastpath:${readString(candidate.source) ?? "native"}`],
    source_retrievers: sourceRetrievers
  };
}

function mergeCandidates(candidates: readonly RetrieverCandidate[]): RetrieverCandidate[] {
  const byId = new Map<string, RetrieverCandidate>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.memory_id);
    if (!existing) {
      byId.set(candidate.memory_id, {
        ...candidate,
        matched_terms: [...candidate.matched_terms],
        why_matched: [...candidate.why_matched],
        source_retrievers: [...candidate.source_retrievers]
      });
      continue;
    }
    existing.score = Math.max(existing.score, candidate.score);
    existing.lexical_score = Math.max(existing.lexical_score ?? 0, candidate.lexical_score ?? 0);
    existing.vector_score = Math.max(existing.vector_score ?? 0, candidate.vector_score ?? 0);
    existing.graph_score = Math.max(existing.graph_score ?? 0, candidate.graph_score ?? 0);
    existing.graph_path_score = Math.max(existing.graph_path_score ?? 0, candidate.graph_path_score ?? 0);
    existing.graph_rank_reason = existing.graph_rank_reason ?? candidate.graph_rank_reason;
    existing.graph_entities = [...new Set([...(existing.graph_entities ?? []), ...(candidate.graph_entities ?? [])])];
    existing.graph_relations = [...new Set([...(existing.graph_relations ?? []), ...(candidate.graph_relations ?? [])])];
    existing.graph_evidence_sources = [...new Set([...(existing.graph_evidence_sources ?? []), ...(candidate.graph_evidence_sources ?? [])])];
    existing.graph_path = [...new Set([...(existing.graph_path ?? []), ...(candidate.graph_path ?? [])])];
    existing.graph_entity_evidence = existing.graph_entity_evidence ?? candidate.graph_entity_evidence;
    existing.graph_relation_evidence = existing.graph_relation_evidence ?? candidate.graph_relation_evidence;
    existing.graph_source_evidence = existing.graph_source_evidence ?? candidate.graph_source_evidence;
    existing.graph_path_evidence = existing.graph_path_evidence ?? candidate.graph_path_evidence;
    existing.why_matched = [...new Set([...existing.why_matched, ...candidate.why_matched])];
    existing.source_retrievers = [...new Set([...existing.source_retrievers, ...candidate.source_retrievers])];
  }
  return [...byId.values()].sort((left, right) => right.score - left.score);
}

function hasVectorCandidate(candidates: readonly RetrieverCandidate[]): boolean {
  return candidates.some((candidate) =>
    (candidate.vector_score ?? 0) > 0 ||
    candidate.source_retrievers.includes("vector") ||
    candidate.source_retrievers.includes("qdrant")
  );
}

function hasGraphCandidate(candidates: readonly RetrieverCandidate[]): boolean {
  return candidates.some((candidate) =>
    (candidate.graph_score ?? 0) > 0 ||
    candidate.source_retrievers.includes("graph")
  );
}

async function supplementVectorCandidates(
  candidates: readonly RetrieverCandidate[],
  constraints: QueryConstraints
): Promise<{ candidates: RetrieverCandidate[]; error?: string }> {
  if (hasVectorCandidate(candidates)) {
    return { candidates: [...candidates] };
  }
  if (!runtime?.vector_retriever) {
    return { candidates: [...candidates], error: "node_vector_runtime_unavailable" };
  }
  try {
    const timeoutMs = readCappedPositiveInt(
      "MEMORY_XX_NODE_VECTOR_SUPPLEMENT_TIMEOUT_MS",
      1200,
      "MEMORY_XX_NODE_VECTOR_SUPPLEMENT_TIMEOUT_CAP_MS",
      1500
    );
    const vectorCandidates = await withBudget<RetrieverCandidate[] | null>(
      runtime.vector_retriever.retrieve(constraints),
      timeoutMs,
      null
    );
    if (vectorCandidates === null) {
      return { candidates: [...candidates], error: "node_vector_supplement_timeout" };
    }
    return {
      candidates: mergeCandidates([...candidates, ...vectorCandidates])
    };
  } catch (error) {
    return {
      candidates: [...candidates],
      error: error instanceof Error ? `node_vector_supplement_failed:${error.message}` : "node_vector_supplement_failed"
    };
  }
}

async function supplementGraphCandidates(
  candidates: readonly RetrieverCandidate[],
  constraints: QueryConstraints
): Promise<{ candidates: RetrieverCandidate[]; error?: string }> {
  if (!runtime?.graph_retriever) {
    return hasGraphCandidate(candidates)
      ? { candidates: [...candidates] }
      : { candidates: [...candidates], error: "node_graph_runtime_unavailable" };
  }
  try {
    const timeoutMs = readCappedPositiveInt(
      "MEMORY_XX_NODE_GRAPH_SUPPLEMENT_TIMEOUT_MS",
      800,
      "MEMORY_XX_NODE_GRAPH_SUPPLEMENT_TIMEOUT_CAP_MS",
      1200
    );
    const graphCandidates = await withBudget<RetrieverCandidate[] | null>(
      runtime.graph_retriever.retrieve(constraints),
      timeoutMs,
      null
    );
    if (graphCandidates === null) {
      return { candidates: [...candidates], error: "node_graph_supplement_timeout" };
    }
    return {
      candidates: mergeCandidates([...candidates, ...graphCandidates])
    };
  } catch (error) {
    return {
      candidates: [...candidates],
      error: error instanceof Error ? `node_graph_supplement_failed:${error.message}` : "node_graph_supplement_failed"
    };
  }
}

function fuseFastpathCandidates(
  candidates: readonly RetrieverCandidate[],
  constraints: QueryConstraints
): { candidates: RetrieverCandidate[]; audit: RecallFusionAudit } {
  return fuseRecallCandidatesRrf({
    lexical: candidates.filter((candidate) =>
      (candidate.lexical_score ?? 0) > 0 ||
      candidate.source_retrievers.includes("lexical")
    ),
    vector: candidates.filter((candidate) =>
      (candidate.vector_score ?? 0) > 0 ||
      candidate.source_retrievers.includes("vector") ||
      candidate.source_retrievers.includes("qdrant")
    ),
    graph: candidates.filter((candidate) =>
      (candidate.graph_score ?? 0) > 0 ||
      candidate.source_retrievers.includes("graph")
    ),
    classification: constraints.classification
  });
}

function toResultItem(candidate: RetrieverCandidate) {
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
    lexical_rank: candidate.lexical_rank,
    vector_rank: candidate.vector_rank,
    graph_rank: candidate.graph_rank,
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
    source_retrievers: candidate.source_retrievers,
    source_path: candidate.record.source?.path,
    source_type: candidate.record.source?.source_type,
    matched_terms: candidate.matched_terms
  };
}

async function callFastpathScope(
  scope: RecallScopeRef,
  request: RecallRequest,
  topK: number,
  timeoutMs: number
): Promise<FastpathScopeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${fastpathBaseUrl()}/recall-fast`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.MEMORY_XX_API_TOKEN?.trim()
          ? { authorization: `Bearer ${process.env.MEMORY_XX_API_TOKEN.trim()}` }
          : {})
      },
      body: JSON.stringify({
        query: request.query,
        scopeType: scope.type,
        scopeId: scope.id,
        topK,
        rerank: false
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      return { scope, candidates: [], error: `http_${response.status}` };
    }

    const parsed = await response.json() as FastpathResponse;
    if (parsed.ok !== true) {
      return { scope, candidates: [], error: readString(parsed.error) ?? "fastpath_not_ok" };
    }

    const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    const candidates = rawCandidates
      .map((item) => toCandidate(item as FastpathCandidate, scope))
      .filter((item): item is RetrieverCandidate => item !== null);
    return { scope, candidates };
  } catch (error) {
    return {
      scope,
      candidates: [],
      error: error instanceof Error && error.name === "AbortError" ? "timeout" : "request_failed"
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildFastpathResponse(input: {
  readonly request: RecallRequest;
  readonly classification: ReturnType<typeof classifyQuery>;
  readonly allowedScopeSet: Awaited<ReturnType<typeof resolveAllowedScopeSet>>;
  readonly attemptedScopes: readonly RecallScopeRef[];
  readonly candidates: readonly RetrieverCandidate[];
  readonly returnedCandidates: readonly RetrieverCandidate[];
  readonly rerankOutcome: Awaited<ReturnType<typeof rerankCandidatesWithOptionalModel>>;
  readonly confidenceGate: ReturnType<typeof applyRecallConfidenceGate>;
  readonly filterPlan: ReturnType<typeof buildRecallFilterPlan>;
  readonly metadata: ReturnType<typeof buildMetadataConstraints>;
  readonly fusionAudit: RecallFusionAudit;
  readonly recentApprovedPgFallback: Awaited<ReturnType<typeof fetchRecentApprovedPgFallback>>["audit"];
  readonly errors: readonly string[];
  readonly started: number;
}): RecallResponse {
  const lexicalHits = input.candidates.filter((candidate) => (candidate.lexical_score ?? 0) > 0).length;
  const vectorHits = input.candidates.filter((candidate) => (candidate.vector_score ?? 0) > 0).length;
  const graphHits = input.candidates.filter((candidate) => (candidate.graph_score ?? 0) > 0 || candidate.source_retrievers.includes("graph")).length;
  const degradeReasons = [
    ...input.allowedScopeSet.degrade_reasons,
    ...input.errors.map((error) => `fastpath_scope_${error}`)
  ];
  const latencyMs = Date.now() - input.started;
  const auditRef = `audit:fastpath:${input.request.query.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24) || "query"}`;

  return {
    results: input.returnedCandidates.map(toResultItem),
    filter_mode_applied: input.filterPlan.applied_mode,
    allowed_scope_set: input.allowedScopeSet.allowed_scope_set,
    degraded: degradeReasons.length > 0,
    degrade_reason: degradeReasons.length > 0 ? degradeReasons.join(",") : undefined,
    audit_ref: auditRef,
    audit: {
      audit_ref: auditRef,
      query_type: input.classification.query_type,
      strategy: RetrievalStrategy.Hybrid,
      degraded: degradeReasons.length > 0,
      degrade_reasons: degradeReasons,
      primary_backend: "fastpath",
      fallback_used: false,
      fastpath: {
        attempted: true,
        used: true,
        scopes: [...input.attemptedScopes],
        latency_ms: latencyMs
      },
      rerank: {
        backend: input.rerankOutcome.backend,
        model_attempted: input.rerankOutcome.model_attempted,
        model_used: input.rerankOutcome.model_used,
        reason: input.rerankOutcome.reason,
        latency_ms: input.rerankOutcome.latency_ms
      },
      confidence_gate: input.confidenceGate.audit,
      fusion: input.fusionAudit,
      lexical_status: { name: "lexical", available: true, backend: "rust_lexical_pg" },
      vector_status: {
        name: "vector",
        available: true,
        backend: "qdrant",
        primary_backend: "qdrant"
      },
      lexical_hits: lexicalHits,
      vector_hits: vectorHits,
      graph_hits: graphHits,
      recent_approved_pg_fallback: input.recentApprovedPgFallback,
      merged_hits: input.candidates.length,
      returned_hits: input.returnedCandidates.length
    },
    explain: input.request.explain
      ? {
          classification: input.classification,
          metadata: input.metadata,
          filter: {
            requested_mode: input.filterPlan.requested_mode,
            applied_mode: input.filterPlan.applied_mode,
            predicate_id: input.filterPlan.predicate_id,
            sql_where_clause: input.filterPlan.sql_where_clause
          },
          retrieval: {
            lexical_hits: lexicalHits,
            vector_hits: vectorHits,
            graph_hits: graphHits,
            recent_approved_pg_fallback: input.recentApprovedPgFallback,
            merged_hits: input.candidates.length,
            returned_hits: input.returnedCandidates.length,
            rerank_applied: input.classification.rerank_enabled,
            rerank_backend: input.rerankOutcome.backend,
            rerank_used_model: input.rerankOutcome.model_used,
            rerank_reason: input.rerankOutcome.reason,
            rerank_latency_ms: input.rerankOutcome.latency_ms,
            confidence_gate: input.confidenceGate.audit,
            fusion: input.fusionAudit
          },
          fusion: input.fusionAudit
        }
      : undefined
  };
}

export async function tryExecuteFastpathRecall(request: RecallRequest): Promise<FastpathRecallAttempt> {
  if (!envFlag("MEMORY_XX_RECALL_PRIMARY", "fastpath")) {
    return { attempted: false, used: false, reason: "fastpath_not_primary" };
  }
  if (!isDefaultFilter(request)) {
    return { attempted: false, used: false, reason: "unsupported_filter_mode" };
  }
  if ((request.offset ?? 0) > 0) {
    return { attempted: false, used: false, reason: "unsupported_offset" };
  }
  if ((request.scope_context.memory_ids?.length ?? 0) > 0) {
    return { attempted: false, used: false, reason: "unsupported_exact_memory_ids" };
  }
  if (request.temporal_scope || (request.memory_layers?.length ?? 0) > 0) {
    return { attempted: false, used: false, reason: "unsupported_temporal_scope" };
  }

  const started = Date.now();
  const classification = classifyQuery({
    query: request.query,
    query_type_hint: request.query_type_hint
  });
  const allowedScopeSet = await resolveAllowedScopeSet(request);
  const scopes = allowedScopeSet.allowed_scope_set.filter(supportedScope);
  if (scopes.length === 0) {
    return { attempted: false, used: false, reason: "no_supported_scopes" };
  }

  const limit = Math.max(1, Math.min(50, request.limit ?? classification.top_k));
  const perScopeTopK = Math.max(limit, Math.min(50, readPositiveInt("MEMORY_XX_FASTPATH_SCOPE_TOPK", 10)));
  const timeoutMs = Math.min(
    readRuntimePositiveInt("recall.fastpath.primary_timeout_ms", "MEMORY_XX_FASTPATH_PRIMARY_TIMEOUT_MS", 2500),
    readPositiveInt("MEMORY_XX_FASTPATH_PRIMARY_TIMEOUT_CAP_MS", 3000)
  );
  const stopAtCandidates = Math.max(1, readPositiveInt("MEMORY_XX_FASTPATH_STOP_AT_CANDIDATES", limit));
  const scopeResults: FastpathScopeResult[] = [];
  for (const batch of planFastpathScopeBatches(scopes)) {
    scopeResults.push(
      ...(await Promise.all(
        batch.map((scope) => callFastpathScope(scope, request, perScopeTopK, timeoutMs))
      ))
    );
    if (mergeCandidates(scopeResults.flatMap((result) => result.candidates)).length >= stopAtCandidates) {
      break;
    }
  }
  const candidates = mergeCandidates(scopeResults.flatMap((result) => result.candidates));
  const errors = scopeResults
    .filter((result) => result.error)
    .map((result) => `${result.scope.type}:${result.scope.id}:${result.error}`);
  const attemptedScopes = scopeResults.map((result) => result.scope);

  const filterPlan = buildRecallFilterPlan({
    requested_mode: request.filter_mode ?? DEFAULT_FILTER_MODE,
    allow_privileged_filter_modes: request.debug?.allow_privileged_filter_modes ?? false
  });
  const metadata = buildMetadataConstraints({ query: request.query, classification });
  const queryConstraints: QueryConstraints = {
    normalized_query: request.query.trim().toLowerCase(),
    query_terms: tokenizeRecallQuery(request.query),
    allowed_scope_set: scopes,
    filter_plan: filterPlan,
    metadata,
    classification,
    limit,
    offset: 0,
    force_model_rerank: request.rerank === true || request.hybrid_mode === "model_rerank"
  };
  const recentApprovedPgFallback = await fetchRecentApprovedPgFallback({
    queryable: serverRuntime.writeDatabase
      ? {
          async query(sql, values) {
            const rows = await withWriteTransaction(serverRuntime.writeDatabase!, (tx) =>
              isPostgresTransactionContext(tx) ? tx.query(sql, values ?? []) : []
            );
            return { rows: rows as Record<string, unknown>[] } as any;
          }
        }
      : undefined,
    schema: process.env.MEMORY_XX_DATABASE_SCHEMA,
    constraints: queryConstraints
  }).catch((error) => ({
    candidates: [],
    audit: {
      enabled: process.env.MEMORY_XX_RECENT_APPROVED_PG_FALLBACK !== "false",
      window_ms: Number.parseInt(process.env.MEMORY_XX_RECENT_APPROVED_PG_FALLBACK_WINDOW_MS ?? "30000", 10),
      candidate_cap: Number.parseInt(process.env.MEMORY_XX_RECENT_APPROVED_PG_FALLBACK_LIMIT ?? "20", 10),
      candidate_count: 0,
      reason: error instanceof Error ? `error:${error.message}` : "error"
    }
  }));
  const supplemented = await supplementVectorCandidates(candidates, queryConstraints);
  const graphSupplemented = await supplementGraphCandidates(supplemented.candidates, queryConstraints);
  const effectiveCandidates = mergeCandidates([...graphSupplemented.candidates, ...recentApprovedPgFallback.candidates]);
  if (supplemented.error) {
    errors.push(supplemented.error);
  }
  if (graphSupplemented.error) {
    errors.push(graphSupplemented.error);
  }
  const fused = fuseFastpathCandidates(effectiveCandidates, queryConstraints);
  const shouldFallbackOnEmpty = envFlag("MEMORY_XX_FASTPATH_FALLBACK_ON_EMPTY", "true");
  if (fused.candidates.length === 0 && shouldFallbackOnEmpty) {
    return {
      attempted: true,
      used: false,
      reason: errors.length > 0 ? `fastpath_empty:${errors.join(",")}` : "fastpath_empty",
      latency_ms: Date.now() - started
    };
  }

  const rerankOutcome = await rerankCandidatesWithOptionalModel(fused.candidates, queryConstraints);
  const confidenceGate = applyRecallConfidenceGate(
    rerankOutcome.candidates,
    queryConstraints,
    rerankOutcome
  );
  const returnedCandidates = confidenceGate.candidates.slice(0, limit);
  const latencyMs = Date.now() - started;

  return {
    attempted: true,
    used: true,
    latency_ms: latencyMs,
    response: buildFastpathResponse({
      request,
      classification,
      allowedScopeSet,
      attemptedScopes,
      candidates: fused.candidates,
      returnedCandidates,
      rerankOutcome,
      confidenceGate,
      filterPlan,
      metadata,
      fusionAudit: fused.audit,
      recentApprovedPgFallback: recentApprovedPgFallback.audit,
      errors,
      started
    })
  };
}

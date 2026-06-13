import { RecallError, RecallErrorCode } from "../errors";
import { LifecycleStatus, ReviewState } from "../../shared";
import {
  type BackendStatus,
  type CognitiveType,
  type QueryConstraints,
  type RecallRecord,
  type RetrieverCandidate
} from "../types";
import {
  type QueryEmbeddingProvider,
  type VectorRetriever
} from "./vector-retriever";
import { createLogger } from "../../shared/logger";
import { CircuitBreaker } from "../../shared/circuit-breaker";
import { recordQdrantTimeout } from "../../observability/qdrant-health";

const log = createLogger("qdrant-retriever");

export interface QdrantSearchPoint {
  readonly id: string | number;
  readonly score?: number;
  readonly payload?: Record<string, unknown>;
}

export interface QdrantSearchResponse {
  readonly points?: readonly QdrantSearchPoint[];
  readonly result?: readonly QdrantSearchPoint[];
}

export interface QdrantSearchExecutorInput {
  readonly base_url: string;
  readonly api_key?: string;
  readonly collection_name: string;
  readonly vector: readonly number[];
  readonly limit: number;
  readonly offset: number;
  readonly timeout_ms?: number;
  /** Exact memory IDs to recall — applied as Qdrant must-filter + post-filter. */
  readonly memory_ids?: readonly string[];
}

export type QdrantRecordMapper = (point: QdrantSearchPoint) => RecallRecord | null;
export type QdrantSearchExecutor = (
  input: QdrantSearchExecutorInput
) => Promise<QdrantSearchResponse>;

export interface QdrantVectorRetrieverOptions {
  readonly base_url?: string;
  readonly api_key?: string;
  readonly collection_name?: string;
  readonly query_embedding_provider?: QueryEmbeddingProvider;
  readonly fallback_retriever?: VectorRetriever;
  readonly minimum_score?: number;
  readonly search_executor?: QdrantSearchExecutor;
  readonly record_mapper?: QdrantRecordMapper;
  readonly circuit_breaker?: CircuitBreaker;
  readonly timeout_ms?: number;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function timeoutError(reason: string): Error {
  const error = new Error(reason);
  error.name = "TimeoutError";
  return error;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(reason)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readCognitiveType(value: unknown): CognitiveType | undefined {
  return value === "semantic" || value === "episodic" || value === "procedural" || value === "audit"
    ? value
    : undefined;
}

function defaultRecordMapper(point: QdrantSearchPoint): RecallRecord | null {
  const payload = point.payload ?? {};
  const memoryId = payload.memory_id;
  const content = payload.content;
  const scopeType = payload.scope_type;
  const scopeId = payload.scope_id;

  if (
    typeof memoryId !== "string" ||
    typeof content !== "string" ||
    typeof scopeType !== "string" ||
    typeof scopeId !== "string"
  ) {
    return null;
  }

  return {
    memory_id: memoryId,
    content,
    title: typeof payload.title === "string" ? payload.title : undefined,
    scope_type: scopeType as RecallRecord["scope_type"],
    scope_id: scopeId,
    project_id: typeof payload.project_id === "string" ? payload.project_id : undefined,
    workspace_id:
      typeof payload.workspace_id === "string" ? payload.workspace_id : undefined,
    source:
      typeof payload.source_path === "string"
        ? {
            path: payload.source_path,
            source_type:
              typeof payload.source_type === "string"
                ? payload.source_type
                : undefined
          }
        : undefined,
    section: typeof payload.section === "string" ? payload.section : undefined,
    canonical_section:
      typeof payload.canonical_section === "string"
        ? payload.canonical_section
        : undefined,
    canonical_source_path:
      typeof payload.canonical_source_path === "string"
        ? payload.canonical_source_path
        : undefined,
    category: typeof payload.category === "string" ? payload.category : undefined,
    memory_type:
      typeof payload.memory_type === "string" ? payload.memory_type : undefined,
    cognitive_type: readCognitiveType(payload.cognitive_type),
    memory_layer:
      typeof payload.memory_layer === "string" ? payload.memory_layer : undefined,
    fact_status:
      typeof payload.fact_status === "string" ? payload.fact_status : undefined,
    valid_at:
      typeof payload.valid_at === "string" ? payload.valid_at : undefined,
    invalid_at:
      typeof payload.invalid_at === "string" ? payload.invalid_at : undefined,
    observed_at:
      typeof payload.observed_at === "string" ? payload.observed_at : undefined,
    expires_at:
      typeof payload.expires_at === "string" ? payload.expires_at : undefined,
    episode_id:
      typeof payload.episode_id === "string" ? payload.episode_id : undefined,
    importance:
      typeof payload.importance === "number" ? payload.importance : undefined,
    memory_strength:
      typeof payload.memory_strength === "number" ? payload.memory_strength : undefined,
    decay_policy:
      typeof payload.decay_policy === "string" ? payload.decay_policy : undefined,
    relation_count:
      typeof payload.relation_count === "number" ? payload.relation_count : undefined,
    tags: Array.isArray(payload.tags)
      ? payload.tags.filter((value): value is string => typeof value === "string")
      : undefined,
    entity_names: Array.isArray(payload.entity_names)
      ? payload.entity_names.filter((value): value is string => typeof value === "string")
      : undefined,
    lexical_terms: Array.isArray(payload.lexical_terms)
      ? payload.lexical_terms.filter((value): value is string => typeof value === "string")
      : undefined,
    semantic_terms: Array.isArray(payload.semantic_terms)
      ? payload.semantic_terms.filter((value): value is string => typeof value === "string")
      : undefined,
    created_at:
      typeof payload.created_at === "string" ? payload.created_at : undefined,
    updated_at:
      typeof payload.updated_at === "string" ? payload.updated_at : undefined,
    lifecycleStatus:
      typeof payload.lifecycle_status === "string"
        ? (payload.lifecycle_status as RecallRecord["lifecycleStatus"])
        : LifecycleStatus.Approved,
    reviewState:
      typeof payload.review_state === "string"
        ? (payload.review_state as RecallRecord["reviewState"])
        : ReviewState.Approved,
    recallPolicy: typeof payload.recall_policy === "string" ? payload.recall_policy : undefined,
    isCurrent: typeof payload.is_current === "boolean" ? payload.is_current : true
  };
}

async function defaultSearchExecutor(
  input: QdrantSearchExecutorInput
): Promise<QdrantSearchResponse> {
  const endpoint = `${input.base_url.replace(/\/$/, "")}/collections/${encodeURIComponent(
    input.collection_name
  )}/points/search`;

  /** Build Qdrant filter — wraps in a `must` conditions array when memory_ids present. */
  const filterBody: Record<string, unknown> = {
    vector: input.vector,
    limit: input.limit,
    offset: input.offset,
    with_payload: true,
    with_vector: false
  };

  if (input.memory_ids && input.memory_ids.length > 0) {
    filterBody["filter"] = {
      must: [
        {
          key: "memory_id",
          match: {
            any: input.memory_ids
          }
        }
      ]
    };
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(input.api_key ? { "api-key": input.api_key } : {})
    },
    body: JSON.stringify(filterBody),
    ...(input.timeout_ms ? { signal: AbortSignal.timeout(input.timeout_ms) } : {})
  });

  if (!response.ok) {
    throw new Error(`Qdrant search failed with status ${response.status}`);
  }

  return (await response.json()) as QdrantSearchResponse;
}

function filterByScopes(
  record: RecallRecord,
  allowedScopeSet: readonly { type: string; id: string }[]
): boolean {
  return allowedScopeSet.some(
    (scope) => scope.type === record.scope_type && scope.id === record.scope_id
  );
}

export class QdrantVectorRetriever implements VectorRetriever {
  private readonly baseUrl?: string;
  private readonly apiKey?: string;
  private readonly collectionName?: string;
  private readonly queryEmbeddingProvider?: QueryEmbeddingProvider;
  private readonly fallbackRetriever?: VectorRetriever;
  private readonly minimumScore: number;
  private readonly searchExecutor: QdrantSearchExecutor;
  private readonly recordMapper: QdrantRecordMapper;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly timeoutMs: number;

  constructor(options: QdrantVectorRetrieverOptions) {
    this.baseUrl = options.base_url?.trim() || undefined;
    this.apiKey = options.api_key?.trim() || undefined;
    this.collectionName = options.collection_name?.trim() || undefined;
    this.queryEmbeddingProvider = options.query_embedding_provider;
    this.fallbackRetriever = options.fallback_retriever;
    this.minimumScore = options.minimum_score ?? 0.2;
    this.searchExecutor = options.search_executor ?? defaultSearchExecutor;
    this.recordMapper = options.record_mapper ?? defaultRecordMapper;
    this.circuitBreaker = options.circuit_breaker ?? new CircuitBreaker();
    this.timeoutMs = options.timeout_ms ?? readPositiveInt("MEMORY_XX_QDRANT_QUERY_TIMEOUT_MS", 1200);
  }

  async get_backend_status(): Promise<BackendStatus> {
    const fallbackStatus = this.fallbackRetriever
      ? await this.fallbackRetriever.get_backend_status()
      : undefined;

    if (!this.baseUrl || !this.collectionName) {
      return {
        name: "vector",
        available: fallbackStatus?.available ?? false,
        reason: "qdrant_unconfigured",
        backend: fallbackStatus?.backend ?? "pgvector",
        primary_backend: "qdrant",
        fallback_backend: fallbackStatus?.backend ?? "pgvector",
        fallback_available: fallbackStatus?.available ?? false,
        qdrant_configured: false,
        last_probe_available: false,
        timeout_ms: this.timeoutMs
      };
    }

    if (!this.queryEmbeddingProvider) {
      return {
        name: "vector",
        available: fallbackStatus?.available ?? false,
        reason: "vector_embedding_unavailable",
        backend: fallbackStatus?.available ? fallbackStatus.backend ?? "pgvector" : "qdrant",
        primary_backend: "qdrant",
        fallback_backend: fallbackStatus?.backend ?? "pgvector",
        fallback_available: fallbackStatus?.available ?? false,
        qdrant_configured: true,
        last_probe_available: false,
        timeout_ms: this.timeoutMs
      };
    }

    return {
      name: "vector",
      available: true,
      backend: "qdrant",
      primary_backend: "qdrant",
      fallback_backend: fallbackStatus?.backend ?? "pgvector",
      fallback_available: fallbackStatus?.available ?? false,
      qdrant_configured: true,
      last_probe_available: null,
      timeout_ms: this.timeoutMs
    };
  }

  async retrieve(input: QueryConstraints): Promise<RetrieverCandidate[]> {
    if (!this.baseUrl || !this.collectionName || !this.queryEmbeddingProvider) {
      return this.retrieveFromFallbackOrThrow(input, "qdrant_unconfigured");
    }

    const queryEmbeddingResult = await this.queryEmbeddingProvider.embed_query({
      query: input.normalized_query,
      query_terms: input.query_terms
    });
    const queryEmbedding = queryEmbeddingResult.embedding;

    if (!queryEmbedding || queryEmbedding.length === 0) {
      log.warn("query embedding unavailable, falling back", {
        query: input.normalized_query.substring(0, 80),
        audit: queryEmbeddingResult.audit
      });
      return this.retrieveFromFallbackOrThrow(input, "vector_embedding_unavailable");
    }

    if (!this.circuitBreaker.canExecute()) {
      log.warn("circuit breaker open, falling back", {
        qdrant_state: this.circuitBreaker.currentState,
        failures: this.circuitBreaker.failureCountValue
      });
      return this.retrieveFromFallbackOrThrow(input, "qdrant_circuit_open");
    }

    try {
      // Build optional memory_ids Qdrant filter
      const memoryIds = input.memory_ids;

      const response = await withTimeout(this.searchExecutor({
        base_url: this.baseUrl,
        api_key: this.apiKey,
        collection_name: this.collectionName,
        vector: queryEmbedding,
        limit: input.limit,
        offset: input.offset,
        timeout_ms: this.timeoutMs,
        memory_ids: memoryIds
      }), this.timeoutMs, "qdrant_timeout");
      const points = response.points ?? response.result ?? [];

      const candidates: RetrieverCandidate[] = [];
      for (const point of points) {
        const record = this.recordMapper(point);
        if (!record) {
          continue;
        }
        if (!filterByScopes(record, input.allowed_scope_set)) {
          continue;
        }
        if (!input.filter_plan.evaluate(record)) {
          continue;
        }
        // Post-filter: if memory_ids was requested, enforce exact match
        if (memoryIds && memoryIds.length > 0 && !memoryIds.includes(record.memory_id)) {
          continue;
        }
        const score = Number(point.score) || 0;
        if (score < this.minimumScore) {
          continue;
        }
        candidates.push({
          memory_id: record.memory_id,
          record,
          score,
          vector_score: score,
          matched_terms: input.query_terms.filter((term) =>
            `${record.title ?? ""} ${record.content}`.toLowerCase().includes(term)
          ),
          why_matched: ["qdrant_primary_ann"],
          source_retrievers: ["vector", "qdrant"]
        });
      }

      this.circuitBreaker.recordSuccess();
      return candidates;
    } catch (error) {
      this.circuitBreaker.recordFailure();
      const reason = error instanceof Error && (error.name === "TimeoutError" || error.message === "qdrant_timeout")
        ? "qdrant_timeout"
        : "qdrant_backend_unavailable";
      if (reason === "qdrant_timeout") recordQdrantTimeout("query");
      return this.retrieveFromFallbackOrThrow(input, reason);
    }
  }

  private async retrieveFromFallbackOrThrow(
    input: QueryConstraints,
    reason: string
  ): Promise<RetrieverCandidate[]> {
    if (!this.fallbackRetriever) {
      throw new RecallError(
        RecallErrorCode.BackendUnavailable,
        reason
      );
    }

    const fallback = await this.fallbackRetriever.retrieve(input);
    return fallback.map((candidate) => ({
      ...candidate,
      why_matched: [...candidate.why_matched, `vector_fallback:${reason}`],
      source_retrievers: [...new Set([...candidate.source_retrievers, "pgvector-fallback"])]
    }));
  }
}

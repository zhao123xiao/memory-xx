import { createHash } from "node:crypto";
import { Pool } from "pg";
import { loadMemoryXXPostgresConfig, createPostgresPoolConfig } from "../db/adapters/postgres-config";
import { mapMemoryIdToQdrantPointId } from "../qdrant-sync/projector";
import { ResilientQueryEmbeddingProvider } from "../recall/query-embedding-resilience";
import { QwenEmbeddingProviderWrapper } from "../server/embedding-provider";

export interface KnowledgeSearchRequest {
  readonly query: string;
  readonly limit?: number;
  readonly knowledge_collections?: readonly string[];
  readonly repos?: readonly string[];
}

export interface KnowledgeSearchResult {
  readonly chunk_id: string;
  readonly document_id?: string;
  readonly collection?: string;
  readonly repo?: string;
  readonly source_path?: string;
  readonly source_root?: string;
  readonly chunk_index?: number;
  readonly start_line?: number;
  readonly end_line?: number;
  readonly content: string;
  readonly score: number;
  readonly metadata?: Record<string, unknown>;
  readonly content_hash?: string;
  readonly embedding_hash?: string;
}

export interface KnowledgeSearchResponse {
  readonly ok: boolean;
  readonly collection: string;
  readonly results: readonly KnowledgeSearchResult[];
  readonly degraded?: boolean;
  readonly failure_reason?: string;
  readonly diagnostics?: KnowledgeFallbackDiagnostics;
}

export interface KnowledgeFallbackDiagnostics {
  readonly qdrant?: {
    readonly failure_reason: string;
    readonly latency_ms?: number;
  };
  readonly fallback?: {
    readonly attempted: boolean;
    readonly count: number;
    readonly latency_ms?: number;
    readonly mode: KnowledgePostgresSearchMode;
  };
}

const KNOWLEDGE_COLLECTION = process.env.MEMORY_XX_KNOWLEDGE_QDRANT_COLLECTION?.trim() || "knowledge-v1";
const KNOWLEDGE_SCHEMA = process.env.MEMORY_XX_KNOWLEDGE_SCHEMA?.trim() || "knowledge_v1";
const DEFAULT_LIMIT = 8;
const knowledgeEmbeddingProvider = new ResilientQueryEmbeddingProvider(
  new QwenEmbeddingProviderWrapper(),
  {
    max_retries: 2,
    retry_delay_ms: 300,
    retry_backoff_multiplier: 2,
    cache_ttl_ms: 10 * 60 * 1000,
    allow_stale_on_error: true,
    max_cache_entries: 128
  }
);

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_LIMIT;
  return Math.min(50, Math.max(1, Math.trunc(value!)));
}

function readQdrantBaseUrl(): string {
  const base = process.env.MEMORY_XX_QDRANT_BASE_URL?.trim();
  if (!base) throw new Error("尚未配置 MEMORY_XX_QDRANT_BASE_URL。");
  return base.replace(/\/+$/, "");
}

function readQdrantApiKey(): string | undefined {
  return process.env.MEMORY_XX_QDRANT_API_KEY?.trim() || undefined;
}

function normalizeStringArray(value: readonly string[] | undefined): string[] {
  return Array.isArray(value) ? value.map((item) => item.trim()).filter(Boolean) : [];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readAllowlist(name: string): Set<string> | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const values = raw.split(",").map((item) => item.trim()).filter(Boolean);
  return values.length > 0 ? new Set(values) : null;
}

function validateAllowed(values: readonly string[], allowlist: Set<string> | null): boolean {
  return !allowlist || values.every((value) => allowlist.has(value));
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

export type KnowledgePostgresSearchMode = "phrase" | "phrase_or_terms";

export interface KnowledgePostgresSearchQueryInput {
  readonly query: string;
  readonly limit: number;
  readonly collections: readonly string[];
  readonly repos: readonly string[];
  readonly schema?: string;
  readonly tenantId?: string;
  readonly availableColumns?: ReadonlySet<string>;
}

export interface KnowledgePostgresSearchQueryPlan {
  readonly sql: string;
  readonly params: unknown[];
  readonly mode: KnowledgePostgresSearchMode;
}

export interface KnowledgeFallbackDiagnosticsInput {
  readonly failureReason: string;
  readonly qdrantLatencyMs?: number;
  readonly fallbackLatencyMs?: number;
  readonly fallbackCount: number;
  readonly fallbackMode: KnowledgePostgresSearchMode;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function columnOrNull(columns: ReadonlySet<string> | undefined, column: string, alias = column): string {
  if (!columns || columns.has(column)) return column;
  return `NULL AS ${alias}`;
}

function extractKnowledgeQueryTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms = query
    .normalize("NFKC")
    .match(/[\p{L}\p{N}][\p{L}\p{N}_./:-]{1,}/gu) ?? [];
  for (const raw of terms) {
    const term = raw.toLowerCase();
    if (term.length < 2) continue;
    seen.add(term);
    if (seen.size >= 8) break;
  }
  return [...seen];
}

export function buildKnowledgeFallbackDiagnostics(input: KnowledgeFallbackDiagnosticsInput): KnowledgeFallbackDiagnostics {
  return {
    qdrant: {
      failure_reason: input.failureReason,
      ...(input.qdrantLatencyMs === undefined ? {} : { latency_ms: input.qdrantLatencyMs }),
    },
    fallback: {
      attempted: true,
      count: input.fallbackCount,
      ...(input.fallbackLatencyMs === undefined ? {} : { latency_ms: input.fallbackLatencyMs }),
      mode: input.fallbackMode,
    },
  };
}

export function buildKnowledgePostgresSearchQuery(input: KnowledgePostgresSearchQueryInput): KnowledgePostgresSearchQueryPlan {
  const schema = quoteIdentifier(input.schema?.trim() || KNOWLEDGE_SCHEMA);
  const phrase = `%${escapeLikePattern(input.query.trim())}%`;
  const params: unknown[] = [phrase, input.limit];
  const terms = extractKnowledgeQueryTerms(input.query);
  const termMatchExpressions: string[] = [];
  for (const term of terms) {
    params.push(`%${escapeLikePattern(term)}%`);
    termMatchExpressions.push(`content ILIKE $${params.length} ESCAPE '\\'`);
  }

  const termScore = termMatchExpressions.length > 0
    ? termMatchExpressions.map((expression) => `(CASE WHEN ${expression} THEN 1 ELSE 0 END)`).join(" + ")
    : "0";
  const minTermMatches = Math.min(2, termMatchExpressions.length);
  const clauses: string[] = [];
  const tenantId = input.tenantId?.trim();
  if (tenantId) {
    params.push(tenantId);
    clauses.push(`tenant_id = $${params.length}`);
  }
  if (!input.availableColumns || input.availableColumns.has("visibility")) {
    clauses.push(`visibility IN ('public', 'shared', 'research')`);
  }
  if (input.collections.length > 0) {
    params.push(input.collections);
    clauses.push(`collection = ANY($${params.length}::text[])`);
  }
  if (input.repos.length > 0) {
    params.push(input.repos);
    clauses.push(`repo = ANY($${params.length}::text[])`);
  }

  return {
    mode: termMatchExpressions.length > 0 ? "phrase_or_terms" : "phrase",
    params,
    sql: `
      WITH ranked AS (
        SELECT id, document_id, collection, repo, source_path,
               ${columnOrNull(input.availableColumns, "chunk_index")},
               ${columnOrNull(input.availableColumns, "start_line")},
               ${columnOrNull(input.availableColumns, "end_line")},
               content, metadata,
               ${columnOrNull(input.availableColumns, "content_hash")},
               ${columnOrNull(input.availableColumns, "embedding_hash")},
               updated_at,
               (content ILIKE $1 ESCAPE '\\') AS exact_phrase_match,
               (${termScore}) AS term_match_count
        FROM ${schema}.chunks
        WHERE ${clauses.join(" AND ")}
      )
        SELECT id, document_id, collection, repo, source_path, chunk_index, start_line, end_line,
               content, metadata, content_hash, embedding_hash
        FROM ranked
        WHERE ${termMatchExpressions.length > 0 ? `exact_phrase_match OR term_match_count >= ${minTermMatches}` : "exact_phrase_match"}
        ORDER BY exact_phrase_match DESC, term_match_count DESC, updated_at DESC
        LIMIT $2
      `,
  };
}

async function readKnowledgeChunkColumns(pool: Pool, schema: string): Promise<Set<string>> {
  const result = await pool.query<{ column_name: string }>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'chunks'
    `,
    [schema],
  );
  return new Set(result.rows.map((row) => row.column_name));
}

function qdrantFilter(collections: readonly string[], repos: readonly string[]): Record<string, unknown> | undefined {
  const must: Record<string, unknown>[] = [];
  if (collections.length > 0) {
    must.push({ key: "collection", match: { any: collections } });
  }
  if (repos.length > 0) {
    must.push({ key: "repo", match: { any: repos } });
  }
  return must.length > 0 ? { must } : undefined;
}

function mapPayload(point: any): KnowledgeSearchResult | null {
  const payload = point?.payload ?? {};
  const chunkId = typeof payload.chunk_id === "string" ? payload.chunk_id : undefined;
  const content = typeof payload.content === "string" ? payload.content : undefined;
  if (!chunkId || !content) return null;
  return {
    chunk_id: chunkId,
    document_id: typeof payload.document_id === "string" ? payload.document_id : undefined,
    collection: typeof payload.collection === "string" ? payload.collection : undefined,
    repo: typeof payload.repo === "string" ? payload.repo : undefined,
    source_path: typeof payload.source_path === "string" ? payload.source_path : undefined,
    source_root: typeof payload.source_root === "string" ? payload.source_root : undefined,
    chunk_index: typeof payload.chunk_index === "number" ? payload.chunk_index : undefined,
    start_line: typeof payload.start_line === "number" ? payload.start_line : undefined,
    end_line: typeof payload.end_line === "number" ? payload.end_line : undefined,
    content,
    score: typeof point.score === "number" ? point.score : 0,
    metadata: objectRecord(payload.metadata),
    content_hash: typeof payload.content_hash === "string" ? payload.content_hash : undefined,
    embedding_hash: typeof payload.embedding_hash === "string" ? payload.embedding_hash : undefined
  };
}

export function mapKnowledgeChunkIdToPointId(chunkId: string): string {
  return mapMemoryIdToQdrantPointId(`knowledge_chunk:${chunkId}`);
}

export function buildKnowledgeDocumentId(collection: string, sourcePath: string): string {
  return createHash("sha256").update(`${collection}:${sourcePath}`).digest("hex").slice(0, 32);
}

export async function searchKnowledge(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse> {
  const query = request.query.trim();
  if (!query) {
    return { ok: false, collection: KNOWLEDGE_COLLECTION, results: [], degraded: true, failure_reason: "query_required" };
  }
  const collections = normalizeStringArray(request.knowledge_collections);
  const repos = normalizeStringArray(request.repos);
  if (!validateAllowed(collections, readAllowlist("MEMORY_XX_KNOWLEDGE_ALLOWED_COLLECTIONS"))) {
    return { ok: false, collection: KNOWLEDGE_COLLECTION, results: [], degraded: true, failure_reason: "knowledge_collection_not_allowed" };
  }
  if (!validateAllowed(repos, readAllowlist("MEMORY_XX_KNOWLEDGE_ALLOWED_REPOS"))) {
    return { ok: false, collection: KNOWLEDGE_COLLECTION, results: [], degraded: true, failure_reason: "knowledge_repo_not_allowed" };
  }

  const embedded = await knowledgeEmbeddingProvider.embed_query({ query, query_terms: [] });
  if (!embedded.embedding || embedded.embedding.length === 0) {
    const fallbackStartedAt = Date.now();
    const fallback = await searchKnowledgePostgres(query, clampLimit(request.limit), collections, repos);
    const failureReason = embedded.audit.final_error ?? "embedding_unavailable";
    return {
      ok: fallback.length > 0,
      collection: KNOWLEDGE_COLLECTION,
      results: fallback,
      degraded: true,
      failure_reason: failureReason,
      diagnostics: buildKnowledgeFallbackDiagnostics({
        failureReason,
        fallbackCount: fallback.length,
        fallbackLatencyMs: Date.now() - fallbackStartedAt,
        fallbackMode: fallback.mode,
      })
    };
  }

  const body: Record<string, unknown> = {
    vector: embedded.embedding,
    limit: clampLimit(request.limit),
    with_payload: true,
    with_vector: false
  };
  const filter = qdrantFilter(collections, repos);
  if (filter) body.filter = filter;

  const timeoutMs = Number.parseInt(process.env.MEMORY_XX_KNOWLEDGE_QDRANT_TIMEOUT_MS ?? "800", 10);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 800);
  let response: Response;
  const qdrantStartedAt = Date.now();
  try {
    response = await fetch(`${readQdrantBaseUrl()}/collections/${encodeURIComponent(KNOWLEDGE_COLLECTION)}/points/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(readQdrantApiKey() ? { "api-key": readQdrantApiKey()! } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    const qdrantLatencyMs = Date.now() - qdrantStartedAt;
    const fallbackStartedAt = Date.now();
    const fallback = await searchKnowledgePostgres(query, clampLimit(request.limit), collections, repos);
    const failureReason = error instanceof Error && error.name === "AbortError" ? "qdrant_timeout" : "qdrant_unavailable";
    return {
      ok: fallback.length > 0,
      collection: KNOWLEDGE_COLLECTION,
      results: fallback,
      degraded: true,
      failure_reason: failureReason,
      diagnostics: buildKnowledgeFallbackDiagnostics({
        failureReason,
        qdrantLatencyMs,
        fallbackCount: fallback.length,
        fallbackLatencyMs: Date.now() - fallbackStartedAt,
        fallbackMode: fallback.mode,
      })
    };
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const qdrantLatencyMs = Date.now() - qdrantStartedAt;
    const fallbackStartedAt = Date.now();
    const fallback = await searchKnowledgePostgres(query, clampLimit(request.limit), collections, repos);
    const failureReason = `qdrant_${response.status}`;
    return {
      ok: fallback.length > 0,
      collection: KNOWLEDGE_COLLECTION,
      results: fallback,
      degraded: true,
      failure_reason: failureReason,
      diagnostics: buildKnowledgeFallbackDiagnostics({
        failureReason,
        qdrantLatencyMs,
        fallbackCount: fallback.length,
        fallbackLatencyMs: Date.now() - fallbackStartedAt,
        fallbackMode: fallback.mode,
      })
    };
  }

  const data = await response.json() as { result?: unknown; points?: unknown };
  const points = Array.isArray(data.result) ? data.result : Array.isArray(data.points) ? data.points : [];
  const results = points.map(mapPayload).filter((item): item is KnowledgeSearchResult => item !== null);
  if (results.length === 0) {
    const fallbackStartedAt = Date.now();
    const fallback = await searchKnowledgePostgres(query, clampLimit(request.limit), collections, repos);
    if (fallback.length > 0) {
      return {
        ok: true,
        collection: KNOWLEDGE_COLLECTION,
        results: fallback,
        degraded: true,
        failure_reason: "qdrant_empty",
        diagnostics: buildKnowledgeFallbackDiagnostics({
          failureReason: "qdrant_empty",
          qdrantLatencyMs: Date.now() - qdrantStartedAt,
          fallbackCount: fallback.length,
          fallbackLatencyMs: Date.now() - fallbackStartedAt,
          fallbackMode: fallback.mode,
        }),
      };
    }
  }
  return {
    ok: true,
    collection: KNOWLEDGE_COLLECTION,
    results
  };
}

async function searchKnowledgePostgres(
  query: string,
  limit: number,
  collections: readonly string[],
  repos: readonly string[]
): Promise<KnowledgeSearchResult[] & { mode: KnowledgePostgresSearchMode }> {
  type KnowledgeChunkSearchRow = {
    id: unknown;
    document_id: unknown;
    collection: unknown;
    repo: unknown;
    source_path: unknown;
    chunk_index: unknown;
    start_line: unknown;
    end_line: unknown;
    content: unknown;
    metadata: unknown;
    content_hash: unknown;
    embedding_hash: unknown;
  };
  const config = loadMemoryXXPostgresConfig();
  const pool = new Pool(createPostgresPoolConfig(config));
  let mode: KnowledgePostgresSearchMode = "phrase";
  try {
    const schemaName = process.env.MEMORY_XX_KNOWLEDGE_SCHEMA?.trim() || KNOWLEDGE_SCHEMA;
    const availableColumns = await readKnowledgeChunkColumns(pool, schemaName);
    const plan = buildKnowledgePostgresSearchQuery({
      query,
      limit,
      collections,
      repos,
      schema: schemaName,
      tenantId: process.env.MEMORY_XX_KNOWLEDGE_TENANT_ID?.trim(),
      availableColumns,
    });
    mode = plan.mode;
    const rows = (await pool.query<KnowledgeChunkSearchRow>(plan.sql, plan.params)).rows.map((row) => ({
      chunk_id: String(row.id),
      document_id: String(row.document_id),
      collection: String(row.collection),
      repo: String(row.repo),
      source_path: String(row.source_path),
      chunk_index: row.chunk_index === null ? undefined : Number(row.chunk_index),
      start_line: row.start_line === null ? undefined : Number(row.start_line),
      end_line: row.end_line === null ? undefined : Number(row.end_line),
      content: String(row.content),
      score: 0.1,
      metadata: objectRecord(row.metadata),
      content_hash: row.content_hash === null ? undefined : String(row.content_hash),
      embedding_hash: row.embedding_hash === null ? undefined : String(row.embedding_hash)
    }));
    return Object.assign(rows, { mode });
  } catch {
    return Object.assign([], { mode });
  } finally {
    await pool.end();
  }
}

export async function getKnowledgeStatus(): Promise<Record<string, unknown>> {
  const config = loadMemoryXXPostgresConfig();
  const pool = new Pool(createPostgresPoolConfig(config));
  try {
    const chunks = await pool.query(`
      SELECT
        collection,
        count(*)::int AS chunks,
        count(*) FILTER (WHERE content_hash IS NOT NULL)::int AS chunks_with_content_hash,
        count(*) FILTER (WHERE embedding_hash IS NOT NULL)::int AS chunks_with_embedding_hash,
        count(*) FILTER (WHERE qdrant_point_id IS NOT NULL AND qdrant_point_id <> '')::int AS chunks_with_qdrant_point_id
      FROM ${quoteIdentifier(KNOWLEDGE_SCHEMA)}.chunks
      GROUP BY collection
      ORDER BY collection
    `);
    return {
      ok: true,
      schema: KNOWLEDGE_SCHEMA,
      qdrant_collection: KNOWLEDGE_COLLECTION,
      collections: chunks.rows
    };
  } catch (error) {
    return {
      ok: false,
      schema: KNOWLEDGE_SCHEMA,
      qdrant_collection: KNOWLEDGE_COLLECTION,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await pool.end();
  }
}

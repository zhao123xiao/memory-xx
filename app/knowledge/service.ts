import { createHash } from "node:crypto";
import { Pool } from "pg";
import { loadMemoryXXPostgresConfig, createPostgresPoolConfig } from "../db/adapters/postgres-config";
import { mapMemoryIdToQdrantPointId } from "../qdrant-sync/projector";
import { ResilientQueryEmbeddingProvider } from "../recall/query-embedding-resilience";
import { OpenAICompatibleEmbeddingProvider } from "../server/embedding-provider";

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
}

const KNOWLEDGE_COLLECTION = process.env.MEMORY_XX_KNOWLEDGE_QDRANT_COLLECTION?.trim() || "knowledge-v1";
const KNOWLEDGE_SCHEMA = process.env.MEMORY_XX_KNOWLEDGE_SCHEMA?.trim() || "knowledge_v1";
const DEFAULT_LIMIT = 8;
const knowledgeEmbeddingProvider = new ResilientQueryEmbeddingProvider(
  new OpenAICompatibleEmbeddingProvider(),
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
    metadata: payload.metadata && typeof payload.metadata === "object" ? payload.metadata : undefined,
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
    const fallback = await searchKnowledgePostgres(query, clampLimit(request.limit), collections, repos);
    return {
      ok: fallback.length > 0,
      collection: KNOWLEDGE_COLLECTION,
      results: fallback,
      degraded: true,
      failure_reason: embedded.audit.final_error ?? "embedding_unavailable"
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
    const fallback = await searchKnowledgePostgres(query, clampLimit(request.limit), collections, repos);
    return {
      ok: fallback.length > 0,
      collection: KNOWLEDGE_COLLECTION,
      results: fallback,
      degraded: true,
      failure_reason: error instanceof Error && error.name === "AbortError" ? "qdrant_timeout" : "qdrant_unavailable"
    };
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const fallback = await searchKnowledgePostgres(query, clampLimit(request.limit), collections, repos);
    return { ok: fallback.length > 0, collection: KNOWLEDGE_COLLECTION, results: fallback, degraded: true, failure_reason: `qdrant_${response.status}` };
  }

  const data = await response.json() as { result?: unknown; points?: unknown };
  const points = Array.isArray(data.result) ? data.result : Array.isArray(data.points) ? data.points : [];
  return {
    ok: true,
    collection: KNOWLEDGE_COLLECTION,
    results: points.map(mapPayload).filter((item): item is KnowledgeSearchResult => item !== null)
  };
}

async function searchKnowledgePostgres(
  query: string,
  limit: number,
  collections: readonly string[],
  repos: readonly string[]
): Promise<KnowledgeSearchResult[]> {
  const config = loadMemoryXXPostgresConfig();
  const pool = new Pool(createPostgresPoolConfig(config));
  try {
    const params: unknown[] = [`%${query}%`, limit];
    const clauses = ["content ILIKE $1"];
    const tenantId = process.env.MEMORY_XX_KNOWLEDGE_TENANT_ID?.trim();
    if (tenantId) {
      params.push(tenantId);
      clauses.push(`tenant_id = $${params.length}`);
    }
    clauses.push(`visibility IN ('public', 'shared', 'research')`);
    if (collections.length > 0) {
      params.push(collections);
      clauses.push(`collection = ANY($${params.length}::text[])`);
    }
    if (repos.length > 0) {
      params.push(repos);
      clauses.push(`repo = ANY($${params.length}::text[])`);
    }
    const schema = quoteIdentifier(KNOWLEDGE_SCHEMA);
    const result = await pool.query(
      `
        SELECT id, document_id, collection, repo, source_path, chunk_index, start_line, end_line,
               content, metadata, content_hash, embedding_hash
        FROM ${schema}.chunks
        WHERE ${clauses.join(" AND ")}
        ORDER BY updated_at DESC
        LIMIT $2
      `,
      params
    );
    return result.rows.map((row) => ({
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
      metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : undefined,
      content_hash: row.content_hash === null ? undefined : String(row.content_hash),
      embedding_hash: row.embedding_hash === null ? undefined : String(row.embedding_hash)
    }));
  } catch {
    return [];
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

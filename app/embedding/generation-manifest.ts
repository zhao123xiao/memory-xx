import { createHash } from "node:crypto";
import { Pool } from "pg";

import {
  createPostgresPoolConfig,
  loadMemoryXXPostgresConfig,
  type MemoryXXPostgresConfig,
} from "../db/adapters/postgres-config";
import { readPgBoolean } from "../db/row-value-readers";
import { loadMemoryXXQdrantConfig } from "../recall/qdrant-config";
import { loadMemoryRedisConfig } from "../cache";
import { EFFECTIVE_RECALLABLE_SQL_WHERE_CLAUSE } from "../shared/predicates";

export type EmbeddingGenerationStatus =
  | "prepared"
  | "generated"
  | "validated"
  | "active"
  | "retired"
  | "failed";

export interface EmbeddingGenerationManifest {
  readonly generation_id: string;
  readonly provider: string;
  readonly model: string;
  readonly precision: string;
  readonly dims: number;
  readonly embedding_base_hash: string | null;
  readonly text_strategy: string;
  readonly source_collection: string | null;
  readonly target_collection: string;
  readonly qdrant_alias: string;
  readonly redis_prefix: string;
  readonly query_cache_version: string;
  readonly record_count: number;
  readonly point_count: number;
  readonly payload_sample_verified: boolean;
  readonly status: EmbeddingGenerationStatus;
  readonly metadata: Record<string, unknown>;
  readonly created_at: string;
  readonly updated_at: string;
  readonly activated_at: string | null;
  readonly retired_at: string | null;
  readonly failed_at: string | null;
}

export interface EmbeddingGenerationHealth {
  readonly configured: boolean;
  readonly ok: boolean;
  readonly status: "ok" | "degraded";
  readonly active_generation: EmbeddingGenerationManifest | null;
  readonly qdrant_alias: {
    readonly configured: string | null;
    readonly target_collection: string | null;
    readonly target_matches_manifest: boolean | null;
  };
  readonly manifest_match: {
    readonly collection: boolean | null;
    readonly redis_prefix: boolean | null;
    readonly query_cache_version: boolean | null;
    readonly embedding_generation_env: boolean | null;
  };
  readonly qdrant_collection: {
    readonly status?: string;
    readonly points_count?: number;
    readonly indexed_vectors_count?: number;
    readonly vector_size?: number;
    readonly error?: string;
  };
  readonly manifest_count_stale?: boolean;
  readonly postgres_effective_recallable_count?: number;
  readonly qdrant_point_count?: number;
  readonly last_reconciled_at?: string;
  readonly payload_sample: {
    readonly checked: number;
    readonly mismatches: number;
    readonly verified: boolean;
    readonly expected_generation: string | null;
  };
  readonly errors: readonly string[];
}

interface QdrantAliasRow {
  readonly alias_name?: string;
  readonly collection_name?: string;
}

interface QdrantCollectionInfo {
  readonly status: string;
  readonly points_count: number;
  readonly indexed_vectors_count: number;
  readonly vector_size: number;
}

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`Unsafe identifier: ${value}`);
  return `"${value}"`;
}

function withTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

export function hashEmbeddingBase(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return createHash("sha256").update(trimmed).digest("hex").slice(0, 24);
}

export function defaultEmbeddingGenerationId(env: NodeJS.ProcessEnv = process.env): string {
  return env.MEMORY_XX_EMBEDDING_GENERATION_ID?.trim() || "local-qwen8b-int4-v1";
}

export function defaultEmbeddingTextStrategy(env: NodeJS.ProcessEnv = process.env): string {
  return env.MEMORY_XX_EMBEDDING_TEXT_STRATEGY?.trim() || "title_summary_scope_type_layer_content_v1";
}

export function defaultQueryCacheVersion(generationId: string): string {
  return `query-embedding-v3-${generationId}`;
}

function normalizeManifest(row: Record<string, unknown>): EmbeddingGenerationManifest {
  return {
    generation_id: String(row.generation_id),
    provider: String(row.provider),
    model: String(row.model),
    precision: String(row.precision),
    dims: Number(row.dims),
    embedding_base_hash: row.embedding_base_hash == null ? null : String(row.embedding_base_hash),
    text_strategy: String(row.text_strategy),
    source_collection: row.source_collection == null ? null : String(row.source_collection),
    target_collection: String(row.target_collection),
    qdrant_alias: String(row.qdrant_alias),
    redis_prefix: String(row.redis_prefix),
    query_cache_version: String(row.query_cache_version),
    record_count: Number(row.record_count ?? 0),
    point_count: Number(row.point_count ?? 0),
    payload_sample_verified: readPgBoolean(row.payload_sample_verified, "memory_embedding_generations.payload_sample_verified"),
    status: String(row.status) as EmbeddingGenerationStatus,
    metadata: row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : {},
    created_at: new Date(String(row.created_at)).toISOString(),
    updated_at: new Date(String(row.updated_at)).toISOString(),
    activated_at: row.activated_at == null ? null : new Date(String(row.activated_at)).toISOString(),
    retired_at: row.retired_at == null ? null : new Date(String(row.retired_at)).toISOString(),
    failed_at: row.failed_at == null ? null : new Date(String(row.failed_at)).toISOString(),
  };
}

export async function getActiveEmbeddingGeneration(
  pool: Pool,
  config: MemoryXXPostgresConfig = loadMemoryXXPostgresConfig()
): Promise<EmbeddingGenerationManifest | null> {
  const schema = quoteIdent(config.schema);
  const result = await pool.query(`SELECT * FROM ${schema}.memory_embedding_generations WHERE status = 'active' ORDER BY activated_at DESC NULLS LAST, updated_at DESC LIMIT 1`);
  return result.rows[0] ? normalizeManifest(result.rows[0]) : null;
}

export async function getEmbeddingGenerationById(
  pool: Pool,
  generationId: string,
  config: MemoryXXPostgresConfig = loadMemoryXXPostgresConfig()
): Promise<EmbeddingGenerationManifest | null> {
  const schema = quoteIdent(config.schema);
  const result = await pool.query(`SELECT * FROM ${schema}.memory_embedding_generations WHERE generation_id = $1 LIMIT 1`, [generationId]);
  return result.rows[0] ? normalizeManifest(result.rows[0]) : null;
}

async function activeApprovedCount(
  pool: Pool,
  config: MemoryXXPostgresConfig
): Promise<number> {
  const schema = quoteIdent(config.schema);
  const result = await pool.query(`
    SELECT count(*)::int AS cnt
    FROM ${schema}.memory_records
    WHERE ${EFFECTIVE_RECALLABLE_SQL_WHERE_CLAUSE}
  `);
  return Number(result.rows[0]?.cnt ?? 0);
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: init?.signal ?? withTimeout(5000),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as unknown : null;
  if (!response.ok) throw new Error(`${response.status}:${text.slice(0, 300)}`);
  return body;
}

function qdrantHeaders(apiKey?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(apiKey ? { "api-key": apiKey } : {}),
  };
}

export async function getQdrantAliasTarget(input: {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly aliasName?: string;
}): Promise<string | null> {
  if (!input.baseUrl || !input.aliasName) return null;
  const body = await fetchJson(`${input.baseUrl.replace(/\/+$/, "")}/aliases`, {
    headers: qdrantHeaders(input.apiKey),
  }) as { result?: { aliases?: QdrantAliasRow[] } };
  const aliases = body.result?.aliases ?? [];
  return aliases.find((item) => item.alias_name === input.aliasName)?.collection_name ?? null;
}

export async function getQdrantCollectionInfo(input: {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly collectionName?: string;
}): Promise<QdrantCollectionInfo> {
  if (!input.baseUrl || !input.collectionName) throw new Error("qdrant_not_configured");
  const body = await fetchJson(`${input.baseUrl.replace(/\/+$/, "")}/collections/${encodeURIComponent(input.collectionName)}`, {
    headers: qdrantHeaders(input.apiKey),
  }) as { result?: any };
  return {
    status: String(body.result?.status ?? "unknown"),
    points_count: Number(body.result?.points_count ?? 0),
    indexed_vectors_count: Number(body.result?.indexed_vectors_count ?? 0),
    vector_size: Number(body.result?.config?.params?.vectors?.size ?? 0),
  };
}

export async function verifyQdrantPayloadGeneration(input: {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly collectionName?: string;
  readonly generationId: string;
  readonly limit?: number;
  readonly full?: boolean;
}): Promise<{ checked: number; mismatches: number; verified: boolean; full?: boolean }> {
  if (!input.baseUrl || !input.collectionName) return { checked: 0, mismatches: 0, verified: false };
  let checked = 0;
  let mismatches = 0;
  let offset: unknown = undefined;
  const pageLimit = input.full ? 256 : input.limit ?? 10;
  do {
    const body = await fetchJson(`${input.baseUrl.replace(/\/+$/, "")}/collections/${encodeURIComponent(input.collectionName)}/points/scroll`, {
      method: "POST",
      headers: qdrantHeaders(input.apiKey),
      body: JSON.stringify({
        limit: pageLimit,
        with_payload: true,
        with_vector: false,
        ...(offset !== undefined && offset !== null ? { offset } : {})
      }),
    }) as { result?: { points?: Array<{ payload?: Record<string, unknown> }>; next_page_offset?: unknown } };
    const points = body.result?.points ?? [];
    checked += points.length;
    mismatches += points.filter((point) => point.payload?.embedding_generation !== input.generationId).length;
    offset = input.full ? body.result?.next_page_offset : null;
    if (points.length === 0) offset = null;
  } while (input.full && offset !== null && offset !== undefined);
  return {
    checked,
    mismatches,
    verified: checked > 0 && mismatches === 0,
    ...(input.full ? { full: true } : {})
  };
}

export async function inspectEmbeddingGenerationHealth(
  env: NodeJS.ProcessEnv = process.env
): Promise<EmbeddingGenerationHealth> {
  const pgConfig = loadMemoryXXPostgresConfig(env);
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  const qdrantConfig = loadMemoryXXQdrantConfig(env);
  const redisConfig = loadMemoryRedisConfig(env);
  const errors: string[] = [];
  try {
    let active: EmbeddingGenerationManifest | null = null;
    try {
      active = await getActiveEmbeddingGeneration(pool, pgConfig);
    } catch (error) {
      errors.push(`manifest:${error instanceof Error ? error.message : String(error)}`);
    }

    let aliasTarget: string | null = null;
    try {
      aliasTarget = await getQdrantAliasTarget({
        baseUrl: qdrantConfig.base_url,
        apiKey: qdrantConfig.api_key,
        aliasName: qdrantConfig.collection_name,
      });
    } catch (error) {
      errors.push(`qdrant_alias:${error instanceof Error ? error.message : String(error)}`);
    }

    const collectionToInspect = aliasTarget ?? qdrantConfig.collection_name;
    let collectionInfo: EmbeddingGenerationHealth["qdrant_collection"] = {};
    try {
      const info = await getQdrantCollectionInfo({
        baseUrl: qdrantConfig.base_url,
        apiKey: qdrantConfig.api_key,
        collectionName: collectionToInspect,
      });
      collectionInfo = {
        status: info.status,
        points_count: info.points_count,
        indexed_vectors_count: info.indexed_vectors_count,
        vector_size: info.vector_size,
      };
    } catch (error) {
      collectionInfo = { error: error instanceof Error ? error.message : String(error) };
      errors.push(`qdrant_collection:${collectionInfo.error}`);
    }

    let payloadSample = {
      checked: 0,
      mismatches: 0,
      verified: false,
      expected_generation: active?.generation_id ?? null,
    };
    if (active) {
      try {
        payloadSample = {
          ...(await verifyQdrantPayloadGeneration({
            baseUrl: qdrantConfig.base_url,
            apiKey: qdrantConfig.api_key,
            collectionName: qdrantConfig.collection_name,
            generationId: active.generation_id,
            limit: 10,
          })),
          expected_generation: active.generation_id,
        };
      } catch (error) {
        errors.push(`payload_sample:${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const collectionMatch = active
      ? qdrantConfig.collection_name === active.qdrant_alias || qdrantConfig.collection_name === active.target_collection
      : null;
    const redisMatch = active ? redisConfig.prefix === active.redis_prefix : null;
    const cacheVersion = env.MEMORY_XX_QUERY_EMBEDDING_CACHE_VERSION?.trim() || "";
    const cacheMatch = active ? cacheVersion === active.query_cache_version : null;
    const generationEnv = env.MEMORY_XX_EMBEDDING_GENERATION_ID?.trim() || "";
    const generationEnvMatch = active ? generationEnv === active.generation_id : null;
    const aliasTargetMatch = active ? aliasTarget === active.target_collection : null;

    const postgresEffectiveRecallableCount = active
      ? await activeApprovedCount(pool, pgConfig).catch((error) => {
          errors.push(`postgres_effective_count:${error instanceof Error ? error.message : String(error)}`);
          return null;
        })
      : null;
    const qdrantPointCount = typeof collectionInfo.points_count === "number"
      ? collectionInfo.points_count
      : null;
    const countMatchesReality = postgresEffectiveRecallableCount !== null &&
      qdrantPointCount !== null &&
      postgresEffectiveRecallableCount === qdrantPointCount;
    const manifestCountStale = Boolean(
      active &&
      countMatchesReality &&
      (active.record_count !== postgresEffectiveRecallableCount || active.point_count !== qdrantPointCount)
    );

    const ok = Boolean(
      active &&
      collectionMatch &&
      redisMatch &&
      cacheMatch &&
      generationEnvMatch &&
      (aliasTarget === null || aliasTargetMatch) &&
      collectionInfo.status === "green" &&
      collectionInfo.vector_size === active.dims &&
      countMatchesReality &&
      payloadSample.verified
    );

    return {
      configured: Boolean(active),
      ok,
      status: ok ? "ok" : "degraded",
      active_generation: active,
      qdrant_alias: {
        configured: qdrantConfig.collection_name ?? null,
        target_collection: aliasTarget,
        target_matches_manifest: aliasTargetMatch,
      },
      manifest_match: {
        collection: collectionMatch,
        redis_prefix: redisMatch,
        query_cache_version: cacheMatch,
        embedding_generation_env: generationEnvMatch,
      },
      qdrant_collection: collectionInfo,
      manifest_count_stale: manifestCountStale,
      postgres_effective_recallable_count: postgresEffectiveRecallableCount ?? undefined,
      qdrant_point_count: qdrantPointCount ?? undefined,
      last_reconciled_at: new Date().toISOString(),
      payload_sample: payloadSample,
      errors,
    };
  } finally {
    await pool.end();
  }
}

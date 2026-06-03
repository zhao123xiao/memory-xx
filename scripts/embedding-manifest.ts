import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import "./test-harness/config";
import {
  createPostgresPoolConfig,
  loadMemoryV2PostgresConfig,
} from "../app/db/adapters/postgres-config";
import {
  defaultEmbeddingGenerationId,
  defaultEmbeddingTextStrategy,
  defaultQueryCacheVersion,
  getActiveEmbeddingGeneration,
  getEmbeddingGenerationById,
  getQdrantAliasTarget,
  getQdrantCollectionInfo,
  hashEmbeddingBase,
  verifyQdrantPayloadGeneration,
  type EmbeddingGenerationManifest,
} from "../app/embedding";
import { loadMemoryV2QdrantConfig } from "../app/recall/qdrant-config";
import { loadMemoryRedisConfig } from "../app/cache";
import {
  markEmbeddingManifestDirty,
  markEmbeddingManifestRefreshed,
  readEmbeddingManifestDirtyState
} from "../app/embedding/manifest-refresh";
import { EFFECTIVE_RECALLABLE_SQL_WHERE_CLAUSE } from "../app/shared/predicates";

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const index = process.argv.findIndex((arg) => arg === name || arg.startsWith(prefix));
  if (index < 0) return undefined;
  const found = process.argv[index]!;
  if (found === name) {
    const next = process.argv[index + 1];
    return next && next !== "--" && !next.startsWith("--") ? next : "true";
  }
  return found.slice(prefix.length);
}

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`不安全的标识符：${value}`);
  return `"${value}"`;
}

function qdrantHeaders(apiKey?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(apiKey ? { "api-key": apiKey } : {}),
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status}:${text.slice(0, 500)}`);
  return body;
}

async function fetchJsonSoft(url: string, init?: RequestInit): Promise<{ ok: boolean; status?: number; body?: any; error?: string; latency_ms: number }> {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(Number.parseInt(process.env.MEMORY_V2_OBSERVE_TIMEOUT_MS || "10000", 10)),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    return { ok: response.ok, status: response.status, body, latency_ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), latency_ms: Date.now() - started };
  }
}

async function activeApprovedCount(pool: Pool, schema: string): Promise<number> {
  const result = await pool.query(`
    SELECT count(*)::int AS cnt
    FROM ${quoteIdent(schema)}.memory_records
    WHERE ${EFFECTIVE_RECALLABLE_SQL_WHERE_CLAUSE}
  `);
  return Number(result.rows[0]?.cnt ?? 0);
}

async function directReconcileManifestCounts(
  pool: Pool,
  manifest: EmbeddingGenerationManifest
): Promise<Record<string, unknown>> {
  const pgConfig = loadMemoryV2PostgresConfig();
  const qdrantConfig = loadMemoryV2QdrantConfig();
  const recordCount = await activeApprovedCount(pool, pgConfig.schema);
  const collectionInfo = await getQdrantCollectionInfo({
    baseUrl: qdrantConfig.base_url,
    apiKey: qdrantConfig.api_key,
    collectionName: manifest.target_collection,
  });
  const payloadSample = await verifyQdrantPayloadGeneration({
    baseUrl: qdrantConfig.base_url,
    apiKey: qdrantConfig.api_key,
    collectionName: manifest.target_collection,
    generationId: manifest.generation_id,
    limit: 25,
  });
  const aliasTarget = await getQdrantAliasTarget({
    baseUrl: qdrantConfig.base_url,
    apiKey: qdrantConfig.api_key,
    aliasName: manifest.qdrant_alias,
  }).catch(() => null);
  const blockers = [
    ...(collectionInfo.status !== "green" ? ["collection_not_green"] : []),
    ...(collectionInfo.vector_size !== manifest.dims ? ["dimension_mismatch"] : []),
    ...(collectionInfo.points_count !== recordCount ? ["point_count_mismatch"] : []),
    ...(!payloadSample.verified ? ["payload_generation_mismatch"] : []),
    ...(aliasTarget !== null && aliasTarget !== manifest.target_collection ? ["alias_target_mismatch"] : []),
  ];
  const reconciledAt = new Date().toISOString();
  const checks = {
    record_count: recordCount,
    collection: collectionInfo,
    payload_sample: payloadSample,
    alias_target: aliasTarget,
    manifest_count_stale: manifest.record_count !== recordCount || manifest.point_count !== collectionInfo.points_count,
    postgres_effective_recallable_count: recordCount,
    qdrant_point_count: collectionInfo.points_count,
    last_reconciled_at: reconciledAt,
  };
  await pool.query(`
    UPDATE ${quoteIdent(pgConfig.schema)}.memory_embedding_generations
    SET record_count = $2,
        point_count = $3,
        payload_sample_verified = $4,
        metadata = metadata || $5::jsonb,
        updated_at = now()
    WHERE generation_id = $1
  `, [
    manifest.generation_id,
    recordCount,
    collectionInfo.points_count,
    payloadSample.verified,
    JSON.stringify({
      last_reconcile: {
        at: reconciledAt,
        ok: blockers.length === 0,
        blockers,
        checks,
      },
    }),
  ]);
  return {
    ok: blockers.length === 0,
    blockers,
    checks,
  };
}

async function upsertPreparedManifest(pool: Pool): Promise<EmbeddingGenerationManifest> {
  const pgConfig = loadMemoryV2PostgresConfig();
  const qdrantConfig = loadMemoryV2QdrantConfig();
  const redisConfig = loadMemoryRedisConfig();
  const generationId = argValue("--generation-id") || defaultEmbeddingGenerationId();
  const targetCollection = argValue("--target-collection") || process.env.MEMORY_V2_LOCAL_EMBEDDING_COLLECTION || qdrantConfig.collection_name || "memory-xx-local-qwen8b-int4-v1";
  const qdrantAlias = argValue("--alias") || process.env.MEMORY_V2_QDRANT_ALIAS || "memory-xx-active";
  const redisPrefix = argValue("--redis-prefix") || process.env.MEMORY_V2_REDIS_PREFIX || redisConfig.prefix;
  const queryCacheVersion = argValue("--query-cache-version") || process.env.MEMORY_V2_QUERY_EMBEDDING_CACHE_VERSION || defaultQueryCacheVersion(generationId);
  const embeddingBase = process.env.EMBEDDING_API_BASE?.trim() || process.env.EMBEDDING_PROXY_URL?.trim() || "";
  const recordCount = await activeApprovedCount(pool, pgConfig.schema);

  const result = await pool.query(`
    INSERT INTO ${quoteIdent(pgConfig.schema)}.memory_embedding_generations (
      generation_id, provider, model, precision, dims, embedding_base_hash, text_strategy,
      source_collection, target_collection, qdrant_alias, redis_prefix, query_cache_version,
      record_count, point_count, payload_sample_verified, status, metadata, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, false, 'prepared', $14::jsonb, now())
    ON CONFLICT (generation_id) DO UPDATE SET
      provider = EXCLUDED.provider,
      model = EXCLUDED.model,
      precision = EXCLUDED.precision,
      dims = EXCLUDED.dims,
      embedding_base_hash = EXCLUDED.embedding_base_hash,
      text_strategy = EXCLUDED.text_strategy,
      source_collection = EXCLUDED.source_collection,
      target_collection = EXCLUDED.target_collection,
      qdrant_alias = EXCLUDED.qdrant_alias,
      redis_prefix = EXCLUDED.redis_prefix,
      query_cache_version = EXCLUDED.query_cache_version,
      record_count = EXCLUDED.record_count,
      status = CASE
        WHEN memory_embedding_generations.status = 'active' THEN 'active'
        ELSE 'prepared'
      END,
      metadata = memory_embedding_generations.metadata || EXCLUDED.metadata,
      updated_at = now()
    RETURNING *
  `, [
    generationId,
    argValue("--provider") || process.env.MEMORY_V2_EMBEDDING_PROVIDER || "local-ovms",
    process.env.EMBEDDING_MODEL || "Qwen3-Embedding-8B",
    argValue("--precision") || process.env.MEMORY_V2_EMBEDDING_PRECISION || "int4",
    Number.parseInt(process.env.EMBEDDING_DIMS || "4096", 10),
    hashEmbeddingBase(embeddingBase),
    argValue("--text-strategy") || defaultEmbeddingTextStrategy(),
    argValue("--source-collection") || null,
    targetCollection,
    qdrantAlias,
    redisPrefix,
    queryCacheVersion,
    recordCount,
    JSON.stringify({ prepared_by: "memory:embedding-manifest", prepared_at: new Date().toISOString() }),
  ]);
  return result.rows[0] as EmbeddingGenerationManifest;
}

async function switchAlias(aliasName: string, collectionName: string): Promise<void> {
  const qdrantConfig = loadMemoryV2QdrantConfig();
  if (!qdrantConfig.base_url) throw new Error("必须配置 MEMORY_V2_QDRANT_BASE_URL。");
  const aliases = await fetchJson(`${qdrantConfig.base_url.replace(/\/+$/, "")}/aliases`, {
    headers: qdrantHeaders(qdrantConfig.api_key),
  });
  const current = Array.isArray(aliases?.result?.aliases)
    ? aliases.result.aliases.find((item: any) => item.alias_name === aliasName)
    : null;
  const actions = [
    ...(current ? [{ delete_alias: { alias_name: aliasName } }] : []),
    { create_alias: { alias_name: aliasName, collection_name: collectionName } },
  ];
  await fetchJson(`${qdrantConfig.base_url.replace(/\/+$/, "")}/collections/aliases`, {
    method: "POST",
    headers: qdrantHeaders(qdrantConfig.api_key),
    body: JSON.stringify({ actions }),
  });
}

async function validateManifest(pool: Pool, generationId: string): Promise<{
  ok: boolean;
  manifest: EmbeddingGenerationManifest | null;
  checks: Record<string, unknown>;
  blockers: string[];
}> {
  const pgConfig = loadMemoryV2PostgresConfig();
  const qdrantConfig = loadMemoryV2QdrantConfig();
  const manifest = await getEmbeddingGenerationById(pool, generationId, pgConfig);
  const blockers: string[] = [];
  const checks: Record<string, unknown> = {};
  if (!manifest) {
    return { ok: false, manifest: null, checks: {}, blockers: ["manifest_missing"] };
  }

  const expectedRecords = await activeApprovedCount(pool, pgConfig.schema);
  const collectionInfo = await getQdrantCollectionInfo({
    baseUrl: qdrantConfig.base_url,
    apiKey: qdrantConfig.api_key,
    collectionName: manifest.target_collection,
  });
  const payloadSample = await verifyQdrantPayloadGeneration({
    baseUrl: qdrantConfig.base_url,
    apiKey: qdrantConfig.api_key,
    collectionName: manifest.target_collection,
    generationId: manifest.generation_id,
    full: true,
  });
  const aliasTarget = await getQdrantAliasTarget({
    baseUrl: qdrantConfig.base_url,
    apiKey: qdrantConfig.api_key,
    aliasName: manifest.qdrant_alias,
  }).catch(() => null);

  if (collectionInfo.status !== "green") blockers.push("collection_not_green");
  if (collectionInfo.vector_size !== manifest.dims) blockers.push("dimension_mismatch");
  if (collectionInfo.points_count !== expectedRecords) blockers.push("point_count_mismatch");
  if (!payloadSample.verified) blockers.push("payload_generation_mismatch");

  checks.record_count = expectedRecords;
  checks.collection = collectionInfo;
  checks.payload_validation = payloadSample;
  checks.payload_sample = payloadSample;
  checks.alias_target = aliasTarget;

  await pool.query(`
    UPDATE ${quoteIdent(pgConfig.schema)}.memory_embedding_generations
    SET record_count = $2,
        point_count = $3,
        payload_sample_verified = $4,
        status = CASE WHEN $5::boolean THEN 'validated' ELSE status END,
        metadata = metadata || $6::jsonb,
        updated_at = now()
    WHERE generation_id = $1
  `, [
    manifest.generation_id,
    expectedRecords,
    collectionInfo.points_count,
    payloadSample.verified,
    blockers.length === 0 && manifest.status !== "active",
    JSON.stringify({ last_validation: { at: new Date().toISOString(), checks, blockers } }),
  ]);

  return { ok: blockers.length === 0, manifest, checks, blockers };
}

async function activateManifest(pool: Pool, generationId: string): Promise<Record<string, unknown>> {
  const pgConfig = loadMemoryV2PostgresConfig();
  const validation = await validateManifest(pool, generationId);
  if (!validation.ok || !validation.manifest) {
    return { ok: false, validation };
  }
  const manifest = validation.manifest;
  await switchAlias(manifest.qdrant_alias, manifest.target_collection);
  await pool.query("BEGIN");
  try {
    await pool.query(`
      UPDATE ${quoteIdent(pgConfig.schema)}.memory_embedding_generations
      SET status = 'retired', retired_at = now(), updated_at = now()
      WHERE status = 'active' AND generation_id <> $1
    `, [manifest.generation_id]);
    await pool.query(`
      UPDATE ${quoteIdent(pgConfig.schema)}.memory_embedding_generations
      SET status = 'active', activated_at = coalesce(activated_at, now()), retired_at = NULL, failed_at = NULL, updated_at = now()
      WHERE generation_id = $1
    `, [manifest.generation_id]);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
  return {
    ok: true,
    activated_generation: manifest.generation_id,
    qdrant_alias: manifest.qdrant_alias,
    target_collection: manifest.target_collection,
    env: {
      MEMORY_V2_QDRANT_COLLECTION: manifest.qdrant_alias,
      MEMORY_V2_REDIS_PREFIX: manifest.redis_prefix,
      MEMORY_V2_QUERY_EMBEDDING_CACHE_VERSION: manifest.query_cache_version,
      MEMORY_V2_EMBEDDING_GENERATION_ID: manifest.generation_id,
    },
    restart: "systemctl --user restart memory-xx-wrapper.service memory-xx-qdrant-projector-worker.service",
  };
}

async function generateManifest(pool: Pool): Promise<Record<string, unknown>> {
  const manifest = await upsertPreparedManifest(pool);
  const args = [
    "tsx",
    "scripts/generate-local-memory-embeddings.ts",
    `--generation-id=${manifest.generation_id}`,
    `--target-collection=${manifest.target_collection}`,
    `--alias=${manifest.qdrant_alias}`,
    `--redis-prefix=${manifest.redis_prefix}`,
    `--query-cache-version=${manifest.query_cache_version}`,
    `--concurrency=${Math.min(2, Math.max(1, Number.parseInt(argValue("--concurrency") || process.env.MEMORY_V2_LOCAL_EMBEDDING_CONCURRENCY || "2", 10)))}`,
  ];
  const passthrough = ["--limit", "--batch-size", "--source-collection", "--text-strategy"];
  for (const name of passthrough) {
    const value = argValue(name);
    if (value && value !== "true") args.push(`${name}=${value}`);
  }
  if (process.argv.includes("--dry-run")) args.push("--dry-run");
  if (process.argv.includes("--estimate-only")) args.push("--estimate-only");
  if (process.argv.includes("--force-recreate")) args.push("--force-recreate");

  const output = execFileSync("npx", args, {
    cwd: process.cwd(),
    env: { ...process.env, TMPDIR: "/tmp" },
    encoding: "utf8",
    timeout: Number.parseInt(process.env.MEMORY_V2_GENERATE_EMBEDDINGS_TIMEOUT_MS || "7200000", 10),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: true,
    generation_id: manifest.generation_id,
    target_collection: manifest.target_collection,
    qdrant_alias: manifest.qdrant_alias,
    redis_prefix: manifest.redis_prefix,
    query_cache_version: manifest.query_cache_version,
    output_tail: output.slice(-4000),
    next: {
      validate: `TMPDIR=/tmp npm run memory:embedding-manifest -- validate --generation-id=${manifest.generation_id}`,
      activate: `TMPDIR=/tmp npm run memory:embedding-manifest -- activate --generation-id=${manifest.generation_id}`,
    },
  };
}

async function observeManifest(pool: Pool, generationId: string): Promise<Record<string, unknown>> {
  const pgConfig = loadMemoryV2PostgresConfig();
  const manifest = await getEmbeddingGenerationById(pool, generationId, pgConfig);
  if (!manifest) return { ok: false, blockers: ["manifest_missing"], generation_id: generationId };
  const wrapperUrl = (process.env.MEMORY_V2_WRAPPER_URL || "http://127.0.0.1:5100").replace(/\/+$/, "");
  const proxyUrl = (process.env.EMBEDDING_PROXY_URL || "http://127.0.0.1:5221/v1").replace(/\/+$/, "");
  const bypassWrapperHealth = process.argv.includes("--bypass-wrapper-health");
  const token = process.env.MEMORY_V2_ADMIN_TOKEN || process.env.MEMORY_V2_API_TOKEN || process.env.MEMORY_V2_WRAPPER_TOKEN || "";
  const headers = {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const wrapperHealth = await fetchJsonSoft(`${wrapperUrl}/health`, { headers });
  const proxyHealthUrl = proxyUrl.endsWith("/v1") ? `${proxyUrl.slice(0, -3)}/health` : `${proxyUrl}/health`;
  const proxyHealth = await fetchJsonSoft(proxyHealthUrl);
  const embeddingSmoke = await fetchJsonSoft(`${proxyUrl}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(process.env.EMBEDDING_API_KEY ? { authorization: `Bearer ${process.env.EMBEDDING_API_KEY}` } : {}) },
    body: JSON.stringify({ model: manifest.model, input: `memory-xx observe ${manifest.generation_id} ${randomUUID()}` }),
  });
  const embeddingDims = Array.isArray(embeddingSmoke.body?.data?.[0]?.embedding)
    ? embeddingSmoke.body.data[0].embedding.length
    : null;
  const directReconcile = await directReconcileManifestCounts(pool, manifest);
  const recallSmoke = await fetchJsonSoft(`${wrapperUrl}/api/memory/v2/unified/recall`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: "memory-xx embedding generation observe recall smoke",
      scope_type: "project",
      scope_id: "local-default",
      scope_context: { project_ids: ["local-default"], include_global: false },
      limit: 5,
      explain: true,
      debug: { enabled: true },
    }),
  });
  let fixedSmoke: Record<string, unknown> | null = null;
  if (process.argv.includes("--fixed-smoke")) {
    try {
      const output = execFileSync("npm", ["run", "test:quality"], {
        cwd: process.cwd(),
        env: { ...process.env, TMPDIR: "/tmp" },
        encoding: "utf8",
        timeout: 600000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const match = output.match(/@@LAYER_REPORT@@(.+)@@END_REPORT@@/s);
      fixedSmoke = { ok: true, layer_report: match ? JSON.parse(match[1]!) : null };
    } catch (error) {
      fixedSmoke = { ok: false, error: error instanceof Error ? String((error as Error & { stdout?: unknown }).stdout ?? error.message).slice(-3000) : String(error) };
    }
  }
  const smokeWarnings = [
    ...(!wrapperHealth.ok ? ["wrapper_health_failed"] : []),
    ...(!recallSmoke.ok ? [`recall_smoke_failed:${recallSmoke.status ?? recallSmoke.error ?? "unknown"}`] : []),
  ];
  const blockers = [
    ...(!directReconcile.ok ? ((directReconcile.blockers as string[] | undefined) ?? ["direct_reconcile_failed"]) : []),
    ...(!wrapperHealth.ok && !bypassWrapperHealth && !directReconcile.ok ? ["wrapper_health_failed"] : []),
    ...(!proxyHealth.ok ? ["embedding_proxy_health_failed"] : []),
    ...(!embeddingSmoke.ok ? ["embedding_upstream_unavailable"] : []),
    ...(embeddingDims !== manifest.dims ? ["embedding_dims_mismatch"] : []),
    ...(fixedSmoke && fixedSmoke.ok === false ? ["fixed_smoke_failed"] : []),
  ];
  await pool.query(`
    UPDATE ${quoteIdent(pgConfig.schema)}.memory_embedding_generations
    SET metadata = metadata || $2::jsonb,
        updated_at = now()
    WHERE generation_id = $1
  `, [
    manifest.generation_id,
    JSON.stringify({ last_observe: { at: new Date().toISOString(), ok: blockers.length === 0, blockers, smoke_warnings: smokeWarnings } }),
  ]);
  return {
    ok: blockers.length === 0,
    blockers,
    generation_id: manifest.generation_id,
    direct_reconcile: directReconcile,
    wrapper_health: wrapperHealth,
    proxy_health: proxyHealth,
    embedding_smoke: {
      ok: embeddingSmoke.ok,
      status: embeddingSmoke.status,
      latency_ms: embeddingSmoke.latency_ms,
      dims: embeddingDims,
      expected_dims: manifest.dims,
      error: embeddingSmoke.error,
    },
    recall_smoke: {
      ok: recallSmoke.ok,
      status: recallSmoke.status,
      warning_only: !recallSmoke.ok,
      degraded: recallSmoke.body?.degraded,
      vector_hits: recallSmoke.body?.audit?.vector_hits,
      graph_hits: recallSmoke.body?.audit?.graph_hits,
      latency_ms: recallSmoke.latency_ms,
    },
    fixed_smoke: fixedSmoke,
    rollback: "TMPDIR=/tmp npm run memory:embedding-manifest -- rollback && systemctl --user restart memory-xx-wrapper.service memory-xx-qdrant-projector-worker.service",
  };
}

async function refreshManifest(pool: Pool, generationId: string): Promise<Record<string, unknown>> {
  const forceReconcile = process.argv.includes("--force-reconcile");
  const force = process.argv.includes("--force") || forceReconcile;
  const full = process.argv.includes("--full") || process.argv.includes("--validate");
  const debounceMs = Number.parseInt(process.env.MEMORY_V2_MANIFEST_REFRESH_DEBOUNCE_MS || "60000", 10);
  const periodicMs = Number.parseInt(process.env.MEMORY_V2_MANIFEST_REFRESH_PERIODIC_MS || String(15 * 60 * 1000), 10);
  const state = await readEmbeddingManifestDirtyState();
  const now = Date.now();
  const lastMarked = state?.last_marked_at ? Date.parse(state.last_marked_at) : 0;
  const lastRefresh = state?.last_refresh_at ? Date.parse(state.last_refresh_at) : 0;
  const dirtyReady = state?.dirty === true && (!Number.isFinite(lastMarked) || now - lastMarked >= debounceMs);
  const periodicReady = !lastRefresh || now - lastRefresh >= periodicMs;
  if (!force && !dirtyReady && !periodicReady) {
    return {
      ok: true,
      skipped: true,
      reason: state?.dirty ? "debounce_wait" : "fresh",
      state,
      next_after_ms: state?.dirty ? Math.max(0, debounceMs - (now - lastMarked)) : Math.max(0, periodicMs - (now - lastRefresh)),
    };
  }
  const result = full && !forceReconcile
    ? await validateManifest(pool, generationId)
    : await observeManifest(pool, generationId);
  const refreshed = await markEmbeddingManifestRefreshed();
  return {
    ok: (result as any).ok !== false,
    mode: full ? "validate" : "observe",
    trigger: force ? "force" : dirtyReady ? "dirty_debounce" : "periodic",
    previous_state: state,
    state: refreshed,
    result,
  };
}

async function main(): Promise<void> {
  const command = process.argv[2] || "status";
  const pgConfig = loadMemoryV2PostgresConfig();
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  try {
    if (command === "prepare") {
      console.log(JSON.stringify({ ok: true, manifest: await upsertPreparedManifest(pool) }, null, 2));
      return;
    }
    if (command === "validate") {
      const generationId = argValue("--generation-id") || defaultEmbeddingGenerationId();
      const result = await validateManifest(pool, generationId);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (command === "generate") {
      const result = await generateManifest(pool);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (command === "activate") {
      const generationId = argValue("--generation-id") || defaultEmbeddingGenerationId();
      const result = await activateManifest(pool, generationId);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (command === "rollback") {
      const active = await getActiveEmbeddingGeneration(pool, pgConfig);
      const generationId = argValue("--generation-id");
      const target = generationId
        ? await getEmbeddingGenerationById(pool, generationId, pgConfig)
        : (await pool.query(`
            SELECT *
            FROM ${quoteIdent(pgConfig.schema)}.memory_embedding_generations
            WHERE status IN ('retired', 'validated', 'generated')
              AND generation_id <> coalesce($1, '')
            ORDER BY retired_at DESC NULLS LAST, updated_at DESC
            LIMIT 1
          `, [active?.generation_id ?? null])).rows[0] as EmbeddingGenerationManifest | undefined;
      if (!target) throw new Error("未找到可回滚的 embedding generation。");
      const result = await activateManifest(pool, target.generation_id);
      console.log(JSON.stringify({ ...result, rollback_from: active?.generation_id ?? null }, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (command === "observe") {
      const generationId = argValue("--generation-id") || defaultEmbeddingGenerationId();
      const result = await observeManifest(pool, generationId);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (command === "mark-dirty") {
      const reason = argValue("--reason") || "manual";
      console.log(JSON.stringify({ ok: true, state: await markEmbeddingManifestDirty(reason) }, null, 2));
      return;
    }
    if (command === "refresh") {
      const generationId = argValue("--generation-id") || defaultEmbeddingGenerationId();
      const result = await refreshManifest(pool, generationId);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (command === "status") {
      const active = await getActiveEmbeddingGeneration(pool, pgConfig);
      const rows = await pool.query(`
        SELECT generation_id, status, target_collection, qdrant_alias, redis_prefix, query_cache_version,
               record_count, point_count, payload_sample_verified, updated_at, activated_at, retired_at
        FROM ${quoteIdent(pgConfig.schema)}.memory_embedding_generations
        ORDER BY updated_at DESC
        LIMIT 10
      `);
      console.log(JSON.stringify({ ok: true, active_generation: active, recent_generations: rows.rows, refresh_state: await readEmbeddingManifestDirtyState() }, null, 2));
      return;
    }
    throw new Error(`未知命令：${command}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

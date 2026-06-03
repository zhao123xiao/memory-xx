import fs from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

import "./test-harness/config";
import { loadMemoryV2PostgresConfig, createPostgresPoolConfig } from "../app/db/adapters/postgres-config";
import { mapMemoryIdToQdrantPointId } from "../app/qdrant-sync/projector";
import { defaultEmbeddingGenerationId, defaultEmbeddingTextStrategy, defaultQueryCacheVersion, hashEmbeddingBase } from "../app/embedding";

interface MemoryRecord {
  readonly id: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly content: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly memory_type: string | null;
  readonly memory_layer: string | null;
  readonly fact_status: string | null;
  readonly valid_at: string | null;
  readonly observed_at: string | null;
  readonly importance: number | null;
  readonly memory_strength: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ExistingPoint {
  readonly id: string;
  readonly payload?: Record<string, unknown>;
}

interface GeneratedPoint {
  readonly id: string;
  readonly vector: readonly number[];
  readonly payload: Record<string, unknown>;
}

const reportRoot = process.env.MEMORY_V2_REPORT_DIR || path.join(process.cwd(), "reports/memory-xx-tests");
const runId = `local-memory-embedding-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const outputDir = path.join(reportRoot, "local-memory-embedding", runId);

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg === name || arg.startsWith(prefix));
  if (!found) return undefined;
  if (found === name) return "true";
  return found.slice(prefix.length);
}

const estimateOnly = process.argv.includes("--estimate-only");
const limitArg = argValue("--limit");
const limit = limitArg && limitArg !== "true" ? Math.max(1, Number.parseInt(limitArg, 10)) : undefined;
const sourceCollection = argValue("--source-collection") || process.env.MEMORY_V2_QDRANT_COLLECTION || "memory-xx-active";
const targetCollection = argValue("--target-collection") || process.env.MEMORY_V2_LOCAL_EMBEDDING_COLLECTION || "memory-xx-local-qwen8b-int4-v1";
const qdrantAlias = argValue("--alias") || process.env.MEMORY_V2_QDRANT_ALIAS || "memory-xx-active";
const redisPrefix = argValue("--redis-prefix") || process.env.MEMORY_V2_REDIS_PREFIX || "memory-xx-local-qwen8b-int4";
const forceRecreate = process.argv.includes("--force-recreate");
const maxConcurrency = Math.min(2, Math.max(1, Number.parseInt(argValue("--concurrency") || process.env.MEMORY_V2_LOCAL_EMBEDDING_CONCURRENCY || "2", 10)));
const batchSize = Math.max(1, Number.parseInt(argValue("--batch-size") || process.env.MEMORY_V2_LOCAL_EMBEDDING_BATCH_SIZE || "32", 10));
const dryRun = process.argv.includes("--dry-run") || estimateOnly;

const qdrantBase = process.env.MEMORY_V2_QDRANT_BASE_URL?.replace(/\/+$/, "") || "http://127.0.0.1:6333";
const qdrantApiKey = process.env.MEMORY_V2_QDRANT_API_KEY?.trim();
const embeddingBase = (process.env.EMBEDDING_API_BASE || "http://127.0.0.1:5221/v1").replace(/\/+$/, "");
const embeddingKey = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || "";
const embeddingModel = process.env.EMBEDDING_MODEL || "Qwen3-Embedding-8B";
const embeddingDims = Number.parseInt(process.env.EMBEDDING_DIMS || "4096", 10);
const embeddingGeneration = argValue("--generation-id") || defaultEmbeddingGenerationId();
const embeddingTextStrategy = argValue("--text-strategy") || defaultEmbeddingTextStrategy();
const queryCacheVersion = argValue("--query-cache-version") || process.env.MEMORY_V2_QUERY_EMBEDDING_CACHE_VERSION || defaultQueryCacheVersion(embeddingGeneration);

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`Unsafe identifier: ${value}`);
  return `"${value}"`;
}

function qdrantHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(qdrantApiKey ? { "api-key": qdrantApiKey } : {}),
    ...(extra ?? {})
  };
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function estimateMs(total: number, p95PerRecordMs: number): number {
  const waves = Math.ceil(total / maxConcurrency);
  const qdrantOverheadMs = Math.ceil(total / batchSize) * 250;
  return waves * p95PerRecordMs + qdrantOverheadMs;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function embeddingText(record: MemoryRecord): string {
  const lines = [
    record.title ? `Title: ${record.title}` : "",
    record.summary ? `Summary: ${record.summary}` : "",
    `Scope: ${record.scope_type}/${record.scope_id}`,
    record.memory_type ? `Type: ${record.memory_type}` : "",
    record.memory_layer ? `Layer: ${record.memory_layer}` : "",
    record.fact_status ? `Fact status: ${record.fact_status}` : "",
    `Content: ${record.content}`
  ].filter(Boolean);
  return lines.join("\n").slice(0, 4000);
}

async function upsertManifest(pool: Pool, status: "prepared" | "generated" | "validated" | "failed", counts?: {
  readonly record_count?: number;
  readonly point_count?: number;
  readonly payload_sample_verified?: boolean;
  readonly metadata?: Record<string, unknown>;
}): Promise<void> {
  const pgConfig = loadMemoryV2PostgresConfig();
  await pool.query(`
    INSERT INTO ${quoteIdent(pgConfig.schema)}.memory_embedding_generations (
      generation_id, provider, model, precision, dims, embedding_base_hash, text_strategy,
      source_collection, target_collection, qdrant_alias, redis_prefix, query_cache_version,
      record_count, point_count, payload_sample_verified, status, metadata, updated_at
    )
    VALUES ($1, 'local-ovms', $2, 'int4', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, now())
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
      point_count = EXCLUDED.point_count,
      payload_sample_verified = EXCLUDED.payload_sample_verified,
      status = CASE
        WHEN memory_embedding_generations.status = 'active' THEN 'active'
        ELSE EXCLUDED.status
      END,
      metadata = memory_embedding_generations.metadata || EXCLUDED.metadata,
      failed_at = CASE WHEN EXCLUDED.status = 'failed' THEN now() ELSE memory_embedding_generations.failed_at END,
      updated_at = now()
  `, [
    embeddingGeneration,
    embeddingModel,
    embeddingDims,
    hashEmbeddingBase(embeddingBase),
    embeddingTextStrategy,
    sourceCollection,
    targetCollection,
    qdrantAlias,
    redisPrefix,
    queryCacheVersion,
    counts?.record_count ?? 0,
    counts?.point_count ?? 0,
    counts?.payload_sample_verified ?? false,
    status,
    JSON.stringify({
      generator: "generate-local-memory-embeddings",
      run_id: runId,
      ...(counts?.metadata ?? {})
    })
  ]);
}

function fallbackPayload(record: MemoryRecord): Record<string, unknown> {
  return {
    memory_id: record.id,
    request_id: `local-embedding-generation:${runId}:${record.id}`,
    title: record.title ?? undefined,
    content: record.content,
    summary: record.summary ?? undefined,
    scope_type: record.scope_type,
    scope_id: record.scope_id,
    project_id: record.scope_type === "project" ? record.scope_id : undefined,
    workspace_id: record.scope_type === "workspace" ? record.scope_id : undefined,
    source_path: `memory:${record.id}`,
    memory_type: record.memory_type ?? undefined,
    memory_layer: record.memory_layer ?? "recall",
    fact_status: record.fact_status ?? "current",
    valid_at: record.valid_at ?? undefined,
    observed_at: record.observed_at ?? undefined,
    importance: record.importance ?? 0.5,
    memory_strength: record.memory_strength ?? 1,
    created_at: record.created_at,
    updated_at: record.updated_at,
    lifecycle_status: "approved",
    review_state: "not_required",
    is_current: true,
    version: 1,
    source_count: 0,
    relation_count: 0
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(60_000)
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${response.status}:${JSON.stringify(body).slice(0, 500)}`);
  }
  return body;
}

async function loadRecords(pool: Pool): Promise<MemoryRecord[]> {
  const pgConfig = loadMemoryV2PostgresConfig();
  const sql = `
    SELECT
      id,
      title,
      summary,
      content,
      scope_type,
      scope_id,
      memory_type,
      memory_layer,
      fact_status,
      valid_at,
      observed_at,
      importance,
      memory_strength,
      created_at,
      updated_at
    FROM ${pgConfig.schema}.memory_records
    WHERE lifecycle_status = 'approved'
      AND is_current IS TRUE
      AND review_state IN ('approved', 'silent_approved', 'not_required')
    ORDER BY id
    ${limit ? "LIMIT $1" : ""}
  `;
  const result = await pool.query<MemoryRecord>(sql, limit ? [limit] : []);
  return result.rows;
}

async function sampleEmbeddingLatency(records: readonly MemoryRecord[]): Promise<{
  readonly latencies: readonly number[];
  readonly p50: number;
  readonly p95: number;
  readonly avg: number;
}> {
  const sample = records.slice(0, Math.min(12, records.length));
  const latencies: number[] = [];
  for (const record of sample) {
    const started = Date.now();
    await embedRecord(record);
    latencies.push(Date.now() - started);
  }
  return {
    latencies,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    avg: Math.round(mean(latencies))
  };
}

async function embedRecord(record: MemoryRecord): Promise<readonly number[]> {
  const response = await fetchJson(`${embeddingBase}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(embeddingKey ? { authorization: `Bearer ${embeddingKey}` } : {})
    },
    body: JSON.stringify({
      model: embeddingModel,
      input: [embeddingText(record)],
      dimensions: embeddingDims
    })
  });
  const embedding = response?.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length !== embeddingDims) {
    throw new Error(`invalid_embedding:${record.id}:${Array.isArray(embedding) ? embedding.length : "none"}`);
  }
  return embedding as number[];
}

async function ensureCollection(): Promise<void> {
  if (dryRun) return;
  const targetUrl = `${qdrantBase}/collections/${encodeURIComponent(targetCollection)}`;
  const existing = await fetch(targetUrl, { headers: qdrantHeaders(), signal: AbortSignal.timeout(15_000) });
  if (existing.ok && forceRecreate) {
    await fetchJson(targetUrl, { method: "DELETE", headers: qdrantHeaders() });
  } else if (existing.ok) {
    return;
  }

  await fetchJson(targetUrl, {
    method: "PUT",
    headers: qdrantHeaders(),
    body: JSON.stringify({
      vectors: { size: embeddingDims, distance: "Cosine" },
      on_disk_payload: true,
      optimizers_config: { indexing_threshold: 2000 },
      hnsw_config: { m: 16, ef_construct: 100, full_scan_threshold: 10000 }
    })
  });
}

async function retrieveExistingPayloads(pointIds: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
  const response = await fetchJson(`${qdrantBase}/collections/${encodeURIComponent(sourceCollection)}/points`, {
    method: "POST",
    headers: qdrantHeaders(),
    body: JSON.stringify({ ids: pointIds, with_payload: true, with_vector: false })
  });
  const rows = Array.isArray(response?.result) ? response.result as ExistingPoint[] : [];
  const payloads = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (row.payload && typeof row.payload === "object") {
      payloads.set(String(row.id), row.payload);
    }
  }
  return payloads;
}

async function upsertPoints(points: readonly GeneratedPoint[]): Promise<void> {
  if (dryRun || points.length === 0) return;
  await fetchJson(`${qdrantBase}/collections/${encodeURIComponent(targetCollection)}/points?wait=true`, {
    method: "PUT",
    headers: qdrantHeaders(),
    body: JSON.stringify({ points })
  });
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function generate(records: readonly MemoryRecord[]): Promise<{
  readonly processed: number;
  readonly errors: number;
  readonly latencies: readonly number[];
  readonly qdrant_points: number;
}> {
  let processed = 0;
  let errors = 0;
  let qdrantPoints = 0;
  const latencies: number[] = [];

  for (let offset = 0; offset < records.length; offset += batchSize) {
    const batch = records.slice(offset, offset + batchSize);
    const pointIds = batch.map((record) => mapMemoryIdToQdrantPointId(record.id));
    const existingPayloads = await retrieveExistingPayloads(pointIds).catch(() => new Map<string, Record<string, unknown>>());
    const generated = await runWithConcurrency(batch, maxConcurrency, async (record) => {
      const started = Date.now();
      const pointId = mapMemoryIdToQdrantPointId(record.id);
      try {
        const vector = await embedRecord(record);
        const elapsed = Date.now() - started;
        latencies.push(elapsed);
        processed += 1;
        const previousPayload = existingPayloads.get(pointId);
        const payload = {
          ...(previousPayload ?? fallbackPayload(record)),
          embedding_provider: "local-ovms",
          embedding_model: embeddingModel,
          embedding_precision: "int4",
          embedding_dimension: embeddingDims,
          embedding_generation: embeddingGeneration,
          embedding_generated_at: new Date().toISOString(),
          embedding_text_strategy: embeddingTextStrategy
        };
        return { id: pointId, vector, payload } satisfies GeneratedPoint;
      } catch (error) {
        errors += 1;
        console.error(`embedding_failed ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    });
    const points = generated.filter((point): point is GeneratedPoint => point !== null);
    await upsertPoints(points);
    qdrantPoints += points.length;
    const done = Math.min(offset + batch.length, records.length);
    console.log(`  progress ${done}/${records.length} processed=${processed} errors=${errors}`);
  }

  return { processed, errors, latencies, qdrant_points: qdrantPoints };
}

async function collectionCount(collection: string): Promise<number> {
  const response = await fetchJson(`${qdrantBase}/collections/${encodeURIComponent(collection)}`, {
    headers: qdrantHeaders()
  });
  return Number(response?.result?.points_count ?? 0);
}

async function verifyPayloadSample(collection: string): Promise<{ checked: number; mismatches: number; verified: boolean }> {
  if (dryRun) return { checked: 0, mismatches: 0, verified: false };
  const response = await fetchJson(`${qdrantBase}/collections/${encodeURIComponent(collection)}/points/scroll`, {
    method: "POST",
    headers: qdrantHeaders(),
    body: JSON.stringify({ limit: 10, with_payload: true, with_vector: false })
  });
  const points = Array.isArray(response?.result?.points) ? response.result.points as Array<{ payload?: Record<string, unknown> }> : [];
  const mismatches = points.filter((point) => point.payload?.embedding_generation !== embeddingGeneration).length;
  return { checked: points.length, mismatches, verified: points.length > 0 && mismatches === 0 };
}

async function main(): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
  const pgConfig = loadMemoryV2PostgresConfig();
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  try {
    const records = await loadRecords(pool);
    const charLengths = records.map((record) => embeddingText(record).length);
    console.log("=== Local memory embedding generation ===");
    console.log(`schema=${pgConfig.schema}`);
    console.log(`source_collection=${sourceCollection}`);
    console.log(`target_collection=${targetCollection}`);
    console.log(`records=${records.length}`);
    console.log(`concurrency=${maxConcurrency}`);
    console.log(`batch_size=${batchSize}`);
    console.log(`dry_run=${dryRun}`);
    console.log(`embedding_base=${embeddingBase}`);
    console.log(`embedding_model=${embeddingModel}`);
    console.log(`embedding_generation=${embeddingGeneration}`);
    console.log(`qdrant_alias=${qdrantAlias}`);
    console.log(`redis_prefix=${redisPrefix}`);
    console.log(`query_cache_version=${queryCacheVersion}`);
    console.log(`text_chars_p50=${percentile(charLengths, 50)} p95=${percentile(charLengths, 95)} max=${Math.max(0, ...charLengths)}`);

    if (records.length === 0) {
      console.log("Nothing to do.");
      return;
    }

    console.log("Sampling local embedding latency...");
    const latencySample = await sampleEmbeddingLatency(records);
    const estimatedMs = estimateMs(records.length, latencySample.p95);
    const estimate = {
      records: records.length,
      concurrency: maxConcurrency,
      batch_size: batchSize,
      sampled_latency_ms: latencySample,
      estimated_total_ms: estimatedMs,
      estimated_total_human: formatDuration(estimatedMs),
      target_collection: targetCollection
    };
    if (!dryRun) {
      await upsertManifest(pool, "prepared", {
        record_count: records.length,
        metadata: { estimate }
      });
    }
    console.log(`sample_p50=${latencySample.p50}ms sample_p95=${latencySample.p95}ms avg=${latencySample.avg}ms`);
    console.log(`estimated_total=${estimate.estimated_total_human}`);

    if (estimateOnly) {
      const estimatePath = path.join(outputDir, "estimate.json");
      await fs.writeFile(estimatePath, JSON.stringify({ run_id: runId, estimate }, null, 2));
      console.log(`Estimate report: ${estimatePath}`);
      return;
    }

    await ensureCollection();
    const started = Date.now();
    const result = await generate(records);
    const elapsedMs = Date.now() - started;
    const targetCount = dryRun ? 0 : await collectionCount(targetCollection);
    const payloadSample = await verifyPayloadSample(targetCollection);
    if (!dryRun) {
      await upsertManifest(pool, result.errors === 0 && payloadSample.verified ? "validated" : result.errors === 0 ? "generated" : "failed", {
        record_count: records.length,
        point_count: targetCount,
        payload_sample_verified: payloadSample.verified,
        metadata: {
          elapsed_ms: elapsedMs,
          payload_sample: payloadSample
        }
      });
    }
    const report = {
      run_id: runId,
      generated_at: new Date().toISOString(),
      source_collection: sourceCollection,
      target_collection: targetCollection,
      qdrant_alias: qdrantAlias,
      redis_prefix: redisPrefix,
      query_cache_version: queryCacheVersion,
      embedding: {
        provider: "local-ovms",
        model: embeddingModel,
        precision: "int4",
        dims: embeddingDims,
        generation: embeddingGeneration,
        base: embeddingBase,
        text_strategy: embeddingTextStrategy
      },
      estimate,
      result: {
        ...result,
        elapsed_ms: elapsedMs,
        elapsed_human: formatDuration(elapsedMs),
        latency_ms: {
          p50: percentile(result.latencies, 50),
          p95: percentile(result.latencies, 95),
          p99: percentile(result.latencies, 99),
          avg: Math.round(mean(result.latencies))
        },
        payload_sample: payloadSample,
        target_collection_points: targetCount
      }
    };
    const reportPath = path.join(outputDir, "generation-report.json");
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      ok: result.errors === 0,
      report: reportPath,
      target_collection: targetCollection,
      records: records.length,
      processed: result.processed,
      errors: result.errors,
      elapsed: formatDuration(elapsedMs),
      target_collection_points: targetCount,
      latency_ms: report.result.latency_ms
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

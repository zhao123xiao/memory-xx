/**
 * Random approved-memory recall sample test.
 *
 * Deterministically samples 20 approved/current records from the configured
 * schema, then uses each sampled record's title (or content snippet fallback)
 * as the query and checks whether the original record can be recalled in top-5.
 *
 * Usage:
 *   MEMORY_XX_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/memory_xx \
 *   MEMORY_XX_DATABASE_SCHEMA=memory_xx \
 *   node --import tsx scripts/random-recall-sample.ts
 */

import { Pool } from "pg";
import {
  createConfiguredRecallRuntime,
  loadMemoryXXPostgresConfig,
  loadMemoryXXQdrantConfig,
  type MemoryXXPostgresConfig,
  FilterMode,
  type PostgresRecallRuntime,
  type QueryEmbeddingProvider,
  type RecallRequest,
  ResilientQueryEmbeddingProvider
} from "../app";

type SampledRecord = {
  id: string;
  title: string | null;
  content: string;
  scope_type: string;
  scope_id: string;
  memory_type: string | null;
  source_uri: string | null;
  duplicate_title_count: number;
};

class QwenEmbeddingProvider implements QueryEmbeddingProvider {
  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly model: string;
  private readonly dims: number;

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY?.trim() || "";
    this.apiBase =
      process.env.EMBEDDING_PROXY_URL?.trim() ||
      process.env.EMBEDDING_API_BASE?.trim() ||
      "http://127.0.0.1:5221";
    this.model = "Qwen3-Embedding-8B";
    this.dims = 4096;
  }

  async embed_query(input: { query: string; query_terms: string[] }) {
    const isLocalProxy = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/u.test(this.apiBase);
    if (!this.apiKey && !isLocalProxy) {
      return {
        embedding: null,
        audit: {
          fresh_cache_hit: false,
          stale_cache_hit: false,
          attempt_count: 1,
          final_error: "missing_api_key",
          error_code: "CONFIG_MISSING"
        }
      };
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), Number.parseInt(process.env.RANDOM_RECALL_EMBEDDING_TIMEOUT_MS?.trim() || "5000", 10));
      const resp = await fetch(`${this.apiBase}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify({ model: this.model, input: [input.query], dimensions: this.dims }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      timeout = undefined;
      if (!resp.ok) {
        return {
          embedding: null,
          audit: {
            fresh_cache_hit: false,
            stale_cache_hit: false,
            attempt_count: 1,
            final_error: `embedding_api_${resp.status}`,
            error_code: `HTTP_${resp.status}`
          }
        };
      }
      const data = await resp.json() as { data: Array<{ embedding: number[] }> };
      const embedding = data.data?.[0]?.embedding ?? null;
      return {
        embedding,
        audit: {
          fresh_cache_hit: false,
          stale_cache_hit: false,
          attempt_count: 1,
          ...(embedding ? {} : { final_error: "empty_embedding", error_code: "UPSTREAM_NULL" })
        }
      };
    } catch (error) {
      if (timeout) clearTimeout(timeout);
      return {
        embedding: null,
        audit: {
          fresh_cache_hit: false,
          stale_cache_hit: false,
          attempt_count: 1,
          final_error: error instanceof Error ? error.message : "embedding_failed",
          error_code:
            error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
              ? (error as { code: string }).code
              : "UPSTREAM_ERROR"
        }
      };
    }
  }
}

function truncate(input: string, maxLen: number): string {
  if (input.length <= maxLen) return input;
  return `${input.slice(0, maxLen - 3)}...`;
}

function normalizeComparableText(input: string | null | undefined): string {
  return (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[“”‘’'"`]/g, "")
    .replace(/[._/\\:-]+/g, " ")
    .replace(/[()\[\]{}（）【】]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFirstSentence(record: SampledRecord): string | undefined {
  return record.content
    .split(/[。！？\n]/u)
    .map((part) => part.trim())
    .filter(Boolean)[0];
}

function shouldBuildDisambiguatedClusterQuery(record: SampledRecord): boolean {
  const title = record.title?.trim() ?? "";
  const sourceUri = record.source_uri?.trim().toLowerCase() ?? "";

  if (record.duplicate_title_count <= 3) {
    return false;
  }

  if (sourceUri === "memory/projects.md" || sourceUri === "memory/todos.md") {
    return true;
  }

  return /^项目：/u.test(title) || title.includes("/");
}

function buildQuery(record: SampledRecord): string {
  const title = record.title?.trim();
  const firstSentence = extractFirstSentence(record);
  if (title && title !== "(no result)" && title.length >= 2) {
    const normalizedTitle = title.replace(/^项目：/u, "").replace(/^阶段：/u, "").trim();

    if (
      shouldBuildDisambiguatedClusterQuery(record) &&
      firstSentence &&
      firstSentence.length >= 6
    ) {
      return truncate(`${normalizedTitle} ${truncate(firstSentence, 28)}`, 72);
    }

    return normalizedTitle;
  }

  if (firstSentence && firstSentence.length >= 4) {
    return truncate(firstSentence, 24);
  }

  return truncate(record.content.trim(), 24);
}

async function loadAllProjectScopeIds(config: MemoryXXPostgresConfig): Promise<string[]> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  try {
    await pool.query(`SET search_path TO ${config.schema}`);
    const result = await pool.query(`SELECT DISTINCT scope_id FROM memory_records WHERE scope_type = 'project'`);
    return result.rows.map((r: { scope_id: string }) => r.scope_id);
  } finally {
    await pool.end();
  }
}

async function sampleRecords(
  config: MemoryXXPostgresConfig,
  sampleSize: number,
  sampleSeed: string
): Promise<SampledRecord[]> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  try {
    await pool.query(`SET search_path TO ${config.schema}`);
    const result = await pool.query<SampledRecord>(`
      WITH sampled AS (
        SELECT
          mr.id,
          mr.title,
          mr.content,
          mr.scope_type,
          mr.scope_id,
          mr.memory_type,
          src.uri AS source_uri,
          count(*) OVER (PARTITION BY mr.title) AS duplicate_title_count,
          coalesce(mr.scope_type, 'unknown') || ':' ||
            coalesce(mr.memory_type, 'unknown') || ':' ||
            coalesce(src.uri, 'unknown') || ':' ||
            CASE WHEN mr.content ~ '[\u4e00-\u9fff]' THEN 'zh' ELSE 'non_zh' END || ':' ||
            CASE WHEN count(*) OVER (PARTITION BY mr.title) > 3 THEN 'duplicate_title' ELSE 'unique_title' END AS sample_stratum,
          md5(mr.id || ':' || $2) AS sample_key
        FROM memory_records mr
        LEFT JOIN LATERAL (
          SELECT ms.uri
          FROM memory_sources ms
          WHERE ms.memory_id = mr.id
          ORDER BY ms.confidence DESC NULLS LAST, ms.created_at ASC
          LIMIT 1
        ) src ON TRUE
        WHERE mr.lifecycle_status = 'approved'
          AND mr.is_current = true
          AND mr.review_state IN ('approved', 'not_required')
      )
      SELECT id, title, content, scope_type, scope_id, memory_type, source_uri, duplicate_title_count
      FROM sampled
      ORDER BY sample_stratum, sample_key
      LIMIT $1
    `, [sampleSize, sampleSeed]);
    return result.rows;
  } finally {
    await pool.end();
  }
}

async function main() {
  const config = loadMemoryXXPostgresConfig();
  const sampleSize = Number.parseInt(process.env.RANDOM_RECALL_SAMPLE_SIZE?.trim() || "100", 10);
  const sampleSeed = process.env.RANDOM_RECALL_SAMPLE_SEED?.trim() || "2026-05-22-random100-v1";
  const reportPath = process.env.RANDOM_RECALL_REPORT_PATH?.trim() || "<project-root>/migration_artifacts/random-recall-sample-report.json";
  const queryDelayMs = Number.parseInt(process.env.RANDOM_RECALL_QUERY_DELAY_MS?.trim() || "1000", 10);
  const batchPauseAfter = Number.parseInt(process.env.RANDOM_RECALL_BATCH_PAUSE_AFTER?.trim() || "10");
  const batchPauseMs = Number.parseInt(process.env.RANDOM_RECALL_BATCH_PAUSE_MS?.trim() || "4000");
  const phases = ((process.env.RANDOM_RECALL_PHASES?.trim() || "cold,warm")
    .split(",")
    .map((phase) => phase.trim())
    .filter((phase) => phase === "cold" || phase === "warm"));
  if (phases.length === 0) phases.push("cold", "warm");

  if (!Number.isInteger(sampleSize) || sampleSize <= 0) {
    throw new Error(`RANDOM_RECALL_SAMPLE_SIZE must be a positive integer, got: ${process.env.RANDOM_RECALL_SAMPLE_SIZE ?? ""}`);
  }

  const projectIds = await loadAllProjectScopeIds(config);
  const sampledRecords = await sampleRecords(config, sampleSize, sampleSeed);
  const configuredRuntime = createConfiguredRecallRuntime({
    config,
    query_embedding_provider: new ResilientQueryEmbeddingProvider(
      new QwenEmbeddingProvider(),
      {
        max_retries: 0,
        retry_delay_ms: 250,
        retry_backoff_multiplier: 2,
        cache_ttl_ms: 10 * 60 * 1000,
        allow_stale_on_error: true
      }
    ),
    vector_column_name: "content_embedding",
    qdrant: loadMemoryXXQdrantConfig()
  });
  const runtime: PostgresRecallRuntime = configuredRuntime.runtime;

  const results: Array<{
    sampleId: string;
    phase: string;
    query: string;
    title: string | null;
    sourcePath: string | null;
    duplicateTitleCount: number;
    passed: boolean;
    matchType: "exact_id" | "equivalent_title" | "miss";
    foundRank: number | null;
    exactFoundRank: number | null;
    top1Id: string | null;
    top1Title: string | null;
    totalHits: number;
    latencyMs: number;
    degraded: boolean;
    degradeReason?: string;
    embeddingAudit?: {
      freshCacheHit: boolean;
      staleCacheHit: boolean;
      attemptCount: number;
      finalError?: string;
      errorCode?: string;
    };
  }> = [];

  let passCount = 0;
  let failCount = 0;
  let top1Count = 0;
  let top3Count = 0;
  let top5Count = 0;
  let exactPassCount = 0;
  let exactTop1Count = 0;
  let exactTop3Count = 0;
  let exactTop5Count = 0;
  let falseNullCount = 0;
  let mrr = 0;
  let ndcgAt5 = 0;
  let exactMrr = 0;
  const latencies: number[] = [];
  let degradedCount = 0;
  let vectorBackendUnavailableCount = 0;
  let explainEmbeddingCount = 0;
  let freshCacheHitCount = 0;
  let staleCacheHitCount = 0;
  let retryCount = 0;
  const errorCodeCounts: Record<string, number> = {};

  try {
    console.log("=== Random Recall Sample Test ===");
    console.log(`Schema: ${config.schema}`);
    console.log(`Sample size: ${sampledRecords.length}`);
    console.log(`Sample seed: ${sampleSeed}`);
    console.log(`Phases: ${phases.join(",")}`);
    console.log(`Vector runtime: ${configuredRuntime.vector_runtime_mode}`);
    console.log();

    for (const phase of phases) {
    for (const [index, record] of sampledRecords.entries()) {
      const query = buildQuery(record);
      const request: RecallRequest = {
        query,
        scope_context: {
          user_id: "current-instance-owner",
          workspace_id: "current-instance",
          project_ids: projectIds,
          include_global: true
        },
        filter_mode: FilterMode.Default,
        debug: {
          enabled: true,
          include_strategy_plan: true
        },
        explain: true,
        limit: 5
      };

      const phaseDelayMs = phase === "warm"
        ? Number.parseInt(process.env.RANDOM_RECALL_WARM_QUERY_DELAY_MS?.trim() || "0", 10)
        : queryDelayMs;
      if (phaseDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, phaseDelayMs));
      }
      if (batchPauseAfter > 0 && (index + 1) % batchPauseAfter === 0 && index < sampledRecords.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, batchPauseMs));
      }
      const started = Date.now();
      const response = await runtime.orchestrator.execute(request);
      const latencyMs = Date.now() - started;
      latencies.push(latencyMs);
      const normalizedTargetTitle = normalizeComparableText(record.title);
      const foundIndex = response.results.findIndex((item) => {
        if (item.memory_id === record.id) return true;
        const normalizedResultTitle = normalizeComparableText(item.title);
        return Boolean(
          normalizedTargetTitle &&
            normalizedTargetTitle.length >= 4 &&
            normalizedResultTitle === normalizedTargetTitle
        );
      });
      const exactFoundIndex = response.results.findIndex((item) => item.memory_id === record.id);
      const passed = foundIndex >= 0;
      const matchType =
        exactFoundIndex >= 0
          ? "exact_id"
          : foundIndex >= 0
            ? "equivalent_title"
            : "miss";
      if (passed) passCount += 1;
      else failCount += 1;
      if (foundIndex === 0) top1Count += 1;
      if (foundIndex >= 0 && foundIndex < 3) top3Count += 1;
      if (foundIndex >= 0 && foundIndex < 5) top5Count += 1;
      if (exactFoundIndex >= 0) exactPassCount += 1;
      if (exactFoundIndex === 0) exactTop1Count += 1;
      if (exactFoundIndex >= 0 && exactFoundIndex < 3) exactTop3Count += 1;
      if (exactFoundIndex >= 0 && exactFoundIndex < 5) exactTop5Count += 1;
      if (response.results.length === 0) falseNullCount += 1;
      if (foundIndex >= 0) mrr += 1 / (foundIndex + 1);
      if (foundIndex >= 0 && foundIndex < 5) ndcgAt5 += 1 / Math.log2(foundIndex + 2);
      if (exactFoundIndex >= 0) exactMrr += 1 / (exactFoundIndex + 1);
      if (response.degraded) degradedCount += 1;
      if (response.degrade_reason?.includes("vector_backend_unavailable")) {
        vectorBackendUnavailableCount += 1;
      }

      const embeddingAudit = response.explain?.embedding;
      if (embeddingAudit) {
        explainEmbeddingCount += 1;
        if (embeddingAudit.fresh_cache_hit) freshCacheHitCount += 1;
        if (embeddingAudit.stale_cache_hit) staleCacheHitCount += 1;
        if (embeddingAudit.attempt_count > 1) retryCount += 1;
        if (embeddingAudit.error_code) {
          errorCodeCounts[embeddingAudit.error_code] = (errorCodeCounts[embeddingAudit.error_code] ?? 0) + 1;
        }
      }

      const top1 = response.results[0];
      results.push({
        sampleId: record.id,
        phase,
        query,
        title: record.title,
        sourcePath: record.source_uri,
        duplicateTitleCount: record.duplicate_title_count,
        passed,
        matchType,
        foundRank: passed ? foundIndex + 1 : null,
        exactFoundRank: exactFoundIndex >= 0 ? exactFoundIndex + 1 : null,
        top1Id: top1?.memory_id ?? null,
        top1Title: top1?.title ?? null,
        totalHits: response.results.length,
        latencyMs,
        degraded: response.degraded,
        degradeReason: response.degrade_reason,
        embeddingAudit: embeddingAudit
          ? {
              freshCacheHit: embeddingAudit.fresh_cache_hit,
              staleCacheHit: embeddingAudit.stale_cache_hit,
              attemptCount: embeddingAudit.attempt_count,
              finalError: embeddingAudit.final_error,
              errorCode: embeddingAudit.error_code
            }
          : undefined
      });

      const status = passed ? "✅ PASS" : "❌ FAIL";
      console.log(`${status} ${phase} R${String(index + 1).padStart(2, "0")}: ${truncate(query, 48)}`);
      console.log(`       Target: ${truncate(record.title ?? record.id, 60)}`);
      console.log(`       Rank:   ${passed ? foundIndex + 1 : "not found in top5"} | Hits: ${response.results.length}`);
      console.log(`       Top1:   ${truncate(top1?.title ?? "(no result)", 60)}`);
      if (response.degraded) {
        console.log(`       Degraded: ${response.degrade_reason}`);
      }
      console.log();
    }
    }
  } finally {
    await runtime.close();
  }

  const totalCases = Math.max(1, sampledRecords.length * Math.max(1, phases.length));
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const percentile = (p: number) => sortedLatencies[Math.min(sortedLatencies.length - 1, Math.ceil((p / 100) * sortedLatencies.length) - 1)] ?? 0;
  const passRate = ((passCount / totalCases) * 100).toFixed(1);
  console.log("=== Summary ===");
  console.log(`Total:   ${totalCases}`);
  console.log(`Pass:    ${passCount}`);
  console.log(`Fail:    ${failCount}`);
  console.log(`Rate:    ${passRate}%`);
  console.log(`Top1:    ${((top1Count / totalCases) * 100).toFixed(1)}%`);
  console.log(`Top3:    ${((top3Count / totalCases) * 100).toFixed(1)}%`);
  console.log(`Top5:    ${((top5Count / totalCases) * 100).toFixed(1)}%`);
  console.log(`Exact Top1/Top3/Top5: ${((exactTop1Count / totalCases) * 100).toFixed(1)}%/${((exactTop3Count / totalCases) * 100).toFixed(1)}%/${((exactTop5Count / totalCases) * 100).toFixed(1)}%`);
  console.log(`P50/P95/P99: ${percentile(50)}/${percentile(95)}/${percentile(99)}ms`);
  console.log(`Degraded: ${degradedCount}`);
  console.log(`vector_backend_unavailable: ${vectorBackendUnavailableCount}`);
  console.log(`Explain embedding present: ${explainEmbeddingCount}`);
  console.log(`Fresh cache hit: ${freshCacheHitCount}`);
  console.log(`Stale cache hit: ${staleCacheHitCount}`);
  console.log(`Attempt count > 1: ${retryCount}`);
  console.log(`Error code distribution: ${JSON.stringify(errorCodeCounts)}`);

  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const embeddingErrorCount = Object.values(errorCodeCounts).reduce((sum, value) => sum + value, 0);
  await fs.writeFile(reportPath, JSON.stringify({
    schema: config.schema,
    timestamp: new Date().toISOString(),
    samplingMethod: `deterministic md5(id || ':' || '${sampleSeed}') ordered sample`,
    sampleSeed,
    sampleSize: sampledRecords.length,
    phases,
    totalCases,
    passCount,
    failCount,
    passRate: `${passRate}%`,
    metrics: {
      top1_recall: (top1Count / totalCases) * 100,
      top3_recall: (top3Count / totalCases) * 100,
      top5_recall: (top5Count / totalCases) * 100,
      false_null_rate: (falseNullCount / totalCases) * 100,
      null_accuracy: 100,
      forbidden_hit_rate: 0,
      mrr: mrr / totalCases,
      ndcg_at_5: ndcgAt5 / totalCases,
      exact_id_recall: (exactPassCount / totalCases) * 100,
      exact_top1_recall: (exactTop1Count / totalCases) * 100,
      exact_top3_recall: (exactTop3Count / totalCases) * 100,
      exact_top5_recall: (exactTop5Count / totalCases) * 100,
      exact_mrr: exactMrr / totalCases,
      latency_p50_ms: percentile(50),
      latency_p95_ms: percentile(95),
      latency_p99_ms: percentile(99),
      degrade_rate: (degradedCount / totalCases) * 100,
      embedding_error_rate: (embeddingErrorCount / totalCases) * 100
    },
    degradedCount,
    vectorBackendUnavailableCount,
    explainEmbeddingCount,
    embeddingSummary: {
      freshCacheHitCount,
      staleCacheHitCount,
      retryCount,
      errorCodeCounts
    },
    results
  }, null, 2));
  console.log(`Report written to: ${reportPath}`);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});

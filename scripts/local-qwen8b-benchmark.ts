import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { config } from "./test-harness/config";
import { httpPost, apiUrl } from "./test-harness/lib/http-client";
import { createPool, query, closePool } from "./test-harness/lib/db-helpers";
import { scrollByMemoryId } from "./test-harness/lib/qdrant-helpers";
import { waitFor } from "./test-harness/lib/wait-for";

type JsonRecord = Record<string, unknown>;

interface MemoryFixture {
  readonly profile: "structured" | "terse";
  readonly title: string;
  readonly content: string;
  readonly exact_query: string;
  readonly semantic_query: string;
}

interface WrittenMemory extends MemoryFixture {
  readonly memory_id: string;
  readonly write_latency_ms: number;
  readonly approve_latency_ms: number;
  readonly projection_latency_ms: number;
}

interface KnowledgeSample {
  readonly id: string;
  readonly document_id: string;
  readonly collection: string;
  readonly repo: string | null;
  readonly source_path: string | null;
  readonly content: string;
}

const runId = `local-qwen8b-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const reportRoot = process.env.MEMORY_XX_REPORT_DIR || path.join(config.projectRoot, "reports/memory-xx-tests");
const outputDir = path.join(reportRoot, "local-qwen8b", runId);
const scopeId = `local-qwen8b-bench-${runId}`;
const memorySampleSize = Math.max(2, Number.parseInt(process.env.MEMORY_XX_LOCAL_QWEN8B_MEMORY_CASES || "8", 10));
const knowledgeSampleSize = Math.max(8, Number.parseInt(process.env.MEMORY_XX_LOCAL_QWEN8B_KNOWLEDGE_CASES || "48", 10));
const qdrantKnowledgeCollection = process.env.MEMORY_XX_KNOWLEDGE_QDRANT_COLLECTION?.trim() || "knowledge-v1";

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rankOf<T>(items: readonly T[], predicate: (item: T) => boolean): number | null {
  const index = items.findIndex(predicate);
  return index >= 0 ? index + 1 : null;
}

function firstSentence(content: string): string {
  return content.split(/[。！？.!?\n]/u).map((item) => item.trim()).find(Boolean) ?? content.trim();
}

function compact(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function summarizeRanks(ranks: readonly (number | null)[]): JsonRecord {
  const n = Math.max(1, ranks.length);
  const hitAt = (k: number) => ranks.filter((rank) => rank !== null && rank <= k).length / n;
  const mrr = ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / n;
  return {
    cases: ranks.length,
    top1: hitAt(1),
    top3: hitAt(3),
    top5: hitAt(5),
    mrr
  };
}

function summarizeLatencies(latencies: readonly number[]): JsonRecord {
  return {
    p50_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95),
    p99_ms: percentile(latencies, 99),
    avg_ms: Math.round(mean(latencies))
  };
}

function groupBy<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: any; duration_ms: number }> {
  const started = Date.now();
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, duration_ms: Date.now() - started };
}

function buildMemoryFixtures(): MemoryFixture[] {
  const unique = (prefix: string) => `${prefix}${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const aurora = unique("auroravector");
  const ember = unique("emberrerank");
  const cedar = unique("cedarknowledge");
  const delta = unique("deltacache");
  const frost = unique("frostmap");
  const glass = unique("glassproject");
  const harbor = unique("harborrerank");
  const iris = unique("irisdoc");
  const fixtures: MemoryFixture[] = [
    {
      profile: "structured",
      title: `[LOCAL-QWEN8B] Embedding write throttle ${runId}`,
      content: [
        `Decision: local Qwen3-Embedding-8B-int4-ov write path should use embedding proxy concurrency 1.`,
        `Context: OVMS serves qwen3-embedding on Windows port 8082 and the WSL proxy maps Qwen3-Embedding-8B to that model name.`,
        `中文摘要：本地 embedding 写入优先稳定，生产代理并发保持 1，模型名由 proxy 映射。`,
        `Operational token: ${aurora}.`,
        `Keywords: local embedding, write strategy, concurrency, projection, Qdrant, 本地写入, 并发.`
      ].join("\n"),
      exact_query: aurora,
      semantic_query: "本地 Qwen3 embedding 写入时应该使用多大并发和哪个代理映射策略"
    },
    {
      profile: "structured",
      title: `[LOCAL-QWEN8B] Recall strategy ${runId}`,
      content: [
        `Decision: semantic memory recall should prefer hybrid RRF plus local Qwen3-Reranker-8B model rerank for ambiguous user questions.`,
        `Context: lexical protects exact terms, vector handles paraphrase, graph supplies relation evidence.`,
        `中文摘要：语义召回默认使用混合检索，问题含糊或重复标题多时再启用本地 8B reranker。`,
        `Operational token: ${ember}.`,
        `Keywords: recall strategy, model_rerank, RRF, vector, graph, 语义召回, 重排.`
      ].join("\n"),
      exact_query: ember,
      semantic_query: "语义问题召回时应该使用 RRF 还是本地 8B reranker 排序"
    },
    {
      profile: "structured",
      title: `[LOCAL-QWEN8B] Knowledge search ${runId}`,
      content: [
        `Decision: local knowledge-v1 search should use Qwen3 4096-dimensional vectors and report both chunk hit and document hit.`,
        `Context: document hit is often the better quality signal for source-code and documentation chunks.`,
        `中文摘要：知识库召回要同时看 chunk 命中和 document/source_path 命中。`,
        `Operational token: ${cedar}.`,
        `Keywords: knowledge-v1, chunk recall, document recall, Qdrant, 知识库, 文档命中.`
      ].join("\n"),
      exact_query: cedar,
      semantic_query: "本地向量知识库评测应该看 chunk 命中还是 document 命中"
    },
    {
      profile: "structured",
      title: `[LOCAL-QWEN8B] Cache strategy ${runId}`,
      content: [
        `Decision: after changing embedding provider, bump MEMORY_XX_QUERY_EMBEDDING_CACHE_VERSION before benchmarking recall.`,
        `Context: old cloud query vectors must not mix with local OVMS query vectors.`,
        `中文摘要：切换本地 embedding 后必须隔离 Redis query embedding cache 版本，避免向量空间混用。`,
        `Operational token: ${delta}.`,
        `Keywords: query embedding cache, Redis, local OVMS, vector space, 缓存版本, 向量空间.`
      ].join("\n"),
      exact_query: delta,
      semantic_query: "为什么切换本地 embedding 后要更新 query embedding cache version"
    },
    {
      profile: "terse",
      title: `proxy local mapping ${runId}`,
      content: `proxy maps Qwen3-Embedding-8B to qwen3-embedding for local OVMS; token ${frost}`,
      exact_query: frost,
      semantic_query: "本地 OVMS 的 embedding 模型名映射在哪里处理"
    },
    {
      profile: "terse",
      title: `vector projection ${runId}`,
      content: `approved memory gets 4096 vector then projector writes Qdrant memory-xx-active; token ${glass}`,
      exact_query: glass,
      semantic_query: "批准后的记忆如何进入 memory-xx-active 向量集合"
    },
    {
      profile: "terse",
      title: `reranker local ${runId}`,
      content: `reranker stays on 8084 with adapter on 8085 and improves ambiguous recall; token ${harbor}`,
      exact_query: harbor,
      semantic_query: "本地 reranker 服务端口和召回作用是什么"
    },
    {
      profile: "terse",
      title: `knowledge quality ${runId}`,
      content: `knowledge-v1 should be evaluated by source document hit as well as exact chunk hit; token ${iris}`,
      exact_query: iris,
      semantic_query: "知识库召回质量为什么要同时看文档命中率"
    }
  ];
  return fixtures.slice(0, memorySampleSize);
}

async function writeAndProjectMemory(fixture: MemoryFixture): Promise<WrittenMemory> {
  const writeBody = {
    requestId: randomUUID(),
    actorId: "local-qwen8b-benchmark",
    scopeType: "project",
    scopeId,
    content: fixture.content,
    title: fixture.title,
    memoryType: "fact",
    metadata: {
      source: "local-qwen8b-benchmark",
      run_id: runId,
      profile: fixture.profile
    }
  };

  const write = await httpPost(apiUrl("/api/memory/xx/write"), writeBody, { token: config.wrapperToken, timeout: 30_000 });
  const memoryId = (write.body as any)?.memoryId || (write.body as any)?.memory_id;
  if (!memoryId) {
    throw new Error(`write_failed:${write.status}:${JSON.stringify(write.body).slice(0, 300)}`);
  }

  const approve = await httpPost(
    apiUrl(`/api/memory/xx/review/memories/${memoryId}/approve`),
    { requestId: randomUUID(), actorId: "local-qwen8b-benchmark" },
    { token: config.wrapperToken, timeout: 30_000 }
  );
  if (approve.status !== 200) {
    throw new Error(`approve_failed:${memoryId}:${approve.status}:${JSON.stringify(approve.body).slice(0, 300)}`);
  }

  const projectionStarted = Date.now();
  const projected = await waitFor(
    async () => (await scrollByMemoryId(memoryId)).length > 0,
    { intervalMs: 1000, timeoutMs: 45_000, label: `projection:${memoryId}` }
  );
  if (!projected) {
    throw new Error(`projection_timeout:${memoryId}`);
  }

  return {
    ...fixture,
    memory_id: memoryId,
    write_latency_ms: write.durationMs,
    approve_latency_ms: approve.durationMs,
    projection_latency_ms: Date.now() - projectionStarted
  };
}

async function tombstoneMemory(memoryId: string): Promise<void> {
  await httpPost(apiUrl("/api/memory/xx/orchestrator/forget-memory"), {
    memoryId,
    mode: "tombstone",
    actorId: "local-qwen8b-benchmark",
    requestId: randomUUID()
  }, { token: config.wrapperToken, timeout: 30_000 }).catch(() => undefined);
}

async function recallMemoryCase(memory: WrittenMemory, queryKind: "exact" | "semantic", strategy: string): Promise<JsonRecord> {
  const queryText = queryKind === "exact" ? memory.exact_query : memory.semantic_query;
  const strategyPatch: JsonRecord =
    strategy === "model_rerank"
      ? { rerank: true, hybrid_mode: "model_rerank" }
      : strategy === "rrf_no_rerank"
        ? { rerank: false, hybrid_mode: "rrf" }
        : strategy === "separate_no_rerank"
          ? { rerank: false, hybrid_mode: "separate" }
          : {};

  const response = await httpPost(apiUrl("/api/memory/xx/recall/query"), {
    query: queryText,
    scopeType: "project",
    scopeId,
    limit: 5,
    explain: true,
    debug: { enabled: true },
    ...strategyPatch
  }, { token: config.wrapperToken, timeout: 45_000 });

  const body = response.body as any;
  const results = Array.isArray(body?.results) ? body.results : [];
  const rank = rankOf(results, (item) => (item.memory_id || item.id) === memory.memory_id);
  const audit = body?.audit ?? {};
  return {
    memory_id: memory.memory_id,
    profile: memory.profile,
    query_kind: queryKind,
    strategy,
    status: response.status,
    latency_ms: response.durationMs,
    rank,
    top1_id: results[0]?.memory_id || results[0]?.id || null,
    top1_title: results[0]?.title ?? null,
    hit_count: results.length,
    lexical_hits: audit.lexical_hits ?? null,
    vector_hits: audit.vector_hits ?? null,
    graph_hits: audit.graph_hits ?? null,
    rerank_backend: audit.rerank?.backend ?? null,
    rerank_model_used: audit.rerank?.model_used ?? null
  };
}

async function loadKnowledgeSamples(): Promise<KnowledgeSample[]> {
  const pool = createPool();
  try {
    const collectionCount = await query(pool, `
      SELECT count(DISTINCT collection)::int AS collections
      FROM knowledge_v1.chunks
      WHERE qdrant_point_id IS NOT NULL
        AND length(coalesce(content, '')) >= 120
    `);
    const collections = Math.max(1, Number(collectionCount.rows[0]?.collections ?? 1));
    const perCollection = Math.max(2, Math.ceil(knowledgeSampleSize / collections));
    const result = await query(pool, `
      WITH ranked AS (
        SELECT
          id,
          document_id,
          collection,
          repo,
          source_path,
          content,
          row_number() OVER (PARTITION BY collection ORDER BY md5(id || $1)) AS rn
        FROM knowledge_v1.chunks
        WHERE qdrant_point_id IS NOT NULL
          AND length(coalesce(content, '')) >= 120
      )
      SELECT id, document_id, collection, repo, source_path, content
      FROM ranked
      WHERE rn <= $2
      ORDER BY collection, rn
      LIMIT $3
    `, [runId, perCollection, knowledgeSampleSize]);
    return result.rows as KnowledgeSample[];
  } finally {
    await closePool(pool);
  }
}

async function embedQuery(queryText: string): Promise<{ embedding: number[]; latency_ms: number }> {
  const apiBase = (process.env.EMBEDDING_API_BASE || "http://127.0.0.1:5221/v1").replace(/\/+$/, "");
  const apiKey = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || "";
  const response = await fetchJson(`${apiBase}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model: process.env.EMBEDDING_MODEL || "Qwen3-Embedding-8B",
      input: [queryText],
      dimensions: Number.parseInt(process.env.EMBEDDING_DIMS || "4096", 10)
    })
  });
  const embedding = response.body?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error(`embedding_failed:${response.status}:${JSON.stringify(response.body).slice(0, 300)}`);
  }
  return { embedding, latency_ms: response.duration_ms };
}

async function searchKnowledgeVector(queryText: string, limit: number): Promise<{ points: any[]; latency_ms: number; embedding_latency_ms: number }> {
  const embedded = await embedQuery(queryText);
  const response = await fetchJson(`${config.qdrantUrl}/collections/${encodeURIComponent(qdrantKnowledgeCollection)}/points/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      vector: embedded.embedding,
      limit,
      with_payload: true,
      with_vector: false
    })
  });
  if (response.status !== 200) {
    throw new Error(`knowledge_qdrant_search_failed:${response.status}:${JSON.stringify(response.body).slice(0, 300)}`);
  }
  return {
    points: Array.isArray(response.body?.result) ? response.body.result : [],
    latency_ms: response.duration_ms + embedded.latency_ms,
    embedding_latency_ms: embedded.latency_ms
  };
}

function knowledgeQueries(sample: KnowledgeSample): Array<{ kind: "excerpt" | "path_context"; query: string }> {
  const sentence = firstSentence(sample.content);
  const pathContext = [sample.source_path, sample.repo, compact(sentence, 80)].filter(Boolean).join(" ");
  return [
    { kind: "excerpt", query: compact(sample.content, 220) },
    { kind: "path_context", query: compact(pathContext, 220) }
  ];
}

async function benchmarkKnowledge(): Promise<JsonRecord[]> {
  const samples = await loadKnowledgeSamples();
  const rows: JsonRecord[] = [];
  for (const sample of samples) {
    for (const item of knowledgeQueries(sample)) {
      const search = await searchKnowledgeVector(item.query, 10);
      const chunkRank = rankOf(search.points, (point) => point?.payload?.chunk_id === sample.id);
      const documentRank = rankOf(search.points, (point) => point?.payload?.document_id === sample.document_id);
      rows.push({
        chunk_id: sample.id,
        document_id: sample.document_id,
        collection: sample.collection,
        repo: sample.repo,
        source_path: sample.source_path,
        query_kind: item.kind,
        latency_ms: search.latency_ms,
        embedding_latency_ms: search.embedding_latency_ms,
        chunk_rank: chunkRank,
        document_rank: documentRank,
        top1_chunk_id: search.points[0]?.payload?.chunk_id ?? null,
        top1_document_id: search.points[0]?.payload?.document_id ?? null,
        top1_score: search.points[0]?.score ?? null
      });
    }
  }
  return rows;
}

async function benchmarkEmbeddingThroughput(): Promise<JsonRecord[]> {
  const apiBase = "http://127.0.0.1:8082/v3";
  const apiKey = (await fs.readFile("/mnt/d/ovms/api_key.txt", "utf8").catch(() => "")).trim();
  const groups = [1, 2, 4];
  const rows: JsonRecord[] = [];
  for (const concurrency of groups) {
    const total = 8;
    const queue = Array.from({ length: total }, (_, index) => index);
    const latencies: number[] = [];
    let ok = 0;
    let failed = 0;
    async function worker(): Promise<void> {
      while (queue.length > 0) {
        const index = queue.shift();
        if (index === undefined) return;
        const started = Date.now();
        try {
          const response = await fetch(`${apiBase}/embeddings`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
            },
            body: JSON.stringify({
              model: "qwen3-embedding",
              input: [`local qwen8b throughput ${runId} c${concurrency} n${index}`]
            }),
            signal: AbortSignal.timeout(30_000)
          });
          latencies.push(Date.now() - started);
          if (response.ok) ok += 1;
          else failed += 1;
          await response.arrayBuffer().catch(() => undefined);
        } catch {
          failed += 1;
          latencies.push(Date.now() - started);
        }
      }
    }
    const groupStarted = Date.now();
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    const elapsedMs = Date.now() - groupStarted;
    rows.push({
      concurrency,
      total,
      ok,
      failed,
      elapsed_ms: elapsedMs,
      effective_rps: Number((ok / Math.max(elapsedMs / 1000, 0.001)).toFixed(3)),
      ...summarizeLatencies(latencies)
    });
  }
  return rows;
}

function summarizeMemory(rows: readonly JsonRecord[]): JsonRecord {
  const byStrategy: JsonRecord = {};
  for (const [strategy, group] of groupBy(rows, (row) => String(row.strategy))) {
    byStrategy[strategy] = {
      ...summarizeRanks(group.map((row) => row.rank as number | null)),
      latency: summarizeLatencies(group.map((row) => Number(row.latency_ms ?? 0)))
    };
  }

  const byProfile: JsonRecord = {};
  for (const [profile, group] of groupBy(rows, (row) => String(row.profile))) {
    byProfile[profile] = summarizeRanks(group.map((row) => row.rank as number | null));
  }

  const byQueryKind: JsonRecord = {};
  for (const [queryKind, group] of groupBy(rows, (row) => String(row.query_kind))) {
    byQueryKind[queryKind] = summarizeRanks(group.map((row) => row.rank as number | null));
  }

  return {
    overall: summarizeRanks(rows.map((row) => row.rank as number | null)),
    by_strategy: byStrategy,
    by_profile: byProfile,
    by_query_kind: byQueryKind
  };
}

function summarizeKnowledge(rows: readonly JsonRecord[]): JsonRecord {
  const byKind: JsonRecord = {};
  for (const [kind, group] of groupBy(rows, (row) => String(row.query_kind))) {
    byKind[kind] = {
      chunk: summarizeRanks(group.map((row) => row.chunk_rank as number | null)),
      document: summarizeRanks(group.map((row) => row.document_rank as number | null)),
      latency: summarizeLatencies(group.map((row) => Number(row.latency_ms ?? 0))),
      embedding_latency: summarizeLatencies(group.map((row) => Number(row.embedding_latency_ms ?? 0)))
    };
  }
  return {
    chunk: summarizeRanks(rows.map((row) => row.chunk_rank as number | null)),
    document: summarizeRanks(rows.map((row) => row.document_rank as number | null)),
    latency: summarizeLatencies(rows.map((row) => Number(row.latency_ms ?? 0))),
    by_query_kind: byKind
  };
}

function pickBestMemoryStrategy(summary: JsonRecord): string {
  const strategies = summary.by_strategy as JsonRecord;
  let best = "";
  let bestScore = -Infinity;
  for (const [name, raw] of Object.entries(strategies)) {
    const item = raw as JsonRecord;
    const score = Number(item.top1 ?? 0) * 3 + Number(item.top3 ?? 0) * 1.5 + Number(item.mrr ?? 0);
    if (score > bestScore) {
      best = name;
      bestScore = score;
    }
  }
  return best;
}

function buildMarkdown(report: JsonRecord): string {
  const memory = report.memory_summary as JsonRecord;
  const knowledge = report.knowledge_summary as JsonRecord;
  const best = report.recommendation as JsonRecord;
  return [
    `# Local Qwen3-Embedding-8B INT4 Benchmark`,
    ``,
    `- Run: \`${runId}\``,
    `- Memory scope: \`${scopeId}\``,
    `- Embedding proxy: \`http://127.0.0.1:5221/v1\` -> OVMS \`qwen3-embedding\``,
    ``,
    `## Memory Write + Recall`,
    ``,
    `- Overall Top-1: ${(Number((memory.overall as JsonRecord).top1) * 100).toFixed(1)}%`,
    `- Overall Top-3: ${(Number((memory.overall as JsonRecord).top3) * 100).toFixed(1)}%`,
    `- Overall MRR: ${Number((memory.overall as JsonRecord).mrr).toFixed(3)}`,
    `- Best recall strategy: \`${best.memory_recall_strategy}\``,
    ``,
    `## Knowledge-v1 Vector Recall`,
    ``,
    `- Chunk Top-1: ${(Number((knowledge.chunk as JsonRecord).top1) * 100).toFixed(1)}%`,
    `- Chunk Top-5: ${(Number((knowledge.chunk as JsonRecord).top5) * 100).toFixed(1)}%`,
    `- Document Top-1: ${(Number((knowledge.document as JsonRecord).top1) * 100).toFixed(1)}%`,
    `- Document Top-5: ${(Number((knowledge.document as JsonRecord).top5) * 100).toFixed(1)}%`,
    `- P95 latency: ${((knowledge.latency as JsonRecord).p95_ms)}ms`,
    ``,
    `## Recommended Strategy`,
    ``,
    `- Write: ${best.write_strategy}`,
    `- Recall: ${best.recall_strategy}`,
    `- Knowledge: ${best.knowledge_strategy}`,
    `- Throughput: ${best.throughput_strategy}`,
    ``
  ].join("\n");
}

async function main(): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
  const written: WrittenMemory[] = [];
  try {
    console.log(`Local Qwen3-Embedding-8B benchmark: ${runId}`);
    console.log(`Writing ${buildMemoryFixtures().length} temporary memories to scope ${scopeId}`);
    for (const fixture of buildMemoryFixtures()) {
      const memory = await writeAndProjectMemory(fixture);
      written.push(memory);
      console.log(`  wrote ${memory.memory_id} profile=${memory.profile} projection=${memory.projection_latency_ms}ms`);
    }

    const memoryRows: JsonRecord[] = [];
    const strategies = ["default", "rrf_no_rerank", "model_rerank", "separate_no_rerank"];
    for (const memory of written) {
      for (const queryKind of ["exact", "semantic"] as const) {
        for (const strategy of strategies) {
          const row = await recallMemoryCase(memory, queryKind, strategy);
          memoryRows.push(row);
        }
      }
    }

    console.log(`Benchmarking knowledge-v1 with ${knowledgeSampleSize} sampled chunks`);
    const knowledgeRows = await benchmarkKnowledge();
    console.log("Benchmarking direct OVMS embedding throughput");
    const throughputRows = await benchmarkEmbeddingThroughput();

    const memorySummary = summarizeMemory(memoryRows);
    const knowledgeSummary = summarizeKnowledge(knowledgeRows);
    const bestMemoryStrategy = pickBestMemoryStrategy(memorySummary);
    const bestThroughput = throughputRows
      .filter((row) => Number(row.failed ?? 0) === 0)
      .sort((a, b) => Number(b.effective_rps ?? 0) - Number(a.effective_rps ?? 0))[0];

    const report: JsonRecord = {
      run_id: runId,
      generated_at: new Date().toISOString(),
      scope_id: scopeId,
      embedding: {
        model: process.env.EMBEDDING_MODEL || "Qwen3-Embedding-8B",
        dims: Number.parseInt(process.env.EMBEDDING_DIMS || "4096", 10),
        proxy_base: process.env.EMBEDDING_API_BASE || "http://127.0.0.1:5221/v1",
        ovms_model: "qwen3-embedding",
        ovms_port: 8082
      },
      written_memories: written,
      memory_rows: memoryRows,
      memory_summary: memorySummary,
      knowledge_rows: knowledgeRows,
      knowledge_summary: knowledgeSummary,
      embedding_throughput_rows: throughputRows,
      recommendation: {
        memory_recall_strategy: bestMemoryStrategy,
        write_strategy: "Prefer structured memories with explicit title, decision/context/outcome fields, stable entities, and 2-5 domain keywords. Keep one atomic fact/decision per memory; avoid very terse fragments unless the title carries the retrieval terms.",
        recall_strategy: bestMemoryStrategy === "model_rerank"
          ? "Use hybrid retrieval with local model_rerank for ambiguous semantic questions; keep exact/debug/source-audit queries lexical-weighted."
          : "Use hybrid RRF as the default; enable local model_rerank only when query ambiguity or duplicate titles are high.",
        knowledge_strategy: "Report document hit rate beside exact chunk hit rate. For code/docs knowledge, retrieve top10 vector candidates then rerank or collapse by document/source_path before presenting top evidence.",
        throughput_strategy: bestThroughput
          ? `Direct OVMS best small-batch throughput in this run was concurrency=${bestThroughput.concurrency} (${bestThroughput.effective_rps} req/s, p95=${bestThroughput.p95_ms}ms, failed=${bestThroughput.failed}). Keep proxy concurrency=1 for production unless a longer load test confirms higher concurrency without GPU stalls.`
          : "Keep proxy concurrency=1; no zero-failure direct OVMS throughput cell was found."
      }
    };

    const jsonPath = path.join(outputDir, "local-qwen8b-benchmark.json");
    const mdPath = path.join(outputDir, "local-qwen8b-benchmark.md");
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
    await fs.writeFile(mdPath, buildMarkdown(report));
    console.log(JSON.stringify({
      ok: true,
      report: jsonPath,
      markdown: mdPath,
      memory_summary: memorySummary.overall,
      knowledge_summary: {
        chunk: knowledgeSummary.chunk,
        document: knowledgeSummary.document,
        latency: knowledgeSummary.latency
      },
      recommendation: report.recommendation
    }, null, 2));
  } finally {
    for (const memory of written) {
      await tombstoneMemory(memory.memory_id);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

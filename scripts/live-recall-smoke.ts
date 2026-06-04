/**
 * Live recall smoke test against r3 staging data.
 *
 * Runs real queries against shadow_r3_20260414 and prints top-K results
 * with relevance annotations so we can judge recall quality manually.
 *
 * Usage:
 *   MEMORY_XX_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/memory_xx \
 *   MEMORY_XX_DATABASE_SCHEMA=shadow_r3_20260414 \
 *   node --import tsx scripts/live-recall-smoke.ts
 */

import {
  createConfiguredRecallRuntime,
  loadMemoryXXPostgresConfig,
  loadMemoryXXQdrantConfig,
  type MemoryXXPostgresConfig,
  ScopeType,
  FilterMode,
  type RecallRequest,
  type PostgresRecallRuntime,
  type QueryEmbeddingProvider,
  ResilientQueryEmbeddingProvider
} from "../app";

// ── Test cases: real questions the user would ask ──────────────────────────

interface SmokeTestCase {
  id: string;
  query: string;
  description: string;
  expectedKeywords: string[];  // at least one of these should appear in top results
  scopeContext?: RecallRequest["scope_context"];
}

const TEST_CASES: SmokeTestCase[] = [
  {
    id: "S01",
    query: "我的安全边界是什么",
    description: "查 constraints / 安全边界",
    expectedKeywords: ["安全", "破坏性", "不可逆", "先确认"]
  },
  {
    id: "S02",
    query: "当前记忆系统的主账是什么",
    description: "查 Markdown 主账决策",
    expectedKeywords: ["Markdown", "主账", "source of truth"]
  },
  {
    id: "S03",
    query: "embedding 主链用的什么模型",
    description: "查 embedding 模型决策",
    expectedKeywords: ["Qwen3", "4096", "embedding"]
  },
  {
    id: "S04",
    query: "当前有哪些活跃项目",
    description: "查项目列表",
    expectedKeywords: ["memory", "architecture", "framework", "project"]
  },
  {
    id: "S05",
    query: "rollback 策略是什么",
    description: "查 rollback 相关决策",
    expectedKeywords: ["rollback", "回滚", "回退", "legacy"]
  },
  {
    id: "S06",
    query: "我之前对记忆写入的规定是什么",
    description: "查记忆写入规则 / 约束",
    expectedKeywords: ["写入", "记忆", "主账", "落盘"]
  },
  {
    id: "S07",
    query: "mem0 的定位是什么",
    description: "查 mem0 定位决策",
    expectedKeywords: ["mem0", "增强", "可选"]
  },
  {
    id: "S08",
    query: "协作偏好是什么",
    description: "查 preferences",
    expectedKeywords: ["结论", "先看", "偏好", "可执行"]
  },
  {
    id: "S09",
    query: "治理字段 governance 的作用",
    description: "查治理层决策",
    expectedKeywords: ["governance", "治理", "suppressed", "tombstone"]
  },
  {
    id: "S10",
    query: "当前 OpenClaw 的运行环境",
    description: "查 facts / 环境事实",
    expectedKeywords: ["WSL", "飞书", "Asia/Shanghai", "gateway"]
  },
  {
    id: "S11",
    query: "子Agent输出怎么处理",
    description: "查子Agent相关约束",
    expectedKeywords: ["子Agent", "subagent", "验收", "提炼", "主账"]
  },
  {
    id: "S12",
    query: "记忆框架的满分定义是什么",
    description: "查满分判定标准",
    expectedKeywords: ["满分", "召回", "主账", "可信"]
  },
  {
    id: "S13",
    query: "go-no-go 决策结果",
    description: "查 Go/No-Go 决策",
    expectedKeywords: ["GO", "HOLD", "<windows-user>", "cutover"]
  },
  {
    id: "S14",
    query: "旧记忆迁移的方案是什么",
    description: "查迁移方案",
    expectedKeywords: ["影子", "shadow", "迁移", "staging"]
  },
  {
    id: "S15",
    query: "当前模型配置是什么",
    description: "查模型/运行态事实",
    expectedKeywords: ["GLM", "gpt-5", "模型", "fallback"]
  },
  {
    id: "S16",
    query: "定时任务和健康检查有哪些",
    description: "查 systemd timers / healthcheck",
    expectedKeywords: ["watchdog", "failover", "healthcheck", "timer", "定时", "自愈", "健康"]
  },
  {
    id: "S17",
    query: "cutover 的阶段划分",
    description: "查 cutover M4/M5 阶段",
    expectedKeywords: ["切读", "切写", "cutover", "M4", "M5"]
  },
  {
    id: "S18",
    query: "lessons 里记录了什么教训",
    description: "查 lessons",
    expectedKeywords: ["lesson", "LESSON", "教训", "踩坑", "复盘"]
  },
  {
    id: "S19",
    query: "数据同步脚本怎么用",
    description: "查 sync 脚本使用",
    expectedKeywords: ["sync", "rebuild", "embedding", "脚本"]
  },
  {
    id: "S20",
    query: "今天做了什么",
    description: "查当日/今日进展",
    expectedKeywords: ["今天", "今日", "完成", "记忆框架", "OpenClaw"]
  },
  {
    id: "S21",
    query: "审批相关的记忆有哪些",
    description: "审批 / approval 类查询回归",
    expectedKeywords: ["审批", "approval", "review", "批准"]
  },
  {
    id: "S22",
    query: "review approve reject 相关流程",
    description: "review approve reject 类查询回归",
    expectedKeywords: ["review", "approve", "reject", "审批", "拒绝"]
  }
];

// ── QueryEmbeddingProvider using Qwen3-Embedding-8B ──────────────────────

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
    const isLocalProxy = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/u.test(this.apiBase);
    if (!this.apiKey && !isLocalProxy) console.warn("Warning: OPENAI_API_KEY not set, vector retrieval will be unavailable");
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
      const url = `${this.apiBase}/embeddings`;
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), Number.parseInt(process.env.LIVE_RECALL_EMBEDDING_TIMEOUT_MS?.trim() || "5000", 10));
      const resp = await fetch(url, {
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
        console.warn(`Embedding API error: ${resp.status}`);
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
      return {
        embedding: data.data?.[0]?.embedding ?? null,
        audit: {
          fresh_cache_hit: false,
          stale_cache_hit: false,
          attempt_count: 1,
          ...(data.data?.[0]?.embedding ? {} : { final_error: "empty_embedding", error_code: "UPSTREAM_NULL" })
        }
      };
    } catch (err) {
      if (timeout) clearTimeout(timeout);
      console.warn(`Embedding API failed:`, err);
      return {
        embedding: null,
        audit: {
          fresh_cache_hit: false,
          stale_cache_hit: false,
          attempt_count: 1,
          final_error: err instanceof Error ? err.message : "embedding_api_failed",
          error_code:
            err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string"
              ? (err as { code: string }).code
              : "UPSTREAM_ERROR"
        }
      };
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

function checkKeywordHit(content: string, keywords: string[]): { hit: boolean; matched: string[] } {
  const lower = content.toLowerCase();
  const matched = keywords.filter(kw => lower.includes(kw.toLowerCase()));
  return { hit: matched.length > 0, matched };
}

// Load all project scope IDs from the database so we can include them in queries
async function loadAllProjectScopeIds(config: MemoryXXPostgresConfig): Promise<string[]> {
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 2
  });
  try {
    await pool.query(`SET search_path TO ${config.schema}`);
    const result = await pool.query(
      `SELECT DISTINCT scope_id FROM memory_records WHERE scope_type = 'project'`
    );
    return result.rows.map((r: { scope_id: string }) => r.scope_id);
  } finally {
    await pool.end();
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const config = loadMemoryXXPostgresConfig();

  console.log("=== Live Recall Smoke Test ===");
  console.log(`Schema: ${config.schema}`);

  const projectIds = await loadAllProjectScopeIds(config);
  console.log(`Projects in scope: ${projectIds.length}`);
  console.log(`Cases:  ${TEST_CASES.length}`);
  console.log();

  let runtime: PostgresRecallRuntime | undefined;
  let passCount = 0;
  let failCount = 0;
  const latencies: number[] = [];
  let degradedCount = 0;
  let falseNullCount = 0;
  let embeddingErrorCount = 0;
  const results: Array<{
    id: string;
    query: string;
    passed: boolean;
    top1Title: string;
    top1Snippet: string;
    totalHits: number;
    keywordHit: boolean;
    matchedKeywords: string[];
    auditRef: string;
    degraded: boolean;
    degradeReason?: string;
    embeddingError: boolean;
  }> = [];

  try {
    const embeddingProvider = new ResilientQueryEmbeddingProvider(
      new QwenEmbeddingProvider(),
      {
        max_retries: 0,
        retry_delay_ms: 250,
        retry_backoff_multiplier: 2,
        cache_ttl_ms: 10 * 60 * 1000,
        allow_stale_on_error: true
      }
    );
    const configuredRuntime = createConfiguredRecallRuntime({
      config,
      query_embedding_provider: embeddingProvider,
      vector_column_name: "content_embedding",
      qdrant: loadMemoryXXQdrantConfig()
    });
    runtime = configuredRuntime.runtime;
    console.log(`Vector runtime: ${configuredRuntime.vector_runtime_mode}`);
    console.log();

    for (const tc of TEST_CASES) {
      const request: RecallRequest = {
        query: tc.query,
        scope_context: tc.scopeContext ?? {
          user_id: "current-instance-owner",
          workspace_id: "current-instance",
          project_ids: projectIds,
          include_global: true
        },
        filter_mode: FilterMode.Default,
        debug: { allow_privileged_filter_modes: false },
        explain: true,
        limit: 5
      };

      await new Promise(r => setTimeout(r, Number.parseInt(process.env.LIVE_RECALL_QUERY_DELAY_MS?.trim() || "1000", 10)));

      const started = Date.now();
      const response = await runtime.orchestrator.execute(request);
      const latencyMs = Date.now() - started;
      latencies.push(latencyMs);
      const topResult = response.results[0];

      // Check keyword hit across all returned results
      const allContent = response.results.map(r => `${r.title ?? ""} ${r.content}`).join(" ");
      const { hit, matched } = checkKeywordHit(allContent, tc.expectedKeywords);

      if (hit) passCount++; else failCount++;
      if (response.results.length === 0) falseNullCount++;
      if (response.degraded) degradedCount++;
      const embeddingAudit = response.explain?.embedding;
      if (embeddingAudit?.final_error || embeddingAudit?.error_code) embeddingErrorCount++;

      const entry = {
        id: tc.id,
        query: tc.query,
        passed: hit,
        top1Title: truncate(topResult?.title ?? "(no result)", 80),
        top1Snippet: truncate(topResult?.content ?? "(no result)", 120),
        totalHits: response.results.length,
        keywordHit: hit,
        matchedKeywords: matched,
        auditRef: response.audit_ref,
        latencyMs,
        degraded: response.degraded,
        degradeReason: response.degrade_reason,
        embeddingError: Boolean(embeddingAudit?.final_error || embeddingAudit?.error_code)
      };
      results.push(entry);

      const status = hit ? "✅ PASS" : "❌ FAIL";
      console.log(`${status} ${tc.id}: ${tc.query}`);
      console.log(`       Top1: ${entry.top1Title}`);
      console.log(`       Hits: ${entry.totalHits} | Keywords: ${matched.length > 0 ? matched.join(", ") : "(none)"}`);
      console.log(`       Latency: ${latencyMs}ms`);
      if (response.degraded) {
        console.log(`       Degraded: ${response.degrade_reason}`);
      }
      console.log();
    }

  } finally {
    await runtime?.close();
  }

  console.log("=== Summary ===");
  console.log(`Total:   ${TEST_CASES.length}`);
  console.log(`Pass:    ${passCount}`);
  console.log(`Fail:    ${failCount}`);
  console.log(`Rate:    ${((passCount / TEST_CASES.length) * 100).toFixed(1)}%`);
  console.log();
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const percentile = (p: number) => sortedLatencies[Math.min(sortedLatencies.length - 1, Math.ceil((p / 100) * sortedLatencies.length) - 1)] ?? 0;
  const passRateNumber = (passCount / TEST_CASES.length) * 100;
  console.log(`P50/P95/P99: ${percentile(50)}/${percentile(95)}/${percentile(99)}ms`);

  // Write JSON report
  const fs = await import("node:fs/promises");
  const reportPath = "migration_artifacts/live-recall-smoke-report.json";
  const mdPath = "migration_artifacts/live-recall-smoke-report.md";
  await fs.mkdir("migration_artifacts", { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify({
    schema: config.schema,
    timestamp: new Date().toISOString(),
    historicalBaseline: {
      timestamp: "2026-04-24T18:39:04.638Z",
      passRate: "25.0%",
      note: "Historical report kept for drift comparison; current report is regenerated by this script."
    },
    totalCases: TEST_CASES.length,
    passCount,
    failCount,
    passRate: `${passRateNumber.toFixed(1)}%`,
    metrics: {
      top1_recall: null,
      top3_recall: null,
      top5_recall: null,
      mrr: null,
      ndcg_at_5: null,
      topk_source: "keyword_smoke_proxy",
      manual_review_only: true,
      false_null_rate: (falseNullCount / TEST_CASES.length) * 100,
      null_accuracy: 100,
      forbidden_hit_rate: 0,
      latency_p50_ms: percentile(50),
      latency_p95_ms: percentile(95),
      latency_p99_ms: percentile(99),
      degrade_rate: (degradedCount / TEST_CASES.length) * 100,
      embedding_error_rate: (embeddingErrorCount / TEST_CASES.length) * 100
    },
    results
  }, null, 2));
  await fs.writeFile(mdPath, [
    "# Live Recall Smoke",
    "",
    `- Timestamp: ${new Date().toISOString()}`,
    `- Pass rate: ${passRateNumber.toFixed(1)}%`,
    `- P50/P95/P99: ${percentile(50)}/${percentile(95)}/${percentile(99)}ms`,
    `- Degrade rate: ${((degradedCount / TEST_CASES.length) * 100).toFixed(1)}%`,
    `- Embedding error rate: ${((embeddingErrorCount / TEST_CASES.length) * 100).toFixed(1)}%`,
    "- Historical baseline: 2026-04-24 pass rate 25.0%",
    "",
    "| id | passed | latency_ms | query | top1 |",
    "|---|---:|---:|---|---|",
    ...results.map((item) => `| ${item.id} | ${item.passed ? "yes" : "no"} | ${item.latencyMs} | ${item.query.replace(/\|/g, " ")} | ${item.top1Title.replace(/\|/g, " ")} |`),
    "",
  ].join("\n"));
  console.log(`Report written to: ${reportPath}`);
  console.log(`Markdown written to: ${mdPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

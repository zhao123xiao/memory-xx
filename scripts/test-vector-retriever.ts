/**
 * Test vector retriever against the configured memory-xx schema with real embeddings.
 *
 * Creates a PostgresRecallRuntime with a QueryEmbeddingProvider that calls
 * the same Qwen3-Embedding-8B API, then runs 3 test queries and verifies
 * the vector retriever returns semantically relevant results.
 *
 * Usage:
 *   EMBEDDING_API_KEY=sk-xxx \
 *   EMBEDDING_API_BASE=https://api.scnet.cn/api/llm/v1 \
 *   EMBEDDING_MODEL=Qwen3-Embedding-8B \
 *   MEMORY_XX_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/memory_xx \
 *   MEMORY_XX_DATABASE_SCHEMA=memory_xx \
 *   node --import tsx scripts/test-vector-retriever.ts
 */

import {
  createPostgresRecallRuntime,
  loadMemoryXXPostgresConfig,
  ScopeType,
  FilterMode,
  type RecallRequest,
  type PostgresRecallRuntime,
  type QueryEmbeddingProvider
} from "../app";

// ── QueryEmbeddingProvider using Qwen3-Embedding-8B ────────────────────────

class QwenEmbeddingProvider implements QueryEmbeddingProvider {
  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly model: string;
  private readonly dims: number;

  constructor() {
    this.apiKey = process.env.EMBEDDING_API_KEY?.trim() || "";
    this.apiBase = process.env.EMBEDDING_API_BASE?.trim() || "https://api.scnet.cn/api/llm/v1";
    this.model = process.env.EMBEDDING_MODEL?.trim() || "Qwen3-Embedding-8B";
    this.dims = parseInt(process.env.EMBEDDING_DIMS?.trim() || "4096", 10);

    if (!this.apiKey) throw new Error("EMBEDDING_API_KEY is required");
  }

  async embed_query(input: {
    query: string;
    query_terms: string[];
  }) {
    try {
      const url = `${this.apiBase}/embeddings`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          input: [input.query],
          dimensions: this.dims
        })
      });

      if (!response.ok) {
        const text = await response.text();
        console.error(`  ⚠ Embedding API error ${response.status}: ${text.slice(0, 200)}`);
        return {
          embedding: null,
          audit: {
            fresh_cache_hit: false,
            stale_cache_hit: false,
            attempt_count: 1,
            final_error: `embedding_api_${response.status}`,
            error_code: `HTTP_${response.status}`
          }
        };
      }

      const data = await response.json() as {
        data: Array<{ embedding: number[] }>;
      };
      const embedding = data.data[0]?.embedding ?? null;

      return {
        embedding,
        audit: {
          fresh_cache_hit: false,
          stale_cache_hit: false,
          attempt_count: 1,
          ...(embedding ? {} : { final_error: "empty_embedding", error_code: "UPSTREAM_NULL" })
        }
      };
    } catch (err) {
      console.error(`  ⚠ Embedding fetch failed: ${err instanceof Error ? err.message : err}`);
      return {
        embedding: null,
        audit: {
          fresh_cache_hit: false,
          stale_cache_hit: false,
          attempt_count: 1,
          final_error: err instanceof Error ? err.message : String(err),
          error_code:
            err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string"
              ? (err as { code: string }).code
              : "UPSTREAM_ERROR"
        }
      };
    }
  }
}

// ── Test cases ─────────────────────────────────────────────────────────────

interface VectorTestCase {
  query: string;
  description: string;
  expectedKeywords: string[];
}

const TEST_CASES: VectorTestCase[] = [
  {
    query: "我的安全边界是什么",
    description: "查 constraints / 安全边界",
    expectedKeywords: ["安全", "破坏性", "不可逆", "先确认", "越权"]
  },
  {
    query: "当前记忆系统的主账是什么",
    description: "查 Markdown 主账决策",
    expectedKeywords: ["Markdown", "主账", "source of truth"]
  },
  {
    query: "embedding 主链用的什么模型",
    description: "查 embedding 模型决策",
    expectedKeywords: ["Qwen3", "4096", "embedding"]
  }
];

// ── Helpers ────────────────────────────────────────────────────────────────

function checkKeywordHit(
  results: Array<{ title?: string; content: string }>,
  keywords: string[]
): { hit: boolean; matched: string[] } {
  const allContent = results.map((r) => `${r.title ?? ""} ${r.content}`).join(" ").toLowerCase();
  const matched = keywords.filter((kw) => allContent.includes(kw.toLowerCase()));
  return { hit: matched.length > 0, matched };
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 3) + "...";
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const config = loadMemoryXXPostgresConfig();

  console.log("=== Vector Retriever Test ===");
  console.log(`Schema: ${config.schema}`);
  console.log();

  // Load project scope IDs
  const { Pool } = await import("pg");
  const scopePool = new Pool({
    connectionString: config.databaseUrl,
    max: 2
  });
  let projectIds: string[] = [];
  try {
    await scopePool.query(`SET search_path TO ${config.schema}`);
    const result = await scopePool.query(
      `SELECT DISTINCT scope_id FROM memory_records WHERE scope_type = 'project'`
    );
    projectIds = result.rows.map((r: { scope_id: string }) => r.scope_id);
  } finally {
    await scopePool.end();
  }

  let runtime: PostgresRecallRuntime | undefined;
  let passCount = 0;
  let failCount = 0;

  try {
    runtime = createPostgresRecallRuntime({
      config,
      query_embedding_provider: new QwenEmbeddingProvider(),
      vector_column_name: "content_embedding"
    });

    // Check vector backend status
    const vectorStatus = await runtime.vector_retriever.get_backend_status();
    console.log(`Vector backend: available=${vectorStatus.available}, reason=${vectorStatus.reason ?? "none"}`);
    console.log();

    if (!vectorStatus.available) {
      console.error("❌ Vector backend is NOT available. Aborting.");
      console.error(`   Reason: ${vectorStatus.reason}`);
      process.exit(1);
    }

    for (const tc of TEST_CASES) {
      const request: RecallRequest = {
        query: tc.query,
        scope_context: {
          user_id: "current-instance-owner",
          workspace_id: "current-instance",
          project_ids: projectIds,
          include_global: true
        },
        filter_mode: FilterMode.All,
        debug: { allow_privileged_filter_modes: true },
        explain: true,
        limit: 5
      };

      const response = await runtime.orchestrator.execute(request);

      const { hit, matched } = checkKeywordHit(response.results, tc.expectedKeywords);
      const topResult = response.results[0];

      const status = hit ? "✅ PASS" : "❌ FAIL";
      if (hit) passCount++; else failCount++;

      console.log(`${status} "${tc.query}"`);
      console.log(`  Strategy: ${response.audit.strategy}`);
      console.log(`  Degraded: ${response.degraded} (${response.degrade_reason ?? "n/a"})`);
      console.log(`  Lexical hits: ${response.audit.lexical_hits}, Vector hits: ${response.audit.vector_hits}`);
      console.log(`  Total results: ${response.results.length}`);
      if (topResult) {
        console.log(`  Top result: [${truncate(topResult.title ?? "(untitled)", 60)}] score=${topResult.score.toFixed(4)} retrievers=${topResult.source_retrievers.join("+")}`);
      }
      console.log(`  Keywords hit: ${matched.join(", ") || "(none)"}`);
      console.log();
    }

    console.log("=== Summary ===");
    console.log(`Pass: ${passCount}/${TEST_CASES.length}`);
    console.log(`Fail: ${failCount}/${TEST_CASES.length}`);

    if (failCount > 0) {
      process.exit(1);
    }
  } finally {
    await runtime?.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

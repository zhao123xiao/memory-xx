/**
 * verify-qdrant-recall.ts
 * 验证 Qdrant vector recall 是否已修复（vec_hits > 0）
 *
 * 用法：
 *   MEMORY_V2_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/memory_xx \
 *   MEMORY_V2_DATABASE_SCHEMA=shadow_r3_20260414 \
 *   node --import tsx scripts/verify-qdrant-recall.ts
 */

import { createQdrantPrimaryRecallRuntime, loadMemoryV2PostgresConfig, loadMemoryV2QdrantConfig, FilterMode, type RecallRequest } from "../app";

async function main() {
  const pgConfig = loadMemoryV2PostgresConfig();
  const qdrantConfig = loadMemoryV2QdrantConfig();
  console.log("Qdrant config:", JSON.stringify(qdrantConfig));
  const runtime = createQdrantPrimaryRecallRuntime({
    config: pgConfig,
    qdrant_base_url: qdrantConfig.base_url,
    qdrant_api_key: qdrantConfig.api_key,
    qdrant_collection_name: qdrantConfig.collection_name,
    qdrant_minimum_score: qdrantConfig.minimum_score
  });

  const queries = [
    "memory framework status project",
    "constraints rules",
    "lessons learned"
  ];

  for (const query of queries) {
    const request: RecallRequest = {
      query,
      scope_context: {
        user_id: "current-instance-owner",
        workspace_id: "current-instance",
        include_global: true
      },
      filter_mode: FilterMode.Default,
      explain: true,
      limit: 5
    };
    const result = await runtime.orchestrator.execute(request);

    console.log(`\nQuery: "${query}"`);
    console.log(`  hits: ${result.results.length}`);
    console.log(`  top1: ${result.results[0]?.title ?? "NONE"}`);
    console.log(`  vec_hits: ${(result.audit as any)?.vector_hits ?? "N/A"}`);
    console.log(`  lex_hits: ${(result.audit as any)?.lexical_hits ?? "N/A"}`);
    console.log(`  merged_hits: ${(result.audit as any)?.merged_hits ?? "N/A"}`);
    console.log(`  degraded: ${result.degraded}`);
    console.log(`  degrade_reasons: ${JSON.stringify((result.audit as any)?.degrade_reasons ?? [])}`);
    console.log(`  vector_status: ${JSON.stringify((result.audit as any)?.vector_status ?? {})}`);
  }

  await runtime.close();
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

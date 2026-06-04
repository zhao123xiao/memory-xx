/**
 * Minimal live probe for memory-xx against a real PostgreSQL schema.
 *
 * Verifies:
 * 1) schema is reachable
 * 2) memory_records exists and has rows
 * 3) recall orchestrator can return live results
 * 4) degrade/fallback metadata is visible in the response
 *
 * Usage:
 *   MEMORY_XX_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/memory_xx \
 *   MEMORY_XX_DATABASE_SCHEMA=memory_xx \
 *   node --import tsx scripts/pg-live-probe.ts
 */

import { Pool } from "pg";
import {
  createPostgresRecallRuntime,
  createPostgresPoolConfig,
  loadMemoryXXPostgresConfig,
  FilterMode,
  type RecallRequest
} from "../app";

async function main() {
  const config = loadMemoryXXPostgresConfig();
  const pool = new Pool(createPostgresPoolConfig(config));
  const runtime = createPostgresRecallRuntime({ config });

  try {
    const schemaCheck = await pool.query(
      `select current_database() as db, $1::text as schema`,
      [config.schema]
    );
    const countResult = await pool.query(
      `select count(*)::int as count from ${config.schema}.memory_records`
    );
    const projectScopeResult = await pool.query(
      `select distinct scope_id from ${config.schema}.memory_records where scope_type = 'project' order by 1`
    );

    const projectIds = projectScopeResult.rows.map((row: { scope_id: string }) => row.scope_id);

    const request: RecallRequest = {
      query: "当前记忆系统的主账是什么",
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

    const report = {
      timestamp: new Date().toISOString(),
      database: schemaCheck.rows[0]?.db ?? null,
      schema: config.schema,
      memoryRecordCount: countResult.rows[0]?.count ?? 0,
      projectScopeCount: projectIds.length,
      query: request.query,
      returnedHits: response.results.length,
      degraded: response.degraded,
      degradeReason: response.degrade_reason ?? null,
      strategy: response.audit.strategy,
      lexicalHits: response.audit.lexical_hits,
      vectorHits: response.audit.vector_hits,
      top1: response.results[0]
        ? {
            memoryId: response.results[0].memory_id,
            title: response.results[0].title ?? null,
            score: response.results[0].score,
            retrievers: response.results[0].source_retrievers,
            snippet: response.results[0].content.slice(0, 160)
          }
        : null
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await runtime.close();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

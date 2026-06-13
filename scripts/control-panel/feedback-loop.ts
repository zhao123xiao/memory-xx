import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../../app/db/adapters/postgres-config.js";
import { quoteIdent } from "../lib/runtime-env.js";

export async function buildFeedbackLoopSummary(limit = 30): Promise<Record<string, unknown>> {
  const pgConfig = loadMemoryXXPostgresConfig(process.env);
  const schema = quoteIdent(pgConfig.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  try {
    const traces = await pool.query(
      `
        SELECT t.id, t.query_excerpt, t.actor_id, t.query_type, t.strategy, t.degrade_level,
               t.results, t.created_at, count(f.id)::int AS feedback_count
        FROM ${schema}.recall_traces t
        LEFT JOIN ${schema}.recall_feedback_events f ON f.recall_trace_id = t.id
        GROUP BY t.id
        ORDER BY t.created_at DESC
        LIMIT $1
      `,
      [limit]
    );
    const feedback = await pool.query(
      `
        SELECT feedback_type, count(*)::int AS count
        FROM ${schema}.recall_feedback_events
        WHERE created_at >= now() - interval '7 days'
        GROUP BY feedback_type
        ORDER BY count DESC
      `
    );
    const repair = await pool.query(
      `
        SELECT issue_type, status, count(*)::int AS count
        FROM ${schema}.recall_repair_queue
        GROUP BY issue_type, status
        ORDER BY count DESC
      `
    ).catch(() => ({ rows: [] }));
    return {
      ok: true,
      generated_at: new Date().toISOString(),
      traces: traces.rows.map((row) => ({
        recall_trace_id: row.id,
        query_excerpt: row.query_excerpt,
        actor_id: row.actor_id,
        query_type: row.query_type,
        strategy: row.strategy,
        degrade_level: row.degrade_level,
        memory_ids: Array.isArray(row.results?.memory_ids) ? row.results.memory_ids : [],
        feedback_count: row.feedback_count,
        created_at: row.created_at,
      })),
      feedback_7d: feedback.rows,
      repair_queue: repair.rows,
    };
  } finally {
    await pool.end();
  }
}

import { config } from "../test-harness/config.js";
import { closePool, createPool, query } from "../test-harness/lib/db-helpers.js";
import {
  readConversationControls,
  readConversationHeartbeat,
} from "./service-controls.js";
import { tableName } from "./utils.js";

function table(name: string): string {
  return tableName(config.dbSchema, name);
}

export async function buildConversationRecent(limit: number): Promise<Record<string, unknown>> {
  const pool = createPool();
  try {
    const capped = Math.max(1, Math.min(100, limit));
    const [events, batches, candidates, sessions] = await Promise.all([
      query(pool, `
        SELECT id, conversation_id, session_id, turn_id, role, agent_id, source,
               left(content, 160) AS content_preview, scope_context, metadata,
               observed_at, processed_at, batch_id
        FROM ${table("conversation_events")}
        ORDER BY observed_at DESC
        LIMIT $1
      `, [capped]).catch((error) => ({ rows: [], error: error instanceof Error ? error.message : String(error) })),
      query(pool, `
        SELECT id, conversation_id, session_id, status, extraction_backend, mem0_mode,
               candidate_memory_ids, no_op_reasons, error, metadata, created_at, completed_at
        FROM ${table("conversation_batches")}
        ORDER BY created_at DESC
        LIMIT $1
      `, [capped]).catch((error) => ({ rows: [], error: error instanceof Error ? error.message : String(error) })),
      query(pool, `
        SELECT id AS memory_id, title, lifecycle_status, review_state, scope_type, scope_id,
               metadata ->> 'conversation_id' AS conversation_id,
               metadata ->> 'session_id' AS session_id,
               metadata ->> 'batch_id' AS batch_id,
               updated_at
        FROM ${table("memory_records")}
        WHERE metadata ->> 'source' = 'conversation_ingest'
        ORDER BY updated_at DESC
        LIMIT $1
      `, [capped]).catch((error) => ({ rows: [], error: error instanceof Error ? error.message : String(error) })),
      query(pool, `
        SELECT ce.conversation_id, ce.session_id,
               count(*)::int AS event_count,
               count(*) FILTER (WHERE ce.processed_at IS NULL)::int AS pending_event_count,
               max(ce.observed_at) AS last_event_at,
               max(cb.created_at) AS last_batch_at,
               count(DISTINCT cb.id)::int AS batch_count,
               count(DISTINCT mr.id)::int AS candidate_count
        FROM ${table("conversation_events")} ce
        LEFT JOIN ${table("conversation_batches")} cb
          ON cb.conversation_id = ce.conversation_id
         AND COALESCE(cb.session_id, '') = COALESCE(ce.session_id, '')
        LEFT JOIN ${table("memory_records")} mr
          ON mr.metadata ->> 'source' = 'conversation_ingest'
         AND mr.metadata ->> 'session_id' = ce.session_id
        GROUP BY ce.conversation_id, ce.session_id
        ORDER BY max(ce.observed_at) DESC
        LIMIT $1
      `, [capped]).catch((error) => ({ rows: [], error: error instanceof Error ? error.message : String(error) })),
    ]);
    return {
      controls: await readConversationControls(),
      worker_heartbeat: await readConversationHeartbeat(),
      events: events.rows,
      batches: batches.rows,
      candidates: candidates.rows,
      sessions: sessions.rows,
      errors: {
        events: (events as { error?: string }).error,
        batches: (batches as { error?: string }).error,
        candidates: (candidates as { error?: string }).error,
        sessions: (sessions as { error?: string }).error,
      },
    };
  } finally {
    await closePool(pool);
  }
}

export async function buildConversationBatch(batchId: string): Promise<Record<string, unknown>> {
  if (!batchId) return { error: "缺少必填字段：batchId（批次 ID）" };
  const pool = createPool();
  try {
    const [batch, events] = await Promise.all([
      query(pool, `SELECT * FROM ${table("conversation_batches")} WHERE id = $1 LIMIT 1`, [batchId]),
      query(pool, `SELECT * FROM ${table("conversation_events")} WHERE batch_id = $1 ORDER BY observed_at ASC`, [batchId]),
    ]);
    return { batch: batch.rows[0] ?? null, events: events.rows };
  } finally {
    await closePool(pool);
  }
}

export async function buildConversationSession(sessionId: string): Promise<Record<string, unknown>> {
  if (!sessionId) return { error: "缺少必填字段：sessionId（会话 ID）" };
  const pool = createPool();
  try {
    const [events, batches, candidates] = await Promise.all([
      query(pool, `SELECT * FROM ${table("conversation_events")} WHERE session_id = $1 ORDER BY observed_at DESC LIMIT 100`, [sessionId]),
      query(pool, `SELECT * FROM ${table("conversation_batches")} WHERE session_id = $1 ORDER BY created_at DESC LIMIT 50`, [sessionId]),
      query(pool, `
        SELECT id AS memory_id, title, content, lifecycle_status, review_state, metadata, updated_at
        FROM ${table("memory_records")}
        WHERE metadata ->> 'source' = 'conversation_ingest'
          AND metadata ->> 'session_id' = $1
        ORDER BY updated_at DESC
        LIMIT 50
      `, [sessionId]),
    ]);
    return { events: events.rows, batches: batches.rows, candidates: candidates.rows };
  } finally {
    await closePool(pool);
  }
}

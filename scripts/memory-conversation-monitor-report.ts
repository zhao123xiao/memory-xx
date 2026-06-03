#!/usr/bin/env tsx
import "./test-harness/config.js";
import path from "node:path";

import { buildConversationMonitorReport } from "../app/conversation/conversation-monitor-report";
import { readConversationSourceRuntimeStatus } from "../app/conversation/conversation-source-status";
import { config } from "./test-harness/config.js";
import { closePool, createPool, query } from "./test-harness/lib/db-helpers.js";

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | null {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error(`unsafe_identifier:${value}`);
  return `"${value}"`;
}

function table(name: string): string {
  return `${quoteIdent(config.dbSchema)}.${quoteIdent(name)}`;
}

async function loadFacts(limit: number) {
  const pool = createPool();
  try {
    const [events, batches, memoryRecords, policyDecisions] = await Promise.all([
      query(pool, `
        SELECT id, source, role,
               observed_at::text AS observed_at,
               processed_at::text AS processed_at,
               batch_id,
               metadata
          FROM ${table("conversation_events")}
         WHERE observed_at >= now() - interval '7 days'
           AND (source IN ('codex-session-tail','claude-code-session-tail','openclaw-session-tail')
             OR metadata->>'source_adapter' IN ('codex_session','claude_code_session','openclaw_session'))
         ORDER BY observed_at DESC
         LIMIT $1
      `, [limit]),
      query(pool, `
        SELECT cb.id,
               cb.source,
               cb.status,
               cb.candidate_memory_ids,
               cb.no_op_reasons,
               cb.metadata || jsonb_build_object(
                 'source_adapter', max(ce.metadata->>'source_adapter'),
                 'source_adapters', jsonb_agg(DISTINCT ce.metadata->>'source_adapter') FILTER (WHERE ce.metadata->>'source_adapter' IS NOT NULL)
               ) AS metadata
          FROM ${table("conversation_batches")} cb
          LEFT JOIN ${table("conversation_events")} ce ON ce.batch_id = cb.id
         WHERE cb.created_at >= now() - interval '7 days'
           AND cb.source = 'conversation_ingest'
         GROUP BY cb.id
         ORDER BY cb.created_at DESC
         LIMIT $1
      `, [limit]),
      query(pool, `
        SELECT mr.id,
               mr.metadata->>'source' AS source,
               mr.lifecycle_status,
               mr.review_state,
               mr.metadata || jsonb_build_object(
                 'source_adapter', max(ce.metadata->>'source_adapter')
               ) AS metadata
          FROM ${table("memory_records")} mr
          LEFT JOIN ${table("conversation_batches")} cb ON cb.id = mr.metadata->>'batch_id'
          LEFT JOIN ${table("conversation_events")} ce ON ce.batch_id = cb.id
         WHERE mr.created_at >= now() - interval '7 days'
           AND mr.metadata->>'source' = 'conversation_ingest'
         GROUP BY mr.id
         ORDER BY mr.created_at DESC
         LIMIT $1
      `, [limit]),
      query(pool, `
        SELECT COALESCE(
                 d.metadata->>'source_adapter',
                 d.metadata->'memory_policy'->>'source_adapter',
                 r.metadata->>'source_adapter'
               ) AS source_adapter,
               COALESCE(d.metadata->>'source', r.metadata->>'source') AS source,
               COALESCE(
                 d.metadata->'memory_policy'->>'policy_action',
                 d.metadata->>'policy_action',
                 r.metadata->'auto_approval_policy'->'memory_policy'->>'policy_action',
                 r.metadata->>'policy_action'
               ) AS policy_action
          FROM ${table("auto_approval_decisions")} d
          LEFT JOIN ${table("memory_records")} r ON r.id = d.approved_memory_id
         WHERE d.created_at >= now() - interval '7 days'
           AND COALESCE(d.metadata->>'source', r.metadata->>'source') = 'conversation_ingest'
         ORDER BY d.created_at DESC
         LIMIT $1
      `, [limit]),
    ]);
    return {
      events: events.rows,
      batches: batches.rows,
      memoryRecords: memoryRecords.rows,
      policyDecisions: policyDecisions.rows,
    };
  } finally {
    await closePool(pool);
  }
}

async function main(): Promise<void> {
  const json = hasFlag("--json");
  const runtimeDir = process.env.MEMORY_V2_RUNTIME_DIR?.trim() || path.join(process.cwd(), ".runtime");
  const limit = Math.max(1, Math.min(10_000, Number.parseInt(argValue("--limit") ?? "5000", 10) || 5000));
  const heartbeat = await readConversationSourceRuntimeStatus(runtimeDir);
  let facts = { events: [], batches: [], memoryRecords: [], policyDecisions: [] } as Awaited<ReturnType<typeof loadFacts>>;
  let dbError: string | null = null;
  try {
    facts = await loadFacts(limit);
  } catch (error) {
    dbError = error instanceof Error ? error.message : String(error);
  }
  const report = buildConversationMonitorReport({
    heartbeat: heartbeat.ok ? heartbeat : null,
    facts,
  });
  const output = dbError
    ? { ...report, ok: false, status: "degraded" as const, warnings: [...report.warnings, `db_query_failed:${dbError}`] }
    : report;

  if (json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    process.stdout.write(`conversation monitor: status=${output.status} heartbeat=${heartbeat.ok} db=${dbError ? "failed" : "ok"}\n`);
    for (const source of Object.values(output.sources)) {
      process.stdout.write(`- ${source.adapter}: user=${source.user_events} assistant=${source.assistant_events} processed=${source.processed_events} e2e=${source.user_turn_e2e}\n`);
    }
  }
  process.exitCode = output.ok ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

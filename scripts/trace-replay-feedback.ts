#!/usr/bin/env tsx
import "./test-harness/config.js";

import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryV2PostgresConfig } from "../app/db/adapters/postgres-config.js";
import { quoteIdent } from "./lib/runtime-env.js";

type Mode = "candidates" | "apply" | "auto-top1";

function mode(): Mode {
  const raw = process.argv[2] ?? "candidates";
  if (raw === "apply" || raw === "auto-top1") return raw;
  return "candidates";
}

function arg(name: string): string {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? "" : "";
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function limit(): number {
  const parsed = Number.parseInt(arg("limit") || "50", 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(500, parsed)) : 50;
}

function days(): number {
  const parsed = Number.parseInt(arg("days") || "14", 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(90, parsed)) : 14;
}

function readMemoryIds(results: unknown): readonly string[] {
  if (!results || typeof results !== "object" || Array.isArray(results)) return [];
  const value = (results as Record<string, unknown>).memory_ids;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function listCandidates(pool: Pool, schema: string): Promise<Record<string, unknown>> {
  const rows = await pool.query(
    `
      SELECT t.id, t.query_hash, t.query_excerpt, t.actor_id, t.query_type, t.strategy,
             t.degrade_level, t.results, t.audit, t.created_at,
             count(f.id)::int AS feedback_count
      FROM ${schema}.recall_traces t
      LEFT JOIN ${schema}.recall_feedback_events f ON f.recall_trace_id = t.id
      WHERE t.created_at >= now() - ($1::int * interval '1 day')
      GROUP BY t.id
      ORDER BY t.created_at DESC
      LIMIT $2
    `,
    [days(), limit()]
  );
  return {
    candidates: rows.rows.map((row) => ({
      recall_trace_id: row.id,
      query_hash: row.query_hash,
      query_excerpt: row.query_excerpt,
      actor_id: row.actor_id,
      query_type: row.query_type,
      strategy: row.strategy,
      degrade_level: row.degrade_level,
      memory_ids: readMemoryIds(row.results),
      feedback_count: row.feedback_count,
      created_at: row.created_at,
    })),
  };
}

async function applyFeedback(pool: Pool, schema: string, input: {
  readonly recallTraceId: string;
  readonly memoryId: string | null;
  readonly feedbackType: string;
  readonly actorId: string;
  readonly reason: string | null;
  readonly metadata: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const traceRows = await client.query(`SELECT * FROM ${schema}.recall_traces WHERE id = $1 FOR UPDATE`, [input.recallTraceId]);
    const trace = traceRows.rows[0];
    if (!trace) throw new Error(`recall_trace_not_found:${input.recallTraceId}`);
    const memoryIds = readMemoryIds(trace.results);
    if (input.memoryId && input.feedbackType !== "false_null" && !memoryIds.includes(input.memoryId)) {
      throw new Error(`memory_id_not_in_trace:${input.memoryId}`);
    }
    const eventId = `recall_feedback_event_${randomUUID()}`;
    await client.query(
      `
        INSERT INTO ${schema}.recall_feedback_events (
          id, recall_trace_id, memory_id, actor_id, feedback_type, suspicious, reason, metadata, created_at
        )
        VALUES ($1, $2, $3, $4, $5, false, $6, $7::jsonb, now())
      `,
      [
        eventId,
        input.recallTraceId,
        input.memoryId,
        input.actorId,
        input.feedbackType,
        input.reason,
        JSON.stringify({ ...input.metadata, source: "trace_feedback_cli" }),
      ]
    );
    let repair: Record<string, unknown> | null = null;
    if (input.feedbackType === "false_null") {
      const repairId = `recall_repair_${randomUUID()}`;
      const details = {
        source: "trace_feedback_cli",
        recall_trace_id: input.recallTraceId,
        memory_id: input.memoryId,
        query_excerpt: trace.query_excerpt,
      };
      const rows = await client.query(
        `
          INSERT INTO ${schema}.recall_repair_queue (
            id, query_hash, recall_trace_id, issue_type, count, status, details,
            urgency, root_cause_type, root_cause, suggested_action, created_at, updated_at
          )
          VALUES ($1, $2, $3, 'false_null', 1, 'open', $4::jsonb,
            'P2', 'embedding_gap', 'embedding_gap', 'Review missing memory or alias coverage.', now(), now())
          ON CONFLICT (query_hash, issue_type)
          DO UPDATE SET count = recall_repair_queue.count + 1,
                        recall_trace_id = EXCLUDED.recall_trace_id,
                        details = EXCLUDED.details,
                        updated_at = now()
          RETURNING id, count, status, issue_type, root_cause_type
        `,
        [repairId, trace.query_hash, input.recallTraceId, JSON.stringify(details)]
      );
      repair = rows.rows[0] ?? null;
    }
    await client.query("COMMIT");
    return { feedback_event_id: eventId, repair };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function autoTop1(pool: Pool, schema: string): Promise<Record<string, unknown>> {
  const dryRun = !hasFlag("apply");
  const rows = await pool.query(
    `
      SELECT t.id, t.query_hash, t.query_excerpt, t.actor_id, t.results, t.created_at
      FROM ${schema}.recall_traces t
      WHERE t.created_at >= now() - ($1::int * interval '1 day')
        AND NOT EXISTS (SELECT 1 FROM ${schema}.recall_feedback_events f WHERE f.recall_trace_id = t.id)
      ORDER BY t.created_at DESC
      LIMIT $2
    `,
    [days(), limit()]
  );
  const candidates = rows.rows.flatMap((row) => {
    const [memoryId] = readMemoryIds(row.results);
    return memoryId ? [{ recall_trace_id: row.id, memory_id: memoryId, feedback_type: "used_in_context" }] : [];
  });
  if (dryRun) return { dry_run: true, candidates };
  const applied = [];
  for (const item of candidates) {
    applied.push(await applyFeedback(pool, schema, {
      recallTraceId: item.recall_trace_id,
      memoryId: item.memory_id,
      feedbackType: item.feedback_type,
      actorId: "trace-feedback:auto-top1",
      reason: "auto top1 low-risk feedback label",
      metadata: { auto_top1: true },
    }));
  }
  return { dry_run: false, applied };
}

async function main(): Promise<void> {
  const pgConfig = loadMemoryV2PostgresConfig(process.env);
  const schema = quoteIdent(pgConfig.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  try {
    const current = mode();
    const body = current === "candidates"
      ? await listCandidates(pool, schema)
      : current === "auto-top1"
        ? await autoTop1(pool, schema)
        : await applyFeedback(pool, schema, {
          recallTraceId: arg("trace-id") || arg("recall-trace-id"),
          memoryId: arg("memory-id") || null,
          feedbackType: arg("feedback-type") || "used_in_context",
          actorId: arg("actor-id") || "trace-feedback:manual",
          reason: arg("reason") || null,
          metadata: {},
        });
    process.stdout.write(`${JSON.stringify({ ok: true, mode: current, ...body }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

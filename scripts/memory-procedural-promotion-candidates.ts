#!/usr/bin/env tsx
import "./test-harness/config.js";

import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import type { RecallFeedbackEventRow, RecallTraceRow } from "../app/db/schema/tables";
import {
  buildProceduralPromotionCandidateReport,
  type ProceduralPromotionMemoryRow,
} from "../app/governance/procedural-promotion-candidates";
import { requireCliPermission } from "../app/server/permissions.js";
import { loadDotenvIfPresent, quoteIdent } from "./lib/runtime-env";

loadDotenvIfPresent();

function arg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function readInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(arg(name) || String(fallback), 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, value));
}

function jsonObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function iso(value: unknown): string {
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

function mapTrace(row: Record<string, unknown>): RecallTraceRow {
  return {
    id: String(row.id),
    queryHash: String(row.query_hash),
    queryExcerpt: String(row.query_excerpt ?? ""),
    actorId: typeof row.actor_id === "string" ? row.actor_id : null,
    scopeContext: jsonObject(row.scope_context),
    queryType: String(row.query_type ?? "unknown"),
    strategy: String(row.strategy ?? "unknown"),
    degradeLevel: Number(row.degrade_level ?? 0),
    results: jsonObject(row.results),
    audit: jsonObject(row.audit),
    createdAt: iso(row.created_at),
  };
}

function mapFeedback(row: Record<string, unknown>): RecallFeedbackEventRow {
  return {
    id: String(row.id),
    recallTraceId: String(row.recall_trace_id),
    memoryId: typeof row.memory_id === "string" ? row.memory_id : null,
    actorId: String(row.actor_id ?? "unknown"),
    feedbackType: String(row.feedback_type ?? "unknown"),
    suspicious: row.suspicious === true,
    reason: typeof row.reason === "string" ? row.reason : null,
    metadata: jsonObject(row.metadata),
    createdAt: iso(row.created_at),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mapMemory(row: Record<string, unknown>): ProceduralPromotionMemoryRow {
  return {
    id: String(row.id),
    scope_type: String(row.scope_type),
    scope_id: String(row.scope_id),
    title: stringOrNull(row.title),
    content: String(row.content ?? ""),
    memory_type: stringOrNull(row.memory_type),
    memory_class: stringOrNull(row.memory_class),
    cognitive_type: stringOrNull(row.cognitive_type),
    recall_policy: stringOrNull(row.recall_policy),
    metadata: jsonObject(row.metadata),
  };
}

async function main(): Promise<void> {
  if (process.argv.some((item) => item === "--apply" || item === "apply")) {
    throw new Error("memory:procedural-promotion-candidates is report-only; no --apply mode is supported.");
  }
  await requireCliPermission("memory:governance_read");
  const days = readInt("days", 30, 1, 365);
  const limit = readInt("limit", 5000, 1, 50_000);
  const minPositiveScopes = readInt("min-positive-scopes", 2, 2, 100);
  const config = loadMemoryXXPostgresConfig(process.env);
  const schema = quoteIdent(config.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(config));
  const client = await pool.connect();
  try {
    const feedback = await client.query(`
      SELECT *
      FROM ${schema}.recall_feedback_events
      WHERE created_at >= now() - ($1::int * interval '1 day')
        AND feedback_type IN ('used_in_context', 'adopted')
        AND suspicious IS NOT TRUE
        AND memory_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT $2
    `, [days, limit]);
    const traceIds = [...new Set(feedback.rows.map((row) => String(row.recall_trace_id)).filter(Boolean))];
    const memoryIds = [...new Set(feedback.rows.map((row) => String(row.memory_id)).filter(Boolean))];
    const traces = traceIds.length > 0
      ? await client.query(`SELECT * FROM ${schema}.recall_traces WHERE id = ANY($1::text[])`, [traceIds])
      : { rows: [] };
    const memories = memoryIds.length > 0
      ? await client.query(`
          SELECT
            id,
            scope_type,
            scope_id,
            title,
            content,
            memory_type,
            COALESCE(metadata->>'memory_class', metadata->'memory_policy'->>'memory_class', metadata->'auto_approval_policy'->'memory_policy'->>'memory_class') AS memory_class,
            COALESCE(metadata->>'cognitive_type', metadata->'memory_policy'->>'cognitive_type', metadata->'auto_approval_policy'->'memory_policy'->>'cognitive_type') AS cognitive_type,
            COALESCE(metadata->>'recall_policy', metadata->'memory_policy'->>'recall_policy', metadata->'auto_approval_policy'->'memory_policy'->>'recall_policy') AS recall_policy,
            metadata
          FROM ${schema}.memory_records
          WHERE id = ANY($1::text[])
            AND is_current IS TRUE
        `, [memoryIds])
      : { rows: [] };

    const report = buildProceduralPromotionCandidateReport({
      memories: memories.rows.map(mapMemory),
      traces: traces.rows.map(mapTrace),
      feedbackEvents: feedback.rows.map(mapFeedback),
      minPositiveScopes,
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema: config.schema ?? "memory_xx",
      window_days: days,
      limit,
      min_positive_scopes: minPositiveScopes,
      ...report,
    }, null, 2)}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

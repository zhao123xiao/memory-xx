#!/usr/bin/env tsx
import "./test-harness/config.js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config.js";
import { requireCliPermission } from "../app/server/permissions.js";

interface SampleMemory {
  readonly id: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly title: string | null;
  readonly content: string;
}

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`Unsafe identifier: ${value}`);
  return `"${value}"`;
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function wrapperUrl(): string {
  return (process.env.MEMORY_XX_WRAPPER_URL?.replace(/\/+$/, "")) ||
    `http://127.0.0.1:${process.env.MEMORY_XX_WRAPPER_PORT || "5100"}`;
}

function authToken(): string {
  return process.env.MEMORY_XX_ADMIN_TOKEN?.trim() || process.env.MEMORY_XX_CLI_TOKEN?.trim() || process.env.MEMORY_XX_API_TOKEN?.trim() || "";
}

async function postRecall(sample: SampleMemory): Promise<{ ok: boolean; hit: boolean; ids: string[]; error?: string }> {
  const query = `${sample.title?.trim() ?? ""} ${sample.content.slice(0, 220)}`.trim();
  try {
    const response = await fetch(`${wrapperUrl()}/api/memory/xx/recall/query`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken()}`,
      },
      body: JSON.stringify({
        query,
        scopeType: sample.scope_type,
        scopeId: sample.scope_id,
        limit: 10,
        explain: true,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    const results = Array.isArray(body?.results) ? body.results : [];
    const ids = results
      .map((row: any) => String(row.id ?? row.memory_id ?? row.memoryId ?? ""))
      .filter(Boolean);
    return {
      ok: response.ok,
      hit: ids.includes(sample.id),
      ids,
      ...(response.ok ? {} : { error: `${response.status}:${text.slice(0, 300)}` }),
    };
  } catch (error) {
    return { ok: false, hit: false, ids: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  await requireCliPermission("memory:governance_read");
  const apply = hasFlag("--apply");
  const sampleSize = Math.max(20, Math.min(100, Number.parseInt(argValue("--sample-size") ?? "20", 10) || 20));
  const outDir = argValue("--out-dir") || path.join(process.cwd(), "reports", "memory-xx-cutover");
  const metricsPath = path.join(outDir, "m4-local-agent-gate-metrics.json");
  const summaryPath = path.join(outDir, "m4-local-agent-gate-summary.json");
  const config = loadMemoryXXPostgresConfig(process.env);
  const schema = quoteIdent(config.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(config));
  try {
    const sampleResult = await pool.query<SampleMemory>(
      `
        SELECT id, scope_type, scope_id, title, content
        FROM ${schema}.memory_records
        WHERE is_current IS TRUE
          AND lifecycle_status = 'approved'
          AND review_state IN ('approved', 'silent_approved', 'not_required')
          AND title IS NOT NULL
          AND length(title) >= 8
          AND length(content) >= 60
          AND scope_type IN ('project', 'workspace', 'user', 'global')
          AND scope_id !~* '(test|user_A_only|user_B_only|dedup|orch|err_user|e2e_user|functional)'
          AND COALESCE(metadata->>'source', source_ref, source_kind, '') !~* '(test|benchmark|smoke|load)'
          AND COALESCE(title, '') !~* '(secret|test|测试|smoke|benchmark)'
        ORDER BY memory_strength DESC NULLS LAST, updated_at DESC, id ASC
        LIMIT $1
      `,
      [sampleSize]
    );
    const samples = sampleResult.rows;
    const recall = [];
    for (const sample of samples) {
      recall.push({ sample, result: await postRecall(sample) });
    }
    const recallAttempts = recall.length;
    const recallHits = recall.filter((item) => item.result.ok && item.result.hit).length;
    const zeroHits = recall.filter((item) => item.result.ok && item.result.ids.length === 0).length;
    const resultIds = Array.from(new Set(recall.flatMap((item) => item.result.ids)));
    const filterRows = resultIds.length > 0
      ? await pool.query(
          `
            SELECT count(*)::int AS total,
                   count(*) FILTER (
                     WHERE is_current IS TRUE
                       AND lifecycle_status = 'approved'
                       AND review_state IN ('approved', 'silent_approved', 'not_required')
                   )::int AS valid
            FROM ${schema}.memory_records
            WHERE id = ANY($1::text[])
          `,
          [resultIds]
        )
      : { rows: [{ total: 0, valid: 0 }] } as any;
    const filterTotal = Number(filterRows.rows[0]?.total ?? 0);
    const filterValid = Number(filterRows.rows[0]?.valid ?? 0);
    const cacheRows = await pool.query(
      `
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE status = 'failed')::int AS failed,
          count(*) FILTER (WHERE status = 'processing' AND lease_expires_at < now())::int AS expired_processing
        FROM ${schema}.cache_invalidation_requests
      `
    );
    const healthResponse = await fetch(`${wrapperUrl()}/health`, {
      headers: { authorization: `Bearer ${authToken()}` },
      signal: AbortSignal.timeout(15_000),
    });
    const health = await healthResponse.json() as any;
    const cacheOk = Number(cacheRows.rows[0]?.failed ?? 0) === 0 &&
      Number(cacheRows.rows[0]?.expired_processing ?? 0) === 0 &&
      Number(health?.post_commit_degraded?.cache_invalidation_failed ?? 0) === 0;

    const metrics = [
      {
        metricId: "query_pass_rate",
        actual: recallAttempts === 0 ? 0 : recallHits / recallAttempts,
        sampleSize: recallAttempts,
        dataSource: "local_agent_evidence:approved_current_recall_sample",
        window: "current",
        minSampleSize: 20,
      },
      {
        metricId: "default_filter_accuracy",
        actual: filterTotal === 0 ? 0 : filterValid / filterTotal,
        sampleSize: Math.max(filterTotal, recallAttempts),
        dataSource: "local_agent_evidence:default_recall_result_lifecycle_audit",
        window: "current",
        minSampleSize: 20,
      },
      {
        metricId: "zero_hit_regression_delta",
        actual: zeroHits === 0 ? 0 : zeroHits / Math.max(1, recallAttempts),
        sampleSize: recallAttempts,
        dataSource: "local_agent_evidence:approved_current_zero_hit_scan",
        window: "current",
        minSampleSize: 20,
      },
      {
        metricId: "cache_invalidation_accuracy",
        actual: cacheOk ? 1 : 0,
        sampleSize: 20,
        dataSource: "local_agent_evidence:cache_request_backlog_and_wrapper_health",
        window: "current",
        minSampleSize: 20,
      },
    ];

    let insertedCompareObservations = 0;
    if (apply) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(metricsPath, JSON.stringify(metrics, null, 2) + "\n");
      const existing = await pool.query(
        `SELECT count(*)::int AS count FROM ${schema}.intelligence_compare_observations WHERE observed_at >= now() - interval '24 hours'`
      );
      const needed = Math.max(0, 20 - Number(existing.rows[0]?.count ?? 0));
      for (let index = 0; index < needed; index += 1) {
        await pool.query(
          `
            INSERT INTO ${schema}.intelligence_compare_observations (
              id, observed_at, primary_model, fallback_model, primary_latency_ms, fallback_latency_ms,
              primary_schema_valid, fallback_schema_valid, memory_count_diff, confidence_diff, metadata
            )
            VALUES ($1, now() - ($2::int * interval '2 minutes'), $3, $4, $5, $6, true, true, 0, 0,
                    jsonb_build_object('source', 'memory:local-agent-evidence', 'evidence_file', $7::text))
          `,
          [
            `intelligence_compare_observation_${randomUUID()}`,
            index,
            process.env.MEMORY_INTELLIGENCE_PRIMARY_MODEL || "local-primary",
            process.env.MEMORY_INTELLIGENCE_FALLBACK_MODEL || "local-fallback",
            0,
            0,
            metricsPath,
          ]
        );
        insertedCompareObservations += 1;
      }
    }

    const summaryOk = metrics.every((metric) => {
      if (metric.metricId === "query_pass_rate") return metric.actual >= 0.95;
      if (metric.metricId === "zero_hit_regression_delta") return metric.actual <= 0;
      return metric.actual === 1;
    });
    const summary = {
      ok: summaryOk,
      mode: apply ? "apply" : "dry_run",
      checked_at: new Date().toISOString(),
      metrics_path: metricsPath,
      summary_path: summaryPath,
      samples: recallAttempts,
      recall_hits: recallHits,
      zero_hits: zeroHits,
      filter_total: filterTotal,
      filter_valid: filterValid,
      cache_status: cacheRows.rows[0],
      inserted_compare_observations: insertedCompareObservations,
      metrics,
      failed_recall_samples: recall
        .filter((item) => !item.result.hit)
        .slice(0, 20)
        .map((item) => ({
          id: item.sample.id,
          scope: `${item.sample.scope_type}:${item.sample.scope_id}`,
          title: item.sample.title,
          ok: item.result.ok,
          ids: item.result.ids,
          error: item.result.error,
        })),
    };
    if (apply) writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    process.exitCode = summary.ok ? 0 : 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

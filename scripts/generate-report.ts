#!/usr/bin/env tsx
import { Pool } from "pg";
import { createPostgresPoolConfig, loadMemoryV2PostgresConfig } from "../app/db/adapters/postgres-config";
import { requireCliPermission } from "../app/server/permissions.js";

export interface TrendValue {
  readonly current: number | null;
  readonly previous: number | null;
  readonly delta: number | null;
}

export interface Report {
  readonly generatedAt: string;
  readonly windowHours: number;
  readonly silentApprove: {
    readonly fpRate: TrendValue;
    readonly adoptionRate: TrendValue;
    readonly byAgent: Record<string, { fpRate: number | null; adoptionRate: number | null; sampleSize: number }>;
    readonly byScope: Record<string, { fpRate: number | null; adoptionRate: number | null; sampleSize: number }>;
  };
  readonly recall: {
    readonly nullReturnRate: TrendValue;
    readonly averageDegradeLevel: TrendValue;
    readonly totalQueries: TrendValue;
  };
  readonly projector: {
    readonly lagP50Ms: number | null;
    readonly lagP90Ms: number | null;
    readonly lagP99Ms: number | null;
    readonly deadLetterCount: TrendValue;
    readonly readbackVerifyFailCount: TrendValue;
  };
  readonly cache: {
    readonly recallCacheHitRatio: number | null;
  };
  readonly feedback: {
    readonly totalFeedback: TrendValue;
    readonly qdrantProjectionLagMs: number | null;
  };
  readonly alerts: {
    readonly open: number;
    readonly critical: number;
    readonly warning: number;
  };
}

interface ReportOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: Date;
}

const WINDOW_HOURS = 24;

export async function generateReport(options: ReportOptions = {}): Promise<Report> {
  const env = options.env ?? process.env;
  const config = loadMemoryV2PostgresConfig(env);
  const schema = quoteIdent(config.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(config));

  try {
    const [silent, byAgent, byScope, recall, projector, feedback, alerts] = await Promise.all([
      loadSilentApprove(pool, schema),
      loadSilentApproveBy(pool, schema, "agent"),
      loadSilentApproveBy(pool, schema, "scope"),
      loadRecall(pool, schema),
      loadProjector(pool, schema, env),
      loadFeedback(pool, schema),
      loadAlerts(pool, schema),
    ]);

    return {
      generatedAt: (options.now ?? new Date()).toISOString(),
      windowHours: WINDOW_HOURS,
      silentApprove: {
        fpRate: silent.fpRate,
        adoptionRate: silent.adoptionRate,
        byAgent,
        byScope,
      },
      recall,
      projector,
      cache: { recallCacheHitRatio: null },
      feedback,
      alerts,
    };
  } finally {
    await pool.end();
  }
}

async function loadSilentApprove(pool: Pool, schema: string): Promise<{ fpRate: TrendValue; adoptionRate: TrendValue }> {
  const result = await pool.query(`
    WITH windows AS (
      SELECT 'current' AS bucket, now() - interval '24 hours' AS start_at, now() AS end_at
      UNION ALL
      SELECT 'previous', now() - interval '48 hours', now() - interval '24 hours'
    ),
    cohort AS (
      SELECT
        w.bucket,
        COUNT(m.id)::float AS total,
        COUNT(m.id) FILTER (WHERE m.lifecycle_status = 'tombstone' OR m.review_state = 'rejected')::float AS fp,
        COALESCE(EXTRACT(EPOCH FROM (MAX(w.end_at) - MIN(m.created_at))), 0) / 3600 AS hours_since_first
      FROM windows w
      LEFT JOIN ${schema}.memory_records m
        ON m.review_state = 'silent_approved'
       AND m.created_at >= w.start_at
       AND m.created_at < w.end_at
      GROUP BY w.bucket
    )
    SELECT
      bucket,
      CASE WHEN total > 0 THEN fp / total ELSE NULL END AS fp_rate,
      CASE WHEN total > 0 AND hours_since_first > 0 THEN total / hours_since_first ELSE NULL END AS adoption_rate
    FROM cohort
  `);
  const current = result.rows.find((row) => row.bucket === "current");
  const previous = result.rows.find((row) => row.bucket === "previous");
  return {
    fpRate: trend(toNullableNumber(current?.fp_rate), toNullableNumber(previous?.fp_rate)),
    adoptionRate: trend(toNullableNumber(current?.adoption_rate), toNullableNumber(previous?.adoption_rate)),
  };
}

async function loadSilentApproveBy(
  pool: Pool,
  schema: string,
  mode: "agent" | "scope"
): Promise<Record<string, { fpRate: number | null; adoptionRate: number | null; sampleSize: number }>> {
  const dimension = mode === "agent"
    ? "COALESCE(agent_id, metadata->>'agent_id', created_by, 'unknown')"
    : "scope_type";
  const result = await pool.query(`
    SELECT ${dimension} AS key,
      COUNT(*) FILTER (WHERE lifecycle_status = 'tombstone' OR review_state = 'rejected')::float AS fp,
      COUNT(*)::float AS total
    FROM ${schema}.memory_records
    WHERE review_state = 'silent_approved'
      AND created_at >= now() - interval '24 hours'
    GROUP BY 1
    ORDER BY total DESC
    LIMIT 100
  `);
  const rows: Record<string, { fpRate: number | null; adoptionRate: number | null; sampleSize: number }> = {};
  for (const row of result.rows) {
    const total = Number(row.total ?? 0);
    rows[String(row.key ?? "unknown")] = {
      fpRate: total > 0 ? Number(row.fp ?? 0) / total : null,
      adoptionRate: null,
      sampleSize: total,
    };
  }
  return rows;
}

async function loadRecall(pool: Pool, schema: string): Promise<Report["recall"]> {
  const result = await pool.query(`
    WITH windows AS (
      SELECT 'current' AS bucket, now() - interval '24 hours' AS start_at, now() AS end_at
      UNION ALL
      SELECT 'previous', now() - interval '48 hours', now() - interval '24 hours'
    )
    SELECT
      w.bucket,
      COUNT(r.id)::float AS total,
      COUNT(r.id) FILTER (WHERE r.degrade_level >= 3)::float AS nulls,
      AVG(r.degrade_level)::float AS avg_degrade
    FROM windows w
    LEFT JOIN ${schema}.recall_traces r
      ON r.created_at >= w.start_at
     AND r.created_at < w.end_at
    GROUP BY w.bucket
  `);
  const current = result.rows.find((row) => row.bucket === "current");
  const previous = result.rows.find((row) => row.bucket === "previous");
  const currentTotal = toNullableNumber(current?.total) ?? 0;
  const previousTotal = toNullableNumber(previous?.total) ?? 0;
  return {
    totalQueries: trend(currentTotal, previousTotal),
    nullReturnRate: trend(currentTotal > 0 ? Number(current?.nulls ?? 0) / currentTotal : null, previousTotal > 0 ? Number(previous?.nulls ?? 0) / previousTotal : null),
    averageDegradeLevel: trend(toNullableNumber(current?.avg_degrade), toNullableNumber(previous?.avg_degrade)),
  };
}

async function loadProjector(pool: Pool, schema: string, env: NodeJS.ProcessEnv): Promise<Report["projector"]> {
  const maxAttempts = Number(env.MEMORY_V2_CAPACITY_OUTBOX_DEAD_LETTER_MAX_ATTEMPTS ?? env.MEMORY_V2_QDRANT_PROJECTOR_MAX_ATTEMPTS ?? 5);
  const result = await pool.query(`
    WITH windows AS (
      SELECT 'current' AS bucket, now() - interval '24 hours' AS start_at, now() AS end_at
      UNION ALL
      SELECT 'previous', now() - interval '48 hours', now() - interval '24 hours'
    ),
    dead AS (
      SELECT
        w.bucket,
        COUNT(o.id)::float AS dead_letter,
        COUNT(o.id) FILTER (WHERE o.projection_verified IS FALSE)::float AS verify_fail
      FROM windows w
      LEFT JOIN ${schema}.outbox_events o
        ON o.created_at >= w.start_at
       AND o.created_at < w.end_at
       AND o.dispatch_status = 'failed'
       AND o.attempts >= $1
      GROUP BY w.bucket
    ),
    lag AS (
      SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (dispatched_at - created_at)) * 1000) AS p50,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (dispatched_at - created_at)) * 1000) AS p90,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (dispatched_at - created_at)) * 1000) AS p99
      FROM ${schema}.outbox_events
      WHERE dispatched_at IS NOT NULL
        AND created_at >= now() - interval '24 hours'
    )
    SELECT * FROM dead CROSS JOIN lag
  `, [Number.isFinite(maxAttempts) ? maxAttempts : 5]);
  const current = result.rows.find((row) => row.bucket === "current");
  const previous = result.rows.find((row) => row.bucket === "previous");
  return {
    lagP50Ms: toNullableNumber(current?.p50),
    lagP90Ms: toNullableNumber(current?.p90),
    lagP99Ms: toNullableNumber(current?.p99),
    deadLetterCount: trend(toNullableNumber(current?.dead_letter) ?? 0, toNullableNumber(previous?.dead_letter) ?? 0),
    readbackVerifyFailCount: trend(toNullableNumber(current?.verify_fail) ?? 0, toNullableNumber(previous?.verify_fail) ?? 0),
  };
}

async function loadFeedback(pool: Pool, schema: string): Promise<Report["feedback"]> {
  const result = await pool.query(`
    WITH windows AS (
      SELECT 'current' AS bucket, now() - interval '24 hours' AS start_at, now() AS end_at
      UNION ALL
      SELECT 'previous', now() - interval '48 hours', now() - interval '24 hours'
    )
    SELECT w.bucket, COUNT(f.id)::float AS total
    FROM windows w
    LEFT JOIN ${schema}.memory_feedback_events f
      ON f.created_at >= w.start_at
     AND f.created_at < w.end_at
    GROUP BY w.bucket
  `);
  const current = result.rows.find((row) => row.bucket === "current");
  const previous = result.rows.find((row) => row.bucket === "previous");
  return {
    totalFeedback: trend(toNullableNumber(current?.total) ?? 0, toNullableNumber(previous?.total) ?? 0),
    qdrantProjectionLagMs: null,
  };
}

async function loadAlerts(pool: Pool, schema: string): Promise<Report["alerts"]> {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'open')::int AS open,
        COUNT(*) FILTER (WHERE status = 'open' AND level = 'critical')::int AS critical,
        COUNT(*) FILTER (WHERE status = 'open' AND level = 'warning')::int AS warning
      FROM ${schema}.memory_alerts
    `);
    const row = result.rows[0] ?? {};
    return { open: Number(row.open ?? 0), critical: Number(row.critical ?? 0), warning: Number(row.warning ?? 0) };
  } catch {
    return { open: 0, critical: 0, warning: 0 };
  }
}

export function formatReport(report: Report): string {
  const lines: string[] = [];
  lines.push("=".repeat(64));
  lines.push("  memory-xx operations report");
  lines.push(`  generated_at: ${report.generatedAt}`);
  lines.push("=".repeat(64));
  lines.push("");
  lines.push("Silent approve");
  lines.push(`  FP rate:       ${formatTrendPct(report.silentApprove.fpRate)}`);
  lines.push(`  Adoption rate: ${formatTrendNum(report.silentApprove.adoptionRate)}/h`);
  lines.push("");
  lines.push("Recall");
  lines.push(`  Queries:       ${formatTrendNum(report.recall.totalQueries)}`);
  lines.push(`  Null return:   ${formatTrendPct(report.recall.nullReturnRate)}`);
  lines.push(`  Avg degrade:   ${formatTrendNum(report.recall.averageDegradeLevel)}`);
  lines.push("");
  lines.push("Projector");
  lines.push(`  Dead-letter:   ${formatTrendNum(report.projector.deadLetterCount)}`);
  lines.push(`  Verify fail:   ${formatTrendNum(report.projector.readbackVerifyFailCount)}`);
  lines.push(`  Lag p50/p90/p99 ms: ${formatNum(report.projector.lagP50Ms)} / ${formatNum(report.projector.lagP90Ms)} / ${formatNum(report.projector.lagP99Ms)}`);
  lines.push("");
  lines.push("Feedback and alerts");
  lines.push(`  Feedback:      ${formatTrendNum(report.feedback.totalFeedback)}`);
  lines.push(`  Alerts open:   ${report.alerts.open} (critical ${report.alerts.critical}, warning ${report.alerts.warning})`);
  lines.push("=".repeat(64));
  return lines.join("\n");
}

function trend(current: number | null, previous: number | null): TrendValue {
  return { current, previous, delta: current !== null && previous !== null ? current - previous : null };
}

function formatTrendPct(value: TrendValue): string {
  return `${formatPct(value.current)} (previous ${formatPct(value.previous)}, ${formatSignedPct(value.delta)})`;
}

function formatTrendNum(value: TrendValue): string {
  return `${formatNum(value.current)} (previous ${formatNum(value.previous)}, ${formatSignedNum(value.delta)})`;
}

function formatPct(value: number | null): string {
  return value === null ? "N/A" : `${(value * 100).toFixed(2)}%`;
}

function formatSignedPct(value: number | null): string {
  if (value === null) return "delta N/A";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}pp`;
}

function formatNum(value: number | null): string {
  return value === null ? "N/A" : value.toFixed(2);
}

function formatSignedNum(value: number | null): string {
  if (value === null) return "delta N/A";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe identifier: ${value}`);
  }
  return `"${value}"`;
}

async function main(): Promise<void> {
  await requireCliPermission("memory:governance_read");
  const useJson = process.argv.includes("--json");
  const report = await generateReport();
  process.stdout.write((useJson ? JSON.stringify(report, null, 2) : formatReport(report)) + "\n");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Report generation failed:", err);
    process.exitCode = 1;
  });
}

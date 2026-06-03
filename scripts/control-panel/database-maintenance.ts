import { closePool, createPool, query } from "../test-harness/lib/db-helpers.js";
import { readRuntimeControlNumberSync } from "../../app/runtime-control-settings.js";

const SMALL_AUTOVACUUM_TABLES = [
  "memory_embedding_generations",
  "conversation_events",
  "governance_policy_overrides",
  "exporter_state",
  "recall_feedback_events",
  "scope_generations",
  "memory_governance_actions",
] as const;

export async function buildDatabaseMaintenanceSummary(schema: string): Promise<Record<string, unknown>> {
  const pool = createPool();
  const deadTupleWarningRatio = readRuntimeControlNumberSync("database.dead_tuple_warning_ratio", 20);
  try {
    const [deadTuples, tableOptions, settings] = await Promise.all([
      query(pool, `
        SELECT
          stat.relname,
          stat.n_live_tup::bigint::text AS n_live_tup,
          stat.n_dead_tup::bigint::text AS n_dead_tup,
          CASE
            WHEN (stat.n_live_tup + stat.n_dead_tup) > 0
              THEN round(stat.n_dead_tup::numeric * 100 / (stat.n_live_tup + stat.n_dead_tup), 2)::text
            ELSE '0'
          END AS dead_pct,
          stat.last_vacuum::text,
          stat.last_autovacuum::text,
          stat.last_analyze::text,
          stat.last_autoanalyze::text,
          cls.reloptions
        FROM pg_stat_all_tables stat
        JOIN pg_class cls ON cls.oid = stat.relid
        WHERE stat.schemaname = $1
        ORDER BY stat.n_dead_tup DESC, dead_pct DESC
        LIMIT 20
      `, [schema]),
      query(pool, `
        SELECT cls.relname, cls.reloptions
        FROM pg_class cls
        JOIN pg_namespace ns ON ns.oid = cls.relnamespace
        WHERE ns.nspname = $1 AND cls.relname = ANY($2::text[])
        ORDER BY cls.relname
      `, [schema, SMALL_AUTOVACUUM_TABLES]),
      query(pool, `
        SELECT name, setting, unit
        FROM pg_settings
        WHERE name IN ('max_wal_size', 'min_wal_size', 'archive_mode', 'archive_command', 'checkpoint_timeout')
        ORDER BY name
      `),
    ]);
    const wal = await query(pool, `
      SELECT count(*)::int AS files, pg_size_pretty(sum(size)) AS wal_size, sum(size)::bigint::text AS wal_bytes
      FROM pg_ls_waldir()
    `).catch((error) => ({ rows: [{ error: error instanceof Error ? error.message : String(error) }] }));
    const maxWal = settings.rows.find((row: Record<string, unknown>) => row.name === "max_wal_size") as Record<string, unknown> | undefined;
    const maxWalBytes = maxWal ? Number(maxWal.setting) * (maxWal.unit === "MB" ? 1024 * 1024 : 1) : 0;
    const walBytes = Number((wal.rows[0] as Record<string, unknown> | undefined)?.wal_bytes ?? 0);
    return {
      generated_at: new Date().toISOString(),
      schema,
      wal: {
        ...(wal.rows[0] as Record<string, unknown> | undefined),
        max_wal_bytes: maxWalBytes || null,
        wal_ratio: maxWalBytes > 0 ? walBytes / maxWalBytes : null,
        settings: settings.rows,
      },
      top_dead_tuples: deadTuples.rows,
      thresholds: {
        dead_tuple_warning_ratio_percent: deadTupleWarningRatio,
      },
      dead_tuple_warnings: deadTuples.rows.filter((row: Record<string, unknown>) => {
        const deadPct = Number(row.dead_pct ?? 0);
        return Number.isFinite(deadPct) && deadPct >= deadTupleWarningRatio;
      }),
      small_table_autovacuum: {
        target_tables: SMALL_AUTOVACUUM_TABLES,
        configured: tableOptions.rows,
        missing_options: tableOptions.rows.filter((row: Record<string, unknown>) => {
          const options = Array.isArray(row.reloptions) ? row.reloptions.map(String) : [];
          return !options.some((option) => option.startsWith("autovacuum_vacuum_threshold=")) ||
            !options.some((option) => option.startsWith("autovacuum_vacuum_scale_factor=")) ||
            !options.some((option) => option.startsWith("autovacuum_analyze_threshold=")) ||
            !options.some((option) => option.startsWith("autovacuum_analyze_scale_factor="));
        }),
      },
      note: "Control panel is read-only for database maintenance. Run migrations/doctor from CLI for changes.",
    };
  } finally {
    await closePool(pool);
  }
}

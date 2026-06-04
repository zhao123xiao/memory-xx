import "./test-harness/config.js";
import { readdirSync } from "node:fs";
import { Pool } from "pg";
import { loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import { createPostgresPoolConfig } from "../app/db/adapters/postgres-config";

interface CheckResult {
  readonly id: string;
  readonly ok: boolean;
  readonly count: number;
  readonly severity: "critical" | "warning";
  readonly detail: string;
}

const EXPECTED_TABLES = [
  "memory_records",
  "memory_events",
  "memory_sources",
  "memory_relations",
  "memory_entities",
  "memory_entity_links",
  "memory_episodes",
  "outbox_events",
  "recall_traces",
  "recall_feedback_events",
  "trusted_agents",
  "trusted_agent_scope_grants",
  "scope_generations",
  "memory_xx_schema_migrations"
] as const;

const EXPECTED_INDEXES = [
  "idx_memory_governance_runs_active_lease",
  "idx_trusted_agent_scope_grants_active_unique",
  "idx_trusted_agent_scope_grants_lookup"
] as const;

function migrationVersionForFile(filename: string, allFiles: readonly string[]): string {
  const prefix = filename.includes("_") ? filename.slice(0, filename.indexOf("_")) : filename.replace(/\.sql$/u, "");
  const samePrefix = allFiles.filter((file) => file.startsWith(`${prefix}_`));
  return samePrefix.length > 1 ? filename.replace(/\.sql$/u, "") : prefix;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

async function count(pool: Pool, sql: string): Promise<number> {
  const result = await pool.query<{ count: string | number }>(sql);
  return Number(result.rows[0]?.count ?? 0);
}

async function missingValues(
  pool: Pool,
  sql: string,
  expected: readonly string[],
  params: readonly unknown[] = []
): Promise<string[]> {
  const result = await pool.query<{ value: string }>(sql, params);
  const actual = new Set(result.rows.map((row) => row.value));
  return expected.filter((value) => !actual.has(value));
}

async function main(): Promise<void> {
  const config = loadMemoryXXPostgresConfig();
  const pool = new Pool(createPostgresPoolConfig(config));
  const schema = quoteIdent(config.schema);
  try {
    const checks: CheckResult[] = [];
    const migrationFiles = readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort();
    const expectedMigrationVersions = migrationFiles.map((file) => migrationVersionForFile(file, migrationFiles));
    const missingTables = await missingValues(pool, `
      SELECT table_name AS value
      FROM information_schema.tables
      WHERE table_schema = ${"$1"}
    `, EXPECTED_TABLES, [config.schema]);
    checks.push({
      id: "expected_tables_present",
      severity: "critical",
      count: missingTables.length,
      ok: missingTables.length === 0,
      detail: missingTables.length === 0
        ? `expected tables present: ${EXPECTED_TABLES.length}`
        : `missing tables: ${missingTables.join(", ")}`
    });
    const missingIndexes = await missingValues(pool, `
      SELECT indexname AS value
      FROM pg_indexes
      WHERE schemaname = ${"$1"}
    `, EXPECTED_INDEXES, [config.schema]);
    checks.push({
      id: "expected_indexes_present",
      severity: "critical",
      count: missingIndexes.length,
      ok: missingIndexes.length === 0,
      detail: missingIndexes.length === 0
        ? `expected indexes present: ${EXPECTED_INDEXES.length}`
        : `missing indexes: ${missingIndexes.join(", ")}`
    });
    const missingMigrations = await missingValues(pool, `
      SELECT version AS value
      FROM ${schema}.memory_xx_schema_migrations
    `, expectedMigrationVersions);
    checks.push({
      id: "migration_files_applied",
      severity: "critical",
      count: missingMigrations.length,
      ok: missingMigrations.length === 0,
      detail: missingMigrations.length === 0
        ? `all migration files applied: ${migrationFiles.length}`
        : `missing migration versions from live ledger: ${missingMigrations.join(", ")}`
    });
    const migration0020Applied = missingMigrations.includes("0020") ? 1 : 0;
    checks.push({
      id: "migration_0020_trusted_agent_scope_grants_applied",
      severity: "critical",
      count: migration0020Applied,
      ok: migration0020Applied === 0,
      detail: migration0020Applied === 0
        ? "0020_trusted_agent_scope_grants.sql is applied in live ledger"
        : "0020_trusted_agent_scope_grants.sql is missing from live ledger"
    });
    checks.push({
      id: "one_current_per_scope_dedupe_key",
      severity: "critical",
      count: await count(pool, `
        SELECT count(*) FROM (
          SELECT scope_type, scope_id, dedupe_key
          FROM ${schema}.memory_records
          WHERE is_current IS TRUE AND dedupe_key IS NOT NULL
          GROUP BY scope_type, scope_id, dedupe_key
          HAVING count(*) > 1
        ) dup
      `),
      ok: true,
      detail: "scope + dedupe_key has at most one current record",
    });
    checks.push({
      id: "non_recallable_lifecycle_not_current",
      severity: "critical",
      count: await count(pool, `
        SELECT count(*)
        FROM ${schema}.memory_records
        WHERE lifecycle_status IN ('tombstone', 'archived', 'superseded', 'rejected')
          AND is_current IS TRUE
      `),
      ok: true,
      detail: "tombstoned/archived/superseded/rejected records are not current",
    });
    checks.push({
      id: "outbox_cursor_points_to_dispatched",
      severity: "critical",
      count: await count(pool, `
        SELECT count(*)
        FROM ${schema}.exporter_state state
        JOIN ${schema}.outbox_events event ON event.id = state.last_successful_event_id
        WHERE event.dispatch_status != 'dispatched'
      `),
      ok: true,
      detail: "exporter cursor points only to dispatched events",
    });
    checks.push({
      id: "trusted_agent_token_hash_unique",
      severity: "critical",
      count: await count(pool, `
        SELECT count(*) FROM (
          SELECT token_hash
          FROM ${schema}.trusted_agents
          GROUP BY token_hash
          HAVING count(*) > 1
        ) dup
      `),
      ok: true,
      detail: "trusted agent token hashes are unique",
    });
    checks.push({
      id: "recall_feedback_trace_fk_complete",
      severity: "critical",
      count: await count(pool, `
        SELECT count(*)
        FROM ${schema}.recall_feedback_events feedback
        LEFT JOIN ${schema}.recall_traces trace ON trace.id = feedback.recall_trace_id
        WHERE trace.id IS NULL
      `),
      ok: true,
      detail: "recall feedback events reference existing traces",
    });
    checks.push({
      id: "scope_generation_non_negative",
      severity: "critical",
      count: await count(pool, `
        SELECT count(*)
        FROM ${schema}.scope_generations
        WHERE generation < 0
      `),
      ok: true,
      detail: "scope generations are non-negative and monotonic by update contract",
    });
    checks.push({
      id: "migration_version_unique",
      severity: "critical",
      count: await count(pool, `
        SELECT count(*) FROM (
          SELECT version
          FROM ${schema}.memory_xx_schema_migrations
          GROUP BY version
          HAVING count(*) > 1
        ) dup
      `),
      ok: true,
      detail: "migration versions are unique in the live ledger",
    });

    const normalized = checks.map((check) => ({ ...check, ok: check.ok && check.count === 0 }));
    const ok = normalized.every((check) => check.ok || check.severity === "warning");
    process.stdout.write(JSON.stringify({ ok, checks: normalized }, null, 2) + "\n");
    if (!ok) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

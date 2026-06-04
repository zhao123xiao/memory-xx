import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { createClient } from "redis";

interface SmokeStatus {
  readonly status: "ok" | "warning" | "environment-blocked" | "not-run";
  readonly reason?: string;
}

interface CapacitySnapshot {
  readonly captured_at: string;
  readonly env_path: string;
  readonly postgres: Record<string, unknown>;
  readonly qdrant: Record<string, unknown>;
  readonly redis: Record<string, unknown>;
  readonly metrics: Record<string, unknown>;
}

interface TextPrimaryKeyCapacityEstimate {
  readonly target_records: number;
  readonly estimated_memory_records_table_bytes: number;
  readonly estimated_memory_records_pkey_bytes: number;
  readonly estimated_insert_latency_ms: number;
  readonly estimated_write_amplification_ratio: number;
  readonly migration_recommended: boolean;
  readonly recommendation: string;
}

function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    values[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return values;
}

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe identifier: ${value}`);
  }
  return `"${value}"`;
}

async function collectPostgres(env: Record<string, string>): Promise<Record<string, unknown>> {
  const databaseUrl = env.MEMORY_XX_DATABASE_URL ?? "";
  const schema = env.MEMORY_XX_DATABASE_SCHEMA || "memory_xx";
  if (!databaseUrl) return { available: false, reason: "MEMORY_XX_DATABASE_URL not configured" };

  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await pool.query(`SET search_path TO ${quoteIdent(schema)}, public`);
    const counts = await pool.query(`
      SELECT
        (SELECT count(*)::bigint FROM memory_records) AS memory_records,
        (SELECT count(*)::bigint FROM recall_traces) AS recall_traces,
        (SELECT count(*)::bigint FROM recall_feedback_events) AS recall_feedback_events,
        (SELECT count(*)::bigint FROM outbox_events) AS outbox_events,
        (SELECT count(*)::bigint FROM outbox_events WHERE dispatch_status != 'dispatched') AS outbox_pending_or_failed,
        (SELECT pg_database_size(current_database())::bigint) AS database_size_bytes
    `);
    const growth = await pool.query(`
      SELECT
        (SELECT count(*)::bigint FROM memory_records WHERE created_at >= now() - interval '24 hours') AS memory_records_24h,
        (SELECT count(*)::bigint FROM recall_traces WHERE created_at >= now() - interval '24 hours') AS recall_traces_24h,
        (SELECT count(*)::bigint FROM recall_feedback_events WHERE created_at >= now() - interval '24 hours') AS recall_feedback_events_24h,
        (SELECT count(*)::bigint FROM outbox_events WHERE created_at >= now() - interval '24 hours') AS outbox_events_24h
    `);
    const outboxStatuses = await pool.query(`
      SELECT dispatch_status, count(*)::bigint AS count
      FROM outbox_events
      GROUP BY dispatch_status
      ORDER BY dispatch_status
    `);
    const relationSizes = await pool.query(`
      WITH memory_table AS (
        SELECT 'memory_records'::regclass AS oid
      ),
      primary_index AS (
        SELECT i.indexrelid
        FROM pg_index i
        JOIN memory_table t ON t.oid = i.indrelid
        WHERE i.indisprimary
        LIMIT 1
      )
      SELECT
        pg_total_relation_size((SELECT oid FROM memory_table))::bigint AS memory_records_total_bytes,
        pg_relation_size((SELECT oid FROM memory_table))::bigint AS memory_records_heap_bytes,
        COALESCE(pg_relation_size((SELECT indexrelid FROM primary_index)), 0)::bigint AS memory_records_pkey_bytes,
        COALESCE((SELECT indexrelid::regclass::text FROM primary_index), '') AS memory_records_pkey_name
    `);
    return {
      available: true,
      schema,
      counts: stringifyBigints(counts.rows[0] ?? {}),
      growth_24h: stringifyBigints(growth.rows[0] ?? {}),
      outbox_statuses: outboxStatuses.rows.map(stringifyBigints),
      relation_sizes: stringifyBigints(relationSizes.rows[0] ?? {}),
    };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function collectQdrant(env: Record<string, string>): Promise<Record<string, unknown>> {
  const baseUrl = env.MEMORY_XX_QDRANT_BASE_URL || "";
  const collection = env.MEMORY_XX_QDRANT_COLLECTION || env.MEMORY_XX_QDRANT_COLLECTION_NAME || "";
  if (!baseUrl || !collection) return { available: false, reason: "qdrant url or collection not configured" };
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/collections/${encodeURIComponent(collection)}/points/count`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.MEMORY_XX_QDRANT_API_KEY ? { "api-key": env.MEMORY_XX_QDRANT_API_KEY } : {}),
      },
      body: JSON.stringify({ exact: true }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json().catch(() => null);
    return {
      available: response.ok,
      status: response.status,
      collection,
      points: typeof body?.result?.count === "number" ? body.result.count : null,
      response: body,
    };
  } catch (error) {
    return { available: false, collection, error: error instanceof Error ? error.message : String(error) };
  }
}

async function collectRedis(env: Record<string, string>): Promise<Record<string, unknown>> {
  const url = env.MEMORY_XX_REDIS_URL || "";
  if (!url) return { available: false, reason: "MEMORY_XX_REDIS_URL not configured" };
  const client = createClient({ url });
  try {
    await client.connect();
    const info = await client.info("memory");
    const dbSize = await client.dbSize();
    return {
      available: true,
      keys: dbSize,
      used_memory_bytes: numberFromInfo(info, "used_memory"),
      maxmemory_bytes: numberFromInfo(info, "maxmemory"),
    };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

async function collectMetrics(env: Record<string, string>): Promise<Record<string, unknown>> {
  const token = env.MEMORY_XX_API_TOKEN || env.MEMORY_XX_ADMIN_TOKEN || "";
  const baseUrl = env.MEMORY_XX_WRAPPER_URL || `http://127.0.0.1:${env.MEMORY_XX_WRAPPER_PORT || "5100"}`;
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/metrics`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      return { available: false, status: response.status, reason: "metrics endpoint returned non-2xx" };
    }
    const body = await response.json().catch(() => null);
    return {
      available: true,
      status: response.status,
      cost_counters: extractCostCounters(body),
      raw_counter_count: Array.isArray(body?.counters) ? body.counters.length : null,
    };
  } catch (error) {
    return { available: false, status: "environment-blocked", error: error instanceof Error ? error.message : String(error) };
  }
}

function extractCostCounters(body: unknown): Record<string, unknown> {
  const counters = Array.isArray((body as { counters?: unknown })?.counters)
    ? ((body as { counters: Array<{ name?: string; value?: unknown }> }).counters)
    : [];
  const interesting = counters.filter((counter) =>
    /embedding|rerank|fallback|429|rate_limit|redis|qdrant/i.test(String(counter.name ?? ""))
  );
  const snapshotKeys = body && typeof body === "object"
    ? Object.keys(body as Record<string, unknown>).filter((key) => /embedding|rerank|fallback|429|rate_limit|redis|qdrant/i.test(key))
    : [];
  return {
    available: interesting.length > 0 || snapshotKeys.length > 0,
    counters: interesting.slice(0, 40),
    snapshot_keys: snapshotKeys.slice(0, 40),
  };
}

function numberFromInfo(info: string, key: string): number | null {
  const match = new RegExp(`^${key}:(\\d+)`, "m").exec(info);
  return match ? Number(match[1]) : null;
}

function stringifyBigints(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]));
}

function currentMemoryRecordCount(snapshot: CapacitySnapshot): number | null {
  const counts = snapshot.postgres.counts as Record<string, unknown> | undefined;
  const value = counts?.memory_records;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function readNumericField(source: Record<string, unknown> | undefined, key: string): number | null {
  const value = source?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) return Number(value);
  return null;
}

function buildTextPrimaryKeyCapacityPlan(snapshot: CapacitySnapshot): {
  readonly mode: "measured-estimate" | "default-estimate";
  readonly current_records: number | null;
  readonly current_memory_records_table_bytes: number | null;
  readonly current_memory_records_pkey_bytes: number | null;
  readonly current_pkey_name: string | null;
  readonly assumptions: Record<string, unknown>;
  readonly targets: readonly TextPrimaryKeyCapacityEstimate[];
} {
  const currentRecords = currentMemoryRecordCount(snapshot);
  const relationSizes = snapshot.postgres.relation_sizes as Record<string, unknown> | undefined;
  const tableBytes = readNumericField(relationSizes, "memory_records_total_bytes");
  const pkeyBytes = readNumericField(relationSizes, "memory_records_pkey_bytes");
  const pkeyName = typeof relationSizes?.memory_records_pkey_name === "string" && relationSizes.memory_records_pkey_name
    ? relationSizes.memory_records_pkey_name
    : null;
  const measured = currentRecords !== null && currentRecords > 0 && tableBytes !== null && pkeyBytes !== null && pkeyBytes > 0;
  const tableBytesPerRow = measured ? Math.max(800, tableBytes / currentRecords) : 1_200;
  const pkeyBytesPerRow = measured ? Math.max(80, pkeyBytes / currentRecords) : 112;
  const currentLatencyBaselineMs = 2.5;
  const targets = [100_000, 300_000, 1_000_000].map((target) => {
    const estimatedTableBytes = Math.ceil(tableBytesPerRow * target);
    const estimatedPkeyBytes = Math.ceil(pkeyBytesPerRow * target * Math.log10(Math.max(10, target)) / Math.log10(Math.max(10, currentRecords ?? 10_000)));
    const estimatedWriteAmplification = Number((estimatedPkeyBytes / Math.max(1, estimatedTableBytes)).toFixed(4));
    const estimatedLatencyMs = Number((currentLatencyBaselineMs * (1 + estimatedWriteAmplification) * Math.log2(Math.max(2, target)) / Math.log2(10_000)).toFixed(2));
    const migrationRecommended =
      target >= 1_000_000 ||
      estimatedPkeyBytes >= 512 * 1024 * 1024 ||
      estimatedLatencyMs >= 25 ||
      estimatedWriteAmplification >= 0.35;
    return {
      target_records: target,
      estimated_memory_records_table_bytes: estimatedTableBytes,
      estimated_memory_records_pkey_bytes: estimatedPkeyBytes,
      estimated_insert_latency_ms: estimatedLatencyMs,
      estimated_write_amplification_ratio: estimatedWriteAmplification,
      migration_recommended: migrationRecommended,
      recommendation: migrationRecommended
        ? "prepare bigint surrogate key migration plan before this scale"
        : "TEXT primary key remains acceptable with current measured profile",
    };
  });
  return {
    mode: measured ? "measured-estimate" : "default-estimate",
    current_records: currentRecords,
    current_memory_records_table_bytes: tableBytes,
    current_memory_records_pkey_bytes: pkeyBytes,
    current_pkey_name: pkeyName,
    assumptions: {
      table_bytes_per_row: Math.ceil(tableBytesPerRow),
      pkey_bytes_per_row: Math.ceil(pkeyBytesPerRow),
      latency_model: "read-only estimate from current relation size; does not insert synthetic production rows",
      migration_trigger: "target>=1M or pkey>=512MiB or insert_latency>=25ms or write_amplification>=0.35",
    },
    targets,
  };
}

function targetStatus(currentRecords: number | null, target: number): SmokeStatus {
  if (currentRecords === null) {
    return { status: "environment-blocked", reason: "postgres count unavailable" };
  }
  if (currentRecords >= target) {
    return { status: "ok", reason: `covered by current data set (${currentRecords} records)` };
  }
  return { status: "not-run", reason: `requires live test namespace load to reach ${target} records; current=${currentRecords}` };
}

function formatBytes(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function writeReport(outputDir: string, snapshot: CapacitySnapshot, loadSmoke: Record<string, unknown>): void {
  const currentRecords = currentMemoryRecordCount(snapshot);
  const qdrantPoints = typeof snapshot.qdrant.points === "number" ? snapshot.qdrant.points : "unknown";
  const redisKeys = typeof snapshot.redis.keys === "number" ? snapshot.redis.keys : "unknown";
  const textPkPlan = loadSmoke.text_primary_key_capacity_plan as ReturnType<typeof buildTextPrimaryKeyCapacityPlan>;
  const lines = [
    "# M5 Capacity Smoke",
    "",
    `- captured_at: ${snapshot.captured_at}`,
    `- env_path: ${snapshot.env_path}`,
    `- memory_records: ${currentRecords ?? "unknown"}`,
    `- qdrant_points: ${qdrantPoints}`,
    `- redis_keys: ${redisKeys}`,
    "",
    "## Smoke Targets",
    "",
    `- 1k: ${JSON.stringify((loadSmoke.targets as Record<string, unknown>).records_1k)}`,
    `- 10k: ${JSON.stringify((loadSmoke.targets as Record<string, unknown>).records_10k)}`,
    `- 100k: scheduled/live benchmark, non-blocking for Release DoD`,
    `- 300k: read-only TEXT primary key estimate, see below`,
    `- 1m: read-only TEXT primary key migration trigger estimate, see below`,
    "",
    "## TEXT Primary Key Capacity Plan",
    "",
    `- mode: ${textPkPlan.mode}`,
    `- current_pkey_name: ${textPkPlan.current_pkey_name ?? "unknown"}`,
    `- current_memory_records_table: ${formatBytes(textPkPlan.current_memory_records_table_bytes ?? undefined)}`,
    `- current_memory_records_pkey: ${formatBytes(textPkPlan.current_memory_records_pkey_bytes ?? undefined)}`,
    "",
    "| target | estimated table | estimated pkey | est insert latency | write amplification | recommendation |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    ...textPkPlan.targets.map((target) =>
      `| ${target.target_records.toLocaleString("en-US")} | ${formatBytes(target.estimated_memory_records_table_bytes)} | ${formatBytes(target.estimated_memory_records_pkey_bytes)} | ${target.estimated_insert_latency_ms} ms | ${target.estimated_write_amplification_ratio} | ${target.recommendation} |`
    ),
    "",
    "## Notes",
    "",
    "- This command is read-only by default and does not create load-test memories.",
    "- Run the existing live load harness only against an explicit test namespace before treating 10k/100k as executed load tests.",
  ];
  writeFileSync(join(outputDir, "capacity-report.md"), `${lines.join("\n")}\n`, { mode: 0o600 });
}

async function main(): Promise<void> {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const outputDir = join(process.cwd(), "artifacts", "capacity", date);
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });

  const envPath = process.env.MEMORY_XX_ENV_PATH || join(process.cwd(), ".env");
  const fileEnv = readEnvFile(envPath);
  const env = { ...fileEnv, ...process.env } as Record<string, string>;
  const capturedAt = new Date().toISOString();

  const [postgres, qdrant, redis, metrics] = await Promise.all([
    collectPostgres(env),
    collectQdrant(env),
    collectRedis(env),
    collectMetrics(env),
  ]);
  const snapshot: CapacitySnapshot = {
    captured_at: capturedAt,
    env_path: envPath,
    postgres,
    qdrant,
    redis,
    metrics,
  };
  const currentRecords = currentMemoryRecordCount(snapshot);
  const loadSmoke = {
    captured_at: capturedAt,
    mode: "read-only-capacity-smoke",
    targets: {
      records_1k: targetStatus(currentRecords, 1_000),
      records_10k: targetStatus(currentRecords, 10_000),
      records_100k: {
        status: "not-run",
        reason: "scheduled/live benchmark; non-blocking for Release DoD",
      },
    },
    projector_backlog_small_batch: {
      status: "not-run",
      reason: "requires explicit live test namespace event injection",
    },
    text_primary_key_capacity_plan: buildTextPrimaryKeyCapacityPlan(snapshot),
    metrics,
  };

  writeFileSync(join(outputDir, "load-smoke.json"), JSON.stringify({ snapshot, load_smoke: loadSmoke }, null, 2) + "\n", { mode: 0o600 });
  writeReport(outputDir, snapshot, loadSmoke);
  process.stdout.write(JSON.stringify({ ok: true, output_dir: outputDir, load_smoke: loadSmoke }, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

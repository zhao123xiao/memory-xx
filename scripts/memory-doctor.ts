import "./test-harness/config.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { Pool } from "pg";
import { config, redactedConfig } from "./test-harness/config.js";
import { httpGet, httpPost, apiUrl } from "./test-harness/lib/http-client.js";
import { getCollectionInfo } from "./test-harness/lib/qdrant-helpers.js";
import { createPermissionChecker, inspectTokenSeparation } from "../app/server/permissions.js";
import {
  buildRuntimeProfilePlan,
  componentExpectedInProfile,
  componentRequiredInProfile,
  parseMemoryRuntimeProfile,
  RUNTIME_COMPONENTS,
  type MemoryRuntimeProfile,
} from "../app/runtime-profiles.js";
import {
  resolveRuntimeModuleState,
  type RuntimeEnv,
} from "../app/runtime-modules.js";
import { validateRuntimeConfig } from "../app/runtime-config-validator.js";
import { buildSystemdUserEnv } from "../app/ops/systemd-user.js";

type Status = "ready" | "degraded" | "blocked";
type DoctorTarget = "release-ready" | "strict-ready" | "graph-ready" | "embedding-ready" | "quality-ready" | "ops-ready";

interface DoctorReport {
  ok: boolean;
  score: number;
  status: Status;
  generated_at: string;
  target: string;
  mode: MemoryRuntimeProfile;
  env: Record<string, string>;
  blockers: string[];
  warnings: string[];
  next_actions: string[];
  checks: Record<string, unknown>;
}

function addUnique(items: string[], value: string): void {
  if (!items.includes(value)) items.push(value);
}

function readCommandJson(command: string, args: readonly string[]): { ok: boolean; body: unknown; error?: string } {
  const parseJsonFromOutput = (stdout: string): unknown => {
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start < 0 || end < start) throw new Error("json_object_not_found");
    return JSON.parse(stdout.slice(start, end + 1));
  };
  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: "/tmp" },
      maxBuffer: 20 * 1024 * 1024,
    });
    return { ok: true, body: parseJsonFromOutput(stdout) };
  } catch (error: any) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    if (stdout.trim()) {
      try {
        return { ok: false, body: parseJsonFromOutput(stdout), error: error.message };
      } catch {}
    }
    return { ok: false, body: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function parseTarget(): DoctorTarget {
  const index = process.argv.indexOf("--target");
  const raw = index >= 0 ? process.argv[index + 1] : "release-ready";
  return raw === "strict-ready" ||
    raw === "graph-ready" ||
    raw === "embedding-ready" ||
    raw === "quality-ready" ||
    raw === "ops-ready"
    ? raw
    : "release-ready";
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseDoctorMode(target: DoctorTarget): MemoryRuntimeProfile {
  const explicit = argValue("--mode");
  if (explicit) return parseMemoryRuntimeProfile(explicit);
  if (target === "release-ready") return "full";
  return parseMemoryRuntimeProfile();
}

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`Unsafe identifier: ${value}`);
  return `"${value}"`;
}

function migrationVersionForFile(filename: string, allFiles: readonly string[]): string {
  const prefix = filename.includes("_") ? filename.slice(0, filename.indexOf("_")) : filename.replace(/\.sql$/u, "");
  const samePrefix = allFiles.filter((file) => file.startsWith(`${prefix}_`));
  return samePrefix.length > 1 ? filename.replace(/\.sql$/u, "") : prefix;
}

function scanDriftFiles(blockers: string[], warnings: string[]): Record<string, unknown> {
  const files = [
    "README.md",
    "docs/api.md",
    "docs/architecture.md",
    "docs/operations.md",
    "scripts/load-test.ts",
    "scripts/start-mcp-server.ts",
    "scripts/functional-test-memory-xx.sh",
    "scripts/capacity-smoke.ts",
    "scripts/test-harness/recall-quality-smoke.mjs",
    "app/server/http-server.ts",
  ];
  const findings: Array<{ file: string; pattern: string }> = [];
  const patterns = [
    { name: "legacy_wrapper_port_4001", regex: /4001/ },
    { name: "legacy_env_DATABASE_URL", regex: /(?<!MEMORY_XX_)DATABASE_URL/ },
    { name: "legacy_env_REDIS_URL", regex: /(?<!MEMORY_XX_)REDIS_URL/ },
    { name: "legacy_env_QDRANT_URL", regex: /(?<!MEMORY_XX_)QDRANT_URL/ },
    { name: "legacy_env_VECTOR_BACKEND", regex: /\bVECTOR_BACKEND\b/ },
    { name: "legacy_env_RUNTIME_MODE", regex: /\bRUNTIME_MODE\b/ },
  ];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const raw = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      if (pattern.regex.test(raw)) findings.push({ file, pattern: pattern.name });
    }
  }
  if (findings.length > 0) addUnique(warnings, "docs_env_script_drift");
  return {
    checked_files: files,
    findings,
    expected: {
      wrapper_port: 5100,
      env_prefix: "MEMORY_XX_*",
      redis_default: "redis://127.0.0.1:6381/0",
    },
  };
}

function summarizeQueryEmbeddingCache(snapshot: any, warnings: string[]): Record<string, unknown> {
  const stats = snapshot?.stats ?? {};
  const shared = snapshot?.shared_cache ?? {};
  const memoryHits = Number(stats.memory_hits ?? 0);
  const redisHits = Number(stats.redis_hits ?? shared?.stats?.hits ?? 0);
  const redisMisses = Number(stats.redis_misses ?? shared?.stats?.misses ?? 0);
  const redisStores = Number(shared?.stats?.stores ?? 0);
  const redisFallbacks = Number(stats.redis_fallbacks ?? shared?.stats?.fallbacks ?? 0);
  const upstreamFailures = Number(stats.upstream_failures ?? 0);
  const lookups = redisHits + redisMisses;
  const hitRate = lookups > 0 ? redisHits / lookups : null;
  const effectiveLookups = memoryHits + redisHits + redisMisses;
  const effectiveHitRate = effectiveLookups > 0 ? (memoryHits + redisHits) / effectiveLookups : null;
  const configured = Boolean(shared?.configured ?? snapshot?.configured);
  if (
    configured &&
    hitRate !== null &&
    hitRate < 0.10 &&
    redisStores > 20 &&
    (effectiveHitRate === null || effectiveHitRate < 0.50)
  ) {
    addUnique(warnings, "query_embedding_cache_low_hit_rate");
  }
  return {
    configured,
    memory_hits: memoryHits,
    redis_hits: redisHits,
    redis_misses: redisMisses,
    redis_stores: redisStores,
    redis_fallbacks: redisFallbacks,
    redis_hit_rate: hitRate,
    effective_hit_rate: effectiveHitRate,
    upstream_failures: upstreamFailures,
    remediation: hitRate !== null && hitRate < 0.10 && (effectiveHitRate === null || effectiveHitRate < 0.50)
      ? "Check query normalization, key context model/dims/api_base/version, and Redis TTL."
      : undefined,
  };
}

function inspectMigrationNaming(warnings: string[]): Record<string, unknown> {
  const migrationFiles = readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort();
  const byPrefix = new Map<string, string[]>();
  for (const file of migrationFiles) {
    const prefix = file.slice(0, 4);
    const group = byPrefix.get(prefix) ?? [];
    group.push(file);
    byPrefix.set(prefix, group);
  }
  const duplicateVersions = [...byPrefix.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([version, files]) => ({ version, files }));
  const knownExceptions = [{
    version: "0017",
    files: ["0017_governance_run_lease.sql", "0017_scope_generations.sql"],
    reason: "Historical split migration already applied in live ledgers; do not rename applied files.",
  }];
  const unexpected = duplicateVersions.filter((dup) =>
    !knownExceptions.some((item) =>
      item.version === dup.version &&
      item.files.length === dup.files.length &&
      item.files.every((file) => dup.files.includes(file))
    )
  );
  if (unexpected.length > 0) addUnique(warnings, "unexpected_duplicate_migration_version");
  return { duplicate_versions: duplicateVersions, known_exceptions: knownExceptions, unexpected };
}

function inspectRuntimeProfileConsistency(
  checks: Record<string, unknown>,
  mode: MemoryRuntimeProfile,
  blockers: string[]
): Record<string, unknown> {
  const wrapperHealth = (checks.services as any)?.wrapper?.body;
  const explicitProfile = process.env.MEMORY_XX_RUNTIME_PROFILE?.trim() || null;
  const parsedEnvProfile = explicitProfile ? parseMemoryRuntimeProfile(explicitProfile) : null;
  const wrapperMode = process.env.MEMORY_XX_WRAPPER_MODE?.trim() || wrapperHealth?.wrapper_mode || "recall-only";
  const recallPrimary = process.env.MEMORY_XX_RECALL_PRIMARY?.trim() || process.env.RECALL_PRIMARY?.trim() || "node";
  const healthProfile = wrapperHealth?.runtime_profile ?? null;
  const fullIntent = wrapperMode === "full" || recallPrimary === "fastpath" || mode === "full";
  const ok =
    explicitProfile !== null &&
    (!healthProfile || healthProfile === parsedEnvProfile) &&
    (!fullIntent || parsedEnvProfile === "full");
  if (!ok) addUnique(blockers, "runtime_profile_mismatch");
  return {
    ok,
    env_profile: explicitProfile,
    parsed_env_profile: parsedEnvProfile,
    doctor_mode: mode,
    wrapper_health_profile: healthProfile,
    wrapper_mode: wrapperMode,
    recall_primary: recallPrimary,
    full_intent: fullIntent,
    remediation: fullIntent ? "Set MEMORY_XX_RUNTIME_PROFILE=full in .env/systemd env and restart wrapper." : "Set MEMORY_XX_RUNTIME_PROFILE to the intended profile.",
  };
}

function detectWrapperProcessCount(): number | null {
  try {
    const raw = execFileSync("ps", ["-eo", "pid=,args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const currentPid = process.pid;
    const rows = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => {
        const match = line.match(/^(\d+)\s+(.+)$/);
        if (!match) return false;
        const pid = Number.parseInt(match[1] ?? "", 10);
        const args = match[2] ?? "";
        if (pid === currentPid) return false;
        if (/\bps\b|\bpgrep\b|\bgrep\b|\bnpx\b|\btsx\b|memory-doctor\.ts/.test(args)) return false;
        return /(?:^|\s)(?:node\s+)?(?:\S*\/)?wrapper-entry\.mjs(?:\s|$)|memory-xx-wrapper|memory-xx.*wrapper/.test(args);
      });
    return rows.length;
  } catch {
    return null;
  }
}

function inspectMultiInstanceBoundary(blockers: string[], warnings: string[]): Record<string, unknown> {
  const configuredCount = Number.parseInt(process.env.MEMORY_XX_INSTANCE_COUNT?.trim() || "1", 10);
  const detectedCount = detectWrapperProcessCount();
  const effectiveCount = Math.max(
    Number.isFinite(configuredCount) && configuredCount > 0 ? configuredCount : 1,
    detectedCount ?? 1
  );
  const lockBackend = process.env.MEMORY_XX_SEMANTIC_LOCK_BACKEND?.trim() || "local";
  const ok = effectiveCount <= 1 || lockBackend === "redis";
  if (!ok) addUnique(blockers, "multi_instance_local_lock_blocker");
  if (effectiveCount <= 1 && lockBackend === "local") addUnique(warnings, "single_instance_local_semantic_lock");
  return {
    ok,
    configured_instance_count: Number.isFinite(configuredCount) ? configuredCount : null,
    detected_wrapper_process_count: detectedCount,
    effective_instance_count: effectiveCount,
    semantic_lock_backend: lockBackend,
    supported_now: effectiveCount <= 1 || lockBackend === "redis",
    remediation: "Keep a single wrapper instance or implement MEMORY_XX_SEMANTIC_LOCK_BACKEND=redis before horizontal scaling.",
  };
}

function parseLogTime(line: string): number | null {
  try {
    const parsed = JSON.parse(line) as { ts?: unknown };
    if (typeof parsed.ts === "string") {
      const time = new Date(parsed.ts).getTime();
      return Number.isFinite(time) ? time : null;
    }
  } catch {}
  const fastpath = /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/.exec(line);
  if (fastpath) {
    const time = new Date(`${fastpath[1].replace(/\//g, "-")}+08:00`).getTime();
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

function userServiceStartedAt(serviceName: string): number | null {
  try {
    const raw = execFileSync(
      "systemctl",
      ["--user", "show", serviceName, "-p", "ActiveEnterTimestampUSec", "--value"],
      { encoding: "utf8", env: buildSystemdUserEnv() }
    ).trim();
    const micros = Number.parseInt(raw, 10);
    if (Number.isFinite(micros) && micros > 0) {
      return Math.floor(micros / 1000);
    }
  } catch {}

  try {
    const raw = execFileSync(
      "systemctl",
      ["--user", "show", serviceName, "-p", "ActiveEnterTimestamp", "--value"],
      { encoding: "utf8", env: buildSystemdUserEnv() }
    ).trim();
    if (!raw) return null;
    const millis = execFileSync("date", ["-d", raw, "+%s%3N"], { encoding: "utf8" }).trim();
    const parsed = Number.parseInt(millis, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function userServiceActive(serviceName: string): boolean {
  try {
    return execFileSync(
      "systemctl",
      ["--user", "is-active", serviceName],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: buildSystemdUserEnv() }
    ).trim() === "active";
  } catch {
    return false;
  }
}

function recentLogCount(filePath: string, patterns: readonly RegExp[], windowMs = 2 * 60 * 60 * 1000, sinceMs?: number | null): number {
  if (!existsSync(filePath)) return 0;
  const cutoff = Math.max(Date.now() - windowMs, sinceMs ?? 0);
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/).slice(-500);
  return lines.filter((line) => {
    if (!patterns.some((pattern) => pattern.test(line))) return false;
    const timestamp = parseLogTime(line);
    return timestamp === null || timestamp >= cutoff;
  }).length;
}

function latestFileUnder(dir: string, filename: string): string | null {
  if (!existsSync(dir)) return null;
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      const nested = `${fullPath}/${filename}`;
      if (existsSync(nested)) candidates.push({ path: nested, mtimeMs: statSync(nested).mtimeMs });
    } else if (entry.isFile() && entry.name === filename) {
      candidates.push({ path: fullPath, mtimeMs: statSync(fullPath).mtimeMs });
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.path ?? null;
}

function inspectReportFreshness(input: {
  readonly path: string | null;
  readonly maxAgeHours: number;
  readonly warningName: string;
  readonly warnings: string[];
}): Record<string, unknown> {
  if (!input.path || !existsSync(input.path)) {
    addUnique(input.warnings, input.warningName);
    return { ok: false, path: input.path, reason: "missing" };
  }
  const ageHours = (Date.now() - statSync(input.path).mtimeMs) / (60 * 60 * 1000);
  const ok = ageHours <= input.maxAgeHours;
  if (!ok) addUnique(input.warnings, input.warningName);
  let summary: unknown = null;
  try {
    const raw = JSON.parse(readFileSync(input.path, "utf8")) as Record<string, unknown>;
    summary = {
      timestamp: raw.timestamp ?? raw.generated_at,
      passRate: raw.passRate,
      metrics: raw.metrics,
      recommendation: raw.recommendation,
    };
  } catch {}
  return { ok, path: input.path, age_hours: ageHours, max_age_hours: input.maxAgeHours, summary };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeComponent(name: string) {
  return RUNTIME_COMPONENTS.find((component) => component.name === name);
}

export function classifyDoctorComponentProfileState(
  name: string,
  mode: MemoryRuntimeProfile,
  env: RuntimeEnv = process.env
): {
  readonly name: string;
  readonly role: "required" | "expected" | "optional" | "unknown";
  readonly enabled: boolean;
  readonly blocks_profile: boolean;
  readonly reason?: string;
} {
  const component = runtimeComponent(name);
  if (!component) {
    return {
      name,
      role: "unknown",
      enabled: false,
      blocks_profile: false,
      reason: "component_unknown",
    };
  }
  const resolved = resolveRuntimeModuleState(component, mode, env);
  return {
    name,
    role: componentRequiredInProfile(component, mode)
      ? "required"
      : componentExpectedInProfile(component, mode)
        ? "expected"
        : "optional",
    enabled: resolved.enabled,
    blocks_profile: resolved.blocks_profile,
    reason: resolved.reason,
  };
}

async function inspectDb(): Promise<Record<string, unknown>> {
  const pool = new Pool({ connectionString: config.dbUrl });
  const schema = quoteIdent(config.dbSchema);
  try {
    const migrationFiles = readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort();
    const expectedVersions = migrationFiles.map((file) => migrationVersionForFile(file, migrationFiles));
    const migrationResult = await pool.query<{ version: string; filename: string }>(
      `SELECT version, filename FROM ${schema}.memory_xx_schema_migrations ORDER BY version`
    );
    const liveVersions = migrationResult.rows.map((row) => row.version);
    const missingMigrations = expectedVersions.filter((version) => !liveVersions.includes(version));
    const tableResult = await pool.query<{ value: string | null }>(
      `SELECT to_regclass($1) AS value, to_regclass($2) AS value2`,
      [`${config.dbSchema}.trusted_agent_scope_grants`, `${config.dbSchema}.trusted_agents`]
    );
    const indexResult = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'trusted_agent_scope_grants' ORDER BY indexname`,
      [config.dbSchema]
    );
    const counts = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM ${schema}.memory_records) AS records,
        (SELECT count(*)::int FROM ${schema}.memory_records WHERE is_current IS TRUE AND lifecycle_status = 'candidate') AS candidate_current,
        (SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at))) / 86400, 0)::float FROM ${schema}.memory_records WHERE is_current IS TRUE AND lifecycle_status = 'candidate') AS candidate_oldest_days,
        (SELECT count(*)::int FROM ${schema}.outbox_events WHERE dispatch_status = 'pending') AS outbox_pending,
        (SELECT count(*)::int FROM ${schema}.memory_entities) AS entities,
        (SELECT count(*)::int FROM ${schema}.memory_entity_links) AS entity_links,
        (SELECT count(*)::int FROM ${schema}.memory_relations) AS relations,
        (SELECT count(*)::int FROM ${schema}.memory_episodes) AS episodes,
        (SELECT count(*)::int FROM ${schema}.memory_records WHERE is_current IS TRUE AND lifecycle_status = 'approved' AND content_embedding IS NOT NULL) AS pg_projected,
        (SELECT count(*)::int FROM ${schema}.memory_records WHERE is_current IS TRUE AND lifecycle_status = 'approved' AND (metadata->>'source' IS NULL OR metadata->>'source' = '')) AS missing_metadata_source,
        (SELECT count(*)::int FROM ${schema}.memory_records mr WHERE mr.is_current IS TRUE AND mr.lifecycle_status = 'approved' AND mr.episode_id IS NULL) AS missing_episode,
        (SELECT count(*)::int FROM ${schema}.memory_records mr WHERE mr.is_current IS TRUE AND mr.lifecycle_status = 'approved' AND NOT EXISTS (SELECT 1 FROM ${schema}.memory_entity_links mel WHERE mel.memory_id = mr.id)) AS missing_entity_link,
        (SELECT count(*)::int FROM ${schema}.memory_records mr WHERE mr.is_current IS TRUE AND mr.lifecycle_status = 'approved' AND NOT EXISTS (SELECT 1 FROM ${schema}.memory_relations rel WHERE rel.memory_id = mr.id OR rel.related_memory_id = mr.id)) AS missing_relation,
        (SELECT count(*)::int FROM ${schema}.memory_records WHERE is_current IS TRUE AND lifecycle_status IN ('approved', 'candidate') AND (
          CASE WHEN scope_id ~* '(^|[-_:])(test|load-test|mcp-user-flow|benchmark|smoke)([-_:]|$)' THEN 2 ELSE 0 END +
          CASE WHEN COALESCE(metadata->>'source', source_ref, source_kind, created_by, '') ~* '(test|benchmark|smoke|load)' THEN 1 ELSE 0 END +
          CASE WHEN COALESCE(title, '') || ' ' || content ~* '(temporary test|benchmark sample|schema example|Unified API test|Lx test|测试记录|测试污染)' THEN 1 ELSE 0 END +
          CASE WHEN metadata ? 'test_run_id' OR metadata ? 'testRunId' THEN 1 ELSE 0 END +
          CASE WHEN metadata->>'governance_test_pollution' = 'true' THEN 2 ELSE 0 END
        ) >= 3) AS test_pollution_high_confidence,
        (SELECT count(*)::int FROM ${schema}.memory_records WHERE is_current IS TRUE AND lifecycle_status = 'approved' AND metadata ? 'quality_gate') AS quality_gate_metadata_count
    `);
    return {
      migration_files: migrationFiles,
      live_migrations: migrationResult.rows,
      missing_migrations: missingMigrations,
      has_0020: liveVersions.includes("0020"),
      trusted_agent_scope_grants_table: Boolean(tableResult.rows[0]?.value),
      trusted_agents_table: Boolean((tableResult.rows[0] as Record<string, unknown> | undefined)?.value2),
      trusted_agent_scope_grant_indexes: indexResult.rows.map((row) => row.indexname),
      counts: counts.rows[0]
    };
  } finally {
    await pool.end();
  }
}

const SMALL_AUTOVACUUM_TABLES = [
  "memory_embedding_generations",
  "conversation_events",
  "governance_policy_overrides",
  "exporter_state",
  "recall_feedback_events",
  "scope_generations",
  "memory_governance_actions",
] as const;

async function inspectDatabaseMaintenance(blockers: string[], warnings: string[]): Promise<Record<string, unknown>> {
  const pool = new Pool({ connectionString: config.dbUrl });
  const schema = quoteIdent(config.dbSchema);
  try {
    const deadTupleWarningPct = Number.parseFloat(process.env.MEMORY_XX_SMALL_TABLE_DEAD_TUPLE_WARNING_PCT?.trim() || "50");
    const deadTupleWarningMin = Number.parseInt(process.env.MEMORY_XX_SMALL_TABLE_DEAD_TUPLE_WARNING_MIN?.trim() || "10", 10);
    const largeDeadTupleBlockerMin = Number.parseInt(process.env.MEMORY_XX_LARGE_TABLE_DEAD_TUPLE_BLOCKER_MIN?.trim() || "100000", 10);
    const largeDeadTupleBlockerPct = Number.parseFloat(process.env.MEMORY_XX_LARGE_TABLE_DEAD_TUPLE_BLOCKER_PCT?.trim() || "20");
    const walWarningRatio = Number.parseFloat(process.env.MEMORY_XX_WAL_WARNING_RATIO?.trim() || "0.7");
    const [deadTuples, smallTableOptions, settings] = await Promise.all([
      pool.query<{
        relname: string;
        n_live_tup: string;
        n_dead_tup: string;
        dead_pct: string;
        last_vacuum: string | null;
        last_autovacuum: string | null;
        last_analyze: string | null;
        last_autoanalyze: string | null;
        reloptions: string[] | null;
      }>(`
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
      `, [config.dbSchema]),
      pool.query<{
        relname: string;
        reloptions: string[] | null;
      }>(`
        SELECT cls.relname, cls.reloptions
        FROM pg_class cls
        JOIN pg_namespace ns ON ns.oid = cls.relnamespace
        WHERE ns.nspname = $1 AND cls.relname = ANY($2::text[])
        ORDER BY cls.relname
      `, [config.dbSchema, SMALL_AUTOVACUUM_TABLES]),
      pool.query<{ name: string; setting: string; unit: string | null }>(`
        SELECT name, setting, unit
        FROM pg_settings
        WHERE name IN ('max_wal_size', 'min_wal_size', 'archive_mode', 'archive_command', 'checkpoint_timeout')
        ORDER BY name
      `),
    ]);
    const wal = await pool.query<{ files: number; wal_size: string | null; wal_bytes: string | null }>(
      `SELECT count(*)::int AS files, pg_size_pretty(sum(size)) AS wal_size, sum(size)::bigint::text AS wal_bytes FROM pg_ls_waldir()`
    ).catch((error) => ({
      rows: [{ files: 0, wal_size: null, wal_bytes: null, error: error instanceof Error ? error.message : String(error) } as never],
    }));
    const maxWalSetting = settings.rows.find((row) => row.name === "max_wal_size");
    const maxWalBytes = maxWalSetting
      ? Number(maxWalSetting.setting) * (maxWalSetting.unit === "MB" ? 1024 * 1024 : 1)
      : 0;
    const walBytes = Number(wal.rows[0]?.wal_bytes ?? 0);
    const walRatio = maxWalBytes > 0 ? walBytes / maxWalBytes : null;
    const targetRows = deadTuples.rows.filter((row) => SMALL_AUTOVACUUM_TABLES.includes(row.relname as typeof SMALL_AUTOVACUUM_TABLES[number]));
    const smallWarnings = targetRows.filter((row) =>
      Number(row.n_dead_tup) >= deadTupleWarningMin &&
      Number(row.dead_pct) >= deadTupleWarningPct
    );
    const largeBlockers = deadTuples.rows.filter((row) =>
      Number(row.n_dead_tup) >= largeDeadTupleBlockerMin &&
      Number(row.dead_pct) >= largeDeadTupleBlockerPct
    );
    const missingOptions = smallTableOptions.rows.filter((row) => {
      const options = row.reloptions ?? [];
      return !options.some((option) => option.startsWith("autovacuum_vacuum_threshold=")) ||
        !options.some((option) => option.startsWith("autovacuum_vacuum_scale_factor=")) ||
        !options.some((option) => option.startsWith("autovacuum_analyze_threshold=")) ||
        !options.some((option) => option.startsWith("autovacuum_analyze_scale_factor="));
    });
    if (smallWarnings.length > 0) addUnique(warnings, "small_table_dead_tuple_ratio_high");
    if (missingOptions.length > 0) addUnique(warnings, "small_table_autovacuum_options_missing");
    if (walRatio !== null && walRatio >= walWarningRatio) addUnique(warnings, "wal_size_near_max_wal_size");
    if (largeBlockers.length > 0) addUnique(blockers, "large_table_dead_tuples_high");
    return {
      ok: largeBlockers.length === 0,
      thresholds: {
        small_table_dead_tuple_warning_pct: deadTupleWarningPct,
        small_table_dead_tuple_warning_min: deadTupleWarningMin,
        large_table_dead_tuple_blocker_min: largeDeadTupleBlockerMin,
        large_table_dead_tuple_blocker_pct: largeDeadTupleBlockerPct,
        wal_warning_ratio: walWarningRatio,
      },
      wal: {
        ...wal.rows[0],
        max_wal_bytes: maxWalBytes || null,
        wal_ratio: walRatio,
        settings: settings.rows,
      },
      top_dead_tuples: deadTuples.rows,
      small_table_autovacuum: {
        target_tables: SMALL_AUTOVACUUM_TABLES,
        configured: smallTableOptions.rows,
        missing_options: missingOptions,
        high_ratio_warnings: smallWarnings,
      },
      blockers: largeBlockers,
      note: "Small-table high dead tuple ratios are warnings unless absolute dead tuple counts are high.",
    };
  } catch (error) {
    addUnique(warnings, "database_maintenance_scan_failed");
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await pool.end();
  }
}

async function inspectEventLifecycle(blockers: string[], warnings: string[]): Promise<Record<string, unknown>> {
  const pool = new Pool({ connectionString: config.dbUrl });
  const schema = quoteIdent(config.dbSchema);
  const outboxPendingThreshold = Number.parseInt(process.env.MEMORY_XX_EVENT_OUTBOX_PENDING_BLOCKER_THRESHOLD?.trim() || "1000", 10);
  const outboxDeadLetterThreshold = Number.parseInt(process.env.MEMORY_XX_EVENT_OUTBOX_DEAD_LETTER_BLOCKER_THRESHOLD?.trim() || "0", 10);
  const eventRowsWarningThreshold = Number.parseInt(process.env.MEMORY_XX_EVENT_ROWS_WARNING_THRESHOLD?.trim() || "100000", 10);
  const outboxRetentionDays = Number.parseInt(process.env.MEMORY_XX_OUTBOX_EVENT_RETENTION_DAYS?.trim() || "90", 10);
  const memoryRetentionDays = Number.parseInt(process.env.MEMORY_XX_MEMORY_EVENT_RETENTION_DAYS?.trim() || "180", 10);
  const maxAttempts = Number.parseInt(process.env.MEMORY_XX_QDRANT_PROJECTOR_MAX_ATTEMPTS?.trim() || "5", 10);
  try {
    const [row] = await pool.query<{
      outbox_total: number | string;
      outbox_pending: number | string;
      outbox_failed: number | string;
      outbox_dead_letter: number | string;
      outbox_oldest_created_at: string | null;
      outbox_archive_eligible: number | string;
      memory_events_total: number | string;
      memory_events_oldest_created_at: string | null;
      memory_events_archive_eligible: number | string;
    }>(`
      SELECT
        (SELECT count(*)::int FROM ${schema}.outbox_events) AS outbox_total,
        (SELECT count(*)::int FROM ${schema}.outbox_events WHERE dispatch_status = 'pending') AS outbox_pending,
        (SELECT count(*)::int FROM ${schema}.outbox_events WHERE dispatch_status = 'failed') AS outbox_failed,
        (SELECT count(*)::int FROM ${schema}.outbox_events WHERE dispatch_status = 'failed' AND attempts >= $1) AS outbox_dead_letter,
        (SELECT min(created_at)::text FROM ${schema}.outbox_events) AS outbox_oldest_created_at,
        (SELECT count(*)::int FROM ${schema}.outbox_events WHERE dispatch_status = 'dispatched' AND created_at < now() - ($2::text || ' days')::interval) AS outbox_archive_eligible,
        (SELECT count(*)::int FROM ${schema}.memory_events) AS memory_events_total,
        (SELECT min(created_at)::text FROM ${schema}.memory_events) AS memory_events_oldest_created_at,
        (SELECT count(*)::int FROM ${schema}.memory_events WHERE created_at < now() - ($3::text || ' days')::interval) AS memory_events_archive_eligible
    `, [maxAttempts, outboxRetentionDays, memoryRetentionDays]).then((result) => result.rows);
    const outboxPending = Number(row?.outbox_pending ?? 0);
    const deadLetter = Number(row?.outbox_dead_letter ?? 0);
    const outboxTotal = Number(row?.outbox_total ?? 0);
    const memoryEventsTotal = Number(row?.memory_events_total ?? 0);
    if (outboxPending > outboxPendingThreshold) addUnique(blockers, "outbox_pending_over_threshold");
    if (deadLetter > outboxDeadLetterThreshold) addUnique(blockers, "outbox_dead_letter_present");
    if (outboxTotal > eventRowsWarningThreshold || memoryEventsTotal > eventRowsWarningThreshold) addUnique(warnings, "event_table_rows_high");
    if (Number(row?.outbox_archive_eligible ?? 0) > 0 || Number(row?.memory_events_archive_eligible ?? 0) > 0) {
      addUnique(warnings, "event_archive_eligible");
    }
    return {
      ok: outboxPending <= outboxPendingThreshold && deadLetter <= outboxDeadLetterThreshold,
      thresholds: {
        outbox_pending_blocker: outboxPendingThreshold,
        outbox_dead_letter_blocker: outboxDeadLetterThreshold,
        event_rows_warning: eventRowsWarningThreshold,
        outbox_success_retention_days: outboxRetentionDays,
        memory_events_retention_days: memoryRetentionDays,
      },
      outbox_events: {
        total: outboxTotal,
        pending: outboxPending,
        failed: Number(row?.outbox_failed ?? 0),
        dead_letter: deadLetter,
        oldest_created_at: row?.outbox_oldest_created_at ?? null,
        archive_eligible: Number(row?.outbox_archive_eligible ?? 0),
      },
      memory_events: {
        total: memoryEventsTotal,
        oldest_created_at: row?.memory_events_oldest_created_at ?? null,
        archive_eligible: Number(row?.memory_events_archive_eligible ?? 0),
      },
      commands: {
        scan: "TMPDIR=/tmp npm run memory:event-lifecycle -- --json",
        archive_dry_run: "TMPDIR=/tmp npm run memory:archive-events -- --json",
        archive_apply: "TMPDIR=/tmp npm run memory:archive-events -- --apply --json",
        outbox_recovery_scan: "TMPDIR=/tmp npm run memory:outbox-recovery -- scan --limit 20",
        outbox_recovery_apply: "TMPDIR=/tmp npm run memory:outbox-recovery -- replay --status failed --limit 20 --apply",
      },
    };
  } catch (error) {
    addUnique(warnings, "event_lifecycle_scan_failed");
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await pool.end();
  }
}

async function inspectServices(
  blockers: string[],
  warnings: string[],
  mode: MemoryRuntimeProfile
): Promise<Record<string, unknown>> {
  const services: Record<string, unknown> = {};
  for (const [name, url] of Object.entries({
    wrapper: apiUrl("/health"),
    fastpath: `${config.fastpathUrl}/health`,
    lexical: `${config.lexicalUrl}/health`,
    gateway: `${config.gatewayUrl}/health`,
    embedding_proxy: "http://127.0.0.1:5221/health",
    reranker: "http://127.0.0.1:8085/health",
    qdrant_proxy: "http://127.0.0.1:6335/health"
  })) {
    try {
      const response = await httpGet(url, { timeout: 5000 });
      services[name] = { ok: response.status === 200, status: response.status, url, body: name === "wrapper" || name === "embedding_proxy" ? response.body : undefined };
      if (response.status !== 200) {
        const componentState = classifyDoctorComponentProfileState(name, mode);
        if (componentState.blocks_profile) addUnique(blockers, `service_${name}_degraded`);
        else if (!componentState.enabled) services[name] = { ...(services[name] as Record<string, unknown>), disabled: true, reason: componentState.reason };
        else if (mode === "full" && name === "gateway") addUnique(blockers, "gateway_probe_port_drift");
        else addUnique(warnings, `service_${name}_degraded`);
      }
    } catch (error) {
      services[name] = { ok: false, url, error: error instanceof Error ? error.message : String(error) };
      const componentState = classifyDoctorComponentProfileState(name, mode);
      if (componentState.blocks_profile) addUnique(blockers, `service_${name}_unreachable`);
      else if (!componentState.enabled) services[name] = { ...(services[name] as Record<string, unknown>), disabled: true, reason: componentState.reason };
      else if (mode === "full" && name === "gateway") addUnique(blockers, "gateway_probe_port_drift");
      else addUnique(warnings, `service_${name}_unreachable`);
    }
  }
  return services;
}

async function inspectRouting(blockers: string[], warnings: string[]): Promise<Record<string, unknown>> {
  let lastRouting: Record<string, unknown> | null = null;
  const probeId = `doctor-routing-${randomUUID()}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
    const response = await httpPost(apiUrl("/api/memory/xx/recall/query"), {
      query: "memory-xx Reranker集成完成",
      scopeType: "project",
      scopeId: "local-default",
      limit: 8,
      explain: true,
      rerank: true,
      hybrid_mode: "model_rerank",
      debug: { enabled: true }
    }, { token: config.wrapperToken, timeout: 30000, headers: { "x-memory-xx-probe-id": probeId } });
    const body = response.body as any;
    const audit = body?.audit ?? {};
    const routing = {
      attempt,
      status: response.status,
      primary_backend: audit.primary_backend,
      lexical_hits: audit.lexical_hits ?? 0,
      vector_hits: audit.vector_hits ?? 0,
      rerank: audit.rerank ?? null
    };
      lastRouting = routing;
      if (audit.rerank?.backend === "model" && audit.rerank?.model_used === true) {
        if (audit.primary_backend !== "fastpath" || audit.fastpath?.used !== true) addUnique(warnings, "l3_fastpath_not_primary");
        if (Number(audit.vector_hits ?? 0) <= 0) addUnique(blockers, "l3_fastpath_vector_zero");
        return routing;
      }
      if (attempt < 3) {
        await sleep(audit.rerank?.reason === "model_timeout" ? 750 : 500);
        continue;
      }
      if (audit.primary_backend !== "fastpath" || audit.fastpath?.used !== true) addUnique(warnings, "l3_fastpath_not_primary");
      if (Number(audit.vector_hits ?? 0) <= 0) addUnique(blockers, "l3_fastpath_vector_zero");
      addUnique(blockers, "l3_model_reranker_unused");
      return routing;
    } catch (error) {
      lastRouting = { attempt, error: error instanceof Error ? error.message : String(error) };
      if (attempt < 2) {
        await sleep(500);
        continue;
      }
      addUnique(blockers, "l3_routing_probe_failed");
      return lastRouting;
    }
  }
  addUnique(blockers, "l3_routing_probe_failed");
  return lastRouting ?? { error: "routing_probe_not_run" };
}

async function inspectQdrant(): Promise<Record<string, unknown>> {
  try {
    return await getCollectionInfo();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function remediationPlan(blockers: readonly string[]): string[] {
  const actions: string[] = [];
  if (blockers.some((blocker) => blocker.startsWith("config_"))) {
    actions.push("Fix critical runtime config issues reported under checks.config_validation, restart wrapper/projector if env changed, then rerun TMPDIR=/tmp npm run memory:doctor -- --target release-ready --mode full --plan.");
  }
  if (blockers.includes("runtime_profile_mismatch")) {
    actions.push("Set MEMORY_XX_RUNTIME_PROFILE=full in <project-root>/.env, restart wrapper, then rerun TMPDIR=/tmp npm run memory:doctor -- --target ops-ready --mode full --plan.");
  }
  if (blockers.includes("multi_instance_local_lock_blocker")) {
    actions.push("Keep one wrapper instance or implement MEMORY_XX_SEMANTIC_LOCK_BACKEND=redis before running multiple wrapper instances.");
  }
  if (blockers.includes("outbox_pending_over_threshold") || blockers.includes("outbox_dead_letter_present")) {
    actions.push("Run TMPDIR=/tmp npm run memory:event-lifecycle -- --json and TMPDIR=/tmp npm run memory:outbox-recovery -- scan --limit 20, then replay with TMPDIR=/tmp npm run memory:outbox-recovery -- replay --status failed --limit 20 --apply only after reviewing the dry-run plan.");
  }
  if (blockers.includes("api_admin_token_overlap")) {
    actions.push("Set MEMORY_XX_API_TOKEN and MEMORY_XX_ADMIN_TOKEN to different non-empty values, restart wrapper, then rerun TMPDIR=/tmp npm run memory:doctor -- --target strict-ready --plan.");
  }
  if (blockers.includes("0020_not_applied") || blockers.includes("trusted_agent_scope_grants_missing")) {
    actions.push("Run shadow migration for 0020, then TMPDIR=/tmp npm run migrate, then rerun check:db-invariants.");
  }
  if (blockers.includes("gateway_probe_port_drift")) {
    actions.push("Set MEMORY_XX_GATEWAY_URL or OPENCLAW_GATEWAY_URL to the live gateway URL and rerun check:observation.");
  }
  if (blockers.includes("l3_fastpath_vector_zero")) {
    actions.push("Check embedding proxy/429 logs and fastpath Qdrant path; vector_hits must be greater than zero.");
  }
  if (blockers.includes("l3_model_reranker_unused")) {
    actions.push("Check reranker mode/thresholds and real recall audit; model reranker must be used in L3 routing.");
  }
  if (blockers.includes("embedding_429_recent")) {
    actions.push("Lower embedding concurrency or rely on query embedding cache; confirm no recent embedding 429 before release.");
  }
  if (blockers.includes("embedding_proxy_recent_429")) {
    actions.push("Run TMPDIR=/tmp npm run memory:embedding-calibrate, then apply the recommended proxy interval/concurrency and restart memory-xx-embedding-proxy-next.service.");
  }
  if (blockers.includes("embedding_upstream_unavailable")) {
    actions.push("Run systemctl --user start memory-xx-embedding-upstream.service; it starts <windows-drive>\\ovms\\run-embedding.bat on Windows GPU and verifies http://127.0.0.1:8082/v3 embeddings, then rerun TMPDIR=/tmp npm run memory:doctor -- --target embedding-ready --plan.");
  }
  if (blockers.includes("embedding_generation_mismatch") || blockers.includes("embedding_manifest_missing")) {
    actions.push("Run TMPDIR=/tmp npm run memory:embedding-manifest status, then validate/activate the intended generation or rollback to the last known good generation.");
  }
  if (blockers.includes("qdrant_alias_missing_or_wrong")) {
    actions.push("Run TMPDIR=/tmp npm run memory:qdrant-alias -- switch --alias=memory-xx-active --collection=<validated-collection>, then set MEMORY_XX_QDRANT_COLLECTION=memory-xx-active and restart wrapper/projector.");
  }
  if (blockers.includes("qdrant_projection_drift_blocked")) {
    actions.push("Run TMPDIR=/tmp npm run memory:auto-repair -- --json, inspect issues[].evidence.policy_blockers, then split or manually approve reconcile before applying.");
  }
  if (blockers.includes("qdrant_projection_reconcile_failed")) {
    actions.push("Check PostgreSQL/Qdrant connectivity, MEMORY_XX_QDRANT_COLLECTION alias, then rerun TMPDIR=/tmp npm run memory:qdrant-reconcile.");
  }
  if (blockers.includes("quality_report_missing_or_stale") || blockers.includes("quality_threshold_failed") || blockers.includes("quality_report_not_suite_all")) {
    actions.push("Run TMPDIR=/tmp npm run memory:quality -- --suite all, inspect migration_artifacts/quality-report.json, then rerun Doctor.");
  }
  if (blockers.includes("graph_benchmark_failed")) {
    actions.push("Run TMPDIR=/tmp npm run test:graph-recall and inspect L18 case metrics for miss_reason/source mix.");
  }
  if (blockers.some((blocker) => blocker.startsWith("ops_required_"))) {
    actions.push("Run TMPDIR=/tmp npm run memory:mode -- plan --mode <current-mode>, start missing required services with TMPDIR=/tmp npm run memory:up -- --mode <current-mode>, then rerun ops-ready.");
  }
  return actions;
}

async function embeddingUpstreamSmoke(model?: string, dims?: number): Promise<Record<string, unknown>> {
  const proxyBase = (process.env.EMBEDDING_PROXY_URL || "http://127.0.0.1:5221/v1").replace(/\/+$/, "");
  const url = `${proxyBase}/embeddings`;
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.EMBEDDING_API_KEY ? { authorization: `Bearer ${process.env.EMBEDDING_API_KEY}` } : {}),
      },
      body: JSON.stringify({ model: model || "Qwen3-Embedding-8B", input: `memory-xx doctor embedding upstream smoke ${randomUUID()}` }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.json().catch(() => ({})) as any;
    const actualDims = Array.isArray(body?.data?.[0]?.embedding) ? body.data[0].embedding.length : null;
    return {
      ok: response.ok && (dims ? actualDims === dims : actualDims !== null),
      status: response.status,
      url,
      latency_ms: Date.now() - started,
      dims: actualDims,
      expected_dims: dims ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      latency_ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
      remediation: "Start <windows-drive>\\ovms\\run-embedding.bat, then restart/verify memory-xx-embedding-proxy-next.service.",
    };
  }
}

function lastKnownGoodGeneration(generation: any): string | null {
  return generation?.last_known_good?.generation_id ??
    generation?.rollback_generation?.generation_id ??
    null;
}

async function inspectEmbeddingReadiness(checks: Record<string, unknown>, blockers: string[], warnings: string[]): Promise<Record<string, unknown>> {
  const wrapperHealth = (checks.services as any)?.wrapper?.body;
  const generation = wrapperHealth?.embedding_generation;
  const provider = wrapperHealth?.embedding_provider;
  if (!generation?.configured) {
    addUnique(blockers, "embedding_manifest_missing");
    return {
      ok: false,
      reason: "active embedding generation manifest missing",
      generation,
      commands: {
        prepare: "TMPDIR=/tmp npm run memory:embedding-manifest -- prepare",
        validate: "TMPDIR=/tmp npm run memory:embedding-manifest -- validate -- --generation-id=<id>",
      },
    };
  }
  const manifestModel = generation?.active_generation?.model ?? provider?.expected_model ?? provider?.model;
  const manifestDims = Number(generation?.active_generation?.dims ?? provider?.expected_dims ?? provider?.dims ?? 0) || undefined;
  const upstream = await embeddingUpstreamSmoke(manifestModel, manifestDims);
  if (!upstream.ok) addUnique(blockers, "embedding_upstream_unavailable");
  if (generation.manifest_count_stale === true) addUnique(warnings, "embedding_manifest_count_stale");
  if (generation.ok !== true && generation.manifest_count_stale !== true) addUnique(blockers, "embedding_generation_mismatch");
  if (provider?.matches_active_generation === false) addUnique(blockers, "embedding_provider_manifest_mismatch");
  if (generation.qdrant_alias?.target_matches_manifest === false) addUnique(blockers, "qdrant_alias_missing_or_wrong");
  if (generation.payload_sample?.verified === false) addUnique(blockers, "embedding_payload_generation_mismatch");
  if (generation.qdrant_collection?.status && generation.qdrant_collection.status !== "green") addUnique(blockers, "embedding_collection_not_green");
  if (generation.manifest_match?.redis_prefix === false || generation.manifest_match?.query_cache_version === false) {
    addUnique(blockers, "embedding_cache_context_mismatch");
  }
  if (generation.payload_sample?.checked === 0) addUnique(warnings, "embedding_payload_sample_empty");
  return {
    ok: (generation.ok === true || generation.manifest_count_stale === true) && provider?.matches_active_generation !== false && upstream.ok === true,
    generation,
    provider,
    upstream,
    release_playbook: {
      active_generation: generation.active_generation?.generation_id ?? null,
      candidate_generation: generation.candidate_generation?.generation_id ?? "<candidate-id>",
      rollback_generation: lastKnownGoodGeneration(generation) ?? "<last-known-good>",
      alias_target: generation.qdrant_alias?.target_collection ?? null,
      commands: {
        prepare: "TMPDIR=/tmp npm run memory:embedding-manifest -- prepare --generation-id=<new-generation-id>",
        generate: "TMPDIR=/tmp npm run memory:embedding-manifest -- generate --generation-id=<new-generation-id>",
        validate: "TMPDIR=/tmp npm run memory:embedding-manifest -- validate --generation-id=<new-generation-id>",
        activate: "TMPDIR=/tmp npm run memory:embedding-manifest -- activate --generation-id=<new-generation-id>",
        observe: "TMPDIR=/tmp npm run memory:embedding-manifest -- observe --generation-id=<new-generation-id>",
        rollback: "TMPDIR=/tmp npm run memory:embedding-manifest -- rollback",
      },
    },
    commands: {
      status: "TMPDIR=/tmp npm run memory:embedding-manifest -- status",
      validate: `TMPDIR=/tmp npm run memory:embedding-manifest -- validate -- --generation-id=${generation.active_generation?.generation_id ?? "<id>"}`,
      activate: `TMPDIR=/tmp npm run memory:embedding-manifest -- activate -- --generation-id=${generation.active_generation?.generation_id ?? "<id>"}`,
      rollback: "TMPDIR=/tmp npm run memory:embedding-manifest -- rollback",
    },
  };
}

function readJsonFile(filePath: string): any | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function latestQualityReport(): string | null {
  const root = `${config.reportDir}/quality`;
  return latestFileUnder(root, "quality-report.json") ?? (existsSync("migration_artifacts/quality-report.json") ? "migration_artifacts/quality-report.json" : null);
}

function qualitySuiteReportPath(quality: any, suite: string, fallback: string): string {
  const reportPath = quality?.suites?.[suite]?.report_path;
  if (typeof reportPath === "string" && reportPath.trim() && existsSync(reportPath)) return reportPath;
  return fallback;
}

function inspectQualityReadiness(blockers: string[], warnings: string[]): Record<string, unknown> {
  const qualityPath = latestQualityReport();
  const qualityFreshness = inspectReportFreshness({
    path: qualityPath,
    maxAgeHours: 72,
    warningName: "quality_report_missing_or_stale",
    warnings,
  });
  const quality = qualityPath ? readJsonFile(qualityPath) : null;
  if (!qualityPath || qualityFreshness.ok === false) addUnique(blockers, "quality_report_missing_or_stale");
  if (quality && quality.ok === false) addUnique(blockers, "quality_suite_failed");
  const requiredSuites = ["fixed-smoke", "random", "trace-replay", "live"];
  const missingSuites = requiredSuites.filter((suite) => !quality?.suites?.[suite]);
  if (missingSuites.length > 0) addUnique(blockers, "quality_report_not_suite_all");
  const randomPath = qualitySuiteReportPath(quality, "random", "migration_artifacts/random-recall-sample-report.json");
  const livePath = qualitySuiteReportPath(quality, "live", "migration_artifacts/live-recall-smoke-report.json");
  const tracePath = qualitySuiteReportPath(quality, "trace-replay", "migration_artifacts/trace-replay-report.json");

  const random = inspectReportFreshness({
    path: randomPath,
    maxAgeHours: 72,
    warningName: "random_recall_report_missing_or_stale",
    warnings,
  });
  const live = inspectReportFreshness({
    path: livePath,
    maxAgeHours: 72,
    warningName: "live_recall_smoke_report_missing_or_stale",
    warnings,
  });
  const trace = inspectReportFreshness({
    path: tracePath,
    maxAgeHours: 72,
    warningName: "trace_replay_report_missing_or_stale",
    warnings,
  });
  if (!random.ok || !live.ok || !trace.ok) addUnique(blockers, "quality_report_missing_or_stale");

  const randomReport = readJsonFile(randomPath);
  const liveReport = readJsonFile(livePath);
  const traceReport = readJsonFile(tracePath);
  const thresholdFailures: string[] = [];
  const suiteMetrics = (suite: string, fallback: any) =>
    quality?.suites?.[suite]?.metrics ?? quality?.suites?.[suite]?.report?.metrics ?? quality?.suites?.[suite]?.layer_report?.metrics ?? fallback?.metrics ?? {};
  const metricFailures = (suite: string, metrics: any, options?: { manualReviewOnly?: boolean }) => {
    if (!options?.manualReviewOnly) {
      if (Number(metrics.top1_recall ?? 100) < 80) thresholdFailures.push(`${suite}_top1_lt_80`);
      if (Number(metrics.top3_recall ?? 100) < 90) thresholdFailures.push(`${suite}_top3_lt_90`);
      if (Number(metrics.mrr ?? 1) < 0.70) thresholdFailures.push(`${suite}_mrr_lt_0_70`);
      if (Number(metrics.ndcg_at_5 ?? 1) < 0.75) thresholdFailures.push(`${suite}_ndcg_at_5_lt_0_75`);
    }
    if (Number(metrics.false_null_rate ?? 0) > 5) thresholdFailures.push(`${suite}_false_null_gt_5`);
    if (Number(metrics.null_accuracy ?? 100) < 100) thresholdFailures.push(`${suite}_null_accuracy_lt_100`);
    if (Number(metrics.forbidden_hit_rate ?? 0) > 0) thresholdFailures.push(`${suite}_forbidden_hit_gt_0`);
    if (Number(metrics.latency_p99_ms ?? 0) > 15000) thresholdFailures.push(`${suite}_p99_gt_15s`);
    if (Number(metrics.degrade_rate ?? 0) > 20) thresholdFailures.push(`${suite}_degrade_rate_gt_20`);
    if (Number(metrics.embedding_error_rate ?? 0) > 2) thresholdFailures.push(`${suite}_embedding_error_rate_gt_2`);
  };
  const fixedMetrics = suiteMetrics("fixed-smoke", null);
  const randomMetrics = suiteMetrics("random", randomReport);
  const liveMetrics = suiteMetrics("live", liveReport);
  const traceMetrics = suiteMetrics("trace-replay", traceReport);
  metricFailures("fixed_smoke", fixedMetrics);
  metricFailures("random", randomMetrics);
  if (liveReport && Number.parseFloat(String(liveReport.passRate ?? "100")) < 80) thresholdFailures.push("live_pass_rate_lt_80");
  metricFailures("live", liveMetrics, { manualReviewOnly: true });
  if (traceReport?.eligibleCases > 0 && Number(traceMetrics.top5_recall ?? 100) < 80) thresholdFailures.push("trace_top5_lt_80");
  if (traceReport?.eligibleCases > 0) metricFailures("trace", traceMetrics);
  const traceFeedbackCommand = "TMPDIR=/tmp npm run memory:trace-feedback -- candidates --limit=50 --days=14";
  const traceAutoTop1Command = "TMPDIR=/tmp npm run memory:trace-feedback -- auto-top1 --limit=20 --days=14 --apply";
  if (traceReport?.eligibleCases === 0) addUnique(warnings, "trace_replay_no_positive_feedback_samples");
  if (thresholdFailures.length > 0) addUnique(blockers, "quality_threshold_failed");

  return {
    ok: qualityFreshness.ok && random.ok && live.ok && trace.ok && thresholdFailures.length === 0 && quality?.ok !== false,
    quality_report: qualityFreshness,
    random_report: random,
    live_report: live,
    trace_replay_report: trace,
    metrics: {
      fixed_smoke: fixedMetrics,
      random: randomMetrics,
      live: liveMetrics,
      trace_replay: traceMetrics,
    },
    threshold_failures: thresholdFailures,
    missing_suites: missingSuites,
    command: "TMPDIR=/tmp npm run memory:quality -- --suite all",
    trace_feedback: {
      positive_samples: Number(traceReport?.eligibleCases ?? 0),
      candidate_command: traceFeedbackCommand,
      auto_top1_command: traceAutoTop1Command,
      apply_command: "TMPDIR=/tmp npm run memory:trace-feedback -- apply --trace-id=<trace_id> --memory-id=<memory_id> --feedback-type=used_in_context --reason=\"manual quality replay label\" --apply",
      note: "Trace replay becomes a hard quality gate after real positive feedback labels exist.",
    },
  };
}

function inspectOpsReadiness(
  checks: Record<string, unknown>,
  blockers: string[],
  warnings: string[],
  mode: MemoryRuntimeProfile
): Record<string, unknown> {
  const services = checks.services as any;
  const wrapperHealth = services?.wrapper?.body as any;
  const qdrant = checks.qdrant as any;
  const plan = buildRuntimeProfilePlan(mode);
  const statuses = RUNTIME_COMPONENTS.map((component) => {
    let ok = true;
    let detail = "not probed";
    if (component.name === "wrapper") {
      ok = services?.wrapper?.ok === true;
      detail = services?.wrapper?.status ? `HTTP ${services.wrapper.status}` : services?.wrapper?.error ?? "unavailable";
    } else if (component.name === "embedding_proxy") {
      ok = services?.embedding_proxy?.ok === true;
      detail = services?.embedding_proxy?.status ? `HTTP ${services.embedding_proxy.status}` : services?.embedding_proxy?.error ?? "unavailable";
    } else if (component.name === "ovms_upstream") {
      ok = (checks.embedding_ready as any)?.upstream?.ok === true;
      detail = ok
        ? `embedding smoke dims=${(checks.embedding_ready as any)?.upstream?.dims}`
        : String((checks.embedding_ready as any)?.upstream?.error ?? "embedding upstream unavailable");
    } else if (component.name === "fastpath") {
      ok = services?.fastpath?.ok === true;
      detail = services?.fastpath?.status ? `HTTP ${services.fastpath.status}` : services?.fastpath?.error ?? "unavailable";
    } else if (component.name === "lexical") {
      ok = services?.lexical?.ok === true;
      detail = services?.lexical?.status ? `HTTP ${services.lexical.status}` : services?.lexical?.error ?? "unavailable";
    } else if (component.name === "reranker") {
      ok = services?.reranker?.ok === true;
      detail = services?.reranker?.status ? `HTTP ${services.reranker.status}` : services?.reranker?.error ?? "unavailable";
    } else if (component.name === "postgres") {
      ok = Boolean((checks.db as any)?.counts);
      detail = ok ? "DB inspection OK" : "DB inspection failed";
    } else if (component.name === "redis") {
      ok = wrapperHealth?.redis?.available === true;
      detail = ok ? "Redis available via wrapper health" : String(wrapperHealth?.redis?.last_error ?? wrapperHealth?.redis?.reason ?? "redis unavailable");
    } else if (component.name === "qdrant") {
      ok = !qdrant?.error && (!qdrant?.status || qdrant.status === "green");
      detail = qdrant?.error ?? `Qdrant ${qdrant?.status ?? "unknown"}`;
    } else if (component.name === "projector") {
      ok = component.service ? userServiceActive(component.service) : false;
      detail = ok ? "systemd active" : "systemd inactive";
    } else if (component.service && services?.[component.name]) {
      const service = services?.[component.name];
      ok = service?.ok === true;
      detail = service?.status ? `HTTP ${service.status}` : service?.error ?? "unavailable";
    } else if (component.service) {
      ok = component.service ? userServiceActive(component.service) : false;
      detail = ok ? "systemd active" : "systemd inactive";
    } else if (component.kind === "gate") {
      ok = true;
      detail = component.command ?? "one-shot gate";
    }
    const profileState = classifyDoctorComponentProfileState(component.name, mode);
    const required = profileState.blocks_profile;
    const expected = componentExpectedInProfile(component, mode);
    return {
      name: component.name,
      label: component.label,
      required,
      expected,
      enabled: profileState.enabled,
      role: profileState.role,
      ok,
      detail,
      service: component.service,
      command: component.command,
      degraded_behavior: component.degraded_behavior,
    };
  });
  const degradedComponents = statuses.filter((component) => !component.ok).map((component) => component.name);
  const blockedComponents = statuses
    .filter((component) => component.required && !component.ok)
    .map((component) => component.name);
  for (const component of blockedComponents) addUnique(blockers, `ops_required_${component}_degraded`);
  if (degradedComponents.length > 0) addUnique(warnings, "ops_component_degraded");
  const embedding = (checks.embedding_ready as any)?.generation;
  return {
    ok: blockedComponents.length === 0,
    current_mode: mode,
    required_components: statuses.filter((component) => component.required),
    expected_components: statuses.filter((component) => component.expected),
    optional_components: statuses.filter((component) => !component.required && !component.expected),
    degraded_components: degradedComponents,
    blocked_components: blockedComponents,
    active_generation: embedding?.active_generation?.generation_id ?? null,
    alias_target: embedding?.qdrant_alias?.target_collection ?? null,
    rollback_command: "TMPDIR=/tmp npm run memory:embedding-manifest -- rollback && systemctl --user restart memory-xx-wrapper.service memory-xx-qdrant-projector-worker.service",
    start_plan: {
      core: "TMPDIR=/tmp npm run memory:up -- --mode core",
      enhanced: "TMPDIR=/tmp npm run memory:up -- --mode enhanced",
      full: "TMPDIR=/tmp npm run memory:mode -- plan --mode full",
    },
    profile_plan: {
      required: plan.required_components.map((component) => component.name),
      expected: plan.expected_components.map((component) => component.name),
      full_gates: plan.full_gates.map((component) => component.command),
    },
    degrade_policy: (checks as any).dependency_summary ?? null,
  };
}

async function inspectGraphBenchmark(blockers: string[], warnings: string[]): Promise<Record<string, unknown>> {
  try {
    const output = execFileSync("npm", ["run", "test:graph-recall"], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: "/tmp" },
      timeout: 180000,
    });
    const match = output.match(/@@LAYER_REPORT@@(.+)@@END_REPORT@@/s);
    const layerReport = match ? JSON.parse(match[1]!) as any : null;
    if (!layerReport?.ok) addUnique(blockers, "graph_benchmark_failed");
    const caseCheck = Array.isArray(layerReport?.checks)
      ? layerReport.checks.find((check: any) => check.name === "graph:case-metrics")
      : null;
    return { ok: layerReport?.ok === true, layer_report: layerReport, case_metrics: caseCheck?.detail ? JSON.parse(caseCheck.detail) : null };
  } catch (error) {
    addUnique(blockers, "graph_benchmark_failed");
    return { ok: false, error: error instanceof Error ? String((error as Error & { stdout?: unknown }).stdout ?? error.message).slice(-3000) : String(error) };
  }
}

async function inspectStrictReadiness(blockers: string[], warnings: string[]): Promise<Record<string, unknown>> {
  const legacyChecker = createPermissionChecker({
    MEMORY_XX_API_TOKEN: "legacy-token",
    MEMORY_XX_SCOPE_POLICY_MODE: "strict",
  });
  let legacyStrictDenial = false;
  try {
    const decision = await legacyChecker.authorizeScope({
      token: "legacy-token",
      permission: "memory:write",
      scopeType: "project",
      scopeId: "strict-doctor",
    });
    legacyStrictDenial = decision.allowed === false && decision.reason === "legacy_token_disallowed_in_strict_scope";
  } finally {
    await legacyChecker.close();
  }

  let strictHttpTests = { ok: false, output: "" };
  try {
    const output = execFileSync(
      "node",
      ["--import", "tsx", "--test", "tests/permissions.test.ts", "tests/strict-scope-http.test.ts"],
      {
        encoding: "utf8",
        env: { ...process.env, MEMORY_XX_SCOPE_POLICY_MODE: "strict", TMPDIR: "/tmp" },
        timeout: 120000,
      }
    );
    strictHttpTests = { ok: true, output: output.slice(-2000) };
  } catch (error) {
    strictHttpTests = {
      ok: false,
      output: error instanceof Error ? String((error as Error & { stdout?: unknown; stderr?: unknown }).stdout ?? error.message).slice(-2000) : String(error),
    };
  }

  if (!legacyStrictDenial) addUnique(blockers, "strict_legacy_token_not_denied");
  if (!strictHttpTests.ok) addUnique(blockers, "strict_http_tests_failed");

  return {
    mode_default: process.env.MEMORY_XX_SCOPE_POLICY_MODE === "single_user" ? "single_user" : "strict",
    strict_enabled_now: process.env.MEMORY_XX_SCOPE_POLICY_MODE !== "single_user",
    legacy_strict_denial: legacyStrictDenial,
    strict_http_tests: strictHttpTests,
    note: "strict-ready expects strict mode by default; set MEMORY_XX_SCOPE_POLICY_MODE=single_user only as rollback.",
  };
}

async function inspectStrictDefault(blockers: string[]): Promise<Record<string, unknown>> {
  const defaultChecker = createPermissionChecker({
    MEMORY_XX_API_TOKEN: "legacy-token",
    MEMORY_XX_ADMIN_TOKEN: "admin-token",
  });
  try {
    const legacy = await defaultChecker.authorizeScope({
      token: "legacy-token",
      permission: "memory:write",
      scopeType: "project",
      scopeId: "strict-default-doctor",
    });
    const admin = await defaultChecker.authorizeScope({
      token: "admin-token",
      permission: "memory:write",
      scopeType: "project",
      scopeId: "strict-default-doctor",
    });
    const ok = legacy.allowed === false &&
      legacy.reason === "legacy_token_disallowed_in_strict_scope" &&
      admin.allowed === true &&
      admin.reason === "admin_bypass";
    if (!ok) addUnique(blockers, "strict_default_not_enforced");
    return {
      ok,
      default_mode: legacy.scopePolicyMode,
      legacy_denied: legacy.allowed === false,
      legacy_reason: legacy.reason,
      admin_bypass: admin.allowed === true && admin.reason === "admin_bypass",
      rollback: "Set MEMORY_XX_SCOPE_POLICY_MODE=single_user to restore legacy compatibility.",
    };
  } finally {
    await defaultChecker.close();
  }
}

async function inspectGraphReadiness(blockers: string[], warnings: string[]): Promise<Record<string, unknown>> {
  try {
    const response = await httpPost(apiUrl("/api/memory/xx/recall/query"), {
      query: "0020 migration strict scope trusted agent grants",
      scopeType: "project",
      scopeId: "local-default",
      query_type_hint: "project_context",
      limit: 8,
      explain: true,
      debug: { enabled: true }
    }, { token: config.wrapperToken, timeout: 30000 });
    const body = response.body as any;
    const results = Array.isArray(body?.results) ? body.results : [];
    const graphResults = results.filter((item: any) =>
      Array.isArray(item?.source_retrievers) && item.source_retrievers.includes("graph")
    );
    const forbiddenScopeHits = results.filter((item: any) => item?.scope?.id && item.scope.id !== "local-default").length;
    const graphHits = Number(body?.audit?.graph_hits ?? 0);
    if (response.status !== 200) addUnique(blockers, "graph_recall_probe_failed");
    if (graphHits <= 0) addUnique(blockers, "graph_recall_no_graph_hits");
    if (graphResults.length === 0) addUnique(warnings, "graph_recall_evidence_not_in_top_results");
    const graphResultsWithPathEvidence = graphResults.filter((item: any) =>
      (Array.isArray(item.graph_entity_evidence) && item.graph_entity_evidence.length > 0) ||
      (Array.isArray(item.graph_relation_evidence) && item.graph_relation_evidence.length > 0) ||
      (Array.isArray(item.graph_source_evidence) && item.graph_source_evidence.length > 0) ||
      (Array.isArray(item.graph_path_evidence) && item.graph_path_evidence.length > 0)
    ).length;
    if (graphResults.length > 0 && graphResultsWithPathEvidence === 0) addUnique(warnings, "graph_recall_path_evidence_missing");
    if (forbiddenScopeHits > 0) addUnique(blockers, "graph_recall_forbidden_scope_hit");
    return {
      status: response.status,
      graph_hits: graphHits,
      graph_results: graphResults.length,
      graph_results_with_path_evidence: graphResultsWithPathEvidence,
      evidence_source_coverage: results.length > 0 ? graphResults.length / results.length : 0,
      forbidden_scope_hits: forbiddenScopeHits,
    };
  } catch (error) {
    addUnique(blockers, "graph_recall_probe_failed");
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function sendDoctorAlertIfConfigured(report: {
  readonly target: string;
  readonly status: Status;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}): Promise<Record<string, unknown>> {
  const webhookUrl = process.env.MEMORY_XX_ALERT_WEBHOOK_URL?.trim() || process.env.CAPACITY_ALERT_WEBHOOK_URL?.trim() || "";
  if (!webhookUrl || report.status === "ready") return { notification_status: webhookUrl ? "suppressed" : "not_configured" };
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msg_type: "interactive",
        card: {
          header: {
            title: { tag: "plain_text", content: `memory-xx Doctor ${report.status}` },
            template: report.status === "blocked" ? "red" : "orange",
          },
          elements: [
            {
              tag: "div",
              text: {
                tag: "lark_md",
                content: [
                  `**target**: ${report.target}`,
                  `**status**: ${report.status}`,
                  `**blockers**: ${report.blockers.join(", ") || "none"}`,
                  `**warnings**: ${report.warnings.slice(0, 8).join(", ") || "none"}`,
                ].join("\n"),
              },
            },
          ],
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok
      ? { notification_status: "sent" }
      : { notification_status: "failed", status: response.status, body: (await response.text()).slice(0, 200) };
  } catch (error) {
    return { notification_status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  const target = parseTarget();
  const mode = parseDoctorMode(target);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const checks: Record<string, unknown> = {};

  const configValidation = validateRuntimeConfig(process.env);
  checks.config_validation = configValidation;
  for (const blocker of configValidation.blockers) addUnique(blockers, `config_${blocker}`);
  for (const warning of configValidation.warnings) addUnique(warnings, `config_${warning}`);

  checks.git = {
    root: execFileSync("git", ["-C", "<project-root>", "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
    prefix: execFileSync("git", ["-C", "<project-root>", "rev-parse", "--show-prefix"], { encoding: "utf8" }).trim()
  };
  checks.db = await inspectDb();
  const db = checks.db as any;
  if (!db.has_0020) addUnique(blockers, "0020_not_applied");
  if (!db.trusted_agent_scope_grants_table) addUnique(blockers, "trusted_agent_scope_grants_missing");
  if ((db.missing_migrations ?? []).length > 0) addUnique(blockers, "live_migration_ledger_missing_files");
  checks.database_maintenance = await inspectDatabaseMaintenance(blockers, warnings);
  checks.event_lifecycle = await inspectEventLifecycle(blockers, warnings);
  checks.docs_env_script_drift = scanDriftFiles(blockers, warnings);
  checks.migration_naming = inspectMigrationNaming(warnings);

  checks.runtime_profile = {
    current_mode: mode,
    plan: buildRuntimeProfilePlan(mode),
  };
  checks.services = await inspectServices(blockers, warnings, mode);
  checks.runtime_profile_consistency = inspectRuntimeProfileConsistency(checks, mode, blockers);
  checks.multi_instance_boundary = inspectMultiInstanceBoundary(blockers, warnings);
  checks.embedding_ready = await inspectEmbeddingReadiness(checks, blockers, warnings);
  const embeddingProxyHealth = (checks.services as any)?.embedding_proxy?.body;
  if (Number(embeddingProxyHealth?.recent_429_15m ?? 0) > 0) {
    addUnique(blockers, "embedding_proxy_recent_429");
  }
  checks.qdrant = await inspectQdrant();
  const qdrantInfo = checks.qdrant as { pointsCount?: number; indexedVectorsCount?: number; error?: string };
  if (!qdrantInfo.error && Number(qdrantInfo.pointsCount ?? 0) > 500 && Number(qdrantInfo.indexedVectorsCount ?? 0) === 0) {
    addUnique(warnings, "qdrant_hnsw_index_not_built");
  }
  const qdrantProjection = readCommandJson("npm", ["run", "memory:qdrant-reconcile", "--", "--max-drift=100", "--max-delete=20", "--max-upsert=100"]);
  checks.qdrant_projection = qdrantProjection.body ?? { error: qdrantProjection.error };
  const projectionIssues = Array.isArray((qdrantProjection.body as any)?.issues)
    ? (qdrantProjection.body as any).issues as any[]
    : [];
  if (!qdrantProjection.body) {
    addUnique(blockers, "qdrant_projection_reconcile_failed");
  } else if (projectionIssues.length > 0) {
    const blockedIssue = projectionIssues.find((issue) => issue?.repairability === "blocked" || issue?.severity === "critical");
    if (blockedIssue) addUnique(blockers, "qdrant_projection_drift_blocked");
    else addUnique(warnings, "qdrant_projection_drift_auto_safe");
  }
  if (mode === "full" || target === "graph-ready") {
    checks.routing = await inspectRouting(blockers, warnings);
  } else {
    checks.routing = {
      skipped: true,
      reason: `routing fastpath/reranker probe is only required in full mode; current mode is ${mode}`,
    };
  }
  const wrapperStartedAt = userServiceStartedAt("memory-xx-wrapper.service");
  const fastpathStartedAt = userServiceStartedAt("memory-xx-fastpath.service");
  const embeddingProxyStartedAt = userServiceStartedAt("memory-xx-embedding-proxy-next.service");
  checks.logs = {
    since: {
      wrapper_started_at: wrapperStartedAt ? new Date(wrapperStartedAt).toISOString() : null,
      fastpath_started_at: fastpathStartedAt ? new Date(fastpathStartedAt).toISOString() : null,
      embedding_proxy_started_at: embeddingProxyStartedAt ? new Date(embeddingProxyStartedAt).toISOString() : null
    },
    wrapper_embedding_429_recent: recentLogCount("wrapper.error.log", [/Embedding API error: 429/, /embedding_api_429/], undefined, wrapperStartedAt),
    fastpath_embedding_429_recent: recentLogCount("<project-root>-fastpath/fastpath.error.log", [/embedding_status_429/], undefined, fastpathStartedAt),
    proxy_embedding_429_recent: Number(embeddingProxyHealth?.recent_429_15m ?? 0)
  };
  const logs = checks.logs as any;
  if (logs.wrapper_embedding_429_recent > 0 || logs.fastpath_embedding_429_recent > 0) {
    addUnique(blockers, "embedding_429_recent");
  }
  if (logs.proxy_embedding_429_recent > 0) {
    addUnique(blockers, "embedding_proxy_recent_429");
  }
  checks.strict_scope = {
    mode: process.env.MEMORY_XX_SCOPE_POLICY_MODE === "single_user" ? "single_user" : "strict",
    grants_table_ready: db.trusted_agent_scope_grants_table,
    enabled: process.env.MEMORY_XX_SCOPE_POLICY_MODE !== "single_user"
  };
  checks.token_separation = inspectTokenSeparation(process.env);
  if ((checks.token_separation as { ok?: boolean }).ok === false) {
    addUnique(blockers, "api_admin_token_overlap");
  }
  checks.strict_default = await inspectStrictDefault(blockers);
  const activeApproved = Number(db.counts?.pg_projected ?? 0);
  checks.governance_debt = {
    missing_metadata_source: Number(db.counts?.missing_metadata_source ?? 0),
    missing_metadata_source_ratio: activeApproved > 0 ? Number(db.counts?.missing_metadata_source ?? 0) / activeApproved : null,
    graph_orphans: {
      missing_episode: Number(db.counts?.missing_episode ?? 0),
      missing_entity_link: Number(db.counts?.missing_entity_link ?? 0),
      missing_relation: Number(db.counts?.missing_relation ?? 0),
    },
    mode: "report_only",
    remediation: "Use conservative backfill only for clear metadata.source, episodes, and entity links; keep relation debt review-only.",
    command: "TMPDIR=/tmp npm run memory:debt-plan -- --limit=100",
    conservative_apply_command: "TMPDIR=/tmp npm run memory:debt-plan -- --apply-conservative --limit=100",
  };
  if (Number(db.counts?.missing_metadata_source ?? 0) > 0) addUnique(warnings, "governance_missing_metadata_source");
  if (Number(db.counts?.missing_episode ?? 0) > 0 || Number(db.counts?.missing_relation ?? 0) > 0) {
    addUnique(warnings, "graph_structuring_debt");
  }
  if (Number(db.counts?.test_pollution_high_confidence ?? 0) > 0) addUnique(warnings, "test_pollution_high_confidence");
  const qualityGateCoverage = activeApproved > 0 ? Number(db.counts?.quality_gate_metadata_count ?? 0) / activeApproved : null;
  checks.governance_quality_signals = {
    test_pollution_high_confidence: Number(db.counts?.test_pollution_high_confidence ?? 0),
    quality_gate_metadata_count: Number(db.counts?.quality_gate_metadata_count ?? 0),
    quality_gate_metadata_coverage: qualityGateCoverage,
    note: "Direct /write records use lightweight hygiene metadata; smart-write/extract records should carry quality_gate metadata.",
  };
  if (qualityGateCoverage !== null && qualityGateCoverage < 0.10) addUnique(warnings, "quality_gate_metadata_coverage_low");
  checks.query_embedding_cache = {
    configured: Boolean(config.redisUrl),
    prefix: process.env.MEMORY_XX_REDIS_PREFIX?.trim() || "memory-xx",
    wrapper_health_snapshot: (checks.services as any)?.wrapper?.body?.query_embedding_cache ?? null,
    summary: summarizeQueryEmbeddingCache((checks.services as any)?.wrapper?.body?.query_embedding_cache, warnings),
  };
  if (!process.env.MEMORY_XX_EMBEDDING_GENERATION_ID?.trim() || !process.env.MEMORY_XX_QUERY_EMBEDDING_CACHE_VERSION?.trim()) {
    addUnique(warnings, "query_cache_generation_context_missing");
  }
  const reportRoot = config.reportDir;
  checks.embedding_calibration_report = inspectReportFreshness({
    path: latestFileUnder(`${reportRoot}/embedding-calibration`, "embedding-calibration.json"),
    maxAgeHours: 72,
    warningName: "embedding_calibration_report_missing_or_stale",
    warnings,
  });
  checks.random_recall_report = inspectReportFreshness({
    path: "migration_artifacts/random-recall-sample-report.json",
    maxAgeHours: 72,
    warningName: "random_recall_report_missing_or_stale",
    warnings,
  });
  checks.live_recall_smoke_report = inspectReportFreshness({
    path: "migration_artifacts/live-recall-smoke-report.json",
    maxAgeHours: 72,
    warningName: "live_recall_smoke_report_missing_or_stale",
    warnings,
  });
  checks.dependency_summary = {
    runtime_profile: mode,
    postgres: { role: "必需组件", degraded_behavior: "服务不可用" },
    wrapper: { role: "必需组件", degraded_behavior: "记忆 HTTP API（接口）不可用" },
    qdrant: { role: "主向量投影", degraded_behavior: "可用时回退到 pgvector/关键词召回" },
    redis: { role: "缓存和协同", degraded_behavior: "绕过缓存，吞吐量下降" },
    fastpath: { role: "主召回路径", degraded_behavior: "回退到 wrapper/Node 召回" },
    lexical: { role: "关键词召回器", degraded_behavior: "不可用时只使用向量/图谱召回" },
    reranker: { role: "质量增强", degraded_behavior: "回退到本地重排序" },
    gateway: { role: "OpenClaw 集成", degraded_behavior: "记忆服务仍可用，但集成门禁失败" },
    embedding_proxy: { role: "查询/写入向量", degraded_behavior: "回退到旧结果/缓存，或向量能力降级" },
    ovms_upstream: { role: "Windows GPU 上的本地 Qwen3 embedding 模型", degraded_behavior: "代理在线但无法生成新向量；需要启动 memory-xx-embedding-upstream.service" },
    reranker_upstream: { role: "Windows GPU 上的本地 Qwen3 reranker 模型", degraded_behavior: "重排序适配器在线但无法调用模型；需要启动 memory-xx-reranker-upstream.service" },
  };
  if (target === "quality-ready" || target === "release-ready") {
    checks.quality_ready = inspectQualityReadiness(blockers, warnings);
  }
  if (target === "strict-ready" || target === "release-ready") {
    checks.strict_ready = await inspectStrictReadiness(blockers, warnings);
  }
  if (target === "graph-ready" || target === "release-ready") {
    checks.graph_ready = await inspectGraphReadiness(blockers, warnings);
    checks.graph_benchmark = await inspectGraphBenchmark(blockers, warnings);
  }
  if (target === "embedding-ready" || target === "release-ready") {
    checks.embedding_ready_target = checks.embedding_ready;
  }
  if (target === "ops-ready" || target === "release-ready") {
    checks.ops_ready = inspectOpsReadiness(checks, blockers, warnings, mode);
  }

  const nextActions = remediationPlan(blockers);
  const score = Math.max(0, 100 - blockers.length * 15 - warnings.length * 5);
  const status: Status = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "degraded" : "ready";
  const report: DoctorReport = {
    ok: blockers.length === 0,
    score,
    status,
    generated_at: new Date().toISOString(),
    target,
    mode,
    env: redactedConfig(),
    blockers,
    warnings,
    next_actions: nextActions,
    checks
  };
  checks.alert = await sendDoctorAlertIfConfigured(report);

  if (process.argv.includes("--plan")) {
    const planPayload: Record<string, unknown> = {
      ok: report.ok,
      status,
      target,
      mode,
      blockers,
      warnings,
      next_actions: nextActions,
      active_generation: (checks.embedding_ready as any)?.generation?.active_generation?.generation_id ?? null,
      rollback_generation: (checks.embedding_ready as any)?.release_playbook?.rollback_generation ?? null,
      degraded_components: (checks.ops_ready as any)?.degraded_components ?? [],
      runtime_profile_consistency: checks.runtime_profile_consistency,
      event_lifecycle: checks.event_lifecycle,
      qdrant_projection: checks.qdrant_projection,
      multi_instance_boundary: checks.multi_instance_boundary,
      latest_report_paths: {
        quality: latestQualityReport(),
        random: "migration_artifacts/random-recall-sample-report.json",
        live: "migration_artifacts/live-recall-smoke-report.json",
        trace_replay: "migration_artifacts/trace-replay-report.json",
      },
    };
    if (target === "ops-ready") {
      planPayload.ops_ready = checks.ops_ready;
    }
    if (target === "embedding-ready") {
      planPayload.embedding_ready = checks.embedding_ready_target ?? checks.embedding_ready;
    }
    if (target === "quality-ready") {
      planPayload.quality_ready = checks.quality_ready;
    }
    if (target === "graph-ready") {
      planPayload.graph_ready = checks.graph_ready;
      planPayload.graph_benchmark = checks.graph_benchmark;
    }
    if (target === "release-ready") {
      planPayload.release_checks = {
        ops_ready: checks.ops_ready,
        strict_ready: checks.strict_ready,
        embedding_ready: checks.embedding_ready_target,
        quality_ready: checks.quality_ready,
        graph_ready: checks.graph_ready,
        graph_benchmark: checks.graph_benchmark,
      };
    }
    process.stdout.write(JSON.stringify(planPayload, null, 2) + "\n");
  } else {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  }
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

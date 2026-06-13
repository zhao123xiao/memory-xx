import {
  CacheInvalidationRequestRepository,
  PostgresWriteDatabase,
  loadMemoryXXPostgresConfig,
  withWriteTransaction
} from "../app/db";
import { CacheInvalidationWorker, RecallRuntimeCacheInvalidator, RedisRecallCache, loadMemoryRedisConfig } from "../app/cache";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { activatePendingRuntimeControlsSync, readRuntimeControlNumberSync } from "../app/runtime-control-settings";

activatePendingRuntimeControlsSync([
  "worker.cache_invalidation.batch_size",
  "worker.cache_invalidation.max_attempts",
  "worker.cache_invalidation.lease_ttl_seconds",
  "worker.cache_invalidation.retry_base_seconds",
  "worker.cache_invalidation.retry_max_seconds",
]);

function hasArg(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = argValue(`--${name}`) ?? process.env[`MEMORY_XX_CACHE_INVALIDATION_${name.toUpperCase()}`];
  const parsed = Number.parseInt(raw ?? "", 10);
  const envValue = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  const runtimeKey = `worker.cache_invalidation.${name}`;
  const runtimeValue = readRuntimeControlNumberSync(runtimeKey, envValue);
  return Number.isFinite(runtimeValue) && runtimeValue > 0 ? runtimeValue : envValue;
}

function retryDelaySeconds(attempts: number): number {
  const base = readPositiveInt("retry_base_seconds", 30);
  const max = readPositiveInt("retry_max_seconds", 600);
  return Math.min(max, base * Math.max(1, Math.min(attempts, 6)));
}

function statusFilePath(): string {
  const runtimeDir = process.env.MEMORY_XX_RUNTIME_DIR?.trim() || join(process.cwd(), ".runtime");
  return process.env.MEMORY_XX_CACHE_INVALIDATION_STATUS_FILE?.trim() ||
    join(runtimeDir, "cache-invalidation-worker.status.json");
}

function workerId(): string {
  return process.env.MEMORY_XX_WORKER_ID?.trim() || `cache-invalidation-${process.pid}`;
}

async function writeStatus(payload: Record<string, unknown>): Promise<void> {
  const file = statusFilePath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const db = new PostgresWriteDatabase({ config: loadMemoryXXPostgresConfig() });
  const redisConfig = loadMemoryRedisConfig();
  const cache = new RedisRecallCache({ config: redisConfig });
  await cache.connect();
  const repo = new CacheInvalidationRequestRepository();
  const workerIdValue = workerId();
  const dryRun = hasArg("--dry-run");
  const limit = readPositiveInt("batch_size", Number.parseInt(argValue("--limit") ?? "50", 10) || 50);
  const maxAttempts = readPositiveInt("max_attempts", 10);
  const leaseTtlSeconds = readPositiveInt("lease_ttl_seconds", 120);
  try {
    if (dryRun) {
      const rows = await withWriteTransaction(db, (tx) => repo.listClaimable(tx, {
        limit: Number.parseInt(argValue("--limit") ?? "20", 10) || 20,
        maxAttempts
      }));
      const summary = {
        worker_id: workerIdValue,
        dry_run: true,
        claimable: rows.length,
        rows: rows.map((row) => ({
          id: row.id,
          scope_type: row.scopeType,
          scope_id: row.scopeId,
          reason: row.reason,
          status: row.status,
          attempts: row.attempts,
          next_attempt_at: row.nextAttemptAt,
          created_at: row.createdAt
        })),
        duration_ms: Date.now() - startedAt,
        at: new Date().toISOString()
      };
      await writeStatus(summary);
      console.log(JSON.stringify(summary));
      return;
    }

    const invalidator = new RecallRuntimeCacheInvalidator(cache, {
      database: db,
      strict: true,
      persistFailures: false
    });
    const worker = new CacheInvalidationWorker({
      database: db,
      invalidator,
      repository: repo,
      workerId: workerIdValue,
      batchSize: limit,
      leaseTtlSeconds,
      maxAttempts,
      retryDelaySeconds
    });
    const result = await worker.processOnce();
    const summary = {
      worker_id: workerIdValue,
      dry_run: false,
      claimed: result.claimed,
      completed: result.completed,
      failed: result.failed,
      duration_ms: Date.now() - startedAt,
      at: new Date().toISOString()
    };
    await writeStatus(summary);
    console.log(JSON.stringify(summary));
  } finally {
    await cache.close();
    await db.close();
  }
}

main().catch((error) => {
  void writeStatus({
    worker_id: workerId(),
    ok: false,
    phase: "startup_failed",
    error: error instanceof Error ? error.message : String(error),
    at: new Date().toISOString()
  }).catch(() => undefined);
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

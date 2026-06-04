import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import {
  CacheInvalidationRequestRepository,
  PostgresWriteDatabase,
  withWriteTransaction,
} from "../app/db";
import { ScopeType } from "../app/shared";

const execFileAsync = promisify(execFile);

export interface CacheInvalidationSmokeEnv {
  readonly [key: string]: string | undefined;
}

export interface CacheInvalidationWorkerStatus {
  readonly worker_id?: string;
  readonly dry_run?: boolean;
  readonly claimed?: number;
  readonly completed?: number;
  readonly failed?: number;
  readonly errors?: readonly unknown[];
  readonly at?: string;
  readonly ok?: boolean;
  readonly phase?: string;
  readonly error?: string;
}

export interface CacheInvalidationRequestStatus {
  readonly status: string;
  readonly attempts: number;
  readonly completed_at: string | null;
}

export interface CacheInvalidationSmokeReport {
  readonly ok: boolean;
  readonly mode: "live";
  readonly runtime_dir: string | null;
  readonly request_id: string | null;
  readonly worker_status: CacheInvalidationWorkerStatus | null;
  readonly request_status: CacheInvalidationRequestStatus | null;
  readonly blockers: readonly string[];
}

interface BuildCacheInvalidationSmokeOptions {
  readonly env?: CacheInvalidationSmokeEnv;
  readonly runtimeDir?: string;
  readonly scopeId?: string;
  readonly seedRequest?: (scopeId: string, env: CacheInvalidationSmokeEnv) => Promise<string>;
  readonly runWorker?: (runtimeDir: string, env: CacheInvalidationSmokeEnv) => Promise<void>;
  readonly readRequestStatus?: (requestId: string, env: CacheInvalidationSmokeEnv) => Promise<CacheInvalidationRequestStatus | null>;
  readonly keepRuntimeDir?: boolean;
}

export async function buildCacheInvalidationSmokeReport(
  options: BuildCacheInvalidationSmokeOptions = {}
): Promise<CacheInvalidationSmokeReport> {
  const env = options.env ?? process.env;
  const blockers = requiredEnvBlockers(env);
  if (blockers.length > 0) {
    return {
      ok: false,
      mode: "live",
      runtime_dir: options.runtimeDir ?? null,
      request_id: null,
      worker_status: null,
      request_status: null,
      blockers,
    };
  }

  const runtimeDir = options.runtimeDir ?? await mkdtemp(path.join(os.tmpdir(), "memory-xx-cache-invalidation-smoke-"));
  const ownsRuntimeDir = !options.runtimeDir;
  let requestId: string | null = null;
  try {
    await mkdir(runtimeDir, { recursive: true });
    const scopeId = options.scopeId ?? `cache-invalidation-smoke-${Date.now()}`;
    requestId = await (options.seedRequest ?? seedCacheInvalidationRequest)(scopeId, env);
    await (options.runWorker ?? runWorkerOnce)(runtimeDir, env);
    const workerStatus = await readWorkerStatus(runtimeDir);
    const requestStatus = await (options.readRequestStatus ?? readCacheInvalidationRequestStatus)(requestId, env);
    const outputBlockers = [
      ...(workerStatus ? [] : ["worker_status_missing"]),
      ...(workerStatus && Number(workerStatus.completed ?? 0) > 0 ? [] : ["worker_completed_zero"]),
      ...(workerStatus && Number(workerStatus.failed ?? 0) === 0 ? [] : ["worker_failed_nonzero"]),
      ...(requestStatus?.status === "completed" ? [] : [`request_not_completed:${requestStatus?.status ?? "missing"}`]),
      ...(requestStatus?.completed_at ? [] : ["request_missing_completed_at"]),
    ];

    return {
      ok: outputBlockers.length === 0,
      mode: "live",
      runtime_dir: runtimeDir,
      request_id: requestId,
      worker_status: workerStatus,
      request_status: requestStatus,
      blockers: outputBlockers,
    };
  } finally {
    if (ownsRuntimeDir && !options.keepRuntimeDir) {
      await rm(runtimeDir, { recursive: true, force: true });
    }
  }
}

function requiredEnvBlockers(env: CacheInvalidationSmokeEnv): readonly string[] {
  return [
    ["MEMORY_XX_DATABASE_URL", env.MEMORY_XX_DATABASE_URL],
    ["MEMORY_XX_REDIS_URL", env.MEMORY_XX_REDIS_URL],
  ]
    .filter(([, value]) => !value?.trim())
    .map(([name]) => `missing_env:${name}`);
}

async function seedCacheInvalidationRequest(scopeId: string, env: CacheInvalidationSmokeEnv): Promise<string> {
  const db = new PostgresWriteDatabase({ config: loadMemoryXXPostgresConfig(env as NodeJS.ProcessEnv) });
  try {
    const repo = new CacheInvalidationRequestRepository();
    const row = await withWriteTransaction(db, (tx) => repo.enqueue(tx, {
      scopeType: ScopeType.Project,
      scopeId,
      reason: "cache_invalidation_smoke",
    }));
    return row.id;
  } finally {
    await db.close();
  }
}

async function runWorkerOnce(runtimeDir: string, env: CacheInvalidationSmokeEnv): Promise<void> {
  await execFileAsync(process.execPath, ["--import", "tsx", "scripts/run-cache-invalidation-worker.ts", "--limit=1"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
      TMPDIR: "/tmp",
      MEMORY_XX_RUNTIME_DIR: runtimeDir,
      MEMORY_XX_CACHE_INVALIDATION_STATUS_FILE: path.join(runtimeDir, "cache-invalidation-worker.status.json"),
      MEMORY_XX_CACHE_INVALIDATION_BATCH_SIZE: "1",
      MEMORY_XX_CACHE_INVALIDATION_MAX_ATTEMPTS: "3",
    },
    timeout: 120_000,
  });
}

async function readWorkerStatus(runtimeDir: string): Promise<CacheInvalidationWorkerStatus | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(runtimeDir, "cache-invalidation-worker.status.json"), "utf8")) as CacheInvalidationWorkerStatus;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function readCacheInvalidationRequestStatus(
  requestId: string,
  env: CacheInvalidationSmokeEnv
): Promise<CacheInvalidationRequestStatus | null> {
  const pgConfig = loadMemoryXXPostgresConfig(env as NodeJS.ProcessEnv);
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  try {
    const result = await pool.query(
      `SELECT status, attempts::int AS attempts, completed_at FROM ${quoteIdent(pgConfig.schema)}.cache_invalidation_requests WHERE id = $1`,
      [requestId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      status: String(row.status),
      attempts: Number(row.attempts ?? 0),
      completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    };
  } finally {
    await pool.end();
  }
}

function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error(`unsafe_identifier:${value}`);
  return `"${value}"`;
}

async function main(): Promise<void> {
  const report = await buildCacheInvalidationSmokeReport({ keepRuntimeDir: process.argv.includes("--keep-runtime-dir") });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

const entrypoint = process.argv[1] ?? "";
if (entrypoint.endsWith("scripts/cache-invalidation-smoke.ts") || entrypoint.endsWith("scripts\\cache-invalidation-smoke.ts")) {
  void main();
}

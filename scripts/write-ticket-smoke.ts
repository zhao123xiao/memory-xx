import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Pool } from "pg";

import {
  PostgresWriteDatabase,
  WriteTicketRepository,
  withWriteTransaction,
} from "../app/db";
import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import type { JsonObject } from "../app/shared";

const execFileAsync = promisify(execFile);

export interface WriteTicketSmokeEnv {
  readonly [key: string]: string | undefined;
}

export interface WriteTicketWorkerStatus {
  readonly worker_id?: string;
  readonly ok?: boolean;
  readonly phase?: string;
  readonly claimed?: number;
  readonly completed?: number;
  readonly failed?: number;
  readonly at?: string;
  readonly error?: string;
}

export interface WriteTicketStatus {
  readonly status: string;
  readonly attempts: number;
  readonly terminal_at: string | null;
  readonly created_memory_id: string | null;
  readonly candidate_memory_id: string | null;
  readonly duplicate_of_memory_id: string | null;
  readonly failure_reason: string | null;
}

export interface WriteTicketSmokeReport {
  readonly ok: boolean;
  readonly mode: "live";
  readonly runtime_dir: string | null;
  readonly ticket_id: string | null;
  readonly worker_status: WriteTicketWorkerStatus | null;
  readonly ticket_status: WriteTicketStatus | null;
  readonly blockers: readonly string[];
}

interface BuildWriteTicketSmokeOptions {
  readonly env?: WriteTicketSmokeEnv;
  readonly runtimeDir?: string;
  readonly ticketText?: string;
  readonly seedTicket?: (payload: JsonObject, env: WriteTicketSmokeEnv) => Promise<string>;
  readonly runWorker?: (runtimeDir: string, env: WriteTicketSmokeEnv) => Promise<void>;
  readonly readTicketStatus?: (ticketId: string, env: WriteTicketSmokeEnv) => Promise<WriteTicketStatus | null>;
  readonly keepRuntimeDir?: boolean;
}

export async function buildWriteTicketSmokeReport(
  options: BuildWriteTicketSmokeOptions = {}
): Promise<WriteTicketSmokeReport> {
  const env = options.env ?? process.env;
  const blockers = requiredEnvBlockers(env);
  if (blockers.length > 0) {
    return {
      ok: false,
      mode: "live",
      runtime_dir: options.runtimeDir ?? null,
      ticket_id: null,
      worker_status: null,
      ticket_status: null,
      blockers,
    };
  }

  const runtimeDir = options.runtimeDir ?? await mkdtemp(path.join(os.tmpdir(), "memory-xx-write-ticket-smoke-"));
  const ownsRuntimeDir = !options.runtimeDir;
  let ticketId: string | null = null;
  try {
    await mkdir(runtimeDir, { recursive: true });
    const payload = buildTicketPayload(options.ticketText);
    ticketId = await (options.seedTicket ?? seedWriteTicket)(payload, env);
    await (options.runWorker ?? runWorkerOnce)(runtimeDir, env);
    const workerStatus = await readWorkerStatus(runtimeDir);
    const ticketStatus = await (options.readTicketStatus ?? readWriteTicketStatus)(ticketId, env);
    const terminalSuccess = ticketStatus?.status === "created" ||
      ticketStatus?.status === "candidate_created" ||
      ticketStatus?.status === "duplicate_found";
    const outputBlockers = [
      ...(workerStatus ? [] : ["worker_status_missing"]),
      ...(workerStatus && workerStatus.ok === true ? [] : [`worker_not_ok:${workerStatus?.error ?? "missing"}`]),
      ...(workerStatus && Number(workerStatus.claimed ?? 0) > 0 ? [] : ["worker_claimed_zero"]),
      ...(workerStatus && Number(workerStatus.completed ?? 0) > 0 ? [] : ["worker_completed_zero"]),
      ...(workerStatus && Number(workerStatus.failed ?? 0) === 0 ? [] : ["worker_failed_nonzero"]),
      ...(terminalSuccess ? [] : [`ticket_not_terminal_success:${ticketStatus?.status ?? "missing"}`]),
      ...(ticketStatus?.terminal_at ? [] : ["ticket_missing_terminal_at"]),
    ];

    return {
      ok: outputBlockers.length === 0,
      mode: "live",
      runtime_dir: runtimeDir,
      ticket_id: ticketId,
      worker_status: workerStatus,
      ticket_status: ticketStatus,
      blockers: outputBlockers,
    };
  } finally {
    if (ownsRuntimeDir && !options.keepRuntimeDir) {
      await rm(runtimeDir, { recursive: true, force: true });
    }
  }
}

function requiredEnvBlockers(env: WriteTicketSmokeEnv): readonly string[] {
  return [
    ["MEMORY_XX_DATABASE_URL", env.MEMORY_XX_DATABASE_URL],
    ["MEMORY_XX_REDIS_URL", env.MEMORY_XX_REDIS_URL],
    ["MEMORY_XX_QDRANT_BASE_URL", env.MEMORY_XX_QDRANT_BASE_URL],
    ["EMBEDDING_API_BASE", env.EMBEDDING_API_BASE],
  ]
    .filter(([, value]) => !value?.trim())
    .map(([name]) => `missing_env:${name}`);
}

function buildTicketPayload(text?: string): JsonObject {
  const id = randomUUID();
  return {
    request_id: `write-ticket-smoke-${id}`,
    agent_id: "memory-xx-smoke",
    latency_mode: "fast_ack",
    mode: "write",
    text: text ?? `Please remember this memory-xx write ticket smoke marker ${id}.`,
    scope_hint: {
      scope_type: "project",
      scope_id: "memory-xx-smoke",
    },
    metadata: {
      source: "write_ticket_smoke",
      smoke: true,
    },
  };
}

async function seedWriteTicket(payload: JsonObject, env: WriteTicketSmokeEnv): Promise<string> {
  const db = new PostgresWriteDatabase({ config: loadMemoryXXPostgresConfig(env as NodeJS.ProcessEnv) });
  try {
    const repo = new WriteTicketRepository();
    const row = await withWriteTransaction(db, (tx) => repo.create(tx, {
      idempotencyKey: String(payload.request_id ?? randomUUID()),
      actorId: String(payload.agent_id ?? "memory-xx-smoke"),
      agentId: String(payload.agent_id ?? "memory-xx-smoke"),
      requestJson: payload,
      ttlSeconds: 300,
    }));
    return row.id;
  } finally {
    await db.close();
  }
}

async function runWorkerOnce(runtimeDir: string, env: WriteTicketSmokeEnv): Promise<void> {
  await execFileAsync(process.execPath, ["--import", "tsx", "scripts/run-write-ticket-worker.ts", "--once"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
      TMPDIR: "/tmp",
      MEMORY_XX_RUNTIME_DIR: runtimeDir,
      MEMORY_XX_WRITE_TICKET_WORKER_STATUS_FILE: path.join(runtimeDir, "write-ticket-worker.status.json"),
      MEMORY_XX_WRITE_TICKET_WORKER_BATCH_SIZE: "1",
      MEMORY_XX_WRITE_TICKET_LEASE_TTL_SECONDS: "120",
      MEMORY_XX_FAST_ACK_INLINE_FALLBACK: "false",
    },
    timeout: 180_000,
  });
}

async function readWorkerStatus(runtimeDir: string): Promise<WriteTicketWorkerStatus | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(runtimeDir, "write-ticket-worker.status.json"), "utf8")) as WriteTicketWorkerStatus;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function readWriteTicketStatus(ticketId: string, env: WriteTicketSmokeEnv): Promise<WriteTicketStatus | null> {
  const pgConfig = loadMemoryXXPostgresConfig(env as NodeJS.ProcessEnv);
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  try {
    const result = await pool.query(
      `SELECT status, attempts::int AS attempts, terminal_at, created_memory_id, candidate_memory_id, duplicate_of_memory_id, failure_reason FROM ${quoteIdent(pgConfig.schema)}.write_tickets WHERE id = $1`,
      [ticketId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      status: String(row.status),
      attempts: Number(row.attempts ?? 0),
      terminal_at: row.terminal_at ? new Date(row.terminal_at).toISOString() : null,
      created_memory_id: row.created_memory_id ?? null,
      candidate_memory_id: row.candidate_memory_id ?? null,
      duplicate_of_memory_id: row.duplicate_of_memory_id ?? null,
      failure_reason: row.failure_reason ?? null,
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
  const report = await buildWriteTicketSmokeReport({ keepRuntimeDir: process.argv.includes("--keep-runtime-dir") });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

const entrypoint = process.argv[1] ?? "";
if (entrypoint.endsWith("scripts/write-ticket-smoke.ts") || entrypoint.endsWith("scripts\\write-ticket-smoke.ts")) {
  void main();
}

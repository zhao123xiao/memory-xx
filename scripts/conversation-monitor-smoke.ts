import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";

const execFileAsync = promisify(execFile);

export interface ConversationMonitorSmokeEnv {
  readonly [key: string]: string | undefined;
}

export interface ConversationMonitorSmokeHeartbeat {
  readonly ok?: boolean;
  readonly phase?: string;
  readonly posted_events?: number;
  readonly flushed_sessions?: number;
  readonly updated_at?: string;
  readonly last_error?: string | null;
}

export interface ConversationMonitorSmokeReport {
  readonly ok: boolean;
  readonly mode: "live";
  readonly runtime_dir: string | null;
  readonly conversation_id: string;
  readonly session_id: string;
  readonly heartbeat: ConversationMonitorSmokeHeartbeat | null;
  readonly event_count: number;
  readonly blockers: readonly string[];
}

interface BuildConversationMonitorSmokeOptions {
  readonly env?: ConversationMonitorSmokeEnv;
  readonly runtimeDir?: string;
  readonly conversationId?: string;
  readonly sessionId?: string;
  readonly runWorker?: (runtimeDir: string, env: ConversationMonitorSmokeEnv) => Promise<void>;
  readonly countEvents?: (conversationId: string, sessionId: string, env: ConversationMonitorSmokeEnv) => Promise<number>;
  readonly now?: () => Date;
  readonly keepRuntimeDir?: boolean;
}

export async function buildConversationMonitorSmokeReport(
  options: BuildConversationMonitorSmokeOptions = {}
): Promise<ConversationMonitorSmokeReport> {
  const env = options.env ?? process.env;
  const blockers = requiredEnvBlockers(env);
  const conversationId = options.conversationId ?? `conversation-smoke-${randomUUID()}`;
  const sessionId = options.sessionId ?? `session-${randomUUID()}`;
  if (blockers.length > 0) {
    return {
      ok: false,
      mode: "live",
      runtime_dir: options.runtimeDir ?? null,
      conversation_id: conversationId,
      session_id: sessionId,
      heartbeat: null,
      event_count: 0,
      blockers,
    };
  }

  const runtimeDir = options.runtimeDir ?? await mkdtemp(path.join(os.tmpdir(), "memory-xx-conversation-monitor-smoke-"));
  const ownsRuntimeDir = !options.runtimeDir;
  try {
    await seedRuntimeDir(runtimeDir, conversationId, sessionId, options.now?.() ?? new Date());
    await (options.runWorker ?? runWorkerOnce)(runtimeDir, env);
    const heartbeat = await readHeartbeat(runtimeDir);
    const eventCount = await (options.countEvents ?? countConversationEvents)(conversationId, sessionId, env);
    const outputBlockers = [
      ...(heartbeat?.ok === true ? [] : [`heartbeat_not_ok:${heartbeat?.last_error ?? "missing"}`]),
      ...(heartbeat?.updated_at ? [] : ["heartbeat_missing_updated_at"]),
      ...(eventCount > 0 ? [] : ["conversation_event_not_stored"]),
    ];

    return {
      ok: outputBlockers.length === 0,
      mode: "live",
      runtime_dir: runtimeDir,
      conversation_id: conversationId,
      session_id: sessionId,
      heartbeat,
      event_count: eventCount,
      blockers: outputBlockers,
    };
  } finally {
    if (ownsRuntimeDir && !options.keepRuntimeDir) {
      await rm(runtimeDir, { recursive: true, force: true });
    }
  }
}

function requiredEnvBlockers(env: ConversationMonitorSmokeEnv): readonly string[] {
  return [
    ["MEMORY_XX_WRAPPER_URL", env.MEMORY_XX_WRAPPER_URL],
    ["MEMORY_XX_DATABASE_URL", env.MEMORY_XX_DATABASE_URL],
  ]
    .filter(([, value]) => !value?.trim())
    .map(([name]) => `missing_env:${name}`);
}

async function seedRuntimeDir(runtimeDir: string, conversationId: string, sessionId: string, now: Date): Promise<void> {
  const spoolDir = path.join(runtimeDir, "conversation-events");
  await mkdir(spoolDir, { recursive: true });
  await writeFile(path.join(runtimeDir, "conversation-monitor.json"), JSON.stringify({
    conversation_monitor: true,
    conversation_auto_extract: false,
  }, null, 2), "utf8");
  await writeFile(path.join(spoolDir, "smoke.jsonl"), `${JSON.stringify({
    conversation_id: conversationId,
    session_id: sessionId,
    turn_id: "user-1",
    role: "user",
    content: `Remember: memory-xx conversation monitor smoke ${conversationId} stores spool events.`,
    observed_at: now.toISOString(),
    metadata: { smoke: true },
  })}\n`, "utf8");
}

async function runWorkerOnce(runtimeDir: string, env: ConversationMonitorSmokeEnv): Promise<void> {
  await execFileAsync(process.execPath, ["--import", "tsx", "scripts/run-conversation-monitor-worker.ts", "--once"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
      TMPDIR: "/tmp",
      MEMORY_XX_RUNTIME_DIR: runtimeDir,
      MEMORY_XX_CONVERSATION_SPOOL_PATH: path.join(runtimeDir, "conversation-events", "*.jsonl"),
      MEMORY_XX_CONVERSATION_SOURCE_TAIL: "0",
      MEMORY_XX_CONVERSATION_POLL_INTERVAL_MS: "100",
    },
    timeout: 120_000,
  });
}

async function readHeartbeat(runtimeDir: string): Promise<ConversationMonitorSmokeHeartbeat | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(runtimeDir, "conversation-monitor-heartbeat.json"), "utf8")) as ConversationMonitorSmokeHeartbeat;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function countConversationEvents(conversationId: string, sessionId: string, env: ConversationMonitorSmokeEnv): Promise<number> {
  const pgConfig = loadMemoryXXPostgresConfig(env as NodeJS.ProcessEnv);
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM ${quoteIdent(pgConfig.schema)}.conversation_events WHERE conversation_id = $1 AND session_id = $2`,
      [conversationId, sessionId]
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await pool.end();
  }
}

function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error(`unsafe_identifier:${value}`);
  return `"${value}"`;
}

async function main(): Promise<void> {
  const report = await buildConversationMonitorSmokeReport({ keepRuntimeDir: process.argv.includes("--keep-runtime-dir") });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

const entrypoint = process.argv[1] ?? "";
if (entrypoint.endsWith("scripts/conversation-monitor-smoke.ts") || entrypoint.endsWith("scripts\\conversation-monitor-smoke.ts")) {
  void main();
}

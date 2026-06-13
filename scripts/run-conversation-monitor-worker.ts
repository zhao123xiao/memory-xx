#!/usr/bin/env tsx
import "./test-harness/config.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";

import {
  defaultConversationSourceConfigs,
  scanConversationSources,
  type ConversationSourceAdapterSummary,
} from "../app/conversation/session-source-adapters";
import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import { activatePendingRuntimeControlsSync, readRuntimeControlNumberSync } from "../app/runtime-control-settings";

interface RuntimeFlags {
  readonly conversation_monitor: boolean;
  readonly conversation_auto_extract: boolean;
}

interface SpoolCursor {
  readonly files: Record<string, number>;
}

interface SessionKey {
  readonly conversation_id: string;
  readonly session_id: string | null;
}

function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`unsafe_identifier:${value}`);
  }
  return `"${value}"`;
}

const runtimeDir = process.env.MEMORY_XX_RUNTIME_DIR?.trim() || path.join(process.cwd(), ".runtime");
activatePendingRuntimeControlsSync(["worker.conversation.poll_interval_ms"]);
const controlsPath = path.join(runtimeDir, "conversation-monitor.json");
const cursorPath = path.join(runtimeDir, "conversation-events", ".cursor.json");
const sourceCursorPath = path.join(runtimeDir, "conversation-sources.cursor.json");
const heartbeatPath = path.join(runtimeDir, "conversation-monitor-heartbeat.json");
const wrapperUrl = (process.env.MEMORY_XX_WRAPPER_URL?.trim() || "http://127.0.0.1:5100").replace(/\/+$/, "");
const wrapperToken = process.env.MEMORY_XX_ADMIN_TOKEN?.trim() || process.env.MEMORY_XX_API_TOKEN?.trim() || "";
const pollIntervalMs = readPositiveInt("MEMORY_XX_CONVERSATION_POLL_INTERVAL_MS", 10_000);
const spoolPattern = process.env.MEMORY_XX_CONVERSATION_SPOOL_PATH?.trim() || ".runtime/conversation-events/*.jsonl";
const once = process.argv.includes("--once");
const conversationPostMaxBytes = readPositiveInt("MEMORY_XX_CONVERSATION_EVENTS_POST_MAX_BYTES", 750_000);
const conversationPostMaxEvents = readPositiveInt("MEMORY_XX_CONVERSATION_EVENTS_POST_MAX_EVENTS", 50);

let stopping = false;
let lastError: string | null = null;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  const envValue = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  if (name === "MEMORY_XX_CONVERSATION_POLL_INTERVAL_MS") {
    const runtimeValue = readRuntimeControlNumberSync("worker.conversation.poll_interval_ms", envValue);
    return Number.isFinite(runtimeValue) && runtimeValue > 0 ? runtimeValue : envValue;
  }
  return envValue;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim();
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return fallback;
}

function hashContent(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function batchConversationEventsForPost(
  events: readonly Record<string, unknown>[],
  options: { readonly maxBytes: number; readonly maxEvents: number },
): Record<string, unknown>[][] {
  const batches: Record<string, unknown>[][] = [];
  let current: Record<string, unknown>[] = [];
  const maxBytes = Math.max(1024, options.maxBytes);
  const maxEvents = Math.max(1, options.maxEvents);

  function payloadSize(batch: readonly Record<string, unknown>[]): number {
    return Buffer.byteLength(JSON.stringify({ events: batch }), "utf8");
  }

  for (const event of events) {
    const singleSize = payloadSize([event]);
    if (singleSize > maxBytes) {
      if (current.length > 0) {
        batches.push(current);
        current = [];
      }
      continue;
    }
    const next = [...current, event];
    if (current.length > 0 && (next.length > maxEvents || payloadSize(next) > maxBytes)) {
      batches.push(current);
      current = [event];
      continue;
    }
    current = next;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function loadFlags(): Promise<RuntimeFlags> {
  const base = {
    conversation_monitor: boolEnv("MEMORY_XX_CONVERSATION_MONITOR", false),
    conversation_auto_extract: boolEnv("MEMORY_XX_CONVERSATION_AUTO_EXTRACT", false),
  };
  try {
    const parsed = JSON.parse(await readFile(controlsPath, "utf8")) as Partial<RuntimeFlags>;
    return {
      conversation_monitor: typeof parsed.conversation_monitor === "boolean" ? parsed.conversation_monitor : base.conversation_monitor,
      conversation_auto_extract: typeof parsed.conversation_auto_extract === "boolean" ? parsed.conversation_auto_extract : base.conversation_auto_extract,
    };
  } catch {
    return base;
  }
}

async function loadCursor(): Promise<SpoolCursor> {
  try {
    const parsed = JSON.parse(await readFile(cursorPath, "utf8")) as Partial<SpoolCursor>;
    return { files: parsed.files && typeof parsed.files === "object" ? parsed.files : {} };
  } catch {
    return { files: {} };
  }
}

async function saveCursor(cursor: SpoolCursor): Promise<void> {
  await mkdir(path.dirname(cursorPath), { recursive: true });
  await writeFile(cursorPath, JSON.stringify(cursor, null, 2));
}

async function writeHeartbeat(input: {
  readonly flags: RuntimeFlags;
  readonly spoolFiles?: readonly string[];
  readonly sourceFiles?: readonly string[];
  readonly sourceAdapters?: readonly ConversationSourceAdapterSummary[];
  readonly sourceEventsPosted?: number;
  readonly sourceSkipped?: number;
  readonly sourceSkippedExistingFiles?: number;
  readonly cursor?: SpoolCursor;
  readonly postedEvents?: number;
  readonly flushedSessions?: number;
  readonly phase: string;
}): Promise<void> {
  await mkdir(path.dirname(heartbeatPath), { recursive: true });
  await writeFile(heartbeatPath, JSON.stringify({
    ok: lastError === null,
    phase: input.phase,
    pid: process.pid,
    once,
    wrapper_url: wrapperUrl,
    spool_pattern: spoolPattern,
    controls_path: controlsPath,
    cursor_path: cursorPath,
    source_cursor_path: sourceCursorPath,
    flags: input.flags,
    spool_files: input.spoolFiles ?? [],
    source_files: input.sourceFiles ?? [],
    source_adapters: input.sourceAdapters ?? [],
    source_events_posted: input.sourceEventsPosted ?? 0,
    source_skipped: input.sourceSkipped ?? 0,
    source_skipped_existing_files: input.sourceSkippedExistingFiles ?? 0,
    cursor: input.cursor ?? null,
    posted_events: input.postedEvents ?? 0,
    flushed_sessions: input.flushedSessions ?? 0,
    last_error: lastError,
    updated_at: new Date().toISOString(),
  }, null, 2));
}

async function listSpoolFiles(pattern: string): Promise<string[]> {
  const absolutePattern = path.resolve(pattern);
  if (!absolutePattern.includes("*")) {
    try {
      const info = await stat(absolutePattern);
      return info.isFile() ? [absolutePattern] : [];
    } catch {
      return [];
    }
  }
  const dir = path.dirname(absolutePattern);
  const base = path.basename(absolutePattern).replace(/\*/gu, "");
  try {
    const names = await readdir(dir);
    return names
      .filter((name) => name.endsWith(".jsonl") && (base === ".jsonl" || name.includes(base)))
      .map((name) => path.join(dir, name))
      .sort();
  } catch {
    return [];
  }
}

function sessionKeyFromEvent(event: { readonly [key: string]: unknown }): SessionKey | null {
  const conversationId = typeof event.conversation_id === "string"
    ? event.conversation_id
    : typeof event.conversationId === "string"
      ? event.conversationId
      : "codex-local";
  if (!conversationId) return null;
  const sessionId = typeof event.session_id === "string"
    ? event.session_id
    : typeof event.sessionId === "string"
      ? event.sessionId
      : null;
  return { conversation_id: conversationId, session_id: sessionId || null };
}

function eventObject(event: { readonly id: string } & object): Record<string, unknown> {
  return { ...(event as unknown as Record<string, unknown>) };
}

async function postJson(pathname: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${wrapperUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(wrapperToken ? { Authorization: `Bearer ${wrapperToken}`, "X-API-Key": wrapperToken } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${pathname}: ${text.slice(0, 240)}`);
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

async function postConversationEvents(events: readonly { readonly [key: string]: unknown }[]): Promise<number> {
  let posted = 0;
  const batches = batchConversationEventsForPost(events, {
    maxBytes: conversationPostMaxBytes,
    maxEvents: conversationPostMaxEvents,
  });
  for (const batch of batches) {
    await postJson("/api/memory/xx/conversation/events", { events: batch });
    posted += batch.length;
  }
  return posted;
}

async function readSpoolEvents(): Promise<{ events: Record<string, unknown>[]; sessions: SessionKey[]; files: string[]; cursor: SpoolCursor }> {
  const files = await listSpoolFiles(spoolPattern);
  const cursor = await loadCursor();
  const events: Record<string, unknown>[] = [];
  const sessions = new Map<string, SessionKey>();
  for (const file of files) {
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) continue;
    const previousOffset = Math.min(cursor.files[file] ?? 0, info.size);
    if (info.size <= previousOffset) continue;
    const raw = await readFile(file);
    const chunk = raw.subarray(previousOffset).toString("utf8");
    cursor.files[file] = info.size;
    for (const line of chunk.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        if (!event.content_hash && typeof event.content === "string") {
          event.content_hash = hashContent(event.content);
        }
        events.push(event);
        const key = sessionKeyFromEvent(event);
        if (key) sessions.set(`${key.conversation_id}\0${key.session_id ?? ""}`, key);
      } catch (error) {
        console.warn(JSON.stringify({ level: "warn", msg: "invalid_jsonl_event", file, error: error instanceof Error ? error.message : String(error) }));
      }
    }
  }
  await saveCursor(cursor);
  return { events, sessions: [...sessions.values()], files, cursor };
}

async function pendingSessions(pool: Pool, schema: string): Promise<SessionKey[]> {
  const result = await pool.query(`
    SELECT conversation_id, session_id
    FROM ${quoteIdent(schema)}.conversation_events
    WHERE processed_at IS NULL
    GROUP BY conversation_id, session_id
    ORDER BY MIN(observed_at) ASC
    LIMIT 50
  `);
  return result.rows.map((row) => ({ conversation_id: String(row.conversation_id), session_id: row.session_id ? String(row.session_id) : null }));
}

async function flushSessions(sessions: readonly SessionKey[]): Promise<number> {
  let flushed = 0;
  for (const session of sessions) {
    const body = {
      conversation_id: session.conversation_id,
      session_id: session.session_id ?? undefined,
      force: false,
    };
    try {
      const result = await postJson("/api/memory/xx/conversation/flush", body);
      console.log(JSON.stringify({ level: "info", msg: "conversation_flush", session, result }));
      flushed += 1;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ level: "warn", msg: "conversation_flush_failed", session, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  return flushed;
}

async function loop(): Promise<void> {
  const pgConfig = loadMemoryXXPostgresConfig(process.env);
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  try {
    while (!stopping) {
      const flags = await loadFlags();
      let heartbeat = {
        flags,
        phase: "idle",
        postedEvents: 0,
        flushedSessions: 0,
        spoolFiles: [] as string[],
        sourceFiles: [] as string[],
        sourceAdapters: [] as ConversationSourceAdapterSummary[],
        sourceEventsPosted: 0,
        sourceSkipped: 0,
        sourceSkippedExistingFiles: 0,
        cursor: undefined as SpoolCursor | undefined,
      };
      if (flags.conversation_monitor) {
        const sourceScanEnabled = boolEnv("MEMORY_XX_CONVERSATION_SOURCE_TAIL", true);
        const sourceScan = sourceScanEnabled
          ? await scanConversationSources({
            adapters: defaultConversationSourceConfigs(process.env),
            cursorPath: sourceCursorPath,
            readExisting: boolEnv("MEMORY_XX_CONVERSATION_SOURCE_BACKFILL", false),
          })
          : null;
        const { events, sessions, files, cursor } = await readSpoolEvents();
        const sourceEvents = (sourceScan?.events ?? []).map(eventObject);
        const allEvents = [...sourceEvents, ...events];
        const sourceSessions = sourceEvents.map(sessionKeyFromEvent).filter((item): item is SessionKey => item !== null);
        heartbeat = {
          ...heartbeat,
          phase: "monitoring",
          spoolFiles: files,
          sourceFiles: [...(sourceScan?.source_files ?? [])],
          sourceAdapters: [...(sourceScan?.source_adapters ?? [])],
          sourceEventsPosted: sourceScan?.source_events_posted ?? 0,
          sourceSkipped: sourceScan?.source_skipped ?? 0,
          sourceSkippedExistingFiles: sourceScan?.skipped_existing_files ?? 0,
          cursor,
        };
        if (allEvents.length > 0) {
          try {
            const posted = await postConversationEvents(allEvents);
            heartbeat = { ...heartbeat, postedEvents: posted };
            lastError = null;
            console.log(JSON.stringify({ level: "info", msg: "conversation_events_posted", count: posted, source_count: sourceEvents.length, spool_count: events.length }));
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            throw error;
          }
        }
        if (flags.conversation_auto_extract) {
          const dbSessions = await pendingSessions(pool, pgConfig.schema).catch((error) => {
            console.warn(JSON.stringify({ level: "warn", msg: "pending_sessions_failed", error: error instanceof Error ? error.message : String(error) }));
            return [] as SessionKey[];
          });
          const all = new Map<string, SessionKey>();
          for (const session of [...sourceSessions, ...sessions, ...dbSessions]) all.set(`${session.conversation_id}\0${session.session_id ?? ""}`, session);
          heartbeat = { ...heartbeat, phase: "auto_extracting", flushedSessions: await flushSessions([...all.values()]) };
        }
      }
      await writeHeartbeat(heartbeat);
      if (once) break;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  loop().catch((error) => {
    console.error(JSON.stringify({ level: "error", msg: "conversation_monitor_worker_failed", error: error instanceof Error ? error.stack ?? error.message : String(error) }));
    process.exitCode = 1;
  });
}

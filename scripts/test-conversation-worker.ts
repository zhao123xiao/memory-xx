#!/usr/bin/env tsx
import "./test-harness/config.js";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { appendCodexConversationEvent } from "../app/conversation/codex-jsonl-bridge";
import { config } from "./test-harness/config";
import { closePool, createPool, query } from "./test-harness/lib/db-helpers";
import { apiUrl, httpPost } from "./test-harness/lib/http-client";

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${name}: ${detail}`);
}

function runWorkerOnce(runtimeDir: string): void {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/run-conversation-monitor-worker.ts", "--once"], {
    cwd: config.projectRoot,
    env: {
      ...process.env,
      TMPDIR: "/tmp",
      MEMORY_XX_RUNTIME_DIR: runtimeDir,
      MEMORY_XX_CONVERSATION_SPOOL_PATH: path.join(runtimeDir, "conversation-events", "*.jsonl"),
      MEMORY_XX_CONVERSATION_POLL_INTERVAL_MS: "100",
      MEMORY_XX_CONVERSATION_DEBOUNCE_MS: "60000",
    },
    encoding: "utf8",
    stdio: "pipe",
    timeout: 120_000,
  });
}

function idsFromRecall(body: any): string[] {
  const results = body?.results || body?.recall?.results || body?.memories || [];
  return Array.isArray(results) ? results.map((item: any) => item.memory_id || item.memoryId || item.id).filter(Boolean) : [];
}

async function waitForCompletedBatch(pool: ReturnType<typeof createPool>, conversationId: string, sessionId: string): Promise<any> {
  const deadline = Date.now() + 120_000;
  let last: any = null;
  while (Date.now() < deadline) {
    const batches = await query(pool, `
      SELECT id, status, mem0_mode, extraction_backend, candidate_memory_ids, no_op_reasons
      FROM ${config.dbSchema}.conversation_batches
      WHERE conversation_id = $1 AND session_id = $2
      ORDER BY created_at DESC
      LIMIT 1
    `, [conversationId, sessionId]);
    last = batches.rows[0] as any;
    if (last?.status === "completed" || last?.status === "failed") return last;
    await sleep(2_000);
  }
  return last;
}

async function main(): Promise<void> {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-conversation-worker-"));
  const pool = createPool();
  const runId = Math.random().toString(16).slice(2, 10);
  const conversationId = `codex-worker-${runId}`;
  const sessionId = `codex-worker-session-${runId}`;
  const projectId = `conversation-worker-${runId}`;
  let memoryId = "";
  try {
    console.log(`\nConversation worker live gate: ${runId}\n`);
    await appendCodexConversationEvent(path.join(runtimeDir, "conversation-events", "codex.jsonl"), {
      role: "user",
      content: `请记住：conversation worker ${runId} 必须先落 JSONL spool，再通过 worker 生成 pending candidate。`,
      conversation_id: conversationId,
      session_id: sessionId,
      turn_id: "user-1",
      scope_context: { project_ids: [projectId], user_id: "current-instance-owner", workspace_id: "current-instance" },
      metadata: { test_run_id: runId, memory_intent: true },
    });

    await writeFile(path.join(runtimeDir, "conversation-monitor.json"), JSON.stringify({
      conversation_monitor: true,
      conversation_auto_extract: false,
    }, null, 2));
    runWorkerOnce(runtimeDir);
    const events = await query(pool, `
      SELECT id, processed_at
      FROM ${config.dbSchema}.conversation_events
      WHERE conversation_id = $1 AND session_id = $2
      ORDER BY observed_at ASC
    `, [conversationId, sessionId]);
    check("worker:monitor-events", events.rows.length === 1 && events.rows[0]?.processed_at === null, `events=${events.rows.length}, processed=${events.rows[0]?.processed_at ?? "null"}`);

    await writeFile(path.join(runtimeDir, "conversation-monitor.json"), JSON.stringify({
      conversation_monitor: true,
      conversation_auto_extract: true,
    }, null, 2));
    runWorkerOnce(runtimeDir);

    const batch = await waitForCompletedBatch(pool, conversationId, sessionId);
    const candidates = Array.isArray(batch?.candidate_memory_ids) ? batch.candidate_memory_ids : [];
    memoryId = candidates[0] || "";
    check("worker:auto-extract-batch", batch?.status === "completed" && batch?.mem0_mode === "official", `status=${batch?.status}, mem0=${batch?.mem0_mode}, backend=${batch?.extraction_backend}`);
    check("worker:pending-candidate-created", Boolean(memoryId), `memoryId=${memoryId || "missing"}, no_op=${JSON.stringify(batch?.no_op_reasons ?? [])}`);

    if (memoryId) {
      const memory = await query(pool, `
        SELECT lifecycle_status, review_state, metadata
        FROM ${config.dbSchema}.memory_records
        WHERE id = $1
      `, [memoryId]);
      const row = memory.rows[0] as any;
      check("worker:candidate-default-review", row?.lifecycle_status === "candidate" && row?.review_state === "pending", `lifecycle=${row?.lifecycle_status}, review=${row?.review_state}`);

      const approve = await httpPost(apiUrl(`/api/memory/xx/review/memories/${encodeURIComponent(memoryId)}/approve`), {
        requestId: `${runId}:approve`,
        actorId: "conversation-worker-test",
      }, { token: config.wrapperToken, timeout: 45_000 });
      check("worker:approve-candidate", approve.status === 200, `status=${approve.status}`);

      const recallA = await httpPost(apiUrl("/api/memory/xx/unified/recall"), {
        agent_id: "conversation-worker-test",
        query: `conversation worker ${runId} pending candidate`,
        scope_type: "project",
        scope_id: projectId,
        scope_context: { project_ids: [projectId], include_global: false },
        limit: 5,
      }, { token: config.wrapperToken, timeout: 45_000 });
      const idsA = idsFromRecall(recallA.body);
      check("worker:recall-project-a", recallA.status === 200 && idsA.includes(memoryId), `status=${recallA.status}, ids=${idsA.join(",")}`);

      const recallB = await httpPost(apiUrl("/api/memory/xx/unified/recall"), {
        agent_id: "conversation-worker-test",
        query: `conversation worker ${runId} pending candidate`,
        scope_type: "project",
        scope_id: `${projectId}-other`,
        scope_context: { project_ids: [`${projectId}-other`], include_global: false },
        limit: 5,
      }, { token: config.wrapperToken, timeout: 45_000 });
      const idsB = idsFromRecall(recallB.body);
      check("worker:project-isolation", recallB.status === 200 && !idsB.includes(memoryId), `status=${recallB.status}, ids=${idsB.join(",")}`);

      const heartbeat = JSON.parse(await readFile(path.join(runtimeDir, "conversation-monitor-heartbeat.json"), "utf8"));
      check("worker:heartbeat", Boolean(heartbeat.updated_at), `phase=${heartbeat.phase}, updated=${heartbeat.updated_at}`);
    }
  } finally {
    if (memoryId) {
      await httpPost(apiUrl("/api/memory/xx/unified/forget"), {
        memory_id: memoryId,
        agent_id: "conversation-worker-test",
        mode: "tombstone",
      }, { token: config.wrapperToken, timeout: 30_000 }).catch(() => undefined);
    }
    await closePool(pool);
    await rm(runtimeDir, { recursive: true, force: true });
  }
  const failed = checks.filter((item) => !item.passed);
  console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

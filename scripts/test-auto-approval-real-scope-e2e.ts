#!/usr/bin/env tsx
import "./test-harness/config.js";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import { apiUrl, httpPost } from "./test-harness/lib/http-client.js";
import { scrollByMemoryId } from "./test-harness/lib/qdrant-helpers.js";
import { config } from "./test-harness/config.js";
import { loadDotenvIfPresent, quoteIdent } from "./lib/runtime-env";

loadDotenvIfPresent();

const execFileAsync = promisify(execFile);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function idsFromRecall(body: unknown): string[] {
  const data = body as Record<string, unknown>;
  const recall = data?.recall as Record<string, unknown> | undefined;
  const results = (Array.isArray(data?.results) ? data.results : Array.isArray(recall?.results) ? recall.results : []) as Array<Record<string, unknown>>;
  return results.map((item) => String(item.memory_id ?? item.memoryId ?? item.id ?? "")).filter(Boolean);
}

async function runCli(args: readonly string[]): Promise<Record<string, unknown>> {
  const result = await execFileAsync("npm", ["run", "--silent", ...args], {
    cwd: process.cwd(),
    timeout: 90_000,
    env: process.env,
  });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function enableRealScope(scope: string): Promise<void> {
  await runCli(["memory:auto-approval", "--", "enable-real-scope", `--scope=${scope}`, "--agent=codex"]);
}

async function writeAndVerify(input: {
  readonly runId: string;
  readonly scopeType: "project" | "workspace";
  readonly scopeId: string;
  readonly marker: string;
  readonly text: string;
  readonly metadata: Record<string, unknown>;
  readonly pool: Pool;
  readonly schema: string;
}): Promise<Record<string, unknown>> {
  const write = await httpPost(apiUrl("/api/memory/xx/intelligence/smart-write"), {
    text: input.text,
    agent_id: "codex",
    scope_hint: { scope_type: input.scopeType, scope_id: input.scopeId },
    mode: "auto_approve",
    metadata: {
      source: "conversation_ingest",
      real_scope_auto_approval_run_id: input.runId,
      auto_approval_test_case_type: "real_scope_e2e",
      ...input.metadata,
    },
  }, { token: config.wrapperToken, timeout: 60_000 });
  const created = Array.isArray((write.body as Record<string, unknown>)?.created)
    ? (write.body as { created: Array<Record<string, unknown>> }).created
    : [];
  const createdIds = created.map((item) => String(item.memory_id ?? item.memoryId ?? item.id ?? "")).filter(Boolean);
  const approved = created.find((item) => item.lifecycle_status === "approved" && item.review_state === "silent_approved");
  let memoryId = String(approved?.memory_id ?? "");
  if (!memoryId && createdIds.length > 0) {
    const rows = await input.pool.query(`
      SELECT id
      FROM ${input.schema}.memory_records
      WHERE id = ANY($1::text[])
        AND lifecycle_status = 'approved'
        AND review_state = 'silent_approved'
      LIMIT 1
    `, [createdIds]);
    memoryId = String(rows.rows[0]?.id ?? "");
  }
  if (write.status !== 200 || !memoryId) {
    throw new Error(`${input.scopeType}:${input.scopeId} did not silent approve status=${write.status} body=${JSON.stringify(write.body).slice(0, 1500)}`);
  }

  let qdrantVisible = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const points = await scrollByMemoryId(memoryId).catch(() => []);
    qdrantVisible = points.length > 0;
    if (qdrantVisible) break;
    await sleep(1500);
  }

  let unifiedHit = false;
  let mcpHit = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const recall = await httpPost(apiUrl("/api/memory/xx/unified/recall"), {
      query: input.text,
      scope_type: input.scopeType,
      scope_id: input.scopeId,
      include_global: false,
      memory_ids: [memoryId],
      limit: 5,
    }, { token: config.wrapperToken, timeout: 30_000 });
    unifiedHit = idsFromRecall(recall.body).includes(memoryId);
    const mcpArgs: Record<string, unknown> = { query: input.text, memory_ids: [memoryId], limit: 5 };
    if (input.scopeType === "project") mcpArgs.project_ids = [input.scopeId];
    else mcpArgs.workspace_id = input.scopeId;
    const mcp = await httpPost(apiUrl("/mcp"), {
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 100000),
      method: "tools/call",
      params: { name: "recall_memory", arguments: mcpArgs },
    }, { token: config.wrapperToken, timeout: 30_000 });
    const text = (((mcp.body as Record<string, unknown>)?.result as Record<string, unknown>)?.content as Array<Record<string, unknown>> | undefined)?.[0]?.text;
    const parsed = typeof text === "string" ? JSON.parse(text) as unknown : {};
    mcpHit = idsFromRecall(parsed).includes(memoryId);
    if (unifiedHit && mcpHit) break;
    await sleep(1500);
  }

  const rollback = await runCli([
    "memory:auto-approval",
    "--",
    "rollback",
    `--memory-id=${memoryId}`,
    "--mode=tombstone",
    `--reason=auto approval real scope e2e ${input.runId}`,
  ]);

  let invisible = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const recall = await httpPost(apiUrl("/api/memory/xx/unified/recall"), {
      query: input.marker,
      scope_type: input.scopeType,
      scope_id: input.scopeId,
      include_global: false,
      memory_ids: [memoryId],
      limit: 5,
    }, { token: config.wrapperToken, timeout: 30_000 });
    const points = await scrollByMemoryId(memoryId).catch(() => []);
    invisible = !idsFromRecall(recall.body).includes(memoryId) && points.length === 0;
    if (invisible) break;
    await sleep(1500);
  }

  return {
    scope: `${input.scopeType}:${input.scopeId}`,
    memory_id: memoryId,
    qdrant_visible_before_rollback: qdrantVisible,
    unified_recall_hit: unifiedHit,
    mcp_recall_hit: mcpHit,
    rollback,
    invisible_after_rollback: invisible,
    ok: qdrantVisible && unifiedHit && mcpHit && rollback.ok === true && invisible,
  };
}

async function main(): Promise<void> {
  const runId = `real-scope-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const pgConfig = loadMemoryXXPostgresConfig(process.env);
  const schema = quoteIdent(pgConfig.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  const client = await pool.connect();
  await enableRealScope("project:memory-xx");
  await enableRealScope("workspace:current-instance");

  try {
    await client.query(
      `UPDATE ${schema}.memory_records
       SET lifecycle_status = 'tombstone', is_current = false, updated_at = now()
       WHERE metadata->>'auto_approval_test_case_type' = 'real_scope_e2e'
         AND lifecycle_status <> 'tombstone'`
    ).catch(() => undefined);
    const projectMarker = `project closure token ${runId}`;
    const workspaceMarker = `svc-${runId}`;
    const reviewAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const results = [
      await writeAndVerify({
        runId,
        scopeType: "project",
        scopeId: "memory-xx",
        marker: projectMarker,
        text: `请记住：memory-xx 项目事实 ${projectMarker} 的长期规则是 add-only production closure accepts only clean fact entries.`,
        metadata: { memory_type: "fact" },
        pool,
        schema,
      }),
      await writeAndVerify({
        runId,
        scopeType: "workspace",
        scopeId: "current-instance",
        marker: workspaceMarker,
        text: `请记住：current-instance 的本机服务 ${workspaceMarker} 固定监听端口 65${Math.floor(Math.random() * 90 + 10)}，复核时间由 review_at 控制。`,
        metadata: { memory_type: "fact", review_at: reviewAt, temporal_validity: "workspace_current" },
        pool,
        schema,
      }),
    ];
    const ok = results.every((item) => item.ok === true);
    const report = { ok, run_id: runId, enabled_real_scopes: ["project:memory-xx", "workspace:current-instance"], results };
    const reportDir = join(process.cwd(), "reports", "auto-approval-real-scope-e2e");
    await mkdir(reportDir, { recursive: true });
    const reportPath = join(reportDir, `auto-approval-real-scope-e2e-${runId}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ...report, report_path: reportPath }, null, 2)}\n`);
    if (!ok) process.exitCode = 1;
  } finally {
    await client.query(
      `UPDATE ${schema}.memory_records
       SET lifecycle_status = 'tombstone', is_current = false, updated_at = now()
       WHERE metadata->>'real_scope_auto_approval_run_id' = $1
         AND lifecycle_status <> 'tombstone'`,
      [runId]
    ).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env tsx
import "./test-harness/config.js";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import { apiUrl, httpPost } from "./test-harness/lib/http-client.js";
import { scrollByMemoryId } from "./test-harness/lib/qdrant-helpers.js";
import { config } from "./test-harness/config.js";
import { loadDotenvIfPresent, quoteIdent } from "./lib/runtime-env";

loadDotenvIfPresent();

const execFileAsync = promisify(execFile);

function runtimeDir(): string {
  return process.env.MEMORY_XX_RUNTIME_DIR?.trim() || join(process.cwd(), ".runtime");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function idsFromRecall(body: unknown): string[] {
  const data = body as Record<string, unknown>;
  const recall = data?.recall as Record<string, unknown> | undefined;
  const results = (Array.isArray(data?.results) ? data.results : Array.isArray(recall?.results) ? recall.results : []) as Array<Record<string, unknown>>;
  return results.map((item) => String(item.memory_id ?? item.memoryId ?? item.id ?? "")).filter(Boolean);
}

async function ensureScopeGrant(client: import("pg").PoolClient, schema: string, agentId: string, scopeId: string): Promise<void> {
  await client.query(
    `
      INSERT INTO ${schema}.trusted_agent_scope_grants (
        id, agent_id, scope_type, scope_id, permissions, expires_at, created_by, revoked_at, created_at, updated_at
      )
      VALUES ($1, $2, 'project', $3, $4::text[], NULL, 'test:auto-approval-canary-e2e', NULL, now(), now())
      ON CONFLICT (agent_id, scope_type, scope_id) WHERE revoked_at IS NULL
      DO UPDATE SET permissions = EXCLUDED.permissions, updated_at = now()
    `,
    [randomUUID(), agentId, scopeId, ["memory:write", "memory:read", "memory:feedback"]]
  );
}

async function main(): Promise<void> {
  const runId = `aac-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const scopeId = `memory-xx-auto-approval-e2e-${runId}`;
  const marker = `auto approval test-scope marker ${runId}`;
  const agentId = "codex";
  const canaryPath = join(runtimeDir(), "auto-approval-canary.json");
  const previousCanary = existsSync(canaryPath) ? await readFile(canaryPath, "utf8") : null;
  const pgConfig = loadMemoryXXPostgresConfig(process.env);
  const schema = quoteIdent(pgConfig.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  const client = await pool.connect();
  let memoryId = "";
  try {
    await mkdir(runtimeDir(), { recursive: true });
    await writeFile(canaryPath, `${JSON.stringify({
      enabled: true,
      bypass_scopes: [`project:${scopeId}`],
      agents: [agentId],
      updated_at: new Date().toISOString(),
      source: "test:auto-approval-canary-e2e",
      semantic_name: "test-scope-e2e",
    }, null, 2)}\n`, "utf8");
    await ensureScopeGrant(client, schema, agentId, scopeId);

    const write = await httpPost(apiUrl("/api/memory/xx/intelligence/smart-write"), {
      text: `请记住：memory-xx automatic approval canary requires rollback evidence. ${marker}`,
      agent_id: agentId,
      scope_hint: { scope_type: "project", scope_id: scopeId },
      mode: "auto_approve",
      metadata: {
        source: "conversation_ingest",
        auto_approval_random_run_id: runId,
        auto_approval_test_case_type: "test_scope_e2e",
      },
    }, { token: config.wrapperToken, timeout: 60_000 });
    const created = Array.isArray((write.body as Record<string, unknown>)?.created)
      ? (write.body as { created: Array<Record<string, unknown>> }).created
      : [];
    const approved = created.find((item) => item.lifecycle_status === "approved" && item.review_state === "silent_approved");
    memoryId = String(approved?.memory_id ?? "");
    if (write.status !== 200 || !memoryId) {
      throw new Error(`smart-write did not silent approve status=${write.status} body=${JSON.stringify(write.body).slice(0, 1000)}`);
    }

    let qdrantVisible = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const points = await scrollByMemoryId(memoryId).catch(() => []);
      qdrantVisible = points.length > 0;
      if (qdrantVisible) break;
      await sleep(1500);
    }

    let unifiedHit = false;
    let mcpHit = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const recall = await httpPost(apiUrl("/api/memory/xx/unified/recall"), {
        query: marker,
        scope_type: "project",
        scope_id: scopeId,
        include_global: false,
        memory_ids: [memoryId],
        limit: 5,
      }, { token: config.wrapperToken, timeout: 30_000 });
      unifiedHit = idsFromRecall(recall.body).includes(memoryId);
      const mcp = await httpPost(apiUrl("/mcp"), {
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 100000),
        method: "tools/call",
        params: { name: "recall_memory", arguments: { query: marker, project_ids: [scopeId], memory_ids: [memoryId], limit: 5 } },
      }, { token: config.wrapperToken, timeout: 30_000 });
      const text = (((mcp.body as Record<string, unknown>)?.result as Record<string, unknown>)?.content as Array<Record<string, unknown>> | undefined)?.[0]?.text;
      const parsed = typeof text === "string" ? JSON.parse(text) as unknown : {};
      mcpHit = idsFromRecall(parsed).includes(memoryId);
      if (unifiedHit && mcpHit) break;
      await sleep(1500);
    }

    const rollback = await execFileAsync("npm", [
      "run",
      "--silent",
      "memory:auto-approval",
      "--",
      "rollback",
      `--memory-id=${memoryId}`,
      "--mode=tombstone",
      `--reason=auto approval test-scope e2e ${runId}`,
    ], { cwd: process.cwd(), timeout: 60_000, env: process.env });
    const rollbackJson = JSON.parse(rollback.stdout) as Record<string, unknown>;

    let invisible = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const recall = await httpPost(apiUrl("/api/memory/xx/unified/recall"), {
        query: marker,
        scope_type: "project",
        scope_id: scopeId,
        include_global: false,
        memory_ids: [memoryId],
        limit: 5,
      }, { token: config.wrapperToken, timeout: 30_000 });
      const points = await scrollByMemoryId(memoryId).catch(() => []);
      invisible = !idsFromRecall(recall.body).includes(memoryId) && points.length === 0;
      if (invisible) break;
      await sleep(1500);
    }
    const decision = await client.query(
      `SELECT rollback_memory_event_id, metadata FROM ${schema}.auto_approval_decisions WHERE approved_memory_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [memoryId]
    );
    const rollbackEventWritten = Boolean(decision.rows[0]?.rollback_memory_event_id);
    const ok = qdrantVisible && unifiedHit && mcpHit && rollbackJson.ok === true && invisible && rollbackEventWritten;
    const report = {
      ok,
      semantic_name: "test-scope-e2e",
      compatibility_script_name: "test:auto-approval-canary-e2e",
      run_id: runId,
      scope: `project:${scopeId}`,
      memory_id: memoryId,
      qdrant_visible_before_rollback: qdrantVisible,
      unified_recall_hit: unifiedHit,
      mcp_recall_hit: mcpHit,
      rollback: rollbackJson,
      invisible_after_rollback: invisible,
      rollback_event_written: rollbackEventWritten,
    };
    const reportDir = join(process.cwd(), "reports", "auto-approval-test-scope-e2e");
    await mkdir(reportDir, { recursive: true });
    const reportPath = join(reportDir, `auto-approval-test-scope-e2e-${runId}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const compatibilityReportDir = join(process.cwd(), "reports", "auto-approval-canary-e2e");
    await mkdir(compatibilityReportDir, { recursive: true });
    await writeFile(join(compatibilityReportDir, `auto-approval-canary-e2e-${runId}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ...report, report_path: reportPath }, null, 2)}\n`);
    if (!ok) process.exitCode = 1;
  } finally {
    if (memoryId) {
      await client.query(`UPDATE ${schema}.memory_records SET lifecycle_status = 'tombstone', is_current = false, updated_at = now() WHERE id = $1`, [memoryId]).catch(() => undefined);
    }
    if (previousCanary === null) await writeFile(canaryPath, `${JSON.stringify({ enabled: false, bypass_scopes: [], agents: [], updated_at: new Date().toISOString() }, null, 2)}\n`, "utf8").catch(() => undefined);
    else await writeFile(canaryPath, previousCanary, "utf8").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

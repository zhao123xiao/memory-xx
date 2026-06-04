#!/usr/bin/env tsx
import "./test-harness/config.js";

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import { apiUrl, httpPost } from "./test-harness/lib/http-client";
import { config } from "./test-harness/config";
import { loadDotenvIfPresent, quoteIdent } from "./lib/runtime-env";

loadDotenvIfPresent();

interface Scenario {
  readonly index: number;
  readonly type: string;
  readonly expect: "may_approve" | "must_not_approve";
  readonly messages: readonly { role: "user" | "assistant"; content: string }[];
}

interface CaseResult {
  readonly index: number;
  readonly type: string;
  readonly expect: string;
  readonly status: number;
  readonly ok: boolean;
  readonly candidate_memory_ids: readonly string[];
  readonly no_op_reasons: readonly string[];
  readonly mem0_mode: string | null;
  readonly mem0_success: boolean | null;
  readonly fallback_used: boolean;
  readonly approved_count: number;
  readonly pending_count: number;
  readonly blocked_reasons: readonly string[];
  readonly failure?: string;
}

function arg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function casesCount(): number {
  const parsed = Number.parseInt(arg("cases") || "50", 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(100, parsed)) : 50;
}

function marker(): string {
  return randomBytes(5).toString("hex");
}

function idsFromRecall(body: unknown): string[] {
  const data = body as Record<string, unknown>;
  const recall = data?.recall as Record<string, unknown> | undefined;
  const results = (Array.isArray(data?.results) ? data.results : Array.isArray(recall?.results) ? recall.results : []) as Array<Record<string, unknown>>;
  return results.map((item) => String(item.memory_id ?? item.memoryId ?? item.id ?? "")).filter(Boolean);
}

function readArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function buildScenario(index: number, runId: string): Scenario {
  const m = `${runId}-${index}-${marker()}`;
  const durable = [
    {
      type: "durable_project_fact",
      messages: [{ role: "user" as const, content: `请记住：本项目的发布检查 ${m} 要求先确认 memory doctor 没有 blocker，再执行发布记录。` }],
    },
    {
      type: "durable_project_procedure",
      messages: [{ role: "user" as const, content: `记一下：处理 memory-xx 召回异常 ${m} 时，先查 health snapshot，再查 Qdrant/PG reconcile，最后看 cache invalidation。` }],
    },
    {
      type: "durable_project_decision",
      messages: [{ role: "user" as const, content: `请记住：memory-xx 项目决策 ${m} 是 update apply 只允许隔离 scope，真实长期 scope 继续 dry-run。` }],
    },
    {
      type: "durable_project_constraint",
      messages: [{ role: "user" as const, content: `记住：memory-xx 约束 ${m} 是任何 secret、credential 或 PII 都不能静默批准。` }],
    },
    {
      type: "durable_graph_fact",
      messages: [{ role: "user" as const, content: `请记住：图关系 ${m} 必须带 source evidence、entity path 和 relation path，缺证据时进入人工复核。` }],
    },
  ];
  const blocked = [
    {
      type: "question_only",
      messages: [{ role: "user" as const, content: `现在这个 memory-xx 审批问题 ${m} 应该怎么判断才合理？` }],
    },
    {
      type: "temporary_instruction",
      messages: [{ role: "user" as const, content: `这次临时先用 ${m} 这个端口，等会儿就删掉，不要作为长期记忆。` }],
    },
    {
      type: "low_value_continuation",
      messages: [{ role: "user" as const, content: `继续 ${m}` }],
    },
    {
      type: "secret_like",
      messages: [{ role: "user" as const, content: `请记住这个临时 token sk_${m}_1234567890abcdefghijklmnop，后面调用服务用。` }],
    },
    {
      type: "update_conflict",
      messages: [{ role: "user" as const, content: `我之前说 memory-xx ${m} 使用策略 A，现在改成策略 B，旧说法不要再用了。` }],
    },
  ];
  if (index % 5 < 2) {
    const item = durable[index % durable.length]!;
    return { index, type: item.type, expect: "may_approve", messages: item.messages };
  }
  const item = blocked[index % blocked.length]!;
  return { index, type: item.type, expect: "must_not_approve", messages: item.messages };
}

async function withTemporaryCanaryScope(scopeKey: string, fn: () => Promise<void>): Promise<void> {
  const runtimeDir = process.env.MEMORY_XX_RUNTIME_DIR?.trim() || join(process.cwd(), ".runtime");
  const file = join(runtimeDir, "auto-approval-canary.json");
  const hadOriginal = existsSync(file);
  const original = hadOriginal ? await readFile(file, "utf8") : "";
  let next: Record<string, unknown> = { enabled: true, bypass_scopes: [scopeKey], agents: ["codex"] };
  try {
    if (hadOriginal) {
      const parsed = JSON.parse(original) as Record<string, unknown>;
      const scopes = Array.isArray(parsed.bypass_scopes) ? parsed.bypass_scopes.filter((item): item is string => typeof item === "string") : [];
      const agents = Array.isArray(parsed.agents) ? parsed.agents.filter((item): item is string => typeof item === "string") : [];
      next = {
        ...parsed,
        enabled: true,
        bypass_scopes: [...new Set([...scopes, scopeKey])],
        agents: [...new Set([...agents, "codex"])],
      };
    }
  } catch {
    next = { enabled: true, bypass_scopes: [scopeKey], agents: ["codex"] };
  }
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  try {
    await fn();
  } finally {
    if (hadOriginal) await writeFile(file, original, "utf8");
    else await rm(file, { force: true });
  }
}

async function ensureGrant(pool: Pool, schema: string, scopeId: string): Promise<void> {
  await pool.query(`
    INSERT INTO ${schema}.trusted_agent_scope_grants (
      id, agent_id, scope_type, scope_id, permissions, expires_at, created_by
    )
    VALUES ($1, 'codex', 'project', $2, ARRAY['memory:read','memory:write'], now() + interval '1 day', 'llm_conversation_simulation')
    ON CONFLICT DO NOTHING
  `, [randomUUID(), scopeId]);
}

async function fetchMemoryRows(pool: Pool, schema: string, ids: readonly string[]): Promise<Array<Record<string, unknown>>> {
  if (ids.length === 0) return [];
  const rows = await pool.query(`
    SELECT id, lifecycle_status, review_state, is_current, scope_type, scope_id, title, content, metadata
    FROM ${schema}.memory_records
    WHERE id = ANY($1::text[])
  `, [ids]);
  return rows.rows;
}

async function cleanupRun(pool: Pool, schema: string, runId: string, memoryIds: readonly string[]): Promise<void> {
  for (const memoryId of memoryIds) {
    await httpPost(apiUrl("/api/memory/xx/unified/forget"), {
      memory_id: memoryId,
      agent_id: "llm-conversation-simulation",
      mode: "tombstone",
    }, { token: config.wrapperToken, timeout: 30_000 }).catch(() => undefined);
  }
  await pool.query(`
    UPDATE ${schema}.memory_records
    SET lifecycle_status = 'tombstone', is_current = false, updated_at = now()
    WHERE metadata->>'llm_simulation_run_id' = $1
      AND lifecycle_status <> 'tombstone'
  `, [runId]).catch(() => undefined);
  await pool.query(`
    DELETE FROM ${schema}.conversation_batches
    WHERE metadata->>'llm_simulation_run_id' = $1
       OR conversation_id LIKE $2
  `, [runId, `llm-sim-${runId}-%`]).catch(() => undefined);
}

async function main(): Promise<void> {
  const total = casesCount();
  const runId = `llm-${Date.now().toString(36)}-${marker()}`;
  const scopeId = `llm-sim-${runId}`;
  const scopeKey = `project:${scopeId}`;
  const pgConfig = loadMemoryXXPostgresConfig(process.env);
  const schema = quoteIdent(pgConfig.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  const scenarios = Array.from({ length: total }, (_, index) => buildScenario(index, runId));
  const results: CaseResult[] = [];
  const allMemoryIds = new Set<string>();

  try {
    await ensureGrant(pool, schema, scopeId);
    await withTemporaryCanaryScope(scopeKey, async () => {
      for (const scenario of scenarios) {
        const conversationId = `llm-sim-${runId}-${scenario.index}`;
        const sessionId = `llm-sim-session-${runId}-${scenario.index}`;
        try {
          const response = await httpPost(apiUrl("/api/memory/xx/conversation/ingest"), {
            conversation_id: conversationId,
            session_id: sessionId,
            agent_id: "codex",
            source: "codex-jsonl-spool",
            scope_context: {
              project_ids: [scopeId],
              user_id: "current-instance-owner",
              workspace_id: "current-instance",
              include_global: false,
            },
            messages: scenario.messages,
            metadata: {
              llm_simulation_run_id: runId,
              llm_simulation_case_type: scenario.type,
              llm_simulation_index: scenario.index,
              memory_intent: scenario.expect === "may_approve",
            },
          }, { token: config.wrapperToken, timeout: 90_000 });
          const body = response.body as Record<string, unknown>;
          const candidateIds = readArray(body.candidate_memory_ids);
          for (const id of candidateIds) allMemoryIds.add(id);
          const rows = await fetchMemoryRows(pool, schema, candidateIds);
          const approved = rows.filter((row) => row.lifecycle_status === "approved" && row.review_state === "silent_approved");
          const pending = rows.filter((row) => row.lifecycle_status === "candidate" || row.review_state === "pending");
          const blockedReasons = rows.flatMap((row) => {
            const metadata = row.metadata as Record<string, unknown> | null;
            const policy = metadata?.auto_approval_policy as Record<string, unknown> | undefined;
            return readArray(policy?.blocked_reasons);
          });
          const noOpReasons = readArray(body.no_op_reasons);
          const violation = scenario.expect === "must_not_approve" && approved.length > 0;
          results.push({
            index: scenario.index,
            type: scenario.type,
            expect: scenario.expect,
            status: response.status,
            ok: response.status === 200 && !violation,
            candidate_memory_ids: candidateIds,
            no_op_reasons: noOpReasons,
            mem0_mode: typeof body.mem0_mode === "string" ? body.mem0_mode : null,
            mem0_success: typeof body.mem0_success === "boolean" ? body.mem0_success : null,
            fallback_used: body.fallback_used === true,
            approved_count: approved.length,
            pending_count: pending.length,
            blocked_reasons: [...new Set(blockedReasons)],
            ...(violation ? { failure: "must_not_approve_created_silent_approved_memory" } : {}),
          });
        } catch (error) {
          results.push({
            index: scenario.index,
            type: scenario.type,
            expect: scenario.expect,
            status: 0,
            ok: false,
            candidate_memory_ids: [],
            no_op_reasons: [],
            mem0_mode: null,
            mem0_success: null,
            fallback_used: false,
            approved_count: 0,
            pending_count: 0,
            blocked_reasons: [],
            failure: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    const approvedIds = results.flatMap((item) => item.approved_count > 0 ? item.candidate_memory_ids : []);
    const recallSamples: Array<Record<string, unknown>> = [];
    for (const memoryId of approvedIds.slice(0, 3)) {
      const recall = await httpPost(apiUrl("/api/memory/xx/unified/recall"), {
        query: runId,
        scope_type: "project",
        scope_id: scopeId,
        include_global: false,
        memory_ids: [memoryId],
        limit: 5,
      }, { token: config.wrapperToken, timeout: 30_000 }).catch((error) => ({ status: 0, body: { error: String(error) } }));
      recallSamples.push({ memory_id: memoryId, status: recall.status, hit: idsFromRecall(recall.body).includes(memoryId) });
    }

    await cleanupRun(pool, schema, runId, [...allMemoryIds]);
    const residue = await pool.query(`
      SELECT count(*)::int AS count
      FROM ${schema}.memory_records
      WHERE metadata->>'llm_simulation_run_id' = $1
        AND lifecycle_status <> 'tombstone'
    `, [runId]);

    const byType: Record<string, { total: number; ok: number; approved: number; pending: number; no_candidate: number }> = {};
    for (const result of results) {
      byType[result.type] ??= { total: 0, ok: 0, approved: 0, pending: 0, no_candidate: 0 };
      byType[result.type]!.total += 1;
      if (result.ok) byType[result.type]!.ok += 1;
      byType[result.type]!.approved += result.approved_count;
      byType[result.type]!.pending += result.pending_count;
      if (result.candidate_memory_ids.length === 0) byType[result.type]!.no_candidate += 1;
    }
    const report = {
      ok: results.every((item) => item.ok) && Number(residue.rows[0]?.count ?? 0) === 0,
      run_id: runId,
      scope: scopeKey,
      total,
      passed: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      approved_total: results.reduce((sum, item) => sum + item.approved_count, 0),
      pending_total: results.reduce((sum, item) => sum + item.pending_count, 0),
      no_candidate_total: results.filter((item) => item.candidate_memory_ids.length === 0).length,
      mem0_success_total: results.filter((item) => item.mem0_success === true).length,
      fallback_total: results.filter((item) => item.fallback_used).length,
      cleanup: { non_tombstone_residue: Number(residue.rows[0]?.count ?? 0) || 0 },
      recall_samples: recallSamples,
      by_type: byType,
      results,
    };
    const reportDir = join(process.cwd(), "reports", "auto-approval-llm-conversation-simulation");
    await mkdir(reportDir, { recursive: true });
    const reportPath = join(reportDir, `auto-approval-llm-conversation-simulation-${runId}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ...report, report_path: reportPath }, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    await cleanupRun(pool, schema, runId, [...allMemoryIds]).catch(() => undefined);
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

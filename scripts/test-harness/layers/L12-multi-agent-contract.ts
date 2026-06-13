import { randomBytes, randomUUID, createHash } from "node:crypto";
import { config } from "../config.js";
import { createPool, query, closePool } from "../lib/db-helpers.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import { createEmptyReport, finalizeReport, type CheckResult } from "../report-model.js";
import { createLogger } from "../../../app/shared/logger";

const log = createLogger("L12");
const runId = generateRunId();
const report = createEmptyReport("L12", runId);
const BASE_URL = process.env.MEMORY_XX_TEST_URL || config.wrapperUrl;
const createdMemoryIds: string[] = [];
const registeredAgentIds: string[] = [];

interface AgentTokens {
  readonly agentAId: string;
  readonly agentBId: string;
  readonly agentCId: string;
  readonly agentA: string;
  readonly agentB: string;
  readonly agentC: string;
}

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(value)) throw new Error(`Unsafe schema identifier: ${value}`);
  return `"${value}"`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newAgentToken(): string {
  return `l12_${randomBytes(24).toString("base64url")}`;
}

async function post(path: string, body: Record<string, unknown>, token: string) {
  const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${token}` };
  const resp = await fetch(BASE_URL + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: resp.status, data: await resp.json() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : severity === "warning" ? "WARN" : "FAIL";
  console.log(`  [${icon}] ${name}: ${scrubSecrets(detail)}`);
}

async function registerHarnessAgent(agentId: string, token: string, projectScopeIds: readonly string[]): Promise<void> {
  const pool = createPool();
  const schema = quoteIdent(config.dbSchema);
  const permissions = [
    "memory:read",
    "memory:write",
    "memory:feedback",
    "memory:governance_apply",
    "memory:governance_revert",
  ];
  try {
    await query(pool, `UPDATE ${schema}.trusted_agents SET revoked_at = now(), updated_at = now() WHERE agent_id = $1 AND revoked_at IS NULL`, [agentId]);
    await query(pool, `UPDATE ${schema}.trusted_agent_scope_grants SET revoked_at = now(), updated_at = now() WHERE agent_id = $1 AND revoked_at IS NULL`, [agentId]);
    await query(pool, `
      INSERT INTO ${schema}.trusted_agents (id, token_hash, agent_id, permissions, expires_at)
      VALUES ($1, $2, $3, $4, now() + interval '2 hours')
    `, [randomUUID(), hashToken(token), agentId, permissions]);

    for (const scopeId of projectScopeIds) {
      await query(pool, `
        INSERT INTO ${schema}.trusted_agent_scope_grants (
          id, agent_id, scope_type, scope_id, permissions, expires_at, created_by
        )
        VALUES ($1, $2, 'project', $3, $4, now() + interval '2 hours', 'l12-multi-agent-contract')
      `, [randomUUID(), agentId, scopeId, permissions]);
    }
    await query(pool, `
      INSERT INTO ${schema}.trusted_agent_scope_grants (
        id, agent_id, scope_type, scope_id, permissions, expires_at, created_by
      )
      VALUES ($1, $2, 'global', 'global', $3, now() + interval '2 hours', 'l12-multi-agent-contract')
    `, [randomUUID(), agentId, ["memory:read"]]);
    registeredAgentIds.push(agentId);
  } finally {
    await closePool(pool);
  }
}

async function registerHarnessAgents(sharedProjectScopeId: string, isolatedProjectScopeId: string): Promise<AgentTokens> {
  const suffix = runId.toLowerCase().replace(/[^a-z0-9._-]/gu, "-").slice(0, 24);
  const agentAId = `l12-agent-a-${suffix}`;
  const agentBId = `l12-agent-b-${suffix}`;
  const agentCId = `l12-agent-c-${suffix}`;
  const agentTokens = {
    agentAId,
    agentBId,
    agentCId,
    agentA: newAgentToken(),
    agentB: newAgentToken(),
    agentC: newAgentToken(),
  };
  await registerHarnessAgent(agentAId, agentTokens.agentA, [sharedProjectScopeId]);
  await registerHarnessAgent(agentBId, agentTokens.agentB, [sharedProjectScopeId]);
  await registerHarnessAgent(agentCId, agentTokens.agentC, [sharedProjectScopeId, isolatedProjectScopeId]);
  return agentTokens;
}

async function revokeHarnessAgents(): Promise<void> {
  if (registeredAgentIds.length === 0) return;
  const pool = createPool();
  const schema = quoteIdent(config.dbSchema);
  try {
    await query(pool, `UPDATE ${schema}.trusted_agents SET revoked_at = now(), updated_at = now() WHERE agent_id = ANY($1::text[]) AND revoked_at IS NULL`, [registeredAgentIds]);
    await query(pool, `UPDATE ${schema}.trusted_agent_scope_grants SET revoked_at = now(), updated_at = now() WHERE agent_id = ANY($1::text[]) AND revoked_at IS NULL`, [registeredAgentIds]);
    report.cleanup.resources_cleaned.push(...registeredAgentIds.map((agentId) => `agent:${agentId}`));
  } catch (err) {
    report.cleanup.failed.push(`agent-revoke: ${(err as Error).message}`);
  } finally {
    await closePool(pool);
  }
}

async function remember(agentId: string, userId: string, scopeId: string, content: string, token: string) {
  const { status, data } = await post("/api/memory/xx/unified/remember", {
    user_id: userId,
    agent_id: agentId,
    scope_id: scopeId,
    content,
    metadata: { source: "memory-xx-test", run_id: runId },
  }, token);
  if (data.memoryId) createdMemoryIds.push(data.memoryId);
  return { status, data };
}

async function approve(memoryId: string, actorId: string, token: string) {
  return await post(`/api/memory/xx/review/memories/${encodeURIComponent(memoryId)}/approve`, {
    requestId: `${runId}:approve:${memoryId}`,
    actorId,
  }, token);
}

async function cleanup(agentTokens?: AgentTokens) {
  report.cleanup.performed = true;
  for (const memoryId of createdMemoryIds) {
    try {
      const { status } = await post(
        "/api/memory/xx/unified/forget",
        { memory_id: memoryId, agent_id: agentTokens?.agentAId ?? "l12-multi-agent-contract", mode: "tombstone" },
        agentTokens?.agentA ?? config.wrapperToken,
      );
      if (status >= 200 && status < 300) report.cleanup.resources_cleaned.push(memoryId);
      else report.cleanup.failed.push(`${memoryId}: status=${status}`);
    } catch (err) {
      report.cleanup.failed.push(`${memoryId}: ${(err as Error).message}`);
    }
  }
  await revokeHarnessAgents();
  check("cleanup:test-memories", report.cleanup.failed.length === 0, `cleaned=${report.cleanup.resources_cleaned.length}, failed=${report.cleanup.failed.length}`);
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  L12 Multi-Agent Contract — run_id: ${runId}`);
  console.log(`${"=".repeat(50)}\n`);

  const sharedProjectScopeId = `project-shared-${runId}`;
  const isolatedProjectScopeId = `project-isolated-${runId}`;
  let agentTokens: AgentTokens | undefined;
  let agentAMemoryId = "";
  let agentBMemoryId = "";
  try {
    agentTokens = await registerHarnessAgents(sharedProjectScopeId, isolatedProjectScopeId);
    const distinctTokenCount = new Set([agentTokens.agentA, agentTokens.agentB, agentTokens.agentC]).size;
    check("agents:register-distinct-tokens",
      distinctTokenCount === 3,
      `registered=${registeredAgentIds.length}, distinct_tokens=${distinctTokenCount}`);
  } catch (err) { check("agents:register-distinct-tokens", false, (err as Error).message); }

  try {
    const { status, data } = await remember(agentTokens?.agentAId ?? "agent-a", "user-a", sharedProjectScopeId, `Agent A shared project L12 test ${runId}`, agentTokens?.agentA ?? "");
    agentAMemoryId = typeof data.memoryId === "string" ? data.memoryId : "";
    check("agent-a:remember-shared", status === 201 && data.memoryId !== undefined, `status=${status}, memoryId=${data.memoryId ?? "missing"}`);
  } catch (err) { check("agent-a:remember-shared", false, (err as Error).message); }

  try {
    if (!agentAMemoryId) {
      check("agent-a:approve", false, "agent-a memory id missing");
    } else {
      const { status, data } = await approve(agentAMemoryId, agentTokens?.agentAId ?? "l12-agent-a-reviewer", agentTokens?.agentA ?? "");
      check("agent-a:approve", status === 200 && data.memoryId === agentAMemoryId && data.lifecycleStatus === "approved", `status=${status}, memoryId=${agentAMemoryId}`);
    }
  } catch (err) { check("agent-a:approve", false, (err as Error).message); }

  try {
    const { status, data } = await remember(agentTokens?.agentBId ?? "agent-b", "user-b", sharedProjectScopeId, `Agent B shared project L12 test ${runId}`, agentTokens?.agentB ?? "");
    agentBMemoryId = typeof data.memoryId === "string" ? data.memoryId : "";
    check("agent-b:remember-shared", status === 201 && data.memoryId !== undefined, `status=${status}, memoryId=${data.memoryId ?? "missing"}`);
  } catch (err) { check("agent-b:remember-shared", false, (err as Error).message); }

  try {
    if (!agentBMemoryId) {
      check("agent-b:approve", false, "agent-b memory id missing");
    } else {
      const { status, data } = await approve(agentBMemoryId, agentTokens?.agentBId ?? "l12-agent-b-reviewer", agentTokens?.agentB ?? "");
      check("agent-b:approve", status === 200 && data.memoryId === agentBMemoryId && data.lifecycleStatus === "approved", `status=${status}, memoryId=${agentBMemoryId}`);
    }
  } catch (err) { check("agent-b:approve", false, (err as Error).message); }

  try {
    const { status } = await post("/api/memory/xx/unified/forget", { agent_id: agentTokens?.agentCId ?? "test" }, agentTokens?.agentC ?? "");
    check("unified:forget-required-memory-id", status === 400, `status=${status}`);
  } catch (err) { check("unified:forget-required-memory-id", false, (err as Error).message); }

  try {
    const { status, data } = await post("/api/memory/xx/unified/audit", {}, agentTokens?.agentC ?? "");
    check("unified:audit", status === 200 && data.ok !== undefined, `status=${status}, ok=${data.ok}`);
  } catch (err) { check("unified:audit", false, (err as Error).message); }

  try {
    let finalStatus = 0;
    let finalData: any = {};
    let finalMemoryIds: string[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const { status, data } = await post("/api/memory/xx/unified/reflect", {
        agent_id: agentTokens?.agentCId ?? "agent-c",
        run_id: runId,
        query: `shared project L12 test ${runId}`,
        scope_type: "project",
        scope_id: sharedProjectScopeId,
        memory_ids: [agentAMemoryId, agentBMemoryId].filter(Boolean),
        limit: 5
      }, agentTokens?.agentC ?? "");
      finalStatus = status;
      finalData = data;
      finalMemoryIds = Array.isArray(data.recall?.memory_ids) ? data.recall.memory_ids : [];
      if (status === 200 && data.ok === true && Boolean(data.audit) && finalMemoryIds.includes(agentAMemoryId) && finalMemoryIds.includes(agentBMemoryId)) break;
      await sleep(1000);
    }
    const reflectOk = finalStatus === 200 && finalData.ok === true && finalData.message === undefined && Boolean(finalData.audit) && finalMemoryIds.includes(agentAMemoryId) && finalMemoryIds.includes(agentBMemoryId);
    check("agent-c:reflect-shared-project", reflectOk, `status=${finalStatus}, ok=${finalData.ok}, recall=${finalData.recall?.count ?? "missing"}`);
  } catch (err) { check("agent-c:reflect-shared-project", false, (err as Error).message); }

  try {
    let finalStatus = 0;
    let finalData: any = {};
    let isolatedMemoryIds: string[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const { status, data } = await post("/api/memory/xx/unified/reflect", {
        agent_id: agentTokens?.agentCId ?? "agent-c",
        run_id: runId,
        query: `Agent B shared project L12 test ${runId}`,
        scope_type: "project",
        scope_id: isolatedProjectScopeId,
        limit: 5
      }, agentTokens?.agentC ?? "");
      finalStatus = status;
      finalData = data;
      isolatedMemoryIds = Array.isArray(data.recall?.memory_ids) ? data.recall.memory_ids : [];
      if (status === 200 && data.ok === true && Boolean(data.audit) && !isolatedMemoryIds.includes(agentBMemoryId)) break;
      await sleep(1000);
    }
    const isolationOk = finalStatus === 200 && finalData.ok === true && Boolean(finalData.audit) && !isolatedMemoryIds.includes(agentBMemoryId);
    check("agent-c:reflect-isolated-project", isolationOk, `status=${finalStatus}, ok=${finalData.ok}, returned=${isolatedMemoryIds.length}`);
  } catch (err) { check("agent-c:reflect-isolated-project", false, (err as Error).message); }

  await cleanup(agentTokens);
  finalizeReport(report);
  log.info("Results", { passed: report.checks.filter(c => c.passed).length, failed: report.checks.filter(c => !c.passed).length, total: report.checks.length });
  console.log(`@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);
  process.exit(report.ok ? 0 : 1);
}

main().catch(async (err) => { check("fatal", false, err.message); await cleanup(); finalizeReport(report); console.log(`@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`); process.exit(1); });

import { config } from "../config.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import { createEmptyReport, finalizeReport, type CheckResult } from "../report-model.js";
import { createLogger } from "../../../app/shared/logger";

const log = createLogger("L12");
const runId = generateRunId();
const report = createEmptyReport("L12", runId);
const BASE_URL = process.env.MEMORY_V2_TEST_URL || config.wrapperUrl;
const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + config.wrapperToken };
const createdMemoryIds: string[] = [];

async function post(path: string, body: Record<string, unknown>) {
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

async function remember(agentId: string, userId: string, scopeId: string, content: string) {
  const { status, data } = await post("/api/memory/v2/unified/remember", {
    user_id: userId,
    agent_id: agentId,
    scope_id: scopeId,
    content,
    metadata: { source: "memory-xx-test", run_id: runId },
  });
  if (data.memoryId) createdMemoryIds.push(data.memoryId);
  return { status, data };
}

async function approve(memoryId: string, actorId: string) {
  return await post(`/api/memory/v2/review/memories/${encodeURIComponent(memoryId)}/approve`, {
    requestId: `${runId}:approve:${memoryId}`,
    actorId,
  });
}

async function cleanup() {
  report.cleanup.performed = true;
  for (const memoryId of createdMemoryIds) {
    try {
      const { status } = await post("/api/memory/v2/unified/forget", { memory_id: memoryId, agent_id: "l12-multi-agent-contract", mode: "tombstone" });
      if (status >= 200 && status < 300) report.cleanup.resources_cleaned.push(memoryId);
      else report.cleanup.failed.push(`${memoryId}: status=${status}`);
    } catch (err) {
      report.cleanup.failed.push(`${memoryId}: ${(err as Error).message}`);
    }
  }
  check("cleanup:test-memories", report.cleanup.failed.length === 0, `cleaned=${report.cleanup.resources_cleaned.length}, failed=${report.cleanup.failed.length}`);
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  L12 Multi-Agent Contract — run_id: ${runId}`);
  console.log(`${"=".repeat(50)}\n`);

  let agentAMemoryId = "";
  try {
    const { status, data } = await remember("agent-a", "user-a", `project-x-${runId}`, `Agent A L12 test ${runId}`);
    agentAMemoryId = typeof data.memoryId === "string" ? data.memoryId : "";
    check("agent-a:remember", status === 201 && data.memoryId !== undefined, `status=${status}, memoryId=${data.memoryId ?? "missing"}`);
  } catch (err) { check("agent-a:remember", false, (err as Error).message); }

  try {
    if (!agentAMemoryId) {
      check("agent-a:approve", false, "agent-a memory id missing");
    } else {
      const { status, data } = await approve(agentAMemoryId, "l12-agent-a-reviewer");
      check("agent-a:approve", status === 200 && data.memoryId === agentAMemoryId && data.lifecycleStatus === "approved", `status=${status}, memoryId=${agentAMemoryId}`);
    }
  } catch (err) { check("agent-a:approve", false, (err as Error).message); }

  try {
    const { status, data } = await remember("agent-b", "user-b", `project-y-${runId}`, `Agent B L12 test ${runId}`);
    check("agent-b:remember", status === 201 && data.memoryId !== undefined, `status=${status}, memoryId=${data.memoryId ?? "missing"}`);
  } catch (err) { check("agent-b:remember", false, (err as Error).message); }

  try {
    const { status } = await post("/api/memory/v2/unified/forget", { agent_id: "test" });
    check("unified:forget-required-memory-id", status === 400, `status=${status}`);
  } catch (err) { check("unified:forget-required-memory-id", false, (err as Error).message); }

  try {
    const { status, data } = await post("/api/memory/v2/unified/audit", {});
    check("unified:audit", status === 200 && data.ok !== undefined, `status=${status}, ok=${data.ok}`);
  } catch (err) { check("unified:audit", false, (err as Error).message); }

  try {
    let finalStatus = 0;
    let finalData: any = {};
    let finalMemoryIds: string[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const { status, data } = await post("/api/memory/v2/unified/reflect", {
        agent_id: "l12-agent",
        run_id: runId,
        query: `Agent A L12 test ${runId}`,
        scope_type: "project",
        scope_id: `project-x-${runId}`,
        memory_ids: agentAMemoryId ? [agentAMemoryId] : undefined,
        limit: 3
      });
      finalStatus = status;
      finalData = data;
      finalMemoryIds = Array.isArray(data.recall?.memory_ids) ? data.recall.memory_ids : [];
      if (status === 200 && data.ok === true && Boolean(data.audit) && finalMemoryIds.includes(agentAMemoryId)) break;
      await sleep(1000);
    }
    const reflectOk = finalStatus === 200 && finalData.ok === true && finalData.message === undefined && Boolean(finalData.audit) && finalMemoryIds.includes(agentAMemoryId);
    check("unified:reflect", reflectOk, `status=${finalStatus}, ok=${finalData.ok}, recall=${finalData.recall?.count ?? "missing"}`);
  } catch (err) { check("unified:reflect", false, (err as Error).message); }

  await cleanup();
  finalizeReport(report);
  log.info("Results", { passed: report.checks.filter(c => c.passed).length, failed: report.checks.filter(c => !c.passed).length, total: report.checks.length });
  console.log(`@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);
  process.exit(report.ok ? 0 : 1);
}

main().catch(async (err) => { check("fatal", false, err.message); await cleanup(); finalizeReport(report); console.log(`@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`); process.exit(1); });

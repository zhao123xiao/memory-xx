import { randomUUID } from "node:crypto";

import { config } from "./config";
import { scrubSecrets } from "./lib/secret-scrubber";

type Severity = "critical" | "warning" | "info";

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
  readonly severity: Severity;
}

const runId = randomUUID().slice(0, 8);
const baseUrl = process.env.MEMORY_V2_TEST_URL || config.wrapperUrl;
const token = config.wrapperToken;
const scopeId = `real-user-${runId}`;
const userId = "real-user-local";
const agentId = "real-user-perspective-test";
const checks: Check[] = [];
const createdMemoryIds: string[] = [];

function check(name: string, passed: boolean, detail: string, severity: Severity = "critical"): void {
  checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : severity === "warning" ? "WARN" : "FAIL";
  process.stdout.write(`  [${icon}] ${name}: ${scrubSecrets(detail)}\n`);
}

async function post(
  path: string,
  body: Record<string, unknown>,
  authToken: string = token,
  timeoutMs = 30_000
): Promise<{ status: number; data: any; ms: number }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const start = Date.now();
  const resp = await fetch(baseUrl + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: resp.status, data, ms: Date.now() - start };
}

async function get(path: string, authToken: string = token): Promise<{ status: number; data: any; text: string; ms: number }> {
  const headers: Record<string, string> = {};
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const start = Date.now();
  const resp = await fetch(baseUrl + path, { headers, signal: AbortSignal.timeout(15_000) });
  const text = await resp.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: resp.status, data, text, ms: Date.now() - start };
}

async function mcpTool(name: string, args: Record<string, unknown>): Promise<{ status: number; parsed: any; ms: number }> {
  const resp = await post(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1_000_000),
      method: "tools/call",
      params: { name, arguments: args },
    },
    token,
    45_000
  );
  const text = resp.data?.result?.content?.[0]?.text;
  let parsed: any = null;
  try {
    parsed = typeof text === "string" ? JSON.parse(text) : null;
  } catch {
    parsed = { text };
  }
  return { status: resp.status, parsed, ms: resp.ms };
}

function memoryIdsFromRecall(data: any): string[] {
  const results = data?.results || data?.recall?.results || data?.memories || [];
  return Array.isArray(results)
    ? results.map((item: any) => item.memory_id || item.memoryId || item.id).filter(Boolean)
    : [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanup(): Promise<void> {
  for (const memoryId of createdMemoryIds) {
    try {
      const resp = await post(
        "/api/memory/v2/unified/forget",
        { memory_id: memoryId, agent_id: agentId, mode: "tombstone" },
        token,
        30_000
      );
      check(`cleanup:${memoryId}`, resp.status >= 200 && resp.status < 300, `status=${resp.status}`, "warning");
    } catch (error) {
      check(`cleanup:${memoryId}`, false, error instanceof Error ? error.message : String(error), "warning");
    }
  }
}

async function waitForCleanupInvisible(timeoutMs = 10_000): Promise<{ status: number; ids: string[]; attempts: number }> {
  const started = Date.now();
  let attempts = 0;
  let lastStatus = 0;
  let lastIds: string[] = [];
  while (Date.now() - started <= timeoutMs) {
    attempts += 1;
    const verify = await post(
      "/api/memory/v2/recall/query",
      { query: runId, scope_context: { project_ids: [scopeId], include_global: false }, limit: 10 },
      token,
      30_000
    );
    lastStatus = verify.status;
    lastIds = memoryIdsFromRecall(verify.data);
    if (createdMemoryIds.every((id) => !lastIds.includes(id))) {
      return { status: lastStatus, ids: lastIds, attempts };
    }
    await sleep(1_000);
  }
  return { status: lastStatus, ids: lastIds, attempts };
}

async function main(): Promise<void> {
  process.stdout.write(`\n${"=".repeat(60)}\n`);
  process.stdout.write(`  User Perspective Smoke — run_id: ${runId}\n`);
  process.stdout.write(`  Scope: ${scopeId}\n`);
  process.stdout.write(`${"=".repeat(60)}\n\n`);

  try {
    const health = await get("/health");
    check("user:authenticated-health", health.status === 200, `status=${health.status}, runtime=${health.data?.runtime_initialised}`);

    const noAuthWrite = await post(
      "/api/memory/v2/unified/remember",
      { user_id: userId, agent_id: agentId, scope_id: scopeId, content: "no auth should fail" },
      ""
    );
    check("user:no-token-write-rejected", noAuthWrite.status === 401, `status=${noAuthWrite.status}`);

    const marker = `真实用户视角标记 ${runId}`;
    const conversationMarker = `真实 Codex 对话监听标记 ${runId}`;
    const conversation = await post("/api/memory/v2/conversation/ingest", {
      conversation_id: `user-perspective-codex-${runId}`,
      session_id: `user-perspective-session-${runId}`,
      agent_id: "codex",
      source: "user-perspective-codex-simulation",
      scope_context: { project_ids: [scopeId], user_id: userId, workspace_id: "current-instance" },
      messages: [
        { role: "user", content: `请记住：Codex 自动监听测试要求候选先进入 pending 审批。${conversationMarker}` },
        { role: "assistant", content: "我会通过 conversation ingest 生成待审批候选，不会自动批准。" },
      ],
      metadata: { source_test: "user-perspective-conversation", run_id: runId },
    }, token, 60_000);
    const conversationMemoryId = Array.isArray(conversation.data?.candidate_memory_ids) ? conversation.data.candidate_memory_ids[0] : "";
    if (conversationMemoryId) createdMemoryIds.push(conversationMemoryId);
    check(
      "user:conversation-ingest-pending",
      conversation.status === 200 && conversation.data?.mem0_mode === "official" && Boolean(conversationMemoryId),
      `status=${conversation.status}, mem0=${conversation.data?.mem0_mode || "n/a"}, memoryId=${conversationMemoryId || "missing"}`
    );
    if (conversationMemoryId) {
      const approveConversation = await post(
        `/api/memory/v2/review/memories/${encodeURIComponent(conversationMemoryId)}/approve`,
        { requestId: `${runId}:conversation-approve`, actorId: agentId },
        token,
        30_000
      );
      check("user:conversation-approve", approveConversation.status === 200, `status=${approveConversation.status}`);
      let conversationFound = false;
      let conversationIds: string[] = [];
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        const recallConversation = await post(
          "/api/memory/v2/unified/recall",
          {
            agent_id: agentId,
            query: `Codex 自动监听 pending 审批 ${conversationMarker}`,
            scope_type: "project",
            scope_id: scopeId,
            scope_context: { project_ids: [scopeId], include_global: false },
            limit: 5,
          },
          token,
          45_000
        );
        conversationIds = memoryIdsFromRecall(recallConversation.data);
        conversationFound = conversationIds.includes(conversationMemoryId);
        if (conversationFound) break;
        await sleep(2_000);
      }
      check("user:conversation-recall", conversationFound, `ids=${conversationIds.join(",")}`);
    }
    const preference = `请记住：以后汇报 memory-xx 测试结果时，先给结论，再列证据、报告路径和失败根因；不要只说测试通过。${marker}`;
    const remember = await post("/api/memory/v2/unified/remember", {
      user_id: userId,
      agent_id: agentId,
      scope_id: scopeId,
      content: preference,
      metadata: { source: "real-user-perspective-test", run_id: runId, user_story: "reporting-preference" },
    });
    const memoryId = remember.data?.memoryId || remember.data?.memory_id;
    if (memoryId) createdMemoryIds.push(memoryId);
    check(
      "user:remember-preference",
      remember.status === 201 && Boolean(memoryId),
      `status=${remember.status}, memoryId=${memoryId || "missing"}, latency=${remember.ms}ms`
    );

    if (memoryId) {
      const approve = await post(
        `/api/memory/v2/review/memories/${encodeURIComponent(memoryId)}/approve`,
        { requestId: `${runId}:approve`, actorId: agentId },
        token,
        30_000
      );
      check(
        "user:approve-visible-memory",
        approve.status === 200,
        `status=${approve.status}, lifecycle=${approve.data?.lifecycleStatus || approve.data?.lifecycle_status || "n/a"}`,
        approve.status === 200 ? "critical" : "warning"
      );

      let found = false;
      let lastIds: string[] = [];
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        const recall = await post(
          "/api/memory/v2/recall/query",
          {
            query: `memory-xx 测试结果 汇报方式 ${marker}`,
            scope_context: { user_id: userId, workspace_id: scopeId, project_ids: [scopeId], include_global: false },
            limit: 5,
            explain: true,
          },
          token,
          45_000
        );
        lastIds = memoryIdsFromRecall(recall.data);
        found = lastIds.includes(memoryId);
        if (found) {
          check("user:recall-preference", true, `attempt=${attempt}, hits=${lastIds.length}, latency=${recall.ms}ms`);
          break;
        }
        await sleep(2_000);
      }
      if (!found) {
        check("user:recall-preference", false, `attempts=8, ids=${lastIds.join(",")}`);
      }

      const feedback = await post("/api/memory/v2/unified/feedback", {
        memory_id: memoryId,
        feedback_type: "confirmed",
        agent_id: agentId,
        reason: "真实用户视角测试：召回内容符合预期",
        metadata: { source: "real-user-perspective-test", run_id: runId },
      });
      check(
        "user:confirm-feedback",
        feedback.status === 200 && feedback.data?.ok === true && Boolean(feedback.data?.feedback_event?.id),
        `status=${feedback.status}, event=${feedback.data?.feedback_event?.id || "missing"}, generation=${feedback.data?.scope_generation?.generation ?? "n/a"}`
      );
    }

    const knowledgeOff = await post("/api/memory/v2/unified/recall", {
      agent_id: agentId,
      query: "sandbox 文档 memory-xx",
      scope_type: "project",
      scope_id: scopeId,
      include_knowledge: false,
      limit: 5,
    });
    const offHasKnowledge = Boolean(knowledgeOff.data?.knowledge_results || knowledgeOff.data?.knowledge?.results);
    check("user:knowledge-default-off", knowledgeOff.status === 200 && !offHasKnowledge, `status=${knowledgeOff.status}, knowledge=${offHasKnowledge}`);

    const knowledgeOn = await post("/api/memory/v2/unified/recall", {
      agent_id: agentId,
      query: "sandbox 文档 memory-xx",
      scope_type: "project",
      scope_id: scopeId,
      include_knowledge: true,
      limit: 5,
    });
    const knowledgeCount = knowledgeOn.data?.knowledge_results?.length ?? knowledgeOn.data?.knowledge?.results?.length ?? 0;
    check(
      "user:knowledge-opt-in",
      knowledgeOn.status === 200,
      `status=${knowledgeOn.status}, knowledge_count=${knowledgeCount}, included=${knowledgeOn.data?.knowledge_included ?? "n/a"}`
    );

    const tools = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, token, 30_000);
    const toolNames = tools.data?.result?.tools?.map((tool: any) => tool.name) || [];
    check(
      "user:mcp-tools-visible",
      tools.status === 200 && toolNames.includes("smart_write_memory") && toolNames.includes("recall_memory"),
      `status=${tools.status}, tools=${toolNames.length}`
    );

    if (createdMemoryIds[0]) {
      const mcpRecall = await mcpTool("recall_memory", {
        query: `汇报方式 ${runId}`,
        project_ids: [scopeId],
        memory_ids: [createdMemoryIds[0]],
        limit: 5,
      });
      const mcpIds = memoryIdsFromRecall(mcpRecall.parsed || {});
      check(
        "user:mcp-recall-specific-memory",
        mcpRecall.status === 200 && mcpIds.includes(createdMemoryIds[0]),
        `status=${mcpRecall.status}, ids=${mcpIds.join(",")}`,
        "warning"
      );
    }
  } finally {
    await cleanup();
    if (createdMemoryIds.length > 0) {
      const verify = await waitForCleanupInvisible();
      check(
        "user:cleanup-recall-invisible",
        createdMemoryIds.every((id) => !verify.ids.includes(id)),
        `status=${verify.status}, attempts=${verify.attempts}, remaining_ids=${verify.ids.join(",")}`,
        "warning"
      );
    }
  }

  const failedCritical = checks.filter((item) => !item.passed && item.severity === "critical");
  const failedWarning = checks.filter((item) => !item.passed && item.severity !== "critical");
  const summary = {
    ok: failedCritical.length === 0,
    run_id: runId,
    scope_id: scopeId,
    checks_total: checks.length,
    checks_passed: checks.filter((item) => item.passed).length,
    failed_critical: failedCritical,
    failed_warning: failedWarning,
    created_memory_ids: createdMemoryIds,
  };
  process.stdout.write(`\n@@USER_PERSPECTIVE_REPORT@@${JSON.stringify(summary, null, 2)}@@END_REPORT@@\n`);
  process.exit(summary.ok ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

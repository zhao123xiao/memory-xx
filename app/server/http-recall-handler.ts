import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { RecallFeedbackRepository } from "../db/repositories/recall-feedback-repository";
import { FilterMode, type JsonObject } from "../shared";
import type { RecallRequest, RecallResponse } from "../recall/types";
import { parseJsonBody } from "./body";
import { tryExecuteFastpathRecall } from "./fastpath-client";
import { getDeps, type HandlerDeps } from "./http-handler-deps";
import { hasLongTermRecallScope } from "./http-handler-parsing";
import { buildRecallRequestFromBody } from "./http-request-builders";
import { validateRecallBody } from "./input-validation";
import { enforceScopePermission, scopeRefsFromScopeContext } from "./scope-enforcement";
import { createPermissionChecker } from "./permissions";

export function rejectRuntimeScopeOnlyRecall(
  res: ServerResponse,
  request: RecallRequest
): boolean {
  if (request.scope_context.runtime && !hasLongTermRecallScope(request.scope_context)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "long_term_scope_required",
      message: "运行时 scope（作用域）只表示当前执行上下文；召回时请提供 user、workspace、project、global 或 memory_ids。"
    }));
    return true;
  }
  return false;
}

export async function executeNodeRecallRequest(request: RecallRequest, handlerDeps?: Partial<HandlerDeps>): Promise<{ response: RecallResponse; extras: Record<string, unknown> }> {
  const deps = getDeps(handlerDeps);
  if (!deps.runtime) {
    throw new Error("运行时尚未初始化");
  }
  const response = await deps.runtime.orchestrator.execute(request);
  return {
    response,
    extras: {
      primary_backend: "node",
      fallback_used: false,
      memory_ids: response.results.map((item) => item.memory_id),
    },
  };
}

async function recordRecallUsage(memoryIds: readonly string[], handlerDeps?: Partial<HandlerDeps>): Promise<void> {
  const uniqueIds = [...new Set(memoryIds)].filter(Boolean);
  if (uniqueIds.length === 0) {
    return;
  }

  const deps = getDeps(handlerDeps);
  const db = deps.writeDatabase;
  if (!db) {
    return;
  }

  try {
    await db.withTransaction(async (tx) => {
      if (!("query" in tx)) {
        return;
      }
      await tx.query(
        `
          UPDATE memory_records
          SET usage_count = COALESCE(usage_count, 0) + 1,
              last_accessed_at = $2::timestamptz,
              updated_at = updated_at
          WHERE id = ANY($1::text[])
            AND is_current IS TRUE
            AND lifecycle_status = 'approved'
        `,
        [uniqueIds, new Date().toISOString()]
      );
    });
  } catch {
    // Recall must not fail only because access reinforcement failed.
  }
}

function recallQueryHash(request: RecallRequest): string {
  return createHash("sha256")
    .update(JSON.stringify({
      query: request.query.trim().toLowerCase(),
      context_queries: request.context_queries ?? [],
      current_goal: request.current_goal ?? null,
      task_id: request.task_id ?? request.scope_context.runtime?.task_id ?? null,
      scope_context: request.scope_context
    }))
    .digest("hex")
    .slice(0, 32);
}

async function attachRecallTrace(
  request: RecallRequest,
  response: RecallResponse,
  handlerDeps?: Partial<HandlerDeps>
): Promise<RecallResponse> {
  const traceId = randomUUID();
  const degradeLevel = response.degrade_level ?? response.audit.degrade_level ?? 0;
  const traced: RecallResponse = {
    ...response,
    degrade_level: degradeLevel,
    null_guard: response.null_guard ?? response.audit.null_guard ?? response.audit.confidence_gate,
    fusion: response.fusion ?? response.audit.fusion,
    query_context: response.query_context ?? response.audit.query_context,
    recall_trace_id: traceId,
    feedback_contract: response.feedback_contract ?? {
      expected_fields: ["recall_trace_id", "used_memory_ids", "agent_id"],
      validation_rules: ["trace_membership_check", "suspicious_feedback_thresholds"]
    }
  };
  traced.audit = {
    ...traced.audit,
    degrade_level: degradeLevel,
    null_guard: traced.null_guard,
    fusion: traced.fusion,
    query_context: traced.query_context,
    scope_context_source: request.debug?.scope_context_source,
    default_scope_injected: request.debug?.default_scope_injected,
  };

  const deps = getDeps(handlerDeps);
  if (!deps.writeDatabase) {
    return traced;
  }

  try {
    const repository = new RecallFeedbackRepository();
    await deps.writeDatabase.withTransaction(async (tx) => {
      await repository.addTrace(tx, {
        id: traceId,
        queryHash: recallQueryHash(request),
        queryExcerpt: request.query.replace(/\s+/g, " ").trim().slice(0, 240),
        actorId: null,
        scopeContext: request.scope_context as unknown as JsonObject,
        queryType: traced.audit.query_type,
        strategy: traced.audit.strategy,
        degradeLevel,
        results: {
          memory_ids: traced.results.map((item) => item.memory_id),
          ranked: traced.results.map((item, index) => ({
            rank: index + 1,
            memory_id: item.memory_id,
            score: item.score,
            source_retrievers: item.source_retrievers
          }))
        } as JsonObject,
        audit: {
          audit_ref: traced.audit_ref,
          degrade_level: traced.degrade_level ?? traced.audit.degrade_level ?? 0,
          fusion: traced.fusion ?? null,
          null_guard: traced.null_guard ?? null
        } as JsonObject
      });
    });
  } catch {
    // Trace persistence is diagnostic; recall must not fail because tracing failed.
  }

  return traced;
}

export async function executeRecallRequest(request: RecallRequest, handlerDeps?: Partial<HandlerDeps>): Promise<{ response: RecallResponse; extras: Record<string, unknown> }> {
  let fastpathAttempt: Awaited<ReturnType<typeof tryExecuteFastpathRecall>> | null = null;
  try {
    fastpathAttempt = await tryExecuteFastpathRecall(request);
    if (fastpathAttempt.used && fastpathAttempt.response) {
      await recordRecallUsage(fastpathAttempt.response.results.map((item) => item.memory_id), handlerDeps);
      const traced = await attachRecallTrace(request, fastpathAttempt.response, handlerDeps);
      return {
        response: traced,
        extras: {
          primary_backend: "fastpath",
          fallback_used: false,
          memory_ids: traced.results.map((item) => item.memory_id),
          fastpath_latency_ms: fastpathAttempt.latency_ms,
        },
      };
    }
  } catch (error) {
    fastpathAttempt = {
      attempted: true,
      used: false,
      reason: error instanceof Error ? error.message : "fastpath_exception",
    };
  }

  const executed = await executeNodeRecallRequest(request, handlerDeps);
  await recordRecallUsage(executed.response.results.map((item) => item.memory_id), handlerDeps);
  executed.response = await attachRecallTrace(request, executed.response, handlerDeps);
  const fallbackUsed = fastpathAttempt?.attempted === true;
  if (fallbackUsed) {
    executed.response.audit = {
      ...executed.response.audit,
      primary_backend: "node",
      fallback_used: true,
      fallback_reason: fastpathAttempt?.reason ?? "fastpath_unavailable",
      fastpath: {
        attempted: true,
        used: false,
        reason: fastpathAttempt?.reason,
        latency_ms: fastpathAttempt?.latency_ms,
      },
    };
    if (executed.response.explain) {
      executed.response.explain = {
        ...executed.response.explain,
        retrieval: {
          ...executed.response.explain.retrieval,
          rerank_backend: executed.response.audit.rerank?.backend,
          rerank_used_model: executed.response.audit.rerank?.model_used,
          rerank_reason: executed.response.audit.rerank?.reason,
          rerank_latency_ms: executed.response.audit.rerank?.latency_ms,
        },
      };
    }
  }
  return {
    response: executed.response,
    extras: {
      ...executed.extras,
      fallback_used: fallbackUsed,
      fallback_reason: fallbackUsed ? fastpathAttempt?.reason : undefined,
    },
  };
}

export async function handleRecall(req: IncomingMessage, res: ServerResponse, handlerDeps?: Partial<HandlerDeps>): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "请求方法不允许" }));
    return;
  }
  const deps = getDeps(handlerDeps);
  if (!deps.runtime) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "运行时尚未初始化" }));
    return;
  }
  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message === "body_read_timeout" ? 408 : message === "body_too_large" ? 413 : 400;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message === "body_read_timeout" ? "body_read_timeout" : "JSON 请求体无效" }));
    return;
  }
  const recallValidation = validateRecallBody(body ?? {});
  if (!recallValidation.valid) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: recallValidation.error }));
    return;
  }
  try {
    const request = buildRecallRequestFromBody((body ?? {}) as Record<string, unknown>);
    if (rejectRuntimeScopeOnlyRecall(res, request)) {
      return;
    }
    const deps = getDeps(handlerDeps);
    if (!(await enforceScopePermission(req, res, {
      permissions: deps.permissions,
      env: deps.env,
      writeDatabase: deps.writeDatabase
    }, "memory:read", scopeRefsFromScopeContext(request.scope_context)))) {
      return;
    }

    const allowPrivileged = request.filter_mode === FilterMode.Default
      ? false
      : await hasPrivilegedFilterPermission(req, deps);
    if (request.filter_mode !== FilterMode.Default && !allowPrivileged) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "当前权限不足，不能使用请求的 filter_mode（过滤模式）" }));
      return;
    }

    request.debug = allowPrivileged
      ? { ...(request.debug ?? {}), allow_privileged_filter_modes: true }
      : request.debug;

    const { response } = await executeRecallRequest(request, handlerDeps);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  } catch {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "内部服务错误" }));
  }
}

async function hasPrivilegedFilterPermission(
  req: IncomingMessage,
  deps: HandlerDeps
): Promise<boolean> {
  const checker = deps.permissions ?? createPermissionChecker(deps.env ?? process.env);
  const shouldClose = !deps.permissions;
  try {
    const decision = await checker.authorizeRequest(req, "memory:governance_read");
    return decision.allowed;
  } finally {
    if (shouldClose) await checker.close();
  }
}

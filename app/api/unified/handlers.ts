import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { LifecycleStatus, OutboxEventType, ReviewState, ScopeType, type JsonObject } from "../../shared";
import { executeRecallRequest, executeWriteCommand } from "../../server/http-handlers";
import * as runtime from "../../server/runtime";
import { searchKnowledge, type KnowledgeSearchResult } from "../../knowledge/service";
import { MemoryFeedbackRepository, type MemoryFeedbackType } from "../../db/repositories/memory-feedback-repository";
import { MemoryEventRepository } from "../../db/repositories/memory-event-repository";
import { MemoryRecordRepository } from "../../db/repositories/memory-record-repository";
import { OutboxEventRepository } from "../../db/repositories/outbox-event-repository";
import { IngestRequestRepository } from "../../db/repositories/ingest-request-repository";
import { RecallFeedbackRepository, type RecallFeedbackType } from "../../db/repositories/recall-feedback-repository";
import { ScopeGenerationRepository } from "../../db/repositories/scope-generation-repository";
import { KnowledgeScopeGrantRepository } from "../../db/repositories/knowledge-scope-grant-repository";
import { withWriteTransaction, isInMemoryTransactionContext, isPostgresTransactionContext } from "../../db/tx/write-transaction";
import { IngestRequestStatus, WriteCommandType, type StoredIngestResult } from "../../shared/contracts/write";
import { parseJsonBody } from "../../server/body";
import {
  buildRecallRepairDetails,
  defaultRecallRepairSuggestedAction,
  resolveRecallRepairRootCauseType
} from "../../recall/recall-repair";
import {
  enforceMemoryIdPermission,
  enforceScopePermission,
  globalScope,
  scopeRefsFromScopeContext,
  strictScopeEnabled,
  type ScopeEnforcementContext,
} from "../../server/scope-enforcement";
import { createPermissionChecker, extractAuthToken, type PermissionChecker } from "../../server/permissions";
import { applyAutoApprovalFeedbackGovernance } from "../../governance/auto-approval-feedback";
function sendJson(res: ServerResponse, status: number, data: unknown): void { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
function readStr(value: unknown, fallback = ""): string { return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback; }
function isPlainObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function readJsonObject(value: unknown): JsonObject | null { return isPlainObject(value) ? value as JsonObject : null; }
function internalApiToken(): string { return process.env.MEMORY_V2_ADMIN_TOKEN ?? process.env.MEMORY_V2_API_TOKEN ?? ""; }
function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : undefined;
}

async function enforceKnowledgeRead(
  req: IncomingMessage,
  res: ServerResponse,
  authContext: ScopeEnforcementContext | undefined,
  input: { readonly collections: readonly string[]; readonly repos: readonly string[] }
): Promise<boolean> {
  if (!strictScopeEnabled(authContext)) return true;
  const checker: PermissionChecker = authContext?.permissions ?? createPermissionChecker(authContext?.env ?? process.env);
  const shouldClose = !authContext?.permissions;
  try {
    const token = extractAuthToken(req);
    const global = await checker.authorizeScope({ token, permission: "memory:read", scopeType: "global", scopeId: "global" });
    if (global.allowed && global.scopeAllowed) return true;
    const resources = [
      ...input.collections.map((resourceId) => ({ resourceType: "collection" as const, resourceId })),
      ...input.repos.map((resourceId) => ({ resourceType: "repo" as const, resourceId }))
    ];
    if (resources.length === 0) {
      sendJson(res, global.authenticated ? 403 : 401, {
        error: global.authenticated ? "forbidden" : "unauthorized",
        required: "memory:read",
        reason: "knowledge_scope_required"
      });
      return false;
    }
    const base = await checker.authorizeToken(token, "memory:read");
    if (!base.authenticated || !base.allowed || !base.identity) {
      sendJson(res, base.authenticated ? 403 : 401, {
        error: base.authenticated ? "forbidden" : "unauthorized",
        required: "memory:read",
        reason: base.authenticated ? "permission_denied" : "unauthenticated"
      });
      return false;
    }
    if (!authContext?.writeDatabase) {
      sendJson(res, 503, { error: "knowledge_grant_store_unavailable" });
      return false;
    }
    const grantRepository = new KnowledgeScopeGrantRepository();
    for (const resource of resources) {
      const allowed = await withWriteTransaction(authContext.writeDatabase, (tx) =>
        grantRepository.hasReadGrant(tx, {
          agentId: base.identity!.agentId,
          resourceType: resource.resourceType,
          resourceId: resource.resourceId
        })
      );
      if (!allowed) {
        sendJson(res, 403, {
          error: "forbidden",
          required: "memory:read",
          resource,
          reason: "knowledge_scope_grant_missing"
        });
        return false;
      }
    }
    return true;
  } finally {
    if (shouldClose) await checker.close();
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function errorStatus(error: unknown): number {
  const explicitStatus = typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;
  if (explicitStatus) return explicitStatus;
  const message = error instanceof Error ? error.message : String(error);
  if (message === "body_read_timeout") return 408;
  if (message === "body_too_large") return 413;
  if (message === "invalid_json_body") return 400;
  return 500;
}

function buildScopeContext(p: Record<string, unknown>) {
  const nested = isPlainObject(p.scope_context) ? p.scope_context as Record<string, unknown> : {};
  const scopeType = readStr(p.scope_type).toLowerCase();
  const scopeId = readStr(p.scope_id);
  const ctx: {
    user_id?: string;
    workspace_id?: string;
    project_ids?: string[];
    include_global?: boolean;
    runtime?: { run_id?: string; task_id?: string; session_id?: string };
    memory_ids?: string[];
  } = {
    user_id: readStr(p.user_id ?? nested.user_id) || undefined,
    project_ids: readStringArray(p.project_ids) ?? readStringArray(nested.project_ids),
    workspace_id: readStr(p.workspace_id ?? nested.workspace_id) || undefined,
    include_global: p.include_global === false
      ? false
      : nested.include_global === false
        ? false
      : scopeType
        ? scopeType === "global" || p.include_global === true || nested.include_global === true
        : true,
    runtime: isPlainObject(p.runtime) || isPlainObject(nested.runtime) ? {
      run_id: readStr((isPlainObject(p.runtime) ? p.runtime : nested.runtime as Record<string, unknown>).run_id) || undefined,
      task_id: readStr((isPlainObject(p.runtime) ? p.runtime : nested.runtime as Record<string, unknown>).task_id) || undefined,
      session_id: readStr((isPlainObject(p.runtime) ? p.runtime : nested.runtime as Record<string, unknown>).session_id) || undefined,
    } : undefined,
    memory_ids: readStringArray(p.memory_ids) ?? readStringArray(nested.memory_ids),
  };

  if (scopeType === "user" || scopeType === "personal") ctx.user_id = scopeId || ctx.user_id;
  if (scopeType === "workspace" || scopeType === "shared") ctx.workspace_id = scopeId || ctx.workspace_id;
  if (scopeType === "project" && scopeId) ctx.project_ids = [...new Set([scopeId, ...(ctx.project_ids ?? [])])];
  if (scopeType === "run" && scopeId) ctx.runtime = { ...(ctx.runtime ?? {}), run_id: scopeId };
  if (scopeType === "task" && scopeId) ctx.runtime = { ...(ctx.runtime ?? {}), task_id: scopeId };
  const taskId = readStr(p.task_id);
  const sessionId = readStr(p.session_id);
  if (taskId || sessionId) ctx.runtime = { ...(ctx.runtime ?? {}), ...(taskId ? { task_id: taskId } : {}), ...(sessionId ? { session_id: sessionId } : {}) };
  if (scopeType === "global") ctx.include_global = true;
  return ctx;
}

function hasLongTermScopeContext(scopeContext: ReturnType<typeof buildScopeContext>): boolean {
  return Boolean(
    scopeContext.user_id ||
    scopeContext.workspace_id ||
    scopeContext.include_global ||
    (scopeContext.project_ids?.length ?? 0) > 0 ||
    (scopeContext.memory_ids?.length ?? 0) > 0
  );
}

function isRuntimeScopeName(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "run" || normalized === "task" || normalized === "execution";
}

function readTemporalScope(value: unknown): "current" | "all" | "historical" | undefined {
  const ts = readStr(value);
  return ts === "current" || ts === "all" || ts === "historical" ? ts : undefined;
}

function buildHybridResults(
  memoryResults: Awaited<ReturnType<typeof executeRecallRequest>>["response"]["results"],
  knowledgeResults: readonly KnowledgeSearchResult[],
  memoryBudget: number,
  knowledgeBudget: number,
  hybridMode: "separate" | "rrf" | "model_rerank" = "rrf",
) {
  const memoryItems = memoryResults.slice(0, memoryBudget).map((item) => ({
    kind: "memory" as const,
    id: item.memory_id,
    title: item.title,
    content: item.content,
    score: item.rerank_score ?? item.score,
    source: item.scope,
  }));
  const knowledgeItems = knowledgeResults.slice(0, knowledgeBudget).map((item) => ({
    kind: "knowledge" as const,
    id: item.chunk_id,
    title: item.source_path,
    content: item.content,
    score: item.score,
    source: {
      collection: item.collection,
      repo: item.repo,
      source_path: item.source_path,
      start_line: item.start_line,
      end_line: item.end_line,
    },
  }));
  if (hybridMode === "separate") {
    return [...memoryItems, ...knowledgeItems];
  }
  const k = 20;
  const ranked = [
    ...memoryItems.map((item, index) => ({
      ...item,
      raw_score: item.score,
      score: 1.1 / (k + index + 1),
      hybrid_rank_source: "memory" as const
    })),
    ...knowledgeItems.map((item, index) => ({
      ...item,
      raw_score: item.score,
      score: 1.0 / (k + index + 1),
      hybrid_rank_source: "knowledge" as const
    }))
  ];
  return ranked.sort((left, right) => right.score - left.score);
}

export async function handleRemember(req: IncomingMessage, res: ServerResponse, authContext?: ScopeEnforcementContext): Promise<void> {
  if (req.method !== "POST") { sendJson(res, 405, { error: "请求方法不允许" }); return; }
  try {
    const body = await parseJsonBody(req); const p = (isPlainObject(body) ? body : {}) as Record<string, unknown>;
    for (const f of ["user_id", "agent_id", "scope_id", "content"]) { if (!readStr(p[f])) { sendJson(res, 400, { error: `缺少必填字段：${f}` }); return; } }
    const agentId = readStr(p.agent_id);
    const autoApprove = process.env.MEMORY_V2_TRUSTED_AGENT_AUTO_APPROVE === "true";
    const trusted = (process.env.MEMORY_V2_TRUSTED_AGENTS ?? "").split(",").map(s => s.trim()).filter(Boolean);
    const isAuto = autoApprove && trusted.includes(agentId);
    const rawScopeType = readStr(p.scope_type, "project").toLowerCase();
    if (isRuntimeScopeName(rawScopeType)) {
      sendJson(res, 400, { error: "runtime_scope_not_supported_for_write" });
      return;
    }
    const db = runtime.writeDatabase; if (!db) { sendJson(res, 503, { error: "运行时尚未初始化" }); return; }
    const map: Record<string, ScopeType> = { personal: ScopeType.User, user: ScopeType.User, shared: ScopeType.Workspace, workspace: ScopeType.Workspace, project: ScopeType.Project, global: ScopeType.Global };
    const scopeType = map[rawScopeType] ?? ScopeType.Project;
    if (!(await enforceScopePermission(req, res, authContext, "memory:write", [{
      scopeType,
      scopeId: readStr(p.scope_id),
    }]))) {
      return;
    }
    const result = await executeWriteCommand({ requestId: readStr(p.request_id) || randomUUID(), actorId: agentId, scopeType, scopeId: readStr(p.scope_id), content: readStr(p.content), title: readStr(p.title) || null, summary: null, metadata: { ...(isPlainObject(p.metadata) ? p.metadata as JsonObject : {}), source: readStr(p.source) || "unified-api", app_id: readStr(p.app_id) || null } as JsonObject, lifecycleStatus: isAuto ? LifecycleStatus.Approved : LifecycleStatus.Candidate, reviewState: isAuto ? ReviewState.NotRequired : ReviewState.Pending, sources: [], relations: [] });
    sendJson(res, 201, result);
  } catch (err) { sendJson(res, errorStatus(err), { error: (err as Error).message }); }
}

export async function handleRecall(req: IncomingMessage, res: ServerResponse, authContext?: ScopeEnforcementContext): Promise<void> {
  if (req.method !== "POST") { sendJson(res, 405, { error: "请求方法不允许" }); return; }
  try {
    const body = await parseJsonBody(req); const p = (isPlainObject(body) ? body : {}) as Record<string, unknown>;
    const query = readStr(p.query);
    const hybridMode = readStr(p.hybrid_mode) === "separate" || readStr(p.hybrid_mode) === "model_rerank" ? readStr(p.hybrid_mode) as "separate" | "model_rerank" : "rrf";
    const scopeContext = buildScopeContext(p);
    if (scopeContext.runtime && !hasLongTermScopeContext(scopeContext)) {
      sendJson(res, 400, {
        error: "long_term_scope_required",
        message: "运行时 scope（作用域）只表示当前执行上下文；召回时请提供 user、workspace、project、global 或 memory_ids。"
      });
      return;
    }
    if (!(await enforceScopePermission(req, res, authContext, "memory:read", scopeRefsFromScopeContext(scopeContext)))) {
      return;
    }
    const knowledgeCollections = readStringArray(p.knowledge_collections) ?? [];
    const knowledgeRepos = readStringArray(p.repos) ?? [];
    if (p.include_knowledge === true && !(await enforceKnowledgeRead(req, res, authContext, {
      collections: knowledgeCollections,
      repos: knowledgeRepos
    }))) return;
    const rt = runtime.runtime; if (!rt) { sendJson(res, 503, { error: "运行时尚未初始化" }); return; }
    const { response } = await executeRecallRequest({
      query,
      scope_context: scopeContext,
      limit: typeof p.limit === "number" ? p.limit : 10,
      temporal_scope: readTemporalScope(p.temporal_scope),
      memory_layers: readStringArray(p.memory_layers),
      session_id: readStr(p.session_id) || undefined,
      turn_id: readStr(p.turn_id) || undefined,
      context_queries: readStringArray(p.context_queries),
      current_goal: readStr(p.current_goal) || undefined,
      task_id: readStr(p.task_id) || undefined,
      hybrid_mode: hybridMode,
    });
    if (p.include_knowledge === true) {
      const memoryBudget = typeof p.memory_budget === "number" ? Math.max(1, Math.trunc(p.memory_budget)) : response.results.length;
      const knowledgeBudget = typeof p.knowledge_budget === "number" ? Math.max(1, Math.trunc(p.knowledge_budget)) : 8;
      const knowledge = await searchKnowledge({
        query,
        limit: knowledgeBudget,
        knowledge_collections: knowledgeCollections,
        repos: knowledgeRepos
      });
      sendJson(res, 200, {
        ...response,
        memory_results: response.results,
        knowledge_included: true,
        knowledge_results: knowledge.results,
        hybrid_results: buildHybridResults(response.results, knowledge.results, memoryBudget, knowledgeBudget, hybridMode),
        hybrid_rerank: {
          backend: hybridMode === "separate" ? "separate" : "rrf",
          k: 20,
          memory_weight: 1.1,
          knowledge_weight: 1.0,
          memory_budget: memoryBudget,
          knowledge_budget: knowledgeBudget,
        },
        knowledge_degraded: knowledge.degraded ?? false,
        knowledge_failure_reason: knowledge.failure_reason
      });
      return;
    }
    sendJson(res, 200, response);
  } catch (err) { sendJson(res, errorStatus(err), { error: (err as Error).message }); }
}

export async function handleReflect(req: IncomingMessage, res: ServerResponse, authContext?: ScopeEnforcementContext): Promise<void> {
  if (req.method !== "POST") { sendJson(res, 405, { error: "请求方法不允许" }); return; }
  try {
    const body = await parseJsonBody(req); const p = (isPlainObject(body) ? body : {}) as Record<string, unknown>;
    const query = readStr(p.query);
    const scopeContext = buildScopeContext(p);
    const includeGlobalAudit = p.include_global_audit === true || p.include_audit === true;
    const scopes = query ? scopeRefsFromScopeContext(scopeContext) : globalScope();
    if (!(await enforceScopePermission(req, res, authContext, "memory:read", scopes))) {
      return;
    }
    let auditRespOk = true;
    let audit: Record<string, unknown> = {
      scoped: true,
      skipped: "global_audit_requires_include_global_audit"
    };
    if (!query || includeGlobalAudit) {
      if (!(await enforceScopePermission(req, res, authContext, "memory:read", globalScope()))) {
        return;
      }
      const port = process.env.MEMORY_V2_WRAPPER_PORT ?? "5100"; const token = internalApiToken();
      const auditResp = await fetch("http://127.0.0.1:" + port + "/api/memory/v2/orchestrator/audit-memory-consistency", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token }, body: JSON.stringify({ include_records: false }) });
      auditRespOk = auditResp.ok;
      audit = await auditResp.json().catch(() => ({ ok: false, error: "audit_invalid_json" })) as Record<string, unknown>;
    }
    let recall: null | { count: number; memory_ids: string[]; applied_temporal_scope?: unknown; degraded?: unknown } = null;
    if (query) {
      const rt = runtime.runtime; if (!rt) { sendJson(res, 503, { error: "运行时尚未初始化" }); return; }
      const { response } = await executeRecallRequest({ query, scope_context: scopeContext, limit: typeof p.limit === "number" ? p.limit : 5, temporal_scope: readTemporalScope(p.temporal_scope), memory_layers: readStringArray(p.memory_layers) });
      const auditPayload = response.audit as { temporal?: { applied_temporal_scope?: unknown }; degraded?: unknown } | undefined;
      recall = {
        count: response.results.length,
        memory_ids: response.results.map((item) => item.memory_id),
        applied_temporal_scope: auditPayload?.temporal?.applied_temporal_scope,
        degraded: auditPayload?.degraded,
      };
    }
    const recommendations: string[] = [];
    if (!auditRespOk || audit?.ok === false) recommendations.push("run_audit_repair_before_release");
    if (recall && recall.count === 0) recommendations.push("no_relevant_memory_found_consider_remember");
    sendJson(res, 200, {
      ok: auditRespOk,
      agent_id: readStr(p.agent_id) || null,
      run_id: readStr(p.run_id) || null,
      checked_at: new Date().toISOString(),
      audit,
      recall,
      recommendations,
    });
  } catch (err) { sendJson(res, errorStatus(err), { error: (err as Error).message }); }
}

export async function handleForget(req: IncomingMessage, res: ServerResponse, authContext?: ScopeEnforcementContext): Promise<void> {
  if (req.method !== "POST") { sendJson(res, 405, { error: "请求方法不允许" }); return; }
  try {
    const body = await parseJsonBody(req); const p = (isPlainObject(body) ? body : {}) as Record<string, unknown>;
    const memoryId = readStr(p.memory_id); if (!memoryId) { sendJson(res, 400, { error: "缺少必填字段：memory_id（记忆 ID）" }); return; }
    if (!(await enforceMemoryIdPermission(req, res, authContext, "memory:governance_revert", [memoryId]))) {
      return;
    }
    const port = process.env.MEMORY_V2_WRAPPER_PORT ?? "5100"; const token = internalApiToken();
    const resp = await fetch("http://127.0.0.1:" + port + "/api/memory/v2/orchestrator/forget-memory", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token }, body: JSON.stringify({ requestId: randomUUID(), actorId: readStr(p.agent_id, "unified-api"), memoryId, mode: readStr(p.mode) === "archive" ? "archive" : "tombstone" }) });
    sendJson(res, resp.status, await resp.json());
  } catch (err) { sendJson(res, errorStatus(err), { error: (err as Error).message }); }
}

export async function handleAudit(req: IncomingMessage, res: ServerResponse, authContext?: ScopeEnforcementContext): Promise<void> {
  if (req.method !== "POST") { sendJson(res, 405, { error: "请求方法不允许" }); return; }
  try {
    const body = await parseJsonBody(req); const p = (isPlainObject(body) ? body : {}) as Record<string, unknown>;
    if (!(await enforceScopePermission(req, res, authContext, "memory:read", globalScope()))) {
      return;
    }
    const port = process.env.MEMORY_V2_WRAPPER_PORT ?? "5100"; const token = internalApiToken();
    const resp = await fetch("http://127.0.0.1:" + port + "/api/memory/v2/orchestrator/audit-memory-consistency", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token }, body: JSON.stringify({ include_records: p.include_records === true }) });
    sendJson(res, resp.status, await resp.json());
  } catch (err) { sendJson(res, errorStatus(err), { error: (err as Error).message }); }
}

const FEEDBACK_TYPES = new Set<MemoryFeedbackType>(["confirmed", "used", "edited", "negative", "wrong", "deleted", "not_relevant", "changed_mind"]);
const RECALL_FEEDBACK_TYPES = new Set<RecallFeedbackType>(["presented", "used_in_context", "adopted", "ignored", "not_relevant", "false_positive", "false_null"]);

function feedbackStrengthAdjustment(feedbackType: MemoryFeedbackType): number {
  if (feedbackType === "confirmed" || feedbackType === "used") return 0.08;
  if (feedbackType === "negative" || feedbackType === "wrong" || feedbackType === "deleted" || feedbackType === "not_relevant") return -0.12;
  return 0;
}

function clampMemoryStrength(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function feedbackTypeFromAliasAction(action: string): MemoryFeedbackType | null {
  const normalized = action.trim().toLowerCase();
  if (normalized === "used") return "used";
  if (normalized === "adopted") return "confirmed";
  if (normalized === "rejected" || normalized === "bad") return "negative";
  return null;
}

function extractTraceMemoryIds(results: JsonObject): Set<string> {
  const value = results.memory_ids;
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
}

function hashQueryFromTraceFallback(recallTraceId: string): string {
  return createHash("sha256").update(recallTraceId).digest("hex").slice(0, 32);
}

export async function handleRecallFeedback(req: IncomingMessage, res: ServerResponse, authContext?: ScopeEnforcementContext): Promise<void> {
  if (req.method !== "POST") { sendJson(res, 405, { error: "请求方法不允许" }); return; }
  try {
    const body = await parseJsonBody(req);
    const p = (isPlainObject(body) ? body : {}) as Record<string, unknown>;
    const recallTraceId = readStr(p.recall_trace_id);
    const actorId = readStr(p.agent_id) || readStr(p.actor_id, "unified-api");
    if (!recallTraceId) { sendJson(res, 400, { error: "缺少必填字段：recall_trace_id（召回轨迹 ID）" }); return; }
    const db = authContext?.writeDatabase ?? runtime.writeDatabase;
    if (!db) { sendJson(res, 503, { error: "运行时尚未初始化" }); return; }
    const usedMemoryIds = readStringArray(p.used_memory_ids) ?? [];
    const feedbackType = readStr(p.feedback_type) as RecallFeedbackType;
    const memoryId = readStr(p.memory_id) || null;
    const feedbackMemoryIds = [...usedMemoryIds, ...(memoryId ? [memoryId] : [])];
    if (feedbackMemoryIds.length > 0) {
      if (!(await enforceMemoryIdPermission(req, res, authContext, "memory:feedback", feedbackMemoryIds))) {
        return;
      }
    } else if (!(await enforceScopePermission(req, res, authContext, "memory:feedback", globalScope()))) {
      return;
    }
    const explicitFalseNull = p.false_null === true || feedbackType === "false_null";
    const feedbackMetadata = readJsonObject(p.metadata) ?? {};
    const recallFeedbackRequestId = readStr(p.request_id) || readStr(p.requestId) || randomUUID();
    const commandPayload = {
      recall_trace_id: recallTraceId,
      actor_id: actorId,
      used_memory_ids: usedMemoryIds,
      feedback_type: feedbackType || null,
      memory_id: memoryId,
      false_null: explicitFalseNull,
      reason: readStr(p.reason) || null,
      metadata: feedbackMetadata,
      alias: readStr(p.alias) || null,
      suggested_values: readJsonObject(p.suggested_values),
      root_cause_type: p.root_cause_type ?? null,
      root_cause: p.root_cause ?? null,
      suggested_action: readStr(p.suggested_action) || null
    } as JsonObject;
    const payloadHash = hashJson(commandPayload);
    const payloadJson = stableStringify(commandPayload);

    const result = await withWriteTransaction(db, async (tx) => {
      const repository = new RecallFeedbackRepository();
      const ingestRequests = new IngestRequestRepository();
      const existing = await ingestRequests.findByRequestId(tx, recallFeedbackRequestId);
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw httpError("idempotency_payload_conflict", 409);
        }
        if (existing.status === IngestRequestStatus.Completed && existing.result) {
          return { replayed: true, ...(existing.result as JsonObject) };
        }
        if (existing.status === IngestRequestStatus.Failed) {
          throw httpError("request_already_failed", 409);
        }
        throw httpError("request_already_in_flight", 409);
      }
      const accepted = await ingestRequests.insertAccepted(tx, {
        requestId: recallFeedbackRequestId,
        commandType: WriteCommandType.RecallFeedback,
        payloadHash,
        payloadJson,
        actorId
      });
      if (!accepted) {
        throw httpError("request_already_in_flight", 409);
      }

      const trace = await repository.getTrace(tx, recallTraceId);
      if (!trace) throw Object.assign(new Error("recall_trace_not_found"), { status: 404 });
      const traceMemoryIds = extractTraceMemoryIds(trace.results);
      const invalidUsed = usedMemoryIds.filter((id) => !traceMemoryIds.has(id));
      if (invalidUsed.length > 0) throw Object.assign(new Error("used_memory_ids_not_in_trace"), { status: 400 });
      if (memoryId && !explicitFalseNull && !traceMemoryIds.has(memoryId)) {
        throw Object.assign(new Error("memory_id_not_in_trace"), { status: 400 });
      }

      const suspicious = await repository.isActorFeedbackSuspicious(tx, actorId);
      const events = [];
      for (const id of usedMemoryIds) {
        events.push(await repository.addFeedback(tx, {
          recallTraceId,
          memoryId: id,
          actorId,
          feedbackType: "used_in_context",
          suspicious,
          metadata: { source: "recall_feedback_callback" }
        }));
      }
      if (feedbackType && RECALL_FEEDBACK_TYPES.has(feedbackType)) {
        events.push(await repository.addFeedback(tx, {
          recallTraceId,
          memoryId,
          actorId,
          feedbackType,
          suspicious,
          reason: readStr(p.reason) || null,
          metadata: feedbackMetadata
        }));
      }

      let repair: { count: number; triggered: boolean; root_cause_type: string; true_null?: boolean } | null = null;
      if (explicitFalseNull) {
        const queryHash = trace.queryHash || hashQueryFromTraceFallback(recallTraceId);
        const alias = readStr(p.alias) || readStr(feedbackMetadata.alias);
        const suggestedValues = readJsonObject(p.suggested_values) ??
          readJsonObject(feedbackMetadata.suggested_values) ??
          (alias ? { alias } as JsonObject : null);
        const rootCauseType = resolveRecallRepairRootCauseType({
          rootCauseType: p.root_cause_type ?? feedbackMetadata.root_cause_type,
          rootCause: p.root_cause ?? feedbackMetadata.root_cause,
          details: feedbackMetadata,
          memoryId
        });
        const suggestedAction = readStr(p.suggested_action) ||
          readStr(feedbackMetadata.suggested_action) ||
          defaultRecallRepairSuggestedAction(rootCauseType);
        const details = buildRecallRepairDetails({
          scope: trace.scopeContext,
          queryHash,
          rootCauseType,
          memoryId,
          suggestedAction,
          suggestedValues,
          extra: {
            ...feedbackMetadata,
            source: "recall_feedback",
            actor_id: actorId,
            ...(alias ? { alias } : {})
          } as JsonObject
        });

        if (rootCauseType === "memory_absent") {
          repair = { count: 0, triggered: false, root_cause_type: rootCauseType, true_null: true };
        } else {
          const row = await repository.upsertRepairQueue(tx, {
            queryHash,
            recallTraceId,
            issueType: "false_null",
            details,
            rootCauseType,
            rootCause: rootCauseType,
            suggestedAction
          });
          repair = { count: row.count, triggered: row.count >= 5, root_cause_type: rootCauseType };
        }
      }
      const completedEvents = events.map((event) => ({
        id: event.id,
        recallTraceId: event.recallTraceId,
        recall_trace_id: event.recallTraceId,
        memoryId: event.memoryId,
        memory_id: event.memoryId,
        actorId: event.actorId,
        actor_id: event.actorId,
        feedbackType: event.feedbackType,
        feedback_type: event.feedbackType,
        suspicious: event.suspicious,
        reason: event.reason,
        metadata: event.metadata,
        createdAt: event.createdAt,
        created_at: event.createdAt
      })) as JsonObject[];
      const completed = {
        commandType: WriteCommandType.RecallFeedback,
        requestId: recallFeedbackRequestId,
        request_id: recallFeedbackRequestId,
        recallTraceId,
        recall_trace_id: recallTraceId,
        events: completedEvents,
        suspicious,
        repair: repair ? repair as unknown as JsonObject : null,
        outbox_events_skipped: true
      } as JsonObject;
      await ingestRequests.markCompleted(tx, recallFeedbackRequestId, completed);
      return { replayed: false, ...completed };
    });

    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    sendJson(res, errorStatus(err), { error: (err as Error).message });
  }
}

export async function handleFeedback(req: IncomingMessage, res: ServerResponse, authContext?: ScopeEnforcementContext): Promise<void> {
  if (req.method !== "POST") { sendJson(res, 405, { error: "请求方法不允许" }); return; }
  try {
    const body = await parseJsonBody(req);
    const p = (isPlainObject(body) ? body : {}) as Record<string, unknown>;
    await handleFeedbackPayload(req, res, p, authContext);
  } catch (err) {
    sendJson(res, errorStatus(err), { error: (err as Error).message });
  }
}

export async function handleFeedbackAlias(
  req: IncomingMessage,
  res: ServerResponse,
  memoryId: string,
  action: string,
  authContext?: ScopeEnforcementContext
): Promise<void> {
  if (req.method !== "POST") { sendJson(res, 405, { error: "请求方法不允许" }); return; }
  try {
    const feedbackType = feedbackTypeFromAliasAction(action);
    if (!feedbackType) { sendJson(res, 400, { error: "反馈操作无效" }); return; }
    const body = await parseJsonBody(req);
    const p = {
      ...(isPlainObject(body) ? body as Record<string, unknown> : {}),
      memory_id: memoryId,
      feedback_type: feedbackType,
      metadata: {
        ...(isPlainObject((body as Record<string, unknown> | null)?.metadata) ? (body as Record<string, unknown>).metadata as JsonObject : {}),
        deprecated_alias: "/api/memory/v2/feedback/memories/:memory_id/:action",
        alias_action: action,
      }
    } as Record<string, unknown>;
    await handleFeedbackPayload(req, res, p, authContext);
  } catch (err) {
    sendJson(res, errorStatus(err), { error: (err as Error).message });
  }
}

async function handleFeedbackPayload(
  req: IncomingMessage,
  res: ServerResponse,
  p: Record<string, unknown>,
  authContext?: ScopeEnforcementContext
): Promise<void> {
  const memoryId = readStr(p.memory_id);
  const feedbackType = readStr(p.feedback_type) as MemoryFeedbackType;
  if (!memoryId) { sendJson(res, 400, { error: "缺少必填字段：memory_id（记忆 ID）" }); return; }
  if (!FEEDBACK_TYPES.has(feedbackType)) { sendJson(res, 400, { error: "feedback_type（反馈类型）无效" }); return; }
  if (!(await enforceMemoryIdPermission(req, res, authContext, "memory:feedback", [memoryId]))) {
    return;
  }
  const db = authContext?.writeDatabase ?? runtime.writeDatabase;
  if (!db) { sendJson(res, 503, { error: "运行时尚未初始化" }); return; }
  const actorId = readStr(p.agent_id) || readStr(p.actor_id, "unified-api");
  const relatedMemoryId = readStr(p.related_memory_id) || null;
  const reason = readStr(p.reason) || null;
  const feedbackRequestId = readStr(p.request_id) || readStr(p.requestId) || randomUUID();
  const feedbackMetadata = {
    ...(isPlainObject(p.metadata) ? p.metadata as JsonObject : {}),
    ...(readStr(p.recall_trace_id) ? { recall_trace_id: readStr(p.recall_trace_id) } : {}),
  } as JsonObject;
  const commandPayload = {
    memory_id: memoryId,
    feedback_type: feedbackType,
    actor_id: actorId,
    related_memory_id: relatedMemoryId,
    reason,
    metadata: feedbackMetadata,
  } as JsonObject;
  const payloadHash = hashJson(commandPayload);
  const payloadJson = stableStringify(commandPayload);

  const result = await withWriteTransaction(db, async (tx) => {
    const ingestRequests = new IngestRequestRepository();
    const existing = await ingestRequests.findByRequestId(tx, feedbackRequestId);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw httpError("idempotency_payload_conflict", 409);
      }
      if (existing.status === IngestRequestStatus.Completed && existing.result) {
        return { replayed: true, stored: existing.result };
      }
      if (existing.status === IngestRequestStatus.Failed) {
        throw httpError("request_already_failed", 409);
      }
      throw httpError("request_already_in_flight", 409);
    }

    const accepted = await ingestRequests.insertAccepted(tx, {
      requestId: feedbackRequestId,
      commandType: WriteCommandType.FeedbackMemory,
      payloadHash,
      payloadJson,
      actorId,
    });
    if (!accepted) {
      throw httpError("request_already_in_flight", 409);
    }

    const memoryRecordRepository = new MemoryRecordRepository();
    const record = await memoryRecordRepository.findByIdForUpdate(tx, memoryId);
    if (!record) throw httpError("memory_not_found", 404);

    const inserted = await new MemoryFeedbackRepository().add(tx, {
      memoryId,
      actorId,
      feedbackType,
      relatedMemoryId,
      reason,
      metadata: feedbackMetadata,
    });
    const requestedStrengthDelta = feedbackStrengthAdjustment(feedbackType);
    const previousMemoryStrength = record.memoryStrength;
    const nextMemoryStrength = clampMemoryStrength(previousMemoryStrength + requestedStrengthDelta);
    const actualStrengthDelta = nextMemoryStrength - previousMemoryStrength;
    const shouldUpdateRecord = requestedStrengthDelta !== 0 || feedbackType === "edited";
    const now = tx.now();

    if (isPostgresTransactionContext(tx)) {
      if (shouldUpdateRecord) {
        await tx.query(
          `
            UPDATE memory_records
            SET memory_strength = $2,
                metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
                updated_by = $4,
                updated_at = $5::timestamptz
            WHERE id = $1
          `,
          [
            memoryId,
            nextMemoryStrength,
            JSON.stringify({
              user_feedback: feedbackType,
              user_edited: feedbackType === "edited" ? true : undefined,
              user_flagged: requestedStrengthDelta < 0 ? true : undefined,
              last_feedback_event_id: inserted.id,
            }),
            actorId,
            now,
          ]
        );
      }
      if (feedbackType === "changed_mind" && relatedMemoryId) {
        await tx.query(
          `
            INSERT INTO memory_relations (id, memory_id, related_memory_id, relation_type, direction, weight, metadata, created_at, updated_at)
            VALUES ($1, $2, $3, 'superseded_by', 'outbound', 1.0, $4::jsonb, $5::timestamptz, $5::timestamptz)
          `,
          [
            tx.nextId("memory_relation"),
            memoryId,
            relatedMemoryId,
            JSON.stringify({ feedback_event_id: inserted.id, source: "user_feedback_changed_mind" }),
            now,
          ]
        );
      }
    } else if (isInMemoryTransactionContext(tx)) {
      const index = tx.state.memoryRecords.findIndex((row) => row.id === memoryId);
      if (index >= 0) {
        const current = tx.state.memoryRecords[index];
        if (shouldUpdateRecord) {
          tx.state.memoryRecords[index] = {
            ...current,
            memoryStrength: nextMemoryStrength,
            metadata: {
              ...current.metadata,
              user_feedback: feedbackType,
              ...(feedbackType === "edited" ? { user_edited: true } : {}),
              ...(requestedStrengthDelta < 0 ? { user_flagged: true } : {}),
              last_feedback_event_id: inserted.id,
            },
            updatedBy: actorId,
            updatedAt: now,
          };
        }
      }
      if (feedbackType === "changed_mind" && relatedMemoryId) {
        tx.state.memoryRelations.push({
          id: tx.nextId("memory_relation"),
          memoryId,
          relatedMemoryId,
          relationType: "superseded_by",
          direction: "outbound",
          weight: 1,
          metadata: { feedback_event_id: inserted.id, source: "user_feedback_changed_mind" },
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    const eventPayload = {
      memoryId,
      memory_id: memoryId,
      requestId: feedbackRequestId,
      request_id: feedbackRequestId,
      sourceMemoryRequestId: record.requestId,
      source_memory_request_id: record.requestId,
      feedbackEventId: inserted.id,
      feedback_event_id: inserted.id,
      feedbackType,
      feedback_type: feedbackType,
      actorId,
      actor_id: actorId,
      scope: { type: record.scopeType, id: record.scopeId },
      scopeType: record.scopeType,
      scopeId: record.scopeId,
      previousMemoryStrength,
      memoryStrength: nextMemoryStrength,
      strengthDelta: actualStrengthDelta,
      strength_delta: actualStrengthDelta,
      requestedStrengthDelta,
      feedbackMetadata,
      ...(relatedMemoryId ? { relatedMemoryId, related_memory_id: relatedMemoryId } : {}),
      ...(reason ? { reason } : {}),
    } as JsonObject;

    const memoryEvent = await new MemoryEventRepository().append(tx, {
      memoryId,
      requestId: feedbackRequestId,
      eventType: OutboxEventType.MemoryFeedbackRecorded,
      actorId,
      payload: eventPayload,
    });

    const outboxEvent = await new OutboxEventRepository().append(tx, {
      aggregateId: memoryId,
      requestId: feedbackRequestId,
      eventType: OutboxEventType.MemoryFeedbackRecorded,
      payload: eventPayload,
    });

    const generation = await new ScopeGenerationRepository().bump(tx, {
      scopeType: record.scopeType,
      scopeId: record.scopeId,
    });

    const autoApprovalGovernance = await applyAutoApprovalFeedbackGovernance(tx, {
      memoryId,
      feedbackEventId: inserted.id,
      feedbackType,
      actorId,
    });

    const completed: StoredIngestResult = {
      commandType: WriteCommandType.FeedbackMemory,
      memoryId,
      requestId: feedbackRequestId,
      feedbackEventId: inserted.id,
      memoryEventId: memoryEvent.id,
      outboxEventId: outboxEvent.id,
      eventType: OutboxEventType.MemoryFeedbackRecorded,
      feedbackType,
      autoApprovalGovernance: autoApprovalGovernance as unknown as JsonObject,
      scopeType: record.scopeType,
      scopeId: record.scopeId,
      memoryStrength: nextMemoryStrength,
      strengthDelta: actualStrengthDelta,
    } as JsonObject;
    await ingestRequests.markCompleted(tx, feedbackRequestId, completed);

    return {
      replayed: false,
      stored: completed,
      feedbackEvent: inserted,
      memoryEventId: memoryEvent.id,
      outboxEventId: outboxEvent.id,
      scopeGeneration: generation,
      autoApprovalGovernance,
    };
  });

  const stored = result.stored as Record<string, unknown>;
  sendJson(res, 200, {
    ok: true,
    replayed: result.replayed,
    request_id: feedbackRequestId,
    result: stored,
    feedback_event: result.feedbackEvent,
    memory_event_id: result.memoryEventId ?? stored.memoryEventId,
    outbox_event_id: result.outboxEventId ?? stored.outboxEventId,
    scope_generation: result.scopeGeneration,
  });
}

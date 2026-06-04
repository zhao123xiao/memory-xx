import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { RecallRuntimeCacheInvalidator } from "../cache";
import { createMemoryOrchestratorService, type MemoryOrchestratorAction } from "../orchestrator";
import { ArchiveMemoryService } from "../review/services/archive-memory-service";
import { TombstoneMemoryService } from "../review/services/tombstone-memory-service";
import { ScopeType } from "../shared";
import { CreateMemoryService } from "../write/services/create-memory-service";
import { parseJsonBody } from "./body";
import { getDeps, type HandlerDeps } from "./http-handler-deps";
import {
  isPlainObject,
  readOptionalTrimmedString,
  resolveScopeType,
} from "./http-handler-parsing";
import {
  buildCreateCommandFromBody,
  buildRecallRequestFromBody,
  buildWriteScopeHintFromBody
} from "./http-request-builders";
import {
  executeNodeRecallRequest,
  executeRecallRequest,
  rejectRuntimeScopeOnlyRecall
} from "./http-recall-handler";
import { resolveWriteErrorStatus } from "./http-write-handler";
import {
  enforceMemoryIdPermission,
  enforceScopePermission,
  globalScope,
  scopeRefsFromScopeContext,
  type ScopeRef,
} from "./scope-enforcement";
import type { OrchestratorHttpBody } from "./types";
import type { RecallResponse } from "../recall/types";

function summarizeRecallResults(response: RecallResponse, maxItems: number) {
  const used = response.results.slice(0, Math.max(1, maxItems));
  const lines = used.map((item, index) => {
    const title = item.title?.trim() || "memory " + item.memory_id;
    const excerpt = item.content.replace(/\s+/g, " ").trim().slice(0, 160);
    return String(index + 1) + ". [" + item.scope.type + ":" + item.scope.id + "] " + title + " - " + excerpt;
  });
  return {
    text: lines.length > 0 ? "Found " + response.results.length + " relevant memories.\n" + lines.join("\n") : "No matching memories found.",
    total_results: response.results.length,
    used_results: used.length,
    memory_ids: used.map((item) => item.memory_id),
    audit_ref: response.audit_ref,
    degraded: response.degraded,
  };
}

async function executeOrchestratorAction(action: MemoryOrchestratorAction | "recall_memory_legacy", payload: OrchestratorHttpBody, handlerDeps?: Partial<HandlerDeps>) {
  const deps = getDeps(handlerDeps);
  const rt = deps.runtime;
  const db = deps.writeDatabase;
  if (!db) {
    throw new Error("运行时尚未初始化");
  }
  if (!rt && (action === "recall_memory" || action === "recall_memory_legacy" || action === "summarize_memory")) {
    throw new Error("运行时尚未初始化");
  }
  const orchestrator = createMemoryOrchestratorService({
    recallOrchestrator: rt?.orchestrator ?? {
      async execute(): Promise<never> {
        throw new Error("运行时尚未初始化");
      }
    } as never,
    createMemoryService: new CreateMemoryService({
      database: db,
      cacheInvalidator: new RecallRuntimeCacheInvalidator(deps.recallCache, { database: deps.writeDatabase }),
      projectionSyncService: deps.projectionSyncService ?? undefined,
    }),
    archiveMemoryService: new ArchiveMemoryService({ database: db }),
    tombstoneMemoryService: new TombstoneMemoryService({ database: db }),
    database: db,
    cacheInvalidator: new RecallRuntimeCacheInvalidator(deps.recallCache, { database: db }),
  });
  switch (action) {
    case "resolve_scope_plan": {
      const rawRecallRequest = isPlainObject(payload.recall_request) ? (payload.recall_request as Record<string, unknown>) : payload;
      const rawWriteScopeHint = isPlainObject(payload.write_scope_hint) ? (payload.write_scope_hint as Record<string, unknown>) : payload;
      return await orchestrator.resolve_scope_plan({
        recall_request: buildRecallRequestFromBody(rawRecallRequest),
        write_scope_hint: buildWriteScopeHintFromBody(rawWriteScopeHint),
      });
    }
    case "write_memory": {
      const rawCommand = isPlainObject(payload.command) ? (payload.command as Record<string, unknown>) : payload;
      return await orchestrator.write_memory({
        command: buildCreateCommandFromBody(rawCommand),
      });
    }
    case "recall_memory": {
      const rawRequest = isPlainObject(payload.request) ? (payload.request as Record<string, unknown>) : payload;
      const executed = await executeRecallRequest(buildRecallRequestFromBody(rawRequest), handlerDeps);
      return { recall: executed.response, ...executed.extras };
    }
    case "recall_memory_legacy": {
      const rawRequest = isPlainObject(payload.request) ? (payload.request as Record<string, unknown>) : payload;
      const executed = await executeNodeRecallRequest(buildRecallRequestFromBody(rawRequest), handlerDeps);
      return { recall: executed.response, ...executed.extras };
    }
    case "summarize_memory": {
      const rawRequest = isPlainObject(payload.request) ? (payload.request as Record<string, unknown>) : payload;
      const maxItems =
        typeof payload.max_items === "number"
          ? payload.max_items
          : typeof payload.maxItems === "number"
            ? payload.maxItems
            : 3;
      const executed = await executeRecallRequest(buildRecallRequestFromBody(rawRequest), handlerDeps);
      return {
        summary: summarizeRecallResults(executed.response, maxItems),
        recall: executed.response,
        ...executed.extras,
      };
    }
    case "memory_counts": {
      const rawBody = isPlainObject(payload) ? (payload as Record<string, unknown>) : {};
      const rawScopeType = readOptionalTrimmedString(rawBody.scopeType) ?? readOptionalTrimmedString(rawBody.scope_type);
      const scopeType = rawScopeType && Object.values(ScopeType).includes(rawScopeType as ScopeType)
        ? rawScopeType as ScopeType
        : undefined;
      return await orchestrator.memory_counts({
        scopeType,
        scopeId: readOptionalTrimmedString(rawBody.scopeId) ?? readOptionalTrimmedString(rawBody.scope_id),
        includeByScope: rawBody.includeByScope === true || rawBody.include_by_scope === true,
      });
    }
    case "forget_memory":
      if (!readOptionalTrimmedString(payload.memoryId) && !readOptionalTrimmedString(payload.memory_id)) {
        throw Object.assign(new Error("缺少必填字段：memoryId 或 memory_id（记忆 ID）"), { code: "invalid_input" });
      }
      return await orchestrator.forget_memory({
        requestId: readOptionalTrimmedString(payload.requestId) ?? randomUUID(),
        actorId: readOptionalTrimmedString(payload.actorId) ?? "memory-xx",
        memoryId: readOptionalTrimmedString(payload.memoryId) ?? readOptionalTrimmedString(payload.memory_id) ?? "",
        mode: payload.mode === "archive" ? "archive" : "tombstone",
      });
    case "audit_memory_consistency":
      return await orchestrator.audit_memory_consistency({
        include_records: payload.include_records === true,
      });
    case "list_pending_memories": {
      const rawBody = isPlainObject(payload) ? (payload as Record<string, unknown>) : {};
      return await orchestrator.list_pending_memories({
        scope_type: typeof rawBody.scope_type === "string" ? rawBody.scope_type : undefined,
        scope_id: typeof rawBody.scope_id === "string" ? rawBody.scope_id : undefined,
        limit: typeof rawBody.limit === "number" ? rawBody.limit : undefined,
        offset: typeof rawBody.offset === "number" ? rawBody.offset : undefined,
        agent_id: typeof rawBody.agent_id === "string" ? rawBody.agent_id : undefined,
        memory_class: typeof rawBody.memory_class === "string" ? rawBody.memory_class : undefined,
        recall_policy: typeof rawBody.recall_policy === "string" ? rawBody.recall_policy : undefined,
        policy_action: typeof rawBody.policy_action === "string" ? rawBody.policy_action : undefined,
        source: typeof rawBody.source === "string" ? rawBody.source : undefined,
      });
    }
    case "mcp_approve_memory": {
      const rawBody = isPlainObject(payload) ? (payload as Record<string, unknown>) : {};
      return await orchestrator.mcp_approve_memory({
        memory_id: String(rawBody.memory_id ?? ""),
        reviewer_id: String(rawBody.reviewer_id ?? "memory-xx"),
        reason: typeof rawBody.reason === "string" ? rawBody.reason : undefined,
      });
    }
    case "mcp_reject_memory": {
      const rawBody = isPlainObject(payload) ? (payload as Record<string, unknown>) : {};
      return await orchestrator.mcp_reject_memory({
        memory_id: String(rawBody.memory_id ?? ""),
        reviewer_id: String(rawBody.reviewer_id ?? "memory-xx"),
        reason: String(rawBody.reason ?? "rejected via MCP"),
      });
    }
    case "repair_memory_consistency":
      return await orchestrator.repair_memory_consistency({
        dry_run: payload.dry_run !== false,
      });
    case "read_memory": {
      const db = deps.writeDatabase;
      if (!db) throw new Error("运行时尚未初始化");
      const readRaw = isPlainObject(payload) ? (payload as Record<string, unknown>) : {};
      let lookupId = readOptionalTrimmedString(readRaw.memoryId) ?? readOptionalTrimmedString(readRaw.memory_id) ?? "";
      const pathLookup = readOptionalTrimmedString(readRaw.path) ?? "";
      if (!lookupId && pathLookup.startsWith("memory-xx/") && pathLookup.endsWith(".md")) {
        lookupId = decodeURIComponent(pathLookup.slice("memory-xx/".length, -".md".length));
      }
      if (!lookupId) throw Object.assign(new Error("缺少必填字段：memoryId 或 path（记忆路径）"), { code: "invalid_input" });
      const snap = await db.snapshotForMemoryIds([lookupId]);
      const rec = snap.memoryRecords.find((r) => r.id === lookupId);
      if (!rec) throw Object.assign(new Error("memory_not_found"), { code: "record_not_found" });
      return {
        memory: {
          id: rec.id,
          content: rec.content,
          title: rec.title,
          summary: rec.summary,
          scope_type: rec.scopeType,
          scope_id: rec.scopeId,
          lifecycle_status: rec.lifecycleStatus,
          review_state: rec.reviewState,
          is_current: rec.isCurrent,
          metadata: rec.metadata,
          created_at: rec.createdAt,
          updated_at: rec.updatedAt,
        },
      };
    }
    default:
      throw new Error(`不支持的 orchestrator action（编排动作）：${String(action)}`);
  }
}

function scopeRefsFromMemoryCountsPayload(payload: Record<string, unknown>): readonly ScopeRef[] {
  const rawScopeType = readOptionalTrimmedString(payload.scopeType) ?? readOptionalTrimmedString(payload.scope_type);
  const scopeId = readOptionalTrimmedString(payload.scopeId) ?? readOptionalTrimmedString(payload.scope_id);
  if (!rawScopeType || !scopeId) return globalScope();
  return [{ scopeType: resolveScopeType(rawScopeType), scopeId }];
}

function validatePaginationPayload(
  res: ServerResponse,
  payload: Record<string, unknown>
): boolean {
  for (const key of ["limit", "offset"] as const) {
    if (payload[key] !== undefined && (!Number.isInteger(payload[key]) || Number(payload[key]) < 0)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `${key}_must_be_non_negative_integer` }));
      return false;
    }
  }
  if (typeof payload.limit === "number" && (payload.limit < 1 || payload.limit > 100)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "limit_must_be_between_1_and_100" }));
    return false;
  }
  return true;
}

async function enforceOrchestratorScope(
  req: IncomingMessage,
  res: ServerResponse,
  action: MemoryOrchestratorAction | "recall_memory_legacy",
  payload: OrchestratorHttpBody,
  handlerDeps?: Partial<HandlerDeps>
): Promise<boolean> {
  const deps = getDeps(handlerDeps);
  const context = { permissions: deps.permissions, env: deps.env, writeDatabase: deps.writeDatabase };
  const raw = isPlainObject(payload) ? (payload as Record<string, unknown>) : {};
  switch (action) {
    case "resolve_scope_plan": {
      const rawRecallRequest = isPlainObject(raw.recall_request) ? (raw.recall_request as Record<string, unknown>) : raw;
      const rawWriteScopeHint = isPlainObject(raw.write_scope_hint) ? (raw.write_scope_hint as Record<string, unknown>) : raw;
      const recallRequest = buildRecallRequestFromBody(rawRecallRequest);
      const writeScope = buildWriteScopeHintFromBody(rawWriteScopeHint);
      const scopes = [
        ...scopeRefsFromScopeContext(recallRequest.scope_context),
        ...(writeScope ? [{ scopeType: writeScope.scope_type, scopeId: writeScope.scope_id }] : []),
      ];
      return enforceScopePermission(req, res, context, "memory:read", scopes);
    }
    case "write_memory": {
      const rawCommand = isPlainObject(raw.command) ? (raw.command as Record<string, unknown>) : raw;
      const command = buildCreateCommandFromBody(rawCommand);
      return enforceScopePermission(req, res, context, "memory:write", [{ scopeType: command.scopeType, scopeId: command.scopeId }]);
    }
    case "recall_memory":
    case "recall_memory_legacy":
    case "summarize_memory": {
      const rawRequest = isPlainObject(raw.request) ? (raw.request as Record<string, unknown>) : raw;
      const request = buildRecallRequestFromBody(rawRequest);
      if (rejectRuntimeScopeOnlyRecall(res, request)) {
        return false;
      }
      return enforceScopePermission(req, res, context, "memory:read", scopeRefsFromScopeContext(request.scope_context));
    }
    case "memory_counts":
      return enforceScopePermission(req, res, context, "memory:read", scopeRefsFromMemoryCountsPayload(raw));
    case "forget_memory":
      {
        const memoryId = readOptionalTrimmedString(raw.memoryId) ?? readOptionalTrimmedString(raw.memory_id);
        if (!memoryId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "缺少必填字段：memoryId 或 memory_id（记忆 ID）" }));
          return false;
        }
        return enforceMemoryIdPermission(req, res, context, "memory:governance_revert", [memoryId]);
      }
    case "read_memory": {
      const memoryId = readOptionalTrimmedString(raw.memoryId) ?? readOptionalTrimmedString(raw.memory_id);
      if (!memoryId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "缺少必填字段：memoryId 或 memory_id（记忆 ID）" }));
        return false;
      }
      return enforceMemoryIdPermission(req, res, context, "memory:read", [memoryId]);
    }
    case "list_pending_memories": {
      if (!validatePaginationPayload(res, raw)) {
        return false;
      }
      const scopeType = readOptionalTrimmedString(raw.scope_type);
      const scopeId = readOptionalTrimmedString(raw.scope_id);
      const scopes = scopeType && scopeId ? [{ scopeType: resolveScopeType(scopeType), scopeId }] : globalScope();
      return enforceScopePermission(req, res, context, "memory:read", scopes);
    }
    case "mcp_approve_memory":
    case "mcp_reject_memory":
      return enforceMemoryIdPermission(req, res, context, "memory:governance_apply", [readOptionalTrimmedString(raw.memory_id) ?? ""]);
    case "audit_memory_consistency":
      return enforceScopePermission(req, res, context, "memory:read", globalScope());
    case "repair_memory_consistency":
      return enforceScopePermission(req, res, context, "memory:governance_apply", globalScope());
    default:
      return true;
  }
}

export async function handleOrchestrator(req: IncomingMessage, res: ServerResponse, action: MemoryOrchestratorAction | "recall_memory_legacy", handlerDeps?: Partial<HandlerDeps>): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "请求方法不允许" }));
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
  try {
    const payload = (body ?? {}) as OrchestratorHttpBody;
    if (!(await enforceOrchestratorScope(req, res, action, payload, handlerDeps))) {
      return;
    }
    const result = await executeOrchestratorAction(action, payload, handlerDeps);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    const status = resolveWriteErrorStatus(err);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status >= 500 ? { error: "内部服务错误" } : { error: (err as Error).message }));
  }
}

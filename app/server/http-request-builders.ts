import { randomUUID } from "node:crypto";

import {
  FilterMode,
  LifecycleStatus,
  ReviewState,
  ScopeType,
  type JsonObject
} from "../shared";
import type { CreateMemoryCommand } from "../shared/contracts/write";
import { QueryType, type RecallRequest } from "../recall/types";
import { validateWriteBody } from "./input-validation";
import {
  hasCallerSuppliedLongTermScope,
  isPlainObject,
  isRuntimeScopeType,
  readHybridMode,
  readOptionalTrimmedString,
  readStringArray,
  readTemporalScope,
  resolveScopeType,
} from "./http-handler-parsing";

export function buildWriteScopeHintFromBody(body: Record<string, unknown>) {
  const scopeType = readOptionalTrimmedString(body.scopeType);
  const scopeId = readOptionalTrimmedString(body.scopeId);
  if (!scopeType || !scopeId) {
    return undefined;
  }
  return {
    scope_type: resolveScopeType(scopeType),
    scope_id: scopeId,
  };
}

export function buildRecallRequestFromBody(body: Record<string, unknown>): RecallRequest {
  const callerScopeContext = isPlainObject(body.scope_context)
    ? (body.scope_context as RecallRequest["scope_context"])
    : {};
  const explicitScopeType = readOptionalTrimmedString(body.scopeType);
  const explicitScopeId = readOptionalTrimmedString(body.scopeId);
  const resolvedExplicitScopeType =
    explicitScopeType && explicitScopeId ? resolveScopeType(explicitScopeType) : undefined;

  const scopeContext: RecallRequest["scope_context"] = { ...callerScopeContext };

  if (resolvedExplicitScopeType === ScopeType.User && explicitScopeId) scopeContext.user_id = explicitScopeId;
  if (resolvedExplicitScopeType === ScopeType.Workspace && explicitScopeId) scopeContext.workspace_id = explicitScopeId;
  if (resolvedExplicitScopeType === ScopeType.Project && explicitScopeId) scopeContext.project_ids = [explicitScopeId];
  if (resolvedExplicitScopeType === ScopeType.Global) scopeContext.include_global = true;
  if (resolvedExplicitScopeType === ScopeType.Run && explicitScopeId) scopeContext.runtime = { ...(scopeContext.runtime ?? {}), run_id: explicitScopeId };
  if (resolvedExplicitScopeType === ScopeType.Task && explicitScopeId) scopeContext.runtime = { ...(scopeContext.runtime ?? {}), task_id: explicitScopeId };
  const topLevelMemoryIds = readStringArray(body.memory_ids);
  if (topLevelMemoryIds && topLevelMemoryIds.length > 0) {
    (scopeContext as RecallRequest["scope_context"] & { memory_ids?: string[] }).memory_ids = topLevelMemoryIds;
  }
  const sessionId = readOptionalTrimmedString(body.session_id);
  const taskId = readOptionalTrimmedString(body.task_id);
  if (sessionId || taskId) {
    scopeContext.runtime = {
      ...(scopeContext.runtime ?? {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(taskId ? { task_id: taskId } : {})
    };
  }

  const hasExplicitScope = resolvedExplicitScopeType !== undefined;
  const callerSuppliedLongTermScope = hasCallerSuppliedLongTermScope(scopeContext);
  const needsDefaultLongTermScope = !hasExplicitScope && !callerSuppliedLongTermScope;
  const debug = body.debug && typeof body.debug === "object"
    ? { ...(body.debug as RecallRequest["debug"]) }
    : {};
  debug.scope_context_source = needsDefaultLongTermScope ? "defaulted" : "caller_explicit";
  debug.default_scope_injected = needsDefaultLongTermScope;

  return {
    query: typeof body.query === "string" ? body.query.trim() : "",
    scope_context: {
      workspace_id: scopeContext.workspace_id ?? (needsDefaultLongTermScope ? "current-instance" : undefined),
      user_id: scopeContext.user_id ?? (needsDefaultLongTermScope ? "current-instance-owner" : undefined),
      project_ids: scopeContext.project_ids,
      include_global: scopeContext.include_global ?? (needsDefaultLongTermScope ? true : false),
      runtime: scopeContext.runtime,
      memory_ids: (scopeContext as RecallRequest["scope_context"] & { memory_ids?: string[] }).memory_ids,
    },
    query_type_hint: (() => {
        const hintMap: Record<string, string> = { "known_item_lookup": "exact_lookup", "temporal_recent": "timeline_history" };
        const raw = typeof body.query_type_hint === "string" ? body.query_type_hint : "";
        const resolved = hintMap[raw] ?? raw;
        return Object.values(QueryType).includes(resolved as QueryType)
          ? (resolved as RecallRequest["query_type_hint"])
          : undefined;
      })(),
    filter_mode:
      body.filter_mode === "all" || body.filter_mode === "governance" || body.filter_mode === "shadow_compare"
        ? (body.filter_mode as FilterMode)
        : FilterMode.Default,
    debug,
    limit: typeof body.limit === "number" ? body.limit : 6,
    offset: typeof body.offset === "number" ? body.offset : 0,
    explain: body.explain === true,
    rerank: typeof body.rerank === "boolean" ? body.rerank : undefined,
    temporal_scope: readTemporalScope(body.temporal_scope),
    memory_layers: readStringArray(body.memory_layers),
    session_id: sessionId,
    turn_id: readOptionalTrimmedString(body.turn_id),
    context_queries: readStringArray(body.context_queries),
    current_goal: readOptionalTrimmedString(body.current_goal),
    task_id: taskId,
    scope_conflict_policy: readOptionalTrimmedString(body.scope_conflict_policy) as RecallRequest["scope_conflict_policy"],
    hybrid_mode: readHybridMode(body.hybrid_mode),
  };
}

export function buildCreateCommandFromBody(body: Record<string, unknown>): CreateMemoryCommand {
  const validation = validateWriteBody(body);
  if (!validation.valid) {
    const error = new Error(validation.error);
    (error as Error & { code?: string }).code = "invalid_input";
    throw error;
  }
  const validated = validation.value;
  const scopeType = resolveScopeType(validated.scopeType);
  if (isRuntimeScopeType(scopeType)) {
    const error = new Error("runtime_scope_not_supported_for_write");
    (error as Error & { code?: string }).code = "invalid_input";
    (error as Error & { publicMessage?: string }).publicMessage =
      "run/task/execution scopes are runtime-only recall context and cannot be stored in the long-term memory ledger.";
    throw error;
  }
  return {
    requestId: readOptionalTrimmedString(body.requestId) ?? randomUUID(),
    actorId: readOptionalTrimmedString(body.actorId) ?? "memory-xx",
    scopeType,
    scopeId: validated.scopeId.trim(),
    content: validated.content,
    title: validated.title ?? null,
    summary: typeof body.summary === "string" ? body.summary : null,
    metadata: (validated.metadata ?? {}) as JsonObject,
    dedupeKey: validated.dedupeKey?.trim() ?? null,
    memoryType: readOptionalTrimmedString(body.memoryType) ?? readOptionalTrimmedString(body.memory_type) ?? null,
    validAt: readOptionalTrimmedString(body.valid_at) ?? readOptionalTrimmedString(body.validAt) ?? null,
    observedAt: readOptionalTrimmedString(body.observed_at) ?? readOptionalTrimmedString(body.observedAt) ?? null,
    expiresAt: readOptionalTrimmedString(body.expires_at) ?? readOptionalTrimmedString(body.expiresAt) ?? null,
    lifecycleStatus: validated.lifecycleStatus ?? LifecycleStatus.Candidate,
    reviewState: validated.reviewState ?? ReviewState.Pending,
    sources: Array.isArray(body.sources) ? (body.sources as CreateMemoryCommand["sources"]) : [],
    relations: validated.relations ?? [],
  };
}

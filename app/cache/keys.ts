import { createHash } from "node:crypto";

import type { QueryClassification, RecallRequest, RecallScopeRef } from "../recall/types";
import { ScopeType } from "../shared";

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function normalizeScopes(scopes: readonly RecallScopeRef[]): string[] {
  return scopes.map((scope) => `${scope.type}:${scope.id}`).sort((left, right) => left.localeCompare(right));
}

function embeddingCacheContext(): Record<string, string> {
  return {
    generation_id: process.env.MEMORY_V2_EMBEDDING_GENERATION_ID?.trim() || "unknown-generation",
    query_cache_version: process.env.MEMORY_V2_QUERY_EMBEDDING_CACHE_VERSION?.trim() || "unknown-query-cache-version",
    model: process.env.MEMORY_V2_EMBEDDING_MODEL?.trim() || process.env.EMBEDDING_MODEL?.trim() || "unknown-model",
    dims: process.env.MEMORY_V2_EMBEDDING_DIMS?.trim() || process.env.EMBEDDING_DIMS?.trim() || "unknown-dims"
  };
}

export function buildSearchCacheKey(prefix: string, request: RecallRequest): string {
  return [prefix, "cache", "search", stableHash({
    embedding: embeddingCacheContext(),
    query: request.query.trim().toLowerCase(),
    context_queries: request.context_queries ?? [],
    current_goal: request.current_goal ?? null,
    task_id: request.task_id ?? request.scope_context.runtime?.task_id ?? null,
    session_id: request.session_id ?? request.scope_context.runtime?.session_id ?? null,
    scope_context: request.scope_context,
    filter_mode: request.filter_mode,
    query_type_hint: request.query_type_hint,
    rerank: request.rerank ?? null,
    hybrid_mode: request.hybrid_mode ?? null,
    strategy_version: "recall-v3-rrf-k20",
    reranker_config_version: [
      process.env.MEMORY_V2_RERANKER_MODEL_WEIGHT ?? "0.25",
      process.env.MEMORY_V2_RERANKER_MIN_CANDIDATES ?? "4",
      process.env.MEMORY_V2_RERANKER_LOCAL_TOP3_GAP_THRESHOLD ?? "0.20"
    ].join(":"),
    limit: request.limit ?? 0,
    offset: request.offset ?? 0
  })].join(":");
}

export function buildStartupContextCacheKey(prefix: string, request: RecallRequest, classification: QueryClassification): string {
  return [prefix, "cache", "startup-context", stableHash({
    query: request.query.trim().toLowerCase(),
    query_type: classification.query_type,
    user_id: request.scope_context.user_id,
    workspace_id: request.scope_context.workspace_id,
    project_ids: request.scope_context.project_ids ?? [],
    include_global: request.scope_context.include_global ?? true
  })].join(":");
}

export function buildSessionCacheKey(prefix: string, request: RecallRequest): string | null {
  const runtime = request.scope_context.runtime;
  const sessionId = request.session_id ?? runtime?.session_id ?? runtime?.run_id ?? runtime?.task_id;
  if (!sessionId) {
    return null;
  }

  return [prefix, "cache", "session", stableHash({
    session_id: sessionId,
    scopes: normalizeScopes(scopeRefsFromScopeContextLike(request))
  })].join(":");
}

function scopeRefsFromScopeContextLike(request: RecallRequest): RecallScopeRef[] {
  const scopes: RecallScopeRef[] = [];
  if (request.scope_context.user_id) scopes.push({ type: ScopeType.User, id: request.scope_context.user_id });
  for (const projectId of request.scope_context.project_ids ?? []) {
    scopes.push({ type: ScopeType.Project, id: projectId });
  }
  if (request.scope_context.workspace_id) scopes.push({ type: ScopeType.Workspace, id: request.scope_context.workspace_id });
  if (request.scope_context.include_global) scopes.push({ type: ScopeType.Global, id: "global" });
  return scopes;
}

export function buildRecentCacheKey(prefix: string, scopes: readonly RecallScopeRef[]): string | null {
  if (scopes.length === 0) {
    return null;
  }

  return [prefix, "cache", "recent", stableHash(normalizeScopes(scopes))].join(":");
}

export function buildScopeInvalidationPattern(prefix: string, scope: RecallScopeRef): string {
  return [prefix, "cache", "scope", `${scope.type}:${scope.id}`, "*"].join(":");
}

export function buildScopeIndexKey(prefix: string, scope: RecallScopeRef): string {
  return [prefix, "cache", "scope", `${scope.type}:${scope.id}`, "keys"].join(":");
}

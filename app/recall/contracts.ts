import { API_PREFIXES, DEFAULT_FILTER_MODE, FilterMode } from "../shared";
import { RecallError, RecallErrorCode } from "./errors";
import { type RecallRequest, type RecallResponse } from "./types";

export const RECALL_QUERY_ROUTE = {
  method: "POST",
  path: `${API_PREFIXES.recall}/query`
} as const;

export interface RecallHttpRequest {
  body?: unknown;
}

export interface RecallHttpResponse {
  status: number;
  body:
    | RecallResponse
    | { error: { code: string; message: string; details?: Record<string, unknown> } };
}

const FILTER_MODES = new Set<string>(Object.values(FilterMode));
export const MAX_RECALL_QUERY_LENGTH = 4096;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new RecallError(
      RecallErrorCode.InvalidScopeContext,
      "scope_context contains a non-string scope identifier"
    );
  }

  return value;
}

function asContextBundleMode(value: unknown): RecallRequest["context_bundle"] | undefined {
  return value === false || value === "summary" || value === "full" ? value : undefined;
}

function asContextBundleBudget(value: unknown): RecallRequest["context_bundle_budget"] | undefined {
  if (!isPlainObject(value)) return undefined;
  return {
    l0AlwaysResident: typeof value.l0AlwaysResident === "number" ? value.l0AlwaysResident : undefined,
    l1PinnedScopeFacts: typeof value.l1PinnedScopeFacts === "number" ? value.l1PinnedScopeFacts : undefined,
    l2QueryWorkingSet: typeof value.l2QueryWorkingSet === "number" ? value.l2QueryWorkingSet : undefined,
    l3ExpandableDeepMemory: typeof value.l3ExpandableDeepMemory === "number" ? value.l3ExpandableDeepMemory : undefined,
  };
}

export function parseRecallRequest(input: unknown): RecallRequest {
  if (!isPlainObject(input)) {
    throw new RecallError(
      RecallErrorCode.QueryEmpty,
      "recall request body must be an object"
    );
  }

  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) {
    throw new RecallError(
      RecallErrorCode.QueryEmpty,
      "query must be a non-empty string"
    );
  }
  if (query.length > MAX_RECALL_QUERY_LENGTH) {
    throw new RecallError(
      RecallErrorCode.QueryTooLong,
      `query must be at most ${MAX_RECALL_QUERY_LENGTH} characters`,
      { max_length: MAX_RECALL_QUERY_LENGTH }
    );
  }

  if (!isPlainObject(input.scope_context)) {
    throw new RecallError(
      RecallErrorCode.InvalidScopeContext,
      "scope_context is required"
    );
  }

  const rawScopeContext = input.scope_context;
  const filterModeRaw = input.filter_mode;

  if (
    filterModeRaw !== undefined &&
    (typeof filterModeRaw !== "string" || !FILTER_MODES.has(filterModeRaw))
  ) {
    throw new RecallError(
      RecallErrorCode.InvalidFilterMode,
      "filter_mode is invalid",
      { filter_mode: filterModeRaw }
    );
  }

  const limit =
    typeof input.limit === "number"
      ? Math.max(1, Math.min(50, Math.floor(input.limit)))
      : 10;
  const offset =
    typeof input.offset === "number" ? Math.max(0, Math.floor(input.offset)) : 0;

  return {
    query,
    scope_context: {
      user_id:
        typeof rawScopeContext.user_id === "string"
          ? rawScopeContext.user_id
          : undefined,
      project_ids: asStringArray(rawScopeContext.project_ids),
      workspace_id:
        typeof rawScopeContext.workspace_id === "string"
          ? rawScopeContext.workspace_id
          : undefined,
      include_global:
        typeof rawScopeContext.include_global === "boolean"
          ? rawScopeContext.include_global
          : undefined,
      runtime: isPlainObject(rawScopeContext.runtime)
        ? {
            run_id:
              typeof rawScopeContext.runtime.run_id === "string"
                ? rawScopeContext.runtime.run_id
                : undefined,
            task_id:
              typeof rawScopeContext.runtime.task_id === "string"
                ? rawScopeContext.runtime.task_id
                : undefined
          }
        : undefined
    },
    filter_mode: (filterModeRaw as FilterMode | undefined) ?? DEFAULT_FILTER_MODE,
    query_type_hint:
      typeof input.query_type_hint === "string"
        ? (input.query_type_hint as RecallRequest["query_type_hint"])
        : undefined,
    debug: isPlainObject(input.debug)
      ? {
          enabled:
            typeof input.debug.enabled === "boolean"
              ? input.debug.enabled
              : undefined,
          include_strategy_plan:
            typeof input.debug.include_strategy_plan === "boolean"
              ? input.debug.include_strategy_plan
              : undefined,
          allow_privileged_filter_modes:
            typeof input.debug.allow_privileged_filter_modes === "boolean"
              ? input.debug.allow_privileged_filter_modes
              : undefined,
          scope_context_source:
            input.debug.scope_context_source === "caller_explicit" || input.debug.scope_context_source === "defaulted"
              ? input.debug.scope_context_source
              : undefined,
          default_scope_injected:
            typeof input.debug.default_scope_injected === "boolean"
              ? input.debug.default_scope_injected
              : undefined
        }
      : undefined,
    explain: typeof input.explain === "boolean" ? input.explain : undefined,
    limit,
    offset,
    include_knowledge: input.include_knowledge === true,
    knowledge_collections: asStringArray(input.knowledge_collections),
    knowledge_repos: asStringArray(input.knowledge_repos ?? input.repos),
    knowledge_budget: typeof input.knowledge_budget === "number" ? Math.max(1, Math.min(50, Math.floor(input.knowledge_budget))) : undefined,
    context_bundle: asContextBundleMode(input.context_bundle),
    context_bundle_budget: asContextBundleBudget(input.context_bundle_budget)
  };
}

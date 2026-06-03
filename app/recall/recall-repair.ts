import type { JsonObject, JsonValue } from "../shared";

export const RECALL_REPAIR_ROOT_CAUSE_TYPES = [
  "projection_gap",
  "embedding_gap",
  "alias_missing",
  "scope_mismatch",
  "temporal_filter_too_strict",
  "memory_absent",
  "rerank_demoted"
] as const;

export type RecallRepairRootCauseType = typeof RECALL_REPAIR_ROOT_CAUSE_TYPES[number];

const ROOT_CAUSE_SET = new Set<string>(RECALL_REPAIR_ROOT_CAUSE_TYPES);

export function isRecallRepairRootCauseType(value: unknown): value is RecallRepairRootCauseType {
  return typeof value === "string" && ROOT_CAUSE_SET.has(value);
}

export function normalizeRecallRepairRootCauseType(value: unknown): RecallRepairRootCauseType | null {
  if (isRecallRepairRootCauseType(value)) {
    return value;
  }
  return null;
}

export function resolveRecallRepairRootCauseType(input: {
  readonly rootCauseType?: unknown;
  readonly rootCause?: unknown;
  readonly details?: JsonObject | null;
  readonly memoryId?: string | null;
}): RecallRepairRootCauseType {
  return (
    normalizeRecallRepairRootCauseType(input.rootCauseType) ??
    normalizeRecallRepairRootCauseType(input.rootCause) ??
    normalizeRecallRepairRootCauseType(input.details?.root_cause_type) ??
    normalizeRecallRepairRootCauseType(input.details?.root_cause) ??
    (input.memoryId ? "projection_gap" : "embedding_gap")
  );
}

export function defaultRecallRepairSuggestedAction(rootCauseType: RecallRepairRootCauseType): string {
  switch (rootCauseType) {
    case "projection_gap":
      return "reproject_memory";
    case "embedding_gap":
      return "reproject_then_consider_lexical_weight";
    case "alias_missing":
      return "suggest_alias";
    case "scope_mismatch":
      return "suggest_scope_config";
    case "temporal_filter_too_strict":
      return "suggest_temporal_window";
    case "memory_absent":
      return "mark_true_null";
    case "rerank_demoted":
      return "suggest_rerank_weight";
  }
}

export function buildRecallRepairDetails(input: {
  readonly scope?: JsonObject | null;
  readonly queryHash: string;
  readonly rootCauseType: RecallRepairRootCauseType;
  readonly memoryId?: string | null;
  readonly suggestedAction?: string | null;
  readonly suggestedValues?: JsonObject | null;
  readonly extra?: JsonObject | null;
}): JsonObject {
  const suggestedAction = input.suggestedAction?.trim() ||
    defaultRecallRepairSuggestedAction(input.rootCauseType);
  const suggestedValues = input.suggestedValues ??
    defaultSuggestedValues(input.rootCauseType, input.memoryId ?? null);
  const details: Record<string, JsonValue> = {
    ...(input.extra ?? {}),
    root_cause_type: input.rootCauseType,
    scope: input.scope ?? {},
    query_hash: input.queryHash,
    suggested_values: suggestedValues,
    suggested_action: suggestedAction
  };
  if (input.memoryId) {
    details.memory_id = input.memoryId;
  }

  const primaryScope = inferPrimaryScope(input.scope ?? {});
  if (primaryScope) {
    details.scope_type = primaryScope.scope_type;
    details.scope_id = primaryScope.scope_id;
  }

  return details as JsonObject;
}

export function inferPrimaryScope(scope: JsonObject): { readonly scope_type: string; readonly scope_id: string } | null {
  const projectIds = stringArray(scope.project_ids);
  if (projectIds.length > 0) {
    return { scope_type: "project", scope_id: projectIds[0]! };
  }

  if (typeof scope.user_id === "string" && scope.user_id.trim() !== "") {
    return { scope_type: "user", scope_id: scope.user_id.trim() };
  }

  if (typeof scope.workspace_id === "string" && scope.workspace_id.trim() !== "") {
    return { scope_type: "workspace", scope_id: scope.workspace_id.trim() };
  }

  if (scope.include_global === true) {
    return { scope_type: "global", scope_id: "global" };
  }

  return null;
}

function defaultSuggestedValues(
  rootCauseType: RecallRepairRootCauseType,
  memoryId: string | null
): JsonObject {
  const base: Record<string, JsonValue> = memoryId ? { memory_id: memoryId } : {};
  switch (rootCauseType) {
    case "projection_gap":
      return { ...base, projection_target: "qdrant" } as JsonObject;
    case "embedding_gap":
      return { ...base, candidate_repair: "refresh_embedding_or_lexical_weight" } as JsonObject;
    case "alias_missing":
      return { ...base, aliases: [] } as JsonObject;
    case "scope_mismatch":
      return { ...base, scope_config_candidate: {} } as JsonObject;
    case "temporal_filter_too_strict":
      return { ...base, temporal_scope_candidate: "all" } as JsonObject;
    case "memory_absent":
      return { ...base, true_null: true } as JsonObject;
    case "rerank_demoted":
      return { ...base, rerank_weight_candidate: {} } as JsonObject;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim())
    : [];
}

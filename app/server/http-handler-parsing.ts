import { ScopeType } from "../shared";
import type { RecallRequest } from "../recall/types";

export function resolveScopeType(raw: string): ScopeType {
  const map: Record<string, ScopeType> = {
    personal: ScopeType.User,
    shared: ScopeType.Workspace,
    execution: ScopeType.Run,
    user: ScopeType.User,
    workspace: ScopeType.Workspace,
    run: ScopeType.Run,
    project: ScopeType.Project,
    global: ScopeType.Global,
    task: ScopeType.Task,
  };
  const resolved = map[raw.toLowerCase()];
  if (!resolved) {
    throw new Error(
      `Unknown scope-type "${raw}". Supported: personal, shared, execution, user, workspace, run, project, global, task`
    );
  }
  return resolved;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readOptionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : undefined;
}

export function readHybridMode(value: unknown): RecallRequest["hybrid_mode"] | undefined {
  const mode = readOptionalTrimmedString(value);
  return mode === "separate" || mode === "rrf" || mode === "model_rerank" ? mode : undefined;
}

export function isRuntimeScopeType(scopeType: ScopeType): boolean {
  return scopeType === ScopeType.Run || scopeType === ScopeType.Task;
}

export function hasLongTermRecallScope(scopeContext: RecallRequest["scope_context"]): boolean {
  return Boolean(
    scopeContext.user_id ||
    scopeContext.workspace_id ||
    scopeContext.include_global ||
    (scopeContext.project_ids?.length ?? 0) > 0 ||
    ((scopeContext as RecallRequest["scope_context"] & { memory_ids?: readonly string[] }).memory_ids?.length ?? 0) > 0
  );
}

export function hasCallerSuppliedLongTermScope(scopeContext: RecallRequest["scope_context"]): boolean {
  return Boolean(
    scopeContext.user_id ||
    scopeContext.workspace_id ||
    typeof scopeContext.include_global === "boolean" ||
    (scopeContext.project_ids?.length ?? 0) > 0 ||
    ((scopeContext as RecallRequest["scope_context"] & { memory_ids?: readonly string[] }).memory_ids?.length ?? 0) > 0
  );
}

export function readTemporalScope(value: unknown): RecallRequest["temporal_scope"] | undefined {
  const scope = readOptionalTrimmedString(value);
  return scope === "current" || scope === "historical" || scope === "all" ? scope : undefined;
}

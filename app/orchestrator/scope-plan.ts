import { resolveAllowedScopeSet } from "../recall/scope-resolver";
import type { RecallScopeRef } from "../recall/types";
import {
  ScopeType,
  Visibility,
  resolveAllowedVisibilitiesFromScopeContext,
  resolveAllowedVisibilitiesFromScopeNames
} from "../shared";
import type { ResolveScopePlanRequest, ResolveScopePlanResponse } from "./types";

function firstScopeByPriority(scopes: readonly RecallScopeRef[]): RecallScopeRef | null {
  const priority: ScopeType[] = [ScopeType.Project, ScopeType.Workspace, ScopeType.User, ScopeType.Global];
  for (const type of priority) {
    const match = scopes.find((scope) => scope.type === type);
    if (match) {
      return match;
    }
  }
  return scopes[0] ?? null;
}

function resolveSuggestedWriteScope(input: ResolveScopePlanRequest, allowedScopes: readonly RecallScopeRef[]) {
  const hintedType = input.write_scope_hint?.scope_type;
  const hintedId = input.write_scope_hint?.scope_id?.trim();
  if (hintedType && hintedId) {
    return {
      scopeType: hintedType,
      scopeId: hintedId,
      source: "hint" as const,
    };
  }

  const preferred = firstScopeByPriority(
    allowedScopes.filter(
      (scope) =>
        scope.type === ScopeType.Project ||
        scope.type === ScopeType.Workspace ||
        scope.type === ScopeType.User ||
        scope.type === ScopeType.Global,
    ),
  );
  if (!preferred) {
    return null;
  }
  return {
    scopeType: preferred.type,
    scopeId: preferred.id,
    source: "derived" as const,
  };
}

function resolveAllowedVisibilitiesFromSnapshot(input: ResolveScopePlanRequest): readonly Visibility[] | null {
  const recallScopes = input.memory_scope_snapshot?.memoryScope.recallScopes;
  if (!recallScopes?.length) {
    return null;
  }
  return resolveAllowedVisibilitiesFromScopeNames(recallScopes);
}

function resolveAllowedVisibilities(input: ResolveScopePlanRequest): readonly Visibility[] {
  return (
    resolveAllowedVisibilitiesFromSnapshot(input) ??
    resolveAllowedVisibilitiesFromScopeContext(input.recall_request.scope_context)
  );
}

export async function resolveOrchestratorScopePlan(input: ResolveScopePlanRequest): Promise<ResolveScopePlanResponse> {
  const resolved = await resolveAllowedScopeSet(input.recall_request);
  return {
    allowed_scope_set: resolved.allowed_scope_set,
    long_term_scopes: resolved.long_term_scopes,
    runtime_scopes: resolved.runtime_scopes,
    allowedVisibilities: resolveAllowedVisibilities(input),
    degraded: resolved.degraded,
    degrade_reasons: resolved.degrade_reasons,
    suggested_write_scope: resolveSuggestedWriteScope(input, resolved.allowed_scope_set),
  };
}

import { FilterMode, ScopeType, Visibility } from "../types";

/**
 * Stable presentation order for route/runtime allowance summaries that reuse the
 * canonical visibility vocabulary.
 */
export const STABLE_VISIBILITY_ORDER: readonly Visibility[] = [
  Visibility.Shared,
  Visibility.Personal,
  Visibility.Research,
  Visibility.Governance,
  Visibility.Execution
];

const CANONICAL_VISIBILITY_SET = new Set<string>(Object.values(Visibility));

export type MemoryVisibilityPersistenceMode =
  | "first_batch_persistable"
  | "derived_only_until_schema_lands";

/**
 * Formal business-semantic carrier for memory-level visibility.
 *
 * Important boundary:
 * - `visibility` is now a real contract-level semantic field.
 * - In the current A-side first cut it is still derived from existing
 *   `scope_type/scope_id + route/filter governance semantics`.
 * - This does NOT imply a memory-record table column already exists.
 */
export interface MemoryVisibilityContract {
  readonly visibility: Visibility;
  readonly persistenceMode: MemoryVisibilityPersistenceMode;
  readonly derivedFrom: "scope_type_scope_id_plus_explanation_layer";
  readonly explanation: string;
}

export interface ResolveMemoryVisibilityInput {
  readonly scopeType: ScopeType;
  /**
   * Governance semantics are carried today by the explanation layer
   * (for example governance/debug filter paths) rather than a physical column.
   */
  readonly filterMode?: FilterMode;
}

export function resolveMemoryVisibility(
  input: ResolveMemoryVisibilityInput
): MemoryVisibilityContract {
  switch (input.scopeType) {
    case ScopeType.User:
      return {
        visibility: Visibility.Personal,
        persistenceMode: "first_batch_persistable",
        derivedFrom: "scope_type_scope_id_plus_explanation_layer",
        explanation:
          "user scope currently derives to personal visibility in the contract layer; this is business semantics, not a physical table column."
      };
    case ScopeType.Workspace:
      return {
        visibility: Visibility.Shared,
        persistenceMode: "first_batch_persistable",
        derivedFrom: "scope_type_scope_id_plus_explanation_layer",
        explanation:
          "workspace scope currently derives to shared visibility in the contract layer; this is business semantics, not a physical table column."
      };
    case ScopeType.Project:
      return {
        visibility: Visibility.Research,
        persistenceMode: "first_batch_persistable",
        derivedFrom: "scope_type_scope_id_plus_explanation_layer",
        explanation:
          "project scope currently derives to research visibility in the contract layer; this is business semantics, not a physical table column."
      };
    case ScopeType.Global:
      return {
        visibility:
          input.filterMode === FilterMode.Governance
            ? Visibility.Governance
            : Visibility.Shared,
        persistenceMode: "first_batch_persistable",
        derivedFrom: "scope_type_scope_id_plus_explanation_layer",
        explanation:
          input.filterMode === FilterMode.Governance
            ? "global scope on governance semantics currently derives to governance visibility; this is business semantics explained by route/filter semantics, not a physical table column."
            : "global scope without governance semantics currently folds into shared visibility for the first-cut explanation layer; this remains derived business semantics, not a physical table column."
      };
    case ScopeType.Run:
    case ScopeType.Task:
      return {
        visibility: Visibility.Execution,
        persistenceMode: "derived_only_until_schema_lands",
        derivedFrom: "scope_type_scope_id_plus_explanation_layer",
        explanation:
          "run/task scope derives to execution visibility only as an extension semantic slot. It is intentionally not promoted into the first-batch persisted visibility semantics."
      };
    default: {
      const exhaustive: never = input.scopeType;
      return exhaustive;
    }
  }
}

export function resolvePersistedVisibility(
  input: ResolveMemoryVisibilityInput
): Visibility | null {
  const resolved = resolveMemoryVisibility(input);
  return resolved.persistenceMode === "first_batch_persistable"
    ? resolved.visibility
    : null;
}

/**
 * Route/runtime memoryScope snapshots already carry the canonical visibility
 * vocabulary (`shared`, `personal`, `research`, `governance`, `execution`).
 *
 * This helper centralizes that allowance-layer parsing so A-side plan summaries
 * do not maintain a second hand-written mapping source beside the formal shared
 * visibility contract.
 */
export function resolveVisibilityFromScopeName(scopeName: string): Visibility | null {
  return CANONICAL_VISIBILITY_SET.has(scopeName) ? (scopeName as Visibility) : null;
}

/**
 * Minimal allowance-layer helper for route/runtime scope-name snapshots.
 *
 * This remains distinct from record-level `visibility` derivation: it summarizes
 * which canonical visibilities a resolved plan can currently touch.
 */
export function resolveAllowedVisibilitiesFromScopeNames(
  scopeNames: readonly string[] | undefined,
): readonly Visibility[] {
  if (!scopeNames?.length) {
    return [];
  }
  const allowed = new Set<Visibility>();
  for (const scopeName of scopeNames) {
    const visibility = resolveVisibilityFromScopeName(scopeName);
    if (visibility) {
      allowed.add(visibility);
    }
  }
  return STABLE_VISIBILITY_ORDER.filter((visibility) => allowed.has(visibility));
}

export interface ResolveAllowedVisibilitiesFromScopeContextInput {
  readonly project_ids?: readonly string[];
  readonly workspace_id?: string;
  readonly include_global?: boolean;
  readonly user_id?: string;
  readonly runtime?: {
    readonly run_id?: string;
    readonly task_id?: string;
  };
}

/**
 * Compatibility fallback for allowance derivation when no resolved
 * memory-scope snapshot is available.
 *
 * This is intentionally a plan-level summary helper and does not imply that the
 * resulting values are persisted on memory records.
 */
export function resolveAllowedVisibilitiesFromScopeContext(
  scopeContext: ResolveAllowedVisibilitiesFromScopeContextInput,
): readonly Visibility[] {
  const allowed = new Set<Visibility>();

  if (scopeContext.project_ids?.length || scopeContext.workspace_id || scopeContext.include_global) {
    allowed.add(Visibility.Shared);
  }
  if (scopeContext.user_id) {
    allowed.add(Visibility.Personal);
  }
  if (scopeContext.runtime?.run_id || scopeContext.runtime?.task_id) {
    allowed.add(Visibility.Execution);
  }

  return STABLE_VISIBILITY_ORDER.filter((visibility) => allowed.has(visibility));
}

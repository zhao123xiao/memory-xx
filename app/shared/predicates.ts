import {
  type CanonicalPredicate,
  type MemoryGovernanceFields,
  LifecycleStatus,
  ReviewState
} from "./types";

export const EFFECTIVE_RECALLABLE_EXPRESSION =
  "lifecycle_status = 'approved' AND is_current = true AND review_state IN ('approved', 'silent_approved', 'not_required') AND recall_policy = 'default'";

export const EFFECTIVE_RECALLABLE_SQL_WHERE_CLAUSE =
  "lifecycle_status = 'approved' AND is_current = TRUE AND review_state IN ('approved', 'silent_approved', 'not_required') AND COALESCE(metadata->>'recall_policy', metadata->'auto_approval_policy'->'memory_policy'->>'recall_policy', 'default') = 'default'";

export function isEffectiveRecallable(
  input: MemoryGovernanceFields
): boolean {
  return (
    input.lifecycleStatus === LifecycleStatus.Approved &&
    input.isCurrent &&
    (input.recallPolicy === undefined ||
      input.recallPolicy === null ||
      input.recallPolicy === "" ||
      input.recallPolicy === "default") &&
    (input.reviewState === ReviewState.Approved ||
      input.reviewState === ReviewState.SilentApproved ||
      input.reviewState === ReviewState.NotRequired)
  );
}

export const EFFECTIVE_RECALLABLE_PREDICATE: CanonicalPredicate<MemoryGovernanceFields> =
  {
    id: "effective_recallable",
    description:
      "Default Recall API and projection visibility predicate frozen by I1.",
    expression: EFFECTIVE_RECALLABLE_EXPRESSION,
    sqlWhereClause: EFFECTIVE_RECALLABLE_SQL_WHERE_CLAUSE,
    evaluate: isEffectiveRecallable
  };

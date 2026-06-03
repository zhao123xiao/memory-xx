import {
  DEFAULT_FILTER_MODE,
  EFFECTIVE_RECALLABLE_EXPRESSION,
  EFFECTIVE_RECALLABLE_PREDICATE,
  EFFECTIVE_RECALLABLE_SQL_WHERE_CLAUSE,
  FilterMode
} from "../shared";
import { RecallError, RecallErrorCode } from "./errors";
import { type RecallFilterPlan, type RecallRecord } from "./types";

function wideOpenPredicate(): (record: RecallRecord) => boolean {
  return () => true;
}

export function buildRecallFilterPlan(input: {
  requested_mode?: FilterMode;
  allow_privileged_filter_modes?: boolean;
}): RecallFilterPlan {
  const requestedMode = input.requested_mode ?? DEFAULT_FILTER_MODE;

  if (
    requestedMode !== FilterMode.Default &&
    !input.allow_privileged_filter_modes
  ) {
    throw new RecallError(
      RecallErrorCode.InvalidFilterMode,
      "non-default filter_mode requires privileged debug mode",
      { filter_mode: requestedMode }
    );
  }

  switch (requestedMode) {
    case FilterMode.Default:
      return {
        requested_mode: requestedMode,
        applied_mode: FilterMode.Default,
        predicate_id: EFFECTIVE_RECALLABLE_PREDICATE.id,
        expression: EFFECTIVE_RECALLABLE_EXPRESSION,
        sql_where_clause: EFFECTIVE_RECALLABLE_SQL_WHERE_CLAUSE,
        evaluate: (record) =>
          EFFECTIVE_RECALLABLE_PREDICATE.evaluate({
            lifecycleStatus: record.lifecycleStatus,
            isCurrent: record.isCurrent,
            reviewState: record.reviewState,
            recallPolicy: record.recallPolicy
          })
      };
    case FilterMode.Governance:
      return {
        requested_mode: requestedMode,
        applied_mode: FilterMode.Governance,
        predicate_id: "governance_visible",
        expression:
          "special governance/debug path without effective_recallable narrowing",
        sql_where_clause: "TRUE",
        evaluate: wideOpenPredicate()
      };
    case FilterMode.All:
      return {
        requested_mode: requestedMode,
        applied_mode: FilterMode.All,
        predicate_id: "all_records",
        expression: "all scoped records",
        sql_where_clause: "TRUE",
        evaluate: wideOpenPredicate()
      };
    case FilterMode.ShadowCompare:
      return {
        requested_mode: requestedMode,
        applied_mode: FilterMode.ShadowCompare,
        predicate_id: "shadow_compare",
        expression: "shadow compare mode without default narrowing",
        sql_where_clause: "TRUE",
        evaluate: wideOpenPredicate()
      };
    default:
      throw new RecallError(
        RecallErrorCode.InvalidFilterMode,
        "filter_mode is invalid",
        { filter_mode: requestedMode }
      );
  }
}

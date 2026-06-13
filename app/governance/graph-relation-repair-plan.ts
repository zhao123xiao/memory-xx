import type { JsonObject } from "../shared/types";
import { isGraphTestFixture } from "./graph-test-fixture";

export type GraphRelationRepairReason =
  | "missing_relation_source"
  | "missing_relation_target"
  | "non_current_relation_target"
  | "non_approved_relation_target";

export type GraphRelationRepairAction =
  | "retarget_relation_to_successor"
  | "review_successor_before_retarget"
  | "archive_relation_or_restore_target";

export type GraphRelationRepairReviewBlocker =
  | "none"
  | "target_missing_or_source_missing"
  | "missing_successor"
  | "ambiguous_successor"
  | "successor_not_approved_current";

export type GraphRelationRepairLane = "production" | "test_only";

export interface GraphRelationRepairPlanRow {
  readonly relation_id: string;
  readonly relation_type: string;
  readonly relation_memory_id: string;
  readonly relation_related_memory_id: string;
  readonly source_exists: boolean;
  readonly source_lifecycle_status: string | null;
  readonly source_is_current: boolean | null;
  readonly source_created_by?: string | null;
  readonly source_agent_id?: string | null;
  readonly source_title?: string | null;
  readonly source_metadata?: JsonObject | null;
  readonly target_exists: boolean;
  readonly target_lifecycle_status: string | null;
  readonly target_is_current: boolean | null;
  readonly target_created_by?: string | null;
  readonly target_agent_id?: string | null;
  readonly target_title?: string | null;
  readonly target_metadata?: JsonObject | null;
  readonly relation_metadata?: JsonObject | null;
  readonly successor_memory_id: string | null;
  readonly successor_lifecycle_status: string | null;
  readonly successor_is_current: boolean | null;
  readonly successor_count: number;
  readonly updated_at: string | null;
}

export interface GraphRelationRepairActionSummary {
  readonly action: GraphRelationRepairAction;
  readonly count: number;
}

export interface GraphRelationRepairReviewBlockerSummary {
  readonly blocker: Exclude<GraphRelationRepairReviewBlocker, "none">;
  readonly count: number;
}

export interface GraphRelationRepairCandidate {
  readonly candidate_type: "graph_relation_repair";
  readonly candidate_id: string;
  readonly relation_id: string;
  readonly relation_type: string;
  readonly source_memory_id: string;
  readonly current_related_memory_id: string;
  readonly suggested_related_memory_id: string | null;
  readonly reason: GraphRelationRepairReason;
  readonly lane: GraphRelationRepairLane;
  readonly suggested_action: GraphRelationRepairAction;
  readonly review_blocker: GraphRelationRepairReviewBlocker;
  readonly apply_allowed: boolean;
  readonly blockers: readonly string[];
  readonly apply_plan?: GraphRelationRetargetApplyPlan;
  readonly evidence: {
    readonly source_exists: boolean;
    readonly source_lifecycle_status: string | null;
    readonly source_is_current: boolean | null;
    readonly target_exists: boolean;
    readonly target_lifecycle_status: string | null;
    readonly target_is_current: boolean | null;
    readonly successor_lifecycle_status: string | null;
    readonly successor_is_current: boolean | null;
    readonly successor_count: number;
    readonly updated_at: string | null;
    readonly report_only: boolean;
  };
}

export interface GraphRelationRetargetApplyPlan {
  readonly kind: "graph_relation_retarget";
  readonly relation_id: string;
  readonly source_memory_id: string;
  readonly old_related_memory_id: string;
  readonly new_related_memory_id: string;
}

export interface GraphRelationRepairPlan {
  readonly ok: true;
  readonly generated_at: string;
  readonly report_only: boolean;
  readonly apply_allowed: boolean;
  readonly summary: {
    readonly total_rows: number;
    readonly total_candidates: number;
    readonly by_reason: Partial<Record<GraphRelationRepairReason, number>>;
    readonly by_action: Partial<Record<GraphRelationRepairAction, number>>;
    readonly by_review_blocker: Partial<Record<Exclude<GraphRelationRepairReviewBlocker, "none">, number>>;
    readonly by_lane: Partial<Record<GraphRelationRepairLane, number>>;
    readonly production_candidates: number;
    readonly test_only_candidates: number;
    readonly production_top_actions: readonly GraphRelationRepairActionSummary[];
    readonly production_top_review_blockers: readonly GraphRelationRepairReviewBlockerSummary[];
    readonly top_actions: readonly GraphRelationRepairActionSummary[];
    readonly top_review_blockers: readonly GraphRelationRepairReviewBlockerSummary[];
    readonly report_only: boolean;
    readonly apply_allowed: boolean;
    readonly apply_allowed_candidates: number;
  };
  readonly candidates: readonly GraphRelationRepairCandidate[];
}

export interface BuildGraphRelationRepairPlanInput {
  readonly rows: readonly GraphRelationRepairPlanRow[];
  readonly generatedAt?: string;
  readonly applyMode?: "report_only" | "guarded";
}

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function includesTestSignal(value: string | null | undefined): boolean {
  const normalized = normalize(value);
  return normalized.includes("test") ||
    normalized.includes("测试") ||
    normalized.includes("fixture") ||
    normalized.includes("debug");
}

function laneFor(row: GraphRelationRepairPlanRow): GraphRelationRepairLane {
  if (row.relation_id.startsWith("relation_debt_")) return "test_only";
  const sourceHistorical = row.source_is_current === false || normalize(row.source_lifecycle_status) === "tombstone";
  const targetHistorical = row.target_is_current === false || normalize(row.target_lifecycle_status) === "tombstone";
  if (sourceHistorical && targetHistorical) return "test_only";
  if (includesTestSignal(row.source_title) || includesTestSignal(row.target_title)) return "test_only";
  return "production";
}

function increment<TKey extends string>(target: Partial<Record<TKey, number>>, key: TKey): void {
  target[key] = (target[key] ?? 0) + 1;
}

function reasonFor(row: GraphRelationRepairPlanRow): GraphRelationRepairReason | null {
  if (isGraphTestFixture({
    sourceMetadata: row.source_metadata,
    targetMetadata: row.target_metadata,
    relationMetadata: row.relation_metadata,
    sourceCreatedBy: row.source_created_by,
    sourceAgentId: row.source_agent_id,
    targetCreatedBy: row.target_created_by,
    targetAgentId: row.target_agent_id,
    relationId: row.relation_id,
    sourceTitle: row.source_title,
    targetTitle: row.target_title,
    sourceLifecycleStatus: row.source_lifecycle_status,
    sourceIsCurrent: row.source_is_current,
    targetLifecycleStatus: row.target_lifecycle_status,
    targetIsCurrent: row.target_is_current,
  })) {
    return null;
  }
  if (!row.source_exists) return "missing_relation_source";
  if (!row.target_exists) return "missing_relation_target";
  if (row.target_is_current === false) return "non_current_relation_target";
  if (normalize(row.target_lifecycle_status) !== "approved") return "non_approved_relation_target";
  return null;
}

function hasUniqueCurrentApprovedSuccessor(row: GraphRelationRepairPlanRow): boolean {
  return row.successor_count === 1 &&
    !!row.successor_memory_id &&
    row.successor_is_current === true &&
    normalize(row.successor_lifecycle_status) === "approved";
}

function actionFor(row: GraphRelationRepairPlanRow, reason: GraphRelationRepairReason): GraphRelationRepairAction {
  if (reason === "non_current_relation_target") {
    return hasUniqueCurrentApprovedSuccessor(row)
      ? "retarget_relation_to_successor"
      : "review_successor_before_retarget";
  }
  return "archive_relation_or_restore_target";
}

function reviewBlockerFor(
  row: GraphRelationRepairPlanRow,
  reason: GraphRelationRepairReason,
  action: GraphRelationRepairAction,
): GraphRelationRepairReviewBlocker {
  if (action === "retarget_relation_to_successor") return "none";
  if (reason === "missing_relation_source" || reason === "missing_relation_target") {
    return "target_missing_or_source_missing";
  }
  if (row.successor_count === 0 || !row.successor_memory_id) return "missing_successor";
  if (row.successor_count > 1) return "ambiguous_successor";
  return "successor_not_approved_current";
}

function stableId(row: GraphRelationRepairPlanRow, action: GraphRelationRepairAction): string {
  return `graph-relation-repair:${action}:${row.relation_id}`;
}

function topActions(byAction: Partial<Record<GraphRelationRepairAction, number>>): readonly GraphRelationRepairActionSummary[] {
  return (Object.entries(byAction) as [GraphRelationRepairAction, number][])
    .filter(([, count]) => count > 0)
    .sort(([leftAction, leftCount], [rightAction, rightCount]) =>
      rightCount - leftCount ||
      leftAction.localeCompare(rightAction)
    )
    .slice(0, 3)
    .map(([action, count]) => ({ action, count }));
}

function topReviewBlockers(
  byReviewBlocker: Partial<Record<Exclude<GraphRelationRepairReviewBlocker, "none">, number>>,
): readonly GraphRelationRepairReviewBlockerSummary[] {
  return (Object.entries(byReviewBlocker) as [Exclude<GraphRelationRepairReviewBlocker, "none">, number][])
    .filter(([, count]) => count > 0)
    .sort(([leftBlocker, leftCount], [rightBlocker, rightCount]) =>
      rightCount - leftCount ||
      leftBlocker.localeCompare(rightBlocker)
    )
    .slice(0, 3)
    .map(([blocker, count]) => ({ blocker, count }));
}

export function buildGraphRelationRepairPlan(input: BuildGraphRelationRepairPlanInput): GraphRelationRepairPlan {
  const reportOnly = input.applyMode !== "guarded";
  const candidates: GraphRelationRepairCandidate[] = [];
  const byReason: Partial<Record<GraphRelationRepairReason, number>> = {};
  const byAction: Partial<Record<GraphRelationRepairAction, number>> = {};
  const byReviewBlocker: Partial<Record<Exclude<GraphRelationRepairReviewBlocker, "none">, number>> = {};
  const byLane: Partial<Record<GraphRelationRepairLane, number>> = {};
  const productionByAction: Partial<Record<GraphRelationRepairAction, number>> = {};
  const productionByReviewBlocker: Partial<Record<Exclude<GraphRelationRepairReviewBlocker, "none">, number>> = {};

  for (const row of input.rows) {
    const reason = reasonFor(row);
    if (!reason) continue;
    const action = actionFor(row, reason);
    const reviewBlocker = reviewBlockerFor(row, reason, action);
    const lane = laneFor(row);
    increment(byReason, reason);
    increment(byAction, action);
    increment(byLane, lane);
    if (reviewBlocker !== "none") increment(byReviewBlocker, reviewBlocker);
    if (lane === "production") {
      increment(productionByAction, action);
      if (reviewBlocker !== "none") increment(productionByReviewBlocker, reviewBlocker);
    }
    const applyPlan = buildRetargetApplyPlan({
      row,
      action,
      reviewBlocker,
      lane,
      reportOnly,
    });
    candidates.push({
      candidate_type: "graph_relation_repair",
      candidate_id: stableId(row, action),
      relation_id: row.relation_id,
      relation_type: row.relation_type,
      source_memory_id: row.relation_memory_id,
      current_related_memory_id: row.relation_related_memory_id,
      suggested_related_memory_id: action === "retarget_relation_to_successor" ? row.successor_memory_id : null,
      reason,
      lane,
      suggested_action: action,
      review_blocker: reviewBlocker,
      apply_allowed: applyPlan !== undefined,
      blockers: applyPlan ? [] : reportOnly ? ["report_only", "requires_human_review"] : ["requires_human_review"],
      ...(applyPlan ? { apply_plan: applyPlan } : {}),
      evidence: {
        source_exists: row.source_exists,
        source_lifecycle_status: row.source_lifecycle_status,
        source_is_current: row.source_is_current,
        target_exists: row.target_exists,
        target_lifecycle_status: row.target_lifecycle_status,
        target_is_current: row.target_is_current,
        successor_lifecycle_status: row.successor_lifecycle_status,
        successor_is_current: row.successor_is_current,
        successor_count: row.successor_count,
        updated_at: row.updated_at,
        report_only: reportOnly,
      },
    });
  }

  const sorted = candidates.sort((left, right) =>
    left.relation_id.localeCompare(right.relation_id) ||
    left.candidate_id.localeCompare(right.candidate_id)
  );
  return {
    ok: true,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    report_only: reportOnly,
    apply_allowed: sorted.some((candidate) => candidate.apply_allowed),
    summary: {
      total_rows: input.rows.length,
      total_candidates: sorted.length,
      by_reason: byReason,
      by_action: byAction,
      by_review_blocker: byReviewBlocker,
      by_lane: byLane,
      production_candidates: byLane.production ?? 0,
      test_only_candidates: byLane.test_only ?? 0,
      production_top_actions: topActions(productionByAction),
      production_top_review_blockers: topReviewBlockers(productionByReviewBlocker),
      top_actions: topActions(byAction),
      top_review_blockers: topReviewBlockers(byReviewBlocker),
      report_only: reportOnly,
      apply_allowed: sorted.some((candidate) => candidate.apply_allowed),
      apply_allowed_candidates: sorted.filter((candidate) => candidate.apply_allowed).length,
    },
    candidates: sorted,
  };
}

function buildRetargetApplyPlan(input: {
  readonly row: GraphRelationRepairPlanRow;
  readonly action: GraphRelationRepairAction;
  readonly reviewBlocker: GraphRelationRepairReviewBlocker;
  readonly lane: GraphRelationRepairLane;
  readonly reportOnly: boolean;
}): GraphRelationRetargetApplyPlan | undefined {
  if (input.reportOnly) return undefined;
  if (input.lane !== "production") return undefined;
  if (input.action !== "retarget_relation_to_successor") return undefined;
  if (input.reviewBlocker !== "none") return undefined;
  if (!input.row.successor_memory_id) return undefined;
  return {
    kind: "graph_relation_retarget",
    relation_id: input.row.relation_id,
    source_memory_id: input.row.relation_memory_id,
    old_related_memory_id: input.row.relation_related_memory_id,
    new_related_memory_id: input.row.successor_memory_id,
  };
}

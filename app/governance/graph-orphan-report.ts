import type { JsonObject } from "../shared/types";
import { isGraphTestFixture } from "./graph-test-fixture";

export type GraphOrphanReason =
  | "missing_episode"
  | "missing_entity_link"
  | "missing_relation"
  | "missing_relation_target"
  | "non_current_relation_target"
  | "non_approved_relation_target";

export type GraphOrphanSuggestedAction =
  | "review_graph_enrichment"
  | "review_relation_repair_or_archive";

export type GraphOrphanLane = "production" | "test_only";

export interface GraphOrphanReportRow {
  readonly id: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly title: string | null;
  readonly memory_type: string | null;
  readonly lifecycle_status: string;
  readonly review_state: string;
  readonly is_current: boolean;
  readonly episode_id: string | null;
  readonly has_entity_link: boolean;
  readonly has_relation: boolean;
  readonly relation_id: string | null;
  readonly relation_type: string | null;
  readonly relation_memory_id: string | null;
  readonly relation_related_memory_id: string | null;
  readonly source_created_by?: string | null;
  readonly source_agent_id?: string | null;
  readonly source_metadata?: JsonObject | null;
  readonly related_created_by?: string | null;
  readonly related_agent_id?: string | null;
  readonly related_title?: string | null;
  readonly related_metadata?: JsonObject | null;
  readonly relation_metadata?: JsonObject | null;
  readonly related_exists: boolean | null;
  readonly related_lifecycle_status: string | null;
  readonly related_is_current: boolean | null;
  readonly updated_at: string | null;
}

export interface GraphOrphanCandidate {
  readonly candidate_type: "graph_orphan";
  readonly candidate_id: string;
  readonly memory_id: string;
  readonly scope: string;
  readonly title: string | null;
  readonly memory_type: string | null;
  readonly reason: GraphOrphanReason;
  readonly lane: GraphOrphanLane;
  readonly suggested_action: GraphOrphanSuggestedAction;
  readonly apply_allowed: false;
  readonly blockers: readonly string[];
  readonly evidence: {
    readonly relation_id: string | null;
    readonly relation_type: string | null;
    readonly relation_memory_id: string | null;
    readonly relation_related_memory_id: string | null;
    readonly related_lifecycle_status: string | null;
    readonly related_is_current: boolean | null;
    readonly updated_at: string | null;
    readonly report_only: true;
  };
}

export interface GraphOrphanReasonSummary {
  readonly reason: GraphOrphanReason;
  readonly count: number;
  readonly suggested_action: GraphOrphanSuggestedAction;
}

export interface GraphOrphanReport {
  readonly ok: true;
  readonly dry_run: true;
  readonly generated_at: string;
  readonly summary: {
    readonly total_rows: number;
    readonly total_candidates: number;
    readonly by_reason: Partial<Record<GraphOrphanReason, number>>;
    readonly by_action: Partial<Record<GraphOrphanSuggestedAction, number>>;
    readonly by_lane: Partial<Record<GraphOrphanLane, number>>;
    readonly production_candidates: number;
    readonly test_only_candidates: number;
    readonly production_top_reasons: readonly GraphOrphanReasonSummary[];
    readonly top_reasons: readonly GraphOrphanReasonSummary[];
    readonly report_only: true;
  };
  readonly candidates: readonly GraphOrphanCandidate[];
}

export interface BuildGraphOrphanReportInput {
  readonly rows: readonly GraphOrphanReportRow[];
  readonly generatedAt?: string;
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

function laneFor(row: GraphOrphanReportRow): GraphOrphanLane {
  if (row.relation_id?.startsWith("relation_debt_")) return "test_only";
  const sourceHistorical = row.is_current === false || normalize(row.lifecycle_status) === "tombstone";
  const targetHistorical = row.related_is_current === false || normalize(row.related_lifecycle_status) === "tombstone";
  if (row.relation_id && sourceHistorical && targetHistorical) return "test_only";
  if (includesTestSignal(row.scope_id) || includesTestSignal(row.title) || includesTestSignal(row.related_title)) {
    return "test_only";
  }
  return "production";
}

function isApprovedCurrent(row: GraphOrphanReportRow): boolean {
  return row.is_current &&
    normalize(row.lifecycle_status) === "approved" &&
    ["approved", "not_required"].includes(normalize(row.review_state));
}

function requiresEpisode(row: GraphOrphanReportRow): boolean {
  const memoryType = normalize(row.memory_type);
  return memoryType === "episode" ||
    memoryType === "episodic" ||
    memoryType === "observation" ||
    memoryType === "status";
}

function requiresRelation(row: GraphOrphanReportRow): boolean {
  const memoryType = normalize(row.memory_type);
  return memoryType === "decision" ||
    memoryType === "procedure" ||
    memoryType === "procedural" ||
    memoryType === "ops_learning" ||
    memoryType === "ops_proposal" ||
    memoryType === "status";
}

function increment<TKey extends string>(target: Partial<Record<TKey, number>>, key: TKey): void {
  target[key] = (target[key] ?? 0) + 1;
}

function stableId(row: GraphOrphanReportRow, reason: GraphOrphanReason): string {
  const relationPart = row.relation_id ? `:${row.relation_id}` : "";
  return `graph-orphan:${reason}:${row.id}${relationPart}`;
}

function suggestedAction(reason: GraphOrphanReason): GraphOrphanSuggestedAction {
  return reason === "missing_episode" || reason === "missing_entity_link" || reason === "missing_relation"
    ? "review_graph_enrichment"
    : "review_relation_repair_or_archive";
}

function topReasons(byReason: Partial<Record<GraphOrphanReason, number>>): readonly GraphOrphanReasonSummary[] {
  return (Object.entries(byReason) as [GraphOrphanReason, number][])
    .filter(([, count]) => count > 0)
    .sort(([leftReason, leftCount], [rightReason, rightCount]) =>
      rightCount - leftCount ||
      leftReason.localeCompare(rightReason)
    )
    .slice(0, 3)
    .map(([reason, count]) => ({
      reason,
      count,
      suggested_action: suggestedAction(reason),
    }));
}

function reasonsFor(row: GraphOrphanReportRow): readonly GraphOrphanReason[] {
  if (isGraphTestFixture({
    sourceMetadata: row.source_metadata,
    targetMetadata: row.related_metadata,
    relationMetadata: row.relation_metadata,
    sourceCreatedBy: row.source_created_by,
    sourceAgentId: row.source_agent_id,
    targetCreatedBy: row.related_created_by,
    targetAgentId: row.related_agent_id,
    relationId: row.relation_id,
    sourceTitle: row.title,
    targetTitle: row.related_title,
    sourceLifecycleStatus: row.lifecycle_status,
    sourceIsCurrent: row.is_current,
    targetLifecycleStatus: row.related_lifecycle_status,
    targetIsCurrent: row.related_is_current,
  })) {
    return [];
  }
  const reasons: GraphOrphanReason[] = [];
  if (isApprovedCurrent(row)) {
    if (requiresEpisode(row) && !row.episode_id) reasons.push("missing_episode");
    if (!row.has_entity_link) reasons.push("missing_entity_link");
    if (requiresRelation(row) && !row.has_relation) reasons.push("missing_relation");
  }
  if (row.relation_id) {
    if (row.related_exists === false) reasons.push("missing_relation_target");
    else if (row.related_is_current === false) reasons.push("non_current_relation_target");
    else if (row.related_lifecycle_status && normalize(row.related_lifecycle_status) !== "approved") {
      reasons.push("non_approved_relation_target");
    }
  }
  return reasons;
}

export function buildGraphOrphanReport(input: BuildGraphOrphanReportInput): GraphOrphanReport {
  const candidates: GraphOrphanCandidate[] = [];
  const byReason: Partial<Record<GraphOrphanReason, number>> = {};
  const byAction: Partial<Record<GraphOrphanSuggestedAction, number>> = {};
  const byLane: Partial<Record<GraphOrphanLane, number>> = {};
  const productionByReason: Partial<Record<GraphOrphanReason, number>> = {};

  for (const row of input.rows) {
    for (const reason of reasonsFor(row)) {
      const action = suggestedAction(reason);
      const lane = laneFor(row);
      increment(byReason, reason);
      increment(byAction, action);
      increment(byLane, lane);
      if (lane === "production") increment(productionByReason, reason);
      candidates.push({
        candidate_type: "graph_orphan",
        candidate_id: stableId(row, reason),
        memory_id: row.id,
        scope: `${row.scope_type}:${row.scope_id}`,
        title: row.title,
        memory_type: row.memory_type,
        reason,
        lane,
        suggested_action: action,
        apply_allowed: false,
        blockers: ["report_only", "requires_human_review"],
        evidence: {
          relation_id: row.relation_id,
          relation_type: row.relation_type,
          relation_memory_id: row.relation_memory_id,
          relation_related_memory_id: row.relation_related_memory_id,
          related_lifecycle_status: row.related_lifecycle_status,
          related_is_current: row.related_is_current,
          updated_at: row.updated_at,
          report_only: true,
        },
      });
    }
  }

  const sorted = candidates.sort((left, right) =>
    left.reason.localeCompare(right.reason) ||
    left.memory_id.localeCompare(right.memory_id) ||
    left.candidate_id.localeCompare(right.candidate_id)
  );

  return {
    ok: true,
    dry_run: true,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    summary: {
      total_rows: input.rows.length,
      total_candidates: sorted.length,
      by_reason: byReason,
      by_action: byAction,
      by_lane: byLane,
      production_candidates: byLane.production ?? 0,
      test_only_candidates: byLane.test_only ?? 0,
      production_top_reasons: topReasons(productionByReason),
      top_reasons: topReasons(byReason),
      report_only: true,
    },
    candidates: sorted,
  };
}

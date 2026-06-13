import type { TemporalMemoryRelationType } from "../shared/memory-relation-types";

export interface TemporalTransitionFactRow {
  readonly id: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly title: string | null;
  readonly content: string;
  readonly memory_type: string | null;
  readonly memory_class: string | null;
  readonly cognitive_type: string | null;
  readonly recall_policy: string | null;
  readonly lifecycle_status: string;
  readonly review_state: string;
  readonly is_current: boolean;
  readonly fact_status: string | null;
  readonly topic: string | null;
  readonly valid_at: string | null;
  readonly invalid_at: string | null;
  readonly observed_at: string | null;
  readonly updated_at: string | null;
}

export interface ExistingTemporalTransitionRelationRow {
  readonly memory_id: string;
  readonly related_memory_id: string;
  readonly relation_type: string;
}

export interface TemporalTransitionCandidate {
  readonly candidate_type: "temporal_transition_candidate";
  readonly candidate_id: string;
  readonly scope: string;
  readonly topic: string;
  readonly newer_memory_id: string;
  readonly older_memory_id: string;
  readonly suggested_relation_type: Extract<TemporalMemoryRelationType, "supersedes" | "contradicts">;
  readonly suggested_older_fact_status: "historical";
  readonly suggested_older_invalid_at: string | null;
  readonly suggested_action: "review_temporal_transition";
  readonly confidence: number;
  readonly blockers: readonly ["report_only", "requires_human_review"];
  readonly apply_allowed: false;
  readonly evidence: {
    readonly newer_updated_at: string | null;
    readonly older_updated_at: string | null;
    readonly newer_valid_at: string | null;
    readonly older_valid_at: string | null;
    readonly conflicting_values: readonly string[];
    readonly shared_terms: readonly string[];
    readonly report_only: true;
  };
}

export interface TemporalTransitionCandidateReport {
  readonly ok: true;
  readonly generated_at: string;
  readonly report_only: true;
  readonly apply_allowed: false;
  readonly summary: {
    readonly total_rows: number;
    readonly total_candidates: number;
    readonly by_suggested_relation: Partial<Record<"supersedes" | "contradicts", number>>;
    readonly report_only: true;
  };
  readonly candidates: readonly TemporalTransitionCandidate[];
}

export interface BuildTemporalTransitionCandidateReportInput {
  readonly generatedAt?: string;
  readonly rows: readonly TemporalTransitionFactRow[];
  readonly existingRelations: readonly ExistingTemporalTransitionRelationRow[];
  readonly maxCandidatesPerTopic?: number;
}

const FACT_TYPES = new Set(["", "fact", "constraint", "decision", "preference", "long_term_fact"]);
const STOP_TERMS = new Set(["api", "uses", "used", "port", "now", "before", "the", "and", "with", "memory"]);

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function isApprovedCurrentSemanticFact(row: TemporalTransitionFactRow): boolean {
  if (!row.is_current || normalize(row.lifecycle_status) !== "approved") return false;
  if (!["approved", "not_required"].includes(normalize(row.review_state))) return false;
  if (["historical", "invalid", "superseded", "archived", "rejected"].includes(normalize(row.fact_status))) return false;
  if (normalize(row.invalid_at)) return false;
  const memoryType = normalize(row.memory_type);
  const cognitiveType = normalize(row.cognitive_type);
  return FACT_TYPES.has(memoryType) && (cognitiveType === "" || cognitiveType === "semantic");
}

function groupKey(row: TemporalTransitionFactRow): string {
  return `${normalize(row.scope_type)}:${row.scope_id}:${normalize(row.topic) || normalize(row.title) || "topic:unknown"}`;
}

function text(row: TemporalTransitionFactRow): string {
  return `${row.title ?? ""}\n${row.content}`;
}

function values(row: TemporalTransitionFactRow): Set<string> {
  const matches = text(row).match(/\b\d+(?:\.\d+){0,3}\b/gu) ?? [];
  return new Set(matches.map((item) => item.toLowerCase()));
}

function tokens(row: TemporalTransitionFactRow): Set<string> {
  const matches = text(row).toLowerCase().match(/[a-z][a-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}/gu) ?? [];
  return new Set(matches.filter((item) => !STOP_TERMS.has(item)));
}

function sharedTerms(left: TemporalTransitionFactRow, right: TemporalTransitionFactRow): string[] {
  const rightTokens = tokens(right);
  return [...tokens(left)].filter((item) => rightTokens.has(item)).sort().slice(0, 8);
}

function conflictingValues(left: TemporalTransitionFactRow, right: TemporalTransitionFactRow): string[] {
  const all = [...new Set([...values(left), ...values(right)])].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  return all.length >= 2 ? all : [];
}

function timestamp(row: TemporalTransitionFactRow): number {
  const candidate = row.updated_at ?? row.observed_at ?? row.valid_at;
  const parsed = candidate ? new Date(candidate).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function stablePart(value: string): string {
  return value.replace(/[^a-z0-9_-]+/giu, "-").replace(/^-+|-+$/gu, "").toLowerCase();
}

function relationKey(memoryId: string, relatedMemoryId: string, relationType: string): string {
  return `${memoryId}\u0000${relatedMemoryId}\u0000${relationType}`;
}

function hasExistingTemporalRelation(
  existing: ReadonlySet<string>,
  leftId: string,
  rightId: string,
): boolean {
  return ["supersedes", "contradicts"].some((relationType) =>
    existing.has(relationKey(leftId, rightId, relationType)) ||
    existing.has(relationKey(rightId, leftId, relationType))
  );
}

function increment<TKey extends string>(target: Partial<Record<TKey, number>>, key: TKey): void {
  target[key] = (target[key] ?? 0) + 1;
}

export function buildTemporalTransitionCandidateReport(
  input: BuildTemporalTransitionCandidateReportInput,
): TemporalTransitionCandidateReport {
  const maxCandidatesPerTopic = input.maxCandidatesPerTopic ?? 20;
  const existing = new Set(input.existingRelations.map((relation) =>
    relationKey(relation.memory_id, relation.related_memory_id, normalize(relation.relation_type))
  ));
  const groups = new Map<string, TemporalTransitionFactRow[]>();
  for (const row of input.rows.filter(isApprovedCurrentSemanticFact)) {
    const rows = groups.get(groupKey(row)) ?? [];
    rows.push(row);
    groups.set(groupKey(row), rows);
  }

  const candidates: TemporalTransitionCandidate[] = [];
  for (const [key, rows] of groups.entries()) {
    const topicCandidates: TemporalTransitionCandidate[] = [];
    for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex += 1) {
        const left = rows[leftIndex];
        const right = rows[rightIndex];
        if (!left || !right) continue;
        if (hasExistingTemporalRelation(existing, left.id, right.id)) continue;
        const conflicts = conflictingValues(left, right);
        const terms = sharedTerms(left, right);
        if (conflicts.length < 2 || terms.length === 0) continue;
        const [newer, older] = timestamp(left) >= timestamp(right) ? [left, right] : [right, left];
        topicCandidates.push({
          candidate_type: "temporal_transition_candidate",
          candidate_id: stablePart(["temporal-transition", newer.id, "supersedes", older.id].join(":")),
          scope: `${newer.scope_type}:${newer.scope_id}`,
          topic: normalize(newer.topic) || key,
          newer_memory_id: newer.id,
          older_memory_id: older.id,
          suggested_relation_type: "supersedes",
          suggested_older_fact_status: "historical",
          suggested_older_invalid_at: newer.valid_at ?? newer.observed_at ?? newer.updated_at,
          suggested_action: "review_temporal_transition",
          confidence: Math.min(0.95, 0.72 + Math.min(terms.length, 3) * 0.05 + Math.min(conflicts.length, 3) * 0.03),
          blockers: ["report_only", "requires_human_review"],
          apply_allowed: false,
          evidence: {
            newer_updated_at: newer.updated_at,
            older_updated_at: older.updated_at,
            newer_valid_at: newer.valid_at,
            older_valid_at: older.valid_at,
            conflicting_values: conflicts,
            shared_terms: terms,
            report_only: true,
          },
        });
      }
    }
    candidates.push(...topicCandidates
      .sort((left, right) =>
        right.confidence - left.confidence ||
        left.newer_memory_id.localeCompare(right.newer_memory_id) ||
        left.older_memory_id.localeCompare(right.older_memory_id)
      )
      .slice(0, maxCandidatesPerTopic));
  }

  const bySuggestedRelation: Partial<Record<"supersedes" | "contradicts", number>> = {};
  for (const candidate of candidates) increment(bySuggestedRelation, candidate.suggested_relation_type);
  const sorted = candidates.sort((left, right) =>
    left.scope.localeCompare(right.scope) ||
    left.topic.localeCompare(right.topic) ||
    left.newer_memory_id.localeCompare(right.newer_memory_id) ||
    left.older_memory_id.localeCompare(right.older_memory_id)
  );
  return {
    ok: true,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    report_only: true,
    apply_allowed: false,
    summary: {
      total_rows: input.rows.length,
      total_candidates: sorted.length,
      by_suggested_relation: bySuggestedRelation,
      report_only: true,
    },
    candidates: sorted,
  };
}

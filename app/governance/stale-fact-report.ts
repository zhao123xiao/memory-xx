/**
 * Stale Fact Report
 *
 * Identifies potentially stale facts based on temporal relations.
 * Based on memory-xx governance module.
 */

export interface StaleFactReportRow {
  readonly id: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly title: string | null;
  readonly content: string;
  readonly memory_type: string | null;
  readonly lifecycle_status: string;
  readonly review_state: string;
  readonly is_current: boolean;
  readonly fact_status: string | null;
  readonly valid_at: string | null;
  readonly invalid_at: string | null;
  readonly observed_at: string | null;
  readonly updated_at: string | null;
  readonly relation_id: string | null;
  readonly relation_type: string | null;
  readonly relation_direction: "outbound" | "inbound" | null;
  readonly related_memory_id: string | null;
  readonly related_title: string | null;
  readonly related_content: string | null;
  readonly related_lifecycle_status: string | null;
  readonly related_is_current: boolean | null;
  readonly relation_created_at: string | null;
}

export type StaleFactReason = "superseded_current_fact" | "contradicted_current_fact";
export type StaleFactSuggestedAction = "mark_invalid_or_superseded" | "human_temporal_review";

export interface StaleFactCandidate {
  readonly memory_id: string;
  readonly scope: string;
  readonly title: string | null;
  readonly content_preview: string;
  readonly memory_type: string | null;
  readonly fact_status: string | null;
  readonly valid_at: string | null;
  readonly invalid_at: string | null;
  readonly relation_id: string | null;
  readonly relation_type: string;
  readonly relation_direction: "outbound" | "inbound" | null;
  readonly related_memory_id: string | null;
  readonly related_title: string | null;
  readonly related_content_preview: string | null;
  readonly reason: StaleFactReason;
  readonly suggested_action: StaleFactSuggestedAction;
  readonly evidence: {
    readonly relation_created_at: string | null;
    readonly related_lifecycle_status: string | null;
    readonly related_is_current: boolean | null;
    readonly observed_at: string | null;
    readonly updated_at: string | null;
  };
}

export interface StaleFactReport {
  readonly ok: true;
  readonly dry_run: true;
  readonly generated_at: string;
  readonly summary: {
    readonly total_rows: number;
    readonly total_candidates: number;
    readonly by_reason: Partial<Record<StaleFactReason, number>>;
    readonly by_action: Partial<Record<StaleFactSuggestedAction, number>>;
  };
  readonly candidates: readonly StaleFactCandidate[];
}

export interface BuildStaleFactReportInput {
  readonly generatedAt?: string;
  readonly rows: readonly StaleFactReportRow[];
}

const FACT_MEMORY_TYPES = new Set(["fact", "constraint", "decision", "preference", "long_term_fact"]);

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function preview(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

function isCurrentFact(row: StaleFactReportRow): boolean {
  if (!row.is_current) return false;
  if (normalize(row.lifecycle_status) !== "approved") return false;
  if (row.invalid_at) return false;
  if (["superseded", "invalid", "rejected", "archived"].includes(normalize(row.fact_status))) return false;
  const memoryType = normalize(row.memory_type);
  return memoryType === "" || FACT_MEMORY_TYPES.has(memoryType);
}

function candidateReason(row: StaleFactReportRow): StaleFactReason | null {
  const relationType = normalize(row.relation_type);
  if (!isCurrentFact(row)) return null;
  if (row.related_memory_id && normalize(row.related_lifecycle_status) !== "approved") return null;
  if (row.related_memory_id && row.related_is_current === false) return null;
  if (relationType === "supersedes" && row.relation_direction === "inbound") {
    return "superseded_current_fact";
  }
  if (relationType === "contradicts") {
    return "contradicted_current_fact";
  }
  return null;
}

function suggestedAction(reason: StaleFactReason): StaleFactSuggestedAction {
  return reason === "superseded_current_fact" ? "mark_invalid_or_superseded" : "human_temporal_review";
}

function increment<TKey extends string>(target: Partial<Record<TKey, number>>, key: TKey): void {
  target[key] = (target[key] ?? 0) + 1;
}

export function buildStaleFactReport(input: BuildStaleFactReportInput): StaleFactReport {
  const candidates: StaleFactCandidate[] = [];
  const byReason: Partial<Record<StaleFactReason, number>> = {};
  const byAction: Partial<Record<StaleFactSuggestedAction, number>> = {};

  for (const row of input.rows) {
    const reason = candidateReason(row);
    if (!reason || !row.relation_type) continue;
    const action = suggestedAction(reason);
    increment(byReason, reason);
    increment(byAction, action);
    candidates.push({
      memory_id: row.id,
      scope: `${row.scope_type}:${row.scope_id}`,
      title: row.title,
      content_preview: preview(row.content) ?? "",
      memory_type: row.memory_type,
      fact_status: row.fact_status,
      valid_at: row.valid_at,
      invalid_at: row.invalid_at,
      relation_id: row.relation_id,
      relation_type: row.relation_type,
      relation_direction: row.relation_direction,
      related_memory_id: row.related_memory_id,
      related_title: row.related_title,
      related_content_preview: preview(row.related_content),
      reason,
      suggested_action: action,
      evidence: {
        relation_created_at: row.relation_created_at,
        related_lifecycle_status: row.related_lifecycle_status,
        related_is_current: row.related_is_current,
        observed_at: row.observed_at,
        updated_at: row.updated_at,
      },
    });
  }

  return {
    ok: true,
    dry_run: true,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    summary: {
      total_rows: input.rows.length,
      total_candidates: candidates.length,
      by_reason: byReason,
      by_action: byAction,
    },
    candidates,
  };
}
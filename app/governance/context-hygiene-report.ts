/**
 * Context Hygiene Report
 *
 * Identifies memories that may pollute context with inappropriate recall policies.
 * Based on memory-xx governance module.
 */
import { inferCognitiveType } from "../shared/cognitive-type";

export interface ContextHygieneReportRow {
  readonly id: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly title: string | null;
  readonly content: string;
  readonly memory_type: string | null;
  readonly memory_layer?: string | null;
  readonly memory_class: string | null;
  readonly cognitive_type: string | null;
  readonly recall_policy: string | null;
  readonly lifecycle_status: string;
  readonly review_state: string;
  readonly is_current: boolean;
  readonly updated_at: string | null;
}

export type ContextHygieneReason =
  | "episodic_default_recall_leakage"
  | "audit_default_recall_leakage";

export type ContextHygieneSuggestedRecallPolicy = "explicit_only" | "never";

export interface ContextHygieneCandidate {
  readonly memory_id: string;
  readonly scope: string;
  readonly title: string | null;
  readonly content_preview: string;
  readonly memory_type: string | null;
  readonly memory_class: string | null;
  readonly cognitive_type: string | null;
  readonly recall_policy: string | null;
  readonly reason: ContextHygieneReason;
  readonly suggested_recall_policy: ContextHygieneSuggestedRecallPolicy;
  readonly suggested_action: "review_recall_policy_tightening";
  readonly blockers: readonly ["report_only", "requires_human_review"];
  readonly evidence: {
    readonly lifecycle_status: string;
    readonly review_state: string;
    readonly is_current: boolean;
    readonly updated_at: string | null;
  };
}

export interface ContextHygieneReport {
  readonly ok: true;
  readonly generated_at: string;
  readonly report_only: true;
  readonly apply_allowed: false;
  readonly summary: {
    readonly total_rows: number;
    readonly total_candidates: number;
    readonly by_reason: Partial<Record<ContextHygieneReason, number>>;
    readonly by_suggested_recall_policy: Partial<Record<ContextHygieneSuggestedRecallPolicy, number>>;
  };
  readonly candidates: readonly ContextHygieneCandidate[];
}

export interface BuildContextHygieneReportInput {
  readonly generatedAt?: string;
  readonly rows: readonly ContextHygieneReportRow[];
}

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function preview(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

function increment<TKey extends string>(target: Partial<Record<TKey, number>>, key: TKey): void {
  target[key] = (target[key] ?? 0) + 1;
}

function reasonFor(row: ContextHygieneReportRow): ContextHygieneReason | null {
  if (!row.is_current) return null;
  if (normalize(row.lifecycle_status) !== "approved") return null;
  if (normalize(row.recall_policy) !== "default") return null;
  const cognitiveType = effectiveCognitiveType(row);
  if (cognitiveType === "episodic") return "episodic_default_recall_leakage";
  if (cognitiveType === "audit") return "audit_default_recall_leakage";
  return null;
}

function effectiveCognitiveType(row: ContextHygieneReportRow): string {
  const persisted = normalize(row.cognitive_type);
  if (persisted) return persisted;
  return inferCognitiveType({
    memory_type: row.memory_type,
    memory_layer: row.memory_layer,
    recall_policy: row.recall_policy,
    memory_class: row.memory_class,
  });
}

function suggestedRecallPolicy(reason: ContextHygieneReason): ContextHygieneSuggestedRecallPolicy {
  return reason === "audit_default_recall_leakage" ? "never" : "explicit_only";
}

export function buildContextHygieneReport(input: BuildContextHygieneReportInput): ContextHygieneReport {
  const candidates: ContextHygieneCandidate[] = [];
  const byReason: Partial<Record<ContextHygieneReason, number>> = {};
  const bySuggestedRecallPolicy: Partial<Record<ContextHygieneSuggestedRecallPolicy, number>> = {};

  for (const row of input.rows) {
    const reason = reasonFor(row);
    if (!reason) continue;
    const recallPolicy = suggestedRecallPolicy(reason);
    increment(byReason, reason);
    increment(bySuggestedRecallPolicy, recallPolicy);
    candidates.push({
      memory_id: row.id,
      scope: `${row.scope_type}:${row.scope_id}`,
      title: row.title,
      content_preview: preview(row.content),
      memory_type: row.memory_type,
      memory_class: row.memory_class,
      cognitive_type: effectiveCognitiveType(row),
      recall_policy: row.recall_policy,
      reason,
      suggested_recall_policy: recallPolicy,
      suggested_action: "review_recall_policy_tightening",
      blockers: ["report_only", "requires_human_review"],
      evidence: {
        lifecycle_status: row.lifecycle_status,
        review_state: row.review_state,
        is_current: row.is_current,
        updated_at: row.updated_at,
      },
    });
  }

  return {
    ok: true,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    report_only: true,
    apply_allowed: false,
    summary: {
      total_rows: input.rows.length,
      total_candidates: candidates.length,
      by_reason: byReason,
      by_suggested_recall_policy: bySuggestedRecallPolicy,
    },
    candidates,
  };
}
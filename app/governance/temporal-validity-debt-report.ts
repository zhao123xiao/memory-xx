export interface TemporalValidityDebtRow {
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
  readonly valid_at: string | null;
  readonly invalid_at: string | null;
  readonly observed_at: string | null;
  readonly review_at: string | null;
  readonly expires_at: string | null;
  readonly updated_at: string | null;
}

export type TemporalValidityDebtReason =
  | "current_fact_missing_valid_at"
  | "progress_snapshot_missing_review_at"
  | "episodic_current_default_recall"
  | "invalidated_fact_still_current";

export type TemporalValidityDebtSuggestedAction =
  | "review_temporal_metadata"
  | "isolate_temporal_snapshot";

export type TemporalValidityDebtSuggestedRecallPolicy = "default" | "explicit_only" | "never";
export type TemporalValidityDebtSuggestedFactStatus = "current" | "historical" | "invalid";

export interface TemporalValidityDebtCandidate {
  readonly memory_id: string;
  readonly scope: string;
  readonly title: string | null;
  readonly content_preview: string;
  readonly memory_type: string | null;
  readonly memory_class: string | null;
  readonly cognitive_type: string | null;
  readonly recall_policy: string | null;
  readonly fact_status: string | null;
  readonly reasons: readonly TemporalValidityDebtReason[];
  readonly lane: "production" | "test_only";
  readonly suggested_action: TemporalValidityDebtSuggestedAction;
  readonly suggested_recall_policy: TemporalValidityDebtSuggestedRecallPolicy;
  readonly suggested_fact_status: TemporalValidityDebtSuggestedFactStatus;
  readonly blockers: readonly ["report_only", "requires_human_review"];
  readonly evidence: {
    readonly valid_at: string | null;
    readonly invalid_at: string | null;
    readonly observed_at: string | null;
    readonly review_at: string | null;
    readonly expires_at: string | null;
    readonly updated_at: string | null;
  };
}

export interface TemporalValidityDebtReport {
  readonly ok: true;
  readonly generated_at: string;
  readonly report_only: true;
  readonly apply_allowed: false;
  readonly summary: {
    readonly total_rows: number;
    readonly total_candidates: number;
    readonly production_candidates: number;
    readonly test_only_candidates: number;
    readonly by_reason: Partial<Record<TemporalValidityDebtReason, number>>;
    readonly by_suggested_action: Partial<Record<TemporalValidityDebtSuggestedAction, number>>;
  };
  readonly candidates: readonly TemporalValidityDebtCandidate[];
}

export interface BuildTemporalValidityDebtReportInput {
  readonly generatedAt?: string;
  readonly rows: readonly TemporalValidityDebtRow[];
}

const CURRENT_FACT_MEMORY_TYPES = new Set(["fact", "constraint", "decision", "preference", "long_term_fact"]);

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

function isTestOnlyRow(row: TemporalValidityDebtRow): boolean {
  const scope = `${normalize(row.scope_type)}:${normalize(row.scope_id)}`;
  const title = normalize(row.title);
  return normalize(row.recall_policy) === "test_only" ||
    scope.includes("memory-policy-eval") ||
    scope.includes("test") ||
    title.startsWith("policy-corpus:");
}

function isApprovedCurrent(row: TemporalValidityDebtRow): boolean {
  return row.is_current && normalize(row.lifecycle_status) === "approved";
}

function isSemanticCurrentFact(row: TemporalValidityDebtRow): boolean {
  if (!isApprovedCurrent(row)) return false;
  if (normalize(row.invalid_at)) return false;
  if (["historical", "invalid", "superseded", "archived", "rejected"].includes(normalize(row.fact_status))) return false;
  const memoryType = normalize(row.memory_type);
  const cognitiveType = normalize(row.cognitive_type);
  return (memoryType === "" || CURRENT_FACT_MEMORY_TYPES.has(memoryType)) &&
    (cognitiveType === "" || cognitiveType === "semantic");
}

function isProgressSnapshot(row: TemporalValidityDebtRow): boolean {
  if (!isApprovedCurrent(row)) return false;
  if (["historical", "invalid", "superseded", "archived", "rejected"].includes(normalize(row.fact_status))) return false;
  const memoryType = normalize(row.memory_type);
  const memoryClass = normalize(row.memory_class);
  if (!isTestOnlyRow(row) && ["lesson", "preference", "constraint", "decision"].includes(memoryType)) return false;
  if (!isTestOnlyRow(row) && ["procedural_constraint", "preference", "constraint", "decision"].includes(memoryClass)) return false;
  const text = `${row.title ?? ""}\n${row.content}`;
  return normalize(row.cognitive_type) === "episodic" ||
    memoryType === "status" ||
    memoryType === "procedure" ||
    memoryClass === "procedure" ||
    memoryClass === "operational_issue" ||
    /(?:CI|build-and-test|Docker Build|release gate|full-stack-release-gate|in progress|还在跑|继续等|当前进度|已通过|progress|status)/iu.test(text);
}

function reasonsFor(row: TemporalValidityDebtRow): TemporalValidityDebtReason[] {
  const reasons: TemporalValidityDebtReason[] = [];
  if (isSemanticCurrentFact(row) && !row.valid_at && !row.observed_at) {
    reasons.push("current_fact_missing_valid_at");
  }
  if (isProgressSnapshot(row) && !row.review_at && !row.expires_at) {
    reasons.push("progress_snapshot_missing_review_at");
  }
  if (isProgressSnapshot(row) && normalize(row.recall_policy) === "default") {
    reasons.push("episodic_current_default_recall");
  }
  if (isApprovedCurrent(row) && row.invalid_at && normalize(row.fact_status) === "current") {
    reasons.push("invalidated_fact_still_current");
  }
  return reasons;
}

function suggestedAction(reasons: readonly TemporalValidityDebtReason[]): TemporalValidityDebtSuggestedAction {
  return reasons.includes("progress_snapshot_missing_review_at") ||
    reasons.includes("episodic_current_default_recall")
    ? "isolate_temporal_snapshot"
    : "review_temporal_metadata";
}

function suggestedRecallPolicy(
  row: TemporalValidityDebtRow,
  reasons: readonly TemporalValidityDebtReason[],
): TemporalValidityDebtSuggestedRecallPolicy {
  if (reasons.includes("episodic_current_default_recall")) return "explicit_only";
  const current = normalize(row.recall_policy);
  if (current === "never") return "never";
  if (current === "explicit_only") return "explicit_only";
  return "default";
}

function suggestedFactStatus(reasons: readonly TemporalValidityDebtReason[]): TemporalValidityDebtSuggestedFactStatus {
  if (reasons.includes("invalidated_fact_still_current") || reasons.includes("progress_snapshot_missing_review_at")) {
    return "historical";
  }
  return "current";
}

export function buildTemporalValidityDebtReport(input: BuildTemporalValidityDebtReportInput): TemporalValidityDebtReport {
  const candidates: TemporalValidityDebtCandidate[] = [];
  const byReason: Partial<Record<TemporalValidityDebtReason, number>> = {};
  const bySuggestedAction: Partial<Record<TemporalValidityDebtSuggestedAction, number>> = {};

  for (const row of input.rows) {
    const reasons = reasonsFor(row);
    if (reasons.length === 0) continue;
    const action = suggestedAction(reasons);
    const lane = isTestOnlyRow(row) ? "test_only" : "production";
    for (const reason of reasons) increment(byReason, reason);
    increment(bySuggestedAction, action);
    candidates.push({
      memory_id: row.id,
      scope: `${row.scope_type}:${row.scope_id}`,
      title: row.title,
      content_preview: preview(row.content),
      memory_type: row.memory_type,
      memory_class: row.memory_class,
      cognitive_type: row.cognitive_type,
      recall_policy: row.recall_policy,
      fact_status: row.fact_status,
      reasons,
      lane,
      suggested_action: action,
      suggested_recall_policy: suggestedRecallPolicy(row, reasons),
      suggested_fact_status: suggestedFactStatus(reasons),
      blockers: ["report_only", "requires_human_review"],
      evidence: {
        valid_at: row.valid_at,
        invalid_at: row.invalid_at,
        observed_at: row.observed_at,
        review_at: row.review_at,
        expires_at: row.expires_at,
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
      production_candidates: candidates.filter((candidate) => candidate.lane === "production").length,
      test_only_candidates: candidates.filter((candidate) => candidate.lane === "test_only").length,
      by_reason: byReason,
      by_suggested_action: bySuggestedAction,
    },
    candidates,
  };
}

import type { JsonObject } from "../shared/types";
import type {
  AutonomousPendingClosurePlan,
  PendingAutonomousClosureItem,
  PendingAutonomousClosureRow,
} from "./memory-auto-approval-sweep";

export interface PendingCanaryTrainingReportInput {
  readonly runId: string;
  readonly generatedAt: string;
  readonly rows: readonly PendingAutonomousClosureRow[];
  readonly plan: AutonomousPendingClosurePlan;
}

export interface PendingCanaryTrainingSample {
  readonly id: string;
  readonly scope: string;
  readonly source: string;
  readonly agent_id: string;
  readonly memory_type: string | null;
  readonly title: string | null;
  readonly content_preview: string;
  readonly autonomous_action: string;
  readonly memory_class: string;
  readonly recall_policy: string;
  readonly policy_action: string;
  readonly assistant_memory_kind?: string;
  readonly evidence_level?: string;
  readonly reasons: readonly string[];
}

export interface PendingCanaryTrainingReport {
  readonly ok: boolean;
  readonly run_id: string;
  readonly generated_at: string;
  readonly purpose: "pending_canary_auto_approval_training";
  readonly pending_count: number;
  readonly sweep_summary: AutonomousPendingClosurePlan["summary"];
  readonly samples: readonly PendingCanaryTrainingSample[];
}

function source(metadata: JsonObject): string {
  return typeof metadata.source === "string" && metadata.source.trim() ? metadata.source : "unknown";
}

function agentId(row: PendingAutonomousClosureRow): string {
  return typeof row.metadata.agent_id === "string" && row.metadata.agent_id.trim()
    ? row.metadata.agent_id
    : row.created_by ?? "unknown";
}

function actionItems(plan: AutonomousPendingClosurePlan): PendingAutonomousClosureItem[] {
  return [
    ...plan.groups.would_approve_default,
    ...plan.groups.would_approve_explicit_issue,
    ...plan.groups.would_reject_closed,
    ...plan.groups.would_reject_sensitive,
    ...plan.groups.would_reject_test_noise,
    ...plan.groups.would_reject_unknown_source,
    ...plan.groups.would_event_log_only,
    ...plan.groups.would_keep_pending,
  ];
}

export function buildPendingCanaryTrainingReport(input: PendingCanaryTrainingReportInput): PendingCanaryTrainingReport {
  const itemById = new Map(actionItems(input.plan).map((item) => [item.id, item]));
  const samples = input.rows.map((row) => {
    const item = itemById.get(row.id);
    return {
      id: row.id,
      scope: `${row.scope_type}:${row.scope_id}`,
      source: source(row.metadata),
      agent_id: agentId(row),
      memory_type: row.memory_type,
      title: row.title,
      content_preview: row.content.slice(0, 240),
      autonomous_action: item?.autonomous_action ?? "keep_pending",
      memory_class: item?.memory_class ?? "unknown_source_quarantine",
      recall_policy: item?.recall_policy ?? "never",
      policy_action: item?.policy_action ?? "create_candidate",
      ...(item?.assistant_memory_kind ? { assistant_memory_kind: item.assistant_memory_kind } : {}),
      ...(item?.evidence_level ? { evidence_level: item.evidence_level } : {}),
      reasons: item?.reasons ?? ["missing_autonomous_plan_item"],
    } satisfies PendingCanaryTrainingSample;
  });
  return {
    ok: true,
    run_id: input.runId,
    generated_at: input.generatedAt,
    purpose: "pending_canary_auto_approval_training",
    pending_count: input.rows.length,
    sweep_summary: input.plan.summary,
    samples,
  };
}

import { randomUUID } from "node:crypto";

import { GovernanceRepository } from "../db/repositories/governance-repository";
import { stableGovernanceSelectorHash } from "./service";
import { isPostgresTransactionContext, type WriteTransactionContext } from "../db/tx/write-transaction";
import type { JsonObject } from "../shared/types";

const NEGATIVE_FEEDBACK = new Set(["wrong", "deleted", "not_relevant", "changed_mind", "negative"]);
const POSITIVE_FEEDBACK = new Set(["confirmed", "used"]);
const RECALL_NEGATIVE_FEEDBACK = new Set(["ignored", "not_relevant", "false_positive"]);

export interface AutoApprovalCohortFreezeMetricsInput {
  readonly sampleSize: number;
  readonly negativeCount: number;
  readonly rollbackCount?: number;
  readonly manualArchiveDeleteCount?: number;
  readonly recallNegativeCount?: number;
  readonly positiveCount?: number;
  readonly minSample: number;
  readonly falsePositiveFreezeRate: number;
  readonly rollbackFreezeRate: number;
  readonly manualArchiveDeleteFreezeRate: number;
  readonly recallNegativeFreezeRate: number;
}

export interface AutoApprovalCohortFreezeMetricsResult {
  readonly freeze: boolean;
  readonly reason: "freeze_threshold_met" | "insufficient_sample" | "below_threshold";
  readonly freezeTrigger: string | null;
  readonly triggeredBy: readonly string[];
  readonly approvalRate: number;
  readonly falsePositiveRate: number;
  readonly rollbackRate: number;
  readonly manualArchiveDeleteRate: number;
  readonly recallNegativeFeedbackRate: number;
  readonly cleanRunCount: number;
}

export interface AutoApprovalFeedbackGovernanceResult {
  readonly triggered: boolean;
  readonly actionId?: string;
  readonly selector?: JsonObject;
  readonly stats?: JsonObject;
  readonly reason?: string;
}

export function shouldFreezeAutoApprovalCohort(input: {
  readonly sampleSize: number;
  readonly negativeCount: number;
  readonly minSample: number;
  readonly freezeRate: number;
}): { readonly freeze: boolean; readonly falsePositiveRate: number; readonly reason: "freeze_threshold_met" | "insufficient_sample" | "below_threshold" } {
  const falsePositiveRate = input.sampleSize > 0 ? input.negativeCount / input.sampleSize : 0;
  if (input.sampleSize < input.minSample) {
    return { freeze: false, falsePositiveRate, reason: "insufficient_sample" };
  }
  if (falsePositiveRate >= input.freezeRate) {
    return { freeze: true, falsePositiveRate, reason: "freeze_threshold_met" };
  }
  return { freeze: false, falsePositiveRate, reason: "below_threshold" };
}

export function shouldFreezeAutoApprovalCohortMetrics(
  input: AutoApprovalCohortFreezeMetricsInput
): AutoApprovalCohortFreezeMetricsResult {
  const denominator = input.sampleSize > 0 ? input.sampleSize : 0;
  const rate = (count: number | undefined): number => (denominator > 0 ? (count ?? 0) / denominator : 0);
  const falsePositiveRate = rate(input.negativeCount);
  const rollbackRate = rate(input.rollbackCount);
  const manualArchiveDeleteRate = rate(input.manualArchiveDeleteCount);
  const recallNegativeFeedbackRate = rate(input.recallNegativeCount);
  const cleanRunCount = Math.max(0, (input.positiveCount ?? 0) - input.negativeCount);
  const approvalRate = input.sampleSize > 0 ? 1 : 0;
  if (input.sampleSize < input.minSample) {
    return {
      freeze: false,
      reason: "insufficient_sample",
      freezeTrigger: null,
      triggeredBy: [],
      approvalRate,
      falsePositiveRate,
      rollbackRate,
      manualArchiveDeleteRate,
      recallNegativeFeedbackRate,
      cleanRunCount,
    };
  }
  const triggeredBy = [
    ...(falsePositiveRate >= input.falsePositiveFreezeRate ? ["false_positive_rate"] : []),
    ...(rollbackRate >= input.rollbackFreezeRate ? ["rollback_rate"] : []),
    ...(manualArchiveDeleteRate >= input.manualArchiveDeleteFreezeRate ? ["manual_archive_delete_rate"] : []),
    ...(recallNegativeFeedbackRate >= input.recallNegativeFreezeRate ? ["recall_negative_feedback_rate"] : []),
  ];
  return {
    freeze: triggeredBy.length > 0,
    reason: triggeredBy.length > 0 ? "freeze_threshold_met" : "below_threshold",
    freezeTrigger: triggeredBy[0] ?? null,
    triggeredBy,
    approvalRate,
    falsePositiveRate,
    rollbackRate,
    manualArchiveDeleteRate,
    recallNegativeFeedbackRate,
    cleanRunCount,
  };
}

function readNumberEnv(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function addDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export async function applyAutoApprovalFeedbackGovernance(
  tx: WriteTransactionContext,
  input: {
    readonly memoryId: string;
    readonly feedbackEventId: string;
    readonly feedbackType: string;
    readonly actorId: string;
  }
): Promise<AutoApprovalFeedbackGovernanceResult> {
  if (!NEGATIVE_FEEDBACK.has(input.feedbackType) && !POSITIVE_FEEDBACK.has(input.feedbackType)) {
    return { triggered: false, reason: "feedback_type_not_governed" };
  }
  if (!isPostgresTransactionContext(tx)) {
    return { triggered: false, reason: "postgres_required" };
  }

  const [decision] = await tx.query<{
    id: string;
    agent_id: string;
    scope_type: string;
    scope_id: string;
    metadata: JsonObject;
    memory_type: string | null;
    source: string | null;
  }>(
    `
      SELECT d.id, d.agent_id, d.scope_type, d.scope_id, d.metadata,
        r.memory_type,
        COALESCE(r.metadata->>'source', d.metadata->>'source', '') AS source
      FROM auto_approval_decisions d
      JOIN memory_records r ON r.id = COALESCE(d.approved_memory_id, d.candidate_memory_id)
      WHERE COALESCE(d.approved_memory_id, d.candidate_memory_id) = $1
        AND d.decision = 'approve'
      ORDER BY d.created_at DESC
      LIMIT 1
    `,
    [input.memoryId]
  );
  if (!decision) return { triggered: false, reason: "not_auto_approved_memory" };

  const selector = {
    agent_id: decision.agent_id,
    scope_type: decision.scope_type,
    scope_id: decision.scope_id,
    memory_type: decision.memory_type ?? "unknown",
    source: decision.source ?? "",
  } satisfies JsonObject;
  const selectorHash = stableGovernanceSelectorHash(selector);
  const minSample = readIntEnv("MEMORY_V2_AUTO_APPROVAL_MIN_COHORT_SAMPLE", 20);
  const freezeRate = readNumberEnv(
    "MEMORY_V2_AUTO_APPROVAL_NEGATIVE_FREEZE_THRESHOLD",
    readNumberEnv("MEMORY_V2_AUTO_APPROVAL_FALSE_POSITIVE_FREEZE_RATE", 0.05)
  );
  const rollbackFreezeRate = readNumberEnv("MEMORY_V2_AUTO_APPROVAL_ROLLBACK_FREEZE_THRESHOLD", 0.03);
  const manualArchiveDeleteFreezeRate = readNumberEnv("MEMORY_V2_AUTO_APPROVAL_MANUAL_DELETE_FREEZE_THRESHOLD", 0.05);
  const recallNegativeFreezeRate = readNumberEnv("MEMORY_V2_AUTO_APPROVAL_RECALL_NEGATIVE_FREEZE_THRESHOLD", 0.05);

  const [stats] = await tx.query<{
    sample_size: string;
    negative_count: string;
    positive_count: string;
    rollback_count: string;
    manual_archive_delete_count: string;
    recall_negative_count: string;
  }>(
    `
      WITH cohort AS (
        SELECT DISTINCT COALESCE(d.approved_memory_id, d.candidate_memory_id) AS memory_id
        FROM auto_approval_decisions d
        LEFT JOIN memory_records r ON r.id = COALESCE(d.approved_memory_id, d.candidate_memory_id)
        WHERE d.decision = 'approve'
          AND d.agent_id = $1
          AND d.scope_type = $2
          AND d.scope_id = $3
          AND COALESCE(r.memory_type, 'unknown') = $4
          AND COALESCE(r.metadata->>'source', d.metadata->>'source', '') = $5
          AND d.created_at >= now() - interval '24 hours'
      )
      SELECT
        count(DISTINCT cohort.memory_id)::text AS sample_size,
        (
          SELECT count(DISTINCT f.memory_id)
          FROM memory_feedback_events f
          JOIN cohort c ON c.memory_id = f.memory_id
          WHERE f.feedback_type = ANY($6::text[])
        )::text AS negative_count,
        (
          SELECT count(DISTINCT f.memory_id)
          FROM memory_feedback_events f
          JOIN cohort c ON c.memory_id = f.memory_id
          WHERE f.feedback_type = ANY($7::text[])
        )::text AS positive_count,
        (
          SELECT count(DISTINCT c.memory_id)
          FROM cohort c
          WHERE EXISTS (
              SELECT 1 FROM auto_approval_decisions rd
              WHERE COALESCE(rd.approved_memory_id, rd.candidate_memory_id) = c.memory_id
                AND rd.rollback_memory_event_id IS NOT NULL
            )
            OR EXISTS (
              SELECT 1 FROM memory_governance_actions ga
              WHERE ga.memory_id = c.memory_id
                AND ga.action_type = 'auto_approval_rollback'
                AND ga.status IN ('applied', 'reported')
            )
        )::text AS rollback_count,
        (
          SELECT count(DISTINCT c.memory_id)
          FROM cohort c
          JOIN memory_records mr ON mr.id = c.memory_id
          WHERE mr.lifecycle_status IN ('archived', 'tombstone', 'rejected')
            AND NOT EXISTS (
              SELECT 1 FROM auto_approval_decisions rd
              WHERE COALESCE(rd.approved_memory_id, rd.candidate_memory_id) = c.memory_id
                AND rd.rollback_memory_event_id IS NOT NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM memory_governance_actions ga
              WHERE ga.memory_id = c.memory_id
                AND ga.action_type = 'auto_approval_rollback'
                AND ga.status IN ('applied', 'reported')
            )
        )::text AS manual_archive_delete_count,
        (
          SELECT count(DISTINCT rf.memory_id)
          FROM recall_feedback_events rf
          JOIN cohort c ON c.memory_id = rf.memory_id
          WHERE rf.feedback_type = ANY($8::text[])
        )::text AS recall_negative_count
      FROM cohort
    `,
    [
      selector.agent_id,
      selector.scope_type,
      selector.scope_id,
      selector.memory_type,
      selector.source,
      [...NEGATIVE_FEEDBACK],
      [...POSITIVE_FEEDBACK],
      [...RECALL_NEGATIVE_FEEDBACK],
    ]
  );

  const sampleSize = Number(stats?.sample_size ?? 0);
  const negativeCount = Number(stats?.negative_count ?? 0);
  const positiveCount = Number(stats?.positive_count ?? 0);
  const rollbackCount = Number(stats?.rollback_count ?? 0);
  const manualArchiveDeleteCount = Number(stats?.manual_archive_delete_count ?? 0);
  const recallNegativeCount = Number(stats?.recall_negative_count ?? 0);
  const freezeDecision = shouldFreezeAutoApprovalCohortMetrics({
    sampleSize,
    negativeCount,
    rollbackCount,
    manualArchiveDeleteCount,
    recallNegativeCount,
    positiveCount,
    minSample,
    falsePositiveFreezeRate: freezeRate,
    rollbackFreezeRate,
    manualArchiveDeleteFreezeRate,
    recallNegativeFreezeRate,
  });
  const falsePositiveRate = freezeDecision.falsePositiveRate;
  const evidence = {
    feedback_event_id: input.feedbackEventId,
    feedback_type: input.feedbackType,
    decision_id: decision.id,
    selector,
    sample_size: sampleSize,
    negative_count: negativeCount,
    positive_count: positiveCount,
    rollback_count: rollbackCount,
    manual_archive_delete_count: manualArchiveDeleteCount,
    recall_negative_count: recallNegativeCount,
    approval_rate: freezeDecision.approvalRate,
    false_positive_rate: falsePositiveRate,
    rollback_rate: freezeDecision.rollbackRate,
    manual_archive_delete_rate: freezeDecision.manualArchiveDeleteRate,
    recall_negative_feedback_rate: freezeDecision.recallNegativeFeedbackRate,
    clean_run_count: freezeDecision.cleanRunCount,
    freeze_trigger: freezeDecision.freezeTrigger,
    freeze_triggered_by: [...freezeDecision.triggeredBy],
    freeze_window_hours: 24,
    freeze_threshold: freezeRate,
    false_positive_freeze_threshold: freezeRate,
    rollback_freeze_threshold: rollbackFreezeRate,
    manual_archive_delete_freeze_threshold: manualArchiveDeleteFreezeRate,
    recall_negative_freeze_threshold: recallNegativeFreezeRate,
    min_sample: minSample,
    cohort_selector: selector,
  } satisfies JsonObject;

  if (freezeDecision.freeze) {
    const override = await new GovernanceRepository().upsertPolicyOverride(tx, {
      selectorHash,
      selector,
      policyType: "silent_approve",
      threshold: null,
      defaultThreshold: null,
      autoApproveEnabled: false,
      cleanRunCount: 0,
      lastCohortAt: tx.now(),
      expiresAt: addDays(7),
      metadata: {
        source: "auto_approval_feedback_freeze",
        ...evidence,
      },
    });
    const action = await new GovernanceRepository().recordAction(tx, {
      actionType: "auto_approval_cohort_frozen",
      scopeType: decision.scope_type,
      scopeId: decision.scope_id,
      memoryId: input.memoryId,
      selector,
      evidence,
      afterState: { governance_policy_override_id: override.id, auto_approve_enabled: false },
      status: "applied",
      createdBy: input.actorId,
    });
    await tx.query(
      `
        UPDATE memory_feedback_events
        SET governance_triggered = TRUE,
            governance_action_id = $2
        WHERE id = $1
      `,
      [input.feedbackEventId, action.id]
    );
    return { triggered: true, actionId: action.id, selector, stats: evidence };
  }

  if (POSITIVE_FEEDBACK.has(input.feedbackType)) {
    await new GovernanceRepository().upsertPolicyOverride(tx, {
      selectorHash,
      selector,
      policyType: "silent_approve",
      threshold: null,
      defaultThreshold: null,
      autoApproveEnabled: null,
      cleanRunCount: positiveCount,
      lastCohortAt: tx.now(),
      expiresAt: addDays(7),
      metadata: {
        source: "auto_approval_positive_feedback_observed",
        ...evidence,
      },
    });
  }

  return { triggered: false, selector, stats: evidence, reason: "threshold_not_met" };
}

import type { JsonObject } from "../shared";
import {
  evaluateMemoryPolicy,
  type MemoryPolicyAction,
  type MemoryPolicyResult,
} from "./memory-policy-engine";

export interface PendingPolicyBackfillRow {
  readonly id: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly title: string | null;
  readonly content: string;
  readonly memory_type: string | null;
  readonly metadata: JsonObject;
  readonly created_by: string | null;
}

export interface PendingPolicyBackfillItem {
  readonly id: string;
  readonly memory_class: MemoryPolicyResult["memory_class"];
  readonly recall_policy: MemoryPolicyResult["recall_policy"];
  readonly policy_action: MemoryPolicyAction;
  readonly storage_target: MemoryPolicyResult["storage_target"];
  readonly lifecycle_intent: MemoryPolicyResult["lifecycle_intent"];
  readonly reasons: readonly string[];
}

export interface PendingPolicyBackfillPlan {
  readonly groups: {
    readonly would_reject_by_policy: PendingPolicyBackfillItem[];
    readonly would_quarantine: PendingPolicyBackfillItem[];
    readonly would_mark_test_only: PendingPolicyBackfillItem[];
    readonly would_mark_audit_only: PendingPolicyBackfillItem[];
    readonly would_keep_review: PendingPolicyBackfillItem[];
  };
  readonly summary: {
    readonly total: number;
    readonly would_reject_by_policy: number;
    readonly would_quarantine: number;
    readonly would_mark_test_only: number;
    readonly would_mark_audit_only: number;
    readonly would_keep_review: number;
    readonly would_approve: 0;
  };
}

export interface BackfillEvidenceOptions {
  readonly runId: string;
  readonly appliedAt: string;
}

export interface BackfillGovernanceActionInput {
  readonly runId: string;
  readonly row: PendingPolicyBackfillRow;
  readonly item: PendingPolicyBackfillItem;
  readonly beforeState: JsonObject;
  readonly afterState: JsonObject;
}

export interface BackfillGovernanceAction {
  readonly actionType: "memory_policy_backfill";
  readonly memoryId: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly selector: JsonObject;
  readonly evidence: JsonObject;
  readonly beforeState: JsonObject;
  readonly afterState: JsonObject;
  readonly status: "applied";
  readonly createdBy: "memory-xx-policy-backfill";
}

export function planPendingPolicyBackfill(rows: readonly PendingPolicyBackfillRow[]): PendingPolicyBackfillPlan {
  const groups: PendingPolicyBackfillPlan["groups"] = {
    would_reject_by_policy: [],
    would_quarantine: [],
    would_mark_test_only: [],
    would_mark_audit_only: [],
    would_keep_review: [],
  };

  for (const row of rows) {
    const source = typeof row.metadata.source === "string" ? row.metadata.source : "unknown";
    const result = evaluateMemoryPolicy({
      source,
      sourceText: row.content,
      baseDecision: "pending",
      blockedReasons: [],
      candidate: {
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        memoryType: row.memory_type,
        operation: "create",
        confidence: 0.7,
        qualityScore: 0.7,
        title: row.title,
        content: row.content,
        metadata: row.metadata,
        memoryClass: typeof row.metadata.memory_class === "string" ? row.metadata.memory_class : null,
      },
    });
    const item: PendingPolicyBackfillItem = {
      id: row.id,
      memory_class: result.memory_class,
      recall_policy: result.recall_policy,
      policy_action: result.policy_action,
      storage_target: result.storage_target,
      lifecycle_intent: result.lifecycle_intent,
      reasons: result.reasons,
    };
    if (result.policy_action === "reject_by_policy") {
      groups.would_reject_by_policy.push(item);
    } else if (result.policy_action === "quarantine_candidate") {
      groups.would_quarantine.push(item);
    } else if (result.recall_policy === "test_only") {
      groups.would_mark_test_only.push(item);
    } else if (result.recall_policy === "audit_only") {
      groups.would_mark_audit_only.push(item);
    } else {
      groups.would_keep_review.push(item);
    }
  }

  return {
    groups,
    summary: {
      total: rows.length,
      would_reject_by_policy: groups.would_reject_by_policy.length,
      would_quarantine: groups.would_quarantine.length,
      would_mark_test_only: groups.would_mark_test_only.length,
      would_mark_audit_only: groups.would_mark_audit_only.length,
      would_keep_review: groups.would_keep_review.length,
      would_approve: 0,
    },
  };
}

export function buildBackfillMetadata(
  metadata: JsonObject,
  item: PendingPolicyBackfillItem,
  options?: BackfillEvidenceOptions,
): JsonObject {
  const appliedAt = options?.appliedAt ?? new Date().toISOString();
  const runId = options?.runId ?? `policy-backfill-${appliedAt}`;
  return {
    ...metadata,
    memory_class: item.memory_class,
    recall_policy: item.recall_policy,
    policy_action: item.policy_action,
    storage_target: item.storage_target,
    lifecycle_intent: item.lifecycle_intent,
    memory_policy_backfill: {
      applied_at: appliedAt,
      run_id: runId,
      policy_action: item.policy_action,
      memory_class: item.memory_class,
      recall_policy: item.recall_policy,
      reasons: [...item.reasons],
    },
  };
}

export function isBackfillAlreadyApplied(metadata: JsonObject, item: PendingPolicyBackfillItem): boolean {
  const backfill = metadata.memory_policy_backfill;
  if (backfill && typeof backfill === "object" && !Array.isArray(backfill)) {
    const record = backfill as Record<string, unknown>;
    if (
      record.policy_action === item.policy_action &&
      record.memory_class === item.memory_class &&
      record.recall_policy === item.recall_policy
    ) {
      return true;
    }
  }
  return metadata.policy_action === item.policy_action &&
    metadata.memory_class === item.memory_class &&
    metadata.recall_policy === item.recall_policy;
}

export function buildBackfillGovernanceAction(input: BackfillGovernanceActionInput): BackfillGovernanceAction {
  return {
    actionType: "memory_policy_backfill",
    memoryId: input.row.id,
    scopeType: input.row.scope_type,
    scopeId: input.row.scope_id,
    selector: {
      source: typeof input.row.metadata.source === "string" ? input.row.metadata.source : "unknown",
      created_by: input.row.created_by,
      memory_type: input.row.memory_type,
    },
    evidence: {
      backfill_run_id: input.runId,
      memory_class: input.item.memory_class,
      storage_target: input.item.storage_target,
      recall_policy: input.item.recall_policy,
      policy_action: input.item.policy_action,
      reasons: [...input.item.reasons],
    },
    beforeState: input.beforeState,
    afterState: input.afterState,
    status: "applied",
    createdBy: "memory-xx-policy-backfill",
  };
}

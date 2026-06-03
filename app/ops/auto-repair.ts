import type { QdrantProjectionReconcileResult } from "../qdrant-sync/consistency-reconcile";
import {
  buildQdrantProjectionIssue,
  DEFAULT_QDRANT_PROJECTION_REPAIR_POLICY,
  type MemoryRuntimeIssue,
  type QdrantProjectionRepairPolicy,
} from "./runtime-issues";

export interface MemoryAutoRepairPlanInput {
  readonly before: QdrantProjectionReconcileResult;
  readonly embeddingGenerationOk: boolean;
  readonly embeddingGenerationEvidence?: Record<string, unknown>;
  readonly policy?: Partial<QdrantProjectionRepairPolicy>;
  readonly checkedAt?: string;
}

export interface MemoryAutoRepairPlan {
  readonly ok: boolean;
  readonly can_apply: boolean;
  readonly policy: QdrantProjectionRepairPolicy;
  readonly issues: readonly MemoryRuntimeIssue[];
  readonly blocked_reasons: readonly string[];
  readonly recommended_action: string;
}

export function normalizeAutoRepairPolicy(input: Partial<QdrantProjectionRepairPolicy> = {}): QdrantProjectionRepairPolicy {
  return {
    maxDrift: positiveInt(input.maxDrift, DEFAULT_QDRANT_PROJECTION_REPAIR_POLICY.maxDrift),
    maxDelete: positiveInt(input.maxDelete, DEFAULT_QDRANT_PROJECTION_REPAIR_POLICY.maxDelete),
    maxUpsert: positiveInt(input.maxUpsert, DEFAULT_QDRANT_PROJECTION_REPAIR_POLICY.maxUpsert),
  };
}

export function evaluateMemoryAutoRepairPlan(input: MemoryAutoRepairPlanInput): MemoryAutoRepairPlan {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const policy = normalizeAutoRepairPolicy(input.policy);
  const issues: MemoryRuntimeIssue[] = [];
  const blockedReasons: string[] = [];

  const qdrantIssue = buildQdrantProjectionIssue(input.before.diff, { policy, checkedAt });
  if (qdrantIssue) issues.push(qdrantIssue);

  if (!input.embeddingGenerationOk) {
    issues.push({
      id: "embedding_generation_mismatch",
      severity: "critical",
      subsystem: "embedding",
      root_cause: "嵌入代际（embedding generation）未通过健康校验，自动修复不能确认写入的向量版本",
      evidence: input.embeddingGenerationEvidence ?? {},
      repairability: "blocked",
      recommended_action: "先人工运行 memory:embedding-manifest validate/status，确认 active manifest、alias、payload generation 一致。",
      repair_command: "TMPDIR=/tmp npm run memory:embedding-manifest -- status",
      last_checked_at: checkedAt,
    });
    blockedReasons.push("embedding_generation_not_ok");
  }

  for (const issue of issues) {
    if (issue.repairability !== "auto_safe") {
      blockedReasons.push(`${issue.id}:${issue.repairability}`);
    }
  }

  const ok = issues.length === 0;
  const canApply = !ok && blockedReasons.length === 0 && issues.every((issue) => issue.repairability === "auto_safe");
  return {
    ok,
    can_apply: canApply,
    policy,
    issues,
    blocked_reasons: [...new Set(blockedReasons)],
    recommended_action: ok
      ? "无需修复。"
      : canApply
        ? "可执行 memory:auto-repair -- --apply 自动修复。"
        : "自动修复已阻断；按 issues[].recommended_action 先人工处理。",
  };
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

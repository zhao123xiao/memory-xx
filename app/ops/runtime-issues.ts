import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { QdrantProjectionConsistencyDiff } from "../qdrant-sync/consistency-reconcile";

export type MemoryRuntimeIssueSeverity = "info" | "warning" | "degraded" | "critical";
export type MemoryRuntimeIssueSubsystem =
  | "runtime"
  | "qdrant"
  | "embedding"
  | "projector"
  | "recall"
  | "governance"
  | "config";
export type MemoryRuntimeIssueRepairability = "auto_safe" | "manual_safe" | "blocked";
export type MemoryServiceStatus = "ok" | "degraded" | "repairing" | "blocked";

export interface MemoryRuntimeIssue {
  readonly id: string;
  readonly severity: MemoryRuntimeIssueSeverity;
  readonly subsystem: MemoryRuntimeIssueSubsystem;
  readonly root_cause: string;
  readonly evidence: Record<string, unknown>;
  readonly repairability: MemoryRuntimeIssueRepairability;
  readonly recommended_action: string;
  readonly repair_command?: string;
  readonly last_checked_at: string;
}

export interface QdrantProjectionRepairPolicy {
  readonly maxDrift: number;
  readonly maxDelete: number;
  readonly maxUpsert: number;
}

export interface RepairRunSummary {
  readonly path?: string;
  readonly run_id?: string;
  readonly status?: string;
  readonly mode?: string;
  readonly ok?: boolean;
  readonly checked_at?: string;
  readonly completed_at?: string;
  readonly issues?: readonly MemoryRuntimeIssue[];
  readonly before?: unknown;
  readonly after?: unknown;
}

export const DEFAULT_QDRANT_PROJECTION_REPAIR_POLICY: QdrantProjectionRepairPolicy = {
  maxDrift: 100,
  maxDelete: 20,
  maxUpsert: 100,
};

export function qdrantProjectionDriftTotals(diff: QdrantProjectionConsistencyDiff): {
  readonly total: number;
  readonly deleteCount: number;
  readonly upsertCount: number;
  readonly staleCount: number;
  readonly missingCount: number;
  readonly payloadDriftCount: number;
  readonly orphanCount: number;
} {
  const staleCount = diff.staleMemoryIds.length;
  const missingCount = diff.missingMemoryIds.length;
  const payloadDriftCount = diff.payloadDriftMemoryIds.length;
  const orphanCount = diff.orphanPointIds.length;
  return {
    total: staleCount + missingCount + payloadDriftCount + orphanCount,
    deleteCount: staleCount + orphanCount,
    upsertCount: missingCount,
    staleCount,
    missingCount,
    payloadDriftCount,
    orphanCount,
  };
}

export function explainQdrantProjectionPolicy(
  diff: QdrantProjectionConsistencyDiff,
  policy: QdrantProjectionRepairPolicy = DEFAULT_QDRANT_PROJECTION_REPAIR_POLICY
): { readonly autoSafe: boolean; readonly blockers: readonly string[] } {
  const totals = qdrantProjectionDriftTotals(diff);
  const blockers: string[] = [];
  if (totals.total > policy.maxDrift) blockers.push("drift_over_threshold");
  if (totals.deleteCount > policy.maxDelete) blockers.push("delete_over_threshold");
  if (totals.upsertCount > policy.maxUpsert) blockers.push("upsert_over_threshold");
  if (totals.payloadDriftCount > 0) blockers.push("payload_drift_requires_manual_review");
  return { autoSafe: blockers.length === 0, blockers };
}

export function buildQdrantProjectionIssue(
  diff: QdrantProjectionConsistencyDiff,
  options: {
    readonly policy?: QdrantProjectionRepairPolicy;
    readonly checkedAt?: string;
  } = {}
): MemoryRuntimeIssue | null {
  const totals = qdrantProjectionDriftTotals(diff);
  if (totals.total === 0) return null;

  const policy = options.policy ?? DEFAULT_QDRANT_PROJECTION_REPAIR_POLICY;
  const policyResult = explainQdrantProjectionPolicy(diff, policy);
  const repairability: MemoryRuntimeIssueRepairability = policyResult.autoSafe ? "auto_safe" : "blocked";
  const severity: MemoryRuntimeIssueSeverity = policyResult.autoSafe ? "degraded" : "critical";

  return {
    id: "qdrant_projection_drift",
    severity,
    subsystem: "qdrant",
    root_cause: [
      totals.staleCount > 0 ? "Qdrant 存在 PG 已不可召回的投影残留" : "",
      totals.missingCount > 0 ? "PG 中存在可召回记忆但 Qdrant 缺少投影" : "",
      totals.orphanCount > 0 ? "Qdrant 存在无法映射到 memory_id 的孤儿 point" : "",
      totals.payloadDriftCount > 0 ? "Qdrant payload 与 PG 事实源不一致" : "",
    ].filter(Boolean).join("；"),
    evidence: {
      qdrant_point_count: diff.qdrantPointCount,
      qdrant_memory_id_count: diff.qdrantMemoryIdCount,
      postgres_effective_recallable_count: diff.postgresEffectiveRecallableCount,
      stale_count: totals.staleCount,
      missing_count: totals.missingCount,
      orphan_count: totals.orphanCount,
      payload_drift_count: totals.payloadDriftCount,
      total_drift: totals.total,
      policy,
      policy_blockers: policyResult.blockers,
      sample_stale_memory_ids: diff.staleMemoryIds.slice(0, 10),
      sample_missing_memory_ids: diff.missingMemoryIds.slice(0, 10),
      sample_orphan_point_ids: diff.orphanPointIds.slice(0, 10),
      sample_payload_drift_memory_ids: diff.payloadDriftMemoryIds.slice(0, 10),
    },
    repairability,
    recommended_action: policyResult.autoSafe
      ? "运行 memory:auto-repair -- --apply，按 PG 事实源安全修复小规模 Qdrant 投影漂移。"
      : "先人工确认 drift 规模、payload drift、embedding generation 与 alias，再决定是否分批 reconcile。",
    repair_command: policyResult.autoSafe
      ? `TMPDIR=/tmp npm run memory:auto-repair -- --apply --max-drift=${policy.maxDrift} --max-delete=${policy.maxDelete} --max-upsert=${policy.maxUpsert} --json`
      : undefined,
    last_checked_at: options.checkedAt ?? new Date().toISOString(),
  };
}

export function buildHealthRuntimeIssues(input: {
  readonly runtimeInitialised: boolean;
  readonly vectorAvailable: boolean;
  readonly vectorReason?: string;
  readonly generationOk: boolean;
  readonly providerMatchesActiveGeneration: boolean | null;
  readonly tokenSeparationOk: boolean;
  readonly configValidationOk: boolean;
  readonly checkedAt?: string;
}): MemoryRuntimeIssue[] {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const issues: MemoryRuntimeIssue[] = [];
  if (!input.runtimeInitialised || !input.vectorAvailable) {
    issues.push({
      id: "runtime_vector_unavailable",
      severity: "critical",
      subsystem: "runtime",
      root_cause: input.runtimeInitialised ? "向量检索后端不可用" : "wrapper runtime 尚未初始化",
      evidence: {
        runtime_initialised: input.runtimeInitialised,
        vector_available: input.vectorAvailable,
        vector_reason: input.vectorReason,
      },
      repairability: "manual_safe",
      recommended_action: "检查 wrapper、PostgreSQL、Qdrant/pgvector 连接状态，修复依赖后重启 wrapper。",
      last_checked_at: checkedAt,
    });
  }
  if (!input.generationOk || input.providerMatchesActiveGeneration === false) {
    issues.push({
      id: "embedding_generation_mismatch",
      severity: "critical",
      subsystem: "embedding",
      root_cause: input.generationOk ? "当前 embedding provider 与 active manifest 不一致" : "active embedding manifest 未通过健康校验",
      evidence: {
        generation_ok: input.generationOk,
        provider_matches_active_generation: input.providerMatchesActiveGeneration,
      },
      repairability: "blocked",
      recommended_action: "运行 memory:embedding-manifest status/validate，人工确认后再 activate 或 rollback；系统不会自动切换 generation。",
      repair_command: "TMPDIR=/tmp npm run memory:embedding-manifest -- status",
      last_checked_at: checkedAt,
    });
  }
  if (!input.tokenSeparationOk) {
    issues.push({
      id: "api_admin_token_overlap",
      severity: "critical",
      subsystem: "config",
      root_cause: "接口令牌（API token）与管理令牌（admin token）未隔离",
      evidence: { token_separation_ok: false },
      repairability: "blocked",
      recommended_action: "手动设置不同的 MEMORY_V2_API_TOKEN 与 MEMORY_V2_ADMIN_TOKEN 后重启服务。",
      last_checked_at: checkedAt,
    });
  }
  if (!input.configValidationOk) {
    issues.push({
      id: "runtime_config_invalid",
      severity: "critical",
      subsystem: "config",
      root_cause: "运行配置校验未通过",
      evidence: { config_validation_ok: false },
      repairability: "manual_safe",
      recommended_action: "查看 health.config_validation 或 memory:doctor 输出，修复环境变量/配置后重启服务。",
      last_checked_at: checkedAt,
    });
  }
  return issues;
}

export function deriveMemoryServiceStatus(input: {
  readonly baseOk: boolean;
  readonly issues: readonly MemoryRuntimeIssue[];
  readonly repairSummary?: RepairRunSummary | null;
}): MemoryServiceStatus {
  const issues = [
    ...input.issues,
    ...(input.repairSummary?.issues ?? []),
  ];
  if (input.repairSummary?.status === "repairing") return "repairing";
  if (issues.some((issue) => issue.repairability === "blocked" || issue.severity === "critical")) {
    return "blocked";
  }
  if (!input.baseOk || issues.length > 0 || input.repairSummary?.ok === false) return "degraded";
  return "ok";
}

export function readLatestRepairRunSummary(runtimeDir = process.env.MEMORY_V2_RUNTIME_DIR?.trim() || `${process.cwd()}/.runtime`): RepairRunSummary | null {
  const dir = path.join(runtimeDir, "repair-runs");
  const latestPath = path.join(dir, "latest.json");
  const candidate = existsSync(latestPath)
    ? latestPath
    : latestJsonFile(dir);
  if (!candidate) return null;
  try {
    const body = JSON.parse(readFileSync(candidate, "utf8")) as RepairRunSummary;
    return { ...body, path: candidate };
  } catch (error) {
    return {
      path: candidate,
      status: "unreadable",
      ok: false,
      issues: [{
        id: "repair_artifact_unreadable",
        severity: "warning",
        subsystem: "runtime",
        root_cause: "最近一次 repair run artifact 无法读取",
        evidence: { path: candidate, error: error instanceof Error ? error.message : String(error) },
        repairability: "manual_safe",
        recommended_action: "检查 .runtime/repair-runs/latest.json 文件权限和 JSON 内容。",
        last_checked_at: new Date().toISOString(),
      }],
    };
  }
}

function latestJsonFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(dir, file))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}

export interface MemoryLandingCommandStatus {
  readonly ok: boolean;
  readonly exit_code?: number;
  readonly error?: string | null;
}

export interface MemoryLandingScanInput {
  readonly generatedAt?: string;
  readonly memoryStatus: Record<string, unknown> | null;
  readonly pending: Record<string, unknown> | null;
  readonly qdrantReconcile: Record<string, unknown> | null;
  readonly p1Gate: Record<string, unknown> | null;
  readonly policyReport: Record<string, unknown> | null;
  readonly autoApprovalStatus: Record<string, unknown> | null;
  readonly productionGuard: Record<string, unknown> | null;
  readonly conversationSources: Record<string, unknown> | null;
  readonly conversationMonitorReport?: Record<string, unknown> | null;
  readonly requiredConversationSources?: readonly string[];
  readonly commandStatus?: Record<string, MemoryLandingCommandStatus>;
}

export interface MemoryLandingScanReport {
  readonly ok: boolean;
  readonly generated_at: string;
  readonly current_usability: "usable" | "degraded" | "unusable";
  readonly production_landing_complete: boolean;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly capability_status: Record<string, "ok" | "warning" | "blocked" | "unknown">;
  readonly current_state: Record<string, unknown>;
  readonly gaps: readonly string[];
  readonly next_actions: readonly string[];
  readonly snapshots: Record<string, unknown>;
  readonly command_status: Record<string, MemoryLandingCommandStatus>;
}

const DEFAULT_REQUIRED_CONVERSATION_SOURCES = ["codex_session", "claude_code_session"] as const;

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return arrayValue(value).filter((item): item is string => typeof item === "string");
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function qdrantDrift(input: Record<string, unknown> | null): number {
  if (!input) return Number.POSITIVE_INFINITY;
  const diff = objectValue(input.diff);
  const direct = [
    "stale",
    "missing",
    "payload_drift",
    "orphan",
  ].reduce((sum, key) => sum + numberValue(input[key]), 0);
  if (direct > 0) return direct;
  return [
    "staleMemoryIds",
    "missingMemoryIds",
    "payloadDriftMemoryIds",
    "orphanPointIds",
    "stale",
    "missing",
    "payloadDrift",
    "orphanPoints",
  ].reduce((sum, key) => sum + arrayValue(diff[key]).length, 0);
}

function conversationAdapterSummary(conversationSources: Record<string, unknown> | null): Record<string, unknown> {
  const adapters = arrayValue(conversationSources?.source_adapters ?? conversationSources?.adapters)
    .map(objectValue);
  return {
    adapter_count: adapters.length,
    adapters: adapters.map((adapter) => ({
      adapter: adapter.adapter ?? "unknown",
      files: numberValue(adapter.files),
      events: numberValue(adapter.events),
      skipped: numberValue(adapter.skipped),
      last_event_at: adapter.last_event_at ?? null,
    })),
    source_events: numberValue(conversationSources?.source_events ?? conversationSources?.source_events_posted),
    source_skipped: numberValue(conversationSources?.source_skipped),
  };
}

export function buildMemoryLandingScanReport(input: MemoryLandingScanInput): MemoryLandingScanReport {
  const memoryStatus = objectValue(input.memoryStatus);
  const pending = objectValue(input.pending ?? memoryStatus.pending);
  const qdrantReconcile = objectValue(input.qdrantReconcile ?? memoryStatus.qdrant_projection);
  const p1Gate = objectValue(input.p1Gate ?? memoryStatus.p1_gate);
  const policyReport = objectValue(input.policyReport);
  const autoApprovalStatus = objectValue(input.autoApprovalStatus);
  const productionGuard = objectValue(input.productionGuard);
  const conversationSources = objectValue(input.conversationSources ?? memoryStatus.conversation_sources);
  const conversationMonitorReport = objectValue(input.conversationMonitorReport);
  const requiredConversationSources = (input.requiredConversationSources?.length ? input.requiredConversationSources : DEFAULT_REQUIRED_CONVERSATION_SOURCES)
    .map((source) => source.trim())
    .filter((source) => source.length > 0);

  const blockers: string[] = [];
  const warnings: string[] = [];
  const gaps: string[] = [];
  const nextActions: string[] = [];
  const capabilityStatus: Record<string, "ok" | "warning" | "blocked" | "unknown"> = {};

  const runtimeOk = booleanValue(memoryStatus.runtime_ok);
  if (!runtimeOk) blockers.push("runtime_unhealthy");
  capabilityStatus.runtime_chain = runtimeOk ? "ok" : "blocked";

  const governanceOk = booleanValue(memoryStatus.governance_ok) && numberValue(pending.candidate_current) === 0;
  if (!governanceOk) blockers.push("pending_backlog_nonzero");
  capabilityStatus.pending_governance = governanceOk ? "ok" : "blocked";

  const drift = qdrantDrift(qdrantReconcile);
  const qdrantOk = booleanValue(qdrantReconcile.ok) && drift === 0;
  if (!qdrantOk) blockers.push("qdrant_drift_nonzero");
  capabilityStatus.qdrant_projection = qdrantOk ? "ok" : "blocked";

  const p1Warnings = stringArray(p1Gate.warnings);
  const p1Blockers = stringArray(p1Gate.blockers);
  const p1CompareWarning = p1Warnings.some((warning) => warning.includes("intelligence_compare_observations_sample_size_below_minimum"));
  const p1Ok = booleanValue(p1Gate.ok) && p1Blockers.length === 0 && !p1CompareWarning;
  if (p1Blockers.length > 0) blockers.push(...p1Blockers.map((blocker) => `p1:${blocker}`));
  if (p1CompareWarning) {
    blockers.push("p1_compare_observations_below_minimum");
    gaps.push("P1 compare observation 仍不足 20/24h，生产 guard 会继续阻塞。");
    nextActions.push("TMPDIR=/tmp npm run memory:intelligence-quality -- --compare-sample-size=20 --write-observations --json");
  }
  capabilityStatus.p1_quality_gate = p1Ok ? "ok" : "blocked";

  const compare = objectValue(policyReport.compare_observations);
  const compareCount = numberValue(compare.count);
  if (compareCount < numberValue(compare.minimum, 20)) {
    gaps.push(`质量对照样本不足：${compareCount}/${numberValue(compare.minimum, 20)}。`);
  }

  const guard = objectValue(productionGuard.guard);
  const guardBlockers = stringArray(guard.blockers);
  const guardWarnings = stringArray(guard.warnings);
  if (productionGuard.ok === false || guardBlockers.length > 0) {
    blockers.push(...guardBlockers.map((blocker) => `production_guard:${blocker}`));
  }
  warnings.push(...guardWarnings.map((warning) => `production_guard:${warning}`));
  capabilityStatus.production_guard = productionGuard.ok === true ? "ok" : "blocked";

  const statusReasons = stringArray(memoryStatus.status_reason);
  if (statusReasons.includes("timer_probe_unavailable") || memoryStatus.systemd_timer_probe_ok === false) {
    warnings.push("timer_probe_unavailable");
    gaps.push("systemd user bus 当前 shell 不可用，timer probe 只能作为 warning 记录。");
  }

  const conversationSummary = conversationAdapterSummary(conversationSources);
  const adapters = arrayValue(conversationSummary.adapters).map(objectValue);
  const sourceHasEvents = (source: string) => adapters.some((adapter) => adapter.adapter === source && numberValue(adapter.events) > 0);
  const missingConversationSources = requiredConversationSources.filter((source) => !sourceHasEvents(source));
  if (missingConversationSources.length > 0) {
    warnings.push("conversation_source_e2e_incomplete");
    gaps.push(`Required conversation source E2E samples missing: ${missingConversationSources.join(", ")}.`);
  }
  capabilityStatus.conversation_sources = missingConversationSources.length === 0 ? "ok" : "warning";

  const candidateOnly = objectValue(autoApprovalStatus.candidate_only);
  if (candidateOnly.enabled === true) {
    warnings.push("candidate_only_kill_switch_enabled");
    gaps.push("candidate_only 仍开启，说明全自动审批尚未进入完全放开状态。");
  }

  const readiness = objectValue(autoApprovalStatus.readiness);
  const updateApply = objectValue(readiness.update_apply_enablement);
  if (updateApply.enabled !== true || updateApply.real_project_apply !== true) {
    gaps.push("真实生产 update/supersede/apply 尚未开放，只能继续 dry-run 或 test scope 验证。");
  }
  const enabledScopes = stringArray(objectValue(autoApprovalStatus.real_scope_enablements).enabled_scopes);
  if (!enabledScopes.includes("global:global")) {
    gaps.push("global 自动写入未开放；这是当前阶段的正确安全边界。");
  }

  const windows = objectValue(policyReport.windows);
  const last24h = objectValue(windows.last_24h);
  if (numberValue(last24h.total) < 20) {
    warnings.push("real_policy_feedback_low");
    gaps.push(`近 24h policy 决策样本偏少：${numberValue(last24h.total)} 条，不足以证明真实生产分布稳定。`);
  }

  const uniqueBlockers = [...new Set(blockers)];
  const uniqueWarnings = [...new Set(warnings)];
  const runtimeUsable = runtimeOk && governanceOk && qdrantOk;
  const productionLandingComplete = uniqueBlockers.length === 0
    && compareCount >= numberValue(compare.minimum, 20)
    && missingConversationSources.length === 0
    && candidateOnly.enabled !== true
    && productionGuard.ok === true;

  if (!runtimeUsable) nextActions.unshift("先修复 runtime/pending/Qdrant 任一 blocker，再讨论自动审批扩权。");
  if (!productionLandingComplete) {
    nextActions.push("保持 global 和 real update/apply 关闭，继续 project/user add-only 受控 canary。");
    nextActions.push("连续 7 天保存 landing scan 报告，满足稳定性标准后再评估 candidate_only 退出。");
  }

  return {
    ok: runtimeUsable,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    current_usability: runtimeUsable ? "usable" : uniqueBlockers.length > 0 ? "unusable" : "degraded",
    production_landing_complete: productionLandingComplete,
    blockers: uniqueBlockers,
    warnings: uniqueWarnings,
    capability_status: capabilityStatus,
    current_state: {
      runtime_ok: runtimeOk,
      governance_ok: governanceOk,
      candidate_current: numberValue(pending.candidate_current),
      qdrant_drift: drift,
      p1_ok_without_compare_warning: p1Ok,
      production_guard_ok: productionGuard.ok === true,
      compare_observations: {
        count: compareCount,
        minimum: numberValue(compare.minimum, 20),
        status: compare.status ?? "unknown",
      },
      conversation_sources: conversationSummary,
      required_conversation_sources: requiredConversationSources,
      missing_conversation_sources: missingConversationSources,
      conversation_monitor_report: {
        ok: conversationMonitorReport.ok ?? null,
        status: conversationMonitorReport.status ?? "unknown",
        sources: conversationMonitorReport.sources ?? {},
      },
      candidate_only: candidateOnly,
      enabled_real_scopes: enabledScopes,
    },
    gaps: [...new Set(gaps)],
    next_actions: [...new Set(nextActions)],
    snapshots: {
      memory_status: input.memoryStatus,
      pending: input.pending,
      qdrant_reconcile: input.qdrantReconcile,
      p1_gate: input.p1Gate,
      policy_report: input.policyReport,
      auto_approval_status: input.autoApprovalStatus,
      production_guard: input.productionGuard,
      conversation_sources: input.conversationSources,
      conversation_monitor_report: input.conversationMonitorReport,
    },
    command_status: input.commandStatus ?? {},
  };
}

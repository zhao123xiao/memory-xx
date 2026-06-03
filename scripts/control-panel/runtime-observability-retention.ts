export interface RuntimeObservabilityRetentionPolicy {
  readonly table: string;
  readonly timestamp_column: string;
  readonly retention_days: number;
  readonly keep_latest_per_project?: number;
  readonly reason: string;
}

export interface RuntimeObservabilityRetentionPlan {
  readonly policies: readonly RuntimeObservabilityRetentionPolicy[];
  readonly current_state_tables: readonly string[];
}

export interface RuntimeObservabilityRetentionResult {
  readonly ok: boolean;
  readonly mode: "dry_run" | "apply";
  readonly plan: RuntimeObservabilityRetentionPlan;
  readonly candidates: readonly {
    readonly table: string;
    readonly candidate_count: number;
    readonly retention_days: number;
    readonly deleted?: number;
  }[];
}

export function buildRuntimeObservabilityRetentionPlan(overrides: {
  readonly componentSnapshotDays?: number;
  readonly agentConnectionDays?: number;
  readonly opsAdvisorDays?: number;
  readonly codeGraphSnapshotDays?: number;
  readonly codeGraphKeepLatestPerProject?: number;
} = {}): RuntimeObservabilityRetentionPlan {
  return {
    policies: [
      {
        table: "runtime_component_snapshots",
        timestamp_column: "collected_at",
        retention_days: overrides.componentSnapshotDays ?? 7,
        reason: "组件健康是高频历史快照，保留 7 天用于趋势和故障回看。",
      },
      {
        table: "runtime_agent_connections",
        timestamp_column: "last_seen_at",
        retention_days: overrides.agentConnectionDays ?? 90,
        reason: "agent/client 连接保留 90 天，足够审计近期接入来源。",
      },
      {
        table: "ops_advisor_reports",
        timestamp_column: "generated_at",
        retention_days: overrides.opsAdvisorDays ?? 90,
        reason: "自动化运维建议保留 90 天，便于复盘策略变化。",
      },
      {
        table: "code_graph_project_snapshots",
        timestamp_column: "generated_at",
        retention_days: overrides.codeGraphSnapshotDays ?? 90,
        keep_latest_per_project: overrides.codeGraphKeepLatestPerProject ?? 20,
        reason: "code graph 按项目保留近期版本，并至少保留每项目最近 20 个快照。",
      },
    ],
    current_state_tables: [
      "runtime_setting_effective_values",
      "runtime_tool_invocations",
    ],
  };
}

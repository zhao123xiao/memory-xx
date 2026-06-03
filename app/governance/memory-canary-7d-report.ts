export interface MemoryCanary7dReportInput {
  readonly now?: string;
  readonly reports: readonly Record<string, unknown>[];
  readonly days?: number;
  readonly minRealFeedbackSamples?: number;
}

export interface SourceE2EStatus {
  readonly ok: boolean;
  readonly events: number;
  readonly last_event_at: string | null;
}

export interface MemoryCanary7dReport {
  readonly ok: boolean;
  readonly generated_at: string;
  readonly days: number;
  readonly days_observed: number;
  readonly candidate_only_exit_ready: boolean;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly streaks: {
    readonly runtime_ok_days: number;
    readonly pending_zero_days: number;
    readonly qdrant_zero_drift_days: number;
    readonly p1_pass_days: number;
    readonly production_guard_ok_days: number;
  };
  readonly metrics: {
    readonly total_real_policy_feedback: number;
    readonly min_real_feedback_samples: number;
    readonly default_leakage: number;
    readonly explicit_only_default_recall_leakage: number;
    readonly test_noise_default_recall_leakage: number;
    readonly unknown_sensitive_or_test_noise_auto_approve: number;
    readonly latest_candidate_current: number;
    readonly latest_qdrant_drift: number;
  };
  readonly conversation_source_e2e: Record<string, SourceE2EStatus>;
  readonly latest_report: Record<string, unknown> | null;
}

const REQUIRED_SOURCES = ["codex_session", "claude_code_session", "openclaw_session"] as const;

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function reportTime(report: Record<string, unknown>): number {
  const time = Date.parse(stringValue(report.generated_at) ?? "");
  return Number.isFinite(time) ? time : 0;
}

function currentState(report: Record<string, unknown>): Record<string, unknown> {
  return objectValue(report.current_state);
}

function policyReport(report: Record<string, unknown>): Record<string, unknown> {
  const snapshots = objectValue(report.snapshots);
  return objectValue(snapshots.policy_report);
}

function dailyPolicyFeedback(report: Record<string, unknown>): number {
  const policy = policyReport(report);
  const windows = objectValue(policy.windows);
  return numberValue(objectValue(windows.last_24h).total);
}

function leakageMetrics(report: Record<string, unknown>): Record<string, unknown> {
  const policy = policyReport(report);
  return {
    ...objectValue(policy.leakage_eval),
    ...objectValue(policy.recall_eval),
  };
}

function sourceSummary(report: Record<string, unknown>): Record<string, SourceE2EStatus> {
  const state = currentState(report);
  const conversationSources = objectValue(state.conversation_sources);
  const adapters = arrayValue(conversationSources.adapters).map(objectValue);
  const result: Record<string, SourceE2EStatus> = {};
  for (const adapter of adapters) {
    const name = stringValue(adapter.adapter) ?? "unknown";
    const events = numberValue(adapter.events);
    const previous = result[name];
    result[name] = {
      ok: events > 0 || previous?.ok === true,
      events: events + (previous?.events ?? 0),
      last_event_at: stringValue(adapter.last_event_at) ?? previous?.last_event_at ?? null,
    };
  }
  const monitorSources = objectValue(objectValue(state.conversation_monitor_report).sources);
  for (const [name, sourceValue] of Object.entries(monitorSources)) {
    const source = objectValue(sourceValue);
    const events = numberValue(source.user_events) + numberValue(source.assistant_events);
    const previous = result[name];
    result[name] = {
      ok: source.user_turn_e2e === true || previous?.ok === true,
      events: events + (previous?.events ?? 0),
      last_event_at: stringValue(source.last_event_at) ?? previous?.last_event_at ?? null,
    };
  }
  return result;
}

function countStable(sortedReports: readonly Record<string, unknown>[], predicate: (report: Record<string, unknown>) => boolean): number {
  return sortedReports.filter(predicate).length;
}

function withinWindow(reports: readonly Record<string, unknown>[], now: string, days: number): Record<string, unknown>[] {
  const nowMs = Date.parse(now);
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  return reports
    .filter((report) => {
      const time = reportTime(report);
      return time > 0 && time >= cutoff && time <= nowMs;
    })
    .sort((a, b) => reportTime(b) - reportTime(a));
}

export function buildMemoryCanary7dReport(input: MemoryCanary7dReportInput): MemoryCanary7dReport {
  const generatedAt = input.now ?? new Date().toISOString();
  const days = input.days ?? 7;
  const minRealFeedbackSamples = input.minRealFeedbackSamples ?? 20;
  const reports = withinWindow(input.reports, generatedAt, days);
  const latest = reports[0] ?? null;
  const latestState = latest ? currentState(latest) : {};
  const latestCandidateCurrent = numberValue(latestState.candidate_current);
  const latestQdrantDrift = numberValue(latestState.qdrant_drift);

  const streaks = {
    runtime_ok_days: countStable(reports, (report) => booleanValue(currentState(report).runtime_ok)),
    pending_zero_days: countStable(reports, (report) => numberValue(currentState(report).candidate_current) === 0),
    qdrant_zero_drift_days: countStable(reports, (report) => numberValue(currentState(report).qdrant_drift) === 0),
    p1_pass_days: countStable(reports, (report) => booleanValue(currentState(report).p1_ok_without_compare_warning)),
    production_guard_ok_days: countStable(reports, (report) => booleanValue(currentState(report).production_guard_ok)),
  };

  const sourceTotals: Record<string, SourceE2EStatus> = {};
  let totalRealPolicyFeedback = 0;
  let defaultLeakage = 0;
  let explicitOnlyDefaultRecallLeakage = 0;
  let testNoiseDefaultRecallLeakage = 0;
  let unknownSensitiveOrTestNoiseAutoApprove = 0;

  for (const report of reports) {
    totalRealPolicyFeedback += dailyPolicyFeedback(report);
    const leakage = leakageMetrics(report);
    defaultLeakage += numberValue(leakage.default_leakage);
    explicitOnlyDefaultRecallLeakage += numberValue(leakage.explicit_only_default_recall_leakage);
    testNoiseDefaultRecallLeakage += numberValue(leakage.test_noise_default_recall_leakage);
    unknownSensitiveOrTestNoiseAutoApprove += numberValue(leakage.unknown_sensitive_or_test_noise_auto_approve);
    const perReportSources = sourceSummary(report);
    for (const [name, source] of Object.entries(perReportSources)) {
      const previous = sourceTotals[name];
      sourceTotals[name] = {
        ok: source.ok || previous?.ok === true,
        events: source.events + (previous?.events ?? 0),
        last_event_at: source.last_event_at ?? previous?.last_event_at ?? null,
      };
    }
  }

  for (const source of REQUIRED_SOURCES) {
    sourceTotals[source] ??= { ok: false, events: 0, last_event_at: null };
  }

  const blockers: string[] = [];
  const warnings: string[] = [];
  if (reports.length < days) blockers.push(`insufficient_daily_reports:${reports.length}/${days}`);
  if (streaks.runtime_ok_days < days) blockers.push(`runtime_not_stable:${streaks.runtime_ok_days}/${days}`);
  if (latestCandidateCurrent !== 0) blockers.push(`pending_backlog_nonzero:${latestCandidateCurrent}`);
  if (latestQdrantDrift !== 0) blockers.push(`qdrant_drift_nonzero:${latestQdrantDrift}`);
  if (streaks.pending_zero_days < days) blockers.push(`pending_zero_not_stable:${streaks.pending_zero_days}/${days}`);
  if (streaks.qdrant_zero_drift_days < days) blockers.push(`qdrant_zero_drift_not_stable:${streaks.qdrant_zero_drift_days}/${days}`);
  if (streaks.p1_pass_days < days) blockers.push(`p1_gate_not_stable:${streaks.p1_pass_days}/${days}`);
  if (streaks.production_guard_ok_days < days) blockers.push(`production_guard_not_stable:${streaks.production_guard_ok_days}/${days}`);
  if (totalRealPolicyFeedback < minRealFeedbackSamples) blockers.push(`insufficient_real_feedback:${totalRealPolicyFeedback}/${minRealFeedbackSamples}`);
  const totalLeakage = defaultLeakage + explicitOnlyDefaultRecallLeakage + testNoiseDefaultRecallLeakage;
  if (totalLeakage !== 0) blockers.push(`default_recall_leakage_nonzero:${totalLeakage}`);
  if (unknownSensitiveOrTestNoiseAutoApprove !== 0) blockers.push(`unknown_sensitive_or_test_noise_auto_approve:${unknownSensitiveOrTestNoiseAutoApprove}`);
  for (const source of REQUIRED_SOURCES) {
    if (!sourceTotals[source]?.ok) blockers.push(`conversation_source_e2e_missing:${source}`);
  }
  if (latest && objectValue(currentState(latest).candidate_only).enabled !== true) {
    warnings.push("candidate_only_already_disabled");
  }

  const candidateOnlyExitReady = blockers.length === 0;
  return {
    ok: candidateOnlyExitReady,
    generated_at: generatedAt,
    days,
    days_observed: reports.length,
    candidate_only_exit_ready: candidateOnlyExitReady,
    blockers,
    warnings,
    streaks,
    metrics: {
      total_real_policy_feedback: totalRealPolicyFeedback,
      min_real_feedback_samples: minRealFeedbackSamples,
      default_leakage: defaultLeakage,
      explicit_only_default_recall_leakage: explicitOnlyDefaultRecallLeakage,
      test_noise_default_recall_leakage: testNoiseDefaultRecallLeakage,
      unknown_sensitive_or_test_noise_auto_approve: unknownSensitiveOrTestNoiseAutoApprove,
      latest_candidate_current: latestCandidateCurrent,
      latest_qdrant_drift: latestQdrantDrift,
    },
    conversation_source_e2e: sourceTotals,
    latest_report: latest,
  };
}

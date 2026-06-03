import type { ConversationSourceRuntimeStatus } from "./conversation-source-status";

export interface ConversationMonitorEventFact {
  readonly id?: string;
  readonly source?: string | null;
  readonly role?: string | null;
  readonly observed_at?: string | null;
  readonly processed_at?: string | null;
  readonly batch_id?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}

export interface ConversationMonitorBatchFact {
  readonly id?: string;
  readonly source?: string | null;
  readonly status?: string | null;
  readonly candidate_memory_ids?: readonly unknown[] | null;
  readonly no_op_reasons?: readonly unknown[] | null;
  readonly metadata?: Record<string, unknown> | null;
}

export interface ConversationMonitorMemoryRecordFact {
  readonly id?: string;
  readonly source?: string | null;
  readonly lifecycle_status?: string | null;
  readonly review_state?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}

export interface ConversationMonitorPolicyDecisionFact {
  readonly source_adapter?: string | null;
  readonly source?: string | null;
  readonly policy_action?: string | null;
}

export interface ConversationMonitorReportInput {
  readonly generatedAt?: string;
  readonly heartbeat: ConversationSourceRuntimeStatus | null;
  readonly facts: {
    readonly events: readonly ConversationMonitorEventFact[];
    readonly batches: readonly ConversationMonitorBatchFact[];
    readonly memoryRecords: readonly ConversationMonitorMemoryRecordFact[];
    readonly policyDecisions: readonly ConversationMonitorPolicyDecisionFact[];
  };
}

export interface ConversationMonitorSourceSummary {
  adapter: string;
  files_scanned: number;
  events_posted: number;
  user_events: number;
  assistant_events: number;
  processed_events: number;
  pending_events: number;
  flushed_sessions: number;
  assistant_only_batches: number;
  created_memory_count: number;
  candidate_count: number;
  approved_default_count: number;
  approved_explicit_only_count: number;
  quarantined_count: number;
  default_recallable_count: number;
  rejected_by_policy_count: number;
  policy_actions: Record<string, number>;
  last_seen: string | null;
  last_event_at: string | null;
  user_turn_e2e: boolean;
}

export interface ConversationMonitorReport {
  readonly ok: boolean;
  readonly status: "ok" | "degraded";
  readonly generated_at: string;
  readonly warnings: readonly string[];
  readonly heartbeat: ConversationSourceRuntimeStatus | null;
  readonly sources: Record<string, ConversationMonitorSourceSummary>;
}

const ADAPTERS = ["codex_session", "claude_code_session", "openclaw_session"] as const;

function metadata(value: { readonly metadata?: Record<string, unknown> | null }): Record<string, unknown> {
  return value.metadata && typeof value.metadata === "object" ? value.metadata : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function sourceToAdapter(source: string | null | undefined): string | null {
  if (!source) return null;
  if (source === "codex-session-tail") return "codex_session";
  if (source === "claude-code-session-tail") return "claude_code_session";
  if (source === "openclaw-session-tail") return "openclaw_session";
  return null;
}

function factAdapter(fact: { readonly source?: string | null; readonly metadata?: Record<string, unknown> | null }): string | null {
  return stringValue(metadata(fact).source_adapter) ?? sourceToAdapter(stringValue(fact.source));
}

function makeSummary(adapter: string): ConversationMonitorSourceSummary {
  return {
    adapter,
    files_scanned: 0,
    events_posted: 0,
    user_events: 0,
    assistant_events: 0,
    processed_events: 0,
    pending_events: 0,
    flushed_sessions: 0,
    assistant_only_batches: 0,
    created_memory_count: 0,
    candidate_count: 0,
    approved_default_count: 0,
    approved_explicit_only_count: 0,
    quarantined_count: 0,
    default_recallable_count: 0,
    rejected_by_policy_count: 0,
    policy_actions: {},
    last_seen: null,
    last_event_at: null,
    user_turn_e2e: false,
  };
}

function bump(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function updateLatest(current: string | null, incoming: string | null | undefined): string | null {
  if (!incoming) return current;
  if (!current) return incoming;
  return Date.parse(incoming) > Date.parse(current) ? incoming : current;
}

export function buildConversationMonitorReport(input: ConversationMonitorReportInput): ConversationMonitorReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const warnings: string[] = [];
  const sources: Record<string, ConversationMonitorSourceSummary> = {};
  for (const adapter of ADAPTERS) sources[adapter] = makeSummary(adapter);

  if (!input.heartbeat) {
    warnings.push("conversation_monitor_heartbeat_missing");
  } else {
    for (const adapter of input.heartbeat.adapters) {
      const name = adapter.adapter;
      sources[name] ??= makeSummary(name);
      sources[name] = {
        ...sources[name],
        files_scanned: adapter.files,
        events_posted: adapter.events,
        last_seen: adapter.last_seen,
        last_event_at: adapter.last_event_at,
      };
    }
  }

  for (const event of input.facts.events) {
    const adapter = factAdapter(event);
    if (!adapter) continue;
    sources[adapter] ??= makeSummary(adapter);
    const summary = sources[adapter];
    const role = stringValue(event.role);
    if (role === "user") summary.user_events += 1;
    if (role === "assistant") summary.assistant_events += 1;
    if (stringValue(event.processed_at)) summary.processed_events += 1;
    else summary.pending_events += 1;
    summary.last_event_at = updateLatest(summary.last_event_at, stringValue(event.observed_at));
  }

  for (const batch of input.facts.batches) {
    const adapter = factAdapter(batch);
    if (!adapter) continue;
    sources[adapter] ??= makeSummary(adapter);
    const summary = sources[adapter];
    if (stringValue(batch.status) === "completed") summary.flushed_sessions += 1;
    if (arrayValue(batch.no_op_reasons).includes("assistant_only_ignored")) summary.assistant_only_batches += 1;
  }

  for (const record of input.facts.memoryRecords) {
    const adapter = factAdapter(record);
    if (!adapter) continue;
    sources[adapter] ??= makeSummary(adapter);
    const summary = sources[adapter];
    summary.created_memory_count += 1;
    const lifecycleStatus = stringValue(record.lifecycle_status);
    const reviewState = stringValue(record.review_state);
    const recordMetadata = metadata(record);
    const policyAction = stringValue(recordMetadata.policy_action) ?? stringValue(recordMetadata.memory_policy && typeof recordMetadata.memory_policy === "object" && !Array.isArray(recordMetadata.memory_policy)
      ? (recordMetadata.memory_policy as Record<string, unknown>).policy_action
      : null);
    const recallPolicy = stringValue(recordMetadata.recall_policy) ?? stringValue(recordMetadata.memory_policy && typeof recordMetadata.memory_policy === "object" && !Array.isArray(recordMetadata.memory_policy)
      ? (recordMetadata.memory_policy as Record<string, unknown>).recall_policy
      : null);
    if (lifecycleStatus === "candidate" || reviewState === "pending" || policyAction === "create_candidate") summary.candidate_count += 1;
    if (policyAction === "quarantine_candidate") summary.quarantined_count += 1;
    // Rejections are counted from policy decisions below to avoid double-counting
    // the same rejected record and its decision row.
    if (lifecycleStatus === "approved" || reviewState === "silent_approved") {
      if (recallPolicy === "default" || !recallPolicy) {
        summary.approved_default_count += 1;
        summary.default_recallable_count += 1;
      } else if (recallPolicy === "explicit_only") {
        summary.approved_explicit_only_count += 1;
      }
    }
  }

  for (const decision of input.facts.policyDecisions) {
    const adapter = stringValue(decision.source_adapter) ?? sourceToAdapter(stringValue(decision.source));
    if (!adapter) continue;
    sources[adapter] ??= makeSummary(adapter);
    const action = stringValue(decision.policy_action) ?? "unknown";
    bump(sources[adapter].policy_actions, action);
    if (action === "reject_by_policy") sources[adapter].rejected_by_policy_count += 1;
  }

  for (const summary of Object.values(sources)) {
    summary.user_turn_e2e = summary.user_events > 0
      && summary.processed_events > 0
      && (summary.flushed_sessions > 0 || Object.keys(summary.policy_actions).length > 0 || summary.created_memory_count > 0);
  }

  const ok = input.heartbeat?.ok === true;
  return {
    ok,
    status: ok ? "ok" : "degraded",
    generated_at: generatedAt,
    warnings,
    heartbeat: input.heartbeat,
    sources,
  };
}

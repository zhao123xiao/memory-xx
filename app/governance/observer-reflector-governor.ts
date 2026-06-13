import type { CognitiveType } from "../shared/cognitive-type";
import type {
  MemoryRecallPolicy,
  MemoryStorageTarget,
} from "./memory-policy-engine";
import { evaluateMemoryPolicy, type MemoryPolicyResult } from "./memory-policy-engine";
import type { ExtractedMemoryClass } from "../intelligence/types";

export type ConversationMemoryRouteStage =
  | "observer"
  | "reflector_candidate"
  | "governor_candidate";

export interface ConversationMemoryRouteMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
}

export interface PlanConversationMemoryRouteInput {
  readonly source: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly messages: readonly ConversationMemoryRouteMessage[];
}

export interface ConversationMemoryRoutePlan {
  readonly stage: ConversationMemoryRouteStage;
  readonly storage_target: MemoryStorageTarget;
  readonly recall_policy: MemoryRecallPolicy;
  readonly default_recall_allowed: boolean;
  readonly reflector_required: boolean;
  readonly governor_required: boolean;
  readonly suggested_memory_class: ExtractedMemoryClass;
  readonly suggested_cognitive_type: CognitiveType;
  readonly reasons: readonly string[];
  readonly audit: {
    readonly source: string;
    readonly scope: string;
    readonly message_count: number;
    readonly roles: readonly string[];
    readonly observer_first: true;
  };
}

export interface ObserverFirstExtractionGateInput {
  readonly observerFirstEnabled: boolean;
}

export type ObservationReflectionCandidateType =
  | "semantic_reflection_candidate"
  | "procedural_reflection_candidate";

export interface ObservationForReflection {
  readonly id: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly observedAt: string;
  readonly route: ConversationMemoryRoutePlan;
  readonly messages: readonly ConversationMemoryRouteMessage[];
}

export interface ObservationReflectionCandidate {
  readonly candidate_type: ObservationReflectionCandidateType;
  readonly candidate_id: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly observation_ids: readonly string[];
  readonly suggested_memory_class: ExtractedMemoryClass;
  readonly suggested_cognitive_type: CognitiveType;
  readonly recall_policy: MemoryRecallPolicy;
  readonly governor_required: true;
  readonly governor_preview: Pick<MemoryPolicyResult, "memory_class" | "storage_target" | "recall_policy" | "lifecycle_intent" | "policy_action" | "reasons">;
  readonly suggested_action: "review_reflection_candidate";
  readonly evidence: {
    readonly sample_count: number;
    readonly first_observed_at: string;
    readonly last_observed_at: string;
    readonly reasons: readonly string[];
    readonly report_only: true;
  };
}

export interface ObservationReflectionReport {
  readonly ok: true;
  readonly generated_at: string;
  readonly summary: {
    readonly total_observations: number;
    readonly total_candidates: number;
    readonly by_type: Record<ObservationReflectionCandidateType, number>;
    readonly report_only: true;
  };
  readonly candidates: readonly ObservationReflectionCandidate[];
}

export interface BuildObservationReflectionReportInput {
  readonly observations: readonly ObservationForReflection[];
  readonly generatedAt?: string;
  readonly minSemanticObservations?: number;
}

export interface ConversationBatchReflectionRow {
  readonly id: string;
  readonly scope_context: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly created_at: string;
}

export interface ConversationEventReflectionRow {
  readonly id: string;
  readonly batch_id: string | null;
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly observed_at: string;
}

export interface BuildObservationReflectionReportFromRowsInput {
  readonly batches: readonly ConversationBatchReflectionRow[];
  readonly events: readonly ConversationEventReflectionRow[];
  readonly generatedAt?: string;
  readonly minSemanticObservations?: number;
}

export type ObservationReviewQueueName =
  | "event_log_observation"
  | "reflector_candidate"
  | "governor_review_candidate";

export interface ObservationReviewQueueItem {
  readonly queue: ObservationReviewQueueName;
  readonly observation_id: string;
  readonly scope: string;
  readonly observed_at: string;
  readonly route_stage: ConversationMemoryRouteStage;
  readonly suggested_memory_class: ExtractedMemoryClass;
  readonly suggested_cognitive_type: CognitiveType;
  readonly storage_target: MemoryStorageTarget;
  readonly recall_policy: MemoryRecallPolicy;
  readonly default_recall_allowed: boolean;
  readonly reflection_candidate_ids: readonly string[];
  readonly required_before_apply: readonly string[];
  readonly apply_allowed: false;
  readonly reasons: readonly string[];
}

export interface ObservationReviewQueueReport {
  readonly ok: true;
  readonly generated_at: string;
  readonly report_only: true;
  readonly apply_allowed: false;
  readonly summary: {
    readonly total_observations: number;
    readonly total_review_items: number;
    readonly retention_only_items: number;
    readonly actionable_review_items: number;
    readonly by_queue: Record<ObservationReviewQueueName, number>;
    readonly report_only: true;
  };
  readonly items: readonly ObservationReviewQueueItem[];
}

export interface BuildObservationReviewQueueInput {
  readonly observations: readonly ObservationForReflection[];
  readonly reflectionReport: ObservationReflectionReport;
  readonly generatedAt?: string;
}

export interface BuildObservationReviewQueueFromRowsInput extends BuildObservationReflectionReportFromRowsInput {
  readonly reflectionReport: ObservationReflectionReport;
}

function textOf(messages: readonly ConversationMemoryRouteMessage[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join("\n");
}

function rolesOf(messages: readonly ConversationMemoryRouteMessage[]): readonly string[] {
  return [...new Set(messages.map((message) => message.role))];
}

function isAssistantOnly(messages: readonly ConversationMemoryRouteMessage[]): boolean {
  return messages.length > 0 && messages.every((message) => message.role === "assistant" || message.role === "tool");
}

function hasExplicitMemoryIntent(text: string): boolean {
  return /请记住|帮我记住|记住|记一下|记下来|remember this|please remember|我的偏好|以后|后续|必须|不能|prefer|preference/iu.test(text);
}

function isPreference(text: string): boolean {
  return /偏好|喜欢|习惯|prefer|preference|usually|always/iu.test(text);
}

function isProcessSnapshot(text: string): boolean {
  return /(release|CI|build-and-test|Docker Build|in progress|继续等待|进度|已通过|网页确认|gate|status|handoff|当前进度)/iu.test(text);
}

function isTroubleshootingEvidenceChain(text: string): boolean {
  const hasIssue = /(失败|报错|故障|问题|断裂|不支持|error|failed|failure|bug|regression)/iu.test(text);
  const hasFix = /(修复|解决|设置|命令|复跑|验证通过|exit 0|fix|workaround|rerun|typecheck|TMPDIR=\/tmp)/iu.test(text);
  return hasIssue && hasFix;
}

function baseAudit(input: PlanConversationMemoryRouteInput): ConversationMemoryRoutePlan["audit"] {
  return {
    source: input.source,
    scope: `${input.scopeType}:${input.scopeId}`,
    message_count: input.messages.length,
    roles: rolesOf(input.messages),
    observer_first: true,
  };
}

function stableId(parts: readonly string[]): string {
  return parts
    .map((part) => part.replace(/[^a-z0-9_-]+/giu, "-").replace(/^-+|-+$/gu, "").toLowerCase())
    .filter(Boolean)
    .join(":");
}

function observationText(observation: ObservationForReflection): string {
  return textOf(observation.messages);
}

function semanticReflectionKey(observation: ObservationForReflection): string {
  const text = observationText(observation).toLowerCase();
  const topic = /tmpdir=\/tmp|tsx|wsl/u.test(text)
    ? "tsx-wsl-tmpdir"
    : observation.route.suggested_memory_class;
  return [observation.scopeType, observation.scopeId, observation.route.suggested_memory_class, topic].join(" ");
}

function dateRange(observations: readonly ObservationForReflection[]): { first: string; last: string } {
  const sorted = [...observations].sort((left, right) => left.observedAt.localeCompare(right.observedAt));
  return {
    first: sorted[0]?.observedAt ?? "",
    last: sorted[sorted.length - 1]?.observedAt ?? "",
  };
}

function candidateContent(observations: readonly ObservationForReflection[]): string {
  return observations
    .flatMap((observation) => observation.messages.map((message) => message.content))
    .join("\n\n");
}

function governorPreview(input: {
  readonly scopeType: string;
  readonly scopeId: string;
  readonly memoryClass: ExtractedMemoryClass;
  readonly memoryType: string;
  readonly content: string;
}): ObservationReflectionCandidate["governor_preview"] {
  const result = evaluateMemoryPolicy({
    source: "conversation_ingest",
    sourceText: input.content,
    baseDecision: "pending",
    blockedReasons: ["reflector_report_only"],
    candidate: {
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      memoryType: input.memoryType,
      operation: "add",
      confidence: 0.9,
      qualityScore: 0.9,
      content: input.content,
      metadata: {
        source: "conversation_ingest",
        memory_class: input.memoryClass,
        reflection_candidate: true,
      },
      memoryClass: input.memoryClass,
    },
  });
  return {
    memory_class: result.memory_class,
    storage_target: result.storage_target,
    recall_policy: result.recall_policy,
    lifecycle_intent: result.lifecycle_intent,
    policy_action: result.policy_action,
    reasons: result.reasons,
  };
}

function addCandidateCount(
  counts: Record<ObservationReflectionCandidateType, number>,
  type: ObservationReflectionCandidateType,
): void {
  counts[type] = (counts[type] ?? 0) + 1;
}

function addQueueCount(
  counts: Record<ObservationReviewQueueName, number>,
  queue: ObservationReviewQueueName,
): void {
  counts[queue] = (counts[queue] ?? 0) + 1;
}

function queueForObservation(observation: ObservationForReflection): ObservationReviewQueueName {
  if (observation.route.stage === "reflector_candidate") return "reflector_candidate";
  if (observation.route.stage === "governor_candidate") return "governor_review_candidate";
  return "event_log_observation";
}

function requiredBeforeApplyForQueue(queue: ObservationReviewQueueName): readonly string[] {
  if (queue === "event_log_observation") return ["retention_policy"];
  if (queue === "reflector_candidate") return ["reflector_review", "governor_review", "operator_approval"];
  return ["governor_review", "operator_approval"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function routeFromMetadata(metadata: Record<string, unknown>): ConversationMemoryRoutePlan | null {
  const value = metadata.conversation_memory_route;
  if (!isRecord(value)) return null;
  const stage = readString(value.stage);
  if (stage !== "observer" && stage !== "reflector_candidate" && stage !== "governor_candidate") return null;
  return value as unknown as ConversationMemoryRoutePlan;
}

function scopeFromRow(row: ConversationBatchReflectionRow): { scopeType: string; scopeId: string } {
  const projectId = readStringArray(row.scope_context.project_ids ?? row.scope_context.projectIds)[0];
  if (projectId) return { scopeType: "project", scopeId: projectId };
  const workspaceId = readString(row.scope_context.workspace_id ?? row.scope_context.workspaceId);
  if (workspaceId) return { scopeType: "workspace", scopeId: workspaceId };
  const userId = readString(row.scope_context.user_id ?? row.scope_context.userId);
  if (userId) return { scopeType: "user", scopeId: userId };
  return { scopeType: "scope", scopeId: "unknown" };
}

export function planConversationMemoryRoute(input: PlanConversationMemoryRouteInput): ConversationMemoryRoutePlan {
  const text = textOf(input.messages);
  const reasons: string[] = ["observer_first"];

  if (isAssistantOnly(input.messages)) reasons.push("assistant_only_observation");
  if (isProcessSnapshot(text)) reasons.push("process_snapshot_observation");

  if (isAssistantOnly(input.messages) || isProcessSnapshot(text)) {
    return {
      stage: "observer",
      storage_target: "event_log_only",
      recall_policy: "never",
      default_recall_allowed: false,
      reflector_required: false,
      governor_required: false,
      suggested_memory_class: "runtime_noise",
      suggested_cognitive_type: "audit",
      reasons,
      audit: baseAudit(input),
    };
  }

  if (isTroubleshootingEvidenceChain(text)) {
    return {
      stage: "reflector_candidate",
      storage_target: "event_log_only",
      recall_policy: "audit_only",
      default_recall_allowed: false,
      reflector_required: true,
      governor_required: true,
      suggested_memory_class: "procedure",
      suggested_cognitive_type: "procedural",
      reasons: [...reasons, "troubleshooting_evidence_chain"],
      audit: baseAudit(input),
    };
  }

  if (hasExplicitMemoryIntent(text)) {
    const memoryClass: ExtractedMemoryClass = isPreference(text) ? "preference" : "constraint";
    return {
      stage: "governor_candidate",
      storage_target: "postgres_memory",
      recall_policy: "default",
      default_recall_allowed: false,
      reflector_required: false,
      governor_required: true,
      suggested_memory_class: memoryClass,
      suggested_cognitive_type: "semantic",
      reasons: [...reasons, "explicit_memory_intent"],
      audit: baseAudit(input),
    };
  }

  return {
    stage: "observer",
    storage_target: "event_log_only",
    recall_policy: "never",
    default_recall_allowed: false,
    reflector_required: true,
    governor_required: false,
    suggested_memory_class: "audit_evidence",
    suggested_cognitive_type: "audit",
    reasons: [...reasons, "no_explicit_memory_intent"],
    audit: baseAudit(input),
  };
}

export function shouldSkipLongTermExtractionForObservation(
  route: ConversationMemoryRoutePlan,
  input: ObserverFirstExtractionGateInput,
): boolean {
  return input.observerFirstEnabled && route.stage === "observer";
}

export function buildObservationReflectionReport(
  input: BuildObservationReflectionReportInput,
): ObservationReflectionReport {
  const minSemanticObservations = input.minSemanticObservations ?? 2;
  const candidates: ObservationReflectionCandidate[] = [];
  const counts: Record<ObservationReflectionCandidateType, number> = {
    semantic_reflection_candidate: 0,
    procedural_reflection_candidate: 0,
  };

  for (const observation of input.observations) {
    if (observation.route.stage !== "reflector_candidate") continue;
    const type = "procedural_reflection_candidate";
    const range = dateRange([observation]);
    addCandidateCount(counts, type);
    candidates.push({
      candidate_type: type,
      candidate_id: stableId([type, observation.scopeType, observation.scopeId, observation.id]),
      scope_type: observation.scopeType,
      scope_id: observation.scopeId,
      observation_ids: [observation.id],
      suggested_memory_class: "procedure",
      suggested_cognitive_type: "procedural",
      recall_policy: "explicit_only",
      governor_required: true,
      governor_preview: governorPreview({
        scopeType: observation.scopeType,
        scopeId: observation.scopeId,
        memoryClass: "procedure",
        memoryType: "procedure",
        content: candidateContent([observation]),
      }),
      suggested_action: "review_reflection_candidate",
      evidence: {
        sample_count: 1,
        first_observed_at: range.first,
        last_observed_at: range.last,
        reasons: observation.route.reasons,
        report_only: true,
      },
    });
  }

  const semanticGroups = new Map<string, ObservationForReflection[]>();
  for (const observation of input.observations) {
    if (observation.route.stage !== "governor_candidate") continue;
    if (observation.route.suggested_cognitive_type !== "semantic") continue;
    const key = semanticReflectionKey(observation);
    semanticGroups.set(key, [...(semanticGroups.get(key) ?? []), observation]);
  }

  for (const observations of semanticGroups.values()) {
    if (observations.length < minSemanticObservations) continue;
    const sorted = [...observations].sort((left, right) => left.id.localeCompare(right.id));
    const first = sorted[0]!;
    const range = dateRange(sorted);
    const type = "semantic_reflection_candidate";
    addCandidateCount(counts, type);
    candidates.push({
      candidate_type: type,
      candidate_id: stableId([type, first.scopeType, first.scopeId, first.route.suggested_memory_class, sorted.map((item) => item.id).join("-")]),
      scope_type: first.scopeType,
      scope_id: first.scopeId,
      observation_ids: sorted.map((item) => item.id),
      suggested_memory_class: first.route.suggested_memory_class,
      suggested_cognitive_type: "semantic",
      recall_policy: "default",
      governor_required: true,
      governor_preview: governorPreview({
        scopeType: first.scopeType,
        scopeId: first.scopeId,
        memoryClass: first.route.suggested_memory_class,
        memoryType: first.route.suggested_memory_class === "preference" ? "preference" : "constraint",
        content: candidateContent(sorted),
      }),
      suggested_action: "review_reflection_candidate",
      evidence: {
        sample_count: sorted.length,
        first_observed_at: range.first,
        last_observed_at: range.last,
        reasons: [...new Set(sorted.flatMap((item) => item.route.reasons))],
        report_only: true,
      },
    });
  }

  const sortedCandidates = candidates.sort((left, right) =>
    left.candidate_type.localeCompare(right.candidate_type) ||
    left.scope_type.localeCompare(right.scope_type) ||
    left.scope_id.localeCompare(right.scope_id) ||
    left.candidate_id.localeCompare(right.candidate_id)
  );

  return {
    ok: true,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    summary: {
      total_observations: input.observations.length,
      total_candidates: sortedCandidates.length,
      by_type: counts,
      report_only: true,
    },
    candidates: sortedCandidates,
  };
}

export function buildObservationReviewQueue(input: BuildObservationReviewQueueInput): ObservationReviewQueueReport {
  const counts: Record<ObservationReviewQueueName, number> = {
    event_log_observation: 0,
    reflector_candidate: 0,
    governor_review_candidate: 0,
  };
  const candidateIdsByObservation = new Map<string, string[]>();
  for (const candidate of input.reflectionReport.candidates) {
    for (const observationId of candidate.observation_ids) {
      candidateIdsByObservation.set(observationId, [
        ...(candidateIdsByObservation.get(observationId) ?? []),
        candidate.candidate_id,
      ]);
    }
  }

  const items = input.observations
    .map((observation): ObservationReviewQueueItem => {
      const queue = queueForObservation(observation);
      addQueueCount(counts, queue);
      return {
        queue,
        observation_id: observation.id,
        scope: `${observation.scopeType}:${observation.scopeId}`,
        observed_at: observation.observedAt,
        route_stage: observation.route.stage,
        suggested_memory_class: observation.route.suggested_memory_class,
        suggested_cognitive_type: observation.route.suggested_cognitive_type,
        storage_target: observation.route.storage_target,
        recall_policy: observation.route.recall_policy,
        default_recall_allowed: observation.route.default_recall_allowed,
        reflection_candidate_ids: [...(candidateIdsByObservation.get(observation.id) ?? [])].sort(),
        required_before_apply: requiredBeforeApplyForQueue(queue),
        apply_allowed: false,
        reasons: observation.route.reasons,
      };
    })
    .sort((left, right) =>
      left.observed_at.localeCompare(right.observed_at) ||
      left.observation_id.localeCompare(right.observation_id)
    );

  return {
    ok: true,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    report_only: true,
    apply_allowed: false,
    summary: {
      total_observations: input.observations.length,
      total_review_items: items.length,
      retention_only_items: counts.event_log_observation,
      actionable_review_items: counts.reflector_candidate + counts.governor_review_candidate,
      by_queue: counts,
      report_only: true,
    },
    items,
  };
}

function observationsFromRows(input: Pick<BuildObservationReflectionReportFromRowsInput, "batches" | "events">): ObservationForReflection[] {
  const eventsByBatch = new Map<string, ConversationEventReflectionRow[]>();
  for (const event of input.events) {
    if (!event.batch_id) continue;
    eventsByBatch.set(event.batch_id, [...(eventsByBatch.get(event.batch_id) ?? []), event]);
  }
  return input.batches.flatMap((batch): ObservationForReflection[] => {
    const route = routeFromMetadata(batch.metadata);
    if (!route) return [];
    const events = [...(eventsByBatch.get(batch.id) ?? [])].sort((left, right) => left.observed_at.localeCompare(right.observed_at));
    if (events.length === 0) return [];
    const scope = scopeFromRow(batch);
    return [{
      id: batch.id,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      observedAt: events[0]?.observed_at ?? batch.created_at,
      route,
      messages: events.map((event) => ({
        role: event.role,
        content: event.content,
      })),
    }];
  });
}

export function buildObservationReviewQueueFromRows(
  input: BuildObservationReviewQueueFromRowsInput,
): ObservationReviewQueueReport {
  return buildObservationReviewQueue({
    observations: observationsFromRows(input),
    reflectionReport: input.reflectionReport,
    generatedAt: input.generatedAt,
  });
}

export function buildObservationReflectionReportFromRows(
  input: BuildObservationReflectionReportFromRowsInput,
): ObservationReflectionReport {
  return buildObservationReflectionReport({
    observations: observationsFromRows(input),
    generatedAt: input.generatedAt,
    minSemanticObservations: input.minSemanticObservations,
  });
}

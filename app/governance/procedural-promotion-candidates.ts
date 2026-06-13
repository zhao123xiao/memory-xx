import type {
  RecallFeedbackEventRow,
  RecallTraceRow,
} from "../db/schema/tables";
import type { JsonObject } from "../shared";
import { scanMemoryPrivacy } from "./privacy-scan";

export interface ProceduralPromotionMemoryRow {
  readonly id: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly title: string | null;
  readonly content: string;
  readonly memory_type: string | null;
  readonly memory_class: string | null;
  readonly cognitive_type: string | null;
  readonly recall_policy: string | null;
  readonly metadata: JsonObject;
}

export interface ProceduralPromotionCandidate {
  readonly candidate_type: "cross_scope_procedural_promotion";
  readonly candidate_id: string;
  readonly memory_id: string;
  readonly source_scope: string;
  readonly positive_scope_keys: readonly string[];
  readonly positive_feedback_count: number;
  readonly suggested_target_scope: "global:procedural-candidates";
  readonly governor_required: true;
  readonly apply_allowed: false;
  readonly blockers: readonly string[];
  readonly privacy_scan: {
    readonly blocked: boolean;
    readonly reasons: readonly string[];
  };
  readonly evidence: {
    readonly query_types: readonly string[];
    readonly report_only: true;
  };
}

export interface ProceduralPromotionCandidateReport {
  readonly ok: true;
  readonly generated_at: string;
  readonly summary: {
    readonly total_candidates: number;
    readonly report_only: true;
  };
  readonly candidates: readonly ProceduralPromotionCandidate[];
}

export interface BuildProceduralPromotionCandidateReportInput {
  readonly memories: readonly ProceduralPromotionMemoryRow[];
  readonly traces: readonly RecallTraceRow[];
  readonly feedbackEvents: readonly RecallFeedbackEventRow[];
  readonly minPositiveScopes?: number;
  readonly generatedAt?: string;
}

const POSITIVE_FEEDBACK = new Set(["used_in_context", "adopted"]);

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function isProcedural(memory: ProceduralPromotionMemoryRow): boolean {
  return normalize(memory.cognitive_type) === "procedural" ||
    normalize(memory.memory_class) === "procedure" ||
    normalize(memory.memory_type) === "procedure" ||
    normalize(memory.memory_type) === "procedural" ||
    normalize(memory.memory_type) === "ops_learning";
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function firstString(value: unknown): string | null {
  return stringArray(value)[0] ?? null;
}

function traceScopeKey(trace: RecallTraceRow): string {
  const memoryId = firstString(trace.scopeContext.memory_ids);
  if (memoryId) return `memory:${memoryId}`;
  const projectId = firstString(trace.scopeContext.project_ids);
  if (projectId) return `project:${projectId}`;
  const userId = typeof trace.scopeContext.user_id === "string" && trace.scopeContext.user_id.trim() ? trace.scopeContext.user_id.trim() : "";
  if (userId) return `user:${userId}`;
  const workspaceId = typeof trace.scopeContext.workspace_id === "string" && trace.scopeContext.workspace_id.trim() ? trace.scopeContext.workspace_id.trim() : "";
  if (workspaceId) return `workspace:${workspaceId}`;
  return "scope:unknown";
}

function stableId(parts: readonly string[]): string {
  return parts
    .map((part) => part.replace(/[^a-z0-9_-]+/giu, "-").replace(/^-+|-+$/gu, "").toLowerCase())
    .filter(Boolean)
    .join(":");
}

export function buildProceduralPromotionCandidateReport(
  input: BuildProceduralPromotionCandidateReportInput,
): ProceduralPromotionCandidateReport {
  const minPositiveScopes = input.minPositiveScopes ?? 2;
  const traceById = new Map(input.traces.map((trace) => [trace.id, trace]));
  const proceduralMemories = new Map(input.memories.filter(isProcedural).map((memory) => [memory.id, memory]));
  const scopeHits = new Map<string, Set<string>>();
  const feedbackCounts = new Map<string, number>();
  const queryTypes = new Map<string, Set<string>>();

  for (const event of input.feedbackEvents) {
    if (event.suspicious || !POSITIVE_FEEDBACK.has(event.feedbackType) || !event.memoryId) continue;
    const memory = proceduralMemories.get(event.memoryId);
    if (!memory) continue;
    const trace = traceById.get(event.recallTraceId);
    if (!trace) continue;
    const scopes = scopeHits.get(memory.id) ?? new Set<string>();
    scopes.add(traceScopeKey(trace));
    scopeHits.set(memory.id, scopes);
    feedbackCounts.set(memory.id, (feedbackCounts.get(memory.id) ?? 0) + 1);
    const queries = queryTypes.get(memory.id) ?? new Set<string>();
    queries.add(trace.queryType);
    queryTypes.set(memory.id, queries);
  }

  const candidates: ProceduralPromotionCandidate[] = [];
  for (const [memoryId, scopes] of scopeHits.entries()) {
    if (scopes.size < minPositiveScopes) continue;
    const memory = proceduralMemories.get(memoryId);
    if (!memory) continue;
    const privacy = scanMemoryPrivacy(`${memory.title ?? ""}\n${memory.content}`);
    const blockers = ["report_only", "requires_human_review"];
    if (privacy.blocked || privacy.findings.some((finding) => finding.kind === "internal_path")) {
      blockers.push("privacy_or_scope_leakage");
    }
    candidates.push({
      candidate_type: "cross_scope_procedural_promotion",
      candidate_id: stableId(["cross-scope-procedural-promotion", memoryId]),
      memory_id: memoryId,
      source_scope: `${memory.scope_type}:${memory.scope_id}`,
      positive_scope_keys: [...scopes],
      positive_feedback_count: feedbackCounts.get(memoryId) ?? 0,
      suggested_target_scope: "global:procedural-candidates",
      governor_required: true,
      apply_allowed: false,
      blockers,
      privacy_scan: {
        blocked: privacy.blocked || blockers.includes("privacy_or_scope_leakage"),
        reasons: [...new Set([...privacy.reasons, ...(blockers.includes("privacy_or_scope_leakage") ? ["privacy_or_scope_leakage"] : [])])],
      },
      evidence: {
        query_types: [...(queryTypes.get(memoryId) ?? new Set<string>())].sort(),
        report_only: true,
      },
    });
  }

  const sorted = candidates.sort((left, right) => left.memory_id.localeCompare(right.memory_id));
  return {
    ok: true,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    summary: {
      total_candidates: sorted.length,
      report_only: true,
    },
    candidates: sorted,
  };
}

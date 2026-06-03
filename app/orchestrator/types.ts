import type { WriteDatabaseState } from "../db/schema/tables";
import type { RecallRequest, RecallResponse, ResolvedScopeSet } from "../recall/types";
import type { JsonObject, ScopeType, Visibility } from "../shared";
import type { CreateMemoryCommand, StoredWriteResult } from "../shared/contracts/write";

export type MemoryScopeName = "execution" | "shared" | "personal" | "research" | "governance";

/**
 * Minimal route/runtime memory-scope snapshot shape mirrored from
 * `openclaw/src/agents/memory-scope.ts`.
 *
 * The orchestrator only needs the resolved recall-scope and route/runtime pieces
 * required for plan-level visibility allowance derivation, so we keep this
 * intentionally narrow and backwards-compatible.
 */
export interface ResolveScopePlanMemoryScopeSnapshot {
  readonly memoryScope: {
    readonly recallScopes: readonly MemoryScopeName[];
  };
  readonly recallScopeContext?: RecallRequest["scope_context"];
  readonly route?: {
    readonly workspaceId?: string;
    readonly userId?: string;
    readonly projectId?: string;
    readonly globalScopeId?: string;
    readonly runtimeRunId?: string;
    readonly runtimeTaskId?: string;
  };
}

export interface ResolveScopePlanRequest {
  readonly recall_request: RecallRequest;
  /**
   * Preferred source for allowedVisibilities derivation.
   * When present, this should be the already-resolved route/runtime memoryScope
   * snapshot from the caller, with RecallScopeContext retained only as fallback.
   */
  readonly memory_scope_snapshot?: ResolveScopePlanMemoryScopeSnapshot;
  readonly write_scope_hint?: {
    readonly scope_type?: ScopeType;
    readonly scope_id?: string;
  };
}

export interface ResolveScopePlanResponse {
  readonly allowed_scope_set: ResolvedScopeSet["allowed_scope_set"];
  readonly long_term_scopes: ResolvedScopeSet["long_term_scopes"];
  readonly runtime_scopes: ResolvedScopeSet["runtime_scopes"];
  /**
   * Visibility allowance for the current resolved route/runtime context.
   *
   * This is a plan-level summary of which canonical visibility categories the
   * current context is allowed to touch. It is NOT a memory-record attribute,
   * and it is NOT an externally supplied recall-request filter parameter.
   */
  readonly allowedVisibilities?: readonly Visibility[];
  readonly degraded: boolean;
  readonly degrade_reasons: readonly string[];
  readonly suggested_write_scope: {
    readonly scopeType: ScopeType;
    readonly scopeId: string;
    readonly source: "hint" | "derived";
  } | null;
}

export interface WriteMemoryRequest {
  readonly command: CreateMemoryCommand;
}

export interface WriteMemoryResponse {
  readonly write: StoredWriteResult & { readonly replayed?: boolean };
}

export interface RecallMemoryRequest {
  readonly request: RecallRequest;
}

export interface RecallMemoryResponse {
  readonly recall: RecallResponse;
}

export interface SummarizeMemoryRequest {
  readonly request: RecallRequest;
  readonly max_items?: number;
}

export interface SummarizeMemoryResponse {
  readonly summary: {
    readonly text: string;
    readonly total_results: number;
    readonly used_results: number;
    readonly memory_ids: readonly string[];
    readonly audit_ref: string;
    readonly degraded: boolean;
  };
  readonly recall: RecallResponse;
}

export interface MemoryCountsRequest {
  readonly scopeType?: ScopeType;
  readonly scopeId?: string;
  readonly includeByScope?: boolean;
}

export interface MemoryCountsResponse {
  readonly ok: boolean;
  readonly checked_at: string;
  readonly scope: {
    readonly scopeType: ScopeType;
    readonly scopeId: string;
  };
  readonly counts: {
    readonly total: number;
    readonly current: number;
    readonly candidate_pending_current: number;
    readonly candidate_pending: number;
    readonly approved_current: number;
    readonly pending_review: number;
    readonly archived: number;
    readonly rejected: number;
    readonly tombstone: number;
  };
  readonly by_scope?: readonly {
    readonly scopeType: ScopeType;
    readonly scopeId: string;
    readonly total: number;
    readonly candidate_pending_current: number;
    readonly pending_review: number;
  }[];
}

export interface ForgetMemoryRequest {
  readonly requestId: string;
  readonly actorId: string;
  readonly memoryId: string;
  readonly mode?: "tombstone" | "archive";
}

export interface ForgetMemoryResponse {
  readonly write: StoredWriteResult & { readonly replayed?: boolean };
  readonly mode: "tombstone" | "archive";
}

export interface RepairMemoryConsistencyRequest {
  readonly dry_run?: boolean;
}

export interface RepairMemoryConsistencyResponse {
  readonly repaired_at: string;
  readonly dry_run: boolean;
  readonly repairs: readonly {
    readonly code: string;
    readonly memoryId?: string;
    readonly requestId?: string;
    readonly action: string;
    readonly details: string;
  }[];
  readonly counts: {
    readonly memory_records: number;
    readonly memory_events: number;
    readonly outbox_events: number;
    readonly ingest_requests: number;
  };
}

export interface AuditMemoryConsistencyRequest {
  readonly include_records?: boolean;
}

export interface AuditMemoryConsistencyResponse {
  readonly ok: boolean;
  readonly checked_at: string;
  readonly counts: {
    readonly memory_records: number;
    readonly memory_events: number;
    readonly outbox_events: number;
    readonly ingest_requests: number;
  };
  readonly findings: readonly {
    readonly code:
      | "non_current_approved_record"
      | "multiple_current_records_per_scope"
      | "missing_event_for_memory"
      | "missing_outbox_for_request";
    readonly severity: "info" | "warn";
    readonly memoryId?: string;
    readonly requestId?: string;
    readonly scopeKey?: string;
    readonly details: string;
  }[];
  readonly snapshot?: WriteDatabaseState;
}


export interface ListPendingMemoriesRequest {
  readonly scope_type?: string;
  readonly scope_id?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly agent_id?: string;
  readonly memory_class?: string;
  readonly recall_policy?: string;
  readonly policy_action?: string;
  readonly source?: string;
}

export interface PendingMemoryItem {
  readonly id: string;
  readonly content: string;
  readonly title: string | null;
  readonly memory_type: string | null;
  readonly created_at: string;
  readonly actor_id: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly memory_class?: string | null;
  readonly recall_policy?: string | null;
  readonly policy_action?: string | null;
  readonly suggested_action?: string;
  readonly metadata?: JsonObject;
  readonly conversation_context?: JsonObject;
}

export interface ListPendingMemoriesResponse {
  readonly ok: boolean;
  readonly memories: readonly PendingMemoryItem[];
  readonly total: number;
  readonly cooldown?: boolean;
}

export interface McpApproveMemoryRequest {
  readonly memory_id: string;
  readonly reviewer_id: string;
  readonly reason?: string;
}

export interface McpRejectMemoryRequest {
  readonly memory_id: string;
  readonly reviewer_id: string;
  readonly reason: string;
}

export interface McpReviewMemoryResponse {
  readonly ok: boolean;
  readonly memory_id: string;
  readonly lifecycle_status: string;
  readonly review_state: string;
}

export interface ReadMemoryRequest {
  readonly memoryId?: string;
  readonly path?: string;
}

export interface ReadMemoryResponse {
  readonly memory: {
    readonly id: string;
    readonly content: string;
    readonly title: string | null;
    readonly summary: string | null;
    readonly scope_type: string;
    readonly scope_id: string;
    readonly lifecycle_status: string;
    readonly review_state: string;
    readonly is_current: boolean;
    readonly metadata: import("../shared").JsonObject;
    readonly created_at: string;
    readonly updated_at: string;
  } | null;
  readonly error?: string;
  readonly error_code?: "invalid_input" | "record_not_found";
  readonly status?: 400 | 404;
}

export interface SmartWriteMemoryRequest {
  readonly text: string;
  readonly agent_id: string;
  readonly user_id?: string;
  readonly workspace_id?: string;
  readonly scope_hint?: {
    readonly scope_type: string;
    readonly scope_id: string;
  };
}

export interface MemoryOrchestratorHandlers {
  resolve_scope_plan(input: ResolveScopePlanRequest): Promise<ResolveScopePlanResponse>;
  write_memory(input: WriteMemoryRequest): Promise<WriteMemoryResponse>;
  recall_memory(input: RecallMemoryRequest): Promise<RecallMemoryResponse>;
  summarize_memory(input: SummarizeMemoryRequest): Promise<SummarizeMemoryResponse>;
  memory_counts(input: MemoryCountsRequest): Promise<MemoryCountsResponse>;
  forget_memory(input: ForgetMemoryRequest): Promise<ForgetMemoryResponse>;
  audit_memory_consistency(
    input: AuditMemoryConsistencyRequest,
  ): Promise<AuditMemoryConsistencyResponse>;
  repair_memory_consistency(
    input: RepairMemoryConsistencyRequest,
  ): Promise<RepairMemoryConsistencyResponse>;
  list_pending_memories(input: ListPendingMemoriesRequest): Promise<ListPendingMemoriesResponse>;
  mcp_approve_memory(input: McpApproveMemoryRequest): Promise<McpReviewMemoryResponse>;
  mcp_reject_memory(input: McpRejectMemoryRequest): Promise<McpReviewMemoryResponse>;
  read_memory(input: ReadMemoryRequest): Promise<ReadMemoryResponse>;
}

export type MemoryOrchestratorAction = keyof MemoryOrchestratorHandlers;

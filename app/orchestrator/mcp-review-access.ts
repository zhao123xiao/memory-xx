import { randomUUID } from "node:crypto";

import type { WriteTransactionRunner } from "../db/tx/write-transaction";
import { isPostgresTransactionContext, withWriteTransaction } from "../db/tx/write-transaction";
import { ReviewDecisionService } from "../review/services/review-decision-service";
import { LifecycleStatus, ReviewState, type JsonObject } from "../shared";
import { mapMemoryRecordRow } from "../db/adapters/postgres-row-mappers";
import type { MemoryRecordRow } from "../db/schema/tables";
import type {
  ListPendingMemoriesRequest,
  ListPendingMemoriesResponse,
  McpApproveMemoryRequest,
  McpRejectMemoryRequest,
  McpReviewMemoryResponse,
  ReadMemoryRequest,
  ReadMemoryResponse
} from "./types";

function memoryPolicyField(metadata: Record<string, unknown> | undefined, key: string): string | null {
  if (!metadata) return null;
  const direct = metadata[key];
  if (typeof direct === "string") return direct;
  const autoApproval = metadata.auto_approval_policy;
  if (typeof autoApproval !== "object" || autoApproval === null || Array.isArray(autoApproval)) return null;
  const memoryPolicy = (autoApproval as Record<string, unknown>).memory_policy;
  if (typeof memoryPolicy !== "object" || memoryPolicy === null || Array.isArray(memoryPolicy)) return null;
  const value = (memoryPolicy as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function pendingPriority(metadata: Record<string, unknown> | undefined): number {
  const memoryClass = memoryPolicyField(metadata, "memory_class");
  if (memoryClass === "operational_issue") return 0;
  if (memoryClass === "unknown_source_quarantine") return 1;
  if (memoryClass === "test_evidence" || memoryClass === "audit_evidence") return 2;
  return 3;
}

function suggestedAction(metadata: Record<string, unknown> | undefined): string {
  const memoryClass = memoryPolicyField(metadata, "memory_class");
  const recallPolicy = memoryPolicyField(metadata, "recall_policy");
  const policyAction = memoryPolicyField(metadata, "policy_action");
  if (memoryClass === "operational_issue") return "review_operational_issue";
  if (memoryClass === "unknown_source_quarantine" || policyAction === "quarantine_candidate") return "confirm_or_reject_quarantine";
  if (memoryClass === "test_evidence" || recallPolicy === "test_only") return "review_test_only_scope";
  if (memoryClass === "audit_evidence" || recallPolicy === "audit_only") return "review_audit_only_scope";
  return "normal_review";
}

export async function listPendingMemories(
  database: WriteTransactionRunner,
  input: ListPendingMemoriesRequest
): Promise<ListPendingMemoriesResponse> {
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 50)));
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));

  const postgresResult = await listPendingMemoriesFromPostgres(database, input, limit, offset);
  if (postgresResult) return postgresResult;

  let candidates = (await database.snapshot()).memoryRecords.filter((r) =>
    r.lifecycleStatus === LifecycleStatus.Candidate && r.reviewState === ReviewState.Pending && r.isCurrent
  );
  if (input.scope_type) {
    candidates = candidates.filter((r) => r.scopeType === input.scope_type);
  }
  if (input.scope_id) {
    candidates = candidates.filter((r) => r.scopeId === input.scope_id);
  }
  if (input.agent_id) {
    const agentId = input.agent_id;
    candidates = candidates.filter((r) => memoryAgentMatches(r, agentId));
  }
  if (input.memory_class) {
    candidates = candidates.filter((r) => memoryPolicyField(r.metadata, "memory_class") === input.memory_class);
  }
  if (input.recall_policy) {
    candidates = candidates.filter((r) => memoryPolicyField(r.metadata, "recall_policy") === input.recall_policy);
  }
  if (input.policy_action) {
    candidates = candidates.filter((r) => memoryPolicyField(r.metadata, "policy_action") === input.policy_action);
  }
  if (input.source) {
    candidates = candidates.filter((r) => r.metadata?.source === input.source);
  }

  candidates.sort((a, b) => {
    const priority = pendingPriority(a.metadata) - pendingPriority(b.metadata);
    return priority !== 0 ? priority : a.createdAt.localeCompare(b.createdAt);
  });
  const total = candidates.length;
  const page = candidates.slice(offset, offset + limit);

  return formatPendingMemories(page, total);
}

async function listPendingMemoriesFromPostgres(
  database: WriteTransactionRunner,
  input: ListPendingMemoriesRequest,
  limit: number,
  offset: number
): Promise<ListPendingMemoriesResponse | null> {
  return withWriteTransaction(database, async (tx) => {
    if (!isPostgresTransactionContext(tx)) return null;

    const filters: string[] = [
      "lifecycle_status = 'candidate'",
      "review_state = 'pending'",
      "is_current = true",
    ];
    const params: unknown[] = [];
    const addParam = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (input.scope_type) filters.push(`scope_type = ${addParam(input.scope_type)}`);
    if (input.scope_id) filters.push(`scope_id = ${addParam(input.scope_id)}`);
    if (input.agent_id) {
      const placeholder = addParam(input.agent_id);
      filters.push(`(created_by = ${placeholder} OR agent_id = ${placeholder} OR metadata->>'agent_id' = ${placeholder})`);
    }
    if (input.memory_class) filters.push(memoryPolicySqlPredicate("memory_class", addParam(input.memory_class)));
    if (input.recall_policy) filters.push(memoryPolicySqlPredicate("recall_policy", addParam(input.recall_policy)));
    if (input.policy_action) filters.push(memoryPolicySqlPredicate("policy_action", addParam(input.policy_action)));
    if (input.source) filters.push(`metadata->>'source' = ${addParam(input.source)}`);

    const whereSql = filters.join(" AND ");
    const countRows = await tx.query<{ total: string | number }>(
      `SELECT count(*) AS total FROM memory_records WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.total ?? 0);
    const rowParams = [...params, limit, offset];
    const rows = await tx.query(
      `
        SELECT *
        FROM memory_records
        WHERE ${whereSql}
        ORDER BY
          CASE
            WHEN COALESCE(metadata->>'memory_class', metadata->'auto_approval_policy'->'memory_policy'->>'memory_class') = 'operational_issue' THEN 0
            WHEN COALESCE(metadata->>'memory_class', metadata->'auto_approval_policy'->'memory_policy'->>'memory_class') = 'unknown_source_quarantine' THEN 1
            WHEN COALESCE(metadata->>'memory_class', metadata->'auto_approval_policy'->'memory_policy'->>'memory_class') IN ('test_evidence', 'audit_evidence') THEN 2
            ELSE 3
          END ASC,
          created_at ASC
        LIMIT $${params.length + 1}
        OFFSET $${params.length + 2}
      `,
      rowParams
    );

    return formatPendingMemories(rows.map(mapMemoryRecordRow), total);
  });
}

function memoryPolicySqlPredicate(key: string, placeholder: string): string {
  return `COALESCE(metadata->>'${key}', metadata->'auto_approval_policy'->'memory_policy'->>'${key}') = ${placeholder}`;
}

function memoryAgentMatches(row: MemoryRecordRow, agentId: string): boolean {
  return row.createdBy === agentId || row.agentId === agentId || row.metadata.agent_id === agentId;
}

function formatPendingMemories(
  page: readonly MemoryRecordRow[],
  total: number
): ListPendingMemoriesResponse {
  return {
    ok: true,
    memories: page.map((r) => ({
      id: r.id,
      content: r.content,
      title: r.title ?? null,
      memory_type: (r as any).memoryType ?? null,
      created_at: r.createdAt,
      actor_id: r.createdBy,
      scope_type: r.scopeType,
      scope_id: r.scopeId,
      metadata: r.metadata as JsonObject,
      memory_class: memoryPolicyField(r.metadata, "memory_class"),
      recall_policy: memoryPolicyField(r.metadata, "recall_policy"),
      policy_action: memoryPolicyField(r.metadata, "policy_action"),
      suggested_action: suggestedAction(r.metadata),
      conversation_context: r.metadata?.source === "conversation_ingest"
        ? {
            source: r.metadata.source,
            conversation_id: r.metadata.conversation_id ?? null,
            session_id: r.metadata.session_id ?? null,
            turn_ids: r.metadata.turn_ids ?? r.metadata.source_turn_ids ?? [],
            source_message_roles: r.metadata.source_message_roles ?? [],
            scope_context_source: r.metadata.scope_context_source ?? null,
            mem0_mode: r.metadata.mem0_mode ?? null,
            extraction_backend: r.metadata.extraction_backend ?? null,
            review_reason: r.metadata.review_reason ?? null,
          }
        : undefined,
    })),
    total,
  };
}

export async function approveMemoryFromMcp(
  database: WriteTransactionRunner,
  input: McpApproveMemoryRequest,
  invalidateScopeCache: (scopeType: string, scopeId: string) => Promise<void>,
  service: ReviewDecisionService = new ReviewDecisionService({ database })
): Promise<McpReviewMemoryResponse> {
  const snapshot = await database.snapshotForMemoryIds([input.memory_id]);
  const record = snapshot.memoryRecords.find((r) => r.id === input.memory_id);

  if (!record) {
    return { ok: false, memory_id: input.memory_id, lifecycle_status: "unknown", review_state: "unknown" };
  }

  if (record.lifecycleStatus === "approved" && record.reviewState === "approved") {
    return { ok: true, memory_id: record.id, lifecycle_status: record.lifecycleStatus, review_state: record.reviewState };
  }

  const result = await service.approve({
    requestId: randomUUID(),
    actorId: input.reviewer_id,
    memoryId: input.memory_id
  });

  await invalidateScopeCache(record.scopeType, record.scopeId);

  return {
    ok: true,
    memory_id: result.memoryId,
    lifecycle_status: result.lifecycleStatus,
    review_state: result.reviewState,
  };
}

export async function rejectMemoryFromMcp(
  database: WriteTransactionRunner,
  input: McpRejectMemoryRequest,
  invalidateScopeCache: (scopeType: string, scopeId: string) => Promise<void>,
  service: ReviewDecisionService = new ReviewDecisionService({ database })
): Promise<McpReviewMemoryResponse> {
  const snapshot = await database.snapshotForMemoryIds([input.memory_id]);
  const record = snapshot.memoryRecords.find((r) => r.id === input.memory_id);

  if (!record) {
    return { ok: false, memory_id: input.memory_id, lifecycle_status: "unknown", review_state: "unknown" };
  }

  if (record.lifecycleStatus === "rejected" && record.reviewState === "rejected") {
    return { ok: true, memory_id: record.id, lifecycle_status: record.lifecycleStatus, review_state: record.reviewState };
  }

  const result = await service.reject({
    requestId: randomUUID(),
    actorId: input.reviewer_id,
    memoryId: input.memory_id
  });

  await invalidateScopeCache(record.scopeType, record.scopeId);

  return {
    ok: true,
    memory_id: result.memoryId,
    lifecycle_status: result.lifecycleStatus,
    review_state: result.reviewState,
  };
}

export async function readMemoryById(
  database: WriteTransactionRunner,
  input: ReadMemoryRequest
): Promise<ReadMemoryResponse> {
  const lookupId = input.memoryId?.trim() || "";
  if (!lookupId) {
    return { memory: null, error: "memoryId required", error_code: "invalid_input", status: 400 };
  }
  const snapshot = await database.snapshotForMemoryIds([lookupId]);
  const record = snapshot.memoryRecords.find((r) => r.id === lookupId);
  if (!record) {
    return { memory: null, error: "memory_not_found", error_code: "record_not_found", status: 404 };
  }
  return {
    memory: {
      id: record.id,
      content: record.content,
      title: record.title,
      summary: record.summary,
      scope_type: record.scopeType,
      scope_id: record.scopeId,
      lifecycle_status: record.lifecycleStatus,
      review_state: record.reviewState,
      is_current: record.isCurrent,
      metadata: record.metadata,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    },
  };
}

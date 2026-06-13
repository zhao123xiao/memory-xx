import { GovernanceRepository } from "../db/repositories/governance-repository";
import { mapMemoryRelationRow } from "../db/adapters/postgres-row-mappers";
import {
  isInMemoryTransactionContext,
  isPostgresTransactionContext,
  withWriteTransaction,
  type WriteTransactionRunner,
} from "../db/tx/write-transaction";
import { LifecycleStatus, ReviewState, type JsonObject } from "../shared";
import type { GraphRelationRetargetApplyPlan } from "./graph-relation-repair-plan";

export interface ExecuteGraphRelationRetargetPlanInput {
  readonly plan: GraphRelationRetargetApplyPlan;
  readonly actorId: string;
  readonly runId?: string | null;
}

export interface ExecuteGraphRelationRetargetPlanResult {
  readonly ok: boolean;
  readonly status: "applied" | "blocked";
  readonly blocked_reason?: string;
  readonly relation_id: string;
  readonly old_related_memory_id: string;
  readonly new_related_memory_id: string;
}

export async function executeGraphRelationRetargetPlan(
  database: WriteTransactionRunner,
  input: ExecuteGraphRelationRetargetPlanInput,
): Promise<ExecuteGraphRelationRetargetPlanResult> {
  return withWriteTransaction(database, async (tx) => {
    const governance = new GovernanceRepository();
    const beforeState = await loadGraphRetargetState(tx, input.plan);
    const blockedReason = validateRetargetState(beforeState, input.plan);
    if (blockedReason) {
      const result = blockedResult(input.plan, blockedReason);
      await governance.recordAction(tx, governanceActionInput(input, result, beforeState, null));
      return result;
    }

    const updatedRelation = await applyRetarget(tx, input.plan, input.actorId);
    const result: ExecuteGraphRelationRetargetPlanResult = {
      ok: true,
      status: "applied",
      relation_id: input.plan.relation_id,
      old_related_memory_id: input.plan.old_related_memory_id,
      new_related_memory_id: input.plan.new_related_memory_id,
    };
    await governance.recordAction(tx, governanceActionInput(input, result, beforeState, {
      relation: updatedRelation as unknown as JsonObject,
    }));
    return result;
  });
}

interface RetargetState {
  readonly relation: {
    readonly id: string;
    readonly memoryId: string;
    readonly relatedMemoryId: string;
    readonly relationType: string;
    readonly metadata: JsonObject;
  } | null;
  readonly source: {
    readonly id: string;
    readonly lifecycleStatus: string;
    readonly reviewState: string;
    readonly isCurrent: boolean;
  } | null;
  readonly successor: {
    readonly id: string;
    readonly lifecycleStatus: string;
    readonly reviewState: string;
    readonly isCurrent: boolean;
  } | null;
}

async function loadGraphRetargetState(
  tx: Parameters<Parameters<typeof withWriteTransaction>[1]>[0],
  plan: GraphRelationRetargetApplyPlan,
): Promise<RetargetState> {
  if (isInMemoryTransactionContext(tx)) {
    const relation = tx.state.memoryRelations.find((item) => item.id === plan.relation_id) ?? null;
    const source = tx.state.memoryRecords.find((item) => item.id === plan.source_memory_id) ?? null;
    const successor = tx.state.memoryRecords.find((item) => item.id === plan.new_related_memory_id) ?? null;
    return {
      relation: relation ? {
        id: relation.id,
        memoryId: relation.memoryId,
        relatedMemoryId: relation.relatedMemoryId,
        relationType: relation.relationType,
        metadata: relation.metadata,
      } : null,
      source: source ? {
        id: source.id,
        lifecycleStatus: source.lifecycleStatus,
        reviewState: source.reviewState,
        isCurrent: source.isCurrent,
      } : null,
      successor: successor ? {
        id: successor.id,
        lifecycleStatus: successor.lifecycleStatus,
        reviewState: successor.reviewState,
        isCurrent: successor.isCurrent,
      } : null,
    };
  }
  if (isPostgresTransactionContext(tx)) {
    const [relation] = await tx.query(
      `SELECT * FROM memory_relations WHERE id = $1 FOR UPDATE`,
      [plan.relation_id],
    );
    const [source] = await tx.query<{ id: string; lifecycle_status: string; review_state: string; is_current: boolean }>(
      `SELECT id, lifecycle_status, review_state, is_current FROM memory_records WHERE id = $1`,
      [plan.source_memory_id],
    );
    const [successor] = await tx.query<{ id: string; lifecycle_status: string; review_state: string; is_current: boolean }>(
      `SELECT id, lifecycle_status, review_state, is_current FROM memory_records WHERE id = $1`,
      [plan.new_related_memory_id],
    );
    const mappedRelation = relation ? mapMemoryRelationRow(relation) : null;
    return {
      relation: mappedRelation ? {
        id: mappedRelation.id,
        memoryId: mappedRelation.memoryId,
        relatedMemoryId: mappedRelation.relatedMemoryId,
        relationType: mappedRelation.relationType,
        metadata: mappedRelation.metadata,
      } : null,
      source: source ? {
        id: source.id,
        lifecycleStatus: source.lifecycle_status,
        reviewState: source.review_state,
        isCurrent: source.is_current,
      } : null,
      successor: successor ? {
        id: successor.id,
        lifecycleStatus: successor.lifecycle_status,
        reviewState: successor.review_state,
        isCurrent: successor.is_current,
      } : null,
    };
  }
  return { relation: null, source: null, successor: null };
}

function validateRetargetState(state: RetargetState, plan: GraphRelationRetargetApplyPlan): string | null {
  if (!state.relation) return "relation_not_found";
  if (!state.source) return "source_not_found";
  if (!state.successor) return "successor_not_found";
  if (state.relation.memoryId !== plan.source_memory_id) return "relation_source_mismatch";
  if (state.relation.relatedMemoryId !== plan.old_related_memory_id) return "relation_old_target_mismatch";
  if (!state.source.isCurrent || state.source.lifecycleStatus !== LifecycleStatus.Approved) return "source_not_approved_current";
  if (
    !state.successor.isCurrent ||
    state.successor.lifecycleStatus !== LifecycleStatus.Approved ||
    ![ReviewState.Approved, ReviewState.SilentApproved, ReviewState.NotRequired].includes(state.successor.reviewState as ReviewState)
  ) {
    return "successor_not_approved_current";
  }
  return null;
}

async function applyRetarget(
  tx: Parameters<Parameters<typeof withWriteTransaction>[1]>[0],
  plan: GraphRelationRetargetApplyPlan,
  actorId: string,
): Promise<Record<string, unknown>> {
  const patch = {
    graph_relation_repair: "retarget_relation_to_successor",
    old_related_memory_id: plan.old_related_memory_id,
    new_related_memory_id: plan.new_related_memory_id,
    repaired_by: actorId,
    repaired_at: tx.now(),
  };
  if (isInMemoryTransactionContext(tx)) {
    const index = tx.state.memoryRelations.findIndex((item) => item.id === plan.relation_id);
    if (index < 0) throw new Error("relation_not_found");
    const next = {
      ...tx.state.memoryRelations[index],
      relatedMemoryId: plan.new_related_memory_id,
      metadata: {
        ...tx.state.memoryRelations[index].metadata,
        ...patch,
      },
      updatedAt: tx.now(),
    };
    tx.state.memoryRelations[index] = next;
    return next as unknown as Record<string, unknown>;
  }
  if (isPostgresTransactionContext(tx)) {
    const [row] = await tx.query(
      `
        UPDATE memory_relations
        SET related_memory_id = $2,
            metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
            updated_at = $4::timestamptz
        WHERE id = $1
        RETURNING *
      `,
      [plan.relation_id, plan.new_related_memory_id, JSON.stringify(patch), tx.now()],
    );
    return row ? mapMemoryRelationRow(row) as unknown as Record<string, unknown> : {};
  }
  return {};
}

function blockedResult(plan: GraphRelationRetargetApplyPlan, blockedReason: string): ExecuteGraphRelationRetargetPlanResult {
  return {
    ok: false,
    status: "blocked",
    blocked_reason: blockedReason,
    relation_id: plan.relation_id,
    old_related_memory_id: plan.old_related_memory_id,
    new_related_memory_id: plan.new_related_memory_id,
  };
}

function governanceActionInput(
  input: ExecuteGraphRelationRetargetPlanInput,
  result: ExecuteGraphRelationRetargetPlanResult,
  beforeState: RetargetState,
  afterState: JsonObject | null,
) {
  return {
    runId: input.runId ?? null,
    actionType: "graph_relation_retarget",
    scopeType: null,
    scopeId: null,
    memoryId: input.plan.source_memory_id,
    relatedMemoryId: input.plan.new_related_memory_id,
    selector: {
      relation_id: input.plan.relation_id,
      old_related_memory_id: input.plan.old_related_memory_id,
      new_related_memory_id: input.plan.new_related_memory_id,
    },
    evidence: {
      plan: input.plan as unknown as JsonObject,
      blocked_reason: result.blocked_reason ?? null,
    },
    beforeState: beforeState as unknown as JsonObject,
    afterState: afterState ?? {},
    status: result.status === "applied" ? "applied" : "reported",
    createdBy: input.actorId,
  } as const;
}

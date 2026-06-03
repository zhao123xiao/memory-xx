import type { JsonObject } from "../../shared";
import type {
  RecallFeedbackEventRow,
  RecallRepairQueueRow,
  RecallTraceRow
} from "../schema/tables";
import {
  type WriteTransactionContext,
  isInMemoryTransactionContext
} from "../tx/write-transaction";
import {
  mapRecallFeedbackEventRow,
  mapRecallRepairQueueRow,
  mapRecallTraceRow
} from "./support-row-mappers";
import {
  buildRecallRepairDetails,
  resolveRecallRepairRootCauseType,
  type RecallRepairRootCauseType
} from "../../recall/recall-repair";

export type RecallFeedbackType =
  | "presented"
  | "used_in_context"
  | "adopted"
  | "ignored"
  | "not_relevant"
  | "false_positive"
  | "false_null";

export interface AddRecallTraceInput {
  readonly id: string;
  readonly queryHash: string;
  readonly queryExcerpt: string;
  readonly actorId?: string | null;
  readonly scopeContext: JsonObject;
  readonly queryType: string;
  readonly strategy: string;
  readonly degradeLevel: number;
  readonly results: JsonObject;
  readonly audit: JsonObject;
}

export interface AddRecallFeedbackInput {
  readonly recallTraceId: string;
  readonly memoryId?: string | null;
  readonly actorId: string;
  readonly feedbackType: RecallFeedbackType;
  readonly suspicious?: boolean;
  readonly reason?: string | null;
  readonly metadata?: JsonObject | null;
}

export class RecallFeedbackRepository {
  async addTrace(tx: WriteTransactionContext, input: AddRecallTraceInput): Promise<RecallTraceRow> {
    const now = tx.now();
    if (isInMemoryTransactionContext(tx)) {
      const row: RecallTraceRow = {
        id: input.id,
        queryHash: input.queryHash,
        queryExcerpt: input.queryExcerpt,
        actorId: input.actorId ?? null,
        scopeContext: input.scopeContext,
        queryType: input.queryType,
        strategy: input.strategy,
        degradeLevel: input.degradeLevel,
        results: input.results,
        audit: input.audit,
        createdAt: now,
      };
      tx.state.recallTraces.push(row);
      return row;
    }

    const [row] = await tx.query(
      `
        INSERT INTO recall_traces (
          id, query_hash, query_excerpt, actor_id, scope_context, query_type, strategy,
          degrade_level, results, audit, created_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10::jsonb, $11::timestamptz)
        ON CONFLICT (id) DO NOTHING
        RETURNING *
      `,
      [
        input.id,
        input.queryHash,
        input.queryExcerpt,
        input.actorId ?? null,
        JSON.stringify(input.scopeContext),
        input.queryType,
        input.strategy,
        input.degradeLevel,
        JSON.stringify(input.results),
        JSON.stringify(input.audit),
        now,
      ]
    );
    if (row) return mapRecallTraceRow(row);
    const existing = await this.getTrace(tx, input.id);
    if (!existing) throw new Error("recall_trace_insert_failed");
    return existing;
  }

  async getTrace(tx: WriteTransactionContext, recallTraceId: string): Promise<RecallTraceRow | null> {
    if (isInMemoryTransactionContext(tx)) {
      return tx.state.recallTraces.find((row) => row.id === recallTraceId) ?? null;
    }
    const rows = await tx.query(
      `SELECT * FROM recall_traces WHERE id = $1 LIMIT 1`,
      [recallTraceId]
    );
    return rows[0] ? mapRecallTraceRow(rows[0]) : null;
  }

  async addFeedback(tx: WriteTransactionContext, input: AddRecallFeedbackInput): Promise<RecallFeedbackEventRow> {
    const now = tx.now();
    if (isInMemoryTransactionContext(tx)) {
      const row: RecallFeedbackEventRow = {
        id: tx.nextId("recall_feedback_event"),
        recallTraceId: input.recallTraceId,
        memoryId: input.memoryId ?? null,
        actorId: input.actorId,
        feedbackType: input.feedbackType,
        suspicious: input.suspicious ?? false,
        reason: input.reason ?? null,
        metadata: input.metadata ?? {},
        createdAt: now,
      };
      tx.state.recallFeedbackEvents.push(row);
      return row;
    }

    const [row] = await tx.query(
      `
        INSERT INTO recall_feedback_events (
          id, recall_trace_id, memory_id, actor_id, feedback_type, suspicious, reason, metadata, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)
        RETURNING *
      `,
      [
        tx.nextId("recall_feedback_event"),
        input.recallTraceId,
        input.memoryId ?? null,
        input.actorId,
        input.feedbackType,
        input.suspicious ?? false,
        input.reason ?? null,
        JSON.stringify(input.metadata ?? {}),
        now,
      ]
    );
    return mapRecallFeedbackEventRow(row);
  }

  async isActorFeedbackSuspicious(tx: WriteTransactionContext, actorId: string): Promise<boolean> {
    if (isInMemoryTransactionContext(tx)) {
      const rows = tx.state.recallFeedbackEvents.filter((row) => row.actorId === actorId);
      return suspiciousFromCounts(rows.length, rows.filter((row) => row.feedbackType === "used_in_context").length, rows.filter((row) => row.feedbackType === "false_null").length);
    }
    const [row] = await tx.query<{ total: string; used: string; false_nulls: string }>(
      `
        SELECT
          count(*)::text AS total,
          count(*) FILTER (WHERE feedback_type = 'used_in_context')::text AS used,
          count(*) FILTER (WHERE feedback_type = 'false_null')::text AS false_nulls
        FROM recall_feedback_events
        WHERE actor_id = $1
          AND created_at >= now() - interval '24 hours'
      `,
      [actorId]
    );
    return suspiciousFromCounts(Number(row?.total ?? 0), Number(row?.used ?? 0), Number(row?.false_nulls ?? 0));
  }

  async upsertRepairQueue(tx: WriteTransactionContext, input: {
    readonly queryHash: string;
    readonly recallTraceId: string;
    readonly issueType: "false_null" | "ignored" | "not_relevant" | "reranker_fallback";
    readonly details?: JsonObject;
    readonly urgency?: string;
    readonly rootCauseType?: RecallRepairRootCauseType | null;
    readonly rootCause?: string | null;
    readonly suggestedAction?: string | null;
  }): Promise<RecallRepairQueueRow> {
    const now = tx.now();
    const rootCauseType = input.issueType === "false_null"
      ? resolveRecallRepairRootCauseType({
          rootCauseType: input.rootCauseType,
          rootCause: input.rootCause,
          details: input.details,
          memoryId: readString(input.details?.memory_id)
        })
      : input.rootCauseType ?? null;
    const details = input.issueType === "false_null"
      ? buildRecallRepairDetails({
          scope: readJsonObject(input.details?.scope),
          queryHash: input.queryHash,
          rootCauseType: rootCauseType ?? "embedding_gap",
          memoryId: readString(input.details?.memory_id),
          suggestedAction: input.suggestedAction ?? readString(input.details?.suggested_action),
          suggestedValues: readJsonObject(input.details?.suggested_values),
          extra: input.details ?? {}
        })
      : input.details ?? {};
    if (isInMemoryTransactionContext(tx)) {
      const existing = tx.state.recallRepairQueue.find((row) => row.queryHash === input.queryHash && row.issueType === input.issueType);
      if (existing) {
        const next: RecallRepairQueueRow = {
          ...existing,
          count: existing.count + 1,
          recallTraceId: input.recallTraceId,
          details,
          urgency: strongestUrgency(existing.urgency, input.urgency ?? "P2"),
          rootCauseType: rootCauseType ?? existing.rootCauseType,
          rootCause: input.rootCause ?? rootCauseType ?? existing.rootCause,
          suggestedAction: input.suggestedAction ?? readString(details.suggested_action) ?? existing.suggestedAction,
          updatedAt: now,
        };
        const index = tx.state.recallRepairQueue.indexOf(existing);
        tx.state.recallRepairQueue[index] = next;
        return next;
      }
      const row: RecallRepairQueueRow = {
        id: tx.nextId("recall_repair_queue"),
        queryHash: input.queryHash,
        recallTraceId: input.recallTraceId,
        issueType: input.issueType,
        count: 1,
        status: "open",
        details,
        urgency: input.urgency ?? "P2",
        rootCauseType,
        rootCause: input.rootCause ?? rootCauseType ?? null,
        suggestedAction: input.suggestedAction ?? readString(details.suggested_action) ?? null,
        governanceActionId: null,
        appliedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      tx.state.recallRepairQueue.push(row);
      return row;
    }
    const [row] = await tx.query(
      `
        INSERT INTO recall_repair_queue (
          id, query_hash, recall_trace_id, issue_type, count, status, details,
          urgency, root_cause_type, root_cause, suggested_action, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, 1, 'open', $5::jsonb, $6, $7, $8, $9, $10::timestamptz, $10::timestamptz)
        ON CONFLICT (query_hash, issue_type)
        DO UPDATE SET
          count = recall_repair_queue.count + 1,
          recall_trace_id = EXCLUDED.recall_trace_id,
          details = EXCLUDED.details,
          urgency = CASE
            WHEN EXCLUDED.urgency = 'P0' OR recall_repair_queue.urgency = 'P0' THEN 'P0'
            WHEN EXCLUDED.urgency = 'P1' OR recall_repair_queue.urgency = 'P1' THEN 'P1'
            ELSE EXCLUDED.urgency
          END,
          root_cause_type = COALESCE(EXCLUDED.root_cause_type, recall_repair_queue.root_cause_type),
          root_cause = COALESCE(EXCLUDED.root_cause, recall_repair_queue.root_cause),
          suggested_action = COALESCE(EXCLUDED.suggested_action, recall_repair_queue.suggested_action),
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `,
      [
        tx.nextId("recall_repair_queue"),
        input.queryHash,
        input.recallTraceId,
        input.issueType,
        JSON.stringify(details),
        input.urgency ?? "P2",
        rootCauseType,
        input.rootCause ?? rootCauseType ?? null,
        input.suggestedAction ?? readString(details.suggested_action) ?? null,
        now,
      ]
    );
    return mapRecallRepairQueueRow(row);
  }
}

function strongestUrgency(left: string, right: string): string {
  const rank = new Map([["P0", 0], ["P1", 1], ["P2", 2], ["P3", 3]]);
  return (rank.get(right) ?? 2) < (rank.get(left) ?? 2) ? right : left;
}

function suspiciousFromCounts(total: number, used: number, falseNulls: number): boolean {
  if (total < 20) return false;
  return used / total > 0.95 || falseNulls / total > 0.50;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readJsonObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

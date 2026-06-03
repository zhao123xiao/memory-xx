import type { WriteTransactionRunner } from "../db/tx/write-transaction";
import { isInMemoryTransactionContext } from "../db/tx/write-transaction";
import {
  LifecycleStatus,
  ScopeType
} from "../shared";
import { EFFECTIVE_RECALLABLE_SQL_WHERE_CLAUSE, isEffectiveRecallable } from "../shared/predicates";
import type { MemoryCountsRequest, MemoryCountsResponse } from "./types";

export async function readMemoryCounts(
  database: WriteTransactionRunner,
  now: () => string,
  input: MemoryCountsRequest = {}
): Promise<MemoryCountsResponse> {
  const scopeType = input.scopeType ?? ScopeType.Project;
  const hasExplicitScope = Boolean(input.scopeType && input.scopeId?.trim());
  const scopeId = input.scopeId?.trim() || "*";
  let aggregateRows: readonly {
    total: string | number;
    current: string | number;
    candidate_pending_current: string | number;
    candidate_pending: string | number;
    approved_current: string | number;
    pending_review: string | number;
    archived: string | number;
    rejected: string | number;
    tombstone: string | number;
  }[] = [];
  let byScopeRows: readonly {
    scope_type: ScopeType;
    scope_id: string;
    total: string | number;
    candidate_pending_current: string | number;
    pending_review: string | number;
  }[] = [];

  await database.withTransaction(async (tx) => {
    if (isInMemoryTransactionContext(tx)) {
      const records = hasExplicitScope
        ? tx.state.memoryRecords.filter((record) => record.scopeType === scopeType && record.scopeId === scopeId)
        : tx.state.memoryRecords;
      aggregateRows = [{
        total: records.length,
        current: records.filter((record) => record.isCurrent).length,
        candidate_pending_current: records.filter((record) => record.isCurrent && record.lifecycleStatus === LifecycleStatus.Candidate && record.reviewState === "pending").length,
        candidate_pending: records.filter((record) => record.lifecycleStatus === LifecycleStatus.Candidate && record.reviewState === "pending").length,
        approved_current: records.filter((record) => isEffectiveRecallable(record)).length,
        pending_review: records.filter((record) => record.reviewState === "pending").length,
        archived: records.filter((record) => record.lifecycleStatus === LifecycleStatus.Archived).length,
        rejected: records.filter((record) => record.lifecycleStatus === LifecycleStatus.Rejected).length,
        tombstone: records.filter((record) => record.lifecycleStatus === LifecycleStatus.Tombstone).length,
      }];
      if (input.includeByScope === true) {
        const grouped = new Map<string, { scope_type: ScopeType; scope_id: string; total: number; candidate_pending_current: number; pending_review: number }>();
        const byScopeSource = hasExplicitScope
          ? tx.state.memoryRecords.filter((record) => record.scopeType === scopeType && record.scopeId === scopeId)
          : tx.state.memoryRecords;
        for (const record of byScopeSource) {
          const key = `${record.scopeType}:${record.scopeId}`;
          const row = grouped.get(key) ?? { scope_type: record.scopeType, scope_id: record.scopeId, total: 0, candidate_pending_current: 0, pending_review: 0 };
          row.total += 1;
          if (record.isCurrent && record.lifecycleStatus === LifecycleStatus.Candidate && record.reviewState === "pending") row.candidate_pending_current += 1;
          if (record.reviewState === "pending") row.pending_review += 1;
          grouped.set(key, row);
        }
        byScopeRows = [...grouped.values()];
      }
      return;
    }

    aggregateRows = await tx.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE is_current IS TRUE)::int AS current,
        COUNT(*) FILTER (WHERE is_current IS TRUE AND lifecycle_status = 'candidate' AND review_state = 'pending')::int AS candidate_pending_current,
        COUNT(*) FILTER (WHERE lifecycle_status = 'candidate' AND review_state = 'pending')::int AS candidate_pending,
        COUNT(*) FILTER (WHERE ${EFFECTIVE_RECALLABLE_SQL_WHERE_CLAUSE})::int AS approved_current,
        COUNT(*) FILTER (WHERE review_state = 'pending')::int AS pending_review,
        COUNT(*) FILTER (WHERE lifecycle_status = 'archived')::int AS archived,
        COUNT(*) FILTER (WHERE lifecycle_status = 'rejected')::int AS rejected,
        COUNT(*) FILTER (WHERE lifecycle_status = 'tombstone')::int AS tombstone
      FROM memory_records
      ${hasExplicitScope ? "WHERE scope_type = $1 AND scope_id = $2" : ""}
    `, hasExplicitScope ? [scopeType, scopeId] : []);

    if (input.includeByScope === true) {
      byScopeRows = await tx.query(`
        SELECT
          scope_type,
          scope_id,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE is_current IS TRUE AND lifecycle_status = 'candidate' AND review_state = 'pending')::int AS candidate_pending_current,
          COUNT(*) FILTER (WHERE review_state = 'pending')::int AS pending_review
        FROM memory_records
        ${hasExplicitScope ? "WHERE scope_type = $1 AND scope_id = $2" : ""}
        GROUP BY scope_type, scope_id
        ORDER BY candidate_pending_current DESC, pending_review DESC, total DESC
        LIMIT 50
      `, hasExplicitScope ? [scopeType, scopeId] : []);
    }
  });

  const row = aggregateRows[0] ?? {
    total: 0,
    current: 0,
    candidate_pending_current: 0,
    candidate_pending: 0,
    approved_current: 0,
    pending_review: 0,
    archived: 0,
    rejected: 0,
    tombstone: 0,
  };
  const toNumber = (value: unknown) => Number(value || 0);
  return {
    ok: true,
    checked_at: now(),
    scope: { scopeType, scopeId },
    counts: {
      total: toNumber(row.total),
      current: toNumber(row.current),
      candidate_pending_current: toNumber(row.candidate_pending_current),
      candidate_pending: toNumber(row.candidate_pending),
      approved_current: toNumber(row.approved_current),
      pending_review: toNumber(row.pending_review),
      archived: toNumber(row.archived),
      rejected: toNumber(row.rejected),
      tombstone: toNumber(row.tombstone),
    },
    ...(input.includeByScope === true ? {
      by_scope: byScopeRows.map((item) => ({
        scopeType: item.scope_type,
        scopeId: item.scope_id,
        total: toNumber(item.total),
        candidate_pending_current: toNumber(item.candidate_pending_current),
        pending_review: toNumber(item.pending_review),
      })),
    } : {}),
  };
}

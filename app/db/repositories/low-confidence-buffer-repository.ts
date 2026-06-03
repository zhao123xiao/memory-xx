import type { LowConfidenceBufferRow } from "../schema/tables";
import {
  type WriteTransactionContext,
  isInMemoryTransactionContext
} from "../tx/write-transaction";
import { mapLowConfidenceBufferRow } from "./support-row-mappers";
import type { JsonObject } from "../../shared";

export interface AddLowConfidenceBufferInput {
  readonly requestId: string;
  readonly actorId: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly inputText: string;
  readonly extraction: JsonObject;
  readonly qualityGate: JsonObject;
}

export class LowConfidenceBufferRepository {
  async listDueForRetry(tx: WriteTransactionContext, limit = 20): Promise<readonly LowConfidenceBufferRow[]> {
    const now = tx.now();
    if (isInMemoryTransactionContext(tx)) {
      return tx.state.lowConfidenceBuffer
        .filter((row) =>
          row.status === "pending_retry" &&
          row.retryCount === 0 &&
          row.nextRetryAt !== null &&
          row.nextRetryAt <= now
        )
        .sort((left, right) => (left.nextRetryAt ?? "").localeCompare(right.nextRetryAt ?? ""))
        .slice(0, limit);
    }

    const rows = await tx.query(
      `
        SELECT *
        FROM low_confidence_buffer
        WHERE status = 'pending_retry'
          AND retry_count = 0
          AND next_retry_at <= now()
        ORDER BY next_retry_at ASC, created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `,
      [limit]
    );
    return rows.map(mapLowConfidenceBufferRow);
  }

  async add(tx: WriteTransactionContext, input: AddLowConfidenceBufferInput): Promise<LowConfidenceBufferRow> {
    const now = tx.now();
    const nextRetry = new Date(Date.parse(now) + 10 * 60 * 1000).toISOString();
    if (isInMemoryTransactionContext(tx)) {
      const row: LowConfidenceBufferRow = {
        id: tx.nextId("low_confidence_buffer"),
        requestId: input.requestId,
        actorId: input.actorId,
        scopeType: input.scopeType as LowConfidenceBufferRow["scopeType"],
        scopeId: input.scopeId,
        inputText: input.inputText,
        extraction: input.extraction,
        qualityGate: input.qualityGate,
        status: "pending_retry",
        retryCount: 0,
        nextRetryAt: nextRetry,
        abandonedAt: null,
        promotedMemoryId: null,
        createdAt: now,
        updatedAt: now,
      };
      tx.state.lowConfidenceBuffer.push(row);
      return row;
    }

    const [row] = await tx.query(
      `
        INSERT INTO low_confidence_buffer (
          id, request_id, actor_id, scope_type, scope_id, input_text, extraction,
          quality_gate, status, retry_count, next_retry_at, abandoned_at,
          promoted_memory_id, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 'pending_retry', 0,
          $9::timestamptz, NULL, NULL, $10::timestamptz, $11::timestamptz)
        RETURNING *
      `,
      [
        tx.nextId("low_confidence_buffer"),
        input.requestId,
        input.actorId,
        input.scopeType,
        input.scopeId,
        input.inputText,
        JSON.stringify(input.extraction),
        JSON.stringify(input.qualityGate),
        nextRetry,
        now,
        now,
      ]
    );
    return mapLowConfidenceBufferRow(row);
  }

  async markRetried(tx: WriteTransactionContext, bufferId: string): Promise<LowConfidenceBufferRow> {
    const now = tx.now();
    if (isInMemoryTransactionContext(tx)) {
      const index = tx.state.lowConfidenceBuffer.findIndex((row) => row.id === bufferId);
      if (index < 0) throw new Error(`Low confidence buffer not found: ${bufferId}`);
      const current = tx.state.lowConfidenceBuffer[index];
      const row: LowConfidenceBufferRow = {
        ...current,
        status: "retried",
        retryCount: current.retryCount + 1,
        nextRetryAt: null,
        updatedAt: now,
      };
      tx.state.lowConfidenceBuffer[index] = row;
      return row;
    }

    const [row] = await tx.query(
      `
        UPDATE low_confidence_buffer
        SET status = 'retried',
            retry_count = retry_count + 1,
            next_retry_at = NULL,
            updated_at = $2::timestamptz
        WHERE id = $1
        RETURNING *
      `,
      [bufferId, now]
    );
    if (!row) throw new Error(`Low confidence buffer not found: ${bufferId}`);
    return mapLowConfidenceBufferRow(row);
  }

  async markPromoted(tx: WriteTransactionContext, bufferId: string, memoryId: string): Promise<LowConfidenceBufferRow> {
    const now = tx.now();
    if (isInMemoryTransactionContext(tx)) {
      const index = tx.state.lowConfidenceBuffer.findIndex((row) => row.id === bufferId);
      if (index < 0) throw new Error(`Low confidence buffer not found: ${bufferId}`);
      const current = tx.state.lowConfidenceBuffer[index];
      const row: LowConfidenceBufferRow = {
        ...current,
        status: "promoted",
        retryCount: current.retryCount + 1,
        nextRetryAt: null,
        promotedMemoryId: memoryId,
        updatedAt: now,
      };
      tx.state.lowConfidenceBuffer[index] = row;
      return row;
    }

    const [row] = await tx.query(
      `
        UPDATE low_confidence_buffer
        SET status = 'promoted',
            retry_count = retry_count + 1,
            next_retry_at = NULL,
            promoted_memory_id = $2,
            updated_at = $3::timestamptz
        WHERE id = $1
        RETURNING *
      `,
      [bufferId, memoryId, now]
    );
    if (!row) throw new Error(`Low confidence buffer not found: ${bufferId}`);
    return mapLowConfidenceBufferRow(row);
  }

  async markAbandonedOlderThan(tx: WriteTransactionContext, cutoffIso: string): Promise<number> {
    const now = tx.now();
    if (isInMemoryTransactionContext(tx)) {
      let count = 0;
      const nextRows = tx.state.lowConfidenceBuffer.map((row) => {
        if (!["pending_retry", "retried"].includes(row.status) || row.createdAt > cutoffIso) return row;
        count += 1;
        return { ...row, status: "abandoned" as const, abandonedAt: now, updatedAt: now };
      });
      tx.state.lowConfidenceBuffer.splice(0, tx.state.lowConfidenceBuffer.length, ...nextRows);
      return count;
    }
    const rows = await tx.query(
      `
        UPDATE low_confidence_buffer
        SET status = 'abandoned', abandoned_at = $2::timestamptz, updated_at = $2::timestamptz
        WHERE status IN ('pending_retry', 'retried') AND created_at <= $1::timestamptz
        RETURNING id
      `,
      [cutoffIso, now]
    );
    return rows.length;
  }
}

import {
  type WriteTransactionContext,
  isInMemoryTransactionContext
} from "../tx/write-transaction";
import type { OutboxEventRow } from "../schema/tables";
import {
  OutboxDispatchStatus
} from "../../shared/contracts/write";
import { type JsonObject, type OutboxEventType } from "../../shared/types";
import { mapOutboxEventRow } from "../adapters/postgres-row-mappers";

export interface AppendOutboxEventInput {
  readonly aggregateId: string;
  readonly requestId: string;
  readonly eventType: OutboxEventType;
  readonly payload: JsonObject;
}

export class OutboxEventRepository {
  async append(
    tx: WriteTransactionContext,
    input: AppendOutboxEventInput
  ): Promise<OutboxEventRow> {
    if (isInMemoryTransactionContext(tx)) {
      const row: OutboxEventRow = {
        id: tx.nextId("outbox_event"),
        aggregateId: input.aggregateId,
        requestId: input.requestId,
        eventType: input.eventType,
        payload: input.payload,
        payloadVersion: 1,
        dispatchStatus: OutboxDispatchStatus.Pending,
        attempts: 0,
        createdAt: tx.now(),
        dispatchedAt: null,
        dispatchedBy: null,
        dispatchStartedAt: null,
        projectionVerified: null,
        dispatchMetadata: {}
      };
      tx.state.outboxEvents.push(row);
      return row;
    }

    const [row] = await tx.query(
      `
        INSERT INTO outbox_events (
          id,
          aggregate_id,
          request_id,
          event_type,
          payload,
          payload_version,
          dispatch_status,
          attempts,
          created_at,
          dispatched_at,
          dispatched_by,
          dispatch_started_at,
          projection_verified,
          dispatch_metadata
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, 1, $6, 0, $7::timestamptz, NULL, NULL, NULL, NULL, '{}'::jsonb)
        RETURNING *
      `,
      [
        tx.nextId("outbox_event"),
        input.aggregateId,
        input.requestId,
        input.eventType,
        JSON.stringify(input.payload),
        OutboxDispatchStatus.Pending,
        tx.now()
      ]
    );

    return mapOutboxEventRow(row);
  }
}

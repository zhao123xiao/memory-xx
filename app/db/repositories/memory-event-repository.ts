import {
  type WriteTransactionContext,
  isInMemoryTransactionContext
} from "../tx/write-transaction";
import type { MemoryEventRow } from "../schema/tables";
import { type JsonObject, type OutboxEventType } from "../../shared/types";
import { mapMemoryEventRow } from "../adapters/postgres-row-mappers";

export interface AppendMemoryEventInput {
  readonly memoryId: string;
  readonly requestId: string;
  readonly eventType: OutboxEventType;
  readonly actorId: string;
  readonly payload: JsonObject;
}

export class MemoryEventRepository {
  async append(
    tx: WriteTransactionContext,
    input: AppendMemoryEventInput
  ): Promise<MemoryEventRow> {
    if (isInMemoryTransactionContext(tx)) {
      const row: MemoryEventRow = {
        id: tx.nextId("memory_event"),
        memoryId: input.memoryId,
        requestId: input.requestId,
        eventType: input.eventType,
        actorId: input.actorId,
        payload: input.payload,
        createdAt: tx.now()
      };
      tx.state.memoryEvents.push(row);
      return row;
    }

    const [row] = await tx.query(
      `
        INSERT INTO memory_events (
          id,
          memory_id,
          request_id,
          event_type,
          actor_id,
          payload,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
        RETURNING *
      `,
      [
        tx.nextId("memory_event"),
        input.memoryId,
        input.requestId,
        input.eventType,
        input.actorId,
        JSON.stringify(input.payload),
        tx.now()
      ]
    );

    return mapMemoryEventRow(row);
  }
}

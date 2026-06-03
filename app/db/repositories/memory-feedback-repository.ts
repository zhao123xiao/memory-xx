import type { MemoryFeedbackEventRow } from "../schema/tables";
import {
  type WriteTransactionContext,
  isInMemoryTransactionContext
} from "../tx/write-transaction";
import { mapMemoryFeedbackEventRow } from "./support-row-mappers";
import type { JsonObject } from "../../shared";

export type MemoryFeedbackType =
  | "confirmed"
  | "used"
  | "edited"
  | "negative"
  | "wrong"
  | "deleted"
  | "not_relevant"
  | "changed_mind";

export interface AddMemoryFeedbackInput {
  readonly memoryId: string;
  readonly actorId: string;
  readonly feedbackType: MemoryFeedbackType;
  readonly relatedMemoryId?: string | null;
  readonly reason?: string | null;
  readonly metadata?: JsonObject | null;
}

export class MemoryFeedbackRepository {
  async add(tx: WriteTransactionContext, input: AddMemoryFeedbackInput): Promise<MemoryFeedbackEventRow> {
    const now = tx.now();
    if (isInMemoryTransactionContext(tx)) {
      const row: MemoryFeedbackEventRow = {
        id: tx.nextId("memory_feedback_event"),
        memoryId: input.memoryId,
        actorId: input.actorId,
        feedbackType: input.feedbackType,
        relatedMemoryId: input.relatedMemoryId ?? null,
        reason: input.reason ?? null,
        metadata: input.metadata ?? {},
        governanceTriggered: false,
        governanceActionId: null,
        createdAt: now,
      };
      tx.state.memoryFeedbackEvents.push(row);
      return row;
    }
    const [row] = await tx.query(
      `
        INSERT INTO memory_feedback_events (
          id, memory_id, actor_id, feedback_type, related_memory_id, reason, metadata, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
        RETURNING *
      `,
      [
        tx.nextId("memory_feedback_event"),
        input.memoryId,
        input.actorId,
        input.feedbackType,
        input.relatedMemoryId ?? null,
        input.reason ?? null,
        JSON.stringify(input.metadata ?? {}),
        now,
      ]
    );
    return mapMemoryFeedbackEventRow(row);
  }
}

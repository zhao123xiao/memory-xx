import { createHash } from "node:crypto";

import type { MemoryEventRepository } from "../../db/repositories/memory-event-repository";
import type { MemoryRecordRepository } from "../../db/repositories/memory-record-repository";
import type { OutboxEventRepository } from "../../db/repositories/outbox-event-repository";
import type { WriteTransactionContext } from "../../db/tx/write-transaction";
import {
  OutboxEventType,
  type JsonObject
} from "../../shared/types";
import {
  WriteCommandType,
  type NormalizedCreateMemoryCommand,
  type StoredWriteResult
} from "../../shared/contracts/write";

export async function updateCreateMemoryCandidateInPlace(
  tx: WriteTransactionContext,
  existing: {
    readonly id: string;
    readonly content: string;
    readonly title: string | null;
    readonly summary: string | null;
    readonly metadata: JsonObject;
    readonly reviewState: StoredWriteResult["reviewState"];
    readonly isCurrent: boolean;
    readonly version: number;
  },
  command: NormalizedCreateMemoryCommand,
  repositories: {
    readonly memoryRecordRepository: MemoryRecordRepository;
    readonly memoryEventRepository: MemoryEventRepository;
    readonly outboxEventRepository: OutboxEventRepository;
  }
): Promise<StoredWriteResult> {
  const updated = await repositories.memoryRecordRepository.updateCandidate(tx, {
    memoryId: existing.id,
    actorId: command.actorId,
    content: command.content,
    title: command.title,
    summary: command.summary,
    metadata: {
      ...existing.metadata,
      ...command.metadata,
      source_aware_update: {
        reason: "same_scope_same_source_block_candidate_update",
        previous_content_hash: createHash("sha256").update(existing.content).digest("hex"),
      } as JsonObject
    },
    dedupeKey: command.dedupeKey,
    memoryType: command.memoryType,
    contentEmbedding: command.contentEmbedding
  });
  const eventPayload = {
    memoryId: updated.id,
    requestId: command.requestId,
    previousContent: existing.content,
    content: updated.content,
    lifecycleStatus: updated.lifecycleStatus,
    reviewState: updated.reviewState,
    isCurrent: updated.isCurrent,
    version: updated.version,
    reason: "same_scope_same_source_block_candidate_update"
  } as const;
  const memoryEvent = await repositories.memoryEventRepository.append(tx, {
    memoryId: updated.id,
    requestId: command.requestId,
    eventType: OutboxEventType.MemoryCandidateUpdated,
    actorId: command.actorId,
    payload: { ...eventPayload }
  });
  const outboxEvent = await repositories.outboxEventRepository.append(tx, {
    aggregateId: updated.id,
    requestId: command.requestId,
    eventType: OutboxEventType.MemoryCandidateUpdated,
    payload: { ...eventPayload }
  });
  return {
    commandType: WriteCommandType.UpdateCandidateMemory,
    memoryId: updated.id,
    requestId: command.requestId,
    lifecycleStatus: updated.lifecycleStatus,
    reviewState: updated.reviewState,
    isCurrent: updated.isCurrent,
    version: updated.version,
    memoryEventType: memoryEvent.eventType,
    outboxEventType: outboxEvent.eventType,
    memoryEventId: memoryEvent.id,
    outboxEventId: outboxEvent.id,
    affectedMemoryIds: [updated.id]
  };
}

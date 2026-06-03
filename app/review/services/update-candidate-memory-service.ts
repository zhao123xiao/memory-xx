import { type WriteTransactionContext } from "../../db/tx/write-transaction";
import {
  LifecycleStatus,
  OutboxEventType,
  ReviewState
} from "../../shared/types";
import {
  InvalidLifecycleTransitionError,
  RecordNotFoundError
} from "../../shared/errors/write-errors";
import {
  WriteCommandType,
  type StoredWriteResult
} from "../../shared/contracts/write";
import {
  type UpdateCandidateMemoryCommand,
  hashUpdateCandidateMemoryCommand,
  normalizeUpdateCandidateMemoryCommand,
  serializeUpdateCandidateMemoryCommand
} from "../commands/update-candidate-memory-command";
import {
  createReviewLifecycleServiceContext,
  executeReviewMutation,
  type ReviewLifecycleExecutionResult,
  type ReviewLifecycleServiceDependencies
} from "./service-support";

export class UpdateCandidateMemoryService {
  private readonly context;

  constructor(dependencies: ReviewLifecycleServiceDependencies) {
    this.context = createReviewLifecycleServiceContext(dependencies);
  }

  execute(command: UpdateCandidateMemoryCommand): Promise<ReviewLifecycleExecutionResult> {
    const normalizedCommand = normalizeUpdateCandidateMemoryCommand(command);
    return executeReviewMutation(this.context, {
      requestId: normalizedCommand.requestId,
      actorId: normalizedCommand.actorId,
      commandType: WriteCommandType.UpdateCandidateMemory,
      payloadHash: hashUpdateCandidateMemoryCommand(normalizedCommand),
      payloadJson: serializeUpdateCandidateMemoryCommand(normalizedCommand),
      mutate: (tx) => this.updateCandidate(tx, normalizedCommand)
    });
  }

  private async updateCandidate(
    tx: WriteTransactionContext,
    command: ReturnType<typeof normalizeUpdateCandidateMemoryCommand>
  ): Promise<StoredWriteResult> {
    const record = await this.context.memoryRecordRepository.findByIdForUpdate(tx, command.memoryId);
    if (!record) {
      throw new RecordNotFoundError(command.memoryId);
    }
    if (
      record.lifecycleStatus !== LifecycleStatus.Candidate ||
      record.reviewState !== ReviewState.Pending ||
      !record.isCurrent
    ) {
      throw new InvalidLifecycleTransitionError(
        WriteCommandType.UpdateCandidateMemory,
        command.memoryId,
        record.lifecycleStatus,
        record.reviewState,
        record.isCurrent
      );
    }

    const updated = await this.context.memoryRecordRepository.updateCandidate(tx, {
      memoryId: command.memoryId,
      actorId: command.actorId,
      content: command.content,
      title: command.title,
      summary: command.summary,
      metadata: command.metadata,
      dedupeKey: command.dedupeKey,
      memoryType: command.memoryType,
      contentEmbedding: command.contentEmbedding,
    });

    const eventPayload = {
      memoryId: updated.id,
      requestId: command.requestId,
      previousContent: record.content,
      content: updated.content,
      lifecycleStatus: updated.lifecycleStatus,
      reviewState: updated.reviewState,
      isCurrent: updated.isCurrent,
      version: updated.version
    } as const;

    const memoryEvent = await this.context.memoryEventRepository.append(tx, {
      memoryId: updated.id,
      requestId: command.requestId,
      eventType: OutboxEventType.MemoryCandidateUpdated,
      actorId: command.actorId,
      payload: { ...eventPayload }
    });
    const outboxEvent = await this.context.outboxEventRepository.append(tx, {
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
}

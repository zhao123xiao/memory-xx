import { type WriteTransactionContext } from "../../db/tx/write-transaction";
import { GovernanceRepository } from "../../db/repositories/governance-repository";
import {
  LifecycleStatus,
  OutboxEventType
} from "../../shared/types";
import {
  RecordNotFoundError,
  InvalidLifecycleTransitionError,
  WriteError,
  WriteErrorCode
} from "../../shared/errors/write-errors";
import {
  WriteCommandType,
  type StoredWriteResult
} from "../../shared/contracts/write";
import { isEffectiveRecallable } from "../../shared/predicates";
import {
  type ArchiveMemoryCommand,
  hashArchiveMemoryCommand,
  normalizeArchiveMemoryCommand,
  serializeArchiveMemoryCommand
} from "../commands/archive-memory-command";
import {
  createReviewLifecycleServiceContext,
  executeReviewMutation,
  type ReviewLifecycleExecutionResult,
  type ReviewLifecycleServiceDependencies
} from "./service-support";

export class ArchiveMemoryService {
  private readonly context;

  constructor(dependencies: ReviewLifecycleServiceDependencies) {
    this.context = createReviewLifecycleServiceContext(dependencies);
  }

  execute(command: ArchiveMemoryCommand): Promise<ReviewLifecycleExecutionResult> {
    const normalizedCommand = normalizeArchiveMemoryCommand(command);
    return executeReviewMutation(this.context, {
      requestId: normalizedCommand.requestId,
      actorId: normalizedCommand.actorId,
      commandType: WriteCommandType.ArchiveMemory,
      payloadHash: hashArchiveMemoryCommand(normalizedCommand),
      payloadJson: serializeArchiveMemoryCommand(normalizedCommand),
      mutate: (tx) => this.archive(tx, normalizedCommand)
    });
  }

  private async archive(
    tx: WriteTransactionContext,
    command: { readonly requestId: string; readonly actorId: string; readonly memoryId: string }
  ): Promise<StoredWriteResult> {
    const record = await this.context.memoryRecordRepository.findByIdForUpdate(tx, command.memoryId);
    if (!record) {
      throw new RecordNotFoundError(command.memoryId);
    }

    // Freeze check
    const governance = new GovernanceRepository();
    const frozen = await governance.isScopeFrozen(tx, record.scopeType, record.scopeId, "archive");
    if (frozen) {
      throw new WriteError(
        WriteErrorCode.ScopeFrozen,
        `Scope ${record.scopeType}/${record.scopeId} is frozen for action archive`
      );
    }

    if (!isEffectiveRecallable(record)) {
      throw new InvalidLifecycleTransitionError(
        WriteCommandType.ArchiveMemory,
        command.memoryId,
        record.lifecycleStatus,
        record.reviewState,
        record.isCurrent
      );
    }

    const updated = await this.context.memoryRecordRepository.updateState(tx, {
      memoryId: command.memoryId,
      lifecycleStatus: LifecycleStatus.Archived,
      reviewState: record.reviewState,
      isCurrent: false,
      actorId: command.actorId
    });

    const eventPayload = {
      memoryId: updated.id,
      requestId: command.requestId,
      previousLifecycleStatus: record.lifecycleStatus,
      lifecycleStatus: updated.lifecycleStatus,
      previousReviewState: record.reviewState,
      reviewState: updated.reviewState,
      previousIsCurrent: record.isCurrent,
      isCurrent: updated.isCurrent
    } as const;

    const memoryEvent = await this.context.memoryEventRepository.append(tx, {
      memoryId: updated.id,
      requestId: command.requestId,
      eventType: OutboxEventType.MemoryLifecycleChanged,
      actorId: command.actorId,
      payload: { ...eventPayload }
    });

    const outboxEvent = await this.context.outboxEventRepository.append(tx, {
      aggregateId: updated.id,
      requestId: command.requestId,
      eventType: OutboxEventType.MemoryLifecycleChanged,
      payload: { ...eventPayload }
    });

    return {
      commandType: WriteCommandType.ArchiveMemory,
      memoryId: updated.id,
      requestId: command.requestId,
      lifecycleStatus: updated.lifecycleStatus,
      reviewState: updated.reviewState,
      isCurrent: updated.isCurrent,
      version: updated.version,
      memoryEventType: memoryEvent.eventType,
      outboxEventType: outboxEvent.eventType,
      memoryEventId: memoryEvent.id,
      outboxEventId: outboxEvent.id
    };
  }
}

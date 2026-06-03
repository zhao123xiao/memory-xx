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
import {
  type TombstoneMemoryCommand,
  hashTombstoneMemoryCommand,
  normalizeTombstoneMemoryCommand,
  serializeTombstoneMemoryCommand
} from "../commands/tombstone-memory-command";
import {
  createReviewLifecycleServiceContext,
  executeReviewMutation,
  type ReviewLifecycleExecutionResult,
  type ReviewLifecycleServiceDependencies
} from "./service-support";

export class TombstoneMemoryService {
  private readonly context;

  constructor(dependencies: ReviewLifecycleServiceDependencies) {
    this.context = createReviewLifecycleServiceContext(dependencies);
  }

  execute(command: TombstoneMemoryCommand): Promise<ReviewLifecycleExecutionResult> {
    const normalizedCommand = normalizeTombstoneMemoryCommand(command);
    return executeReviewMutation(this.context, {
      requestId: normalizedCommand.requestId,
      actorId: normalizedCommand.actorId,
      commandType: WriteCommandType.TombstoneMemory,
      payloadHash: hashTombstoneMemoryCommand(normalizedCommand),
      payloadJson: serializeTombstoneMemoryCommand(normalizedCommand),
      mutate: (tx) => this.tombstone(tx, normalizedCommand)
    });
  }

  private async tombstone(
    tx: WriteTransactionContext,
    command: { readonly requestId: string; readonly actorId: string; readonly memoryId: string }
  ): Promise<StoredWriteResult> {
    const record = await this.context.memoryRecordRepository.findByIdForUpdate(tx, command.memoryId);
    if (!record) {
      throw new RecordNotFoundError(command.memoryId);
    }

    // Freeze check
    const governance = new GovernanceRepository();
    const frozen = await governance.isScopeFrozen(tx, record.scopeType, record.scopeId, "tombstone");
    if (frozen) {
      throw new WriteError(
        WriteErrorCode.ScopeFrozen,
        `Scope ${record.scopeType}/${record.scopeId} is frozen for action tombstone`
      );
    }

    if (record.lifecycleStatus === LifecycleStatus.Tombstone) {
      throw new InvalidLifecycleTransitionError(
        WriteCommandType.TombstoneMemory,
        command.memoryId,
        record.lifecycleStatus,
        record.reviewState,
        record.isCurrent
      );
    }

    const updated = await this.context.memoryRecordRepository.updateState(tx, {
      memoryId: command.memoryId,
      lifecycleStatus: LifecycleStatus.Tombstone,
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
      eventType: OutboxEventType.MemoryTombstoned,
      actorId: command.actorId,
      payload: { ...eventPayload }
    });

    const outboxEvent = await this.context.outboxEventRepository.append(tx, {
      aggregateId: updated.id,
      requestId: command.requestId,
      eventType: OutboxEventType.MemoryTombstoned,
      payload: { ...eventPayload }
    });

    return {
      commandType: WriteCommandType.TombstoneMemory,
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

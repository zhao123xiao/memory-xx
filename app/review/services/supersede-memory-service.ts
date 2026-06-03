import { type WriteTransactionContext } from "../../db/tx/write-transaction";
import { GovernanceRepository } from "../../db/repositories/governance-repository";
import {
  LifecycleStatus,
  OutboxEventType
} from "../../shared/types";
import {
  RecordNotFoundError,
  RelationTargetNotFoundError,
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
  type SupersedeMemoryCommand,
  hashSupersedeMemoryCommand,
  normalizeSupersedeMemoryCommand,
  serializeSupersedeMemoryCommand
} from "../commands/supersede-memory-command";
import {
  createReviewLifecycleServiceContext,
  executeReviewMutation,
  type ReviewLifecycleExecutionResult,
  type ReviewLifecycleServiceDependencies
} from "./service-support";

export class SupersedeMemoryService {
  private readonly context;

  constructor(dependencies: ReviewLifecycleServiceDependencies) {
    this.context = createReviewLifecycleServiceContext(dependencies);
  }

  execute(command: SupersedeMemoryCommand): Promise<ReviewLifecycleExecutionResult> {
    const normalizedCommand = normalizeSupersedeMemoryCommand(command);
    return executeReviewMutation(this.context, {
      requestId: normalizedCommand.requestId,
      actorId: normalizedCommand.actorId,
      commandType: WriteCommandType.SupersedeMemory,
      payloadHash: hashSupersedeMemoryCommand(normalizedCommand),
      payloadJson: serializeSupersedeMemoryCommand(normalizedCommand),
      mutate: (tx) => this.supersede(tx, normalizedCommand)
    });
  }

  private async supersede(
    tx: WriteTransactionContext,
    command: ReturnType<typeof normalizeSupersedeMemoryCommand>
  ): Promise<StoredWriteResult> {
    const currentRecord = await this.context.memoryRecordRepository.findByIdForUpdate(
      tx,
      command.memoryId
    );
    if (!currentRecord) {
      throw new RecordNotFoundError(command.memoryId);
    }

    // Freeze check
    const governance = new GovernanceRepository();
    const frozen = await governance.isScopeFrozen(tx, currentRecord.scopeType, currentRecord.scopeId, "supersede");
    if (frozen) {
      throw new WriteError(
        WriteErrorCode.ScopeFrozen,
        `Scope ${currentRecord.scopeType}/${currentRecord.scopeId} is frozen for action supersede`
      );
    }

    if (!isEffectiveRecallable(currentRecord)) {
      throw new InvalidLifecycleTransitionError(
        WriteCommandType.SupersedeMemory,
        command.memoryId,
        currentRecord.lifecycleStatus,
        currentRecord.reviewState,
        currentRecord.isCurrent
      );
    }

    const supersededRecord = await this.context.memoryRecordRepository.updateState(tx, {
      memoryId: currentRecord.id,
      lifecycleStatus: LifecycleStatus.Superseded,
      reviewState: currentRecord.reviewState,
      isCurrent: false,
      actorId: command.actorId
    });

    const nextRecord = await this.context.memoryRecordRepository.createSupersedingVersion(tx, {
      previousRecord: currentRecord,
      requestId: command.requestId,
      actorId: command.actorId,
      content: command.content,
      title: command.title,
      summary: command.summary,
      metadata: command.metadata,
      dedupeKey: command.dedupeKey,
      lifecycleStatus: LifecycleStatus.Approved,
      reviewState: command.reviewState
    });

    if (command.sources.length > 0) {
      await this.context.memorySourceRepository.createMany(tx, nextRecord.id, command.sources);
    }

    if (command.relations.length > 0) {
      for (const relation of command.relations) {
        const target = await this.context.memoryRecordRepository.findById(
          tx,
          relation.relatedMemoryId
        );
        if (!target) {
          throw new RelationTargetNotFoundError(relation.relatedMemoryId);
        }
      }

      await this.context.memoryRelationRepository.createMany(tx, nextRecord.id, command.relations);
    }

    const previousEventPayload = {
      memoryId: supersededRecord.id,
      requestId: command.requestId,
      previousLifecycleStatus: currentRecord.lifecycleStatus,
      lifecycleStatus: supersededRecord.lifecycleStatus,
      previousReviewState: currentRecord.reviewState,
      reviewState: supersededRecord.reviewState,
      previousIsCurrent: currentRecord.isCurrent,
      isCurrent: supersededRecord.isCurrent,
      replacementMemoryId: nextRecord.id,
      replacementVersion: nextRecord.version
    } as const;

    await this.context.memoryEventRepository.append(tx, {
      memoryId: supersededRecord.id,
      requestId: command.requestId,
      eventType: OutboxEventType.MemoryLifecycleChanged,
      actorId: command.actorId,
      payload: { ...previousEventPayload }
    });

    await this.context.outboxEventRepository.append(tx, {
      aggregateId: supersededRecord.id,
      requestId: command.requestId,
      eventType: OutboxEventType.MemoryLifecycleChanged,
      payload: { ...previousEventPayload }
    });

    const nextEventPayload = {
      memoryId: nextRecord.id,
      requestId: command.requestId,
      supersededMemoryId: supersededRecord.id,
      lifecycleStatus: nextRecord.lifecycleStatus,
      reviewState: nextRecord.reviewState,
      isCurrent: nextRecord.isCurrent,
      version: nextRecord.version,
      sourceCount: command.sources.length,
      relationCount: command.relations.length
    } as const;

    const memoryEvent = await this.context.memoryEventRepository.append(tx, {
      memoryId: nextRecord.id,
      requestId: command.requestId,
      eventType: OutboxEventType.MemorySuperseded,
      actorId: command.actorId,
      payload: { ...nextEventPayload }
    });

    const outboxEvent = await this.context.outboxEventRepository.append(tx, {
      aggregateId: nextRecord.id,
      requestId: command.requestId,
      eventType: OutboxEventType.MemorySuperseded,
      payload: { ...nextEventPayload }
    });

    return {
      commandType: WriteCommandType.SupersedeMemory,
      memoryId: nextRecord.id,
      requestId: command.requestId,
      lifecycleStatus: nextRecord.lifecycleStatus,
      reviewState: nextRecord.reviewState,
      isCurrent: nextRecord.isCurrent,
      version: nextRecord.version,
      memoryEventType: memoryEvent.eventType,
      outboxEventType: outboxEvent.eventType,
      memoryEventId: memoryEvent.id,
      outboxEventId: outboxEvent.id,
      affectedMemoryIds: [supersededRecord.id, nextRecord.id],
      supersededMemoryId: supersededRecord.id
    };
  }
}

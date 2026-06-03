import { type WriteTransactionContext } from "../../db/tx/write-transaction";
import { GovernanceRepository } from "../../db/repositories/governance-repository";
import {
  LifecycleStatus,
  OutboxEventType,
  ReviewState
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
  type ApproveMemoryCommand,
  hashApproveMemoryCommand,
  normalizeApproveMemoryCommand,
  serializeApproveMemoryCommand
} from "../commands/approve-memory-command";
import {
  type RejectMemoryCommand,
  hashRejectMemoryCommand,
  normalizeRejectMemoryCommand,
  serializeRejectMemoryCommand
} from "../commands/reject-memory-command";
import {
  createReviewLifecycleServiceContext,
  executeReviewMutation,
  type ReviewLifecycleExecutionResult,
  type ReviewLifecycleServiceDependencies
} from "./service-support";

export class ReviewDecisionService {
  private readonly context;

  constructor(dependencies: ReviewLifecycleServiceDependencies) {
    this.context = createReviewLifecycleServiceContext(dependencies);
  }

  approve(command: ApproveMemoryCommand): Promise<ReviewLifecycleExecutionResult> {
    const normalizedCommand = normalizeApproveMemoryCommand(command);
    return executeReviewMutation(this.context, {
      requestId: normalizedCommand.requestId,
      actorId: normalizedCommand.actorId,
      commandType: WriteCommandType.ApproveMemory,
      payloadHash: hashApproveMemoryCommand(normalizedCommand),
      payloadJson: serializeApproveMemoryCommand(normalizedCommand),
      mutate: (tx) =>
        this.executeDecision(
          tx,
          normalizedCommand,
          LifecycleStatus.Approved,
          ReviewState.Approved,
          WriteCommandType.ApproveMemory
        )
    });
  }

  reject(command: RejectMemoryCommand): Promise<ReviewLifecycleExecutionResult> {
    const normalizedCommand = normalizeRejectMemoryCommand(command);
    return executeReviewMutation(this.context, {
      requestId: normalizedCommand.requestId,
      actorId: normalizedCommand.actorId,
      commandType: WriteCommandType.RejectMemory,
      payloadHash: hashRejectMemoryCommand(normalizedCommand),
      payloadJson: serializeRejectMemoryCommand(normalizedCommand),
      mutate: (tx) =>
        this.executeDecision(
          tx,
          normalizedCommand,
          LifecycleStatus.Rejected,
          ReviewState.Rejected,
          WriteCommandType.RejectMemory
        )
    });
  }

  private async executeDecision(
    tx: WriteTransactionContext,
    command: { readonly requestId: string; readonly actorId: string; readonly memoryId: string },
    nextLifecycleStatus: LifecycleStatus.Approved | LifecycleStatus.Rejected,
    nextReviewState: ReviewState.Approved | ReviewState.Rejected,
    commandType: WriteCommandType.ApproveMemory | WriteCommandType.RejectMemory
  ): Promise<StoredWriteResult> {
    const record = await this.context.memoryRecordRepository.findByIdForUpdate(tx, command.memoryId);
    if (!record) {
      throw new RecordNotFoundError(command.memoryId);
    }

    // Freeze check
    const governance = new GovernanceRepository();
    const frozen = await governance.isScopeFrozen(tx, record.scopeType, record.scopeId, commandType === WriteCommandType.ApproveMemory ? "approve" : "reject");
    if (frozen) {
      throw new WriteError(
        WriteErrorCode.ScopeFrozen,
        `Scope ${record.scopeType}/${record.scopeId} is frozen for action ${commandType === WriteCommandType.ApproveMemory ? "approve" : "reject"}`
      );
    }

    if (
      record.lifecycleStatus !== LifecycleStatus.Candidate ||
      record.reviewState !== ReviewState.Pending ||
      !record.isCurrent
    ) {
      throw new InvalidLifecycleTransitionError(
        commandType,
        command.memoryId,
        record.lifecycleStatus,
        record.reviewState,
        record.isCurrent
      );
    }

    const updated = await this.context.memoryRecordRepository.updateState(tx, {
      memoryId: command.memoryId,
      lifecycleStatus: nextLifecycleStatus,
      reviewState: nextReviewState,
      isCurrent: nextLifecycleStatus === LifecycleStatus.Approved,
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
      eventType: OutboxEventType.MemoryReviewChanged,
      actorId: command.actorId,
      payload: { ...eventPayload }
    });

    const outboxEvent = await this.context.outboxEventRepository.append(tx, {
      aggregateId: updated.id,
      requestId: command.requestId,
      eventType: OutboxEventType.MemoryReviewChanged,
      payload: { ...eventPayload }
    });

    return {
      commandType,
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

import { CacheInvalidationRequestRepository } from "../../db/repositories/cache-invalidation-request-repository";
import { MemoryEventRepository } from "../../db/repositories/memory-event-repository";
import { MemoryRecordRepository } from "../../db/repositories/memory-record-repository";
import { OutboxEventRepository } from "../../db/repositories/outbox-event-repository";
import type { MemoryEventRow, MemoryRecordRow, OutboxEventRow } from "../../db/schema/tables";
import type { WriteTransactionContext } from "../../db/tx/write-transaction";
import {
  LifecycleStatus,
  OutboxEventType,
  type JsonObject
} from "../../shared/types";

export interface LifecycleMutationServiceDependencies {
  readonly memoryRecordRepository?: MemoryRecordRepository;
  readonly memoryEventRepository?: MemoryEventRepository;
  readonly outboxEventRepository?: OutboxEventRepository;
  readonly cacheInvalidationRequestRepository?: CacheInvalidationRequestRepository;
}

export interface LifecycleMutationInput {
  readonly memoryId: string;
  readonly requestId: string;
  readonly actorId: string;
  readonly lifecycleStatus: LifecycleStatus;
  readonly isCurrent: boolean;
  readonly reason: string;
  readonly eventType?: OutboxEventType.MemoryLifecycleChanged | OutboxEventType.MemoryReviewChanged;
  readonly metadata?: JsonObject;
}

export interface LifecycleMutationResult {
  readonly previous: MemoryRecordRow;
  readonly updated: MemoryRecordRow;
  readonly memoryEvent: MemoryEventRow;
  readonly outboxEvent: OutboxEventRow;
  readonly cacheInvalidationRequestId: string;
}

export class LifecycleMutationService {
  private readonly memoryRecordRepository: MemoryRecordRepository;
  private readonly memoryEventRepository: MemoryEventRepository;
  private readonly outboxEventRepository: OutboxEventRepository;
  private readonly cacheInvalidationRequestRepository: CacheInvalidationRequestRepository;

  constructor(dependencies: LifecycleMutationServiceDependencies = {}) {
    this.memoryRecordRepository = dependencies.memoryRecordRepository ?? new MemoryRecordRepository();
    this.memoryEventRepository = dependencies.memoryEventRepository ?? new MemoryEventRepository();
    this.outboxEventRepository = dependencies.outboxEventRepository ?? new OutboxEventRepository();
    this.cacheInvalidationRequestRepository =
      dependencies.cacheInvalidationRequestRepository ?? new CacheInvalidationRequestRepository();
  }

  async mutate(tx: WriteTransactionContext, input: LifecycleMutationInput): Promise<LifecycleMutationResult> {
    const previous = await this.memoryRecordRepository.findByIdForUpdate(tx, input.memoryId);
    if (!previous) {
      throw new Error(`Memory ${input.memoryId} not found.`);
    }

    const updated = await this.memoryRecordRepository.updateState(tx, {
      memoryId: input.memoryId,
      lifecycleStatus: input.lifecycleStatus,
      reviewState: previous.reviewState,
      isCurrent: input.isCurrent,
      actorId: input.actorId
    });

    const payload = {
      memoryId: updated.id,
      requestId: input.requestId,
      reason: input.reason,
      previousLifecycleStatus: previous.lifecycleStatus,
      lifecycleStatus: updated.lifecycleStatus,
      previousReviewState: previous.reviewState,
      reviewState: updated.reviewState,
      previousIsCurrent: previous.isCurrent,
      isCurrent: updated.isCurrent,
      scope: { type: updated.scopeType, id: updated.scopeId },
      ...(input.metadata ?? {})
    } as JsonObject;

    const eventType = input.eventType ?? OutboxEventType.MemoryLifecycleChanged;
    const memoryEvent = await this.memoryEventRepository.append(tx, {
      memoryId: updated.id,
      requestId: input.requestId,
      eventType,
      actorId: input.actorId,
      payload
    });
    const outboxEvent = await this.outboxEventRepository.append(tx, {
      aggregateId: updated.id,
      requestId: input.requestId,
      eventType,
      payload
    });
    const cacheInvalidation = await this.cacheInvalidationRequestRepository.enqueue(tx, {
      scopeType: updated.scopeType,
      scopeId: updated.scopeId,
      reason: input.reason
    });

    return {
      previous,
      updated,
      memoryEvent,
      outboxEvent,
      cacheInvalidationRequestId: cacheInvalidation.id
    };
  }

  async supersedeForRepair(tx: WriteTransactionContext, input: {
    readonly memoryId: string;
    readonly requestId: string;
    readonly actorId: string;
    readonly reason: string;
    readonly keepMemoryId?: string;
  }): Promise<LifecycleMutationResult> {
    const current = await this.memoryRecordRepository.findById(tx, input.memoryId);
    const lifecycleStatus =
      current?.lifecycleStatus === LifecycleStatus.Approved
        ? LifecycleStatus.Superseded
        : current?.lifecycleStatus ?? LifecycleStatus.Superseded;
    return this.mutate(tx, {
      memoryId: input.memoryId,
      requestId: input.requestId,
      actorId: input.actorId,
      lifecycleStatus,
      isCurrent: false,
      reason: input.reason,
      metadata: {
        repairReason: input.reason,
        keepMemoryId: input.keepMemoryId ?? null
      }
    });
  }
}

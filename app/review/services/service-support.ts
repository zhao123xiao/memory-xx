import { IngestRequestRepository } from "../../db/repositories/ingest-request-repository";
import { MemoryEventRepository } from "../../db/repositories/memory-event-repository";
import { MemoryRecordRepository } from "../../db/repositories/memory-record-repository";
import { MemoryRelationRepository } from "../../db/repositories/memory-relation-repository";
import { MemorySourceRepository } from "../../db/repositories/memory-source-repository";
import { OutboxEventRepository } from "../../db/repositories/outbox-event-repository";
import {
  type WriteTransactionContext,
  type WriteTransactionRunner,
  withWriteTransaction
} from "../../db/tx/write-transaction";
import {
  type StoredWriteResult,
  type WriteCommandType
} from "../../shared/contracts/write";
import {
  WriteError,
  WriteErrorCode
} from "../../shared/errors/write-errors";
import { RequestIdempotencyService } from "../../write/services/request-idempotency-service";
import type { QdrantProjectionSyncService } from "../../qdrant-sync";
import { recordPostCommitDegraded } from "../../observability/post-commit-degraded";
import type { MemoryCacheInvalidator } from "../../cache";

export interface ReviewLifecycleServiceDependencies {
  readonly database: WriteTransactionRunner;
  readonly ingestRequestRepository?: IngestRequestRepository;
  readonly memoryRecordRepository?: MemoryRecordRepository;
  readonly memorySourceRepository?: MemorySourceRepository;
  readonly memoryRelationRepository?: MemoryRelationRepository;
  readonly memoryEventRepository?: MemoryEventRepository;
  readonly outboxEventRepository?: OutboxEventRepository;
  readonly requestIdempotencyService?: RequestIdempotencyService;
  readonly projectionSyncService?: QdrantProjectionSyncService;
  readonly cacheInvalidator?: MemoryCacheInvalidator;
}

export interface ReviewLifecycleExecutionResult extends StoredWriteResult {
  readonly replayed: boolean;
  readonly post_commit_degraded?: boolean;
  readonly projection_sync_failed?: boolean;
  readonly post_commit_errors?: readonly string[];
}

export interface ReviewLifecycleServiceContext {
  readonly database: WriteTransactionRunner;
  readonly ingestRequestRepository: IngestRequestRepository;
  readonly memoryRecordRepository: MemoryRecordRepository;
  readonly memorySourceRepository: MemorySourceRepository;
  readonly memoryRelationRepository: MemoryRelationRepository;
  readonly memoryEventRepository: MemoryEventRepository;
  readonly outboxEventRepository: OutboxEventRepository;
  readonly requestIdempotencyService: RequestIdempotencyService;
  readonly projectionSyncService?: QdrantProjectionSyncService;
  readonly cacheInvalidator?: MemoryCacheInvalidator;
}

export interface ExecuteReviewMutationInput<TResult extends StoredWriteResult> {
  readonly requestId: string;
  readonly actorId: string;
  readonly commandType: WriteCommandType;
  readonly payloadHash: string;
  readonly payloadJson: string;
  readonly mutate: (tx: WriteTransactionContext) => Promise<TResult>;
}

export function createReviewLifecycleServiceContext(
  dependencies: ReviewLifecycleServiceDependencies
): ReviewLifecycleServiceContext {
  const ingestRequestRepository =
    dependencies.ingestRequestRepository ?? new IngestRequestRepository();

  return {
    database: dependencies.database,
    ingestRequestRepository,
    memoryRecordRepository:
      dependencies.memoryRecordRepository ?? new MemoryRecordRepository(),
    memorySourceRepository:
      dependencies.memorySourceRepository ?? new MemorySourceRepository(),
    memoryRelationRepository:
      dependencies.memoryRelationRepository ?? new MemoryRelationRepository(),
    memoryEventRepository:
      dependencies.memoryEventRepository ?? new MemoryEventRepository(),
    outboxEventRepository:
      dependencies.outboxEventRepository ?? new OutboxEventRepository(),
    requestIdempotencyService:
      dependencies.requestIdempotencyService ??
      new RequestIdempotencyService(dependencies.database, ingestRequestRepository),
    projectionSyncService: dependencies.projectionSyncService,
    cacheInvalidator: dependencies.cacheInvalidator
  };
}

export async function executeReviewMutation<TResult extends StoredWriteResult>(
  context: ReviewLifecycleServiceContext,
  input: ExecuteReviewMutationInput<TResult>
): Promise<ReviewLifecycleExecutionResult> {
  const idempotency = await context.requestIdempotencyService.register<TResult>({
    requestId: input.requestId,
    commandType: input.commandType,
    payloadHash: input.payloadHash,
    payloadJson: input.payloadJson,
    actorId: input.actorId
  });

  if (idempotency.kind === "replayed") {
    return {
      ...idempotency.storedResult,
      replayed: true
    };
  }

  let storedResult: TResult;
  try {
    storedResult = await withWriteTransaction(context.database, async (tx) => {
      const result = await input.mutate(tx);
      await context.ingestRequestRepository.markCompleted(tx, input.requestId, result);
      return result;
    });
  } catch (error) {
    const writeError =
      error instanceof WriteError
        ? error
        : new WriteError(
            WriteErrorCode.TransactionConstraintViolation,
            error instanceof Error ? error.message : "Unexpected lifecycle write failure."
          );

    await context.requestIdempotencyService.markFailed(input.requestId, writeError);
    throw writeError;
  }

  const postCommitErrors: string[] = [];
  let projectionSyncFailed = false;
  let cacheInvalidationFailed = false;
  if (context.projectionSyncService) {
    try {
      await context.projectionSyncService.syncWriteResult(storedResult);
    } catch (error) {
      projectionSyncFailed = true;
      postCommitErrors.push(`projection_sync_failed:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (context.cacheInvalidator) {
    try {
      const record = await withWriteTransaction(context.database, (tx) =>
        context.memoryRecordRepository.findById(tx, storedResult.memoryId)
      );
      if (record) {
        await context.cacheInvalidator.invalidate([{ type: record.scopeType, id: record.scopeId }]);
      }
    } catch (error) {
      cacheInvalidationFailed = true;
      postCommitErrors.push(`cache_invalidation_failed:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (postCommitErrors.length > 0) {
    recordPostCommitDegraded({
      projectionSyncFailed,
      cacheInvalidationFailed,
      errors: postCommitErrors
    });
  }

  return {
    ...storedResult,
    replayed: false,
    ...(postCommitErrors.length > 0
      ? {
          post_commit_degraded: true,
          projection_sync_failed: projectionSyncFailed,
          cache_invalidation_failed: cacheInvalidationFailed,
          post_commit_errors: postCommitErrors
        }
      : {})
  };
}

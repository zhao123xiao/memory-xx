import type { MemoryCacheInvalidator } from "../../cache";
import { createHash } from "node:crypto";
import {
  IngestRequestRepository
} from "../../db/repositories/ingest-request-repository";
import { MemoryEventRepository } from "../../db/repositories/memory-event-repository";
import { MemoryRecordRepository } from "../../db/repositories/memory-record-repository";
import { MemoryRelationRepository } from "../../db/repositories/memory-relation-repository";
import { MemorySourceRepository } from "../../db/repositories/memory-source-repository";
import { OutboxEventRepository } from "../../db/repositories/outbox-event-repository";
import {
  type WriteTransactionRunner,
  isInMemoryTransactionContext,
  isPostgresTransactionContext,
  type WriteTransactionContext,
  withWriteTransaction
} from "../../db/tx/write-transaction";
import {
  LifecycleStatus,
  OutboxEventType,
  ReviewState,
  type JsonObject
} from "../../shared/types";
import {
  RecordNotFoundError,
  RelationTargetNotFoundError,
  WriteError,
  WriteErrorCode
} from "../../shared/errors/write-errors";
import {
  WriteCommandType,
  type CreateMemoryCommand,
  type NormalizedCreateMemoryCommand,
  type StoredWriteResult
} from "../../shared/contracts/write";
import type { QdrantProjectionSyncService } from "../../qdrant-sync";
import {
  hashCreateMemoryCommand,
  normalizeCreateMemoryCommand,
  serializeCreateMemoryCommand
} from "../commands/create-memory-command";
import { RequestIdempotencyService } from "./request-idempotency-service";
import { mapMemoryIdToQdrantPointId } from "../../qdrant-sync/projector";
import {
  findSameScopeSemanticDuplicate,
  findSourceAwareCurrentMatch
} from "./create-memory-duplicate-finder";
import { updateCreateMemoryCandidateInPlace } from "./create-memory-candidate-update";
import { runCreateMemoryPostCommitSideEffects } from "./create-memory-post-commit";

export interface CreateMemoryExecutionResult extends StoredWriteResult {
  readonly replayed: boolean;
  readonly post_commit_degraded?: boolean;
  readonly cache_invalidation_failed?: boolean;
  readonly projection_sync_failed?: boolean;
  readonly post_commit_errors?: readonly string[];
}

export interface CreateMemoryServiceDependencies {
  readonly database: WriteTransactionRunner;
  readonly cacheInvalidator?: MemoryCacheInvalidator;
  readonly ingestRequestRepository?: IngestRequestRepository;
  readonly memoryRecordRepository?: MemoryRecordRepository;
  readonly memorySourceRepository?: MemorySourceRepository;
  readonly memoryRelationRepository?: MemoryRelationRepository;
  readonly memoryEventRepository?: MemoryEventRepository;
  readonly outboxEventRepository?: OutboxEventRepository;
  readonly requestIdempotencyService?: RequestIdempotencyService;
  readonly projectionSyncService?: QdrantProjectionSyncService;
}

export class CreateMemoryService {
  private readonly ingestRequestRepository: IngestRequestRepository;
  private readonly memoryRecordRepository: MemoryRecordRepository;
  private readonly memorySourceRepository: MemorySourceRepository;
  private readonly memoryRelationRepository: MemoryRelationRepository;
  private readonly memoryEventRepository: MemoryEventRepository;
  private readonly outboxEventRepository: OutboxEventRepository;
  private readonly requestIdempotencyService: RequestIdempotencyService;

  constructor(private readonly dependencies: CreateMemoryServiceDependencies) {
    this.ingestRequestRepository =
      dependencies.ingestRequestRepository ?? new IngestRequestRepository();
    this.memoryRecordRepository =
      dependencies.memoryRecordRepository ?? new MemoryRecordRepository();
    this.memorySourceRepository =
      dependencies.memorySourceRepository ?? new MemorySourceRepository();
    this.memoryRelationRepository =
      dependencies.memoryRelationRepository ?? new MemoryRelationRepository();
    this.memoryEventRepository =
      dependencies.memoryEventRepository ?? new MemoryEventRepository();
    this.outboxEventRepository =
      dependencies.outboxEventRepository ?? new OutboxEventRepository();
    this.requestIdempotencyService =
      dependencies.requestIdempotencyService ??
      new RequestIdempotencyService(dependencies.database, this.ingestRequestRepository);
  }

  async execute(command: CreateMemoryCommand): Promise<CreateMemoryExecutionResult> {
    const normalizedCommand = normalizeCreateMemoryCommand(command);
    const payloadJson = serializeCreateMemoryCommand(normalizedCommand);
    const payloadHash = hashCreateMemoryCommand(normalizedCommand);
    const idempotency = await this.requestIdempotencyService.register<StoredWriteResult>({
      requestId: normalizedCommand.requestId,
      commandType: WriteCommandType.CreateMemory,
      payloadHash,
      payloadJson,
      actorId: normalizedCommand.actorId
    });

    if (idempotency.kind === "replayed") {
      return {
        ...idempotency.storedResult,
        replayed: true
      };
    }

    let result: StoredWriteResult;
    let dedupeReplay = false;
    try {
      result = await withWriteTransaction(this.dependencies.database, async (tx) => {
        let supersededMemoryIds: string[] = [];
        let effectiveCommand: NormalizedCreateMemoryCommand = normalizedCommand;
        if (normalizedCommand.dedupeKey && isPostgresTransactionContext(tx)) {
          await tx.query(
            "SELECT pg_advisory_xact_lock(hashtext($1))",
            [`${normalizedCommand.scopeType}:${normalizedCommand.scopeId}:${normalizedCommand.dedupeKey}`]
          );
        }

        const sourceAwareExisting = await findSourceAwareCurrentMatch(tx, normalizedCommand, this.memoryRecordRepository);
        if (sourceAwareExisting) {
          if (sourceAwareExisting.content === normalizedCommand.content) {
            const storedResult = await this.buildExistingDedupeResult(tx, sourceAwareExisting, normalizedCommand.requestId);
            await this.ingestRequestRepository.markCompleted(
              tx,
              normalizedCommand.requestId,
              storedResult
            );
            dedupeReplay = true;
            return storedResult;
          }
          if (
            sourceAwareExisting.lifecycleStatus === LifecycleStatus.Candidate &&
            sourceAwareExisting.reviewState === ReviewState.Pending &&
            sourceAwareExisting.isCurrent
          ) {
            const storedResult = await updateCreateMemoryCandidateInPlace(tx, sourceAwareExisting, normalizedCommand, {
              memoryRecordRepository: this.memoryRecordRepository,
              memoryEventRepository: this.memoryEventRepository,
              outboxEventRepository: this.outboxEventRepository,
            });
            await this.ingestRequestRepository.markCompleted(tx, normalizedCommand.requestId, storedResult);
            return storedResult;
          }
        } else {
          const semanticDuplicate = await findSameScopeSemanticDuplicate(tx, normalizedCommand);
          if (
            semanticDuplicate &&
            normalizedCommand.lifecycleStatus === LifecycleStatus.Approved
          ) {
            effectiveCommand = {
              ...normalizedCommand,
              lifecycleStatus: LifecycleStatus.Candidate,
              reviewState: ReviewState.Pending,
              metadata: {
                ...normalizedCommand.metadata,
                semantic_duplicate: {
                  review_reason: "same_scope_high_similarity_without_source_block",
                  existing_memory_id: semanticDuplicate.id,
                  score: semanticDuplicate.score,
                  cross_scope: false,
                  action: "candidate_review"
                } as JsonObject
              }
            };
          }
        }

        // DedupeKey/source conflict resolution: supersede existing record if one exists.
        if (effectiveCommand.dedupeKey || sourceAwareExisting) {
          const existing = sourceAwareExisting ?? await this.memoryRecordRepository.findCurrentByDedupeKey(
            tx,
            effectiveCommand.dedupeKey ?? ""
          );
          if (existing && existing.content === effectiveCommand.content) {
            const storedResult = await this.buildExistingDedupeResult(tx, existing, effectiveCommand.requestId);
            await this.ingestRequestRepository.markCompleted(
              tx,
              effectiveCommand.requestId,
              storedResult
            );
            dedupeReplay = true;
            return storedResult;
          }
          if (existing && existing.content !== effectiveCommand.content && existing.lifecycleStatus === LifecycleStatus.Approved) {
            await this.memoryRecordRepository.updateState(tx, {
              memoryId: existing.id,
              lifecycleStatus: LifecycleStatus.Superseded,
              reviewState: existing.reviewState,
              isCurrent: false,
              actorId: effectiveCommand.actorId
            });
            supersededMemoryIds = [existing.id];

            // Emit lifecycle-changed events for the superseded record
            const supersedePayload = {
              memoryId: existing.id,
              requestId: effectiveCommand.requestId,
              previousLifecycleStatus: LifecycleStatus.Approved,
              lifecycleStatus: LifecycleStatus.Superseded,
              previousReviewState: existing.reviewState,
              reviewState: existing.reviewState,
              previousIsCurrent: true,
              isCurrent: false
            } as const;
            await this.memoryEventRepository.append(tx, {
              memoryId: existing.id,
              requestId: effectiveCommand.requestId,
              eventType: OutboxEventType.MemoryLifecycleChanged,
              actorId: effectiveCommand.actorId,
              payload: { ...supersedePayload }
            });
            await this.outboxEventRepository.append(tx, {
              aggregateId: existing.id,
              requestId: effectiveCommand.requestId,
              eventType: OutboxEventType.MemoryLifecycleChanged,
              payload: { ...supersedePayload }
            });
          }
        }

        const memoryRecord = await this.memoryRecordRepository.create(tx, effectiveCommand);

        if (effectiveCommand.sources.length > 0) {
          await this.memorySourceRepository.createMany(
            tx,
            memoryRecord.id,
            effectiveCommand.sources
          );
        }

        if (effectiveCommand.relations.length > 0) {
          for (const relation of effectiveCommand.relations) {
            const target = await this.memoryRecordRepository.findById(
              tx,
              relation.relatedMemoryId
            );
            if (!target) {
              throw new RelationTargetNotFoundError(relation.relatedMemoryId);
            }
          }

          await this.memoryRelationRepository.createMany(
            tx,
            memoryRecord.id,
            effectiveCommand.relations
          );
        }

        const contentSignature = createHash("sha256")
          .update(effectiveCommand.content)
          .digest("hex");
        const eventPayload = {
          memoryId: memoryRecord.id,
          requestId: effectiveCommand.requestId,
          write_idempotency_key: effectiveCommand.requestId,
          content_signature: contentSignature,
          projection_hash: null,
          target_point_id: mapMemoryIdToQdrantPointId(memoryRecord.id),
          lifecycleStatus: memoryRecord.lifecycleStatus,
          reviewState: memoryRecord.reviewState,
          sourceCount: effectiveCommand.sources.length,
          relationCount: effectiveCommand.relations.length
        } as const;

        const memoryEvent = await this.memoryEventRepository.append(tx, {
          memoryId: memoryRecord.id,
          requestId: effectiveCommand.requestId,
          eventType: OutboxEventType.MemoryCreated,
          actorId: effectiveCommand.actorId,
          payload: { ...eventPayload }
        });

        const outboxEvent = await this.outboxEventRepository.append(tx, {
          aggregateId: memoryRecord.id,
          requestId: effectiveCommand.requestId,
          eventType: OutboxEventType.MemoryCreated,
          payload: { ...eventPayload }
        });

        const storedResult: StoredWriteResult = {
          commandType: WriteCommandType.CreateMemory,
          memoryId: memoryRecord.id,
          requestId: effectiveCommand.requestId,
          lifecycleStatus: memoryRecord.lifecycleStatus,
          reviewState: memoryRecord.reviewState,
          isCurrent: true,
          version: memoryRecord.version,
          memoryEventType: memoryEvent.eventType,
          outboxEventType: outboxEvent.eventType,
          memoryEventId: memoryEvent.id,
          outboxEventId: outboxEvent.id,
          ...(supersededMemoryIds.length > 0
            ? { affectedMemoryIds: [...supersededMemoryIds, memoryRecord.id], supersededMemoryId: supersededMemoryIds[0] }
            : {})
        };

        await this.ingestRequestRepository.markCompleted(
          tx,
          effectiveCommand.requestId,
          storedResult
        );
        return storedResult;
      });
    } catch (error) {
      const writeError =
        error instanceof WriteError
          ? error
          : new WriteError(
              WriteErrorCode.TransactionConstraintViolation,
              error instanceof Error ? error.message : "Unexpected write-chain failure."
            );

      await this.requestIdempotencyService.markFailed(normalizedCommand.requestId, writeError);
      throw writeError;
    }

    const postCommit = await runCreateMemoryPostCommitSideEffects(normalizedCommand, result, this.dependencies);

    return {
      ...result,
      replayed: dedupeReplay,
      ...postCommit
    };
  }

  async getRecordOrThrow(memoryId: string) {
    return withWriteTransaction(this.dependencies.database, async (tx) => {
      const repo = new MemoryRecordRepository();
      const row = await repo.findById(tx, memoryId);
      if (!row) {
        throw new RecordNotFoundError(memoryId);
      }
      return row;
    });
  }

  private async buildExistingDedupeResult(
    tx: WriteTransactionContext,
    existing: {
      readonly id: string;
      readonly lifecycleStatus: LifecycleStatus;
      readonly reviewState: StoredWriteResult["reviewState"];
      readonly isCurrent: boolean;
      readonly version: number;
    },
    requestId: string
  ): Promise<StoredWriteResult> {
    const eventIds = await this.findExistingProjectionEventIds(tx, existing.id);
    return {
      commandType: WriteCommandType.CreateMemory,
      memoryId: existing.id,
      requestId,
      lifecycleStatus: existing.lifecycleStatus,
      reviewState: existing.reviewState,
      isCurrent: existing.isCurrent,
      version: existing.version,
      memoryEventType: OutboxEventType.MemoryCreated,
      outboxEventType: OutboxEventType.MemoryCreated,
      memoryEventId: eventIds.memoryEventId,
      outboxEventId: eventIds.outboxEventId,
    };
  }

  private async findExistingProjectionEventIds(
    tx: WriteTransactionContext,
    memoryId: string
  ): Promise<{ memoryEventId: string; outboxEventId: string }> {
    if (isInMemoryTransactionContext(tx)) {
      const memoryEvent = [...tx.state.memoryEvents].reverse().find((row) => row.memoryId === memoryId);
      const outboxEvent = [...tx.state.outboxEvents].reverse().find((row) => row.aggregateId === memoryId);
      return {
        memoryEventId: memoryEvent?.id ?? "",
        outboxEventId: outboxEvent?.id ?? "",
      };
    }

    const [memoryEvent] = await tx.query(
      `SELECT id FROM memory_events WHERE memory_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [memoryId]
    );
    const [outboxEvent] = await tx.query(
      `SELECT id FROM outbox_events WHERE aggregate_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [memoryId]
    );
    return {
      memoryEventId: typeof memoryEvent?.id === "string" ? memoryEvent.id : "",
      outboxEventId: typeof outboxEvent?.id === "string" ? outboxEvent.id : "",
    };
  }

}

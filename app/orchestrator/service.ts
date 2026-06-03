import type { WriteTransactionRunner } from "../db/tx/write-transaction";
import { isInMemoryTransactionContext } from "../db/tx/write-transaction";
import { MemoryEventRepository } from "../db/repositories/memory-event-repository";
import { OutboxEventRepository } from "../db/repositories/outbox-event-repository";
import { LifecycleMutationService } from "../review/services/lifecycle-mutation-service";
import type { RecallOrchestrator } from "../recall/orchestrator";
import type { MemoryCacheInvalidator } from "../cache";
import {
  ScopeType,
  OutboxEventType
} from "../shared";
import type { CreateMemoryService } from "../write/services/create-memory-service";
import type { ArchiveMemoryService } from "../review/services/archive-memory-service";
import type { TombstoneMemoryService } from "../review/services/tombstone-memory-service";
import type {
  AuditMemoryConsistencyRequest,
  AuditMemoryConsistencyResponse,
  ForgetMemoryRequest,
  ForgetMemoryResponse,
  MemoryOrchestratorHandlers,
  RecallMemoryRequest,
  RecallMemoryResponse,
  RepairMemoryConsistencyRequest,
  RepairMemoryConsistencyResponse,
  ResolveScopePlanRequest,
  ResolveScopePlanResponse,
  SummarizeMemoryRequest,
  SummarizeMemoryResponse,
  WriteMemoryRequest,
  WriteMemoryResponse,
} from "./types";
import {
  getDuplicateCurrentRepairPriority,
  hasEffectiveRecallableLifecycle,
  hasOutboxForCompletedRequest
} from "./consistency";
import { resolveOrchestratorScopePlan } from "./scope-plan";
import { summarizeRecallResults } from "./summary";
import { readMemoryCounts } from "./memory-counts";
import {
  approveMemoryFromMcp,
  listPendingMemories,
  readMemoryById,
  rejectMemoryFromMcp
} from "./mcp-review-access";

export interface MemoryOrchestratorServiceDependencies {
  readonly recallOrchestrator: RecallOrchestrator;
  readonly createMemoryService: CreateMemoryService;
  readonly archiveMemoryService: ArchiveMemoryService;
  readonly tombstoneMemoryService: TombstoneMemoryService;
  readonly database: WriteTransactionRunner;
  readonly cacheInvalidator?: MemoryCacheInvalidator;
  readonly now?: () => string;
}

export class MemoryOrchestratorService implements MemoryOrchestratorHandlers {
  private readonly now: () => string;

  constructor(private readonly dependencies: MemoryOrchestratorServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async resolve_scope_plan(input: ResolveScopePlanRequest): Promise<ResolveScopePlanResponse> {
    return resolveOrchestratorScopePlan(input);
  }

  async write_memory(input: WriteMemoryRequest): Promise<WriteMemoryResponse> {
    const result = await this.dependencies.createMemoryService.execute(input.command);
    await this.invalidateScopeCache(input.command.scopeType, input.command.scopeId);
    return { write: result };
  }

  async recall_memory(input: RecallMemoryRequest): Promise<RecallMemoryResponse> {
    return {
      recall: await this.dependencies.recallOrchestrator.execute(input.request),
    };
  }

  async summarize_memory(input: SummarizeMemoryRequest): Promise<SummarizeMemoryResponse> {
    const recall = await this.dependencies.recallOrchestrator.execute(input.request);
    return {
      summary: summarizeRecallResults(recall, input.max_items ?? 3),
      recall,
    };
  }

  async memory_counts(input = {}) {
    return readMemoryCounts(this.dependencies.database, this.now, input);
  }

  async forget_memory(input: ForgetMemoryRequest): Promise<ForgetMemoryResponse> {
    const mode = input.mode ?? "tombstone";
    const write =
      mode === "archive"
        ? await this.dependencies.archiveMemoryService.execute({
            requestId: input.requestId,
            actorId: input.actorId,
            memoryId: input.memoryId,
          })
        : await this.dependencies.tombstoneMemoryService.execute({
            requestId: input.requestId,
            actorId: input.actorId,
            memoryId: input.memoryId,
          });
    const snapshot = await this.dependencies.database.snapshotForMemoryIds([input.memoryId]);
    const record = snapshot.memoryRecords.find((r) => r.id === input.memoryId);
    if (record) {
      await this.invalidateScopeCache(record.scopeType, record.scopeId);
    }
    return { write, mode };
  }

  private async invalidateScopeCache(scopeType: string, scopeId: string): Promise<void> {
    if (!this.dependencies.cacheInvalidator) {
      return;
    }
    try {
      await this.dependencies.cacheInvalidator.invalidate([{ type: scopeType as ScopeType, id: scopeId }]);
    } catch {
      // Cache invalidation failure must not break write operations
    }
  }

  async audit_memory_consistency(
    input: AuditMemoryConsistencyRequest = {},
  ): Promise<AuditMemoryConsistencyResponse> {
    const snapshot = await this.dependencies.database.snapshot();
    const findings: Array<AuditMemoryConsistencyResponse["findings"][number]> = [];

    for (const row of snapshot.memoryRecords) {
      if (hasEffectiveRecallableLifecycle(row.lifecycleStatus) && !row.isCurrent) {
        findings.push({
          code: "non_current_approved_record",
          severity: "warn",
          memoryId: row.id,
          details: "approved record should normally remain current unless superseded or tombstoned",
        });
      }
      if (!snapshot.memoryEvents.some((event) => event.memoryId === row.id)) {
        findings.push({
          code: "missing_event_for_memory",
          severity: "warn",
          memoryId: row.id,
          details: "memory record has no corresponding memory_event",
        });
      }
    }

    const currentByScopeAndContent = new Map<string, string[]>();
    for (const row of snapshot.memoryRecords.filter((candidate) => candidate.isCurrent)) {
      const key = `${row.scopeType}:${row.scopeId}:${row.content}`;
      const list = currentByScopeAndContent.get(key) ?? [];
      list.push(row.id);
      currentByScopeAndContent.set(key, list);
    }
    for (const [scopeContentKey, memoryIds] of currentByScopeAndContent.entries()) {
      if (memoryIds.length > 1) {
        const scopeKey = scopeContentKey.replace(/:[^:]*$/, "");
        findings.push({
          code: "multiple_current_records_per_scope",
          severity: "warn",
          scopeKey,
          details: `scope has ${memoryIds.length} current records with identical content: ${memoryIds.join(", ")}`,
        });
      }
    }

    for (const request of snapshot.ingestRequests.filter((candidate) => candidate.status === "completed")) {
      if (!hasOutboxForCompletedRequest(request, snapshot)) {
        findings.push({
          code: "missing_outbox_for_request",
          severity: "warn",
          requestId: request.requestId,
          details: "completed ingest request has no outbox event by request_id or result_json.outboxEventId",
        });
      }
    }

    return {
      ok: findings.length === 0,
      checked_at: this.now(),
      counts: {
        memory_records: snapshot.memoryRecords.length,
        memory_events: snapshot.memoryEvents.length,
        outbox_events: snapshot.outboxEvents.length,
        ingest_requests: snapshot.ingestRequests.length,
      },
      findings,
      ...(input.include_records ? { snapshot } : {}),
    };
  }

  async repair_memory_consistency(
    input: RepairMemoryConsistencyRequest = {},
  ): Promise<RepairMemoryConsistencyResponse> {
    const snapshot = await this.dependencies.database.snapshot();
    const dryRun = input.dry_run ?? true;
    const repairs: Array<RepairMemoryConsistencyResponse["repairs"][number]> = [];
    const memoryEventRepository = new MemoryEventRepository();
    const outboxEventRepository = new OutboxEventRepository();

    for (const row of snapshot.memoryRecords) {
      if (hasEffectiveRecallableLifecycle(row.lifecycleStatus) && !row.isCurrent) {
        repairs.push({
          code: "non_current_approved_record",
          memoryId: row.id,
          action: "manual_review_required",
          details: "approved non-current records may be valid historical versions; repair no longer reactivates them automatically",
        });
      }

      if (!snapshot.memoryEvents.some((event) => event.memoryId === row.id)) {
        const repairRequestId = row.requestId;
        repairs.push({
          code: "missing_event_for_memory",
          memoryId: row.id,
          requestId: repairRequestId,
          action: dryRun ? "would_append_migration_shadow_loaded_event" : "append_migration_shadow_loaded_event",
          details: "append synthetic lifecycle event for record missing memory_event",
        });

        if (!snapshot.outboxEvents.some((event) => event.requestId === repairRequestId)) {
          repairs.push({
            code: "missing_outbox_for_request",
            memoryId: row.id,
            requestId: repairRequestId,
            action: dryRun ? "would_append_migration_shadow_loaded_outbox" : "append_migration_shadow_loaded_outbox",
            details: "append synthetic outbox event paired with repair lifecycle event",
          });
        }
      }
    }

      const duplicateCurrentGroups = new Map<string, typeof snapshot.memoryRecords>();
    for (const row of snapshot.memoryRecords.filter((candidate) => candidate.isCurrent)) {
      const key = `${row.scopeType}:${row.scopeId}:${row.content}`;
      const list = duplicateCurrentGroups.get(key) ?? [];
      list.push(row);
      duplicateCurrentGroups.set(key, list);
    }

    const duplicateCurrentKeepers = new Map<string, string>();
    for (const rows of duplicateCurrentGroups.values()) {
      if (rows.length <= 1) {
        continue;
      }

      const ordered = [...rows].sort((left, right) => {
        const priorityDiff = getDuplicateCurrentRepairPriority(right) - getDuplicateCurrentRepairPriority(left);
        if (priorityDiff !== 0) {
          return priorityDiff;
        }
        const createdAtDiff = right.createdAt.localeCompare(left.createdAt);
        if (createdAtDiff !== 0) {
          return createdAtDiff;
        }
        return right.id.localeCompare(left.id);
      });
      const keeper = ordered[0];
      for (const row of ordered.slice(1)) {
        duplicateCurrentKeepers.set(row.id, keeper.id);
        repairs.push({
          code: "multiple_current_records_per_scope",
          memoryId: row.id,
          requestId: row.requestId,
          action: dryRun ? "would_set_is_current_false" : "set_is_current_false",
          details: `duplicate current record in scope/content group; keep ${keeper.id} as current`,
        });
      }
    }

    if (!dryRun && repairs.length > 0) {
      const missingEventIds = new Set(
        repairs
          .filter((repair) => repair.code === "missing_event_for_memory")
          .map((repair) => repair.memoryId)
          .filter(Boolean) as string[]
      );
      const duplicateCurrentRepairIds = new Set(
        repairs
          .filter((repair) => repair.code === "multiple_current_records_per_scope")
          .map((repair) => repair.memoryId)
          .filter(Boolean) as string[]
      );
      const lifecycleMutationService = new LifecycleMutationService({
        memoryEventRepository,
        outboxEventRepository
      });

      await this.dependencies.database.withTransaction(async (tx) => {
        for (const id of duplicateCurrentRepairIds) {
          const repairedRow = snapshot.memoryRecords.find((candidate) => candidate.id === id);
          if (repairedRow) {
            await lifecycleMutationService.supersedeForRepair(tx, {
              memoryId: id,
              requestId: repairedRow.requestId,
              actorId: repairedRow.updatedBy || repairedRow.createdBy || "system:repair_memory_consistency",
              reason: "multiple_current_records_per_scope",
              keepMemoryId: duplicateCurrentKeepers.get(id)
            });
          }
        }

        for (const row of snapshot.memoryRecords.filter((candidate) => missingEventIds.has(candidate.id))) {
          const repairRequestId = row.requestId;
          const payload = {
            memoryId: row.id,
            requestId: repairRequestId,
            sourceRequestId: row.requestId,
            sourceLifecycleStatus: row.lifecycleStatus,
            sourceReviewState: row.reviewState,
            repairReason: "missing_event_for_memory",
          } as const;

          const eventExists = isInMemoryTransactionContext(tx)
            ? tx.state.memoryEvents.some((event) => event.memoryId === row.id)
            : Boolean((await tx.query(
                `SELECT 1 FROM memory_events WHERE memory_id = $1 LIMIT 1`,
                [row.id]
              ))[0]);

          if (!eventExists) {
            await memoryEventRepository.append(tx, {
              memoryId: row.id,
              requestId: repairRequestId,
              eventType: OutboxEventType.MigrationShadowLoaded,
              actorId: row.updatedBy || row.createdBy || "system:repair_memory_consistency",
              payload: { ...payload },
            });
          }

          const outboxExists = isInMemoryTransactionContext(tx)
            ? tx.state.outboxEvents.some((event) => event.requestId === repairRequestId)
            : Boolean((await tx.query(
                `SELECT 1 FROM outbox_events WHERE request_id = $1 LIMIT 1`,
                [repairRequestId]
              ))[0]);

          if (!outboxExists) {
            await outboxEventRepository.append(tx, {
              aggregateId: row.id,
              requestId: repairRequestId,
              eventType: OutboxEventType.MigrationShadowLoaded,
              payload: { ...payload },
            });
          }
        }
      });
    }

    return {
      repaired_at: this.now(),
      dry_run: dryRun,
      repairs,
      counts: {
        memory_records: snapshot.memoryRecords.length,
        memory_events: snapshot.memoryEvents.length,
        outbox_events: snapshot.outboxEvents.length,
        ingest_requests: snapshot.ingestRequests.length,
      },
    };
  }

  async list_pending_memories(input: import("./types").ListPendingMemoriesRequest): Promise<import("./types").ListPendingMemoriesResponse> {
    return listPendingMemories(this.dependencies.database, input);
  }

  async mcp_approve_memory(input: import("./types").McpApproveMemoryRequest): Promise<import("./types").McpReviewMemoryResponse> {
    return approveMemoryFromMcp(
      this.dependencies.database,
      input,
      (scopeType, scopeId) => this.invalidateScopeCache(scopeType, scopeId)
    );
  }

  async mcp_reject_memory(input: import("./types").McpRejectMemoryRequest): Promise<import("./types").McpReviewMemoryResponse> {
    return rejectMemoryFromMcp(
      this.dependencies.database,
      input,
      (scopeType, scopeId) => this.invalidateScopeCache(scopeType, scopeId)
    );
  }

  async read_memory(input: import("./types").ReadMemoryRequest): Promise<import("./types").ReadMemoryResponse> {
    return readMemoryById(this.dependencies.database, input);
  }
}
export function createMemoryOrchestratorService(
  dependencies: MemoryOrchestratorServiceDependencies,
): MemoryOrchestratorService {
  return new MemoryOrchestratorService(dependencies);
}

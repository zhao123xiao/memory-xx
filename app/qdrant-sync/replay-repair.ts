import type { OutboxEventRow } from "../db/schema/tables";
import { OutboxDispatchStatus } from "../shared/contracts/write";
import type { QdrantProjectionSyncResult } from "./projector";

export interface QdrantReplayRepairRepository {
  loadOutboxEventById(eventId: string): Promise<OutboxEventRow | null>;
  listOutboxEvents(input?: {
    readonly statuses?: readonly OutboxDispatchStatus[];
    readonly limit?: number;
  }): Promise<readonly OutboxEventRow[]>;
}

export class SnapshotQdrantReplayRepairRepository implements QdrantReplayRepairRepository {
  constructor(
    private readonly database: {
      snapshot(): Promise<{
        outboxEvents: OutboxEventRow[];
      }>;
    }
  ) {}

  async loadOutboxEventById(eventId: string): Promise<OutboxEventRow | null> {
    const snapshot = await this.database.snapshot();
    return snapshot.outboxEvents.find((row) => row.id === eventId) ?? null;
  }

  async listOutboxEvents(input: {
    readonly statuses?: readonly OutboxDispatchStatus[];
    readonly limit?: number;
  } = {}): Promise<readonly OutboxEventRow[]> {
    const snapshot = await this.database.snapshot();
    const statuses = input.statuses?.length ? new Set(input.statuses) : null;
    const rows = snapshot.outboxEvents
      .filter((row) => (statuses ? statuses.has(row.dispatchStatus) : true))
      .sort(compareOutboxEvents);

    return typeof input.limit === "number" ? rows.slice(0, input.limit) : rows;
  }
}

export interface ReplayQdrantOutboxEventOptions {
  readonly eventId: string;
  readonly markDispatched?: boolean;
  readonly now?: string;
}

export interface ReplayQdrantOutboxEventResult {
  readonly mode: "event_id";
  readonly eventId: string;
  readonly exporterName: string;
  readonly mutatedOutboxState: boolean;
  readonly memoryIds: readonly string[];
  readonly eventStatusBefore: OutboxDispatchStatus;
  readonly attemptsBefore: number;
  readonly alreadyBehindCursor: boolean;
  readonly syncResult: QdrantProjectionSyncResult;
}

export interface ReplayQdrantExporterEventsOptions {
  readonly statuses?: readonly OutboxDispatchStatus[];
  readonly limit?: number;
  readonly markDispatched?: boolean;
  readonly now?: string;
}

export interface ReplayQdrantExporterEventsResultItem {
  readonly eventId: string;
  readonly memoryIds: readonly string[];
  readonly eventStatusBefore: OutboxDispatchStatus;
  readonly attemptsBefore: number;
  readonly alreadyBehindCursor: boolean;
  readonly mutatedOutboxState: boolean;
  readonly syncResult: QdrantProjectionSyncResult;
}

export interface ReplayQdrantExporterEventsResult {
  readonly mode: "exporter_status";
  readonly exporterName: string;
  readonly statuses: readonly OutboxDispatchStatus[];
  readonly limit: number | null;
  readonly mutatedOutboxState: boolean;
  readonly totalMatched: number;
  readonly processedCount: number;
  readonly items: readonly ReplayQdrantExporterEventsResultItem[];
}

export interface ReplayQdrantOutboxEventDependencies {
  readonly projectionSyncService: {
    syncMemoryIds(memoryIds: readonly string[]): Promise<QdrantProjectionSyncResult>;
  };
  readonly replayRepository: QdrantReplayRepairRepository;
  readonly outboxRepository?: {
    loadCursor(exporterName?: string): Promise<{
      lastSuccessfulEventId: string | null;
    }>;
    markDispatched(input: {
      exporterName?: string;
      eventId: string;
      now?: string;
    }): Promise<void>;
  };
  readonly exporterName?: string;
  readonly clock?: () => string;
}

const DEFAULT_EXPORTER_NAME = "qdrant_projector";

export class ReplayQdrantOutboxEventService {
  private readonly exporterName: string;
  private readonly clock: () => string;

  constructor(private readonly deps: ReplayQdrantOutboxEventDependencies) {
    this.exporterName = deps.exporterName ?? DEFAULT_EXPORTER_NAME;
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  async execute(input: ReplayQdrantOutboxEventOptions): Promise<ReplayQdrantOutboxEventResult> {
    const event = await this.deps.replayRepository.loadOutboxEventById(input.eventId);
    if (!event) {
      throw new Error(`Qdrant replay event not found: ${input.eventId}`);
    }

    const cursor = await this.deps.outboxRepository?.loadCursor(this.exporterName);
    const memoryIds = deriveAffectedMemoryIds(event);
    const syncResult = await this.deps.projectionSyncService.syncMemoryIds(memoryIds);

    const alreadyBehindCursor = Boolean(
      cursor?.lastSuccessfulEventId && cursor.lastSuccessfulEventId !== event.id
    );

    if (input.markDispatched) {
      if (!this.deps.outboxRepository) {
        throw new Error("Qdrant replay（向量库重放）缺少 outbox repository（投影事件仓库），不能标记为已分发。");
      }
      await this.deps.outboxRepository.markDispatched({
        exporterName: this.exporterName,
        eventId: event.id,
        now: input.now ?? this.clock()
      });
    }

    return {
      mode: "event_id",
      eventId: event.id,
      exporterName: this.exporterName,
      mutatedOutboxState: Boolean(input.markDispatched),
      memoryIds,
      eventStatusBefore: event.dispatchStatus,
      attemptsBefore: event.attempts,
      alreadyBehindCursor,
      syncResult
    };
  }
}

export class ReplayQdrantExporterEventsService {
  private readonly exporterName: string;
  private readonly clock: () => string;

  constructor(private readonly deps: ReplayQdrantOutboxEventDependencies) {
    this.exporterName = deps.exporterName ?? DEFAULT_EXPORTER_NAME;
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  async execute(input: ReplayQdrantExporterEventsOptions = {}): Promise<ReplayQdrantExporterEventsResult> {
    const statuses = input.statuses?.length
      ? [...input.statuses]
      : [OutboxDispatchStatus.Pending, OutboxDispatchStatus.Failed];
    const rows = await this.deps.replayRepository.listOutboxEvents({
      statuses,
      limit: input.limit
    });
    const cursor = await this.deps.outboxRepository?.loadCursor(this.exporterName);
    const items: ReplayQdrantExporterEventsResultItem[] = [];

    for (const event of rows) {
      const memoryIds = deriveAffectedMemoryIds(event);
      const syncResult = await this.deps.projectionSyncService.syncMemoryIds(memoryIds);
      const alreadyBehindCursor = Boolean(
        cursor?.lastSuccessfulEventId && cursor.lastSuccessfulEventId !== event.id
      );

      if (input.markDispatched) {
        if (!this.deps.outboxRepository) {
          throw new Error("Qdrant exporter replay cannot mark dispatched without an outbox repository.");
        }
        await this.deps.outboxRepository.markDispatched({
          exporterName: this.exporterName,
          eventId: event.id,
          now: input.now ?? this.clock()
        });
      }

      items.push({
        eventId: event.id,
        memoryIds,
        eventStatusBefore: event.dispatchStatus,
        attemptsBefore: event.attempts,
        alreadyBehindCursor,
        mutatedOutboxState: Boolean(input.markDispatched),
        syncResult
      });
    }

    return {
      mode: "exporter_status",
      exporterName: this.exporterName,
      statuses,
      limit: input.limit ?? null,
      mutatedOutboxState: Boolean(input.markDispatched),
      totalMatched: rows.length,
      processedCount: items.length,
      items
    };
  }
}

function deriveAffectedMemoryIds(event: Pick<OutboxEventRow, "aggregateId" | "payload">): readonly string[] {
  const memoryIds = new Set<string>();
  memoryIds.add(event.aggregateId);

  const payloadMemoryId = readString(event.payload.memoryId);
  if (payloadMemoryId) {
    memoryIds.add(payloadMemoryId);
  }

  const replacementMemoryId = readString(event.payload.replacementMemoryId);
  if (replacementMemoryId) {
    memoryIds.add(replacementMemoryId);
  }

  const supersededMemoryId = readString(event.payload.supersededMemoryId);
  if (supersededMemoryId) {
    memoryIds.add(supersededMemoryId);
  }

  return [...memoryIds];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export interface RepairByMemoryIdOptions {
  readonly memoryIds: readonly string[];
}

export interface RepairByMemoryIdResultItem {
  readonly memoryId: string;
  readonly operation: "upsert" | "delete" | "skip";
  readonly reason:
    | "effective_recallable"
    | "record_missing"
    | "not_effective_recallable"
    | "tombstone"
    | "superseded"
    | "embedding_missing"
    | "projection_idempotent"
    | "projection_verify_failed";
}

export interface RepairByMemoryIdResult {
  readonly mode: "memory_id";
  readonly memoryIds: readonly string[];
  readonly mutatedOutboxState: false;
  readonly items: readonly RepairByMemoryIdResultItem[];
}

export interface RepairByMemoryIdDependencies {
  readonly projectionSyncService: {
    syncMemoryIds(memoryIds: readonly string[]): Promise<QdrantProjectionSyncResult>;
  };
}

export class RepairByMemoryIdService {
  constructor(private readonly deps: RepairByMemoryIdDependencies) {}

  async execute(input: RepairByMemoryIdOptions): Promise<RepairByMemoryIdResult> {
    if (input.memoryIds.length === 0) {
      throw new Error("按 memory_id（记忆 ID）修复时至少需要一个 memory_id。");
    }

    const syncResult = await this.deps.projectionSyncService.syncMemoryIds(input.memoryIds);

    return {
      mode: "memory_id",
      memoryIds: [...input.memoryIds],
      mutatedOutboxState: false,
      items: syncResult.items
    };
  }
}

function compareOutboxEvents(
  left: Pick<OutboxEventRow, "createdAt" | "id">,
  right: Pick<OutboxEventRow, "createdAt" | "id">
): number {
  const createdAtCompare = left.createdAt.localeCompare(right.createdAt);
  if (createdAtCompare !== 0) {
    return createdAtCompare;
  }
  return left.id.localeCompare(right.id);
}

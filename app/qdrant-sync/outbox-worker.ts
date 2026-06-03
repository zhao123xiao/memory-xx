import type { OutboxEventRow } from "../db/schema/tables";
import {
  type WriteTransactionContext,
  type WriteTransactionRunner,
  isInMemoryTransactionContext,
  withWriteTransaction
} from "../db/tx/write-transaction";
import type { QueryResultRow } from "pg";
import { OutboxDispatchStatus } from "../shared/contracts/write";
import type { OutboxEventType } from "../shared/types";
import type { QdrantProjectionSyncResult } from "./projector";
import { readNullablePgBoolean, readPgBoolean } from "../db/row-value-readers";

const DEFAULT_EXPORTER_NAME = "qdrant_projector";
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 5_000;

export interface QdrantSyncOutboxEvent {
  readonly id: string;
  readonly aggregateId: string;
  readonly requestId: string;
  readonly eventType: OutboxEventType;
  readonly payload: OutboxEventRow["payload"];
  readonly payloadVersion: number;
  readonly attempts: number;
  readonly createdAt: string;
  readonly dispatchedAt: string | null;
  readonly dispatchedBy?: string | null;
  readonly dispatchStartedAt?: string | null;
  readonly projectionVerified?: boolean | null;
  readonly dispatchMetadata?: OutboxEventRow["dispatchMetadata"];
}

export interface QdrantSyncCursorState {
  readonly exporterName: string;
  readonly lastSuccessfulEventId: string | null;
  readonly cursor: string | null;
  readonly lastSuccessAt: string | null;
  readonly failureSummary: string | null;
  readonly isRebuilding: boolean;
  readonly updatedAt: string | null;
}

export interface QdrantSyncOutboxRepository {
  loadCursor(exporterName?: string): Promise<QdrantSyncCursorState>;
  listProcessableEvents(input?: {
    readonly exporterName?: string;
    readonly limit?: number;
    readonly maxAttempts?: number;
  }): Promise<readonly QdrantSyncOutboxEvent[]>;
  claimProcessableEvents(input: {
    readonly exporterName?: string;
    readonly limit?: number;
    readonly maxAttempts?: number;
    readonly workerId: string;
    readonly now?: string;
  }): Promise<readonly QdrantSyncOutboxEvent[]>;
  claimDispatch(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly now?: string;
  }): Promise<boolean>;
  markDispatched(input: {
    readonly exporterName?: string;
    readonly eventId: string;
    readonly now?: string;
    readonly workerId?: string;
    readonly projectionVerified?: boolean;
    readonly dispatchMetadata?: OutboxEventRow["dispatchMetadata"];
  }): Promise<void>;
  markRetry(input: {
    readonly exporterName?: string;
    readonly eventId: string;
    readonly failureMessage: string;
    readonly now?: string;
  }): Promise<void>;
  markDeadLetter(input: {
    readonly exporterName?: string;
    readonly eventId: string;
    readonly failureMessage: string;
    readonly now?: string;
  }): Promise<void>;
}

export class DatabaseQdrantSyncOutboxRepository implements QdrantSyncOutboxRepository {
  constructor(
    private readonly database: WriteTransactionRunner,
    private readonly clock: () => string = () => new Date().toISOString()
  ) {}

  async loadCursor(exporterName = DEFAULT_EXPORTER_NAME): Promise<QdrantSyncCursorState> {
    return withWriteTransaction(this.database, async (tx) => {
      const cursor = await this.getCursorState(tx, exporterName, this.clock());
      return {
        exporterName,
        lastSuccessfulEventId: cursor.lastSuccessfulEventId,
        cursor: cursor.cursor,
        lastSuccessAt: cursor.lastSuccessAt,
        failureSummary: cursor.failureSummary,
        isRebuilding: cursor.isRebuilding,
        updatedAt: cursor.updatedAt
      };
    });
  }

  async listProcessableEvents(input: {
    readonly exporterName?: string;
    readonly limit?: number;
    readonly maxAttempts?: number;
  } = {}): Promise<readonly QdrantSyncOutboxEvent[]> {
    const limit = input.limit ?? DEFAULT_BATCH_SIZE;
    const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const exporterName = input.exporterName ?? DEFAULT_EXPORTER_NAME;

    return withWriteTransaction(this.database, async (tx) => {
      const cursor = await this.getCursorState(tx, exporterName, this.clock());
      const lastSuccessfulEvent = cursor.lastSuccessfulEventId
        ? await this.findOutboxEventById(tx, cursor.lastSuccessfulEventId)
        : null;

      if (isInMemoryTransactionContext(tx)) {
        return tx.state.outboxEvents
          .filter((row) => this.isProcessable(row, lastSuccessfulEvent, maxAttempts))
          .sort(compareOutboxEvents)
          .slice(0, limit)
          .map((row) => ({ ...row }));
      }

      let rows: readonly QueryResultRow[];
      if (cursor.cursor) {
        rows = await tx.query<QueryResultRow>(
          `SELECT * FROM outbox_events
           WHERE dispatch_status != $1
             AND attempts < $2
             AND (created_at, id) > ((SELECT created_at FROM outbox_events WHERE id = $3), $3)
           ORDER BY created_at ASC, id ASC
           LIMIT $4`,
          [OutboxDispatchStatus.Dispatched, maxAttempts, cursor.lastSuccessfulEventId, limit]
        );
      } else {
        rows = await tx.query<QueryResultRow>(
          `SELECT * FROM outbox_events
           WHERE dispatch_status != $1
             AND attempts < $2
           ORDER BY created_at ASC, id ASC
           LIMIT $3`,
          [OutboxDispatchStatus.Dispatched, maxAttempts, limit]
        );
      }

      return rows.map((row) => this.mapOutboxEventRow(row));
    });
  }

  async claimProcessableEvents(input: {
    readonly exporterName?: string;
    readonly limit?: number;
    readonly maxAttempts?: number;
    readonly workerId: string;
    readonly now?: string;
  }): Promise<readonly QdrantSyncOutboxEvent[]> {
    const limit = input.limit ?? DEFAULT_BATCH_SIZE;
    const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const exporterName = input.exporterName ?? DEFAULT_EXPORTER_NAME;
    const now = input.now ?? this.clock();

    return withWriteTransaction(this.database, async (tx) => {
      const cursor = await this.getCursorState(tx, exporterName, now);
      const lastSuccessfulEvent = cursor.lastSuccessfulEventId
        ? await this.findOutboxEventById(tx, cursor.lastSuccessfulEventId)
        : null;

      if (isInMemoryTransactionContext(tx)) {
        const claimed: QdrantSyncOutboxEvent[] = [];
        const candidates = tx.state.outboxEvents
          .filter((row) => this.isProcessable(row, lastSuccessfulEvent, maxAttempts))
          .filter((row) => !row.dispatchStartedAt || row.dispatchStatus === OutboxDispatchStatus.Failed)
          .sort(compareOutboxEvents)
          .slice(0, limit);

        for (const event of candidates) {
          const index = tx.state.outboxEvents.findIndex((row) => row.id === event.id);
          if (index < 0) continue;
          tx.state.outboxEvents[index] = {
            ...event,
            dispatchedBy: input.workerId,
            dispatchStartedAt: now,
            projectionVerified: false,
            dispatchMetadata: {
              ...(event.dispatchMetadata ?? {}),
              dispatch_claimed_at: now,
              dispatch_claim_mode: "atomic_batch",
            },
          };
          claimed.push({ ...tx.state.outboxEvents[index] });
        }
        return claimed;
      }

      const metadata = JSON.stringify({
        dispatch_claimed_at: now,
        dispatch_claim_mode: "atomic_batch",
      });
      const rows = cursor.lastSuccessfulEventId
        ? await tx.query<QueryResultRow>(
            `
              WITH candidates AS (
                SELECT id
                FROM outbox_events
                WHERE dispatch_status != $1
                  AND attempts < $2
                  AND (dispatch_started_at IS NULL OR dispatch_status = $3)
                  AND (created_at, id) > ((SELECT created_at FROM outbox_events WHERE id = $4), $4)
                ORDER BY created_at ASC, id ASC
                LIMIT $5
                FOR UPDATE SKIP LOCKED
              )
              UPDATE outbox_events AS event
              SET dispatched_by = $6,
                  dispatch_started_at = $7::timestamptz,
                  projection_verified = FALSE,
                  dispatch_metadata = COALESCE(event.dispatch_metadata, '{}'::jsonb) || $8::jsonb
              FROM candidates
              WHERE event.id = candidates.id
              RETURNING event.*
            `,
            [
              OutboxDispatchStatus.Dispatched,
              maxAttempts,
              OutboxDispatchStatus.Failed,
              cursor.lastSuccessfulEventId,
              limit,
              input.workerId,
              now,
              metadata,
            ]
          )
        : await tx.query<QueryResultRow>(
            `
              WITH candidates AS (
                SELECT id
                FROM outbox_events
                WHERE dispatch_status != $1
                  AND attempts < $2
                  AND (dispatch_started_at IS NULL OR dispatch_status = $3)
                ORDER BY created_at ASC, id ASC
                LIMIT $4
                FOR UPDATE SKIP LOCKED
              )
              UPDATE outbox_events AS event
              SET dispatched_by = $5,
                  dispatch_started_at = $6::timestamptz,
                  projection_verified = FALSE,
                  dispatch_metadata = COALESCE(event.dispatch_metadata, '{}'::jsonb) || $7::jsonb
              FROM candidates
              WHERE event.id = candidates.id
              RETURNING event.*
            `,
            [
              OutboxDispatchStatus.Dispatched,
              maxAttempts,
              OutboxDispatchStatus.Failed,
              limit,
              input.workerId,
              now,
              metadata,
            ]
          );

      return rows.map((row) => this.mapOutboxEventRow(row));
    });
  }

  private async findOutboxEventById(
    tx: WriteTransactionContext,
    eventId: string
  ): Promise<Pick<OutboxEventRow, "createdAt" | "id"> | null> {
    if (isInMemoryTransactionContext(tx)) {
      return tx.state.outboxEvents.find((item) => item.id === eventId) ?? null;
    }
    const [row] = await tx.query(`SELECT id, created_at FROM outbox_events WHERE id = $1 LIMIT 1`, [eventId]);
    if (!row) return null;
    return { id: String(row.id), createdAt: new Date(String(row.created_at)).toISOString() };
  }

  private mapOutboxEventRow(row: QueryResultRow): QdrantSyncOutboxEvent {
      return {
        id: String(row.id),
        aggregateId: String(row.aggregate_id),
        requestId: String(row.request_id),
        eventType: String(row.event_type) as OutboxEventType,
        payload: (row.payload as OutboxEventRow["payload"]) ?? {},
        payloadVersion: Number(row.payload_version),
        attempts: Number(row.attempts),
        createdAt: new Date(String(row.created_at)).toISOString(),
        dispatchedAt: row.dispatched_at ? new Date(String(row.dispatched_at)).toISOString() : null,
        dispatchedBy: row.dispatched_by ? String(row.dispatched_by) : null,
        dispatchStartedAt: row.dispatch_started_at ? new Date(String(row.dispatch_started_at)).toISOString() : null,
        projectionVerified: readNullablePgBoolean(row.projection_verified, "outbox_events.projection_verified"),
        dispatchMetadata: row.dispatch_metadata && typeof row.dispatch_metadata === "object" ? row.dispatch_metadata as OutboxEventRow["dispatchMetadata"] : {}
      };
  }

  async claimDispatch(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly now?: string;
  }): Promise<boolean> {
    const now = input.now ?? this.clock();
    return withWriteTransaction(this.database, async (tx) => {
      if (isInMemoryTransactionContext(tx)) {
        const index = tx.state.outboxEvents.findIndex((row) => row.id === input.eventId);
        if (index < 0) return false;
        const event = tx.state.outboxEvents[index];
        if (event.dispatchStatus === OutboxDispatchStatus.Dispatched) return false;
        if (event.dispatchStartedAt && event.dispatchStatus !== OutboxDispatchStatus.Failed) return false;
        tx.state.outboxEvents[index] = {
          ...event,
          dispatchedBy: input.workerId,
          dispatchStartedAt: now,
          projectionVerified: false,
          dispatchMetadata: {
            ...(event.dispatchMetadata ?? {}),
            dispatch_claimed_at: now,
          },
        };
        return true;
      }

      const rows = await tx.query(
        `
          UPDATE outbox_events
          SET dispatched_by = $2,
              dispatch_started_at = $3::timestamptz,
              projection_verified = FALSE,
              dispatch_metadata = COALESCE(dispatch_metadata, '{}'::jsonb) || $4::jsonb
          WHERE id = $1
            AND dispatch_status != $5
            AND (dispatch_started_at IS NULL OR dispatch_status = $6)
          RETURNING id
        `,
        [
          input.eventId,
          input.workerId,
          now,
          JSON.stringify({ dispatch_claimed_at: now }),
          OutboxDispatchStatus.Dispatched,
          OutboxDispatchStatus.Failed,
        ]
      );
      return rows.length > 0;
    });
  }

  async markDispatched(input: {
    readonly exporterName?: string;
    readonly eventId: string;
    readonly now?: string;
    readonly workerId?: string;
    readonly projectionVerified?: boolean;
    readonly dispatchMetadata?: OutboxEventRow["dispatchMetadata"];
  }): Promise<void> {
    const now = input.now ?? this.clock();
    await withWriteTransaction(this.database, async (tx) => {
      const event = await this.getOutboxEventOrThrow(tx, input.eventId);
      await this.persistOutboxEvent(tx, {
        ...event,
        dispatchStatus: OutboxDispatchStatus.Dispatched,
        attempts: event.attempts + 1,
        dispatchedAt: now,
        dispatchedBy: input.workerId ?? input.exporterName ?? DEFAULT_EXPORTER_NAME,
        dispatchStartedAt: event.dispatchStartedAt ?? now,
        projectionVerified: input.projectionVerified ?? event.projectionVerified ?? null,
        dispatchMetadata: {
          ...(event.dispatchMetadata ?? {}),
          ...(input.dispatchMetadata ?? {})
        }
      });
      await this.persistCursor(tx, input.exporterName ?? DEFAULT_EXPORTER_NAME, {
        lastSuccessfulEventId: event.id,
        cursor: event.id,
        lastSuccessAt: now,
        failureSummary: null
      });
    });
  }

  async markRetry(input: {
    readonly exporterName?: string;
    readonly eventId: string;
    readonly failureMessage: string;
    readonly now?: string;
  }): Promise<void> {
    const now = input.now ?? this.clock();
    await withWriteTransaction(this.database, async (tx) => {
      const event = await this.getOutboxEventOrThrow(tx, input.eventId);
      await this.persistOutboxEvent(tx, {
        ...event,
        dispatchStatus: OutboxDispatchStatus.Failed,
        attempts: event.attempts + 1,
        dispatchedAt: event.dispatchedAt,
        dispatchedBy: null,
        dispatchStartedAt: null,
        projectionVerified: false
      });
      await this.persistCursor(tx, input.exporterName ?? DEFAULT_EXPORTER_NAME, {
        failureSummary: input.failureMessage,
        updatedAt: now
      });
    });
  }

  async markDeadLetter(input: {
    readonly exporterName?: string;
    readonly eventId: string;
    readonly failureMessage: string;
    readonly now?: string;
  }): Promise<void> {
    const now = input.now ?? this.clock();
    await withWriteTransaction(this.database, async (tx) => {
      const event = await this.getOutboxEventOrThrow(tx, input.eventId);
      await this.persistOutboxEvent(tx, {
        ...event,
        dispatchStatus: OutboxDispatchStatus.Failed,
        attempts: event.attempts + 1,
        dispatchedAt: event.dispatchedAt,
        dispatchedBy: null,
        dispatchStartedAt: null,
        projectionVerified: false
      });
      await this.persistCursor(tx, input.exporterName ?? DEFAULT_EXPORTER_NAME, {
        failureSummary: `dead-letter:${input.failureMessage}`,
        updatedAt: now
      });
    });
  }

  private isProcessable(
    row: OutboxEventRow,
    lastSuccessfulEvent: Pick<OutboxEventRow, "createdAt" | "id"> | null,
    maxAttempts: number
  ): boolean {
    if (row.dispatchStatus === OutboxDispatchStatus.Dispatched) {
      return false;
    }
    if (row.attempts >= maxAttempts) {
      return false;
    }
    if (lastSuccessfulEvent === null) {
      return true;
    }
    return compareOutboxEvents(row, lastSuccessfulEvent) > 0;
  }

  private async getOutboxEventOrThrow(
    tx: WriteTransactionContext,
    eventId: string
  ): Promise<OutboxEventRow> {
    if (isInMemoryTransactionContext(tx)) {
      const row = tx.state.outboxEvents.find((item) => item.id === eventId);
      if (!row) {
        throw new Error(`Qdrant sync outbox event not found: ${eventId}`);
      }
      return row;
    }

    const [row] = await tx.query(`SELECT * FROM outbox_events WHERE id = $1 LIMIT 1`, [eventId]);
    if (!row) {
      throw new Error(`Qdrant sync outbox event not found: ${eventId}`);
    }

    return {
      id: String(row.id),
      aggregateId: String(row.aggregate_id),
      requestId: String(row.request_id),
      eventType: String(row.event_type) as OutboxEventType,
      payload: (row.payload as OutboxEventRow["payload"]) ?? {},
      payloadVersion: Number(row.payload_version),
      dispatchStatus: String(row.dispatch_status) as OutboxDispatchStatus,
        attempts: Number(row.attempts),
        createdAt: new Date(String(row.created_at)).toISOString(),
        dispatchedAt: row.dispatched_at ? new Date(String(row.dispatched_at)).toISOString() : null,
        dispatchedBy: row.dispatched_by ? String(row.dispatched_by) : null,
        dispatchStartedAt: row.dispatch_started_at ? new Date(String(row.dispatch_started_at)).toISOString() : null,
        projectionVerified: readNullablePgBoolean(row.projection_verified, "outbox_events.projection_verified"),
        dispatchMetadata: row.dispatch_metadata && typeof row.dispatch_metadata === "object" ? row.dispatch_metadata as OutboxEventRow["dispatchMetadata"] : {}
      };
  }

  private async persistOutboxEvent(tx: WriteTransactionContext, row: OutboxEventRow): Promise<void> {
    if (isInMemoryTransactionContext(tx)) {
      const index = tx.state.outboxEvents.findIndex((item) => item.id === row.id);
      tx.state.outboxEvents[index] = row;
      return;
    }

    await tx.query(
      `
        UPDATE outbox_events
        SET dispatch_status = $2,
            attempts = $3,
            dispatched_at = $4::timestamptz,
            dispatched_by = $5,
            dispatch_started_at = $6::timestamptz,
            projection_verified = $7,
            dispatch_metadata = $8::jsonb
        WHERE id = $1
      `,
      [
        row.id,
        row.dispatchStatus,
        row.attempts,
        row.dispatchedAt,
        row.dispatchedBy ?? null,
        row.dispatchStartedAt ?? null,
        row.projectionVerified ?? null,
        JSON.stringify(row.dispatchMetadata ?? {})
      ]
    );
  }

  private async persistCursor(
    tx: WriteTransactionContext,
    exporterName: string,
    updates: Partial<{
      lastSuccessfulEventId: string | null;
      cursor: string | null;
      lastSuccessAt: string | null;
      failureSummary: string | null;
      isRebuilding: boolean;
      updatedAt: string;
    }>
  ): Promise<void> {
    const now = updates.updatedAt ?? this.clock();
    const current = await this.getCursorState(tx, exporterName, now);
    const next = {
      ...current,
      ...updates,
      updatedAt: now
    };
    if (isInMemoryTransactionContext(tx)) {
      const index = tx.state.exporterState.findIndex((item) => item.exporterName === exporterName);
      if (index >= 0) {
        tx.state.exporterState[index] = next;
      } else {
        tx.state.exporterState.push(next);
      }
      return;
    }

    await tx.query(
      `
        INSERT INTO exporter_state (
          exporter_name,
          last_successful_event_id,
          cursor,
          last_success_at,
          failure_summary,
          is_rebuilding,
          updated_at
        )
        VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7::timestamptz)
        ON CONFLICT (exporter_name)
        DO UPDATE SET
          last_successful_event_id = EXCLUDED.last_successful_event_id,
          cursor = EXCLUDED.cursor,
          last_success_at = EXCLUDED.last_success_at,
          failure_summary = EXCLUDED.failure_summary,
          is_rebuilding = EXCLUDED.is_rebuilding,
          updated_at = EXCLUDED.updated_at
      `,
      [
        exporterName,
        next.lastSuccessfulEventId,
        next.cursor,
        next.lastSuccessAt,
        next.failureSummary,
        next.isRebuilding,
        now
      ]
    );
  }

  private async getCursorState(
    tx: WriteTransactionContext,
    exporterName: string,
    now: string
  ): Promise<{
    exporterName: string;
    lastSuccessfulEventId: string | null;
    cursor: string | null;
    lastSuccessAt: string | null;
    failureSummary: string | null;
    isRebuilding: boolean;
    updatedAt: string;
  }> {
    if (isInMemoryTransactionContext(tx)) {
      return (
        tx.state.exporterState.find((item) => item.exporterName === exporterName) ?? {
          exporterName,
          lastSuccessfulEventId: null,
          cursor: null,
          lastSuccessAt: null,
          failureSummary: null,
          isRebuilding: false,
          updatedAt: now
        }
      );
    }

    const [row] = await tx.query(`SELECT * FROM exporter_state WHERE exporter_name = $1 LIMIT 1`, [
      exporterName
    ]);
    if (!row) {
      return {
        exporterName,
        lastSuccessfulEventId: null,
        cursor: null,
        lastSuccessAt: null,
        failureSummary: null,
        isRebuilding: false,
        updatedAt: now
      };
    }

    return {
      exporterName,
      lastSuccessfulEventId: row.last_successful_event_id ? String(row.last_successful_event_id) : null,
      cursor: row.cursor ? String(row.cursor) : null,
      lastSuccessAt: row.last_success_at ? new Date(String(row.last_success_at)).toISOString() : null,
      failureSummary: row.failure_summary ? String(row.failure_summary) : null,
        isRebuilding: readPgBoolean(row.is_rebuilding, "exporter_state.is_rebuilding"),
      updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : now
    };
  }
}

export interface QdrantProjectorWorkerDependencies {
  readonly projectionSyncService: {
    syncMemoryIds(memoryIds: readonly string[]): Promise<QdrantProjectionSyncResult>;
  };
  readonly outboxRepository: QdrantSyncOutboxRepository;
  readonly exporterName?: string;
  readonly maxAttempts?: number;
  readonly batchSize?: number;
  readonly retryDelayMs?: number;
  readonly clock?: () => string;
}

export interface QdrantProjectorWorkerResult {
  readonly status: "idle" | "synced" | "retried" | "dead_letter";
  readonly eventId?: string;
  readonly memoryIds: readonly string[];
  readonly attempts?: number;
  readonly cursor?: QdrantSyncCursorState;
  readonly syncResult?: QdrantProjectionSyncResult;
  readonly retryAfterMs?: number;
  readonly error?: string;
}

export class QdrantProjectorWorker {
  private readonly exporterName: string;
  private readonly maxAttempts: number;
  private readonly batchSize: number;
  private readonly retryDelayMs: number;
  private readonly clock: () => string;

  constructor(private readonly deps: QdrantProjectorWorkerDependencies) {
    this.exporterName = deps.exporterName ?? DEFAULT_EXPORTER_NAME;
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
    this.retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  async drainOnce(): Promise<QdrantProjectorWorkerResult> {
    const [event] = await this.deps.outboxRepository.claimProcessableEvents({
      exporterName: this.exporterName,
      limit: 1,
      maxAttempts: this.maxAttempts,
      workerId: this.exporterName,
      now: this.clock()
    });

    if (!event) {
      return {
        status: "idle",
        memoryIds: [],
        cursor: await this.deps.outboxRepository.loadCursor(this.exporterName)
      };
    }

    const memoryIds = deriveAffectedMemoryIds(event);
    try {
      const syncResult = await this.deps.projectionSyncService.syncMemoryIds(memoryIds);
      const hasFailedSkips = syncResult.items.some(
        (item) =>
          item.operation === "skip" &&
          (item.reason === "embedding_missing" || item.reason === "projection_verify_failed")
      );
      if (hasFailedSkips) {
        const failedReasons = syncResult.items
          .filter(
            (item) =>
              item.operation === "skip" &&
              (item.reason === "embedding_missing" || item.reason === "projection_verify_failed")
          )
          .map((item) => `${item.memoryId}:${item.reason}`)
          .join(",");
        throw new Error(`qdrant_projection_incomplete:${failedReasons}`);
      }

      await this.deps.outboxRepository.markDispatched({
        exporterName: this.exporterName,
        eventId: event.id,
        now: this.clock(),
        workerId: this.exporterName,
        projectionVerified: true,
        dispatchMetadata: {
          memoryIds: [...memoryIds],
          itemCount: syncResult.items.length,
          hasFailedSkips
        }
      });
      return {
        status: "synced",
        eventId: event.id,
        memoryIds,
        attempts: event.attempts + 1,
        syncResult,
        cursor: await this.deps.outboxRepository.loadCursor(this.exporterName)
      };
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : String(error);
      const nextAttempts = event.attempts + 1;
      if (nextAttempts >= this.maxAttempts) {
        await this.deps.outboxRepository.markDeadLetter({
          exporterName: this.exporterName,
          eventId: event.id,
          failureMessage,
          now: this.clock()
        });
        return {
          status: "dead_letter",
          eventId: event.id,
          memoryIds,
          attempts: nextAttempts,
          error: failureMessage,
          cursor: await this.deps.outboxRepository.loadCursor(this.exporterName)
        };
      }

      const backoffDelay = Math.min(this.retryDelayMs * Math.pow(2, event.attempts), 60_000);
      await this.deps.outboxRepository.markRetry({
        exporterName: this.exporterName,
        eventId: event.id,
        failureMessage,
        now: this.clock()
      });
      return {
        status: "retried",
        eventId: event.id,
        memoryIds,
        attempts: nextAttempts,
        retryAfterMs: backoffDelay,
        error: failureMessage,
        cursor: await this.deps.outboxRepository.loadCursor(this.exporterName)
      };
    }
  }

  async drainUntilIdle(limit = this.batchSize): Promise<readonly QdrantProjectorWorkerResult[]> {
    const results: QdrantProjectorWorkerResult[] = [];
    for (let index = 0; index < limit; index += 1) {
      const outcome = await this.drainOnce();
      results.push(outcome);
      if (outcome.status === "idle" || outcome.status === "retried" || outcome.status === "dead_letter") {
        break;
      }
    }
    return results;
  }
}

function deriveAffectedMemoryIds(event: QdrantSyncOutboxEvent): readonly string[] {
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

function compareOutboxEvents(left: Pick<OutboxEventRow, "createdAt" | "id">, right: Pick<OutboxEventRow, "createdAt" | "id">): number {
  const createdAtCompare = left.createdAt.localeCompare(right.createdAt);
  if (createdAtCompare !== 0) {
    return createdAtCompare;
  }
  return left.id.localeCompare(right.id);
}

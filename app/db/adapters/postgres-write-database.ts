import { randomUUID } from "node:crypto";

import { Pool, type PoolClient, type QueryResultRow } from "pg";

import type { SequenceName, WriteDatabaseState } from "../schema/tables";
import { createEmptyWriteDatabaseState } from "../schema/tables";
import {
  mapExporterStateRow,
  mapIngestRequestRow,
  mapIntelligenceCompareObservationRow,
  mapKnowledgeScopeGrantRow,
  mapLowConfidenceBufferRow,
  mapMemoryEventRow,
  mapMemoryFeedbackEventRow,
  mapMemoryRecordRow,
  mapMemoryRelationRow,
  mapMemorySourceRow,
  mapMigrationAuditRow,
  mapOutboxEventRow,
  mapCacheInvalidationRequestRow,
  mapRecallFeedbackEventRow,
  mapRecallRepairQueueRow,
  mapRecallTraceRow,
  mapScopeGenerationStateRow,
  mapTrustedAgentRow,
  mapWriteTicketRow
} from "./postgres-row-mappers";
import {
  type MemoryXXPostgresConfig,
  createPostgresPoolConfig
} from "./postgres-config";
import {
  TransactionConstraintViolationError
} from "../../shared/errors/write-errors";
import {
  type PostgresWriteTransactionContext,
  type WriteTransactionRunner
} from "../tx/write-transaction";

export interface PostgresWriteDatabaseOptions {
  readonly config: MemoryXXPostgresConfig;
  readonly pool?: Pool;
  readonly clock?: () => string;
  readonly idFactory?: (sequenceName: SequenceName) => string;
}

class PgWriteTransactionContext implements PostgresWriteTransactionContext {
  readonly backend = "postgres" as const;

  constructor(
    private readonly client: PoolClient,
    private readonly clock: () => string,
    private readonly idFactory: (sequenceName: SequenceName) => string
  ) {}

  now(): string {
    return this.clock();
  }

  nextId(sequenceName: SequenceName): string {
    return this.idFactory(sequenceName);
  }

  async query<TResult extends QueryResultRow>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<readonly TResult[]> {
    const result = await this.client.query<TResult>(sql, [...params]);
    return result.rows;
  }
}

export class PostgresWriteDatabase implements WriteTransactionRunner {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly clock: () => string;
  private readonly idFactory: (sequenceName: SequenceName) => string;

  constructor(private readonly options: PostgresWriteDatabaseOptions) {
    this.pool = options.pool ?? new Pool(createPostgresPoolConfig(options.config));
    this.ownsPool = !options.pool;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? defaultIdFactory;
  }

  async withTransaction<TResult>(
    work: (tx: PostgresWriteTransactionContext) => TResult | Promise<TResult>
  ): Promise<TResult> {
    const client = await this.pool.connect();

    try {
      await ensureSchema(client, this.options.config.schema);
      await client.query("BEGIN");
      await setSearchPath(client, this.options.config.schema);

      const tx = new PgWriteTransactionContext(client, this.clock, this.idFactory);
      const result = await work(tx);

      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async snapshot(): Promise<WriteDatabaseState> {
    const client = await this.pool.connect();

    try {
      await ensureSchema(client, this.options.config.schema);
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await setSearchPath(client, this.options.config.schema);

      const ingestRequests = await client.query(
        "SELECT * FROM ingest_requests ORDER BY first_seen_at ASC"
      );
      const memoryRecords = await client.query(
        "SELECT * FROM memory_records ORDER BY created_at ASC"
      );
      const memorySources = await client.query(
        "SELECT * FROM memory_sources ORDER BY created_at ASC"
      );
      const memoryRelations = await client.query(
        "SELECT * FROM memory_relations ORDER BY created_at ASC"
      );
      const memoryEvents = await client.query(
        "SELECT * FROM memory_events ORDER BY created_at ASC"
      );
      const outboxEvents = await client.query(
        "SELECT * FROM outbox_events ORDER BY created_at ASC"
      );
      const migrationAudit = await client.query(
        "SELECT * FROM migration_audit ORDER BY created_at ASC"
      );
      const exporterState = await client.query(
        "SELECT * FROM exporter_state ORDER BY exporter_name ASC"
      );

      const snapshot = {
        ingestRequests: ingestRequests.rows.map(mapIngestRequestRow),
        memoryRecords: memoryRecords.rows.map(mapMemoryRecordRow),
        memorySources: memorySources.rows.map(mapMemorySourceRow),
        memoryRelations: memoryRelations.rows.map(mapMemoryRelationRow),
        memoryEvents: memoryEvents.rows.map(mapMemoryEventRow),
        outboxEvents: outboxEvents.rows.map(mapOutboxEventRow),
        migrationAudit: migrationAudit.rows.map(mapMigrationAuditRow),
        exporterState: exporterState.rows.map(mapExporterStateRow),
        lowConfidenceBuffer: (await client.query("SELECT * FROM low_confidence_buffer ORDER BY created_at ASC")).rows.map(mapLowConfidenceBufferRow),
        writeTickets: (await client.query("SELECT * FROM write_tickets ORDER BY created_at ASC")).rows.map(mapWriteTicketRow),
        writeTicketsArchive: (await client.query("SELECT * FROM write_tickets_archive ORDER BY created_at ASC")).rows.map(mapWriteTicketRow),
        memoryFeedbackEvents: (await client.query("SELECT * FROM memory_feedback_events ORDER BY created_at ASC")).rows.map(mapMemoryFeedbackEventRow),
        recallTraces: (await client.query("SELECT * FROM recall_traces ORDER BY created_at ASC")).rows.map(mapRecallTraceRow),
        recallFeedbackEvents: (await client.query("SELECT * FROM recall_feedback_events ORDER BY created_at ASC")).rows.map(mapRecallFeedbackEventRow),
        recallRepairQueue: (await client.query("SELECT * FROM recall_repair_queue ORDER BY created_at ASC")).rows.map(mapRecallRepairQueueRow),
        cacheInvalidationRequests: (await client.query("SELECT * FROM cache_invalidation_requests ORDER BY created_at ASC")).rows.map(mapCacheInvalidationRequestRow),
        knowledgeScopeGrants: (await client.query("SELECT * FROM knowledge_scope_grants ORDER BY created_at ASC")).rows.map(mapKnowledgeScopeGrantRow),
        intelligenceCompareObservations: (await client.query("SELECT * FROM intelligence_compare_observations ORDER BY observed_at ASC")).rows.map(mapIntelligenceCompareObservationRow),
        scopeGenerations: (await client.query("SELECT * FROM scope_generations ORDER BY bumped_at ASC")).rows.map(mapScopeGenerationStateRow),
        trustedAgents: (await client.query("SELECT * FROM trusted_agents ORDER BY created_at ASC")).rows.map(mapTrustedAgentRow),
        sequences: {
          memory_record: 0,
          memory_source: 0,
          memory_relation: 0,
          memory_event: 0,
          outbox_event: 0,
          migration_audit: 0,
          low_confidence_buffer: 0,
          write_ticket: 0,
          memory_feedback_event: 0,
          recall_trace: 0,
          recall_feedback_event: 0,
          recall_repair_queue: 0,
          cache_invalidation_request: 0,
          knowledge_scope_grant: 0,
          intelligence_compare_observation: 0
        }
      };
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async snapshotForMemoryIds(memoryIds: readonly string[]): Promise<WriteDatabaseState> {
    if (memoryIds.length === 0) {
      return createEmptyWriteDatabaseState();
    }

    const client = await this.pool.connect();
    try {
      await ensureSchema(client, this.options.config.schema);
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await setSearchPath(client, this.options.config.schema);

      const idParams = memoryIds.map((_, i) => `$${i + 1}`).join(", ");

      const memoryRecords = await client.query(`SELECT * FROM memory_records WHERE id IN (${idParams})`, [...memoryIds]);
      const memorySources = await client.query(`SELECT * FROM memory_sources WHERE memory_id IN (${idParams})`, [...memoryIds]);
      const memoryRelations = await client.query(`SELECT * FROM memory_relations WHERE memory_id IN (${idParams})`, [...memoryIds]);
      const reverseRelations = await client.query(`SELECT * FROM memory_relations WHERE related_memory_id IN (${idParams})`, [...memoryIds]);

      const allRelations = [...memoryRelations.rows, ...reverseRelations.rows];

      const snapshot = {
        memoryRecords: memoryRecords.rows.map(mapMemoryRecordRow),
        memorySources: memorySources.rows.map(mapMemorySourceRow),
        memoryRelations: allRelations.map(mapMemoryRelationRow),
        memoryEvents: [],
        ingestRequests: [],
        outboxEvents: [],
        migrationAudit: [],
        exporterState: [],
        lowConfidenceBuffer: [],
        writeTickets: [],
        writeTicketsArchive: [],
        memoryFeedbackEvents: [],
        recallTraces: [],
        recallFeedbackEvents: [],
        recallRepairQueue: [],
        cacheInvalidationRequests: [],
        knowledgeScopeGrants: [],
        intelligenceCompareObservations: [],
        scopeGenerations: [],
        trustedAgents: [],
        sequences: {
          memory_record: 0,
          memory_source: 0,
          memory_relation: 0,
          memory_event: 0,
          outbox_event: 0,
          migration_audit: 0,
          low_confidence_buffer: 0,
          write_ticket: 0,
          memory_feedback_event: 0,
          recall_trace: 0,
          recall_feedback_event: 0,
          recall_repair_queue: 0,
          cache_invalidation_request: 0,
          knowledge_scope_grant: 0,
          intelligence_compare_observation: 0
        }
      };
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}

export async function ensureSchema(client: PoolClient, schema: string): Promise<void> {
  if (schema === "public") {
    return;
  }

  await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
}

export async function setSearchPath(client: PoolClient, schema: string): Promise<void> {
  await client.query(`SET search_path TO ${quoteIdentifier(schema)}, public`);
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function defaultIdFactory(sequenceName: SequenceName): string {
  return `${sequenceName}_${randomUUID()}`;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Ignore rollback failures after the primary error.
  }
}

function normalizePostgresError(error: unknown): Error {
  if (error instanceof Error && "code" in error) {
    const code = typeof error.code === "string" ? error.code : undefined;
    const detail =
      "detail" in error && typeof error.detail === "string" ? error.detail : undefined;
    const constraint =
      "constraint" in error && typeof error.constraint === "string"
        ? error.constraint
        : undefined;

    return new TransactionConstraintViolationError(error.message, {
      code,
      detail,
      constraint
    });
  }

  if (error instanceof Error) {
    return error;
  }

  return new TransactionConstraintViolationError("Unexpected PostgreSQL transaction failure.");
}

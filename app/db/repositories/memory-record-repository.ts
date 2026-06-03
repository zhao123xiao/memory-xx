import {
  type WriteTransactionContext,
  isInMemoryTransactionContext
} from "../tx/write-transaction";
import type { MemoryRecordRow } from "../schema/tables";
import {
  LifecycleStatus,
  ReviewState,
  type JsonObject
} from "../../shared/types";
import type { NormalizedCreateMemoryCommand } from "../../shared/contracts/write";
import { mapMemoryRecordRow } from "../adapters/postgres-row-mappers";

function activeEmbeddingGeneration(): string | null {
  return process.env.MEMORY_V2_EMBEDDING_GENERATION_ID?.trim() || null;
}

export interface UpdateMemoryRecordStateInput {
  readonly memoryId: string;
  readonly lifecycleStatus: LifecycleStatus;
  readonly reviewState: ReviewState;
  readonly isCurrent: boolean;
  readonly actorId: string;
}

export interface CreateSupersedingMemoryRecordInput {
  readonly previousRecord: MemoryRecordRow;
  readonly requestId: string;
  readonly actorId: string;
  readonly content: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly metadata: JsonObject;
  readonly dedupeKey: string | null;
  readonly lifecycleStatus: LifecycleStatus;
  readonly reviewState: ReviewState;
}

export interface UpdateCandidateMemoryRecordInput {
  readonly memoryId: string;
  readonly actorId: string;
  readonly content: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly metadata: JsonObject;
  readonly dedupeKey: string | null;
  readonly memoryType: string | null;
  readonly contentEmbedding?: readonly number[] | null;
}

export interface ListSmartWriteCandidatesInput {
  readonly scopeType: string;
  readonly scopeId: string;
  readonly memoryType?: string | null;
  readonly dedupeKey?: string | null;
  readonly topic?: string | null;
  readonly recentCandidateSince?: string | null;
  readonly limit?: number;
}

export class MemoryRecordRepository {
  async create(
    tx: WriteTransactionContext,
    command: NormalizedCreateMemoryCommand
  ): Promise<MemoryRecordRow> {
    if (isInMemoryTransactionContext(tx)) {
      const timestamp = tx.now();
      const row: MemoryRecordRow = {
        id: tx.nextId("memory_record"),
        requestId: command.requestId,
        scopeType: command.scopeType,
        scopeId: command.scopeId,
        content: command.content,
        title: command.title,
        summary: command.summary,
        metadata: command.metadata,
        dedupeKey: command.dedupeKey,
        lifecycleStatus: command.lifecycleStatus,
        reviewState: command.reviewState,
        isCurrent: true,
        version: 1,
        createdBy: command.actorId,
        updatedBy: command.actorId,
        createdAt: timestamp,
        updatedAt: timestamp,
        tenantId: command.tenantId,
        agentId: command.agentId,
        governanceStatus: command.governanceStatus,
        visibility: command.visibility,
        memoryType: command.memoryType,
        embeddingGeneration: activeEmbeddingGeneration(),
        contentEmbedding: command.contentEmbedding,
        memoryLayer: "recall",
        factStatus: "current",
        validAt: command.validAt ?? command.observedAt ?? timestamp,
        invalidAt: null,
        observedAt: command.observedAt ?? timestamp,
        expiresAt: command.expiresAt,
        episodeId: null,
        importance: 0.5,
        memoryStrength: 1.0,
        decayPolicy: "importance_weighted"
      };
      tx.state.memoryRecords.push(row);
      return row;
    }

    const timestamp = tx.now();
    const [row] = await tx.query(
      `
        INSERT INTO memory_records (
          id,
          request_id,
          scope_type,
          scope_id,
          content,
          title,
          summary,
          metadata,
          dedupe_key,
          lifecycle_status,
          review_state,
          is_current,
          version,
          created_by,
          updated_by,
          created_at,
          updated_at,
          tenant_id,
          agent_id,
          governance_status,
          visibility,
          memory_type,
          embedding_generation,
          content_embedding,
          valid_at,
          observed_at,
          expires_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, TRUE, 1, $12, $13, $14::timestamptz, $15::timestamptz, $16, $17, $18, $19, $20, $21, $22, $23::timestamptz, $24::timestamptz, $25::timestamptz
        )
        RETURNING *
      `,
      [
        tx.nextId("memory_record"),
        command.requestId,
        command.scopeType,
        command.scopeId,
        command.content,
        command.title,
        command.summary,
        JSON.stringify(command.metadata),
        command.dedupeKey,
        command.lifecycleStatus,
        command.reviewState,
        command.actorId,
        command.actorId,
        timestamp,
        timestamp,
        command.tenantId,
        command.agentId,
        command.governanceStatus,
        command.visibility,
        command.memoryType,
        activeEmbeddingGeneration(),
        command.contentEmbedding ? `[${command.contentEmbedding.join(",")}]` : null,
        command.validAt ?? command.observedAt ?? timestamp,
        command.observedAt ?? timestamp,
        command.expiresAt
      ]
    );

    return mapMemoryRecordRow(row);
  }

  async findById(
    tx: WriteTransactionContext,
    memoryId: string
  ): Promise<MemoryRecordRow | undefined> {
    if (isInMemoryTransactionContext(tx)) {
      return tx.state.memoryRecords.find((row) => row.id === memoryId);
    }

    const [row] = await tx.query(
      "SELECT * FROM memory_records WHERE id = $1",
      [memoryId]
    );
    return row ? mapMemoryRecordRow(row) : undefined;
  }

  async findCurrentByDedupeKey(
    tx: WriteTransactionContext,
    dedupeKey: string
  ): Promise<MemoryRecordRow | undefined> {
    if (isInMemoryTransactionContext(tx)) {
      return tx.state.memoryRecords.find(
        (row) =>
          row.dedupeKey === dedupeKey &&
          row.isCurrent
      );
    }

    const [row] = await tx.query(
      `SELECT * FROM memory_records
       WHERE dedupe_key = $1
         AND is_current = TRUE
       LIMIT 1
       FOR UPDATE`,
      [dedupeKey]
    );
    return row ? mapMemoryRecordRow(row) : undefined;
  }

  async findByIdForUpdate(
    tx: WriteTransactionContext,
    memoryId: string
  ): Promise<MemoryRecordRow | undefined> {
    if (isInMemoryTransactionContext(tx)) {
      return this.findById(tx, memoryId);
    }

    const [row] = await tx.query(
      "SELECT * FROM memory_records WHERE id = $1 FOR UPDATE",
      [memoryId]
    );
    return row ? mapMemoryRecordRow(row) : undefined;
  }

  async listSmartWriteCandidates(
    tx: WriteTransactionContext,
    input: ListSmartWriteCandidatesInput
  ): Promise<MemoryRecordRow[]> {
    const limit = Math.max(1, Math.min(200, input.limit ?? 50));
    const memoryType = input.memoryType?.trim() || null;
    const topic = input.topic?.trim() || null;
    const dedupeKey = input.dedupeKey?.trim() || null;
    const recentCandidateSince = input.recentCandidateSince ?? null;

    if (isInMemoryTransactionContext(tx)) {
      return tx.state.memoryRecords
        .filter((row) => {
          if (row.scopeType !== input.scopeType || row.scopeId !== input.scopeId) return false;
          if (memoryType && row.memoryType && row.memoryType !== memoryType) return false;
          const activeApproved = row.lifecycleStatus === LifecycleStatus.Approved && row.isCurrent;
          const recentCandidate = Boolean(recentCandidateSince && row.lifecycleStatus === LifecycleStatus.Candidate && row.createdAt >= recentCandidateSince);
          if (!activeApproved && !recentCandidate) return false;
          if (dedupeKey && row.dedupeKey === dedupeKey) return true;
          const rowTopic = typeof row.metadata?.topic === "string" ? row.metadata.topic : null;
          const rowMemoryType = typeof row.metadata?.memory_type === "string" ? row.metadata.memory_type : row.memoryType;
          if (topic && memoryType && rowTopic === topic && rowMemoryType === memoryType) return true;
          if (activeApproved) return true;
          if (recentCandidate) return true;
          return false;
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit);
    }

    const params: unknown[] = [
      input.scopeType,
      input.scopeId,
      memoryType,
      dedupeKey,
      topic,
      recentCandidateSince,
      limit
    ];
    const rows = await tx.query(
      `
        SELECT *
        FROM memory_records
        WHERE scope_type = $1
          AND scope_id = $2
          AND ($3::text IS NULL OR memory_type IS NULL OR memory_type = $3)
          AND (
            (lifecycle_status = 'approved' AND is_current = TRUE)
            OR ($6::timestamptz IS NOT NULL AND lifecycle_status = 'candidate' AND created_at >= $6::timestamptz)
          )
          AND (
            ($4::text IS NOT NULL AND dedupe_key = $4)
            OR ($5::text IS NOT NULL AND $3::text IS NOT NULL AND metadata->>'topic' = $5 AND COALESCE(metadata->>'memory_type', memory_type) = $3)
            OR (lifecycle_status = 'approved' AND is_current = TRUE)
            OR ($6::timestamptz IS NOT NULL AND lifecycle_status = 'candidate' AND created_at >= $6::timestamptz)
          )
        ORDER BY updated_at DESC
        LIMIT $7
      `,
      params
    );
    return rows.map(mapMemoryRecordRow);
  }

  async updateMetadata(
    tx: WriteTransactionContext,
    memoryId: string,
    metadata: JsonObject
  ): Promise<MemoryRecordRow> {
    if (isInMemoryTransactionContext(tx)) {
      const index = tx.state.memoryRecords.findIndex((row) => row.id === memoryId);
      if (index === -1) {
        throw new Error(`Memory ${memoryId} not found.`);
      }

      const nextRow: MemoryRecordRow = {
        ...tx.state.memoryRecords[index],
        metadata,
        updatedAt: tx.now()
      };
      tx.state.memoryRecords[index] = nextRow;
      return nextRow;
    }

    const [row] = await tx.query(
      `
        UPDATE memory_records
        SET metadata = $2::jsonb,
            updated_at = $3::timestamptz
        WHERE id = $1
        RETURNING *
      `,
      [memoryId, JSON.stringify(metadata), tx.now()]
    );

    if (!row) {
      throw new Error(`Memory ${memoryId} not found.`);
    }

    return mapMemoryRecordRow(row);
  }

  async updateState(
    tx: WriteTransactionContext,
    input: UpdateMemoryRecordStateInput
  ): Promise<MemoryRecordRow> {
    if (isInMemoryTransactionContext(tx)) {
      const index = tx.state.memoryRecords.findIndex((row) => row.id === input.memoryId);
      if (index === -1) {
        throw new Error(`Memory ${input.memoryId} not found.`);
      }

      const nextRow: MemoryRecordRow = {
        ...tx.state.memoryRecords[index],
        lifecycleStatus: input.lifecycleStatus,
        reviewState: input.reviewState,
        isCurrent: input.isCurrent,
        invalidAt: input.isCurrent ? tx.state.memoryRecords[index].invalidAt : tx.state.memoryRecords[index].invalidAt ?? tx.now(),
        updatedBy: input.actorId,
        updatedAt: tx.now()
      };
      tx.state.memoryRecords[index] = nextRow;
      return nextRow;
    }

    const [row] = await tx.query(
      `
        UPDATE memory_records
        SET lifecycle_status = $2,
            review_state = $3,
            is_current = $4,
            updated_by = $5,
            updated_at = $6::timestamptz,
            invalid_at = CASE
              WHEN $4::boolean IS FALSE THEN COALESCE(invalid_at, $6::timestamptz)
              ELSE invalid_at
            END
        WHERE id = $1
        RETURNING *
      `,
      [
        input.memoryId,
        input.lifecycleStatus,
        input.reviewState,
        input.isCurrent,
        input.actorId,
        tx.now()
      ]
    );

    if (!row) {
      throw new Error(`Memory ${input.memoryId} not found.`);
    }

    return mapMemoryRecordRow(row);
  }

  async updateCandidate(
    tx: WriteTransactionContext,
    input: UpdateCandidateMemoryRecordInput
  ): Promise<MemoryRecordRow> {
    if (isInMemoryTransactionContext(tx)) {
      const index = tx.state.memoryRecords.findIndex((row) => row.id === input.memoryId);
      if (index === -1) {
        throw new Error(`Memory ${input.memoryId} not found.`);
      }

      const current = tx.state.memoryRecords[index];
      const nextRow: MemoryRecordRow = {
        ...current,
        content: input.content,
        title: input.title,
        summary: input.summary,
        metadata: input.metadata,
        dedupeKey: input.dedupeKey,
        memoryType: input.memoryType,
        embeddingGeneration: input.contentEmbedding ? activeEmbeddingGeneration() : current.embeddingGeneration,
        contentEmbedding: input.contentEmbedding ?? current.contentEmbedding ?? null,
        updatedBy: input.actorId,
        updatedAt: tx.now()
      };
      tx.state.memoryRecords[index] = nextRow;
      return nextRow;
    }

    const [row] = await tx.query(
      `
        UPDATE memory_records
        SET content = $2,
            title = $3,
            summary = $4,
            metadata = $5::jsonb,
            dedupe_key = $6,
            memory_type = $7,
            embedding_generation = COALESCE($8, embedding_generation),
            content_embedding = COALESCE($9::vector, content_embedding),
            updated_by = $10,
            updated_at = $11::timestamptz
        WHERE id = $1
        RETURNING *
      `,
      [
        input.memoryId,
        input.content,
        input.title,
        input.summary,
        JSON.stringify(input.metadata),
        input.dedupeKey,
        input.memoryType,
        input.contentEmbedding ? activeEmbeddingGeneration() : null,
        input.contentEmbedding ? `[${input.contentEmbedding.join(",")}]` : null,
        input.actorId,
        tx.now()
      ]
    );

    if (!row) {
      throw new Error(`Memory ${input.memoryId} not found.`);
    }

    return mapMemoryRecordRow(row);
  }

  async createSupersedingVersion(
    tx: WriteTransactionContext,
    input: CreateSupersedingMemoryRecordInput
  ): Promise<MemoryRecordRow> {
    if (isInMemoryTransactionContext(tx)) {
      const timestamp = tx.now();
      const row: MemoryRecordRow = {
        id: tx.nextId("memory_record"),
        requestId: input.requestId,
        scopeType: input.previousRecord.scopeType,
        scopeId: input.previousRecord.scopeId,
        content: input.content,
        title: input.title,
        summary: input.summary,
        metadata: input.metadata,
        dedupeKey: input.dedupeKey,
        lifecycleStatus: input.lifecycleStatus,
        reviewState: input.reviewState,
        isCurrent: true,
        version: input.previousRecord.version + 1,
        createdBy: input.actorId,
        updatedBy: input.actorId,
        createdAt: timestamp,
        updatedAt: timestamp,
        tenantId: input.previousRecord.tenantId,
        agentId: input.previousRecord.agentId,
        governanceStatus: input.previousRecord.governanceStatus,
        visibility: input.previousRecord.visibility,
        memoryType: input.previousRecord.memoryType,
        embeddingGeneration: activeEmbeddingGeneration() ?? input.previousRecord.embeddingGeneration,
        memoryLayer: input.previousRecord.memoryLayer,
        factStatus: "current",
        validAt: timestamp,
        invalidAt: null,
        observedAt: timestamp,
        expiresAt: input.previousRecord.expiresAt,
        episodeId: input.previousRecord.episodeId,
        importance: input.previousRecord.importance,
        memoryStrength: input.previousRecord.memoryStrength,
        decayPolicy: input.previousRecord.decayPolicy
      };
      tx.state.memoryRecords.push(row);
      return row;
    }

    const timestamp = tx.now();
    const [row] = await tx.query(
      `
        INSERT INTO memory_records (
          id,
          request_id,
          scope_type,
          scope_id,
          content,
          title,
          summary,
          metadata,
          dedupe_key,
          lifecycle_status,
          review_state,
          is_current,
          version,
          created_by,
          updated_by,
          created_at,
          updated_at,
          tenant_id,
          agent_id,
          governance_status,
          visibility,
          memory_type,
          embedding_generation,
          memory_layer,
          fact_status,
          valid_at,
          observed_at,
          expires_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, TRUE, $12, $13, $14, $15::timestamptz, $16::timestamptz, $17, $18, $19, $20, $21, $22, $23, $24, $25::timestamptz, $26::timestamptz, $27::timestamptz
        )
        RETURNING *
      `,
      [
        tx.nextId("memory_record"),
        input.requestId,
        input.previousRecord.scopeType,
        input.previousRecord.scopeId,
        input.content,
        input.title,
        input.summary,
        JSON.stringify(input.metadata),
        input.dedupeKey,
        input.lifecycleStatus,
        input.reviewState,
        input.previousRecord.version + 1,
        input.actorId,
        input.actorId,
        timestamp,
        timestamp,
        input.previousRecord.tenantId,
        input.previousRecord.agentId,
        input.previousRecord.governanceStatus,
        input.previousRecord.visibility,
        input.previousRecord.memoryType,
        activeEmbeddingGeneration() ?? input.previousRecord.embeddingGeneration,
        input.previousRecord.memoryLayer,
        "current",
        timestamp,
        timestamp,
        input.previousRecord.expiresAt
      ]
    );

    return mapMemoryRecordRow(row);
  }
}

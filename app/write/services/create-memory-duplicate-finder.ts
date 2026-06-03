import { mapMemoryRecordRow } from "../../db/adapters/postgres-row-mappers";
import type { MemoryRecordRepository } from "../../db/repositories/memory-record-repository";
import {
  isInMemoryTransactionContext,
  type WriteTransactionContext
} from "../../db/tx/write-transaction";
import { cosineSimilarity } from "../../intelligence/semantic-write-lock";
import type { NormalizedCreateMemoryCommand } from "../../shared/contracts/write";
import { LifecycleStatus } from "../../shared/types";
import {
  readDedupeEmbeddingThreshold,
  readMetadataString,
  sourceIdentity,
  textSimilarity
} from "./create-memory-duplicates";

export async function findSourceAwareCurrentMatch(
  tx: WriteTransactionContext,
  command: NormalizedCreateMemoryCommand,
  memoryRecordRepository: MemoryRecordRepository
) {
  const sourceKey = sourceIdentity(command);
  if (!sourceKey.source || !sourceKey.block) return undefined;
  if (isInMemoryTransactionContext(tx)) {
    return tx.state.memoryRecords.find((row) =>
      row.isCurrent &&
      row.scopeType === command.scopeType &&
      row.scopeId === command.scopeId &&
      sourceIdentity(row).source === sourceKey.source &&
      sourceIdentity(row).block === sourceKey.block
    );
  }

  const [row] = await tx.query(
    `
      SELECT *
      FROM memory_records
      WHERE is_current = TRUE
        AND scope_type = $1
        AND scope_id = $2
        AND COALESCE(
          metadata->>'canonical_source_path',
          metadata->>'source_path',
          metadata->>'source_ref',
          metadata->>'uri',
          source_ref
        ) = $3
        AND COALESCE(
          metadata->>'canonical_section',
          metadata->>'section',
          metadata->>'block_id'
        ) = $4
      ORDER BY updated_at DESC
      LIMIT 1
      FOR UPDATE
    `,
    [command.scopeType, command.scopeId, sourceKey.source, sourceKey.block]
  );
  return row ? memoryRecordRepository.findByIdForUpdate(tx, String(row.id)) : undefined;
}

export async function findSameScopeSemanticDuplicate(
  tx: WriteTransactionContext,
  command: NormalizedCreateMemoryCommand
): Promise<{ readonly id: string; readonly score: number } | null> {
  const sourceKey = sourceIdentity(command);
  const embeddingDuplicate = await findSameTopicEmbeddingDuplicate(tx, command);
  if (embeddingDuplicate) return embeddingDuplicate;

  const candidates = isInMemoryTransactionContext(tx)
    ? tx.state.memoryRecords.filter((row) =>
        row.isCurrent &&
        row.scopeType === command.scopeType &&
        row.scopeId === command.scopeId &&
        row.lifecycleStatus === LifecycleStatus.Approved
      )
    : (await tx.query(
        `
          SELECT *
          FROM memory_records
          WHERE is_current = TRUE
            AND scope_type = $1
            AND scope_id = $2
            AND lifecycle_status = $3
          ORDER BY updated_at DESC
          LIMIT 50
        `,
        [command.scopeType, command.scopeId, LifecycleStatus.Approved]
      )).map((row) => row as any);
  let best: { id: string; score: number } | null = null;
  for (const row of candidates) {
    const existingSource = sourceIdentity(row);
    if (sourceKey.source && existingSource.source && sourceKey.source !== existingSource.source) continue;
    const score = textSimilarity(command.content, String(row.content ?? ""));
    if (score >= 0.86 && (!best || score > best.score)) {
      best = { id: String(row.id), score };
    }
  }
  return best;
}

async function findSameTopicEmbeddingDuplicate(
  tx: WriteTransactionContext,
  command: NormalizedCreateMemoryCommand
): Promise<{ readonly id: string; readonly score: number } | null> {
  if (!command.contentEmbedding || command.contentEmbedding.length === 0) return null;
  const topic = readMetadataString(command.metadata, "topic");
  const memoryType = command.memoryType ?? (readMetadataString(command.metadata, "memory_type", "memoryType") || null);
  if (!topic || !memoryType) return null;

  const started = Date.now();
  const threshold = readDedupeEmbeddingThreshold();
  const candidates = isInMemoryTransactionContext(tx)
    ? tx.state.memoryRecords
      .filter((row) =>
        row.isCurrent &&
        row.scopeType === command.scopeType &&
        row.scopeId === command.scopeId &&
        row.lifecycleStatus === LifecycleStatus.Approved &&
        (row.memoryType ?? readMetadataString(row.metadata, "memory_type", "memoryType")) === memoryType &&
        readMetadataString(row.metadata, "topic") === topic &&
        row.contentEmbedding &&
        row.contentEmbedding.length > 0
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 20)
    : (await tx.query(
        `
          SELECT *
          FROM memory_records
          WHERE is_current = TRUE
            AND scope_type = $1
            AND scope_id = $2
            AND lifecycle_status = $3
            AND COALESCE(memory_type, metadata->>'memory_type', metadata->>'memoryType') = $4
            AND metadata->>'topic' = $5
            AND content_embedding IS NOT NULL
          ORDER BY updated_at DESC
          LIMIT 20
        `,
        [command.scopeType, command.scopeId, LifecycleStatus.Approved, memoryType, topic]
      )).map(mapMemoryRecordRow);

  let best: { id: string; score: number } | null = null;
  for (const row of candidates) {
    if (Date.now() - started > 50) break;
    if (!row.contentEmbedding || row.contentEmbedding.length === 0) continue;
    const score = cosineSimilarity(command.contentEmbedding, row.contentEmbedding);
    if (score >= threshold && (!best || score > best.score)) {
      best = { id: row.id, score };
    }
  }
  return best;
}

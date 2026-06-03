import {
  type WriteTransactionContext,
  isInMemoryTransactionContext
} from "../tx/write-transaction";
import type { MemorySourceRow } from "../schema/tables";
import type { MemorySourceInput } from "../../shared/contracts/write";
import { mapMemorySourceRow } from "../adapters/postgres-row-mappers";

export class MemorySourceRepository {
  async createMany(
    tx: WriteTransactionContext,
    memoryId: string,
    sources: readonly MemorySourceInput[]
  ): Promise<MemorySourceRow[]> {
    if (isInMemoryTransactionContext(tx)) {
      return sources.map((source) => {
        const timestamp = tx.now();
        const row: MemorySourceRow = {
          id: tx.nextId("memory_source"),
          memoryId,
          sourceType: source.sourceType,
          uri: source.uri ?? null,
          excerpt: source.excerpt ?? null,
          confidence: source.confidence ?? null,
          capturedAt: source.capturedAt ?? null,
          metadata: source.metadata ?? {},
          createdAt: timestamp,
          updatedAt: timestamp
        };
        tx.state.memorySources.push(row);
        return row;
      });
    }

    const createdRows: MemorySourceRow[] = [];
    for (const source of sources) {
      const timestamp = tx.now();
      const [row] = await tx.query(
        `
          INSERT INTO memory_sources (
            id,
            memory_id,
            source_type,
            uri,
            excerpt,
            confidence,
            captured_at,
            metadata,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::jsonb, $9::timestamptz, $10::timestamptz)
          RETURNING *
        `,
        [
          tx.nextId("memory_source"),
          memoryId,
          source.sourceType,
          source.uri ?? null,
          source.excerpt ?? null,
          source.confidence ?? null,
          source.capturedAt ?? null,
          JSON.stringify(source.metadata ?? {}),
          timestamp,
          timestamp
        ]
      );
      createdRows.push(mapMemorySourceRow(row));
    }

    return createdRows;
  }
}

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
    if (sources.length === 0) {
      return [];
    }

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

    const timestamp = tx.now();
    const values: unknown[] = [];
    const tuples = sources.map((source, index) => {
      const offset = index * 10;
      values.push(
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
      );
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}::timestamptz, $${offset + 8}::jsonb, $${offset + 9}::timestamptz, $${offset + 10}::timestamptz)`;
    });
    const rows = await tx.query(
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
        VALUES ${tuples.join(", ")}
        RETURNING *
      `,
      values
    );

    return rows.map(mapMemorySourceRow);
  }
}

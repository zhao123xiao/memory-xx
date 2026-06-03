import {
  type WriteTransactionContext,
  isInMemoryTransactionContext
} from "../tx/write-transaction";
import type { MemoryRelationRow } from "../schema/tables";
import type { MemoryRelationInput } from "../../shared/contracts/write";
import { mapMemoryRelationRow } from "../adapters/postgres-row-mappers";

export class MemoryRelationRepository {
  async createMany(
    tx: WriteTransactionContext,
    memoryId: string,
    relations: readonly MemoryRelationInput[]
  ): Promise<MemoryRelationRow[]> {
    if (isInMemoryTransactionContext(tx)) {
      return relations.map((relation) => {
        const timestamp = tx.now();
        const row: MemoryRelationRow = {
          id: tx.nextId("memory_relation"),
          memoryId,
          relatedMemoryId: relation.relatedMemoryId,
          relationType: relation.relationType,
          direction: relation.direction ?? "outbound",
          weight: relation.weight ?? null,
          metadata: relation.metadata ?? {},
          createdAt: timestamp,
          updatedAt: timestamp
        };
        tx.state.memoryRelations.push(row);
        return row;
      });
    }

    const createdRows: MemoryRelationRow[] = [];
    for (const relation of relations) {
      const timestamp = tx.now();
      const [row] = await tx.query(
        `
          INSERT INTO memory_relations (
            id,
            memory_id,
            related_memory_id,
            relation_type,
            direction,
            weight,
            metadata,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz, $9::timestamptz)
          RETURNING *
        `,
        [
          tx.nextId("memory_relation"),
          memoryId,
          relation.relatedMemoryId,
          relation.relationType,
          relation.direction ?? "outbound",
          relation.weight ?? null,
          JSON.stringify(relation.metadata ?? {}),
          timestamp,
          timestamp
        ]
      );
      createdRows.push(mapMemoryRelationRow(row));
    }

    return createdRows;
  }
}

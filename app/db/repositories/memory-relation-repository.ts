import {
  type WriteTransactionContext,
  isInMemoryTransactionContext
} from "../tx/write-transaction";
import type { QueryResultRow } from "pg";
import type { MemoryRelationRow } from "../schema/tables";
import type { MemoryRelationInput } from "../../shared/contracts/write";
import { mapMemoryRelationRow } from "../adapters/postgres-row-mappers";
import {
  RecordNotFoundError,
  RelationTargetNotFoundError
} from "../../shared/errors/write-errors";

function postgresConstraintName(error: unknown): string | null {
  return error && typeof error === "object" &&
    "constraint" in error && typeof error.constraint === "string"
    ? error.constraint
    : null;
}

function postgresErrorCode(error: unknown): string | null {
  return error && typeof error === "object" &&
    "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function mapRelationForeignKeyError(
  error: unknown,
  memoryId: string,
  relations: readonly MemoryRelationInput[]
): Error | null {
  if (postgresErrorCode(error) !== "23503") return null;
  const constraint = postgresConstraintName(error);
  if (constraint === "memory_relations_memory_id_fkey") {
    return new RecordNotFoundError(memoryId);
  }
  if (constraint === "memory_relations_related_memory_id_fkey") {
    return new RelationTargetNotFoundError(relations[0]?.relatedMemoryId ?? "unknown");
  }
  return null;
}

export class MemoryRelationRepository {
  async createMany(
    tx: WriteTransactionContext,
    memoryId: string,
    relations: readonly MemoryRelationInput[]
  ): Promise<MemoryRelationRow[]> {
    if (relations.length === 0) {
      return [];
    }

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

    const timestamp = tx.now();
    const values: unknown[] = [];
    const tuples = relations.map((relation, index) => {
      const offset = index * 9;
      values.push(
        tx.nextId("memory_relation"),
        memoryId,
        relation.relatedMemoryId,
        relation.relationType,
        relation.direction ?? "outbound",
        relation.weight ?? null,
        JSON.stringify(relation.metadata ?? {}),
        timestamp,
        timestamp
      );
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}::jsonb, $${offset + 8}::timestamptz, $${offset + 9}::timestamptz)`;
    });
    let rows: readonly QueryResultRow[];
    try {
      rows = await tx.query(
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
          VALUES ${tuples.join(", ")}
          RETURNING *
        `,
        values
      );
    } catch (error) {
      throw mapRelationForeignKeyError(error, memoryId, relations) ?? error;
    }

    return rows.map(mapMemoryRelationRow);
  }
}

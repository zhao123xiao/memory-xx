import type { QueryResultRow } from "pg";

import {
  type WriteTransactionContext,
  isInMemoryTransactionContext
} from "../tx/write-transaction";
import type { ScopeType } from "../../shared/types";

export interface BumpScopeGenerationInput {
  readonly scopeType: ScopeType | string;
  readonly scopeId: string;
}

export interface ScopeGenerationRow {
  readonly scopeType: string;
  readonly scopeId: string;
  readonly generation: number;
  readonly bumpedAt: string;
}

export class ScopeGenerationRepository {
  async bump(
    tx: WriteTransactionContext,
    input: BumpScopeGenerationInput
  ): Promise<ScopeGenerationRow> {
    const now = tx.now();
    if (isInMemoryTransactionContext(tx)) {
      return {
        scopeType: String(input.scopeType),
        scopeId: input.scopeId,
        generation: 0,
        bumpedAt: now
      };
    }

    const [row] = await tx.query<QueryResultRow>(
      `
        INSERT INTO scope_generations (
          scope_type,
          scope_id,
          generation,
          bumped_at
        )
        VALUES ($1, $2, 1, $3::timestamptz)
        ON CONFLICT (scope_type, scope_id)
        DO UPDATE SET
          generation = scope_generations.generation + 1,
          bumped_at = EXCLUDED.bumped_at
        RETURNING scope_type, scope_id, generation, bumped_at
      `,
      [input.scopeType, input.scopeId, now]
    );

    return {
      scopeType: String(row.scope_type),
      scopeId: String(row.scope_id),
      generation: Number(row.generation),
      bumpedAt: toIsoString(row.bumped_at)
    };
  }
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new TypeError("Expected timestamp row value.");
}

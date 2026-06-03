import {
  type WriteTransactionContext,
  isInMemoryTransactionContext
} from "../tx/write-transaction";
import type { MigrationAuditRow } from "../schema/tables";
import type { JsonObject } from "../../shared/types";
import { mapMigrationAuditRow } from "../adapters/postgres-row-mappers";

export interface AppendMigrationAuditInput {
  readonly requestId: string | null;
  readonly targetTable: string;
  readonly targetId: string;
  readonly batchId?: string | null;
  readonly action: string;
  readonly details: JsonObject;
}

export class MigrationAuditRepository {
  async append(
    tx: WriteTransactionContext,
    input: AppendMigrationAuditInput
  ): Promise<MigrationAuditRow> {
    if (isInMemoryTransactionContext(tx)) {
      const row: MigrationAuditRow = {
        id: tx.nextId("migration_audit"),
        requestId: input.requestId,
        targetTable: input.targetTable,
        targetId: input.targetId,
        batchId: input.batchId ?? null,
        action: input.action,
        details: input.details,
        createdAt: tx.now()
      };
      tx.state.migrationAudit.push(row);
      return row;
    }

    const [row] = await tx.query(
      `
        INSERT INTO migration_audit (
          id,
          request_id,
          target_table,
          target_id,
          batch_id,
          action,
          details,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
        RETURNING *
      `,
      [
        tx.nextId("migration_audit"),
        input.requestId,
        input.targetTable,
        input.targetId,
        input.batchId ?? null,
        input.action,
        JSON.stringify(input.details),
        tx.now()
      ]
    );

    return mapMigrationAuditRow(row);
  }
}

import "./test-harness/config.js";
import { loadMemoryXXPostgresConfig, PostgresWriteDatabase } from "../app";
import { withWriteTransaction, isPostgresTransactionContext } from "../app/db/tx/write-transaction";

async function main(): Promise<void> {
  const db = new PostgresWriteDatabase({ config: loadMemoryXXPostgresConfig(process.env) });
  try {
    const archived = await withWriteTransaction(db, async (tx) => {
      if (!isPostgresTransactionContext(tx)) return 0;
      const rows = await tx.query(
        `
          WITH moved AS (
            DELETE FROM write_tickets
            WHERE terminal_at IS NOT NULL
              AND terminal_at < now() - interval '7 days'
            RETURNING *
          )
          INSERT INTO write_tickets_archive SELECT * FROM moved
          RETURNING id
        `
      );
      return rows.length;
    });
    process.stdout.write(JSON.stringify({ ok: true, archived }) + "\n");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

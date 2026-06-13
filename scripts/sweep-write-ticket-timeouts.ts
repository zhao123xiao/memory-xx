import "./test-harness/config.js";
import { loadMemoryXXPostgresConfig, PostgresWriteDatabase } from "../app";
import { withWriteTransaction } from "../app/db/tx/write-transaction";
import { WriteTicketRepository } from "../app/db/repositories/write-ticket-repository";

async function main(): Promise<void> {
  const db = new PostgresWriteDatabase({ config: loadMemoryXXPostgresConfig(process.env) });
  try {
    const failed = await withWriteTransaction(db, (tx) => new WriteTicketRepository().failExpired(tx));
    process.stdout.write(JSON.stringify({ ok: true, failed }) + "\n");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

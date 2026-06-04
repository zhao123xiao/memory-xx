import { IngestRequestRepository, PostgresWriteDatabase, loadMemoryXXPostgresConfig, withWriteTransaction } from "../app/db";

async function main(): Promise<void> {
  const db = new PostgresWriteDatabase({ config: loadMemoryXXPostgresConfig() });
  try {
    const repo = new IngestRequestRepository();
    const failed = await withWriteTransaction(db, (tx) => repo.recoverExpiredAccepted(tx));
    console.log(JSON.stringify({ failed, recovered: 0, claimed: 0, at: new Date().toISOString() }));
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

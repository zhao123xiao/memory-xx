import "./test-harness/config.js";
import { Pool } from "pg";
import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";

async function main(): Promise<void> {
  const config = loadMemoryXXPostgresConfig(process.env);
  const pool = new Pool(createPostgresPoolConfig(config));
  try {
    const schema = quoteIdent(config.schema);
    const result = await pool.query(
      `SELECT dispatch_status, count(*)::int AS count
         FROM ${schema}.outbox_events
        GROUP BY dispatch_status
        ORDER BY dispatch_status`
    );
    const counts = Object.fromEntries(result.rows.map((row) => [row.dispatch_status, row.count]));
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: process.argv[2] ?? "scan",
      counts,
      note: "Use replay:qdrant-outbox for targeted replay; this command is a safe status surface."
    }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`unsafe identifier: ${value}`);
  return `"${value}"`;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

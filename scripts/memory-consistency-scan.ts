import "./test-harness/config.js";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { createPostgresPoolConfig, loadMemoryV2PostgresConfig } from "../app/db/adapters/postgres-config";

async function main(): Promise<void> {
  const config = loadMemoryV2PostgresConfig(process.env);
  const pool = new Pool(createPostgresPoolConfig(config));
  try {
    const schema = quoteIdent(config.schema);
    const db = await pool.query(
      `SELECT count(*)::int AS approved_current
         FROM ${schema}.memory_records
        WHERE lifecycle_status='approved' AND is_current`
    );
    const qdrantRaw = execFileSync("curl", ["-sS", "http://127.0.0.1:6333/collections/memory-xx-active"], {
      encoding: "utf8",
    });
    const qdrant = JSON.parse(qdrantRaw);
    const approvedCurrent = db.rows[0]?.approved_current ?? 0;
    const points = qdrant?.result?.points_count ?? 0;
    process.stdout.write(`${JSON.stringify({
      ok: approvedCurrent === points,
      approved_current: approvedCurrent,
      qdrant_points: points,
      repair_requested: process.argv.includes("--repair-missing"),
      note: "This scan reports PG/Qdrant count parity; targeted repair is handled by replay:qdrant-outbox."
    }, null, 2)}\n`);
    process.exitCode = approvedCurrent === points ? 0 : 1;
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

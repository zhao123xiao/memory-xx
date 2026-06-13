import path from "node:path";

import "./test-harness/config.js";
import { loadMemoryXXPostgresConfig, runPostgresMigrations } from "../app";

async function main(): Promise<void> {
  const config = loadMemoryXXPostgresConfig(process.env);
  const result = await runPostgresMigrations({
    config,
    migrationsDirectory: path.resolve(process.cwd(), "migrations")
  });

  const appliedSummary =
    result.applied.length === 0
      ? "no new migrations applied"
      : `applied ${result.applied.map((migration) => migration.filename).join(", ")}`;
  const skippedSummary =
    result.skipped.length === 0
      ? "no migrations skipped"
      : `skipped ${result.skipped.join(", ")}`;

  process.stdout.write(`${appliedSummary}; ${skippedSummary}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

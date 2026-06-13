import path from "node:path";

import { loadMemoryXXPostgresConfig } from "../db/adapters/postgres-config";
import { runPostgresMigrations } from "./runner";

export async function runMigrationCli(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadMemoryXXPostgresConfig(env);
  const result = await runPostgresMigrations({
    config,
    migrationsDirectory: path.resolve(process.cwd(), "migrations"),
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

if (require.main === module) {
  runMigrationCli().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

import { ExporterStateRepository, getSourceModeStatus, LifecycleStatus, PostgresWriteDatabase, loadMemoryXXPostgresConfig } from "../app";

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readNumberFlag(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const parsed = Number.parseInt(process.argv[index + 1] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  const verify = hasFlag("--verify") || hasFlag("verify");
  if (!verify) {
    console.log(JSON.stringify(getSourceModeStatus(), null, 2));
    return;
  }

  const limit = hasFlag("--full") ? Number.MAX_SAFE_INTEGER : readNumberFlag("--limit", 5000);
  const offset = readNumberFlag("--offset", 0);
  const db = new PostgresWriteDatabase({ config: loadMemoryXXPostgresConfig(process.env) });
  try {
    const snapshot = await db.snapshot();
    const expectedIds = snapshot.memoryRecords
      .filter((record) => record.lifecycleStatus === LifecycleStatus.Approved && record.isCurrent)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(offset, offset + limit)
      .map((record) => record.id);
    const expected = new Set(expectedIds);
    const state = await new ExporterStateRepository().load();
    const projected = new Set(Object.keys(state.records));
    const missing = expectedIds.filter((id) => !projected.has(id));
    const stale = [...projected].filter((id) => expected.has(id) === false).slice(0, 100);
    const status = getSourceModeStatus({
      verification: {
        checked_records: expectedIds.length,
        projected_records: projected.size,
        missing_projection_ids: missing.slice(0, 100),
        stale_projection_ids: stale,
        drift_count: missing.length + stale.length
      }
    });
    console.log(JSON.stringify(status, null, 2));
    if (!status.ok && !hasFlag("--allow-drift")) {
      process.exitCode = 2;
    }
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

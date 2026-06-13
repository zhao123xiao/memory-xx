import {
  ArchiveMemoryService,
  PostgresWriteDatabase,
  RecallRuntimeCacheInvalidator,
  loadMemoryRedisConfig,
  loadMemoryXXPostgresConfig,
  RedisRecallCache,
  NoopRecallCache,
  LifecycleStatus
} from "../app";

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const apply = hasFlag("--apply");
  const now = new Date();
  const db = new PostgresWriteDatabase({ config: loadMemoryXXPostgresConfig() });
  const redisConfig = loadMemoryRedisConfig();
  const cache = redisConfig.url ? new RedisRecallCache({ config: redisConfig }) : new NoopRecallCache();
  if (cache instanceof RedisRecallCache) await cache.connect();
  try {
    const snapshot = await db.snapshot();
    const expired = snapshot.memoryRecords
      .filter((record) =>
        record.isCurrent &&
        record.lifecycleStatus === LifecycleStatus.Approved &&
        record.expiresAt !== null &&
        new Date(record.expiresAt).getTime() <= now.getTime()
      )
      .map((record) => record.id);
    const applied: string[] = [];
    if (apply) {
      const service = new ArchiveMemoryService({
        database: db,
        cacheInvalidator: new RecallRuntimeCacheInvalidator(cache, { database: db })
      });
      for (const memoryId of expired) {
        await service.execute({
          requestId: `temporal-expire-${memoryId}-${Date.now()}`,
          actorId: "system:temporal-sweep",
          memoryId
        });
        applied.push(memoryId);
      }
    }
    console.log(JSON.stringify({
      ok: true,
      mode: apply ? "apply" : "dry-run",
      expired_candidate_ids: expired,
      applied_ids: applied,
      events_expected: applied.length,
      outbox_expected: applied.length,
      cache_invalidation_expected: applied.length,
      projection_repair_expected: applied.length
    }, null, 2));
  } finally {
    await cache.close();
    await db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

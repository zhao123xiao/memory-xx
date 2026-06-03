import {
  ArchiveMemoryService,
  PostgresWriteDatabase,
  RecallRuntimeCacheInvalidator,
  findArchiveCandidates,
  loadMemoryRedisConfig,
  loadMemoryV2PostgresConfig,
  RedisRecallCache,
  NoopRecallCache,
  LifecycleStatus,
  ReviewState
} from "../app";

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const apply = hasFlag("--apply");
  const now = new Date().toISOString();
  const db = new PostgresWriteDatabase({ config: loadMemoryV2PostgresConfig() });
  const redisConfig = loadMemoryRedisConfig();
  const cache = redisConfig.url ? new RedisRecallCache({ config: redisConfig }) : new NoopRecallCache();
  if (cache instanceof RedisRecallCache) await cache.connect();
  try {
    const snapshot = await db.snapshot();
    const candidates = snapshot.memoryRecords
      .filter((record) =>
        record.lifecycleStatus === LifecycleStatus.Approved &&
        [ReviewState.Approved, ReviewState.SilentApproved, ReviewState.NotRequired].includes(record.reviewState) &&
        record.isCurrent
      )
      .map((record) => ({
        id: record.id,
        importance: record.importance,
        usageCount: 0,
        supportCount: 0,
        sourceAuthority: 0.5,
        lastAccessedAt: record.updatedAt,
        conflictCount: 0,
        createdAt: record.createdAt
      }));
    const plan = findArchiveCandidates(candidates, now, !apply);
    const applied: string[] = [];
    if (apply) {
      const service = new ArchiveMemoryService({
        database: db,
        cacheInvalidator: new RecallRuntimeCacheInvalidator(cache, { database: db })
      });
      for (const memoryId of plan.archived_ids) {
        await service.execute({
          requestId: `decay-archive-${memoryId}-${Date.now()}`,
          actorId: "system:decay-run",
          memoryId
        });
        applied.push(memoryId);
      }
    }
    console.log(JSON.stringify({
      ok: true,
      mode: apply ? "apply" : "dry-run",
      checked: plan.total_checked,
      archive_candidate_ids: plan.archived_ids,
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

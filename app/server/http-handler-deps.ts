import type { PostgresRecallRuntime } from "../recall/postgres-runtime";
import type { WriteTransactionRunner } from "../db/tx/write-transaction";
import type { RecallCacheRuntime } from "../cache/types";
import type { PermissionChecker } from "./permissions";
import { runtime, recallCache, writeDatabase, projectionSyncService } from "./runtime";

export interface HandlerDeps {
  runtime: PostgresRecallRuntime | null;
  writeDatabase: WriteTransactionRunner | null;
  recallCache: RecallCacheRuntime;
  projectionSyncService: import("../qdrant-sync/projector").QdrantProjectionSyncService | null;
  permissions?: PermissionChecker;
  env?: NodeJS.ProcessEnv;
}

export function getDeps(override?: Partial<HandlerDeps>): HandlerDeps {
  return {
    runtime: override?.runtime ?? runtime,
    writeDatabase: override?.writeDatabase ?? writeDatabase,
    recallCache: override?.recallCache ?? recallCache,
    projectionSyncService: override?.projectionSyncService ?? projectionSyncService,
    permissions: override?.permissions,
    env: override?.env,
  };
}

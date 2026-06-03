import type { MemoryCacheInvalidator } from "../../cache";
import { recordPostCommitDegraded } from "../../observability/post-commit-degraded";
import type { QdrantProjectionSyncService } from "../../qdrant-sync";
import type { NormalizedCreateMemoryCommand, StoredWriteResult } from "../../shared/contracts/write";

export interface CreateMemoryPostCommitDependencies {
  readonly cacheInvalidator?: MemoryCacheInvalidator;
  readonly projectionSyncService?: QdrantProjectionSyncService;
}

export interface CreateMemoryPostCommitResult {
  readonly post_commit_degraded?: boolean;
  readonly cache_invalidation_failed?: boolean;
  readonly projection_sync_failed?: boolean;
  readonly post_commit_errors?: readonly string[];
}

export async function runCreateMemoryPostCommitSideEffects(
  command: NormalizedCreateMemoryCommand,
  result: StoredWriteResult,
  dependencies: CreateMemoryPostCommitDependencies
): Promise<CreateMemoryPostCommitResult> {
  const postCommitErrors: string[] = [];
  let cacheInvalidationFailed = false;
  let projectionSyncFailed = false;

  if (dependencies.cacheInvalidator) {
    try {
      await dependencies.cacheInvalidator.invalidate([
        {
          type: command.scopeType,
          id: command.scopeId
        }
      ]);
    } catch (error) {
      cacheInvalidationFailed = true;
      postCommitErrors.push(`cache_invalidation_failed:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (dependencies.projectionSyncService) {
    try {
      await dependencies.projectionSyncService.syncWriteResult(result);
    } catch (error) {
      projectionSyncFailed = true;
      postCommitErrors.push(`projection_sync_failed:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (postCommitErrors.length > 0) {
    recordPostCommitDegraded({
      cacheInvalidationFailed,
      projectionSyncFailed,
      errors: postCommitErrors,
    });
  }

  return postCommitErrors.length > 0
    ? {
        post_commit_degraded: true,
        cache_invalidation_failed: cacheInvalidationFailed,
        projection_sync_failed: projectionSyncFailed,
        post_commit_errors: postCommitErrors
      }
    : {};
}

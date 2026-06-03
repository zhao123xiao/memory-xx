export interface PostCommitDegradedInput {
  readonly cacheInvalidationFailed?: boolean;
  readonly projectionSyncFailed?: boolean;
  readonly errors?: readonly string[];
}

export interface PostCommitDegradedSnapshot {
  readonly total: number;
  readonly cache_invalidation_failed: number;
  readonly projection_sync_failed: number;
  readonly recent_errors: readonly string[];
}

const MAX_RECENT_ERRORS = 20;

const state = {
  total: 0,
  cacheInvalidationFailed: 0,
  projectionSyncFailed: 0,
  recentErrors: [] as string[],
};

export function recordPostCommitDegraded(input: PostCommitDegradedInput): void {
  state.total += 1;
  if (input.cacheInvalidationFailed) state.cacheInvalidationFailed += 1;
  if (input.projectionSyncFailed) state.projectionSyncFailed += 1;
  for (const error of input.errors ?? []) {
    state.recentErrors.unshift(error);
  }
  state.recentErrors.splice(MAX_RECENT_ERRORS);
}

export function getPostCommitDegradedSnapshot(): PostCommitDegradedSnapshot {
  return {
    total: state.total,
    cache_invalidation_failed: state.cacheInvalidationFailed,
    projection_sync_failed: state.projectionSyncFailed,
    recent_errors: [...state.recentErrors],
  };
}

export function resetPostCommitDegradedSnapshot(): void {
  state.total = 0;
  state.cacheInvalidationFailed = 0;
  state.projectionSyncFailed = 0;
  state.recentErrors.splice(0, state.recentErrors.length);
}

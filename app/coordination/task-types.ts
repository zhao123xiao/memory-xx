export enum CoordinationTaskType {
  CacheInvalidate = "cache.invalidate",
  ProjectionExport = "projection.export"
}

export const COORDINATION_DISPATCH_IDEMPOTENCY_PREFIX = "dispatch:event";

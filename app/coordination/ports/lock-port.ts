import type { DistributedLock, LockScope } from "../types";

export interface AcquireLockInput {
  readonly lockScope: LockScope;
  readonly resourceId: string;
  readonly ownerId: string;
  readonly ttlMs: number;
  readonly now: number;
  readonly leaseId?: string;
}

export interface ReleaseLockInput {
  readonly lockScope: LockScope;
  readonly resourceId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
}

export interface LockPort {
  acquire(input: AcquireLockInput): Promise<DistributedLock | null>;
  releaseLock(input: ReleaseLockInput): Promise<boolean>;
  getLock(lockScope: LockScope, resourceId: string): Promise<DistributedLock | null>;
}

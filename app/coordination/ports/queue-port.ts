import type {
  ClaimedCoordinationTask,
  CoordinationBacklogSnapshot,
  CoordinationFailure,
  CoordinationTaskRecord,
  CoordinationTaskSpec,
  DlqReason,
  RecoveryReason
} from "../types";

export interface EnqueueTaskInput {
  readonly task: CoordinationTaskSpec;
  readonly now?: number;
  readonly dedupeWindowMs?: number;
}

export interface EnqueueTaskResult {
  readonly accepted: boolean;
  readonly dedupeHit: boolean;
  readonly task: CoordinationTaskRecord;
}

export interface ClaimNextTaskInput {
  readonly workerId: string;
  readonly leaseTtlMs: number;
  readonly now: number;
  readonly requirePresence?: boolean;
}

export interface RequeueTaskInput {
  readonly taskId: string;
  readonly now: number;
  readonly delayMs: number;
  readonly error?: CoordinationFailure;
  readonly ownerId?: string;
  readonly leaseId?: string;
  readonly recoveryReason?: RecoveryReason;
  readonly recoveredBy?: string;
}

export interface MoveToDlqInput {
  readonly taskId: string;
  readonly now: number;
  readonly reason: DlqReason;
  readonly error: CoordinationFailure;
  readonly ownerId?: string;
  readonly leaseId?: string;
}

export interface ReplayDlqTaskInput {
  readonly taskId: string;
  readonly now: number;
  readonly delayMs?: number;
  readonly note?: string;
  readonly recoveredBy: string;
}

export interface QueuePort {
  enqueue(input: EnqueueTaskInput): Promise<EnqueueTaskResult>;
  claimNext(input: ClaimNextTaskInput): Promise<ClaimedCoordinationTask | null>;
  getTask(taskId: string): Promise<CoordinationTaskRecord | null>;
  markRunning(taskId: string, leaseId: string, ownerId: string, now: number): Promise<CoordinationTaskRecord>;
  requeue(input: RequeueTaskInput): Promise<CoordinationTaskRecord>;
  moveToDlq(input: MoveToDlqInput): Promise<CoordinationTaskRecord>;
  listDlq(): Promise<readonly CoordinationTaskRecord[]>;
  replayDlq(input: ReplayDlqTaskInput): Promise<CoordinationTaskRecord>;
  findExpiredLeaseTasks(now: number): Promise<readonly CoordinationTaskRecord[]>;
  getBacklogSnapshot(now: number): Promise<CoordinationBacklogSnapshot>;
}

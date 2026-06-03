import {
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS
} from "../constants";
import {
  CoordinationTaskStatus,
  DlqReason,
  RecoveryReason,
  type CoordinationFailure,
  type CoordinationTaskRecord
} from "../types";

export interface RecoveryDecision {
  readonly action: "retry" | "dlq";
  readonly failure: CoordinationFailure;
  readonly reason: RecoveryReason;
  readonly delayMs?: number;
  readonly dlqReason?: DlqReason;
}

export function computeRetryDelayMs(
  attempt: number,
  baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS
): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

export function decideExpiredLeaseRecovery(
  task: CoordinationTaskRecord,
  now: number
): RecoveryDecision {
  const failure: CoordinationFailure = {
    code: "coord_lease_expired",
    message: `Lease expired for task ${task.taskId}`,
    retriable: task.attempt < task.maxAttempts
  };

  if (
    task.status === CoordinationTaskStatus.Dlq ||
    task.attempt >= task.maxAttempts
  ) {
    return {
      action: "dlq",
      failure,
      reason: RecoveryReason.LeaseExpired,
      dlqReason: DlqReason.LeaseExpired
    };
  }

  return {
    action: "retry",
    failure,
    reason: RecoveryReason.LeaseExpired,
    delayMs: computeRetryDelayMs(task.attempt),
  };
}

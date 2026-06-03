import type { CoordinationLease, CoordinationTaskRecord, DlqReason } from "../types";

export interface CoordinationJobContext {
  readonly task: CoordinationTaskRecord;
  readonly lease: CoordinationLease;
  readonly workerId: string;
  readonly now: number;
  renewLease(ttlMs?: number): Promise<CoordinationLease>;
}

export type CoordinationJobResult =
  | {
      readonly kind: "succeeded";
      readonly result?: unknown;
    }
  | {
      readonly kind: "retry";
      readonly delayMs: number;
      readonly code?: string;
      readonly message?: string;
    }
  | {
      readonly kind: "dlq";
      readonly reason: DlqReason;
      readonly code?: string;
      readonly message?: string;
    };

export interface CoordinationJobHandler {
  readonly taskType: string;
  handle(context: CoordinationJobContext): Promise<CoordinationJobResult>;
}

export function succeeded(result?: unknown): CoordinationJobResult {
  return { kind: "succeeded", result };
}

export function retryLater(
  delayMs: number,
  message?: string,
  code = "coord_retry_requested"
): CoordinationJobResult {
  return {
    kind: "retry",
    delayMs,
    code,
    message
  };
}

export function sendToDlq(
  reason: DlqReason,
  message?: string,
  code = "coord_dlq_requested"
): CoordinationJobResult {
  return {
    kind: "dlq",
    reason,
    code,
    message
  };
}

import type { WriteTransactionRunner } from "../db/tx/write-transaction";
import { LifecycleStatus } from "../shared";

export function readResultString(result: unknown, key: string): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const value = (result as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function readResultBoolean(result: unknown, key: string): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  return (result as Record<string, unknown>)[key] === true;
}

export function hasOutboxForCompletedRequest(
  request: { readonly requestId: string; readonly result: unknown },
  snapshot: Awaited<ReturnType<WriteTransactionRunner["snapshot"]>>,
): boolean {
  if (snapshot.outboxEvents.some((event) => event.requestId === request.requestId)) {
    return true;
  }
  if (readResultBoolean(request.result, "outbox_events_skipped")) {
    return true;
  }
  const outboxEventId = readResultString(request.result, "outboxEventId");
  if (!outboxEventId) return false;
  return snapshot.outboxEvents.some((event) => event.id === outboxEventId);
}

export function hasEffectiveRecallableLifecycle(status: LifecycleStatus): boolean {
  return status === "approved";
}

export function getDuplicateCurrentRepairPriority(record: {
  readonly lifecycleStatus: LifecycleStatus;
  readonly reviewState: string;
  readonly createdAt: string;
  readonly id: string;
}): number {
  const lifecycleRank = hasEffectiveRecallableLifecycle(record.lifecycleStatus)
    ? 2
    : record.lifecycleStatus === "candidate"
      ? 1
      : 0;
  const reviewRank = record.reviewState === "approved"
    ? 2
    : record.reviewState === "pending"
      ? 1
      : 0;
  return lifecycleRank * 10 + reviewRank;
}

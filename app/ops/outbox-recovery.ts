import type { WriteDatabaseState } from "../db/schema/tables";

export interface OutboxRecoverySummary {
  readonly pending: number;
  readonly failed: number;
  readonly dispatched_unverified: number;
}

export function summarizeOutboxRecovery(state: Pick<WriteDatabaseState, "outboxEvents">): OutboxRecoverySummary {
  return {
    pending: state.outboxEvents.filter((event) => event.dispatchStatus === "pending").length,
    failed: state.outboxEvents.filter((event) => event.dispatchStatus === "failed").length,
    dispatched_unverified: state.outboxEvents.filter((event) => event.dispatchStatus === "dispatched" && event.projectionVerified === false).length,
  };
}

import type { WriteDatabaseState } from "../db/schema/tables";

export interface DlqRecoverySummary {
  readonly dead_letter_candidates: number;
}

export function summarizeDlqRecovery(
  state: Pick<WriteDatabaseState, "outboxEvents">,
  maxAttempts = 5
): DlqRecoverySummary {
  return {
    dead_letter_candidates: state.outboxEvents.filter((event) => event.dispatchStatus === "failed" && event.attempts >= maxAttempts).length,
  };
}

import { createLogger } from "../shared/logger";

const log = createLogger("conflict-resolver");

export interface ConflictRecord {
  readonly id_a: string;
  readonly content_a: string;
  readonly importance_a: number;
  readonly created_at_a: string;
  readonly id_b: string;
  readonly content_b: string;
  readonly importance_b: number;
  readonly created_at_b: string;
}

export interface ConflictResolution {
  readonly winner_id: string;
  readonly loser_id: string;
  readonly reason: string;
}

export function resolveConflict(conflict: ConflictRecord): ConflictResolution {
  if (conflict.importance_a !== conflict.importance_b) {
    const winner = conflict.importance_a > conflict.importance_b ? "a" : "b";
    return {
      winner_id: winner === "a" ? conflict.id_a : conflict.id_b,
      loser_id: winner === "a" ? conflict.id_b : conflict.id_a,
      reason: "higher importance (" + String(winner === "a" ? conflict.importance_a : conflict.importance_b) + ")",
    };
  }

  if (conflict.created_at_a > conflict.created_at_b) {
    return { winner_id: conflict.id_a, loser_id: conflict.id_b, reason: "more recent (same importance)" };
  }

  return { winner_id: conflict.id_b, loser_id: conflict.id_a, reason: "more recent (same importance)" };
}

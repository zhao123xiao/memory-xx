import { createLogger } from "../shared/logger";

const log = createLogger("conflict-resolver");

export interface ConflictRecord {
  readonly id_a: string;
  readonly content_a: string;
  readonly importance_a: number;
  readonly created_at_a: string;
  readonly relation_type_a_to_b?: string;
  readonly fact_status_a?: string;
  readonly valid_at_a?: string | null;
  readonly invalid_at_a?: string | null;
  readonly source_trust_a?: number;
  readonly id_b: string;
  readonly content_b: string;
  readonly importance_b: number;
  readonly created_at_b: string;
  readonly relation_type_b_to_a?: string;
  readonly fact_status_b?: string;
  readonly valid_at_b?: string | null;
  readonly invalid_at_b?: string | null;
  readonly source_trust_b?: number;
}

export interface ConflictResolution {
  readonly winner_id: string;
  readonly loser_id: string;
  readonly reason: string;
}

type Side = "a" | "b";

function normalized(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function factSignals(conflict: ConflictRecord, side: Side): {
  readonly id: string;
  readonly otherId: string;
  readonly relationToOther: string;
  readonly factStatus: string;
  readonly invalidAt: string | null | undefined;
  readonly validAt: string | null | undefined;
  readonly sourceTrust: number;
} {
  if (side === "a") {
    return {
      id: conflict.id_a,
      otherId: conflict.id_b,
      relationToOther: normalized(conflict.relation_type_a_to_b),
      factStatus: normalized(conflict.fact_status_a) || "current",
      invalidAt: conflict.invalid_at_a,
      validAt: conflict.valid_at_a,
      sourceTrust: conflict.source_trust_a ?? 0
    };
  }
  return {
    id: conflict.id_b,
    otherId: conflict.id_a,
    relationToOther: normalized(conflict.relation_type_b_to_a),
    factStatus: normalized(conflict.fact_status_b) || "current",
    invalidAt: conflict.invalid_at_b,
    validAt: conflict.valid_at_b,
    sourceTrust: conflict.source_trust_b ?? 0
  };
}

function isCurrentValid(signal: ReturnType<typeof factSignals>): boolean {
  return signal.factStatus === "current" && !signal.invalidAt;
}

function isInvalidated(signal: ReturnType<typeof factSignals>): boolean {
  return Boolean(signal.invalidAt) || ["historical", "invalid", "superseded", "archived", "rejected"].includes(signal.factStatus);
}

function resolution(
  winner: ReturnType<typeof factSignals>,
  loser: ReturnType<typeof factSignals>,
  reason: string
): ConflictResolution {
  return {
    winner_id: winner.id,
    loser_id: loser.id,
    reason
  };
}

export function resolveConflict(conflict: ConflictRecord): ConflictResolution {
  const a = factSignals(conflict, "a");
  const b = factSignals(conflict, "b");
  const relationSignals = new Set([a.relationToOther, b.relationToOther].filter(Boolean));
  if (relationSignals.has("contradicts")) {
    if (isCurrentValid(a) && isInvalidated(b)) {
      return resolution(a, b, "current valid fact supersedes contradicted invalidated fact");
    }
    if (isCurrentValid(b) && isInvalidated(a)) {
      return resolution(b, a, "current valid fact supersedes contradicted invalidated fact");
    }
  }

  if (isCurrentValid(a) !== isCurrentValid(b)) {
    return isCurrentValid(a)
      ? resolution(a, b, "current valid fact")
      : resolution(b, a, "current valid fact");
  }

  if (a.sourceTrust !== b.sourceTrust) {
    return a.sourceTrust > b.sourceTrust
      ? resolution(a, b, `higher source trust (${a.sourceTrust})`)
      : resolution(b, a, `higher source trust (${b.sourceTrust})`);
  }

  const validAtDiff = timestamp(b.validAt) - timestamp(a.validAt);
  if (validAtDiff !== 0) {
    return validAtDiff > 0
      ? resolution(b, a, "newer validity window")
      : resolution(a, b, "newer validity window");
  }

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

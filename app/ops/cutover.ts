import {
  CutoverStage,
  ReadRoute,
  WriteAuthority,
  type BoundaryValidationResult,
  type CanaryAuditSummary,
  type CutoverBoundaryFreeze,
  type ReadRouteAuditEvent
} from "./types";

export function validateCutoverBoundary(boundary: CutoverBoundaryFreeze): BoundaryValidationResult {
  const reasons: string[] = [];

  if (boundary.dualWriteAllowed) {
    reasons.push("dual_write_forbidden");
  }

  if (boundary.stage === CutoverStage.M4ReadCanary) {
    if (boundary.writeAuthority !== WriteAuthority.Legacy) {
      reasons.push("m4_requires_legacy_write_authority");
    }
    if (boundary.newWriteCanAcceptProduction) {
      reasons.push("m4_cannot_enable_new_write_production");
    }
    if (boundary.readRoute === ReadRoute.Rollback && !boundary.legacyWriteFrozen) {
      // allowed, but keep neutral: rollback route itself is not a freeze signal
    }
  }

  if (boundary.stage === CutoverStage.M5WriteCutover) {
    if (boundary.writeAuthority !== WriteAuthority.RecallV2) {
      reasons.push("m5_requires_recall_v2_write_authority");
    }
    if (!boundary.legacyWriteFrozen) {
      reasons.push("m5_requires_legacy_write_freeze");
    }
    if (!boundary.newWriteCanAcceptProduction) {
      reasons.push("m5_requires_new_write_production");
    }
  }

  return {
    ok: reasons.length === 0,
    reasons
  };
}

export function summarizeReadRouteAudit(events: readonly ReadRouteAuditEvent[]): CanaryAuditSummary {
  const byReadPath: Record<string, number> = {
    legacy: 0,
    recall_v2: 0
  };

  let fallbackCount = 0;
  let rollbackMarkedCount = 0;

  for (const event of events) {
    byReadPath[event.readPath] = (byReadPath[event.readPath] ?? 0) + 1;
    if (event.fallbackTriggered) {
      fallbackCount += 1;
    }
    if (event.rollbackMarker) {
      rollbackMarkedCount += 1;
    }
  }

  return {
    totalEvents: events.length,
    byReadPath,
    fallbackCount,
    rollbackMarkedCount
  };
}

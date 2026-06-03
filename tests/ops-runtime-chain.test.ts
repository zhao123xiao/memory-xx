import assert from "node:assert/strict";
import test from "node:test";

import {
  ChecklistStatus,
  CutoverGateRuntimeChain,
  CutoverStage,
  GateDecision,
  ReadRoute,
  RollbackDrillOutcome,
  WriteAuthority
} from "../app";

test("cutover gate runtime chain emits a passing M4 evidence pack with rollback proof", async () => {
  const runtime = new CutoverGateRuntimeChain({ rollbackMaxDurationSeconds: 180 });

  const evidence = await runtime.run({
    generatedAt: "2026-04-13T12:00:00.000Z",
    boundary: {
      stage: CutoverStage.M4ReadCanary,
      readRoute: ReadRoute.Canary,
      writeAuthority: WriteAuthority.Legacy,
      legacyWriteFrozen: false,
      newWriteCanAcceptProduction: false,
      dualWriteAllowed: false,
      notes: "M4 only shifts reads for canary cohorts."
    },
    metrics: [
      { metricId: "query_pass_rate", actual: 0.98, sampleSize: 120 },
      { metricId: "default_filter_accuracy", actual: 1, sampleSize: 50 },
      { metricId: "zero_hit_regression_delta", actual: 0, sampleSize: 120 },
      { metricId: "cache_invalidation_accuracy", actual: 1, sampleSize: 20 }
    ],
    checklist: [
      { id: "m3_gate", label: "M3 gate 已通过", required: true, run: () => ChecklistStatus.Pass },
      { id: "scope_violation", label: "scope violation = 0", required: true, run: () => ChecklistStatus.Pass },
      { id: "rollback_switch", label: "旧读链可接管", required: true, run: () => ChecklistStatus.Pass }
    ],
    auditEvents: [
      {
        requestId: "req-1",
        readPath: "recall_v2",
        route: ReadRoute.Canary,
        cutoverWave: "wave-1",
        queryType: "project",
        allowedScopeSet: ["project:p-alpha"],
        fallbackTriggered: false
      },
      {
        requestId: "req-2",
        readPath: "legacy",
        route: ReadRoute.Rollback,
        cutoverWave: "wave-1",
        queryType: "timeline",
        allowedScopeSet: ["project:p-alpha"],
        fallbackTriggered: true,
        rollbackMarker: "stop-condition-1"
      }
    ],
    rollbackDrill: {
      drillId: "r1",
      stage: CutoverStage.M4ReadCanary,
      restoredReadRoute: ReadRoute.Legacy,
      restoredWriteAuthority: WriteAuthority.Legacy,
      durationSeconds: 90,
      steps: [
        { stepId: "freeze-canary", status: RollbackDrillOutcome.Pass, detail: "wave disabled" },
        { stepId: "route-back", status: RollbackDrillOutcome.Pass, detail: "legacy route restored" }
      ]
    }
  });

  assert.equal(evidence.scorecard.decision, GateDecision.Pass);
  assert.equal(evidence.scorecard.readyForNextStage, true);
  assert.equal(evidence.boundaryValidation.ok, true);
  assert.equal(evidence.gate.decision, GateDecision.Pass);
  assert.equal(evidence.checklist.status, GateDecision.Pass);
  assert.equal(evidence.canaryAudit.totalEvents, 2);
  assert.equal(evidence.canaryAudit.fallbackCount, 1);
  assert.equal(evidence.canaryAudit.rollbackMarkedCount, 1);
  assert.equal(evidence.rollback?.outcome, RollbackDrillOutcome.Pass);
});

test("cutover gate runtime chain blocks M5 when dual-write or rollback failure exists", async () => {
  const runtime = new CutoverGateRuntimeChain({ rollbackMaxDurationSeconds: 60 });

  const evidence = await runtime.run({
    boundary: {
      stage: CutoverStage.M5WriteCutover,
      readRoute: ReadRoute.RecallV2,
      writeAuthority: WriteAuthority.Legacy,
      legacyWriteFrozen: false,
      newWriteCanAcceptProduction: true,
      dualWriteAllowed: true,
      notes: "invalid freeze state"
    },
    metrics: [
      { metricId: "idempotency_conflict_accuracy", actual: 1 },
      { metricId: "projection_consistency_accuracy", actual: 1 },
      { metricId: "legacy_write_ingress_after_freeze", actual: 3 },
      { metricId: "dual_write_incidents", actual: 1 }
    ],
    checklist: [
      { id: "m4_gate", label: "M4 gate 已通过", required: true, run: () => ChecklistStatus.Pass },
      { id: "write_ingress_inventory", label: "全部写入口已盘点", required: true, run: () => ChecklistStatus.Fail }
    ],
    auditEvents: [],
    rollbackDrill: {
      drillId: "r3",
      stage: CutoverStage.M5WriteCutover,
      restoredReadRoute: ReadRoute.Legacy,
      restoredWriteAuthority: WriteAuthority.Legacy,
      durationSeconds: 120,
      steps: [
        { stepId: "freeze-new-write", status: RollbackDrillOutcome.Pass, detail: "new write frozen" },
        { stepId: "restore-legacy", status: RollbackDrillOutcome.Fail, detail: "legacy write did not recover" }
      ]
    }
  });

  assert.equal(evidence.scorecard.decision, GateDecision.Hold);
  assert.equal(evidence.scorecard.readyForNextStage, false);
  assert.deepEqual(evidence.boundaryValidation.reasons, [
    "dual_write_forbidden",
    "m5_requires_recall_v2_write_authority",
    "m5_requires_legacy_write_freeze"
  ]);
  assert.equal(evidence.gate.decision, GateDecision.Hold);
  assert.ok(evidence.scorecard.blockingReasons.includes("dual_write_incidents:threshold_not_met"));
  assert.ok(evidence.scorecard.blockingReasons.includes("write_ingress_inventory"));
  assert.ok(evidence.scorecard.blockingReasons.includes("rollback_exceeded_slo"));
  assert.ok(evidence.scorecard.blockingReasons.includes("step_failed:restore-legacy"));
});

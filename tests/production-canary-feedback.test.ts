import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCandidateOnlyExitReadiness,
  buildProductionCanaryFeedbackReport,
} from "../app";

test("candidate-only exit readiness blocks when real canary feedback is still insufficient", () => {
  const readiness = buildCandidateOnlyExitReadiness({
    candidateOnlyEnabled: true,
    productionGuardOk: true,
    consecutiveP1PassDays: 2,
    minRealFeedbackSamples: 20,
    maxRollbackRate: 0.03,
    window7d: {
      total_real_decisions: 8,
      auto_approved_default: 5,
      auto_approved_explicit_issue: 1,
      auto_rejected_unknown: 1,
      auto_rejected_test_noise: 1,
      auto_rejected_sensitive: 0,
      rollback_count: 0,
      false_positive_count: 0,
      false_negative_count: 0,
      default_leakage: 0,
      explicit_only_default_recall_leakage: 0,
      test_noise_default_recall_leakage: 0,
      unknown_sensitive_or_test_noise_auto_approve: 0,
      unmarked_real_decisions_excluded: 0,
    },
    runtime: {
      pending_current: 0,
      qdrant_drift: 0,
    },
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.candidate_only_exit_ready, false);
  assert.match(readiness.blockers.join(","), /insufficient_real_feedback:8\/20/u);
  assert.match(readiness.blockers.join(","), /p1_gate_not_stable:2\/7/u);
});

test("candidate-only exit readiness passes only with stable canary feedback and zero leakage", () => {
  const readiness = buildCandidateOnlyExitReadiness({
    candidateOnlyEnabled: true,
    productionGuardOk: true,
    consecutiveP1PassDays: 7,
    minRealFeedbackSamples: 20,
    maxRollbackRate: 0.03,
    window7d: {
      total_real_decisions: 42,
      auto_approved_default: 24,
      auto_approved_explicit_issue: 4,
      auto_rejected_unknown: 5,
      auto_rejected_test_noise: 7,
      auto_rejected_sensitive: 2,
      rollback_count: 0,
      false_positive_count: 0,
      false_negative_count: 1,
      default_leakage: 0,
      explicit_only_default_recall_leakage: 0,
      test_noise_default_recall_leakage: 0,
      unknown_sensitive_or_test_noise_auto_approve: 0,
      unmarked_real_decisions_excluded: 0,
    },
    runtime: {
      pending_current: 0,
      qdrant_drift: 0,
    },
  });

  assert.equal(readiness.ready, true);
  assert.equal(readiness.candidate_only_exit_ready, true);
  assert.deepEqual(readiness.blockers, []);
});

test("production canary feedback report keeps update trial in dry-run before real apply", () => {
  const report = buildProductionCanaryFeedbackReport({
    runId: "memory-production-canary-7d-v1",
    generatedAt: "2026-06-01T00:00:00.000Z",
    candidateOnlyEnabled: true,
    productionGuardOk: true,
    consecutiveP1PassDays: 7,
    windows: {
      last_24h: {
        total_real_decisions: 20,
        auto_approved_default: 10,
        auto_approved_explicit_issue: 2,
        auto_rejected_unknown: 3,
        auto_rejected_test_noise: 4,
        auto_rejected_sensitive: 1,
        rollback_count: 0,
        false_positive_count: 0,
        false_negative_count: 0,
        default_leakage: 0,
        explicit_only_default_recall_leakage: 0,
        test_noise_default_recall_leakage: 0,
        unknown_sensitive_or_test_noise_auto_approve: 0,
        unmarked_real_decisions_excluded: 0,
      },
      last_7d: {
        total_real_decisions: 50,
        auto_approved_default: 28,
        auto_approved_explicit_issue: 5,
        auto_rejected_unknown: 6,
        auto_rejected_test_noise: 9,
        auto_rejected_sensitive: 2,
        rollback_count: 0,
        false_positive_count: 0,
        false_negative_count: 1,
        default_leakage: 0,
        explicit_only_default_recall_leakage: 0,
        test_noise_default_recall_leakage: 0,
        unknown_sensitive_or_test_noise_auto_approve: 0,
        unmarked_real_decisions_excluded: 0,
      },
    },
    runtime: {
      pending_current: 0,
      qdrant_drift: 0,
    },
    updateDryRun: {
      scope: "project:memory-xx",
      candidate_count: 3,
      action_counts: { supersede_dry_run: 2, refresh_dry_run: 1 },
      wrong_scope_count: 0,
      default_recall_leakage: 0,
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.run_id, "memory-production-canary-7d-v1");
  assert.equal(report.candidate_only_exit_readiness.candidate_only_exit_ready, true);
  assert.equal(report.update_supersede_trial.mode, "dry_run_only");
  assert.equal(report.update_supersede_trial.real_apply_enabled, false);
  assert.equal(report.update_supersede_trial.scope, "project:memory-xx");
});

test("candidate-only exit readiness blocks when real-scope decisions are not canary-instrumented", () => {
  const readiness = buildCandidateOnlyExitReadiness({
    candidateOnlyEnabled: true,
    productionGuardOk: true,
    consecutiveP1PassDays: 7,
    minRealFeedbackSamples: 20,
    maxRollbackRate: 0.03,
    window7d: {
      total_real_decisions: 0,
      auto_approved_default: 0,
      auto_approved_explicit_issue: 0,
      auto_rejected_unknown: 0,
      auto_rejected_test_noise: 0,
      auto_rejected_sensitive: 0,
      rollback_count: 0,
      false_positive_count: 0,
      false_negative_count: 0,
      default_leakage: 0,
      explicit_only_default_recall_leakage: 0,
      test_noise_default_recall_leakage: 0,
      unknown_sensitive_or_test_noise_auto_approve: 0,
      unmarked_real_decisions_excluded: 29,
    },
    runtime: {
      pending_current: 0,
      qdrant_drift: 0,
    },
  });

  assert.equal(readiness.candidate_only_exit_ready, false);
  assert.match(readiness.blockers.join(","), /production_canary_feedback_not_instrumented:29/u);
  assert.match(readiness.blockers.join(","), /insufficient_real_feedback:0\/20/u);
});

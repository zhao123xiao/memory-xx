import assert from "node:assert/strict";
import test from "node:test";

import { buildMemoryPolicyReport } from "../app/governance/memory-policy-report";

test("policy report summarizes recent policy action and recall isolation evidence", () => {
  const report = buildMemoryPolicyReport({
    now: "2026-06-01T00:00:00.000Z",
    decisions: [
      {
        decided_at: "2026-05-31T23:00:00.000Z",
        memory_class: "runtime_noise",
        policy_action: "reject_by_policy",
        recall_policy: "never",
      },
      {
        decided_at: "2026-05-30T00:00:00.000Z",
        memory_class: "unknown_source_quarantine",
        policy_action: "quarantine_candidate",
        recall_policy: "never",
      },
      {
        decided_at: "2026-05-20T00:00:00.000Z",
        memory_class: "test_evidence",
        policy_action: "create_candidate",
        recall_policy: "test_only",
      },
    ],
    compareObservationCount: 0,
  });

  assert.equal(report.windows.last_24h.policy_actions.reject_by_policy, 1);
  assert.equal(report.windows.last_7d.policy_actions.quarantine_candidate, 1);
  assert.equal(report.windows.last_7d.recall_policies.never, 2);
  assert.equal(report.windows.last_7d.memory_classes.unknown_source_quarantine, 1);
  assert.equal(report.compare_observations.status, "below_minimum");
  assert.match(report.compare_observations.recommended_command, /memory:intelligence-quality/u);
});

test("policy report separates legacy unknown records and reports policy coverage", () => {
  const report = buildMemoryPolicyReport({
    now: "2026-06-01T00:00:00.000Z",
    decisions: [
      {
        decided_at: "2026-05-31T23:00:00.000Z",
        memory_class: "runtime_noise",
        policy_action: "reject_by_policy",
        recall_policy: "never",
        has_policy_fields: true,
      },
      {
        decided_at: "2026-05-31T22:00:00.000Z",
        memory_class: null,
        policy_action: null,
        recall_policy: null,
        has_policy_fields: false,
        legacy: true,
      },
      {
        decided_at: "2026-05-31T21:00:00.000Z",
        memory_class: "unknown_source_quarantine",
        policy_action: "quarantine_candidate",
        recall_policy: "never",
        has_policy_fields: true,
      },
    ],
    compareObservationCount: 20,
    latestCompareObservationAt: "2026-05-31T23:30:00.000Z",
  });

  assert.equal(report.windows.last_24h.total, 3);
  assert.equal(report.windows.last_24h.memory_classes.legacy_unknown, 1);
  assert.equal(report.windows.last_24h.memory_classes.unknown_source_quarantine, 1);
  assert.equal(report.windows.last_24h.policy_coverage_rate, 2 / 3);
  assert.equal(report.compare_observations.status, "ok");
  assert.equal(report.compare_observations.latest_observed_at, "2026-05-31T23:30:00.000Z");
});

test("policy report summarizes autonomous closure counters", () => {
  const report = buildMemoryPolicyReport({
    now: "2026-06-01T00:00:00.000Z",
    decisions: [
      {
        decided_at: "2026-05-31T23:00:00.000Z",
        memory_class: "long_term_fact",
        policy_action: "create_memory",
        recall_policy: "default",
        autonomous_action: "approve_default",
      },
      {
        decided_at: "2026-05-31T22:00:00.000Z",
        memory_class: "operational_issue",
        policy_action: "create_memory",
        recall_policy: "explicit_only",
        autonomous_action: "approve_explicit_issue",
      },
      {
        decided_at: "2026-05-31T21:00:00.000Z",
        memory_class: "unknown_source_quarantine",
        policy_action: "reject_by_policy",
        recall_policy: "never",
        autonomous_action: "reject_unknown_source",
      },
      {
        decided_at: "2026-05-31T20:00:00.000Z",
        memory_class: "test_evidence",
        policy_action: "reject_by_policy",
        recall_policy: "never",
        autonomous_action: "reject_test_noise",
      },
      {
        decided_at: "2026-05-31T19:00:00.000Z",
        memory_class: "runtime_noise",
        policy_action: "reject_by_policy",
        recall_policy: "never",
        autonomous_action: "reject_sensitive",
      },
    ],
    compareObservationCount: 20,
  });

  assert.equal(report.windows.last_24h.autonomous_closure.auto_approved_default, 1);
  assert.equal(report.windows.last_24h.autonomous_closure.auto_approved_explicit_issue, 1);
  assert.equal(report.windows.last_24h.autonomous_closure.auto_rejected_unknown, 1);
  assert.equal(report.windows.last_24h.autonomous_closure.auto_rejected_test_noise, 1);
  assert.equal(report.windows.last_24h.autonomous_closure.auto_rejected_sensitive, 1);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProductionCanaryRuntimeControls,
  defaultAutoApprovalRuntimeControls,
  evaluateProductionCanaryGuard,
  type AutoApprovalProductionGuardInput,
} from "../app";

function baseInput(overrides: Partial<AutoApprovalProductionGuardInput> = {}): AutoApprovalProductionGuardInput {
  const controls = defaultAutoApprovalRuntimeControls();
  return {
    candidateOnly: { enabled: true, reasons: ["false_positive_proxy_high"] },
    runtimeControls: {
      ...controls,
      user: {
        ...controls.user,
        enabled: true,
        add_only: true,
        stable_preference: true,
        constraint: true,
        candidate_only_bypass: true,
      },
      global: {
        ...controls.global,
        enabled: false,
        add_only: false,
        candidate_only_bypass: false,
      },
      update_apply: {
        ...controls.update_apply,
        enabled: false,
        real_project_apply: false,
        workspace_apply: false,
        user_apply: false,
        global_apply: false,
        merge_apply: false,
        preference_change_apply: false,
      },
    },
    realScopeEnablements: [
      {
        scope: "project:memory-xx",
        enabled: true,
        agents: ["codex"],
        allowed_sources: ["conversation_ingest"],
        allowed_operations: ["add"],
      },
      {
        scope: "user:current-user",
        enabled: true,
        agents: ["codex"],
        allowed_sources: ["conversation_ingest"],
        allowed_operations: ["add"],
      },
      {
        scope: "global:global",
        enabled: false,
        agents: ["codex"],
        allowed_sources: ["conversation_ingest"],
        allowed_operations: ["add"],
      },
    ],
    runtimeStatus: { runtime_ok: true, systemd_timer_probe_ok: false },
    qdrantReconcile: { ok: true, stale: 0, missing: 0, payload_drift: 0, orphan: 0 },
    pendingStatus: { ok: true, candidate_current: 0 },
    p1Gate: { ok: true, status: "pass", blockers: [], warnings: [] },
    trainingBaselines: [
      {
        run_id: "memory-benchmark-10k-v1",
        progress_percent: 90,
        production_readiness_score: 1,
        default_leakage: 0,
      },
      {
        run_id: "memory-benchmark-50k-v1",
        progress_percent: 90,
        production_readiness_score: 1,
        default_leakage: 0,
        normalized: 50000,
        hard_negatives: 40615,
      },
    ],
    ...overrides,
  };
}

test("production canary guard passes only project/user add-only with runtime and training evidence", () => {
  const result = evaluateProductionCanaryGuard(baseInput());

  assert.equal(result.ok, true);
  assert.equal(result.mode, "project_user_add_only");
  assert.deepEqual(result.allowed_real_scopes, ["project:memory-xx", "user:current-user"]);
  assert.deepEqual(result.blockers, []);
  assert.match(result.warnings.join(","), /timer_probe_unavailable/u);
  assert.match(result.warnings.join(","), /hard_negative_ratio_high/u);
});

test("production canary guard blocks global scope and real update apply", () => {
  const input = baseInput();
  const result = evaluateProductionCanaryGuard({
    ...input,
    realScopeEnablements: [
      ...input.realScopeEnablements,
      {
        scope: "global:global",
        enabled: true,
        agents: ["codex"],
        allowed_sources: ["conversation_ingest"],
        allowed_operations: ["add"],
      },
    ],
    runtimeControls: {
      ...input.runtimeControls,
      global: {
        ...input.runtimeControls.global,
        enabled: true,
        add_only: true,
        fact: true,
        candidate_only_bypass: true,
      },
      update_apply: {
        ...input.runtimeControls.update_apply,
        enabled: true,
        real_project_apply: true,
        user_apply: true,
        global_apply: true,
      },
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.blockers.join(","), /unexpected_real_scope:global:global/u);
  assert.match(result.blockers.join(","), /global_auto_approval_enabled/u);
  assert.match(result.blockers.join(","), /real_update_apply_enabled/u);
});

test("production canary guard blocks runtime, qdrant, pending, p1, and training failures", () => {
  const result = evaluateProductionCanaryGuard(baseInput({
    runtimeStatus: { runtime_ok: false, systemd_timer_probe_ok: false },
    qdrantReconcile: { ok: false, stale: 1, missing: 0, payload_drift: 0, orphan: 0 },
    pendingStatus: { ok: false, candidate_current: 2 },
    p1Gate: { ok: false, status: "blocked", blockers: ["sample_blocker"], warnings: [] },
    trainingBaselines: [
      {
        run_id: "memory-benchmark-10k-v1",
        progress_percent: 80,
        production_readiness_score: 0.89,
        default_leakage: 1,
      },
    ],
  }));

  assert.equal(result.ok, false);
  assert.match(result.blockers.join(","), /runtime_unhealthy/u);
  assert.match(result.blockers.join(","), /qdrant_drift_nonzero/u);
  assert.match(result.blockers.join(","), /pending_backlog_nonzero/u);
  assert.match(result.blockers.join(","), /p1_gate_failed/u);
  assert.match(result.blockers.join(","), /training_baseline_not_ready:memory-benchmark-10k-v1/u);
});

test("production canary runtime transform keeps only user add-only and disables global/update apply", () => {
  const controls = buildProductionCanaryRuntimeControls({
    ...defaultAutoApprovalRuntimeControls(),
    user: {
      enabled: false,
      add_only: false,
      stable_preference: false,
      constraint: false,
      decision: true,
      candidate_only_bypass: false,
      pii_allowlist: true,
    },
    global: {
      enabled: true,
      add_only: true,
      fact: true,
      constraint: true,
      procedure: true,
      candidate_only_bypass: true,
    },
    update_apply: {
      enabled: true,
      test_scope_apply: true,
      real_project_apply: true,
      workspace_apply: true,
      user_apply: true,
      global_apply: true,
      explicit_replacement: true,
      same_fact_refresh: true,
      temporal_expiry: true,
      merge_apply: true,
      preference_change_apply: true,
      max_hourly_per_scope: 9,
    },
  });

  assert.equal(controls.user.enabled, true);
  assert.equal(controls.user.add_only, true);
  assert.equal(controls.user.stable_preference, true);
  assert.equal(controls.user.constraint, true);
  assert.equal(controls.user.decision, false);
  assert.equal(controls.user.candidate_only_bypass, true);
  assert.equal(controls.user.pii_allowlist, false);
  assert.equal(controls.global.enabled, false);
  assert.equal(controls.global.candidate_only_bypass, false);
  assert.equal(controls.update_apply.enabled, false);
  assert.equal(controls.update_apply.real_project_apply, false);
  assert.equal(controls.update_apply.workspace_apply, false);
  assert.equal(controls.update_apply.user_apply, false);
  assert.equal(controls.update_apply.global_apply, false);
  assert.equal(controls.update_apply.merge_apply, false);
  assert.equal(controls.update_apply.preference_change_apply, false);
});

import type { AutoApprovalRuntimeControls } from "./auto-approval-runtime-controls";

export interface ProductionGuardScopeEnablement {
  readonly scope: string;
  readonly enabled: boolean;
  readonly agents?: readonly string[];
  readonly allowed_sources?: readonly string[];
  readonly allowed_operations?: readonly string[];
}

export interface ProductionGuardTrainingBaseline {
  readonly run_id: string;
  readonly progress_percent?: number;
  readonly production_readiness_score?: number;
  readonly default_leakage?: number;
  readonly normalized?: number;
  readonly hard_negatives?: number;
}

export interface AutoApprovalProductionGuardInput {
  readonly candidateOnly: { readonly enabled: boolean; readonly reasons: readonly string[] };
  readonly runtimeControls: AutoApprovalRuntimeControls;
  readonly realScopeEnablements: readonly ProductionGuardScopeEnablement[];
  readonly runtimeStatus?: { readonly runtime_ok?: boolean; readonly systemd_timer_probe_ok?: boolean } | null;
  readonly qdrantReconcile?: {
    readonly ok?: boolean;
    readonly stale?: number;
    readonly missing?: number;
    readonly payload_drift?: number;
    readonly orphan?: number;
  } | null;
  readonly pendingStatus?: { readonly ok?: boolean; readonly candidate_current?: number } | null;
  readonly p1Gate?: { readonly ok?: boolean; readonly status?: string; readonly blockers?: readonly string[]; readonly warnings?: readonly string[] } | null;
  readonly trainingBaselines?: readonly ProductionGuardTrainingBaseline[];
}

export interface AutoApprovalProductionGuardResult {
  readonly ok: boolean;
  readonly mode: "project_user_add_only";
  readonly allowed_real_scopes: readonly string[];
  readonly enabled_real_scopes: readonly string[];
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly candidate_only: AutoApprovalProductionGuardInput["candidateOnly"];
  readonly update_apply_enablement: AutoApprovalRuntimeControls["update_apply"];
  readonly training_baselines: readonly ProductionGuardTrainingBaseline[];
}

const REQUIRED_ADD_ONLY_SCOPES = ["project:memory-xx", "user:current-user"] as const;
const ALLOWED_ADD_ONLY_SCOPES = new Set<string>(REQUIRED_ADD_ONLY_SCOPES);
const REAL_UPDATE_FLAGS = ["real_project_apply", "workspace_apply", "user_apply", "global_apply"] as const;

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function buildProductionCanaryRuntimeControls(current: AutoApprovalRuntimeControls): AutoApprovalRuntimeControls {
  return {
    ...current,
    user: {
      ...current.user,
      enabled: true,
      add_only: true,
      stable_preference: true,
      constraint: true,
      decision: false,
      candidate_only_bypass: true,
      pii_allowlist: false,
    },
    global: {
      ...current.global,
      enabled: false,
      add_only: false,
      fact: false,
      constraint: false,
      procedure: false,
      candidate_only_bypass: false,
    },
    update_apply: {
      ...current.update_apply,
      enabled: false,
      real_project_apply: false,
      workspace_apply: false,
      user_apply: false,
      global_apply: false,
      merge_apply: false,
      preference_change_apply: false,
    },
  };
}

export function evaluateProductionCanaryGuard(input: AutoApprovalProductionGuardInput): AutoApprovalProductionGuardResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const enabledScopes = [...new Set(input.realScopeEnablements.filter((item) => item.enabled).map((item) => item.scope))].sort();

  for (const required of REQUIRED_ADD_ONLY_SCOPES) {
    if (!enabledScopes.includes(required)) blockers.push(`required_scope_missing:${required}`);
  }
  for (const scope of enabledScopes) {
    if (!ALLOWED_ADD_ONLY_SCOPES.has(scope)) blockers.push(`unexpected_real_scope:${scope}`);
  }
  for (const item of input.realScopeEnablements.filter((row) => row.enabled)) {
    const operations = item.allowed_operations && item.allowed_operations.length > 0 ? item.allowed_operations : ["add"];
    if (operations.some((operation) => operation !== "add")) blockers.push(`non_add_operation_enabled:${item.scope}`);
  }

  const controls = input.runtimeControls;
  if (!controls.user.enabled || !controls.user.add_only || !controls.user.candidate_only_bypass) {
    blockers.push("user_add_only_bypass_disabled");
  }
  if (!controls.user.stable_preference || !controls.user.constraint || controls.user.decision || controls.user.pii_allowlist) {
    blockers.push("user_add_only_policy_not_restricted");
  }
  if (controls.global.enabled || controls.global.add_only || controls.global.candidate_only_bypass || controls.global.fact || controls.global.constraint || controls.global.procedure) {
    blockers.push("global_auto_approval_enabled");
  }
  if (controls.update_apply.enabled || REAL_UPDATE_FLAGS.some((flag) => controls.update_apply[flag])) {
    blockers.push("real_update_apply_enabled");
  }
  if (controls.update_apply.merge_apply || controls.update_apply.preference_change_apply) {
    blockers.push("high_risk_update_apply_mode_enabled");
  }

  if (input.runtimeStatus) {
    if (input.runtimeStatus.runtime_ok === false) blockers.push("runtime_unhealthy");
    if (input.runtimeStatus.systemd_timer_probe_ok === false) warnings.push("timer_probe_unavailable");
  } else {
    warnings.push("runtime_status_missing");
  }

  const qdrant = input.qdrantReconcile;
  if (qdrant) {
    const drift = numberValue(qdrant.stale) + numberValue(qdrant.missing) + numberValue(qdrant.payload_drift) + numberValue(qdrant.orphan);
    if (qdrant.ok === false || drift !== 0) blockers.push("qdrant_drift_nonzero");
  } else {
    warnings.push("qdrant_reconcile_missing");
  }

  if (input.pendingStatus) {
    if (input.pendingStatus.ok === false || numberValue(input.pendingStatus.candidate_current) !== 0) blockers.push("pending_backlog_nonzero");
  } else {
    warnings.push("pending_status_missing");
  }

  if (input.p1Gate) {
    if (input.p1Gate.ok === false || (input.p1Gate.status && input.p1Gate.status !== "pass")) blockers.push("p1_gate_failed");
  } else {
    warnings.push("p1_gate_missing");
  }

  const baselines = input.trainingBaselines ?? [];
  if (baselines.length === 0) warnings.push("training_baselines_missing");
  for (const baseline of baselines) {
    const ready = numberValue(baseline.progress_percent) >= 90
      && numberValue(baseline.production_readiness_score) >= 0.9
      && numberValue(baseline.default_leakage) === 0;
    if (!ready) blockers.push(`training_baseline_not_ready:${baseline.run_id}`);
    const normalized = numberValue(baseline.normalized);
    const hardNegatives = numberValue(baseline.hard_negatives);
    if (normalized > 0 && hardNegatives / normalized > 0.5) warnings.push(`hard_negative_ratio_high:${baseline.run_id}`);
  }

  return {
    ok: blockers.length === 0,
    mode: "project_user_add_only",
    allowed_real_scopes: [...REQUIRED_ADD_ONLY_SCOPES],
    enabled_real_scopes: enabledScopes,
    blockers,
    warnings: [...new Set(warnings)],
    candidate_only: input.candidateOnly,
    update_apply_enablement: controls.update_apply,
    training_baselines: baselines,
  };
}

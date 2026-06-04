import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AutoApprovalRuntimeControls {
  readonly version: 1;
  readonly updated_at?: string;
  readonly user: {
    readonly enabled: boolean;
    readonly add_only: boolean;
    readonly stable_preference: boolean;
    readonly constraint: boolean;
    readonly decision: boolean;
    readonly candidate_only_bypass: boolean;
    readonly pii_allowlist: boolean;
  };
  readonly global: {
    readonly enabled: boolean;
    readonly add_only: boolean;
    readonly fact: boolean;
    readonly constraint: boolean;
    readonly procedure: boolean;
    readonly candidate_only_bypass: boolean;
  };
  readonly update_apply: {
    readonly enabled: boolean;
    readonly test_scope_apply: boolean;
    readonly real_project_apply: boolean;
    readonly workspace_apply: boolean;
    readonly user_apply: boolean;
    readonly global_apply: boolean;
    readonly explicit_replacement: boolean;
    readonly same_fact_refresh: boolean;
    readonly temporal_expiry: boolean;
    readonly merge_apply: boolean;
    readonly preference_change_apply: boolean;
    readonly max_hourly_per_scope: number;
  };
}

export const AUTO_APPROVAL_RUNTIME_CONTROLS_FILE = "auto-approval-runtime-controls.json";

export function autoApprovalRuntimeControlsPath(): string {
  const runtimeDir = process.env.MEMORY_XX_RUNTIME_DIR?.trim() || join(process.cwd(), ".runtime");
  return join(runtimeDir, AUTO_APPROVAL_RUNTIME_CONTROLS_FILE);
}

export function defaultAutoApprovalRuntimeControls(): AutoApprovalRuntimeControls {
  return {
    version: 1,
    user: {
      enabled: false,
      add_only: false,
      stable_preference: false,
      constraint: false,
      decision: false,
      candidate_only_bypass: false,
      pii_allowlist: false,
    },
    global: {
      enabled: false,
      add_only: false,
      fact: false,
      constraint: false,
      procedure: false,
      candidate_only_bypass: false,
    },
    update_apply: {
      enabled: false,
      test_scope_apply: true,
      real_project_apply: false,
      workspace_apply: false,
      user_apply: false,
      global_apply: false,
      explicit_replacement: true,
      same_fact_refresh: true,
      temporal_expiry: true,
      merge_apply: false,
      preference_change_apply: false,
      max_hourly_per_scope: 3,
    },
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeAutoApprovalRuntimeControls(value: unknown): AutoApprovalRuntimeControls {
  const defaults = defaultAutoApprovalRuntimeControls();
  const root = objectValue(value);
  const user = objectValue(root.user);
  const global = objectValue(root.global);
  const updateApply = objectValue(root.update_apply);
  return {
    version: 1,
    ...(typeof root.updated_at === "string" ? { updated_at: root.updated_at } : {}),
    user: {
      enabled: boolValue(user.enabled, defaults.user.enabled),
      add_only: boolValue(user.add_only, defaults.user.add_only),
      stable_preference: boolValue(user.stable_preference, defaults.user.stable_preference),
      constraint: boolValue(user.constraint, defaults.user.constraint),
      decision: boolValue(user.decision, defaults.user.decision),
      candidate_only_bypass: boolValue(user.candidate_only_bypass, defaults.user.candidate_only_bypass),
      pii_allowlist: boolValue(user.pii_allowlist, defaults.user.pii_allowlist),
    },
    global: {
      enabled: boolValue(global.enabled, defaults.global.enabled),
      add_only: boolValue(global.add_only, defaults.global.add_only),
      fact: boolValue(global.fact, defaults.global.fact),
      constraint: boolValue(global.constraint, defaults.global.constraint),
      procedure: boolValue(global.procedure, defaults.global.procedure),
      candidate_only_bypass: boolValue(global.candidate_only_bypass, defaults.global.candidate_only_bypass),
    },
    update_apply: {
      enabled: boolValue(updateApply.enabled, defaults.update_apply.enabled),
      test_scope_apply: boolValue(updateApply.test_scope_apply, defaults.update_apply.test_scope_apply),
      real_project_apply: boolValue(updateApply.real_project_apply, defaults.update_apply.real_project_apply),
      workspace_apply: boolValue(updateApply.workspace_apply, defaults.update_apply.workspace_apply),
      user_apply: boolValue(updateApply.user_apply, defaults.update_apply.user_apply),
      global_apply: boolValue(updateApply.global_apply, defaults.update_apply.global_apply),
      explicit_replacement: boolValue(updateApply.explicit_replacement, defaults.update_apply.explicit_replacement),
      same_fact_refresh: boolValue(updateApply.same_fact_refresh, defaults.update_apply.same_fact_refresh),
      temporal_expiry: boolValue(updateApply.temporal_expiry, defaults.update_apply.temporal_expiry),
      merge_apply: boolValue(updateApply.merge_apply, defaults.update_apply.merge_apply),
      preference_change_apply: boolValue(updateApply.preference_change_apply, defaults.update_apply.preference_change_apply),
      max_hourly_per_scope: numberValue(updateApply.max_hourly_per_scope, defaults.update_apply.max_hourly_per_scope),
    },
  };
}

export function readAutoApprovalRuntimeControlsSync(): AutoApprovalRuntimeControls {
  try {
    return normalizeAutoApprovalRuntimeControls(JSON.parse(readFileSync(autoApprovalRuntimeControlsPath(), "utf8")) as unknown);
  } catch {
    return defaultAutoApprovalRuntimeControls();
  }
}

export function writeAutoApprovalRuntimeControlsSync(next: AutoApprovalRuntimeControls): void {
  const file = autoApprovalRuntimeControlsPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...next, updated_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

export function runtimeControlsUserMemoryTypes(controls = readAutoApprovalRuntimeControlsSync()): readonly string[] {
  const types: string[] = [];
  if (controls.user.stable_preference) types.push("preference");
  if (controls.user.constraint) types.push("constraint");
  if (controls.user.decision) types.push("decision");
  return types;
}

export function runtimeControlsGlobalMemoryTypes(controls = readAutoApprovalRuntimeControlsSync()): readonly string[] {
  const types: string[] = [];
  if (controls.global.fact) types.push("fact");
  if (controls.global.constraint) types.push("constraint");
  if (controls.global.procedure) types.push("procedure", "procedural");
  return types;
}

export function isRuntimeUserAddApprovalEnabled(controls = readAutoApprovalRuntimeControlsSync()): boolean {
  return controls.user.enabled && controls.user.add_only && runtimeControlsUserMemoryTypes(controls).length > 0;
}

export function isRuntimeGlobalAddApprovalEnabled(controls = readAutoApprovalRuntimeControlsSync()): boolean {
  return controls.global.enabled && controls.global.add_only && runtimeControlsGlobalMemoryTypes(controls).length > 0;
}

export function isTestAutoUpdateApplyScope(scopeType: string, scopeId: string): boolean {
  return scopeType === "project" && /^auto-update-test-[a-z0-9-]+$/iu.test(scopeId);
}

export function isRuntimeAutoUpdateApplyScopeEnabled(scopeType: string, scopeId: string, controls = readAutoApprovalRuntimeControlsSync()): boolean {
  if (isTestAutoUpdateApplyScope(scopeType, scopeId)) return controls.update_apply.test_scope_apply;
  if (!controls.update_apply.enabled) return false;
  if (scopeType === "project") return scopeId === "memory-xx" && controls.update_apply.real_project_apply;
  if (scopeType === "workspace") return scopeId === "current-instance" && controls.update_apply.workspace_apply;
  if (scopeType === "user") return scopeId === "current-user" && controls.update_apply.user_apply;
  if (scopeType === "global") return scopeId === "global" && controls.update_apply.global_apply;
  return false;
}

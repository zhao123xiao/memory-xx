import { buildRuntimeModulePlan, RUNTIME_MODULES, type RuntimeModule } from "./runtime-modules";

export type MemoryRuntimeProfile = "core" | "enhanced" | "full";

export type RuntimeComponentKind = "http" | "external" | "systemd" | "gate";

export type RuntimeProfileComponent = RuntimeModule & {
  readonly name: string;
  readonly label: string;
  readonly kind: RuntimeComponentKind;
  readonly required_in: readonly MemoryRuntimeProfile[];
  readonly expected_in?: readonly MemoryRuntimeProfile[];
  readonly degraded_behavior: string;
  readonly service?: string;
  readonly health_url?: string;
  readonly command?: string;
  readonly startable?: boolean;
  readonly stop_with_profile?: boolean;
};

export interface RuntimeProfilePlan {
  readonly profile: MemoryRuntimeProfile;
  readonly required_components: readonly RuntimeProfileComponent[];
  readonly expected_components: readonly RuntimeProfileComponent[];
  readonly optional_components: readonly RuntimeProfileComponent[];
  readonly full_gates: readonly RuntimeProfileComponent[];
}

const PROFILE_ORDER: readonly MemoryRuntimeProfile[] = ["core", "enhanced", "full"];
export function parseMemoryRuntimeProfile(raw?: string): MemoryRuntimeProfile {
  const normalized = (raw ?? process.env.MEMORY_XX_RUNTIME_PROFILE ?? "core").trim().toLowerCase();
  return normalized === "enhanced" || normalized === "full" ? normalized : "core";
}

export function profileIncludes(profile: MemoryRuntimeProfile, baseline: MemoryRuntimeProfile): boolean {
  return PROFILE_ORDER.indexOf(profile) >= PROFILE_ORDER.indexOf(baseline);
}

export const RUNTIME_COMPONENTS: readonly RuntimeProfileComponent[] = RUNTIME_MODULES.map((module) => ({
  ...module,
  kind: module.kind === "sidecar" || module.kind === "core"
    ? "http"
    : module.kind === "worker" || module.kind === "control"
      ? "systemd"
      : module.kind,
})) as readonly RuntimeProfileComponent[];

export function buildRuntimeProfilePlan(profile: MemoryRuntimeProfile): RuntimeProfilePlan {
  const plan = buildRuntimeModulePlan(profile);
  return {
    profile,
    required_components: plan.required_modules as readonly RuntimeProfileComponent[],
    expected_components: plan.expected_modules as readonly RuntimeProfileComponent[],
    optional_components: plan.optional_modules as readonly RuntimeProfileComponent[],
    full_gates: plan.gates as readonly RuntimeProfileComponent[],
  };
}

export function componentRequiredInProfile(
  component: RuntimeProfileComponent,
  profile: MemoryRuntimeProfile
): boolean {
  return component.required_in.includes(profile);
}

export function componentExpectedInProfile(
  component: RuntimeProfileComponent,
  profile: MemoryRuntimeProfile
): boolean {
  return component.expected_in?.includes(profile) ?? false;
}

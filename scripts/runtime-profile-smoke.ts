import { FULL_STACK_CAPABILITIES, buildFullStackCapabilitySnapshot } from "../app/full-stack-capabilities";
import {
  buildRuntimeModuleSnapshot,
  type MemoryRuntimeProfile,
  type RuntimeEnv,
  type RuntimeModuleSnapshot,
} from "../app/runtime-modules";

type SmokeStatus = "pass" | "fail";

interface ProfileSmokeResult {
  readonly profile: MemoryRuntimeProfile;
  readonly status: SmokeStatus;
  readonly required_modules: readonly string[];
  readonly expected_modules: readonly string[];
  readonly optional_modules_count: number;
  readonly blockers: readonly string[];
  readonly disabled_non_blocking: readonly string[];
}

interface RuntimeProfileSmokeReport {
  readonly ok: boolean;
  readonly mode: "offline";
  readonly generated_at: string;
  readonly profiles: readonly ProfileSmokeResult[];
  readonly full_stack_capabilities: {
    readonly total: number;
    readonly disabled_by_default: readonly string[];
    readonly missing_switch: readonly string[];
    readonly missing_degraded_behavior: readonly string[];
  };
}

const PROFILES: readonly MemoryRuntimeProfile[] = ["core", "enhanced", "full"];

function buildDisabledEnv(): RuntimeEnv {
  return Object.fromEntries([
    ...FULL_STACK_CAPABILITIES
      .map((capability) => capability.env_enabled)
      .filter((name): name is string => Boolean(name))
      .map((name) => [name, "0"] as const),
    ["MEMORY_XX_QDRANT_PROXY_ENABLED", "0"],
    ["MEMORY_XX_FASTPATH_ENABLED", "0"],
    ["MEMORY_XX_LEXICAL_SIDECAR_ENABLED", "0"],
    ["MEMORY_XX_RERANKER_UPSTREAM_ENABLED", "0"],
    ["MEMORY_XX_RERANKER_ADAPTER_ENABLED", "0"],
    ["MEMORY_XX_LLM_UPSTREAM_ENABLED", "0"],
    ["MEMORY_XX_MEM0_EXTRACTOR_ENABLED", "0"],
    ["MEMORY_XX_CONVERSATION_MONITOR_ENABLED", "0"],
    ["MEMORY_XX_MARKDOWN_PROJECTION_ENABLED", "0"],
    ["MEMORY_XX_DREAMING_ENABLED", "0"],
    ["MEMORY_XX_CONTROL_PANEL_ENABLED", "0"],
    ["MEMORY_XX_CACHE_INVALIDATION_WORKER_ENABLED", "0"],
    ["MEMORY_XX_WRITE_TICKET_WORKER_ENABLED", "0"],
    ["MEMORY_XX_MAINTENANCE_ENABLED", "0"],
    ["MEMORY_XX_CONSOLIDATION_ENABLED", "0"],
    ["MEMORY_XX_RUNTIME_ISSUE_DETECTION_ENABLED", "0"],
    ["MEMORY_XX_AUTO_REPAIR_ENABLED", "0"],
    ["MEMORY_XX_REPAIR_REPORT_ENABLED", "0"],
    ["MEMORY_XX_LANDING_SCAN_ENABLED", "0"],
    ["MEMORY_XX_CANARY_7D_REPORT_ENABLED", "0"],
    ["MEMORY_XX_QUALITY_RUNNER_ENABLED", "0"],
    ["MEMORY_XX_GOVERNANCE_REPORT_ENABLED", "0"],
  ]);
}

function smokeProfile(profile: MemoryRuntimeProfile, env: RuntimeEnv): ProfileSmokeResult {
  const snapshot: RuntimeModuleSnapshot = buildRuntimeModuleSnapshot(profile, env);
  const blockers = Object.entries(snapshot.states)
    .filter(([, state]) => state.blocks_profile)
    .map(([name, state]) => `${name}:${state.state}:${state.reason ?? "no_reason"}`);
  const disabledNonBlocking = Object.entries(snapshot.states)
    .filter(([, state]) => state.state === "disabled" && !state.blocks_profile)
    .map(([name]) => name);

  return {
    profile,
    status: blockers.length === 0 ? "pass" : "fail",
    required_modules: snapshot.required_modules,
    expected_modules: snapshot.expected_modules,
    optional_modules_count: snapshot.optional_modules.length,
    blockers,
    disabled_non_blocking: disabledNonBlocking,
  };
}

export function buildRuntimeProfileSmokeReport(now = new Date()): RuntimeProfileSmokeReport {
  const env = buildDisabledEnv();
  const profiles = PROFILES.map((profile) => smokeProfile(profile, env));
  const capabilitySnapshot = buildFullStackCapabilitySnapshot(env);
  const missingSwitch = FULL_STACK_CAPABILITIES
    .filter((capability) => !capability.env_enabled)
    .map((capability) => capability.name);
  const missingDegradedBehavior = FULL_STACK_CAPABILITIES
    .filter((capability) => !capability.degraded_behavior.trim())
    .map((capability) => capability.name);
  const disabledByDefault = Object.entries(capabilitySnapshot.states)
    .filter(([, state]) => state.state === "disabled")
    .map(([name]) => name);

  const ok = profiles.every((profile) => profile.status === "pass")
    && missingSwitch.length === 0
    && missingDegradedBehavior.length === 0;

  return {
    ok,
    mode: "offline",
    generated_at: now.toISOString(),
    profiles,
    full_stack_capabilities: {
      total: FULL_STACK_CAPABILITIES.length,
      disabled_by_default: disabledByDefault,
      missing_switch: missingSwitch,
      missing_degraded_behavior: missingDegradedBehavior,
    },
  };
}

async function main(): Promise<void> {
  const report = buildRuntimeProfileSmokeReport();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

const entrypoint = process.argv[1] ?? "";
if (entrypoint.endsWith("scripts/runtime-profile-smoke.ts") || entrypoint.endsWith("scripts\\runtime-profile-smoke.ts")) {
  void main();
}

import { FULL_STACK_CAPABILITIES, buildFullStackCapabilitySnapshot } from "../app/full-stack-capabilities";
import {
  RUNTIME_MODULES,
  buildRuntimeModuleSnapshot,
  type MemoryRuntimeProfile,
  type RuntimeEnv,
  type RuntimeModuleSnapshot,
} from "../app/runtime-modules";
import { parseMemoryRuntimeProfile } from "../app/runtime-profiles";

type SmokeStatus = "pass" | "fail";
type SmokeMode = "offline" | "live";

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
  readonly mode: SmokeMode;
  readonly generated_at: string;
  readonly profiles: readonly ProfileSmokeResult[];
  readonly full_stack_capabilities: {
    readonly total: number;
    readonly disabled_by_default: readonly string[];
    readonly missing_switch: readonly string[];
    readonly missing_degraded_behavior: readonly string[];
  };
}

interface RuntimeProfileLiveSmokeReport extends RuntimeProfileSmokeReport {
  readonly mode: "live";
  readonly health: {
    readonly profile: MemoryRuntimeProfile;
    readonly runtime_modules_mode: string | null;
    readonly missing_runtime_modules: readonly string[];
    readonly missing_full_stack_capabilities: readonly string[];
    readonly blocking_runtime_modules: readonly string[];
    readonly profile_mismatch: boolean;
  };
}

type HealthPayload = Record<string, unknown>;

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

export function buildRuntimeProfileLiveSmokeReport(health: HealthPayload, now = new Date()): RuntimeProfileLiveSmokeReport {
  const base = buildRuntimeProfileSmokeReport(now);
  const healthProfile = parseMemoryRuntimeProfile(readString(health.runtime_profile) ?? undefined);
  const runtimeModules = readRecord(health.runtime_modules);
  const runtimeModulesMode = readString(runtimeModules.mode);
  const runtimeStates = readRecord(runtimeModules.states);
  const fullStackCapabilities = readRecord(health.full_stack_capabilities);
  const capabilityStates = readRecord(fullStackCapabilities.states);
  const missingRuntimeModules = RUNTIME_MODULES
    .map((module) => module.name)
    .filter((name) => !(name in runtimeStates));
  const missingFullStackCapabilities = FULL_STACK_CAPABILITIES
    .map((capability) => capability.name)
    .filter((name) => !(name in capabilityStates));
  const blockingRuntimeModules = Object.entries(runtimeStates)
    .filter(([, value]) => readBoolean(readRecord(value).blocks_profile) === true)
    .map(([name]) => name);
  const profileMismatch = Boolean(runtimeModulesMode && runtimeModulesMode !== healthProfile);
  const liveOk = base.ok
    && missingRuntimeModules.length === 0
    && missingFullStackCapabilities.length === 0
    && blockingRuntimeModules.length === 0
    && !profileMismatch;

  return {
    ...base,
    ok: liveOk,
    mode: "live",
    health: {
      profile: healthProfile,
      runtime_modules_mode: runtimeModulesMode,
      missing_runtime_modules: missingRuntimeModules,
      missing_full_stack_capabilities: missingFullStackCapabilities,
      blocking_runtime_modules: blockingRuntimeModules,
      profile_mismatch: profileMismatch,
    },
  };
}

async function fetchHealth(url: string): Promise<HealthPayload> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`health request failed: HTTP ${response.status}`);
  }
  return await response.json() as HealthPayload;
}

async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  const url = readArgValue("--url") ?? process.env.MEMORY_XX_WRAPPER_HEALTH_URL ?? "http://127.0.0.1:5100/health";
  const report = live
    ? buildRuntimeProfileLiveSmokeReport(await fetchHealth(url))
    : buildRuntimeProfileSmokeReport();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

const entrypoint = process.argv[1] ?? "";
if (entrypoint.endsWith("scripts/runtime-profile-smoke.ts") || entrypoint.endsWith("scripts\\runtime-profile-smoke.ts")) {
  void main();
}

function readArgValue(name: string): string | undefined {
  const equalsArg = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (equalsArg) return equalsArg.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

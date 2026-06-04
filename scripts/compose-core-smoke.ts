import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { parseMemoryRuntimeProfile, type MemoryRuntimeProfile } from "../app/runtime-profiles";

const execFileAsync = promisify(execFile);

const REQUIRED_CORE_SERVICES = [
  "memory-xx",
  "memory-xx-embedding-proxy",
  "memory-xx-qdrant-projector-worker",
  "postgres",
  "redis",
  "qdrant",
] as const;

const WRAPPER_DEPENDS_ON = [
  "postgres",
  "redis",
  "qdrant",
  "memory-xx-embedding-proxy",
  "memory-xx-qdrant-projector-worker",
] as const;

const PROFILED_SERVICES = [
  "memory-xx-fastpath",
  "memory-xx-lexical-sidecar",
  "memory-xx-qdrant-proxy",
  "memory-xx-reranker-adapter",
  "memory-xx-control-panel",
  "memory-xx-mem0-extractor",
  "memory-xx-conversation-monitor",
  "memory-xx-markdown-projection",
  "memory-xx-dream-worker",
  "memory-xx-cache-invalidation-worker",
  "memory-xx-write-ticket-worker",
  "memory-xx-maintenance",
  "memory-xx-consolidation",
  "memory-xx-detect",
  "memory-xx-auto-repair",
  "memory-xx-repair-report",
  "memory-xx-landing-scan",
  "memory-xx-canary-7d-report",
] as const;

const CORE_LONG_RUNNING_SERVICES = [
  "memory-xx",
  "memory-xx-embedding-proxy",
  "memory-xx-qdrant-projector-worker",
  "postgres",
  "redis",
  "qdrant",
] as const;

export interface ComposeCoreSmokeReport {
  readonly ok: boolean;
  readonly compose_file: string;
  readonly required_services: readonly string[];
  readonly missing_services: readonly string[];
  readonly wrapper_missing_depends_on: readonly string[];
  readonly profile_leaks: readonly string[];
  readonly duplicate_environment_keys: readonly string[];
  readonly core_environment: Readonly<Record<string, string>>;
  readonly blockers: readonly string[];
}

export interface ComposeProfileLiveSmokeOptions {
  readonly composePsJsonLines?: readonly string[] | (() => Promise<readonly string[]>);
  readonly healthPayload?: HealthPayload;
  readonly healthUrl?: string;
  readonly waitMs?: number;
  readonly pollIntervalMs?: number;
}

export interface ComposeProfileLiveSmokeReport {
  readonly ok: boolean;
  readonly profile: MemoryRuntimeProfile;
  readonly required_services: readonly string[];
  readonly missing_services: readonly string[];
  readonly missing_enabled_services: readonly string[];
  readonly stopped_enabled_services: readonly string[];
  readonly unhealthy_services: readonly string[];
  readonly exited_nonzero_services: readonly string[];
  readonly exited_zero_services: readonly string[];
  readonly blocking_runtime_modules: readonly string[];
  readonly profile_mismatch: boolean;
  readonly blockers: readonly string[];
}

interface ComposeService {
  readonly name: string;
  readonly body: string;
}

interface ComposePsService {
  readonly Service?: string;
  readonly State?: string;
  readonly Health?: string;
  readonly ExitCode?: number;
}

type HealthPayload = Record<string, unknown>;

export async function buildComposeCoreSmokeReport(composeFile = "docker-compose.yml"): Promise<ComposeCoreSmokeReport> {
  const compose = await readFile(composeFile, "utf8");
  const services = parseServices(compose);
  const byName = new Map(services.map((service) => [service.name, service]));
  const missingServices = REQUIRED_CORE_SERVICES.filter((service) => !byName.has(service));
  const wrapper = byName.get("memory-xx");
  const wrapperDependsOn = wrapper ? parseMapKeys(wrapper.body, "depends_on") : [];
  const wrapperMissingDependsOn = WRAPPER_DEPENDS_ON.filter((service) => !wrapperDependsOn.includes(service));
  const coreEnvironment = wrapper ? parseEnvironment(wrapper.body) : {};
  const profileLeaks = PROFILED_SERVICES.filter((service) => {
    const block = byName.get(service)?.body;
    return block ? !/^\s{4}profiles:\s*$/mu.test(block) : false;
  });
  const duplicateEnvironmentKeys = findDuplicateEnvironmentKeys(services);
  const blockers = [
    ...missingServices.map((service) => `missing_service:${service}`),
    ...wrapperMissingDependsOn.map((service) => `wrapper_missing_depends_on:${service}`),
    ...profileLeaks.map((service) => `enhanced/full services must stay behind profiles:${service}`),
    ...duplicateEnvironmentKeys.map((key) => `duplicate_environment_key:${key}`),
    ...(coreEnvironment.MEMORY_XX_RUNTIME_PROFILE === "${MEMORY_XX_RUNTIME_PROFILE:-core}"
      ? []
      : ["memory-xx_runtime_profile_default_not_core"]),
    ...(coreEnvironment.EMBEDDING_API_BASE === "http://memory-xx-embedding-proxy:5221/v1"
      ? []
      : ["memory-xx_embedding_base_not_compose_proxy"]),
  ];

  return {
    ok: blockers.length === 0,
    compose_file: composeFile,
    required_services: [...REQUIRED_CORE_SERVICES],
    missing_services: missingServices,
    wrapper_missing_depends_on: wrapperMissingDependsOn,
    profile_leaks: profileLeaks,
    duplicate_environment_keys: duplicateEnvironmentKeys,
    core_environment: coreEnvironment,
    blockers,
  };
}

export async function buildComposeProfileLiveSmokeReport(
  options: ComposeProfileLiveSmokeOptions = {}
): Promise<ComposeProfileLiveSmokeReport> {
  const healthPayload = options.healthPayload ?? await fetchHealth(options.healthUrl ?? defaultHealthUrl());
  const waitMs = Math.max(0, options.waitMs ?? 0);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 1000);
  const deadline = Date.now() + waitMs;
  let report = buildComposeProfileLiveSmokeReportFromState(healthPayload, parseComposePsJsonLines(await readComposePsJsonLines(options)));
  while (!report.ok && report.unhealthy_services.some((service) => service.endsWith(":starting")) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    report = buildComposeProfileLiveSmokeReportFromState(healthPayload, parseComposePsJsonLines(await readComposePsJsonLines(options)));
  }
  return report;
}

async function readComposePsJsonLines(options: ComposeProfileLiveSmokeOptions): Promise<readonly string[]> {
  if (typeof options.composePsJsonLines === "function") return await options.composePsJsonLines();
  if (options.composePsJsonLines) return options.composePsJsonLines;
  return await dockerComposePsJsonLines();
}

function buildComposeProfileLiveSmokeReportFromState(
  healthPayload: HealthPayload,
  services: readonly ComposePsService[]
): ComposeProfileLiveSmokeReport {
  const profile = parseMemoryRuntimeProfile(readString(healthPayload.runtime_profile) ?? undefined);
  const runtimeModules = readRecord(healthPayload.runtime_modules);
  const runtimeMode = readString(runtimeModules.mode);
  const runtimeStates = readRecord(runtimeModules.states);
  const byService = new Map(services.map((service) => [service.Service ?? "", service]));

  const missingServices = CORE_LONG_RUNNING_SERVICES.filter((service) => !byService.has(service));
  const enabledRuntimeServices = Object.entries(runtimeStates)
    .map(([name, value]) => ({ name, state: readRecord(value) }))
    .filter(({ state }) => readString(state.state) === "enabled")
    .map(({ name, state }) => ({ module: name, service: systemdServiceToComposeService(readString(state.service)) }))
    .filter((item): item is { module: string; service: string } => Boolean(item.service))
    .filter((item) => !CORE_LONG_RUNNING_SERVICES.includes(item.service as typeof CORE_LONG_RUNNING_SERVICES[number]));
  const missingEnabledServices = enabledRuntimeServices
    .filter((item) => !byService.has(item.service))
    .map((item) => `${item.module}:${item.service}`);
  const stoppedEnabledServices = enabledRuntimeServices
    .map((item) => ({ ...item, state: byService.get(item.service)?.State }))
    .filter((item) => item.state && readString(item.state) !== "running")
    .map((item) => `${item.module}:${item.service}:${item.state}`);
  const unhealthyServices = services
    .filter((service) => readString(service.Health) && readString(service.Health) !== "healthy")
    .map((service) => `${service.Service ?? "unknown"}:${service.Health}`);
  const exitedNonZeroServices = services
    .filter((service) => readString(service.State) === "exited" && Number(service.ExitCode ?? 0) !== 0)
    .map((service) => `${service.Service ?? "unknown"}:${service.ExitCode ?? "unknown"}`);
  const exitedZeroServices = services
    .filter((service) => readString(service.State) === "exited" && Number(service.ExitCode ?? 0) === 0)
    .map((service) => service.Service ?? "unknown");
  const longRunningStoppedServices = CORE_LONG_RUNNING_SERVICES
    .map((service) => byService.get(service))
    .filter((service): service is ComposePsService => Boolean(service))
    .filter((service) => readString(service.State) !== "running")
    .map((service) => `${service.Service ?? "unknown"}:${service.State ?? "unknown"}`);
  const blockingRuntimeModules = Object.entries(runtimeStates)
    .filter(([, value]) => readBoolean(readRecord(value).blocks_profile) === true)
    .map(([name]) => name);
  const profileMismatch = Boolean(runtimeMode && runtimeMode !== profile);
  const blockers = [
    ...missingServices.map((service) => `missing_service:${service}`),
    ...missingEnabledServices.map((service) => `missing_enabled_service:${service}`),
    ...stoppedEnabledServices.map((service) => `stopped_enabled_service:${service}`),
    ...unhealthyServices.map((service) => `unhealthy_service:${service}`),
    ...longRunningStoppedServices.map((service) => `long_running_service_stopped:${service}`),
    ...exitedNonZeroServices.map((service) => `exited_nonzero_service:${service}`),
    ...blockingRuntimeModules.map((module) => `blocking_runtime_module:${module}`),
    ...(profileMismatch ? [`runtime_profile_mismatch:${runtimeMode}:${profile}`] : []),
  ];

  return {
    ok: blockers.length === 0,
    profile,
    required_services: [...CORE_LONG_RUNNING_SERVICES],
    missing_services: missingServices,
    missing_enabled_services: missingEnabledServices,
    stopped_enabled_services: stoppedEnabledServices,
    unhealthy_services: unhealthyServices,
    exited_nonzero_services: exitedNonZeroServices,
    exited_zero_services: exitedZeroServices,
    blocking_runtime_modules: blockingRuntimeModules,
    profile_mismatch: profileMismatch,
    blockers,
  };
}

function systemdServiceToComposeService(service: string | null): string | null {
  if (!service?.endsWith(".service")) return null;
  return service.slice(0, -".service".length).replace(/-wrapper$/u, "");
}

function parseServices(compose: string): readonly ComposeService[] {
  const lines = compose.split(/\r?\n/u);
  const services: ComposeService[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^  ([A-Za-z0-9_-]+):\s*$/u.exec(lines[index] ?? "");
    if (!match) continue;
    const name = match[1];
    const start = index + 1;
    let end = lines.length;
    for (let cursor = start; cursor < lines.length; cursor += 1) {
      if (/^  [A-Za-z0-9_-]+:\s*$/u.test(lines[cursor] ?? "")) {
        end = cursor;
        break;
      }
    }
    services.push({ name, body: lines.slice(start, end).join("\n") });
  }
  return services;
}

function parseEnvironment(serviceBody: string): Readonly<Record<string, string>> {
  return Object.fromEntries([...serviceBody.matchAll(/^\s{6}([A-Z0-9_]+):\s*(.+)$/gmu)]
    .map((match) => [match[1], match[2].replace(/^"|"$/gu, "")]));
}

function findDuplicateEnvironmentKeys(services: readonly ComposeService[]): readonly string[] {
  const duplicated: string[] = [];
  for (const service of services) {
    const keys = parseEnvironmentKeys(service.body);
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) duplicated.push(`${service.name}:${key}`);
      seen.add(key);
    }
  }
  return duplicated;
}

function parseEnvironmentKeys(serviceBody: string): readonly string[] {
  const lines = serviceBody.split(/\r?\n/u);
  const keys: string[] = [];
  let inEnvironment = false;
  for (const line of lines) {
    if (/^\s{4}environment:\s*$/u.test(line)) {
      inEnvironment = true;
      continue;
    }
    if (inEnvironment && /^\s{4}[A-Za-z0-9_-]+:/u.test(line)) break;
    const match = inEnvironment ? /^\s{6}([A-Z0-9_]+):/u.exec(line) : null;
    if (match) keys.push(match[1]);
  }
  return keys;
}

function parseMapKeys(serviceBody: string, section: string): readonly string[] {
  const lines = serviceBody.split(/\r?\n/u);
  const keys: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (new RegExp(`^\\s{4}${section}:\\s*$`, "u").test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^\s{4}[A-Za-z0-9_-]+:/u.test(line)) break;
    const match = inSection ? /^\s{6}([A-Za-z0-9_-]+):/u.exec(line) : null;
    if (match) keys.push(match[1]);
  }
  return keys;
}

async function main(): Promise<void> {
  const composeFile = readArgValue("--file") ?? "docker-compose.yml";
  const live = process.argv.includes("--live");
  const report = live
    ? await buildComposeProfileLiveSmokeReport({
      healthUrl: readArgValue("--url"),
      waitMs: readPositiveIntArg("--wait-ms") ?? 0,
      pollIntervalMs: readPositiveIntArg("--poll-interval-ms") ?? 1000,
    })
    : await buildComposeCoreSmokeReport(composeFile);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

function readArgValue(name: string): string | undefined {
  const equalsArg = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (equalsArg) return equalsArg.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function readPositiveIntArg(name: string): number | undefined {
  const raw = readArgValue(name);
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const entrypoint = process.argv[1] ?? "";
if (entrypoint.endsWith("scripts/compose-core-smoke.ts") || entrypoint.endsWith("scripts\\compose-core-smoke.ts")) {
  void main();
}

async function dockerComposePsJsonLines(): Promise<readonly string[]> {
  const { stdout } = await execFileAsync("docker", ["compose", "ps", "--all", "--format", "json"], {
    maxBuffer: 1024 * 1024 * 10,
  });
  return stdout.split(/\r?\n/u).filter((line) => line.trim());
}

function parseComposePsJsonLines(lines: readonly string[]): readonly ComposePsService[] {
  return lines
    .map((line) => JSON.parse(line) as ComposePsService)
    .filter((service) => typeof service.Service === "string" && service.Service.trim());
}

async function fetchHealth(url: string): Promise<HealthPayload> {
  const response = await fetch(url, {
    headers: buildAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`health request failed: HTTP ${response.status}`);
  }
  return await response.json() as HealthPayload;
}

function buildAuthHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const token = env.MEMORY_XX_ADMIN_TOKEN?.trim() || env.MEMORY_XX_API_TOKEN?.trim() || "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function defaultHealthUrl(): string {
  return process.env.MEMORY_XX_WRAPPER_HEALTH_URL?.trim() || "http://127.0.0.1:5100/health";
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

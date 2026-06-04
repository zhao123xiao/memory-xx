import { readFile } from "node:fs/promises";

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

export interface ComposeCoreSmokeReport {
  readonly ok: boolean;
  readonly compose_file: string;
  readonly required_services: readonly string[];
  readonly missing_services: readonly string[];
  readonly wrapper_missing_depends_on: readonly string[];
  readonly profile_leaks: readonly string[];
  readonly core_environment: Readonly<Record<string, string>>;
  readonly blockers: readonly string[];
}

interface ComposeService {
  readonly name: string;
  readonly body: string;
}

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
  const blockers = [
    ...missingServices.map((service) => `missing_service:${service}`),
    ...wrapperMissingDependsOn.map((service) => `wrapper_missing_depends_on:${service}`),
    ...profileLeaks.map((service) => `enhanced/full services must stay behind profiles:${service}`),
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
    core_environment: coreEnvironment,
    blockers,
  };
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
  const report = await buildComposeCoreSmokeReport(composeFile);
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

const entrypoint = process.argv[1] ?? "";
if (entrypoint.endsWith("scripts/compose-core-smoke.ts") || entrypoint.endsWith("scripts\\compose-core-smoke.ts")) {
  void main();
}

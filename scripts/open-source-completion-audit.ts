#!/usr/bin/env tsx
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { FULL_STACK_CAPABILITIES } from "../app/full-stack-capabilities";
import { RUNTIME_MODULES, type RuntimeModule } from "../app/runtime-modules";
import { buildParityAuditReport, type ParityAuditReport } from "./open-source-parity-audit";

interface AuditSection {
  readonly ok: boolean;
  readonly blockers: readonly string[];
}

interface CompletionAuditReport {
  readonly ok: boolean;
  readonly public_root: string;
  readonly generated_at: string;
  readonly hot_pluggable: AuditSection & {
    readonly runtime_modules: number;
    readonly core_required_modules: readonly string[];
  };
  readonly full_stack_capabilities: AuditSection & {
    readonly total: number;
  };
  readonly public_docs: AuditSection;
  readonly stale_public_names: AuditSection;
  readonly reference_parity?: ParityAuditReport;
  readonly blockers: readonly string[];
}

const root = process.cwd();
const packageJsonPath = path.join(root, "package.json");
const catalogPath = path.join(root, "docs/module-catalog.md");
const readmePath = path.join(root, "README.md");
const checklistPath = path.join(root, "docs/release-checklist.md");

const coreRequiredAllowlist = new Set([
  "wrapper",
  "postgres",
  "redis",
  "qdrant",
  "embedding_proxy",
  "projector",
]);

const staleNeedles = [
  ["MEMORY", "V2"].join("_"),
  ["api", "memory", "v2"].join("/"),
  ["Memory", "v2"].join("-"),
  ["memory", "v2"].join("-"),
  ["openclaw", "memory", "xx", "wrapper"].join("-"),
];

async function exists(relativePath: string): Promise<boolean> {
  try {
    await stat(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function readPackageScripts(): Promise<Record<string, string>> {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    readonly scripts?: Record<string, string>;
  };
  return packageJson.scripts ?? {};
}

function runtimeRole(module: RuntimeModule): "core" | "pluggable" {
  return module.required_in.includes("core") ? "core" : "pluggable";
}

async function auditHotPluggableRuntime(): Promise<CompletionAuditReport["hot_pluggable"]> {
  const blockers: string[] = [];
  const coreRequiredModules = RUNTIME_MODULES
    .filter((module) => module.required_in.includes("core"))
    .map((module) => module.name)
    .sort();

  for (const module of RUNTIME_MODULES) {
    if (!module.degraded_behavior.trim()) blockers.push(`runtime_module_missing_degraded_behavior:${module.name}`);

    const role = runtimeRole(module);
    if (role === "core" && !coreRequiredAllowlist.has(module.name)) {
      blockers.push(`unexpected_core_required_module:${module.name}`);
    }

    if (role === "pluggable" && module.kind !== "external" && !module.env_enabled) {
      blockers.push(`pluggable_module_missing_env_switch:${module.name}`);
    }

    if (role === "pluggable" && module.default_enabled === true) {
      blockers.push(`pluggable_module_enabled_by_default:${module.name}`);
    }

    if (module.startable && !module.service && !module.command && !module.source_path) {
      blockers.push(`startable_module_missing_entrypoint:${module.name}`);
    }

    if (module.source_path && !(await exists(module.source_path))) {
      blockers.push(`runtime_module_missing_source:${module.name}:${module.source_path}`);
    }
  }

  for (const required of coreRequiredAllowlist) {
    if (!coreRequiredModules.includes(required)) blockers.push(`core_required_module_missing:${required}`);
  }

  return {
    ok: blockers.length === 0,
    blockers,
    runtime_modules: RUNTIME_MODULES.length,
    core_required_modules: coreRequiredModules,
  };
}

async function auditFullStackCapabilities(): Promise<CompletionAuditReport["full_stack_capabilities"]> {
  const blockers: string[] = [];
  const packageScripts = await readPackageScripts();
  const packageCommands = Object.values(packageScripts).join("\n");
  const catalog = await readFile(catalogPath, "utf8");
  const runtimeModuleNames = new Set(RUNTIME_MODULES.map((module) => module.name));
  const capabilityNames = new Set(FULL_STACK_CAPABILITIES.map((capability) => capability.name));

  if (capabilityNames.size !== FULL_STACK_CAPABILITIES.length) {
    blockers.push("duplicate_full_stack_capability_names");
  }

  for (const capability of FULL_STACK_CAPABILITIES) {
    if (capability.default_enabled) blockers.push(`capability_enabled_by_default:${capability.name}`);
    if (!capability.env_enabled) blockers.push(`capability_missing_env_switch:${capability.name}`);
    if (!capability.degraded_behavior.trim()) blockers.push(`capability_missing_degraded_behavior:${capability.name}`);
    if (capability.source_paths.length === 0) blockers.push(`capability_missing_source_paths:${capability.name}`);
    if (capability.script_paths.length === 0) blockers.push(`capability_missing_script_paths:${capability.name}`);
    if (!catalog.includes(`\`${capability.name}\``)) blockers.push(`capability_missing_catalog_row:${capability.name}`);
    if (capability.env_enabled && !catalog.includes(`\`${capability.env_enabled}\``)) {
      blockers.push(`capability_env_missing_from_catalog:${capability.name}:${capability.env_enabled}`);
    }

    for (const dependency of capability.dependencies ?? []) {
      if (!runtimeModuleNames.has(dependency) && !capabilityNames.has(dependency)) {
        blockers.push(`capability_unknown_dependency:${capability.name}:${dependency}`);
      }
    }

    for (const source of capability.source_paths) {
      if (!(await exists(source))) blockers.push(`capability_missing_source:${capability.name}:${source}`);
    }

    for (const script of capability.script_paths) {
      if (!(await exists(script))) blockers.push(`capability_missing_script:${capability.name}:${script}`);
      if (!packageCommands.includes(script)) blockers.push(`capability_script_missing_npm_entrypoint:${capability.name}:${script}`);
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    total: FULL_STACK_CAPABILITIES.length,
  };
}

async function auditPublicDocs(): Promise<AuditSection> {
  const blockers: string[] = [];
  const [readme, checklist, catalog] = await Promise.all([
    readFile(readmePath, "utf8"),
    readFile(checklistPath, "utf8"),
    readFile(catalogPath, "utf8"),
  ]);

  for (const required of [
    "open-source:completion-audit",
    "verify:open-source-full-stack",
    "smoke:compose-core-live",
    "smoke:compose-enhanced",
    "smoke:compose-full",
  ]) {
    if (!readme.includes(required)) blockers.push(`readme_missing:${required}`);
    if (!checklist.includes(required)) blockers.push(`release_checklist_missing:${required}`);
  }

  for (const required of ["Runtime Modules", "Full-Stack Capabilities", "Full-Stack Capability Commands"]) {
    if (!catalog.includes(required)) blockers.push(`module_catalog_missing_section:${required}`);
  }

  return {
    ok: blockers.length === 0,
    blockers,
  };
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relative = path.relative(root, fullPath).replace(/\\/gu, "/");
    if (entry.isDirectory()) {
      if ([".git", "node_modules", "dist", ".runtime", "logs", "reports"].includes(entry.name)) continue;
      files.push(...await listFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (relative === "package-lock.json") continue;
    files.push(fullPath);
  }
  return files.sort();
}

async function auditStalePublicNames(): Promise<AuditSection> {
  const blockers: string[] = [];
  for (const file of await listFiles(root)) {
    const relative = path.relative(root, file).replace(/\\/gu, "/");
    const info = await stat(file);
    if (info.size > 2 * 1024 * 1024) continue;
    let content = "";
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const needle of staleNeedles) {
      if (!content.includes(needle)) continue;
      if (relative === "tests/open-source-readiness.test.ts") continue;
      blockers.push(`stale_public_name:${relative}:${needle}`);
    }
  }
  return {
    ok: blockers.length === 0,
    blockers,
  };
}

export async function buildCompletionAuditReport(): Promise<CompletionAuditReport> {
  const [hotPluggable, fullStackCapabilities, publicDocs, stalePublicNames] = await Promise.all([
    auditHotPluggableRuntime(),
    auditFullStackCapabilities(),
    auditPublicDocs(),
    auditStalePublicNames(),
  ]);

  let referenceParity: ParityAuditReport | undefined;
  const referenceRoot = process.env.MEMORY_XX_PARITY_REFERENCE_ROOT?.trim();
  if (referenceRoot) {
    referenceParity = await buildParityAuditReport({ referenceRoot });
  }

  const blockers = [
    ...hotPluggable.blockers,
    ...fullStackCapabilities.blockers,
    ...publicDocs.blockers,
    ...stalePublicNames.blockers,
    ...(referenceParity?.blockers ?? []),
  ].sort();

  return {
    ok: blockers.length === 0,
    public_root: root,
    generated_at: new Date().toISOString(),
    hot_pluggable: hotPluggable,
    full_stack_capabilities: fullStackCapabilities,
    public_docs: publicDocs,
    stale_public_names: stalePublicNames,
    reference_parity: referenceParity,
    blockers,
  };
}

async function main(): Promise<void> {
  const report = await buildCompletionAuditReport();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

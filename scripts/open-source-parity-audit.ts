#!/usr/bin/env tsx
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

type JsonRecord = Record<string, any>;

export interface ParityAuditOptions {
  readonly referenceRoot?: string;
  readonly publicRoot?: string;
}

export interface ParityAuditReport {
  readonly ok: boolean;
  readonly reference_root: string;
  readonly public_root: string;
  readonly compared_files: {
    readonly reference: number;
    readonly public: number;
  };
  readonly missing_npm_scripts: readonly string[];
  readonly extra_npm_scripts: readonly string[];
  readonly reference_only_allowed: readonly string[];
  readonly reference_only_blockers: readonly string[];
  readonly blockers: readonly string[];
}

const COMPARED_ROOTS = new Set([
  "app",
  "scripts",
  "configs",
  "docs",
  "systemd",
  "sidecars",
  "migrations",
  "src",
  "deploy",
  "tests",
]);

const IGNORED_DIRS = new Set([
  ".git",
  ".runtime",
  "artifacts",
  "backups",
  "data",
  "dist",
  "logs",
  "migration_artifacts",
  "node_modules",
  "reports",
]);

export async function buildParityAuditReport(options: ParityAuditOptions = {}): Promise<ParityAuditReport> {
  const referenceRootInput = options.referenceRoot ?? process.env.MEMORY_XX_PARITY_REFERENCE_ROOT;
  if (!referenceRootInput?.trim()) {
    throw new Error("missing_reference_root:set --reference-root or MEMORY_XX_PARITY_REFERENCE_ROOT");
  }
  const referenceRoot = path.resolve(referenceRootInput);
  const publicRoot = path.resolve(options.publicRoot ?? process.cwd());
  const [referenceFiles, publicFiles] = await Promise.all([
    collectComparedFiles(referenceRoot),
    collectComparedFiles(publicRoot),
  ]);
  const publicNormalized = new Set(publicFiles.map(normalizeReferencePath));
  const referenceOnly = referenceFiles
    .filter((file) => !publicNormalized.has(normalizeReferencePath(file)))
    .sort();
  const referenceOnlyAllowed = referenceOnly.filter(isAllowedReferenceOnlyGap);
  const referenceOnlyBlockers = referenceOnly.filter((file) => !isAllowedReferenceOnlyGap(file));
  const { missing, extra } = await comparePackageScripts(referenceRoot, publicRoot);
  const blockers = [
    ...missing.map((script) => `missing_npm_script:${script}`),
    ...referenceOnlyBlockers.map((file) => `reference_only_file:${file}`),
  ];

  return {
    ok: blockers.length === 0,
    reference_root: referenceRoot,
    public_root: publicRoot,
    compared_files: {
      reference: referenceFiles.length,
      public: publicFiles.length,
    },
    missing_npm_scripts: missing,
    extra_npm_scripts: extra,
    reference_only_allowed: referenceOnlyAllowed,
    reference_only_blockers: referenceOnlyBlockers,
    blockers,
  };
}

async function collectComparedFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, "", files);
  return files
    .filter((file) => COMPARED_ROOTS.has(file.split("/")[0] ?? ""))
    .sort();
}

async function walk(root: string, relativeDir: string, files: string[]): Promise<void> {
  const directory = path.join(root, relativeDir);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relative = normalizePath(path.join(relativeDir, entry.name));
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walk(root, relative, files);
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
}

function normalizeReferencePath(file: string): string {
  const referenceProjectName = ["memory", "v2"].join("-");
  const publicProjectName = ["memory", "xx"].join("-");
  return file
    .replaceAll(referenceProjectName, publicProjectName)
    .replaceAll("klee-memory-xx-wrapper", "memory-xx-wrapper")
    .replaceAll(["openclaw", "memory", "xx", "wrapper"].join("-"), "memory-xx-wrapper")
    .replaceAll("openclaw-qdrant-projector-worker", "memory-xx-qdrant-projector-worker")
    .replaceAll("embedding-proxy-next", "embedding-proxy")
    .replaceAll("qdrant-proxy-next", "qdrant-proxy")
    .replaceAll("reranker-adapter-next", "reranker-adapter");
}

function isAllowedReferenceOnlyGap(file: string): boolean {
  if (/\.(bak|pre-bak-restore)$/u.test(file)) return true;
  if (file.startsWith("docs/_ws")) return true;
  if (/^docs\/memory-[^/]+\/operations\/klee-memory-[^/]+-wrapper-usage\.md$/u.test(file)) return true;
  if (/^docs\/.*(方案|计划|测试).*\.md$/u.test(file)) return true;
  return false;
}

async function comparePackageScripts(referenceRoot: string, publicRoot: string): Promise<{
  readonly missing: readonly string[];
  readonly extra: readonly string[];
}> {
  const [referenceScripts, publicScripts] = await Promise.all([
    readPackageScripts(referenceRoot),
    readPackageScripts(publicRoot),
  ]);
  const referenceNames = Object.keys(referenceScripts).sort();
  const publicNames = Object.keys(publicScripts).sort();
  const publicSet = new Set(publicNames);
  const referenceSet = new Set(referenceNames);
  return {
    missing: referenceNames.filter((script) => !publicSet.has(script)),
    extra: publicNames.filter((script) => !referenceSet.has(script)),
  };
}

async function readPackageScripts(root: string): Promise<Record<string, string>> {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as JsonRecord;
  return packageJson.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts as Record<string, string> : {};
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const referenceRoot = argValue("--reference-root");
  const publicRoot = argValue("--public-root") ?? argValue("--root");
  if (referenceRoot) {
    await stat(referenceRoot);
  }
  const report = await buildParityAuditReport({ referenceRoot, publicRoot });
  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`open-source parity audit: ok=${report.ok} missing_npm_scripts=${report.missing_npm_scripts.length} reference_only_blockers=${report.reference_only_blockers.length} allowed_reference_only=${report.reference_only_allowed.length}\n`);
  }
  if (!report.ok && hasFlag("--fail-on-blockers")) process.exitCode = 1;
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

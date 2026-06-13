#!/usr/bin/env tsx
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_SOURCE_ROOT = path.resolve(process.cwd(), "..", "memory-v2");
const COMPARE_ROOTS = ["app", "scripts", "tests", "migrations", "systemd", "configs"] as const;
const EXTRA_TARGET_SCRIPTS = new Set(["audit:prod", "verify:open-source", "memory:parity-audit"]);
const PRIVATE_RESIDUE_PATTERN = /Simplified version for memory-xx|requires governance repository integration|successor_placeholder|MEMORY_V2|\/api\/memory\/v2/u;

interface PackageScriptDiff {
  only_in_source: string[];
  only_in_target: string[];
}

interface ParityAuditReport {
  ok: boolean;
  source_root: string;
  target_root: string;
  compared_roots: string[];
  errors: string[];
  missing_count: number;
  missing: string[];
  package_scripts: PackageScriptDiff;
  residue_hits: Array<{ file: string; line: number; text: string }>;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | null {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function isIgnored(relativePath: string): boolean {
  return /\.bak$|\.pre-bak-restore$|(^|\/)reports\//u.test(relativePath);
}

function walk(root: string, relative = ""): string[] {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const next = path.join(relative, entry.name).replaceAll("\\", "/");
    if (entry.name === "node_modules" || entry.name === ".git" || isIgnored(next)) continue;
    if (entry.isDirectory()) out.push(...walk(root, next));
    else out.push(next);
  }
  return out;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath
    .replace(/^scripts\/klee-memory-v2-wrapper\.ts$/u, "scripts/memory-xx-wrapper.ts")
    .replaceAll("memory-v2", "memory-xx")
    .replaceAll("memory_v2", "memory_xx")
    .replaceAll("MEMORY_V2", "MEMORY_XX")
    .replaceAll("/api/memory/v2", "/api/memory/xx")
    .replaceAll("klee-memory-v2-wrapper", "memory-xx-wrapper")
    .replaceAll("openclaw-memory-xx-wrapper", "memory-xx-wrapper")
    .replaceAll("openclaw-qdrant-projector-worker", "memory-xx-qdrant-projector-worker");
}

function isIntentionalPublicReplacement(file: string, targetFiles: ReadonlySet<string>): boolean {
  if (!/^systemd\/memory-xx-.+-next\.service$/u.test(file)) {
    return false;
  }

  const canonical = file.replace(/-next\.service$/u, ".service");
  return targetFiles.has(canonical);
}

function readPackageScripts(root: string): Record<string, string> {
  const file = path.join(root, "package.json");
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, string> };
  return parsed.scripts ?? {};
}

function diffPackageScripts(sourceRoot: string, targetRoot: string): PackageScriptDiff {
  const sourceScripts = Object.keys(readPackageScripts(sourceRoot)).sort();
  const targetScripts = Object.keys(readPackageScripts(targetRoot)).sort();
  const targetSet = new Set(targetScripts);
  const sourceSet = new Set(sourceScripts);
  return {
    only_in_source: sourceScripts.filter((key) => !targetSet.has(key)),
    only_in_target: targetScripts.filter((key) => !sourceSet.has(key) && !EXTRA_TARGET_SCRIPTS.has(key)),
  };
}

function findMissingFiles(sourceRoot: string, targetRoot: string): string[] {
  const missing: string[] = [];
  for (const root of COMPARE_ROOTS) {
    const sourceFiles = walk(path.join(sourceRoot, root)).map((file) => normalizeRelativePath(`${root}/${file}`));
    const targetFiles = new Set(walk(path.join(targetRoot, root)).map((file) => `${root}/${file}`));
    for (const file of sourceFiles) {
      if (!targetFiles.has(file) && !isIntentionalPublicReplacement(file, targetFiles)) {
        missing.push(file);
      }
    }
  }
  return [...new Set(missing)].sort();
}

function scanResidue(targetRoot: string): ParityAuditReport["residue_hits"] {
  const scanRoots = ["app", "scripts", "configs", "systemd"];
  const hits: ParityAuditReport["residue_hits"] = [];
  for (const root of scanRoots) {
    for (const file of walk(path.join(targetRoot, root))) {
      const relative = `${root}/${file}`;
      if (relative === "scripts/memory-parity-audit.ts") continue;
      const content = readFileSync(path.join(targetRoot, relative), "utf8");
      const lines = content.split(/\r?\n/u);
      lines.forEach((lineText, index) => {
        if (PRIVATE_RESIDUE_PATTERN.test(lineText)) {
          hits.push({ file: relative, line: index + 1, text: lineText.trim() });
        }
      });
    }
  }
  return hits;
}

function buildReport(sourceRoot: string, targetRoot: string): ParityAuditReport {
  const errors: string[] = [];
  if (!existsSync(sourceRoot)) errors.push(`source root does not exist: ${sourceRoot}`);
  if (!existsSync(targetRoot)) errors.push(`target root does not exist: ${targetRoot}`);
  if (errors.length > 0) {
    return {
      ok: false,
      source_root: sourceRoot,
      target_root: targetRoot,
      compared_roots: [...COMPARE_ROOTS],
      errors,
      missing_count: 0,
      missing: [],
      package_scripts: { only_in_source: [], only_in_target: [] },
      residue_hits: [],
    };
  }

  const missing = findMissingFiles(sourceRoot, targetRoot);
  const packageScripts = diffPackageScripts(sourceRoot, targetRoot);
  const residueHits = scanResidue(targetRoot);
  return {
    ok: missing.length === 0 && packageScripts.only_in_source.length === 0 && residueHits.length === 0,
    source_root: sourceRoot,
    target_root: targetRoot,
    compared_roots: [...COMPARE_ROOTS],
    errors,
    missing_count: missing.length,
    missing,
    package_scripts: packageScripts,
    residue_hits: residueHits,
  };
}

async function main(): Promise<void> {
  const sourceRoot = path.resolve(argValue("--source-root") ?? DEFAULT_SOURCE_ROOT);
  const targetRoot = path.resolve(argValue("--target-root") ?? process.cwd());
  const report = buildReport(sourceRoot, targetRoot);

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`memory parity audit: ok=${report.ok} missing=${report.missing_count} source_only_scripts=${report.package_scripts.only_in_source.length} residue_hits=${report.residue_hits.length}\n`);
    if (report.missing.length > 0) process.stdout.write(`missing:\n${report.missing.map((file) => `  - ${file}`).join("\n")}\n`);
    if (report.package_scripts.only_in_source.length > 0) process.stdout.write(`source-only scripts:\n${report.package_scripts.only_in_source.map((script) => `  - ${script}`).join("\n")}\n`);
    if (report.residue_hits.length > 0) process.stdout.write(`residue hits:\n${report.residue_hits.map((hit) => `  - ${hit.file}:${hit.line}`).join("\n")}\n`);
    if (report.errors.length > 0) process.stdout.write(`errors:\n${report.errors.map((error) => `  - ${error}`).join("\n")}\n`);
  }

  if (!report.ok && hasFlag("--fail-on-missing")) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

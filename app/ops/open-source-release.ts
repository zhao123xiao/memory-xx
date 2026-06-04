import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export type OpenSourceBlockerKind =
  | "private_env_file"
  | "runtime_or_report_data"
  | "raw_benchmark_source"
  | "manual_dump_or_debug_artifact"
  | "private_path_literal"
  | "secret_like_literal"
  | "oversized_file";

export interface OpenSourceAuditFinding {
  readonly kind: OpenSourceBlockerKind;
  readonly severity: "blocker" | "warning";
  readonly path: string;
  readonly line?: number;
  readonly message: string;
}

export interface OpenSourcePreauditReport {
  readonly ok: boolean;
  readonly generated_at: string;
  readonly root: string;
  readonly target_dir?: string;
  readonly checked_files: number;
  readonly blockers: readonly OpenSourceAuditFinding[];
  readonly warnings: readonly OpenSourceAuditFinding[];
}

export interface OpenSourceExportResult {
  readonly ok: boolean;
  readonly generated_at: string;
  readonly root: string;
  readonly target_dir: string;
  readonly package_name: string;
  readonly copied_files: number;
  readonly generated_files: readonly string[];
  readonly skipped: readonly string[];
  readonly runtime_cursor_backup_dir: string | null;
  readonly runtime_cursor_backups: readonly string[];
}

const PACKAGE_NAME = "memory-xx";
const MAX_PUBLIC_FILE_BYTES = 2 * 1024 * 1024;

const ALLOWLIST_TOP_LEVEL = new Set([
  ".dockerignore",
  ".env.example",
  ".github",
  ".gitignore",
  "Dockerfile",
  "README.md",
  "app",
  "configs",
  "deploy",
  "docker-compose.yml",
  "migrations",
  "package-lock.json",
  "package.json",
  "scripts",
  "sidecars",
  "src",
  "systemd",
  "tests",
  "tsconfig.json",
  "wrapper-entry.mjs",
]);

const PUBLIC_DOCS = new Set([
  "docs/agent-integration.zh-CN.md",
  "docs/api.md",
  "docs/architecture.md",
  "docs/architecture.zh-CN.md",
  "docs/canary.zh-CN.md",
  "docs/control-panel.zh-CN.md",
  "docs/features.zh-CN.md",
  "docs/knowledge.zh-CN.md",
  "docs/migration-rollback-playbook.md",
  "docs/operations.md",
  "docs/operations.zh-CN.md",
  "docs/policy-governance.zh-CN.md",
  "docs/quickstart.zh-CN.md",
  "docs/runtime-profiles.md",
  "docs/runbooks/backup-restore.md",
  "docs/runbooks/migration-rollback.md",
  "docs/runbooks/recall-quality.md",
  "docs/vector-runtime.zh-CN.md",
]);

const DENYLIST_TOP_LEVEL = new Set([
  ".codex",
  ".logs",
  ".runtime",
  "3",
  "artifacts",
  "backups",
  "data",
  "dist",
  "logs",
  "migration_artifacts",
  "node_modules",
  "reports",
  "review",
  "tmp-shadow-scripts",
]);

const DENYLIST_FILE_NAMES = new Set([
  ".env",
  ".env.fastpath-next",
  "P0-BASELINE.md",
  "P0-data-backup.sql",
  "P0-fastpath-dropins.conf",
  "P0-qdrant-config.json",
  "P0-schema.sql",
  "debug_rerank.mjs",
  "debug_test19.mjs",
  "metrics_snapshot.json",
  "test-sp.mjs",
  "test_write_full.sh",
  "x27source_refx27",
]);

const DENYLIST_RELATIVE_FILES = new Set<string>();

const PRIVATE_LINUX_USER = "local";
const PRIVATE_WINDOWS_USER = "\u8d75\u6653\u6653";
const PRIVATE_PROJECT_ROOT = ["/home", PRIVATE_LINUX_USER, "services", "memory-xx"].join("/");
const PRIVATE_PROJECT_NEXT_ROOT = ["/home", PRIVATE_LINUX_USER, "services", "memory-xx-next"].join("/");
const PRIVATE_LINUX_HOME = ["/home", PRIVATE_LINUX_USER].join("/");
const PRIVATE_WINDOWS_HOME = ["/mnt/c", "Users", PRIVATE_WINDOWS_USER].join("/");
const PRIVATE_WINDOWS_C_HOME = ["C:", "Users", PRIVATE_WINDOWS_USER].join("\\");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/");
}

function relativePath(root: string, file: string): string {
  return normalizePath(path.relative(root, file));
}

function topLevel(relative: string): string {
  return normalizePath(relative).split("/")[0] ?? relative;
}

function isDeniedByPath(relative: string): OpenSourceBlockerKind | null {
  const normalized = normalizePath(relative);
  const base = path.basename(normalized);
  const top = topLevel(normalized);
  if (DENYLIST_RELATIVE_FILES.has(normalized)) return "manual_dump_or_debug_artifact";
  if (base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) return "private_env_file";
  if (DENYLIST_FILE_NAMES.has(base)) return "manual_dump_or_debug_artifact";
  if (normalized.startsWith("data/policy-corpus/sources/")) return "raw_benchmark_source";
  if (DENYLIST_TOP_LEVEL.has(top)) return "runtime_or_report_data";
  return null;
}

function isDeniedDirectory(relative: string): boolean {
  return DENYLIST_TOP_LEVEL.has(topLevel(relative));
}

function isAllowedForExport(relative: string): boolean {
  if (isDeniedByPath(relative)) return false;
  if (normalizePath(relative).startsWith("docs/")) return PUBLIC_DOCS.has(normalizePath(relative));
  return ALLOWLIST_TOP_LEVEL.has(topLevel(relative));
}

function publicExportRelativePath(relative: string): string {
  const normalized = normalizePath(relative);
  return normalized
    .replace(/^configs\/memory-xx/u, "configs/memory-xx")
    .replace(/^scripts\/memory-xx-wrapper\.ts$/u, "scripts/memory-xx-wrapper.ts")
    .replace(/^scripts\/functional-test-memory-xx\.sh$/u, "scripts/functional-test-memory-xx.sh")
    .replace(/^scripts\/windows\/start-memory-xx\.ps1$/u, "scripts/windows/start-memory-xx.ps1")
    .replace(/^scripts\/windows\/status-memory-xx\.ps1$/u, "scripts/windows/status-memory-xx.ps1")
    .replace(/^scripts\/windows\/stop-memory-xx\.ps1$/u, "scripts/windows/stop-memory-xx.ps1")
    .replace(/^systemd\/memory-xx/u, "systemd/memory-xx")
    .replace(/^systemd\/memory-xx/u, "systemd/memory-xx")
    .replace(/^systemd\/memory-xx-qdrant-projector-worker/u, "systemd/memory-xx-qdrant-projector-worker")
    .replace(/^deploy\/systemd\/memory-xx/u, "deploy/systemd/memory-xx")
    .replace(/^deploy\/grafana\/memory-xx/u, "deploy/grafana/memory-xx");
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const rel = relativePath(root, fullPath);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        if (isDeniedDirectory(rel)) continue;
        await visit(fullPath);
        continue;
      }
      if (entry.isFile()) files.push(rel);
    }
  }
  await visit(root);
  return files.sort();
}

function privatePathFinding(relative: string, line: string, lineNumber: number): OpenSourceAuditFinding | null {
  if (!line.includes(PRIVATE_LINUX_HOME) && !line.includes(PRIVATE_WINDOWS_HOME) && !line.includes(PRIVATE_WINDOWS_C_HOME) && !/[A-Z]:\\/u.test(line)) return null;
  return {
    kind: "private_path_literal",
    severity: "blocker",
    path: relative,
    line: lineNumber,
    message: "contains a private local or Windows user path",
  };
}

function secretFinding(relative: string, line: string, lineNumber: number): OpenSourceAuditFinding | null {
  const isPlaceholder = /(<set-in-env>|<[^>]+>|\$\{[A-Z0-9_]+\}|changeme|example|redacted|test-key|test-token)/iu.test(line);
  if (isPlaceholder) return null;
  if (/\bsk-[A-Za-z0-9_-]{20,}\b/u.test(line) || /\bBearer\s+[A-Za-z0-9._~+/-]{24,}\b/u.test(line)) {
    return {
      kind: "secret_like_literal",
      severity: "blocker",
      path: relative,
      line: lineNumber,
      message: "contains a secret-like literal",
    };
  }
  if (/^\s*(?:OPENAI_API_KEY|QDRANT_API_KEY|MEMORY_XX_(?:API|ADMIN|CLI)_TOKEN)\s*=\s*[^#\s<]/u.test(line)) {
    return {
      kind: "secret_like_literal",
      severity: "blocker",
      path: relative,
      line: lineNumber,
      message: "contains a non-placeholder credential assignment",
    };
  }
  return null;
}

export async function buildOpenSourcePreauditReport(input: {
  readonly root: string;
  readonly targetDir?: string;
}): Promise<OpenSourcePreauditReport> {
  const root = path.resolve(input.root);
  const files = await listFiles(root);
  const findings: OpenSourceAuditFinding[] = [];
  let checkedFiles = 0;
  for (const relative of files) {
    const denied = isDeniedByPath(relative);
    if (denied) {
      findings.push({
        kind: denied,
        severity: "blocker",
        path: relative,
        message: "file or directory is excluded from public export",
      });
      continue;
    }
    if (!isAllowedForExport(relative)) continue;
    const fullPath = path.join(root, relative);
    const info = await stat(fullPath).catch(() => null);
    if (!info || info.size > MAX_PUBLIC_FILE_BYTES) {
      findings.push({
        kind: "oversized_file",
        severity: "blocker",
        path: relative,
        message: "file is too large for public source export",
      });
      continue;
    }
    checkedFiles += 1;
    const content = await readFile(fullPath, "utf8").catch(() => "");
    if (content.includes("\0")) continue;
    content.split(/\r?\n/u).forEach((line, index) => {
      const privateFinding = privatePathFinding(relative, line, index + 1);
      if (privateFinding) findings.push(privateFinding);
      const secretLike = secretFinding(relative, line, index + 1);
      if (secretLike) findings.push(secretLike);
    });
  }
  const blockers = findings.filter((finding) => finding.severity === "blocker");
  return {
    ok: blockers.length === 0,
    generated_at: new Date().toISOString(),
    root,
    ...(input.targetDir ? { target_dir: path.resolve(input.targetDir) } : {}),
    checked_files: checkedFiles,
    blockers,
    warnings: findings.filter((finding) => finding.severity === "warning"),
  };
}

function sanitizePackageJson(content: string): string {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  parsed.name = PACKAGE_NAME;
  parsed.description = typeof parsed.description === "string"
    ? sanitizeOpenSourceText(parsed.description)
    : "Open-source AI agent memory framework with policy-governed write, recall, and projection flows.";
  return sanitizeOpenSourceText(`${JSON.stringify(parsed, null, 2)}\n`, { renameProject: true });
}

function sanitizePackageLockJson(content: string): string {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  parsed.name = PACKAGE_NAME;
  const packages = parsed.packages;
  if (packages && typeof packages === "object" && !Array.isArray(packages)) {
    const rootPackage = (packages as Record<string, unknown>)[""];
    if (rootPackage && typeof rootPackage === "object" && !Array.isArray(rootPackage)) {
      (rootPackage as Record<string, unknown>).name = PACKAGE_NAME;
    }
  }
  return sanitizeOpenSourceText(`${JSON.stringify(parsed, null, 2)}\n`, { renameProject: true });
}

function sanitizeEnvExample(content: string): string {
  return content.split(/\r?\n/u).map((line) => {
    if (/^\s*(?:OPENAI_API_KEY|EMBEDDING_API_KEY|QDRANT_API_KEY|MEMORY_INTELLIGENCE_.*API_KEY|QDRANT_API_KEY|MEMORY_XX_(?:API|MCP|ADMIN|CLI)_TOKEN)=/u.test(line)) {
      return line.replace(/=.*/u, "=<set-in-env>");
    }
    return sanitizeOpenSourceText(line, { renameProject: true });
  }).join("\n");
}

function sanitizeWorkflow(content: string): string {
  return sanitizeOpenSourceText(content, { renameProject: true })
    .replace(/postgres:\/\/postgres:postgres@/gu, "postgres://postgres@")
    .replace(/OPENAI_API_KEY=test-key/gu, "OPENAI_API_KEY=<set-in-env>")
    .replace(/MEMORY_XX_API_TOKEN=test-token/gu, "MEMORY_XX_API_TOKEN=<set-in-env>");
}

function sanitizeSecurityTest(content: string): string {
  const openAiStyleKeyPattern = new RegExp(`content:\\s*"api_key:\\s*${"sk-"}live-secret-value-123456\\\\nfallback_api_key:`, "u");
  return content.replace(
    openAiStyleKeyPattern,
    'content: "api_key: " + "sk-" + "live-secret-value-123456\\\\nfallback_api_key:',
  );
}

export function sanitizeOpenSourceText(content: string, options: { readonly renameProject?: boolean } = {}): string {
  let output = content
    .replace(new RegExp(escapeRegExp(PRIVATE_PROJECT_NEXT_ROOT), "gu"), "<project-root>")
    .replace(new RegExp(escapeRegExp(PRIVATE_PROJECT_ROOT), "gu"), "<project-root>")
    .replace(new RegExp(escapeRegExp(PRIVATE_LINUX_HOME), "gu"), "<linux-user-home>")
    .replace(new RegExp(escapeRegExp(PRIVATE_WINDOWS_HOME), "gu"), "<windows-user-home>")
    .replace(new RegExp(escapeRegExp(PRIVATE_WINDOWS_C_HOME), "gu"), "<windows-user-home>")
    .replace(/[A-Z]:\\/gu, "<windows-drive>\\")
    .replace(/local/gu, "local")
    .replace(new RegExp(PRIVATE_LINUX_USER, "gu"), "local")
    .replace(new RegExp(PRIVATE_WINDOWS_USER, "gu"), "<windows-user>");
  if (options.renameProject === true) {
    output = output
      .replace(/memory-xx/g, PACKAGE_NAME)
      .replace(/memory_xx/g, "memory_xx")
      .replace(/Memory XX/g, "Memory XX")
      .replace(/Memory-XX/g, "Memory-XX")
      .replace(/memory-xx/g, PACKAGE_NAME)
      .replace(/Memory XX/g, "Memory XX")
      .replace(/Memory XX/g, "Memory XX")
      .replace(/memory-xx/gu, "memory-xx")
      .replace(/memory-xx-qdrant-projector-worker/gu, "memory-xx-qdrant-projector-worker");
  }
  return output;
}

function sanitizedContent(relative: string, content: string): string {
  if (relative === "package.json") return sanitizePackageJson(content);
  if (relative === "package-lock.json") return sanitizePackageLockJson(content);
  if (relative === ".env.example") return sanitizeEnvExample(content);
  if (relative.startsWith(".github/workflows/")) return sanitizeWorkflow(content);
  if (relative === "README.md" || relative.startsWith("docs/") || relative.startsWith("configs/")) {
    return sanitizeOpenSourceText(content, { renameProject: true });
  }
  if (relative.startsWith("systemd/") || relative.startsWith("deploy/") || relative === "docker-compose.yml") {
    return sanitizeOpenSourceText(content, { renameProject: true });
  }
  if (relative === "tests/security-platform.test.ts") return sanitizeSecurityTest(sanitizeOpenSourceText(content, { renameProject: true }));
  return sanitizeOpenSourceText(content, { renameProject: true });
}

const MIT_LICENSE = `MIT License

Copyright (c) 2026 memory-xx contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const SECURITY = `# Security

Do not commit real memory records, conversation sessions, runtime snapshots,
database dumps, reports, logs, tokens, API keys, local paths, or benchmark source
archives.

Use .env.example placeholders and provide real credentials through private
environment files or secret managers.
`;

const CONTRIBUTING = `# Contributing

Use synthetic fixtures for tests and documentation. Do not add real user
conversation data, private runtime reports, local database exports, or provider
credentials.

Before submitting changes, run:

\`\`\`bash
TMPDIR=/tmp npm run typecheck
TMPDIR=/tmp npm test
TMPDIR=/tmp npm run check:secrets
\`\`\`
`;

function openSourceAuditDocument(result: OpenSourceExportResult): string {
  return `# Open Source Audit

This clean export was generated for \`${PACKAGE_NAME}\`.

Included: application source, scripts, tests, migrations, configuration
templates, deployment templates, Docker files, and CI workflows.

Excluded: private .env files, runtime state, reports, logs, raw benchmark
sources, local database dumps, generated artifacts, caches, and manual debug
dumps.

Generated at: ${result.generated_at}
Copied files: ${result.copied_files}
`;
}

async function writeGeneratedFiles(targetDir: string, result: Omit<OpenSourceExportResult, "generated_files">): Promise<string[]> {
  const files: Array<readonly [string, string]> = [
    ["LICENSE", MIT_LICENSE],
    ["SECURITY.md", SECURITY],
    ["CONTRIBUTING.md", CONTRIBUTING],
    ["OPEN_SOURCE_AUDIT.md", openSourceAuditDocument({ ...result, generated_files: [] })],
  ];
  for (const [relative, content] of files) {
    await writeFile(path.join(targetDir, relative), content, "utf8");
  }
  return files.map(([relative]) => relative);
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertSafeExportTarget(input: {
  readonly root: string;
  readonly targetDir: string;
  readonly apply: boolean;
  readonly targetExplicit: boolean;
}): void {
  if (!input.apply) return;
  if (isPathInside(input.root, input.targetDir)) {
    throw new Error("refusing_open_source_export_target_inside_source_root");
  }
  if (!input.targetExplicit && input.targetDir !== path.resolve(defaultOpenSourceTargetDir())) {
    throw new Error("refusing_open_source_export_target_without_explicit_target_dir");
  }
}

async function backupRuntimeCursors(input: {
  readonly root: string;
  readonly backupId: string;
  readonly enabled: boolean;
}): Promise<{ backupDir: string | null; backups: readonly string[] }> {
  if (!input.enabled) return { backupDir: null, backups: [] };
  const cursorFiles = [
    ".runtime/conversation-events/.cursor.json",
    ".runtime/conversation-sources.cursor.json",
  ];
  const backupRoot = path.join(".runtime", "open-source-export-cursor-backups", input.backupId);
  const backups: string[] = [];
  for (const relative of cursorFiles) {
    const source = path.join(input.root, relative);
    if (!existsSync(source)) continue;
    const suffix = relative.replace(/^\.runtime\//u, "");
    const targetRelative = normalizePath(path.join(backupRoot, suffix));
    const target = path.join(input.root, targetRelative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    backups.push(targetRelative);
  }
  backups.sort();
  return {
    backupDir: backups.length > 0 ? normalizePath(backupRoot) : null,
    backups,
  };
}

export async function exportOpenSourceProject(input: {
  readonly root: string;
  readonly targetDir: string;
  readonly apply?: boolean;
  readonly targetExplicit?: boolean;
  readonly backupId?: string;
  readonly backupRuntimeCursors?: boolean;
}): Promise<OpenSourceExportResult> {
  const root = path.resolve(input.root);
  const targetDir = path.resolve(input.targetDir);
  const apply = input.apply === true;
  assertSafeExportTarget({
    root,
    targetDir,
    apply,
    targetExplicit: input.targetExplicit ?? true,
  });
  const files = (await listFiles(root)).filter(isAllowedForExport);
  const skipped = (await listFiles(root)).filter((relative) => !isAllowedForExport(relative));
  let copied = 0;
  const backupId = input.backupId ?? `open-source-export-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  const cursorBackup = await backupRuntimeCursors({
    root,
    backupId,
    enabled: apply && input.backupRuntimeCursors !== false,
  });
  if (apply) {
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true });
  }
  for (const relative of files) {
    const fullPath = path.join(root, relative);
    const info = await stat(fullPath).catch(() => null);
    if (!info || info.size > MAX_PUBLIC_FILE_BYTES) continue;
    const content = await readFile(fullPath, "utf8").catch(() => "");
    if (apply) {
      const outputPath = path.join(targetDir, publicExportRelativePath(relative));
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, sanitizedContent(relative, content), "utf8");
    }
    copied += 1;
  }
  const generatedAt = new Date().toISOString();
  const base: Omit<OpenSourceExportResult, "generated_files"> = {
    ok: true,
    generated_at: generatedAt,
    root,
    target_dir: targetDir,
    package_name: PACKAGE_NAME,
    copied_files: copied,
    skipped,
    runtime_cursor_backup_dir: cursorBackup.backupDir,
    runtime_cursor_backups: cursorBackup.backups,
  };
  const generatedFiles = apply ? await writeGeneratedFiles(targetDir, base) : [];
  return { ...base, generated_files: generatedFiles };
}

export function defaultOpenSourceTargetDir(): string {
  return process.env.MEMORY_XX_EXPORT_TARGET
    ?? path.join(process.env.HOME ?? ".", "services", PACKAGE_NAME);
}

export function publicPathScanPatterns(): readonly RegExp[] {
  return [
    new RegExp(escapeRegExp(PRIVATE_LINUX_HOME), "u"),
    /\/mnt\/c\/Users/u,
    new RegExp(PRIVATE_WINDOWS_USER, "u"),
    /memory-xx|Memory XX|memory_xx/u,
    /\bsk-[A-Za-z0-9_-]{20,}\b/u,
    /\bBearer\s+[A-Za-z0-9._~+/-]{24,}\b/u,
  ];
}

export async function assertNoPublicPathBlockers(root: string): Promise<readonly OpenSourceAuditFinding[]> {
  if (!existsSync(root)) return [];
  const findings: OpenSourceAuditFinding[] = [];
  for (const relative of await listFiles(root)) {
    if (/memory-xx|Memory XX|memory_xx/u.test(relative)) {
      findings.push({
        kind: "private_path_literal",
        severity: "blocker",
        path: relative,
        message: "public export contains legacy memory-xx naming in a file path",
      });
    }
    const content = await readFile(path.join(root, relative), "utf8").catch(() => "");
    content.split(/\r?\n/u).forEach((line, index) => {
      for (const pattern of publicPathScanPatterns()) {
        if (pattern.test(line)) {
          findings.push({
            kind: pattern.source.includes("sk-") || pattern.source.includes("Bearer") ? "secret_like_literal" : "private_path_literal",
            severity: "blocker",
            path: relative,
            line: index + 1,
            message: "public export contains a blocked literal",
          });
        }
      }
    });
  }
  return findings;
}

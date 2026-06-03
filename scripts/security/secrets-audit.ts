import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type SecretSeverity = "info" | "warning" | "high" | "critical";

export interface SecretFinding {
  readonly file: string;
  readonly line: number;
  readonly field: string;
  readonly kind: string;
  readonly severity: SecretSeverity;
  readonly tracked: boolean;
  readonly value_preview: string;
  readonly recommendation: string;
}

export interface SecretAuditSummary {
  readonly ok: boolean;
  readonly finding_count: number;
  readonly blocker_count: number;
  readonly tracked_secret_count: number;
  readonly rotation_required: readonly string[];
}

export interface SecretAuditReport extends SecretAuditSummary {
  readonly checked_at: string;
  readonly mode: "dry_run";
  readonly roots: readonly string[];
  readonly findings: readonly SecretFinding[];
  readonly rotation_manifest: readonly {
    readonly field: string;
    readonly file: string;
    readonly action: string;
  }[];
}

const SENSITIVE_FIELD = /(?:^|[_-])(api[_-]?key|fallback[_-]?api[_-]?key|secret|password|token|admin[_-]?token)(?:$|[_-])/iu;
const HARD_SECRET_VALUE = /(sk-[A-Za-z0-9_\-]{12,}|admin_[A-Za-z0-9_\-]{12,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9_\-]{24,})/u;
const DEFAULT_EXTENSIONS = new Set([".env", ".yaml", ".yml", ".json", ".service", ".cmd", ".bat", ".ps1", ".sh"]);
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "reports", "migration_artifacts", "artifacts", "backups", ".runtime", "logs"]);

function previewValue(value: string): string {
  const clean = value.trim().replace(/^['"]|['"]$/gu, "");
  if (clean.length <= 8) return "<redacted>";
  return `${clean.slice(0, 3)}...${clean.slice(-3)}`;
}

function isPlaceholder(value: string): boolean {
  const clean = value.trim().replace(/^['"]|['"]$/gu, "");
  if (!clean) return true;
  if (clean.includes("${")) return true;
  if (/^\$\{[A-Z0-9_]+\}$/u.test(clean) || /^\$[A-Z0-9_]+$/u.test(clean)) return true;
  if (/^<[^>]+>$/u.test(clean)) return true;
  if (/^(example|example-.+|.+-example|changeme|change-me|placeholder|redacted|set-in-env|your-.+|test-key|postgres)$/iu.test(clean)) return true;
  if (/^(true|false|null|none)$/iu.test(clean)) return true;
  if (/^[0-9]+$/u.test(clean)) return true;
  return false;
}

function parseConfigAssignment(line: string): { field: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const envMatch = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(trimmed);
  if (envMatch) return { field: envMatch[1], value: envMatch[2] };
  const yamlMatch = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/u.exec(trimmed);
  if (yamlMatch) return { field: yamlMatch[1], value: yamlMatch[2] };
  return null;
}

function secretKind(field: string): string {
  const lower = field.toLowerCase();
  if (lower.includes("api_key") || lower.includes("api-key")) return "api_key";
  if (lower.includes("password")) return "password";
  if (lower.includes("token")) return "token";
  if (lower.includes("secret")) return "secret";
  return "credential";
}

function shouldInspectField(field: string): boolean {
  const lower = field.toLowerCase();
  if (lower === "max_tokens" || lower.endsWith("_max_tokens")) return false;
  if (lower.endsWith("_file") || lower.endsWith("_path")) return false;
  return SENSITIVE_FIELD.test(lower);
}

function classifySeverity(tracked: boolean, value: string): SecretSeverity {
  if (tracked) return "critical";
  return HARD_SECRET_VALUE.test(value.trim()) ? "high" : "warning";
}

export function scanSecretContent(input: {
  readonly file: string;
  readonly content: string;
  readonly tracked?: boolean;
}): readonly SecretFinding[] {
  const tracked = input.tracked === true;
  const findings: SecretFinding[] = [];
  const lines = input.content.split(/\r?\n/u);
  lines.forEach((line, index) => {
    const assignment = parseConfigAssignment(line);
    if (!assignment || !shouldInspectField(assignment.field) || isPlaceholder(assignment.value)) return;
    findings.push({
      file: input.file,
      line: index + 1,
      field: assignment.field,
      kind: secretKind(assignment.field),
      severity: classifySeverity(tracked, assignment.value),
      tracked,
      value_preview: previewValue(assignment.value),
      recommendation: tracked
        ? "改为环境变量引用或 secret file，占位配置提交到仓库；真实值由本机私有 .env/Windows secret file 提供，并轮换已暴露 key。"
        : "保持文件不提交；如该值曾进入日志/对话/仓库历史，请在对应平台轮换。",
    });
  });
  return findings;
}

export function summarizeSecretAudit(findings: readonly SecretFinding[]): SecretAuditSummary {
  const blockerCount = findings.filter((finding) => finding.tracked && finding.severity === "critical").length;
  const rotationRequired = [...new Set(findings.map((finding) => `${finding.field}@${finding.file}`))];
  return {
    ok: blockerCount === 0,
    finding_count: findings.length,
    blocker_count: blockerCount,
    tracked_secret_count: findings.filter((finding) => finding.tracked).length,
    rotation_required: rotationRequired,
  };
}

function gitRoot(startDir: string): string | null {
  try {
    return execFileSync("git", ["-C", startDir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function isGitTracked(file: string, root = gitRoot(process.cwd())): boolean {
  if (!root) return false;
  try {
    const relative = path.relative(root, file);
    execFileSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", relative], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function shouldScanFile(file: string): boolean {
  const base = path.basename(file);
  if (base === ".env" || base.startsWith(".env.")) return true;
  return DEFAULT_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function listFiles(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  const output: string[] = [];
  const visit = (file: string): void => {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      if (EXCLUDED_DIRS.has(path.basename(file))) return;
      for (const child of readdirSync(file)) visit(path.join(file, child));
      return;
    }
    if (stat.isFile() && shouldScanFile(file)) output.push(file);
  };
  visit(root);
  return output;
}

export function defaultSecretAuditRoots(cwd = process.cwd()): readonly string[] {
  return [
    cwd,
    path.resolve(cwd, "../mem0"),
    "<windows-user-home>/Desktop/打开 memory-xx 控制面板.cmd",
    "<windows-user-home>/Desktop/memory-xx-control-panel.ps1",
  ].filter((root, index, roots) => existsSync(root) && roots.indexOf(root) === index);
}

export function runSecretAudit(input: {
  readonly roots?: readonly string[];
  readonly cwd?: string;
} = {}): SecretAuditReport {
  const cwd = input.cwd ?? process.cwd();
  const roots = input.roots ?? defaultSecretAuditRoots(cwd);
  const repoRoot = gitRoot(cwd);
  const findings = roots.flatMap((root) => listFiles(root).flatMap((file) => {
    try {
      return scanSecretContent({
        file,
        content: readFileSync(file, "utf8"),
        tracked: isGitTracked(file, repoRoot),
      });
    } catch {
      return [];
    }
  }));
  const summary = summarizeSecretAudit(findings);
  return {
    ...summary,
    checked_at: new Date().toISOString(),
    mode: "dry_run",
    roots,
    findings,
    rotation_manifest: findings.map((finding) => ({
      field: finding.field,
      file: finding.file,
      action: finding.tracked ? "replace_with_env_placeholder_and_rotate" : "keep_private_and_rotate_if_exposed",
    })),
  };
}

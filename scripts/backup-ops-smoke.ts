import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type BackupOpsCapabilityName = "backup_and_restore" | "deployment_packaging";

export interface BackupOpsSmokeEnv {
  readonly [key: string]: string | undefined;
}

export interface BackupOpsCapabilityResult {
  readonly ok: boolean;
  readonly degraded: boolean;
  readonly output_files: readonly string[];
  readonly status?: string;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export interface BackupOpsSmokeReport {
  readonly ok: boolean;
  readonly mode: "live";
  readonly runtime_dir: string | null;
  readonly checked_capabilities: readonly BackupOpsCapabilityName[];
  readonly results: Partial<Record<BackupOpsCapabilityName, BackupOpsCapabilityResult>>;
  readonly degraded: boolean;
  readonly blockers: readonly string[];
}

interface BackupOpsCommand {
  readonly capability: BackupOpsCapabilityName;
  readonly args: readonly string[];
  readonly outputFile: string;
}

interface BuildBackupOpsSmokeOptions {
  readonly env?: BackupOpsSmokeEnv;
  readonly runtimeDir?: string;
  readonly allowDegraded?: boolean;
  readonly keepRuntimeDir?: boolean;
  readonly runCommand?: (name: BackupOpsCapabilityName, args: readonly string[], outputFile: string, env: BackupOpsSmokeEnv) => Promise<string>;
}

const CAPABILITIES: readonly BackupOpsCapabilityName[] = [
  "backup_and_restore",
  "deployment_packaging",
];

const BACKUP_OPS_COMMANDS: readonly BackupOpsCommand[] = [
  {
    capability: "backup_and_restore",
    args: ["scripts/memory-backup.ts"],
    outputFile: "memory-backup.json",
  },
  {
    capability: "deployment_packaging",
    args: ["scripts/memory-migration-preflight.ts", "--profile=docker-compose-local"],
    outputFile: "migration-preflight.json",
  },
  {
    capability: "deployment_packaging",
    args: ["scripts/memory-deployment-bundle.ts", "--profile=docker-compose-local"],
    outputFile: "deployment-bundle.json",
  },
  {
    capability: "deployment_packaging",
    args: ["scripts/memory-secrets-audit.ts", "--no-fail", "--root=app,scripts,docs,configs,systemd"],
    outputFile: "secrets-audit.json",
  },
];

export async function buildBackupOpsSmokeReport(options: BuildBackupOpsSmokeOptions = {}): Promise<BackupOpsSmokeReport> {
  const env = options.env ?? process.env;
  const requiredBlockers = requiredEnvBlockers(env);
  if (requiredBlockers.length > 0) {
    return {
      ok: false,
      mode: "live",
      runtime_dir: options.runtimeDir ?? null,
      checked_capabilities: CAPABILITIES,
      results: {},
      degraded: false,
      blockers: requiredBlockers,
    };
  }

  const allowDegraded = options.allowDegraded ?? !process.argv.includes("--strict");
  const runtimeDir = options.runtimeDir ?? await mkdtemp(path.join(os.tmpdir(), "memory-xx-backup-ops-smoke-"));
  const ownsRuntimeDir = !options.runtimeDir;
  try {
    await mkdir(runtimeDir, { recursive: true });
    const outputFilesByCapability = new Map<BackupOpsCapabilityName, string[]>(
      CAPABILITIES.map((capability) => [capability, []])
    );
    for (const command of BACKUP_OPS_COMMANDS) {
      const outputFile = path.join(runtimeDir, command.outputFile);
      await (options.runCommand ?? runBackupOpsCommand)(command.capability, command.args, outputFile, env);
      outputFilesByCapability.get(command.capability)?.push(outputFile);
    }

    const results = Object.fromEntries(
      await Promise.all(CAPABILITIES.map(async (capability) => [
        capability,
        await readCapabilityResult(outputFilesByCapability.get(capability) ?? []),
      ]))
    ) as Partial<Record<BackupOpsCapabilityName, BackupOpsCapabilityResult>>;

    const blockers = Object.entries(results).flatMap(([name, result]) => {
      if (!result) return [`${name}:missing_result`];
      if (result.ok) return [];
      if (result.degraded && allowDegraded) return [];
      return [`${name}:${result.blockers[0] ?? result.status ?? "not_ok"}`];
    });

    return {
      ok: blockers.length === 0,
      mode: "live",
      runtime_dir: runtimeDir,
      checked_capabilities: CAPABILITIES,
      results,
      degraded: Object.values(results).some((result) => result?.degraded),
      blockers,
    };
  } finally {
    if (ownsRuntimeDir && !options.keepRuntimeDir) {
      await rm(runtimeDir, { recursive: true, force: true });
    }
  }
}

function requiredEnvBlockers(env: BackupOpsSmokeEnv): readonly string[] {
  const blockers: string[] = [];
  if (!env.MEMORY_XX_DATABASE_URL?.trim()) blockers.push("missing_env:MEMORY_XX_DATABASE_URL");
  if (!env.MEMORY_XX_CLI_TOKEN?.trim() && !env.MEMORY_XX_ADMIN_TOKEN?.trim() && !env.MEMORY_XX_API_TOKEN?.trim()) {
    blockers.push("missing_env:MEMORY_XX_CLI_TOKEN_OR_MEMORY_XX_ADMIN_TOKEN");
  }
  return blockers;
}

async function runBackupOpsCommand(
  _name: BackupOpsCapabilityName,
  args: readonly string[],
  outputFile: string,
  env: BackupOpsSmokeEnv
): Promise<string> {
  const extraArgs = deploymentBundleOutputArgs(args, outputFile);
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", ...args, ...extraArgs], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
        TMPDIR: "/tmp",
        MEMORY_XX_RUNTIME_DIR: env.MEMORY_XX_RUNTIME_DIR ?? path.dirname(outputFile),
      },
      encoding: "utf8",
      timeout: Number.parseInt(env.MEMORY_XX_BACKUP_OPS_SMOKE_TIMEOUT_MS ?? "300000", 10),
      maxBuffer: 20 * 1024 * 1024,
    });
    await writeFile(outputFile, `${result.stdout.trim() || "{}"}\n`, "utf8");
  } catch (error: any) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    await writeFile(outputFile, stdout.trim() ? `${stdout.trim()}\n` : `${JSON.stringify({
      ok: false,
      status: "failed",
      blockers: [error instanceof Error ? error.message : String(error)],
      stderr_tail: stderr.slice(-4000),
    }, null, 2)}\n`, "utf8");
  }
  return outputFile;
}

function deploymentBundleOutputArgs(args: readonly string[], outputFile: string): readonly string[] {
  if (!args.includes("scripts/memory-deployment-bundle.ts")) return [];
  return [`--output=${path.join(path.dirname(outputFile), "deployment-bundle")}`];
}

async function readCapabilityResult(outputFiles: readonly string[]): Promise<BackupOpsCapabilityResult> {
  const reports = await Promise.all(outputFiles.map(async (file) => ({ file, body: parseLastJson(await readFile(file, "utf8")) })));
  const blockers = reports.flatMap(({ body }) => extractBlockers(body));
  const warnings = reports.flatMap(({ body }) => stringArray(body.warnings));
  const allOk = reports.length > 0 && reports.every(({ body }) => isOkEvidence(body));
  const degraded = reports.some(({ body }) => isDegradedEvidence(body));
  return {
    ok: allOk,
    degraded,
    output_files: outputFiles,
    status: reports.find(({ body }) => typeof body.status === "string")?.body.status,
    blockers,
    warnings,
  };
}

function isOkEvidence(body: Record<string, any>): boolean {
  if (body.ok === true || body.status === "ok" || body.status === "ready") return true;
  if (body.mode === "dry_run" && Array.isArray(body.items)) return true;
  if (body.includes_live_secrets === false && typeof body.output === "string") return true;
  if (typeof body.blocker_count === "number" && body.blocker_count === 0) return true;
  return false;
}

function isDegradedEvidence(body: Record<string, any>): boolean {
  if (body.degraded === true || body.status === "degraded" || body.preflight_status === "degraded") return true;
  if (body.ok === false && extractBlockers(body).length > 0) return true;
  if (typeof body.blocker_count === "number" && body.blocker_count > 0) return true;
  return false;
}

function extractBlockers(body: Record<string, any>): readonly string[] {
  return [
    ...stringArray(body.blockers),
    ...stringArray(body.blocked_reasons),
    ...stringArray(body.threshold_failures),
    ...stringArray(body.findings)
      .filter((finding) => /blocker|secret|token|password|credential/iu.test(finding)),
  ];
}

function parseLastJson(text: string): Record<string, any> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return { ok: false, blockers: ["json_output_missing"] };
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? parsed : { ok: false, blockers: ["json_output_not_object"] };
  } catch (error) {
    return { ok: false, blockers: [`json_parse_failed:${error instanceof Error ? error.message : String(error)}`] };
  }
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item : JSON.stringify(item)).filter((item) => item.trim() !== "");
}

async function main(): Promise<void> {
  const report = await buildBackupOpsSmokeReport({
    keepRuntimeDir: process.argv.includes("--keep-runtime-dir"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

const entrypoint = process.argv[1] ?? "";
if (entrypoint.endsWith("scripts/backup-ops-smoke.ts") || entrypoint.endsWith("scripts\\backup-ops-smoke.ts")) {
  void main();
}

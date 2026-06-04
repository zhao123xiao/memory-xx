import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type FullOpsModuleName =
  | "maintenance_orchestrator"
  | "auto_repair"
  | "repair_report"
  | "quality_runner"
  | "governance_report";

export interface FullOpsSmokeEnv {
  readonly [key: string]: string | undefined;
}

export interface FullOpsModuleResult {
  readonly ok: boolean;
  readonly degraded: boolean;
  readonly exit_code: number;
  readonly output_file: string;
  readonly status?: string;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export interface FullOpsSmokeReport {
  readonly ok: boolean;
  readonly mode: "live";
  readonly runtime_dir: string | null;
  readonly checked_modules: readonly FullOpsModuleName[];
  readonly results: Partial<Record<FullOpsModuleName, FullOpsModuleResult>>;
  readonly degraded: boolean;
  readonly blockers: readonly string[];
}

interface FullOpsCommand {
  readonly module: FullOpsModuleName;
  readonly args: readonly string[];
  readonly outputFile: string;
}

interface BuildFullOpsSmokeOptions {
  readonly env?: FullOpsSmokeEnv;
  readonly runtimeDir?: string;
  readonly allowDegraded?: boolean;
  readonly keepRuntimeDir?: boolean;
  readonly runCommand?: (name: FullOpsModuleName, args: readonly string[], outputFile: string, env: FullOpsSmokeEnv) => Promise<string>;
}

const FULL_OPS_COMMANDS: readonly FullOpsCommand[] = [
  {
    module: "maintenance_orchestrator",
    args: ["run", "--mode", "report", "--json"],
    outputFile: "maintenance.json",
  },
  {
    module: "auto_repair",
    args: ["--json"],
    outputFile: "auto-repair.json",
  },
  {
    module: "repair_report",
    args: ["--target", "ops-ready", "--mode", "full", "--plan"],
    outputFile: "doctor.json",
  },
  {
    module: "quality_runner",
    args: ["--suite", "all"],
    outputFile: "quality.json",
  },
  {
    module: "governance_report",
    args: ["--dry-run", "--json"],
    outputFile: "governance.json",
  },
];

export async function buildFullOpsSmokeReport(options: BuildFullOpsSmokeOptions = {}): Promise<FullOpsSmokeReport> {
  const env = options.env ?? process.env;
  const requiredBlockers = requiredEnvBlockers(env);
  if (requiredBlockers.length > 0) {
    return {
      ok: false,
      mode: "live",
      runtime_dir: options.runtimeDir ?? null,
      checked_modules: FULL_OPS_COMMANDS.map((command) => command.module),
      results: {},
      degraded: false,
      blockers: requiredBlockers,
    };
  }

  const allowDegraded = options.allowDegraded ?? !process.argv.includes("--strict");
  const runtimeDir = options.runtimeDir ?? await mkdtemp(path.join(os.tmpdir(), "memory-xx-full-ops-smoke-"));
  const ownsRuntimeDir = !options.runtimeDir;
  const results: Partial<Record<FullOpsModuleName, FullOpsModuleResult>> = {};
  try {
    await mkdir(runtimeDir, { recursive: true });
    for (const command of FULL_OPS_COMMANDS) {
      const outputFile = path.join(runtimeDir, command.outputFile);
      await (options.runCommand ?? runFullOpsCommand)(command.module, command.args, outputFile, env);
      results[command.module] = await readModuleResult(command.module, outputFile);
    }

    const moduleBlockers = Object.entries(results).flatMap(([name, result]) => {
      if (!result) return [`${name}:missing_result`];
      if (result.ok) return [];
      if (result.degraded && allowDegraded) return [];
      return [`${name}:${result.blockers[0] ?? result.status ?? "not_ok"}`];
    });

    return {
      ok: moduleBlockers.length === 0,
      mode: "live",
      runtime_dir: runtimeDir,
      checked_modules: FULL_OPS_COMMANDS.map((command) => command.module),
      results,
      degraded: Object.values(results).some((result) => result?.degraded),
      blockers: moduleBlockers,
    };
  } finally {
    if (ownsRuntimeDir && !options.keepRuntimeDir) {
      await rm(runtimeDir, { recursive: true, force: true });
    }
  }
}

function requiredEnvBlockers(env: FullOpsSmokeEnv): readonly string[] {
  return [
    ["MEMORY_XX_DATABASE_URL", env.MEMORY_XX_DATABASE_URL],
    ["MEMORY_XX_REDIS_URL", env.MEMORY_XX_REDIS_URL],
    ["MEMORY_XX_QDRANT_BASE_URL", env.MEMORY_XX_QDRANT_BASE_URL],
    ["EMBEDDING_API_BASE", env.EMBEDDING_API_BASE],
  ]
    .filter(([, value]) => !value?.trim())
    .map(([name]) => `missing_env:${name}`);
}

async function runFullOpsCommand(
  name: FullOpsModuleName,
  args: readonly string[],
  outputFile: string,
  env: FullOpsSmokeEnv
): Promise<string> {
  const scriptArgs = commandScriptArgs(name, args);
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", ...scriptArgs], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
        TMPDIR: "/tmp",
        MEMORY_XX_RUNTIME_DIR: env.MEMORY_XX_RUNTIME_DIR ?? path.dirname(outputFile),
      },
      encoding: "utf8",
      timeout: Number.parseInt(env.MEMORY_XX_FULL_OPS_SMOKE_TIMEOUT_MS ?? "300000", 10),
      maxBuffer: 20 * 1024 * 1024,
    });
    await writeOutput(outputFile, result.stdout);
  } catch (error: any) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    await writeOutput(outputFile, stdout || JSON.stringify({
      ok: false,
      status: "failed",
      blockers: [error instanceof Error ? error.message : String(error)],
      stderr_tail: stderr.slice(-4000),
    }));
  }
  return outputFile;
}

function commandScriptArgs(name: FullOpsModuleName, args: readonly string[]): readonly string[] {
  switch (name) {
    case "maintenance_orchestrator":
      return ["scripts/maintenance.ts", ...args];
    case "auto_repair":
      return ["scripts/memory-auto-repair.ts", ...args];
    case "repair_report":
      return ["scripts/memory-doctor.ts", ...args];
    case "quality_runner":
      return ["scripts/memory-quality.ts", ...args];
    case "governance_report":
      return ["scripts/memory-governance.ts", ...args];
  }
}

async function writeOutput(outputFile: string, body: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.writeFile(outputFile, `${body.trim() || "{}"}\n`, "utf8");
}

async function readModuleResult(module: FullOpsModuleName, outputFile: string): Promise<FullOpsModuleResult> {
  const parsed = parseLastJson(await readFile(outputFile, "utf8"));
  const blockers = stringArray(parsed.blockers ?? parsed.blocked_reasons ?? parsed.issues?.map?.((issue: any) => issue.id));
  const warnings = stringArray(parsed.warnings);
  const ok = parsed.ok === true || parsed.status === "ready" || parsed.status === "ok" || parsed.status === "repaired";
  const degraded = !ok && isDegradedEvidence(module, parsed, blockers);
  return {
    ok,
    degraded,
    exit_code: 0,
    output_file: outputFile,
    status: typeof parsed.status === "string" ? parsed.status : undefined,
    blockers,
    warnings,
  };
}

function isDegradedEvidence(module: FullOpsModuleName, parsed: Record<string, any>, blockers: readonly string[]): boolean {
  if (parsed.degraded === true || parsed.status === "degraded" || parsed.status === "report") return true;
  if (module === "auto_repair" && Array.isArray(parsed.issues)) return true;
  if (module === "repair_report" && blockers.length > 0) return true;
  if (module === "quality_runner" && blockers.length > 0) return true;
  return false;
}

function parseLastJson(text: string): Record<string, any> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    return { ok: false, status: "failed", blockers: ["json_output_missing"] };
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? parsed : { ok: false, blockers: ["json_output_not_object"] };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      blockers: [`json_parse_failed:${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item : String(item)).filter((item) => item.trim() !== "");
}

async function main(): Promise<void> {
  const report = await buildFullOpsSmokeReport({
    keepRuntimeDir: process.argv.includes("--keep-runtime-dir"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

const entrypoint = process.argv[1] ?? "";
if (entrypoint.endsWith("scripts/full-ops-smoke.ts") || entrypoint.endsWith("scripts\\full-ops-smoke.ts")) {
  void main();
}

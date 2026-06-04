import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RuntimeObservabilityCapabilityName = "runtime_observability_retention";

export interface RuntimeObservabilitySmokeEnv {
  readonly [key: string]: string | undefined;
}

export interface RuntimeObservabilityCapabilityResult {
  readonly ok: boolean;
  readonly degraded: boolean;
  readonly output_files: readonly string[];
  readonly status?: string;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export interface RuntimeObservabilitySmokeReport {
  readonly ok: boolean;
  readonly mode: "live";
  readonly runtime_dir: string | null;
  readonly checked_capabilities: readonly RuntimeObservabilityCapabilityName[];
  readonly results: Partial<Record<RuntimeObservabilityCapabilityName, RuntimeObservabilityCapabilityResult>>;
  readonly degraded: boolean;
  readonly blockers: readonly string[];
}

interface RuntimeObservabilityCommand {
  readonly capability: RuntimeObservabilityCapabilityName;
  readonly args: readonly string[];
  readonly outputFile: string;
}

interface BuildRuntimeObservabilitySmokeOptions {
  readonly env?: RuntimeObservabilitySmokeEnv;
  readonly runtimeDir?: string;
  readonly allowDegraded?: boolean;
  readonly keepRuntimeDir?: boolean;
  readonly runCommand?: (name: RuntimeObservabilityCapabilityName, args: readonly string[], outputFile: string, env: RuntimeObservabilitySmokeEnv) => Promise<string>;
}

const CAPABILITIES: readonly RuntimeObservabilityCapabilityName[] = ["runtime_observability_retention"];

const RUNTIME_OBSERVABILITY_COMMANDS: readonly RuntimeObservabilityCommand[] = [
  {
    capability: "runtime_observability_retention",
    args: ["scripts/runtime-observability-retention.ts"],
    outputFile: "runtime-observability-retention.json",
  },
  {
    capability: "runtime_observability_retention",
    args: ["scripts/trace-retention.ts", "--limit=100"],
    outputFile: "trace-retention.json",
  },
  {
    capability: "runtime_observability_retention",
    args: ["scripts/memory-cleanup-runtime-artifacts.ts"],
    outputFile: "runtime-artifacts-cleanup.json",
  },
];

export async function buildRuntimeObservabilitySmokeReport(
  options: BuildRuntimeObservabilitySmokeOptions = {}
): Promise<RuntimeObservabilitySmokeReport> {
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
  const runtimeDir = options.runtimeDir ?? await mkdtemp(path.join(os.tmpdir(), "memory-xx-runtime-observability-smoke-"));
  const ownsRuntimeDir = !options.runtimeDir;
  try {
    await mkdir(runtimeDir, { recursive: true });
    const outputFilesByCapability = new Map<RuntimeObservabilityCapabilityName, string[]>(
      CAPABILITIES.map((capability) => [capability, []])
    );
    for (const command of RUNTIME_OBSERVABILITY_COMMANDS) {
      const outputFile = path.join(runtimeDir, command.outputFile);
      const commandEnv = {
        ...env,
        MEMORY_XX_RUNTIME_OBSERVABILITY_REPORT_DIR: runtimeDir,
      };
      await (options.runCommand ?? runRuntimeObservabilityCommand)(command.capability, command.args, outputFile, commandEnv);
      outputFilesByCapability.get(command.capability)?.push(outputFile);
    }

    const results = Object.fromEntries(
      await Promise.all(CAPABILITIES.map(async (capability) => [
        capability,
        await readCapabilityResult(outputFilesByCapability.get(capability) ?? []),
      ]))
    ) as Partial<Record<RuntimeObservabilityCapabilityName, RuntimeObservabilityCapabilityResult>>;

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

function requiredEnvBlockers(env: RuntimeObservabilitySmokeEnv): readonly string[] {
  const blockers: string[] = [];
  if (!env.MEMORY_XX_DATABASE_URL?.trim()) blockers.push("missing_env:MEMORY_XX_DATABASE_URL");
  if (!env.MEMORY_XX_CLI_TOKEN?.trim() && !env.MEMORY_XX_ADMIN_TOKEN?.trim() && !env.MEMORY_XX_API_TOKEN?.trim()) {
    blockers.push("missing_env:MEMORY_XX_CLI_TOKEN_OR_MEMORY_XX_ADMIN_TOKEN");
  }
  return blockers;
}

async function runRuntimeObservabilityCommand(
  _name: RuntimeObservabilityCapabilityName,
  args: readonly string[],
  outputFile: string,
  env: RuntimeObservabilitySmokeEnv
): Promise<string> {
  const rootArgs = runtimeArtifactsRootArgs(args, outputFile);
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", ...args, ...rootArgs], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
        TMPDIR: "/tmp",
        MEMORY_XX_RUNTIME_DIR: env.MEMORY_XX_RUNTIME_DIR ?? path.dirname(outputFile),
      },
      encoding: "utf8",
      timeout: Number.parseInt(env.MEMORY_XX_RUNTIME_OBSERVABILITY_SMOKE_TIMEOUT_MS ?? "300000", 10),
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

function runtimeArtifactsRootArgs(args: readonly string[], outputFile: string): readonly string[] {
  if (!args.includes("scripts/memory-cleanup-runtime-artifacts.ts")) return [];
  return [`--root=${path.dirname(outputFile)}`];
}

async function readCapabilityResult(outputFiles: readonly string[]): Promise<RuntimeObservabilityCapabilityResult> {
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
  if (body.mode === "dry_run" && Array.isArray(body.candidates)) return true;
  if (body.apply === false && typeof body.candidate_count === "number") return true;
  if (body.mode === "dry_run" && Array.isArray(body.files)) return true;
  return false;
}

function isDegradedEvidence(body: Record<string, any>): boolean {
  if (body.degraded === true || body.status === "degraded") return true;
  if (body.ok === false && extractBlockers(body).length > 0) return true;
  if (Array.isArray(body.candidates) && body.candidates.some((candidate: any) => Number(candidate?.candidate_count ?? 0) > 0)) return true;
  if (typeof body.candidate_count === "number" && body.candidate_count > 0) return true;
  if (Array.isArray(body.files) && body.files.length > 0) return true;
  return false;
}

function extractBlockers(body: Record<string, any>): readonly string[] {
  return [
    ...stringArray(body.blockers),
    ...stringArray(body.blocked_reasons),
    ...stringArray(body.threshold_failures),
    ...stringArray(body.error ? [body.error] : []),
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
  const report = await buildRuntimeObservabilitySmokeReport({
    keepRuntimeDir: process.argv.includes("--keep-runtime-dir"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

const entrypoint = process.argv[1] ?? "";
if (entrypoint.endsWith("scripts/runtime-observability-smoke.ts") || entrypoint.endsWith("scripts\\runtime-observability-smoke.ts")) {
  void main();
}

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type TrustedAgentCapabilityName = "trusted_agent_tools";

export interface TrustedAgentSmokeEnv {
  readonly [key: string]: string | undefined;
}

export interface TrustedAgentCapabilityResult {
  readonly ok: boolean;
  readonly degraded: boolean;
  readonly output_files: readonly string[];
  readonly status?: string;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export interface TrustedAgentSmokeReport {
  readonly ok: boolean;
  readonly mode: "live";
  readonly runtime_dir: string | null;
  readonly checked_capabilities: readonly TrustedAgentCapabilityName[];
  readonly results: Partial<Record<TrustedAgentCapabilityName, TrustedAgentCapabilityResult>>;
  readonly degraded: boolean;
  readonly blockers: readonly string[];
}

interface TrustedAgentCommand {
  readonly capability: TrustedAgentCapabilityName;
  readonly args: readonly string[];
  readonly outputFile: string;
}

interface BuildTrustedAgentSmokeOptions {
  readonly env?: TrustedAgentSmokeEnv;
  readonly runtimeDir?: string;
  readonly allowDegraded?: boolean;
  readonly keepRuntimeDir?: boolean;
  readonly runCommand?: (name: TrustedAgentCapabilityName, args: readonly string[], outputFile: string, env: TrustedAgentSmokeEnv) => Promise<string>;
}

const CAPABILITIES: readonly TrustedAgentCapabilityName[] = ["trusted_agent_tools"];

const TRUSTED_AGENT_COMMANDS: readonly TrustedAgentCommand[] = [
  {
    capability: "trusted_agent_tools",
    args: ["scripts/memory-agent.ts", "audit"],
    outputFile: "memory-agent-audit.json",
  },
  {
    capability: "trusted_agent_tools",
    args: ["scripts/memory-trusted-agent.ts"],
    outputFile: "trusted-agent-list.json",
  },
];

export async function buildTrustedAgentSmokeReport(options: BuildTrustedAgentSmokeOptions = {}): Promise<TrustedAgentSmokeReport> {
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
  const runtimeDir = options.runtimeDir ?? await mkdtemp(path.join(os.tmpdir(), "memory-xx-trusted-agent-smoke-"));
  const ownsRuntimeDir = !options.runtimeDir;
  try {
    await mkdir(runtimeDir, { recursive: true });
    const outputFilesByCapability = new Map<TrustedAgentCapabilityName, string[]>(
      CAPABILITIES.map((capability) => [capability, []])
    );
    for (const command of TRUSTED_AGENT_COMMANDS) {
      const outputFile = path.join(runtimeDir, command.outputFile);
      await (options.runCommand ?? runTrustedAgentCommand)(command.capability, command.args, outputFile, env);
      outputFilesByCapability.get(command.capability)?.push(outputFile);
    }

    const results = Object.fromEntries(
      await Promise.all(CAPABILITIES.map(async (capability) => [
        capability,
        await readCapabilityResult(outputFilesByCapability.get(capability) ?? []),
      ]))
    ) as Partial<Record<TrustedAgentCapabilityName, TrustedAgentCapabilityResult>>;

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

function requiredEnvBlockers(env: TrustedAgentSmokeEnv): readonly string[] {
  const blockers: string[] = [];
  if (!env.MEMORY_XX_DATABASE_URL?.trim()) blockers.push("missing_env:MEMORY_XX_DATABASE_URL");
  if (!env.MEMORY_XX_CLI_TOKEN?.trim() && !env.MEMORY_XX_ADMIN_TOKEN?.trim() && !env.MEMORY_XX_API_TOKEN?.trim()) {
    blockers.push("missing_env:MEMORY_XX_CLI_TOKEN_OR_MEMORY_XX_ADMIN_TOKEN");
  }
  return blockers;
}

async function runTrustedAgentCommand(
  _name: TrustedAgentCapabilityName,
  args: readonly string[],
  outputFile: string,
  env: TrustedAgentSmokeEnv
): Promise<string> {
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
        TMPDIR: "/tmp",
        MEMORY_XX_RUNTIME_DIR: env.MEMORY_XX_RUNTIME_DIR ?? path.dirname(outputFile),
      },
      encoding: "utf8",
      timeout: Number.parseInt(env.MEMORY_XX_TRUSTED_AGENT_SMOKE_TIMEOUT_MS ?? "300000", 10),
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

async function readCapabilityResult(outputFiles: readonly string[]): Promise<TrustedAgentCapabilityResult> {
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
  if (body.ok !== true) return false;
  if (Array.isArray(body.trusted_agents)) return true;
  if (Array.isArray(body.agents) && Array.isArray(body.grants)) return true;
  if (typeof body.active_agents === "number" && typeof body.active_grants === "number") return true;
  return false;
}

function isDegradedEvidence(body: Record<string, any>): boolean {
  if (body.degraded === true || body.status === "degraded") return true;
  if (body.ok === false && extractBlockers(body).length > 0) return true;
  if (typeof body.active_agents === "number" && body.active_agents > 0) return true;
  if (typeof body.active_grants === "number" && body.active_grants > 0) return true;
  if (Array.isArray(body.trusted_agents) && body.trusted_agents.length > 0) return true;
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
  const report = await buildTrustedAgentSmokeReport({
    keepRuntimeDir: process.argv.includes("--keep-runtime-dir"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

const entrypoint = process.argv[1] ?? "";
if (entrypoint.endsWith("scripts/trusted-agent-smoke.ts") || entrypoint.endsWith("scripts\\trusted-agent-smoke.ts")) {
  void main();
}

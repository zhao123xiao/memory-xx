import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type EnvMap = Record<string, string | undefined>;
type CapabilityName = "self_improvement_ops";

interface SelfImprovementCommand {
  readonly args: readonly string[];
  readonly outputFile: string;
}

export interface SelfImprovementOpsSmokeInput {
  readonly env?: EnvMap;
  readonly runtimeDir?: string;
  readonly keepRuntimeDir?: boolean;
  readonly runCommand?: (name: CapabilityName, args: readonly string[], outputFile: string, env: EnvMap) => Promise<string>;
}

interface SelfImprovementOpsResult {
  readonly ok: boolean;
  readonly degraded: boolean;
  readonly output_files: readonly string[];
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly summaries: readonly Record<string, unknown>[];
}

export interface SelfImprovementOpsSmokeReport {
  readonly ok: boolean;
  readonly runtime_dir: string | null;
  readonly checked_capabilities: readonly CapabilityName[];
  readonly results: Partial<Record<CapabilityName, SelfImprovementOpsResult>>;
  readonly degraded: boolean;
  readonly blockers: readonly string[];
}

const CAPABILITY: CapabilityName = "self_improvement_ops";

const SELF_IMPROVEMENT_COMMANDS: readonly SelfImprovementCommand[] = [
  {
    args: [
      "scripts/memory-self-improvement.ts",
      "--dry-run",
      "--json",
      "--no-write-memory",
      "--skip-quality",
      "--deterministic",
      "--collector-timeout-ms=5000",
      "--llm-timeout-ms=1000",
    ],
    outputFile: "self-improvement.json",
  },
  {
    args: ["scripts/memory-graphiti-shadow-export.ts", "--limit=1"],
    outputFile: "graphiti-shadow-export.json",
  },
  {
    args: ["scripts/memory-sweep-test-pollution.ts", "--limit=25"],
    outputFile: "sweep-test-pollution.json",
  },
];

export async function buildSelfImprovementOpsSmokeReport(
  input: SelfImprovementOpsSmokeInput = {}
): Promise<SelfImprovementOpsSmokeReport> {
  const env = input.env ?? process.env;
  const missing = requiredEnvBlockers(env);
  if (missing.length > 0) {
    return {
      ok: false,
      runtime_dir: input.runtimeDir ?? null,
      checked_capabilities: [CAPABILITY],
      results: {},
      degraded: false,
      blockers: missing,
    };
  }

  const runtimeDir = input.runtimeDir ?? await mkdtemp(path.join(os.tmpdir(), "memory-xx-self-improvement-ops-smoke-"));
  const ownsRuntimeDir = !input.runtimeDir;
  try {
    await mkdir(runtimeDir, { recursive: true });
    const outputFiles: string[] = [];
    for (const command of SELF_IMPROVEMENT_COMMANDS) {
      const outputFile = path.join(runtimeDir, command.outputFile);
      await (input.runCommand ?? runSelfImprovementCommand)(CAPABILITY, command.args, outputFile, env);
      outputFiles.push(outputFile);
    }

    const result = await readSelfImprovementOpsResult(outputFiles);
    const blockers = result.ok ? [] : result.blockers.length > 0 ? result.blockers : ["self_improvement_ops_report_not_ok"];
    return {
      ok: blockers.length === 0,
      runtime_dir: runtimeDir,
      checked_capabilities: [CAPABILITY],
      results: { self_improvement_ops: result },
      degraded: result.degraded,
      blockers,
    };
  } finally {
    if (ownsRuntimeDir && !input.keepRuntimeDir) {
      await rm(runtimeDir, { recursive: true, force: true });
    }
  }
}

function requiredEnvBlockers(env: EnvMap): readonly string[] {
  return [["MEMORY_XX_DATABASE_URL", env.MEMORY_XX_DATABASE_URL]]
    .filter(([, value]) => !value?.trim())
    .map(([name]) => `missing_env:${name}`);
}

async function runSelfImprovementCommand(
  _name: CapabilityName,
  args: readonly string[],
  outputFile: string,
  env: EnvMap
): Promise<string> {
  try {
    const child = await execFileAsync(process.execPath, ["--import", "tsx", ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
        TMPDIR: "/tmp",
        MEMORY_XX_REPORT_DIR: env.MEMORY_XX_REPORT_DIR ?? path.dirname(outputFile),
      },
      encoding: "utf8",
      timeout: Number.parseInt(env.MEMORY_XX_SELF_IMPROVEMENT_OPS_SMOKE_TIMEOUT_MS || "300000", 10),
      maxBuffer: 16 * 1024 * 1024,
    });
    await writeFile(outputFile, `${child.stdout.trim() || "{}"}\n`, "utf8");
  } catch (error: any) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    await writeFile(outputFile, stdout.trim() ? `${stdout.trim()}\n` : `${JSON.stringify({
      ok: false,
      blockers: [error instanceof Error ? error.message : String(error)],
      stderr_tail: stderr.slice(-3000),
    }, null, 2)}\n`, "utf8");
  }
  return outputFile;
}

async function readSelfImprovementOpsResult(outputFiles: readonly string[]): Promise<SelfImprovementOpsResult> {
  const reports = await Promise.all(outputFiles.map(async (file) => ({
    file,
    body: parseLastJson(await readFile(file, "utf8")),
  })));
  const blockers = reports.flatMap(({ body, file }) => isOkEvidence(path.basename(file), body)
    ? []
    : [`${path.basename(file)}:${firstBlocker(body)}`]);
  return {
    ok: reports.length === SELF_IMPROVEMENT_COMMANDS.length && blockers.length === 0,
    degraded: blockers.length > 0,
    output_files: outputFiles,
    blockers,
    warnings: reports.flatMap(({ body }) => stringArray(body.warnings)),
    summaries: reports.map(({ file, body }) => summarize(path.basename(file), body)),
  };
}

function isOkEvidence(file: string, body: Record<string, any>): boolean {
  if (file === "self-improvement.json") {
    return body.ok === true && (Array.isArray(body.entries) || body.proposal && typeof body.proposal === "object");
  }
  if (file === "graphiti-shadow-export.json") {
    return body.ok === true && typeof body.records === "number";
  }
  if (file === "sweep-test-pollution.json") {
    return body.ok === true && body.mode === "dry_run";
  }
  return body.ok === true;
}

function summarize(file: string, body: Record<string, any>): Record<string, unknown> {
  return {
    file,
    ok: body.ok ?? null,
    mode: body.mode ?? null,
    proposal_source: body.proposal_source ?? null,
    entries: Array.isArray(body.entries) ? body.entries.length : null,
    records: typeof body.records === "number" ? body.records : null,
    matched: typeof body.matched === "number" ? body.matched : null,
    rejected_count: typeof body.rejected_count === "number" ? body.rejected_count : null,
  };
}

function firstBlocker(body: Record<string, any>): string {
  const blockers = stringArray(body.blockers);
  if (blockers.length > 0) return blockers[0]!;
  const failures = Array.isArray(body.failures) ? body.failures : [];
  if (failures.length > 0) return "failures_present";
  if (typeof body.error === "string") return body.error;
  if (typeof body.status === "string") return body.status;
  return "not_ok";
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
  return value.map((item) => typeof item === "string" ? item : String(item)).filter((item) => item.trim() !== "");
}

async function main(): Promise<void> {
  const report = await buildSelfImprovementOpsSmokeReport({
    keepRuntimeDir: process.argv.includes("--keep-runtime-dir"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  void main();
}

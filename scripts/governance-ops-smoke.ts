import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type EnvMap = Record<string, string | undefined>;
type CapabilityName = "governance_operations";

interface GovernanceCommand {
  readonly args: readonly string[];
  readonly outputFile: string;
}

export interface GovernanceOpsSmokeInput {
  readonly env?: EnvMap;
  readonly runtimeDir?: string;
  readonly keepRuntimeDir?: boolean;
  readonly runCommand?: (name: CapabilityName, args: readonly string[], outputFile: string, env: EnvMap) => Promise<string>;
}

interface GovernanceOpsResult {
  readonly ok: boolean;
  readonly degraded: boolean;
  readonly output_files: readonly string[];
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly summaries: readonly Record<string, unknown>[];
}

export interface GovernanceOpsSmokeReport {
  readonly ok: boolean;
  readonly runtime_dir: string | null;
  readonly checked_capabilities: readonly CapabilityName[];
  readonly results: Partial<Record<CapabilityName, GovernanceOpsResult>>;
  readonly degraded: boolean;
  readonly blockers: readonly string[];
}

const CAPABILITY: CapabilityName = "governance_operations";

const GOVERNANCE_COMMANDS: readonly GovernanceCommand[] = [
  {
    args: ["scripts/memory-pending.ts", "--limit=25"],
    outputFile: "pending.json",
  },
  {
    args: ["scripts/memory-pending-governance.ts", "--limit=25"],
    outputFile: "pending-governance.json",
  },
  {
    args: ["scripts/memory-pending-canary-report.ts", "--json", "--limit=25"],
    outputFile: "pending-canary-report.json",
  },
  {
    args: ["scripts/memory-policy-backfill.ts", "--json", "--limit=25"],
    outputFile: "policy-backfill.json",
  },
  {
    args: ["scripts/memory-event-lifecycle.ts"],
    outputFile: "event-lifecycle.json",
  },
];

export async function buildGovernanceOpsSmokeReport(input: GovernanceOpsSmokeInput = {}): Promise<GovernanceOpsSmokeReport> {
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

  const runtimeDir = input.runtimeDir ?? await mkdtemp(path.join(os.tmpdir(), "memory-xx-governance-ops-smoke-"));
  const ownsRuntimeDir = !input.runtimeDir;
  try {
    await mkdir(runtimeDir, { recursive: true });
    const outputFiles: string[] = [];
    for (const command of GOVERNANCE_COMMANDS) {
      const outputFile = path.join(runtimeDir, command.outputFile);
      await (input.runCommand ?? runGovernanceCommand)(CAPABILITY, command.args, outputFile, env);
      outputFiles.push(outputFile);
    }

    const result = await readGovernanceResult(outputFiles);
    const blockers = result.ok ? [] : result.blockers.length > 0 ? result.blockers : ["governance_ops_report_not_ok"];
    return {
      ok: blockers.length === 0,
      runtime_dir: runtimeDir,
      checked_capabilities: [CAPABILITY],
      results: { governance_operations: result },
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

async function runGovernanceCommand(
  _name: CapabilityName,
  args: readonly string[],
  outputFile: string,
  env: EnvMap
): Promise<string> {
  try {
    const child = await execFileAsync(process.execPath, ["--import", "tsx", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env, TMPDIR: "/tmp" },
      encoding: "utf8",
      timeout: Number.parseInt(env.MEMORY_XX_GOVERNANCE_OPS_SMOKE_TIMEOUT_MS || "300000", 10),
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

async function readGovernanceResult(outputFiles: readonly string[]): Promise<GovernanceOpsResult> {
  const reports = await Promise.all(outputFiles.map(async (file) => ({
    file,
    body: parseLastJson(await readFile(file, "utf8")),
  })));
  const blockers = reports.flatMap(({ body, file }) => isOkEvidence(body)
    ? []
    : [`${path.basename(file)}:${firstBlocker(body)}`]);
  return {
    ok: reports.length === GOVERNANCE_COMMANDS.length && blockers.length === 0,
    degraded: blockers.length > 0,
    output_files: outputFiles,
    blockers,
    warnings: reports.flatMap(({ body }) => stringArray(body.warnings)),
    summaries: reports.map(({ file, body }) => summarize(path.basename(file), body)),
  };
}

function isOkEvidence(body: Record<string, any>): boolean {
  if (body.ok === true) return true;
  if (body.mode === "dry_run" || body.mode === "dry-run" || body.mode === "scan") return true;
  if (typeof body.pending_count === "number" && body.sweep_summary && typeof body.sweep_summary === "object") return true;
  if (body.plan && typeof body.plan === "object" && body.mode !== "apply") return true;
  return false;
}

function summarize(file: string, body: Record<string, any>): Record<string, unknown> {
  return {
    file,
    ok: body.ok ?? null,
    mode: body.mode ?? null,
    candidate_current: body.candidate_current ?? null,
    pending_count: body.pending_count ?? null,
    matched: body.matched ?? null,
    eligible: body.eligible ?? null,
    events: Array.isArray(body.events) ? body.events.length : null,
  };
}

function firstBlocker(body: Record<string, any>): string {
  const blockers = stringArray(body.blockers);
  if (blockers.length > 0) return blockers[0]!;
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
  const report = await buildGovernanceOpsSmokeReport({
    keepRuntimeDir: process.argv.includes("--keep-runtime-dir"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  void main();
}

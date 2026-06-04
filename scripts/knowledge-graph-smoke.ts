import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type KnowledgeGraphCapabilityName = "knowledge_ingest" | "memory_knowledge_graph" | "code_graph";

export interface KnowledgeGraphSmokeEnv {
  readonly [key: string]: string | undefined;
}

export interface KnowledgeGraphCapabilityResult {
  readonly ok: boolean;
  readonly degraded: boolean;
  readonly output_files: readonly string[];
  readonly status?: string;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export interface KnowledgeGraphSmokeReport {
  readonly ok: boolean;
  readonly mode: "live";
  readonly runtime_dir: string | null;
  readonly checked_capabilities: readonly KnowledgeGraphCapabilityName[];
  readonly results: Partial<Record<KnowledgeGraphCapabilityName, KnowledgeGraphCapabilityResult>>;
  readonly degraded: boolean;
  readonly blockers: readonly string[];
}

interface KnowledgeGraphCommand {
  readonly capability: KnowledgeGraphCapabilityName;
  readonly args: readonly string[];
  readonly outputFile: string;
}

interface BuildKnowledgeGraphSmokeOptions {
  readonly env?: KnowledgeGraphSmokeEnv;
  readonly runtimeDir?: string;
  readonly allowDegraded?: boolean;
  readonly keepRuntimeDir?: boolean;
  readonly runCommand?: (name: KnowledgeGraphCapabilityName, args: readonly string[], outputFile: string, env: KnowledgeGraphSmokeEnv) => Promise<string>;
}

const CAPABILITIES: readonly KnowledgeGraphCapabilityName[] = [
  "knowledge_ingest",
  "memory_knowledge_graph",
  "code_graph",
];

const KNOWLEDGE_GRAPH_COMMANDS: readonly KnowledgeGraphCommand[] = [
  {
    capability: "knowledge_ingest",
    args: ["scripts/memory-knowledge-md.ts", "scan", "--dry-run", "--json", "--root=.", "--max-files=200", "--skip-state-probe"],
    outputFile: "knowledge-scan.json",
  },
  {
    capability: "memory_knowledge_graph",
    args: ["scripts/graph-health.ts"],
    outputFile: "graph-health.json",
  },
  {
    capability: "memory_knowledge_graph",
    args: ["scripts/memory-graph-report.ts"],
    outputFile: "memory-graph-report.json",
  },
  {
    capability: "code_graph",
    args: ["scripts/memory-code-graph.ts", "--root=.", "--json", "--max-files=200", "--limit=120"],
    outputFile: "code-graph.json",
  },
];

export async function buildKnowledgeGraphSmokeReport(options: BuildKnowledgeGraphSmokeOptions = {}): Promise<KnowledgeGraphSmokeReport> {
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
  const runtimeDir = options.runtimeDir ?? await mkdtemp(path.join(os.tmpdir(), "memory-xx-knowledge-graph-smoke-"));
  const ownsRuntimeDir = !options.runtimeDir;
  try {
    await mkdir(runtimeDir, { recursive: true });
    const outputFilesByCapability = new Map<KnowledgeGraphCapabilityName, string[]>(
      CAPABILITIES.map((capability) => [capability, []])
    );
    for (const command of KNOWLEDGE_GRAPH_COMMANDS) {
      const outputFile = path.join(runtimeDir, command.outputFile);
      await (options.runCommand ?? runKnowledgeGraphCommand)(command.capability, command.args, outputFile, env);
      outputFilesByCapability.get(command.capability)?.push(outputFile);
    }

    const results = Object.fromEntries(
      await Promise.all(CAPABILITIES.map(async (capability) => [
        capability,
        await readCapabilityResult(capability, outputFilesByCapability.get(capability) ?? []),
      ]))
    ) as Partial<Record<KnowledgeGraphCapabilityName, KnowledgeGraphCapabilityResult>>;

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

function requiredEnvBlockers(env: KnowledgeGraphSmokeEnv): readonly string[] {
  return env.MEMORY_XX_DATABASE_URL?.trim() ? [] : ["missing_env:MEMORY_XX_DATABASE_URL"];
}

async function runKnowledgeGraphCommand(
  _name: KnowledgeGraphCapabilityName,
  args: readonly string[],
  outputFile: string,
  env: KnowledgeGraphSmokeEnv
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
      timeout: Number.parseInt(env.MEMORY_XX_KNOWLEDGE_GRAPH_SMOKE_TIMEOUT_MS ?? "300000", 10),
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

async function readCapabilityResult(capability: KnowledgeGraphCapabilityName, outputFiles: readonly string[]): Promise<KnowledgeGraphCapabilityResult> {
  const reports = await Promise.all(outputFiles.map(async (file) => ({ file, body: parseLastJson(await readFile(file, "utf8")) })));
  const blockers = reports.flatMap(({ body }) => extractBlockers(body));
  const warnings = reports.flatMap(({ body }) => stringArray(body.warnings));
  const allOk = reports.length > 0 && reports.every(({ body }) => isOkEvidence(capability, body));
  const degraded = reports.some(({ body }) => isDegradedEvidence(capability, body));
  return {
    ok: allOk,
    degraded,
    output_files: outputFiles,
    status: reports.find(({ body }) => typeof body.status === "string")?.body.status,
    blockers,
    warnings,
  };
}

function isOkEvidence(capability: KnowledgeGraphCapabilityName, body: Record<string, any>): boolean {
  if (body.ok === true || body.status === "ok" || body.status === "healthy") return true;
  if (capability === "knowledge_ingest" && body.command === "scan" && Array.isArray(body.candidates)) return true;
  if (capability === "memory_knowledge_graph" && Array.isArray(body.files) && typeof body.out_dir === "string") return true;
  if (capability === "code_graph" && body.summary && typeof body.summary === "object") return true;
  return false;
}

function isDegradedEvidence(_capability: KnowledgeGraphCapabilityName, body: Record<string, any>): boolean {
  return body.degraded === true || body.status === "degraded" || (body.ok === false && extractBlockers(body).length > 0);
}

function extractBlockers(body: Record<string, any>): readonly string[] {
  return [
    ...stringArray(body.blockers),
    ...stringArray(body.blocked_reasons),
    ...stringArray(body.issues?.map?.((issue: any) => issue.id ?? issue.message ?? "issue")),
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
  return value.map((item) => typeof item === "string" ? item : String(item)).filter((item) => item.trim() !== "");
}

async function main(): Promise<void> {
  const report = await buildKnowledgeGraphSmokeReport({
    keepRuntimeDir: process.argv.includes("--keep-runtime-dir"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

const entrypoint = process.argv[1] ?? "";
if (entrypoint.endsWith("scripts/knowledge-graph-smoke.ts") || entrypoint.endsWith("scripts\\knowledge-graph-smoke.ts")) {
  void main();
}

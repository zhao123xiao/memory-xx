import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type EnvMap = Record<string, string | undefined>;
type CapabilityName = "local_embedding_generation";

export interface LocalEmbeddingGenerationSmokeInput {
  readonly env?: EnvMap;
  readonly runtimeDir?: string;
  readonly runCommand?: (name: CapabilityName, args: readonly string[], outputFile: string, env: EnvMap) => Promise<string>;
}

interface CapabilityResult {
  readonly ok: boolean;
  readonly degraded: boolean;
  readonly artifact?: string;
  readonly blockers: readonly string[];
  readonly summary?: Record<string, unknown>;
}

export interface LocalEmbeddingGenerationSmokeReport {
  readonly ok: boolean;
  readonly degraded: boolean;
  readonly checked_capabilities: readonly CapabilityName[];
  readonly blockers: readonly string[];
  readonly artifacts: Partial<Record<CapabilityName, string>>;
  readonly results: Partial<Record<CapabilityName, CapabilityResult>>;
}

function requiredBlockers(env: EnvMap): string[] {
  const blockers: string[] = [];
  if (!env.MEMORY_XX_DATABASE_URL?.trim()) blockers.push("missing_env:MEMORY_XX_DATABASE_URL");
  if (!env.MEMORY_XX_QDRANT_BASE_URL?.trim()) blockers.push("missing_env:MEMORY_XX_QDRANT_BASE_URL");
  if (!env.EMBEDDING_API_BASE?.trim()) blockers.push("missing_env:EMBEDDING_API_BASE");
  if (!(env.OPENAI_API_KEY?.trim() || env.EMBEDDING_API_KEY?.trim())) {
    blockers.push("missing_env:OPENAI_API_KEY_OR_EMBEDDING_API_KEY");
  }
  return blockers;
}

async function defaultRunner(_name: CapabilityName, args: readonly string[], outputFile: string, env: EnvMap): Promise<string> {
  const child = await execFileAsync(process.execPath, ["--import", "tsx", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, TMPDIR: "/tmp" },
    encoding: "utf8",
    timeout: Number.parseInt(env.MEMORY_XX_LOCAL_EMBEDDING_GENERATION_SMOKE_TIMEOUT_MS || "180000", 10),
    maxBuffer: 8 * 1024 * 1024,
  });
  await writeFile(outputFile, child.stdout || "", "utf8");
  return outputFile;
}

async function newestEstimate(reportRoot: string): Promise<string | null> {
  const root = path.join(reportRoot, "local-memory-embedding");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return null;
  }
  const candidates = entries
    .filter((entry) => entry.startsWith("local-memory-embedding-"))
    .sort()
    .reverse();
  for (const candidate of candidates) {
    const file = path.join(root, candidate, "estimate.json");
    try {
      await readFile(file, "utf8");
      return file;
    } catch {
      continue;
    }
  }
  return null;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

function estimateSummary(body: Record<string, unknown>): Record<string, unknown> {
  const estimate = body.estimate && typeof body.estimate === "object"
    ? body.estimate as Record<string, unknown>
    : {};
  return {
    run_id: body.run_id ?? null,
    records: estimate.records ?? null,
    concurrency: estimate.concurrency ?? null,
    batch_size: estimate.batch_size ?? null,
    estimated_total_ms: estimate.estimated_total_ms ?? null,
    target_collection: estimate.target_collection ?? null,
  };
}

export async function buildLocalEmbeddingGenerationSmokeReport(
  input: LocalEmbeddingGenerationSmokeInput = {}
): Promise<LocalEmbeddingGenerationSmokeReport> {
  const env = input.env ?? process.env;
  const checked = ["local_embedding_generation"] as const;
  const blockers = requiredBlockers(env);
  if (blockers.length > 0) {
    return {
      ok: false,
      degraded: true,
      checked_capabilities: checked,
      blockers,
      artifacts: {},
      results: {},
    };
  }

  const runtimeDir = input.runtimeDir ?? await mkdtemp(path.join(os.tmpdir(), "memory-xx-local-embedding-generation-"));
  await mkdir(runtimeDir, { recursive: true });
  const reportRoot = path.join(runtimeDir, "reports");
  const outputFile = path.join(runtimeDir, "local-embedding-generation.stdout");
  const runCommand = input.runCommand ?? defaultRunner;
  const commandEnv = {
    ...env,
    MEMORY_XX_REPORT_DIR: reportRoot,
  };
  const commandArgs = [
    "scripts/generate-local-memory-embeddings.ts",
    "--estimate-only",
    "--limit=1",
    "--concurrency=1",
    "--batch-size=1",
  ];

  try {
    await runCommand("local_embedding_generation", commandArgs, outputFile, commandEnv);
    const reportFile = await newestEstimate(reportRoot) ?? path.join(runtimeDir, "estimate.json");
    const estimate = await readJson(reportFile);
    const estimateData = estimate.estimate && typeof estimate.estimate === "object"
      ? estimate.estimate as Record<string, unknown>
      : {};
    const ok = Number(estimateData.records ?? 0) >= 0;
    const result: CapabilityResult = {
      ok,
      degraded: !ok,
      artifact: reportFile,
      blockers: ok ? [] : ["local_embedding_estimate_missing"],
      summary: estimateSummary(estimate),
    };
    return {
      ok,
      degraded: !ok,
      checked_capabilities: checked,
      blockers: ok ? [] : ["local_embedding_estimate_missing"],
      artifacts: { local_embedding_generation: reportFile },
      results: { local_embedding_generation: result },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      degraded: true,
      checked_capabilities: checked,
      blockers: ["local_embedding_estimate_failed"],
      artifacts: {},
      results: {
        local_embedding_generation: {
          ok: false,
          degraded: true,
          blockers: [message],
        },
      },
    };
  }
}

async function main(): Promise<void> {
  const runtimeDir = path.join(os.tmpdir(), `memory-xx-local-embedding-generation-${randomUUID()}`);
  const report = await buildLocalEmbeddingGenerationSmokeReport({ runtimeDir });
  process.stdout.write(`${JSON.stringify({ ...report, runtime_dir: runtimeDir }, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  void main();
}

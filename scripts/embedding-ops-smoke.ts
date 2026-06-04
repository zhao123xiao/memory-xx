import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type EnvMap = Record<string, string | undefined>;

export interface EmbeddingOpsSmokeInput {
  readonly env?: EnvMap;
  readonly runtimeDir?: string;
  readonly runCommand?: (name: string, args: readonly string[], outputFile: string, env: EnvMap) => Promise<string>;
}

interface CapabilityResult {
  readonly ok: boolean;
  readonly degraded: boolean;
  readonly artifact?: string;
  readonly blockers?: readonly string[];
  readonly summary?: Record<string, unknown>;
}

type MutableResults = {
  embedding_manifest?: CapabilityResult;
  embedding_calibration?: CapabilityResult;
};

export interface EmbeddingOpsSmokeReport {
  readonly ok: boolean;
  readonly degraded: boolean;
  readonly checked_capabilities: readonly ["embedding_manifest", "embedding_calibration"];
  readonly blockers: readonly string[];
  readonly artifacts: Record<string, string>;
  readonly results: Readonly<MutableResults>;
}

function requiredBlockers(env: EnvMap): string[] {
  const blockers: string[] = [];
  if (!env.MEMORY_XX_DATABASE_URL?.trim()) blockers.push("missing_env:MEMORY_XX_DATABASE_URL");
  if (!env.MEMORY_XX_QDRANT_BASE_URL?.trim()) blockers.push("missing_env:MEMORY_XX_QDRANT_BASE_URL");
  if (!(env.EMBEDDING_API_BASE?.trim() || env.EMBEDDING_PROXY_UPSTREAM_BASE?.trim())) {
    blockers.push("missing_env:EMBEDDING_API_BASE");
  }
  if (!(env.OPENAI_API_KEY?.trim() || env.EMBEDDING_PROXY_UPSTREAM_API_KEY?.trim() || env.EMBEDDING_API_KEY?.trim())) {
    blockers.push("missing_env:OPENAI_API_KEY_OR_EMBEDDING_PROXY_UPSTREAM_API_KEY");
  }
  return blockers;
}

async function defaultRunner(_name: string, args: readonly string[], outputFile: string, env: EnvMap): Promise<string> {
  const child = await execFileAsync(process.execPath, [...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, TMPDIR: "/tmp" },
    encoding: "utf8",
    timeout: Number.parseInt(env.MEMORY_XX_EMBEDDING_OPS_SMOKE_TIMEOUT_MS || "120000", 10),
    maxBuffer: 8 * 1024 * 1024,
  });
  await writeFile(outputFile, child.stdout || "{}", "utf8");
  return outputFile;
}

async function newestJsonReport(reportRoot: string): Promise<string | null> {
  const root = path.join(reportRoot, "embedding-calibration");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return null;
  }
  const candidates = entries
    .filter((entry) => entry.startsWith("embedding-calibration-"))
    .sort()
    .reverse();
  for (const candidate of candidates) {
    const file = path.join(root, candidate, "embedding-calibration.json");
    try {
      await readFile(file, "utf8");
      return file;
    } catch {
      continue;
    }
  }
  return null;
}

function manifestSummary(data: Record<string, unknown>): Record<string, unknown> {
  const active = data.active_generation && typeof data.active_generation === "object"
    ? data.active_generation as Record<string, unknown>
    : null;
  const rows = Array.isArray(data.recent_generations) ? data.recent_generations : [];
  return {
    has_active: Boolean(active),
    active_id: active?.generation_id ?? null,
    active_status: active?.status ?? null,
    target_collection: active?.target_collection ?? null,
    qdrant_alias: active?.qdrant_alias ?? null,
    recent_count: rows.length,
  };
}

function calibrationSummary(data: Record<string, unknown>): Record<string, unknown> {
  const matrix = Array.isArray(data.matrix) ? data.matrix : [];
  const selected = data.recommendation && typeof data.recommendation === "object"
    ? (data.recommendation as Record<string, unknown>).selected ?? null
    : null;
  return {
    run_id: data.run_id ?? null,
    upstream_base: data.upstream_base ?? null,
    model: data.model ?? null,
    dims: data.dims ?? null,
    cells: matrix.length,
    selected,
  };
}

async function readJsonFile(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

export async function buildEmbeddingOpsSmokeReport(input: EmbeddingOpsSmokeInput = {}): Promise<EmbeddingOpsSmokeReport> {
  const env = input.env ?? process.env;
  const blockers = requiredBlockers(env);
  const checked = ["embedding_manifest", "embedding_calibration"] as const;
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

  const ownRuntimeDir = input.runtimeDir ? null : await mkdtemp(path.join(os.tmpdir(), "memory-xx-embedding-ops-"));
  const runtimeDir = input.runtimeDir ?? ownRuntimeDir!;
  await mkdir(runtimeDir, { recursive: true });
  const runCommand = input.runCommand ?? defaultRunner;
  const reportRoot = path.join(runtimeDir, "reports");
  const artifacts: Record<string, string> = {};
  const results: MutableResults = {};
  const allBlockers: string[] = [];

  try {
    const manifestFile = path.join(runtimeDir, "embedding-manifest-status.json");
    await runCommand("embedding_manifest", ["--import", "tsx", "scripts/embedding-manifest.ts", "status"], manifestFile, env);
    const manifest = await readJsonFile(manifestFile);
    artifacts.embedding_manifest = manifestFile;
    results.embedding_manifest = {
      ok: manifest.ok !== false,
      degraded: manifest.ok === false,
      artifact: manifestFile,
      blockers: manifest.ok === false ? ["embedding_manifest_status_failed"] : [],
      summary: manifestSummary(manifest),
    };
    if (manifest.ok === false) allBlockers.push("embedding_manifest_status_failed");
  } catch (error) {
    allBlockers.push("embedding_manifest_status_failed");
    results.embedding_manifest = {
      ok: false,
      degraded: true,
      blockers: [error instanceof Error ? error.message : String(error)],
    };
  }

  try {
    const calibrationEnv = {
      ...env,
      MEMORY_XX_REPORT_DIR: reportRoot,
      EMBEDDING_CALIBRATION_REQUESTS_PER_CELL: "1",
      EMBEDDING_CALIBRATION_COOLDOWN_MS: "1",
      EMBEDDING_CALIBRATION_TIMEOUT_MS: "5000",
    };
    const placeholder = path.join(runtimeDir, "embedding-calibration.stdout");
    await runCommand("embedding_calibration", ["--import", "tsx", "scripts/embedding-calibration.ts"], placeholder, calibrationEnv);
    const reportFile = await newestJsonReport(reportRoot) ?? path.join(runtimeDir, "embedding-calibration.json");
    const calibration = await readJsonFile(reportFile);
    const artifact = path.join(runtimeDir, "embedding-calibration.json");
    if (reportFile !== artifact) await writeFile(artifact, JSON.stringify(calibration, null, 2), "utf8");
    artifacts.embedding_calibration = artifact;
    const matrix = Array.isArray(calibration.matrix) ? calibration.matrix : [];
    const ok = matrix.length > 0;
    results.embedding_calibration = {
      ok,
      degraded: !ok,
      artifact,
      blockers: ok ? [] : ["embedding_calibration_report_missing"],
      summary: calibrationSummary(calibration),
    };
    if (!ok) allBlockers.push("embedding_calibration_report_missing");
  } catch (error) {
    allBlockers.push("embedding_calibration_failed");
    results.embedding_calibration = {
      ok: false,
      degraded: true,
      blockers: [error instanceof Error ? error.message : String(error)],
    };
  }

  const ok = allBlockers.length === 0 &&
    results.embedding_manifest?.ok === true &&
    results.embedding_calibration?.ok === true;
  return {
    ok,
    degraded: !ok,
    checked_capabilities: checked,
    blockers: allBlockers,
    artifacts,
    results,
  };
}

async function main(): Promise<void> {
  const runtimeDir = path.join(os.tmpdir(), `memory-xx-embedding-ops-${randomUUID()}`);
  const report = await buildEmbeddingOpsSmokeReport({ runtimeDir });
  console.log(JSON.stringify({ ...report, runtime_dir: runtimeDir }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

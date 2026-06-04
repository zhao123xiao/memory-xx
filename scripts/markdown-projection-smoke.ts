import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  IngestRequestRepository,
  MemoryRecordRepository,
  type WriteTransactionRunner,
  PostgresWriteDatabase,
  withWriteTransaction,
} from "../app/db";
import {
  LifecycleStatus,
  ReviewState,
  ScopeType,
  type JsonObject,
} from "../app/shared";
import { WriteCommandType, type NormalizedCreateMemoryCommand } from "../app/shared/contracts/write";
import { loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";

const execFileAsync = promisify(execFile);

export interface MarkdownProjectionSmokeEnv {
  readonly [key: string]: string | undefined;
}

export interface MarkdownProjectionWorkerStatus {
  readonly worker?: string;
  readonly success?: boolean;
  readonly docsWritten?: number;
  readonly docsSkipped?: number;
  readonly docsRemoved?: number;
  readonly errors?: readonly unknown[];
  readonly duration_ms?: number;
  readonly at?: string;
  readonly error?: string;
}

export interface MarkdownProjectionSmokeReport {
  readonly ok: boolean;
  readonly mode: "live";
  readonly runtime_dir: string | null;
  readonly projection_root: string | null;
  readonly memory_id: string | null;
  readonly worker_status: MarkdownProjectionWorkerStatus | null;
  readonly generated_markdown_files: readonly string[];
  readonly blockers: readonly string[];
}

interface BuildMarkdownProjectionSmokeOptions {
  readonly env?: MarkdownProjectionSmokeEnv;
  readonly runtimeDir?: string;
  readonly projectionRoot?: string;
  readonly seedMemory?: (env: MarkdownProjectionSmokeEnv) => Promise<string>;
  readonly runWorker?: (runtimeDir: string, projectionRoot: string, env: MarkdownProjectionSmokeEnv) => Promise<void>;
  readonly listGeneratedMarkdown?: (projectionRoot: string) => Promise<readonly string[]>;
  readonly keepRuntimeDir?: boolean;
  readonly keepProjectionRoot?: boolean;
}

export async function buildMarkdownProjectionSmokeReport(
  options: BuildMarkdownProjectionSmokeOptions = {}
): Promise<MarkdownProjectionSmokeReport> {
  const env = options.env ?? process.env;
  const blockers = requiredEnvBlockers(env);
  if (blockers.length > 0) {
    return {
      ok: false,
      mode: "live",
      runtime_dir: options.runtimeDir ?? null,
      projection_root: options.projectionRoot ?? null,
      memory_id: null,
      worker_status: null,
      generated_markdown_files: [],
      blockers,
    };
  }

  const runtimeDir = options.runtimeDir ?? await mkdtemp(path.join(os.tmpdir(), "memory-xx-markdown-projection-smoke-"));
  const projectionRoot = options.projectionRoot ?? await mkdtemp(path.join(os.tmpdir(), "memory-xx-markdown-projection-root-"));
  const ownsRuntimeDir = !options.runtimeDir;
  const ownsProjectionRoot = !options.projectionRoot;
  let memoryId: string | null = null;
  try {
    await mkdir(runtimeDir, { recursive: true });
    await mkdir(projectionRoot, { recursive: true });
    memoryId = await (options.seedMemory ?? seedProjectionMemory)(env);
    await (options.runWorker ?? runWorkerOnce)(runtimeDir, projectionRoot, env);
    const workerStatus = await readWorkerStatus(runtimeDir);
    const generatedMarkdownFiles = await (options.listGeneratedMarkdown ?? listMarkdownFiles)(projectionRoot);
    const outputBlockers = [
      ...(workerStatus ? [] : ["worker_status_missing"]),
      ...(workerStatus?.success === true ? [] : [`worker_not_success:${workerStatus?.error ?? "missing"}`]),
      ...(Number(workerStatus?.docsWritten ?? 0) > 0 ? [] : ["worker_docs_written_zero"]),
      ...(generatedMarkdownFiles.length > 0 ? [] : ["markdown_files_missing"]),
    ];

    return {
      ok: outputBlockers.length === 0,
      mode: "live",
      runtime_dir: runtimeDir,
      projection_root: projectionRoot,
      memory_id: memoryId,
      worker_status: workerStatus,
      generated_markdown_files: generatedMarkdownFiles,
      blockers: outputBlockers,
    };
  } finally {
    if (ownsRuntimeDir && !options.keepRuntimeDir) {
      await rm(runtimeDir, { recursive: true, force: true });
    }
    if (ownsProjectionRoot && !options.keepProjectionRoot) {
      await rm(projectionRoot, { recursive: true, force: true });
    }
  }
}

function requiredEnvBlockers(env: MarkdownProjectionSmokeEnv): readonly string[] {
  return [["MEMORY_XX_DATABASE_URL", env.MEMORY_XX_DATABASE_URL]]
    .filter(([, value]) => !value?.trim())
    .map(([name]) => `missing_env:${name}`);
}

export async function seedProjectionMemory(env: MarkdownProjectionSmokeEnv): Promise<string> {
  const db = new PostgresWriteDatabase({ config: loadMemoryXXPostgresConfig(env as NodeJS.ProcessEnv) });
  try {
    return insertProjectionSmokeMemory(db);
  } finally {
    await db.close();
  }
}

export async function insertProjectionSmokeMemory(db: WriteTransactionRunner): Promise<string> {
  const id = randomUUID();
  const requestId = `markdown-projection-smoke-${id}`;
  const ingestRepo = new IngestRequestRepository();
  const repo = new MemoryRecordRepository();
  const command: NormalizedCreateMemoryCommand = {
    requestId,
    actorId: "memory-xx-smoke",
    scopeType: ScopeType.Project,
    scopeId: "memory-xx-smoke",
    content: `Memory XX Smoke markdown projection marker ${id}.`,
    title: "Memory XX Smoke",
    summary: "Smoke record for markdown projection.",
    metadata: {
      category: "projects",
      tags: ["smoke", "markdown_projection"],
      source: "markdown_projection_smoke",
    } satisfies JsonObject,
    dedupeKey: `markdown-projection-smoke:${id}`,
    tenantId: "public",
    agentId: "memory-xx-smoke",
    governanceStatus: "approved",
    visibility: "shared",
    memoryType: "fact",
    contentEmbedding: null,
    validAt: null,
    observedAt: null,
    expiresAt: null,
    lifecycleStatus: LifecycleStatus.Approved,
    reviewState: ReviewState.Approved,
    sources: [],
    relations: [],
  };
  const row = await withWriteTransaction(db, async (tx) => {
    const payloadJson = JSON.stringify(command);
    await ingestRepo.insertAccepted(tx, {
      requestId,
      commandType: WriteCommandType.CreateMemory,
      payloadHash: createHash("sha256").update(payloadJson).digest("hex"),
      payloadJson,
      actorId: command.actorId,
    });
    return repo.create(tx, command);
  });
  return row.id;
}

async function runWorkerOnce(
  runtimeDir: string,
  projectionRoot: string,
  env: MarkdownProjectionSmokeEnv
): Promise<void> {
  await execFileAsync(process.execPath, [
    "--import",
    "tsx",
    "scripts/run-markdown-projection-worker.ts",
    "--views=projects",
    "--limit=25",
    `--root-dir=${projectionRoot}`,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
      TMPDIR: "/tmp",
      MEMORY_XX_RUNTIME_DIR: runtimeDir,
      MEMORY_XX_MARKDOWN_PROJECTION_STATUS_FILE: path.join(runtimeDir, "markdown-projection.status.json"),
    },
    timeout: 120_000,
  });
}

async function readWorkerStatus(runtimeDir: string): Promise<MarkdownProjectionWorkerStatus | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(runtimeDir, "markdown-projection.status.json"), "utf8")) as MarkdownProjectionWorkerStatus;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function listMarkdownFiles(rootDir: string): Promise<readonly string[]> {
  const files: string[] = [];
  await walk(rootDir, files);
  return files.filter((file) => file.endsWith(".md")).sort();
}

async function walk(dir: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
}

async function main(): Promise<void> {
  const report = await buildMarkdownProjectionSmokeReport({
    keepRuntimeDir: process.argv.includes("--keep-runtime-dir"),
    keepProjectionRoot: process.argv.includes("--keep-projection-root"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

const entrypoint = process.argv[1] ?? "";
if (entrypoint.endsWith("scripts/markdown-projection-smoke.ts") || entrypoint.endsWith("scripts\\markdown-projection-smoke.ts")) {
  void main();
}

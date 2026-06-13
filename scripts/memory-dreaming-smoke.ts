import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface MemoryDreamingSmokeEnv {
  readonly [key: string]: string | undefined;
}

export interface MemoryDreamingTaskSummary {
  readonly id?: string;
  readonly task_id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly status?: string;
}

export interface MemoryDreamingWorkerStatus {
  readonly worker?: string;
  readonly worker_id?: string;
  readonly ok?: boolean;
  readonly phase?: string;
  readonly tasks?: readonly MemoryDreamingTaskSummary[];
  readonly report?: {
    readonly summary?: {
      readonly completed?: number;
      readonly skipped?: number;
      readonly failed?: number;
    };
    readonly tasks?: readonly MemoryDreamingTaskSummary[];
  };
  readonly at?: string;
  readonly error?: string;
}

export interface MemoryDreamingSmokeReport {
  readonly ok: boolean;
  readonly mode: "list" | "once";
  readonly runtime_dir: string | null;
  readonly status: MemoryDreamingWorkerStatus | null;
  readonly task_ids: readonly string[];
  readonly degraded: boolean;
  readonly blockers: readonly string[];
}

interface BuildMemoryDreamingSmokeOptions {
  readonly env?: MemoryDreamingSmokeEnv;
  readonly runtimeDir?: string;
  readonly mode?: "list" | "once";
  readonly allowDegraded?: boolean;
  readonly runListTasks?: (runtimeDir: string, env: MemoryDreamingSmokeEnv) => Promise<void>;
  readonly runOnce?: (runtimeDir: string, env: MemoryDreamingSmokeEnv) => Promise<void>;
  readonly keepRuntimeDir?: boolean;
}

export async function buildMemoryDreamingSmokeReport(
  options: BuildMemoryDreamingSmokeOptions = {}
): Promise<MemoryDreamingSmokeReport> {
  const env = options.env ?? process.env;
  const mode = options.mode ?? (process.argv.includes("--once") ? "once" : "list");
  const allowDegraded = options.allowDegraded ?? !process.argv.includes("--strict");
  const runtimeDir = options.runtimeDir ?? await mkdtemp(path.join(os.tmpdir(), "memory-xx-dream-smoke-"));
  const ownsRuntimeDir = !options.runtimeDir;
  try {
    await mkdir(runtimeDir, { recursive: true });
    if (mode === "once") {
      await (options.runOnce ?? runDreamWorkerOnce)(runtimeDir, env);
    } else {
      await (options.runListTasks ?? runDreamWorkerListTasks)(runtimeDir, env);
    }
    const status = await readDreamStatus(runtimeDir);
    const taskIds = taskIdsFromStatus(status);
    const degraded = status?.phase === "processed_with_failures" || Number(status?.report?.summary?.failed ?? 0) > 0;
    const outputBlockers = [
      ...(status ? [] : ["dream_status_missing"]),
      ...(status?.worker === "memory_dreaming" ? [] : [`unexpected_worker:${status?.worker ?? "missing"}`]),
      ...(taskIds.length > 0 ? [] : ["dream_tasks_missing"]),
      ...(mode === "list" && status?.phase !== "listed_tasks" ? [`unexpected_phase:${status?.phase ?? "missing"}`] : []),
      ...(mode === "list" && status?.ok !== true ? ["list_tasks_not_ok"] : []),
      ...(mode === "once" && degraded && !allowDegraded ? ["dream_degraded"] : []),
      ...(mode === "once" && !degraded && status?.ok !== true ? ["dream_once_not_ok"] : []),
    ];

    return {
      ok: outputBlockers.length === 0,
      mode,
      runtime_dir: runtimeDir,
      status,
      task_ids: taskIds,
      degraded,
      blockers: outputBlockers,
    };
  } finally {
    if (ownsRuntimeDir && !options.keepRuntimeDir) {
      await rm(runtimeDir, { recursive: true, force: true });
    }
  }
}

async function runDreamWorkerListTasks(runtimeDir: string, env: MemoryDreamingSmokeEnv): Promise<void> {
  await execFileAsync(process.execPath, ["--import", "tsx", "scripts/run-dream-worker.ts", "--list-tasks"], {
    cwd: process.cwd(),
    env: workerEnv(runtimeDir, env),
    timeout: 30_000,
  });
}

async function runDreamWorkerOnce(runtimeDir: string, env: MemoryDreamingSmokeEnv): Promise<void> {
  try {
    await execFileAsync(process.execPath, ["--import", "tsx", "scripts/run-dream-worker.ts", "--once"], {
      cwd: process.cwd(),
      env: {
        ...workerEnv(runtimeDir, env),
        MEMORY_XX_DREAM_TASK_TIMEOUT_MS: env.MEMORY_XX_DREAM_TASK_TIMEOUT_MS ?? "500",
      },
      timeout: 60_000,
    });
  } catch {
    // The worker intentionally exits non-zero when one or more dream tasks fail.
    // The smoke reads the status file below to classify that as degraded evidence.
  }
}

function workerEnv(runtimeDir: string, env: MemoryDreamingSmokeEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...env,
    TMPDIR: "/tmp",
    MEMORY_XX_RUNTIME_DIR: runtimeDir,
    MEMORY_XX_DREAM_STATUS_FILE: path.join(runtimeDir, "dream-worker.status.json"),
  };
}

async function readDreamStatus(runtimeDir: string): Promise<MemoryDreamingWorkerStatus | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(runtimeDir, "dream-worker.status.json"), "utf8")) as MemoryDreamingWorkerStatus;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function taskIdsFromStatus(status: MemoryDreamingWorkerStatus | null): readonly string[] {
  const tasks = status?.tasks ?? status?.report?.tasks ?? [];
  return tasks
    .map((task) => task.id ?? task.task_id ?? "")
    .filter((value) => value.trim() !== "");
}

async function main(): Promise<void> {
  const report = await buildMemoryDreamingSmokeReport({
    keepRuntimeDir: process.argv.includes("--keep-runtime-dir"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

const entrypoint = process.argv[1] ?? "";
if (entrypoint.endsWith("scripts/memory-dreaming-smoke.ts") || entrypoint.endsWith("scripts\\memory-dreaming-smoke.ts")) {
  void main();
}

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  DreamScheduler,
  DreamWorker,
  createAutoRepairTask,
  createConsistencyAuditTask,
  createEmbeddingRetryTask,
  createMemoryStatsTask,
  loadDreamSchedulerConfig
} from "../app/dream";
import { loadDotenvIfPresent } from "./lib/runtime-env";

loadDotenvIfPresent(process.env.MEMORY_XX_ENV_PATH || ".env");

function hasArg(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function wrapperUrl(): string {
  return (process.env.MEMORY_XX_WRAPPER_URL?.trim() || "http://127.0.0.1:5100").replace(/\/+$/u, "");
}

function workerId(): string {
  return process.env.MEMORY_XX_WORKER_ID?.trim() || `dream-worker-${process.pid}`;
}

function statusFilePath(): string {
  return process.env.MEMORY_XX_DREAM_STATUS_FILE?.trim() ||
    `${process.cwd()}/.runtime/dream-worker.status.json`;
}

async function writeStatus(payload: Record<string, unknown>): Promise<void> {
  const file = statusFilePath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function buildWorker(): DreamWorker {
  const baseUrl = wrapperUrl();
  const apiToken = process.env.MEMORY_XX_ADMIN_TOKEN?.trim() || process.env.MEMORY_XX_API_TOKEN?.trim();
  const worker = new DreamWorker();
  worker.registerTask(createMemoryStatsTask({ baseUrl, apiToken }));
  worker.registerTask(createConsistencyAuditTask({ baseUrl, apiToken }));
  if (process.env.MEMORY_XX_DREAM_AUTO_REPAIR_ENABLED === "1") {
    worker.registerTask(createAutoRepairTask({
      baseUrl,
      apiToken,
      dryRun: process.env.MEMORY_XX_DREAM_AUTO_REPAIR_DRY_RUN !== "0"
    }));
  }
  if (process.env.MEMORY_XX_DREAM_EMBEDDING_RETRY_ENABLED === "1") {
    worker.registerTask(createEmbeddingRetryTask({ baseUrl, apiToken }));
  }
  return worker;
}

async function main(): Promise<void> {
  const worker = buildWorker();
  const config = loadDreamSchedulerConfig({
    ...process.env,
    MEMORY_XX_DREAM_ENABLED: "true"
  });
  const scheduler = new DreamScheduler(worker, config);

  if (hasArg("--list-tasks")) {
    const payload = {
      worker: "memory_dreaming",
      worker_id: workerId(),
      ok: true,
      phase: "listed_tasks",
      tasks: worker.listTasks(),
      at: new Date().toISOString()
    };
    await writeStatus(payload);
    console.log(JSON.stringify(payload));
    return;
  }

  if (hasArg("--once")) {
    const report = await scheduler.runOnce();
    const ok = report.summary.failed === 0;
    await writeStatus({
      worker: "memory_dreaming",
      worker_id: workerId(),
      ok,
      phase: ok ? "processed" : "processed_with_failures",
      report,
      at: new Date().toISOString()
    });
    console.log(JSON.stringify(report));
    if (report.summary.failed > 0) process.exitCode = 1;
    return;
  }

  process.on("SIGINT", () => scheduler.stop());
  process.on("SIGTERM", () => scheduler.stop());
  scheduler.start();
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  await writeStatus({
    worker: "memory_dreaming",
    worker_id: workerId(),
    ok: false,
    phase: "startup_failed",
    success: false,
    error: message,
    at: new Date().toISOString()
  }).catch(() => undefined);
  console.error(message);
  process.exitCode = 1;
});

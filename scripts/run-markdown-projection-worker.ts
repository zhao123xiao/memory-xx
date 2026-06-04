import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  PostgresProjectionDataSource,
  ProjectionJobType,
  ProjectionRunner,
  ProjectionView,
  loadMemoryXXPostgresConfig,
  type ProjectionJob
} from "../app";
import { loadDotenvIfPresent } from "./lib/runtime-env";

loadDotenvIfPresent(process.env.MEMORY_XX_ENV_PATH || ".env");

function hasArg(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function parseViews(): ProjectionView[] | undefined {
  const raw = argValue("--views") ?? argValue("--view");
  if (!raw) return undefined;
  const allowed = new Set(Object.values(ProjectionView));
  const views = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is ProjectionView => allowed.has(item as ProjectionView));
  return views.length > 0 ? views : undefined;
}

function parsePositiveInt(name: string): number | undefined {
  const raw = argValue(name);
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function projectionRootDir(): string {
  const raw = argValue("--root-dir") ?? process.env.MEMORY_XX_PROJECTION_ROOT_DIR ?? "memory_projection";
  return resolve(process.cwd(), raw);
}

function statusFilePath(): string {
  return process.env.MEMORY_XX_MARKDOWN_PROJECTION_STATUS_FILE?.trim() ||
    `${process.cwd()}/.runtime/markdown-projection.status.json`;
}

async function writeStatus(payload: Record<string, unknown>): Promise<void> {
  const file = statusFilePath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const views = parseViews();
  const rootDir = projectionRootDir();
  const dataSource = new PostgresProjectionDataSource({
    config: loadMemoryXXPostgresConfig(process.env),
    includePending: hasArg("--include-pending"),
    includeNonCurrent: hasArg("--include-non-current"),
    limit: parsePositiveInt("--limit")
  });
  const runner = new ProjectionRunner(dataSource, rootDir);
  const job: ProjectionJob = {
    jobId: `markdown-projection-${new Date().toISOString()}`,
    type: ProjectionJobType.FullRebuild,
    requestedAt: new Date().toISOString(),
    triggeredBy: process.env.MEMORY_XX_WORKER_ID?.trim() || "markdown-projection-worker",
    views,
    rootDir,
    reason: "runtime_module"
  };

  try {
    const result = await runner.run(job);
    const payload = {
      worker: "markdown_projection",
      root_dir: rootDir,
      views: views ?? "all",
      ...result,
      duration_ms: Date.now() - startedAt,
      at: new Date().toISOString()
    };
    await writeStatus(payload);
    console.log(JSON.stringify(payload));
    if (!result.success) process.exitCode = 1;
  } finally {
    await dataSource.close();
  }
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  await writeStatus({
    worker: "markdown_projection",
    success: false,
    error: message,
    at: new Date().toISOString()
  }).catch(() => undefined);
  console.error(message);
  process.exitCode = 1;
});

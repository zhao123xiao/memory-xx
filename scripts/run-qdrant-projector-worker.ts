import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  QdrantProjectorWorkerDaemon,
  createQdrantProjectorWorkerFromEnv,
  type QdrantProjectorWorkerDaemonLogger
} from "../app/qdrant-sync/daemon";
import { activatePendingRuntimeControlsSync } from "../app/runtime-control-settings";

const DEFAULT_STATUS_PATH = path.resolve(
  process.cwd(), "qdrant-projector-worker.status.json"
);
let statusWriteSeq = 0;

async function main(): Promise<void> {
  const runtime = await prepareRuntime(process.env);
  const { worker, database, config, statusFilePath, logger } = runtime;

  if (config.once) {
    await writeStatus(statusFilePath, {
      phase: "once-starting",
      exporterName: config.exporterName,
      config
    });
    const result = await worker.drainOnce();
    const finishedAt = new Date().toISOString();
    console.log(
      JSON.stringify(
        {
          ts: finishedAt,
          level: "INFO",
          message: "向量库投影 worker（Qdrant projector）单次运行已完成",
          config,
          result,
          statusFilePath
        },
        null,
        2
      )
    );
    await writeStatus(statusFilePath, {
      phase: "once-completed",
      finishedAt,
      exporterName: config.exporterName,
      config,
      result
    });
    await database.close?.();
    return;
  }

  let daemon!: QdrantProjectorWorkerDaemon;
  const persistSnapshot = async (phase: string, extra?: Record<string, unknown>) => {
    await writeStatus(statusFilePath, {
      phase,
      snapshot: daemon?.getHealthSnapshot?.(),
      ...extra
    });
  };

  const loggerWithStatus: QdrantProjectorWorkerDaemonLogger = {
    info(message, fields) {
      logger.info(message, fields);
      void persistSnapshot("running", { lastLogLevel: "INFO", lastLogMessage: message, lastLogFields: fields })
        .catch((error) => logger.warn("qdrant projector status snapshot write failed", { error: error instanceof Error ? error.message : String(error) }));
    },
    warn(message, fields) {
      logger.warn(message, fields);
      void persistSnapshot("running", { lastLogLevel: "WARN", lastLogMessage: message, lastLogFields: fields })
        .catch((error) => logger.warn("qdrant projector status snapshot write failed", { error: error instanceof Error ? error.message : String(error) }));
    },
    error(message, fields) {
      logger.error(message, fields);
      void persistSnapshot("running", { lastLogLevel: "ERROR", lastLogMessage: message, lastLogFields: fields })
        .catch((error) => logger.warn("qdrant projector status snapshot write failed", { error: error instanceof Error ? error.message : String(error) }));
    }
  };

  daemon = new QdrantProjectorWorkerDaemon({
    worker,
    exporterName: config.exporterName,
    intervalMs: config.intervalMs,
    idleLogEvery: config.idleLogEvery,
    logger: loggerWithStatus
  });

  await persistSnapshot("prepared", { config });

  let closed = false;
  let shutdownPromise: Promise<void> | null = null;
  const closeDatabaseOnce = async () => {
    if (closed) return;
    closed = true;
    await database.close?.();
  };
  const shutdown = async (signal: string) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
    await persistSnapshot("stopping", { signal });
    await daemon.stop(signal);
    await closeDatabaseOnce();
    await persistSnapshot("stopped", { signal });
    process.exitCode = 0;
    })();
    return shutdownPromise;
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  try {
    await daemon.start();
  } finally {
    await closeDatabaseOnce();
    await persistSnapshot("stopped");
  }
}

void main().catch((error) => {
  const statusFilePath = resolveStatusFilePath(process.env);
  const payload = {
    ts: new Date().toISOString(),
    level: "ERROR",
    message: "向量库投影 worker（Qdrant projector）运行器失败",
    error: error instanceof Error ? error.message : String(error),
    statusFilePath
  };
  console.error(JSON.stringify(payload));
  void writeStatus(statusFilePath, { phase: "failed", ...payload });
  process.exitCode = 1;
});

async function prepareRuntime(env: NodeJS.ProcessEnv) {
  const statusFilePath = resolveStatusFilePath(env);
  await ensureStatusFileReady(statusFilePath);
  activatePendingRuntimeControlsSync([
    "worker.qdrant_projector.interval_ms",
    "worker.qdrant_projector.batch_size",
    "worker.qdrant_projector.max_attempts",
    "worker.qdrant_projector.retry_delay_ms",
  ]);

  const { worker, database, config } = await createQdrantProjectorWorkerFromEnv(env);
  const logger = createConsoleLogger();
  await verifyStartupPrerequisites(statusFilePath);
  logger.info("qdrant projector worker startup self-check passed", {
    statusFilePath,
    exporterName: config.exporterName,
    intervalMs: config.intervalMs,
    once: config.once
  });

  return {
    worker,
    database,
    config,
    statusFilePath,
    logger
  };
}

function resolveStatusFilePath(env: NodeJS.ProcessEnv): string {
  const configured = env.MEMORY_XX_QDRANT_PROJECTOR_STATUS_FILE?.trim();
  return configured && configured.length > 0 ? path.resolve(configured) : DEFAULT_STATUS_PATH;
}

async function ensureStatusFileReady(statusFilePath: string): Promise<void> {
  await mkdir(path.dirname(statusFilePath), { recursive: true });
}

async function verifyStartupPrerequisites(statusFilePath: string): Promise<void> {
  await access(path.dirname(statusFilePath));
  await writeStatus(statusFilePath, {
    phase: "startup-self-check",
    checkedAt: new Date().toISOString(),
    pid: process.pid
  });
}

async function writeStatus(statusFilePath: string, payload: Record<string, unknown>): Promise<void> {
  statusWriteSeq = (statusWriteSeq + 1) % Number.MAX_SAFE_INTEGER;
  const tmpPath = `${statusFilePath}.${process.pid}.${Date.now()}.${statusWriteSeq}.tmp`;
  try {
    await writeFile(
      tmpPath,
      `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...payload }, null, 2)}\n`,
      "utf8"
    );
    await rename(tmpPath, statusFilePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function createConsoleLogger(): QdrantProjectorWorkerDaemonLogger {
  return {
    info(message, fields) {
      console.log(formatLog("INFO", message, fields));
    },
    warn(message, fields) {
      console.warn(formatLog("WARN", message, fields));
    },
    error(message, fields) {
      console.error(formatLog("ERROR", message, fields));
    }
  };
}

function formatLog(level: string, message: string, fields?: Record<string, unknown>): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...(fields ?? {})
  });
}

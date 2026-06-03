import {
  DatabaseQdrantSyncOutboxRepository,
  QdrantProjectorWorker,
  type QdrantProjectorWorkerResult,
  type QdrantSyncCursorState
} from "./outbox-worker";
import { HttpQdrantPointWriter } from "./qdrant-point-writer";
import { QdrantProjectionSyncService } from "./projector";
import { ProjectorEmbeddingResolver } from "./projector-embedding-resolver";
import { markEmbeddingManifestDirty } from "../embedding/manifest-refresh";
import { loadMemoryV2PostgresConfig } from "../db/adapters/postgres-config";
import { PostgresWriteDatabase } from "../db/adapters/postgres-write-database";
import { QwenEmbeddingProviderWrapper } from "../server/embedding-provider";
import { loadMemoryV2QdrantConfig } from "../recall/qdrant-config";
import { readRuntimeControlNumberSync } from "../runtime-control-settings";
import { createLogger } from "../shared/logger";
import type { WriteTransactionRunner } from "../db/tx/write-transaction";

const DEFAULT_LOOP_INTERVAL_MS = 5_000;
const DEFAULT_IDLE_LOG_EVERY = 12;

export interface QdrantProjectorWorkerLoop {
  drainOnce(): Promise<QdrantProjectorWorkerResult>;
  drainUntilIdle?(limit?: number): Promise<readonly QdrantProjectorWorkerResult[]>;
}

export interface QdrantProjectorWorkerDaemonOptions {
  readonly worker: QdrantProjectorWorkerLoop;
  readonly exporterName?: string;
  readonly intervalMs?: number;
  readonly idleLogEvery?: number;
  readonly logger?: QdrantProjectorWorkerDaemonLogger;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface QdrantProjectorWorkerDaemonLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface QdrantProjectorWorkerHealthSnapshot {
  readonly exporterName: string;
  readonly running: boolean;
  readonly stopping: boolean;
  readonly startedAt: string | null;
  readonly stoppedAt: string | null;
  readonly loopCount: number;
  readonly lastTickAt: string | null;
  readonly lastResultStatus: QdrantProjectorWorkerResult["status"] | null;
  readonly lastError: string | null;
  readonly lastCursor: QdrantSyncCursorState | null;
}

export interface QdrantProjectorWorkerRuntimeConfig {
  readonly exporterName: string;
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly intervalMs: number;
  readonly idleLogEvery: number;
  readonly once: boolean;
}

export function loadQdrantProjectorWorkerRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): QdrantProjectorWorkerRuntimeConfig {
  return {
    exporterName: readStringEnv(env, "MEMORY_V2_QDRANT_PROJECTOR_EXPORTER_NAME", "qdrant_projector"),
    batchSize: readRuntimePositiveInt(env, "worker.qdrant_projector.batch_size", "MEMORY_V2_QDRANT_PROJECTOR_BATCH_SIZE", 50),
    maxAttempts: readRuntimePositiveInt(env, "worker.qdrant_projector.max_attempts", "MEMORY_V2_QDRANT_PROJECTOR_MAX_ATTEMPTS", 5),
    retryDelayMs: readRuntimePositiveInt(env, "worker.qdrant_projector.retry_delay_ms", "MEMORY_V2_QDRANT_PROJECTOR_RETRY_DELAY_MS", 5_000),
    intervalMs: readRuntimePositiveInt(env, "worker.qdrant_projector.interval_ms", "MEMORY_V2_QDRANT_PROJECTOR_INTERVAL_MS", DEFAULT_LOOP_INTERVAL_MS),
    idleLogEvery: readPositiveIntEnv(env, "MEMORY_V2_QDRANT_PROJECTOR_IDLE_LOG_EVERY", DEFAULT_IDLE_LOG_EVERY),
    once: readBooleanEnv(env, "MEMORY_V2_QDRANT_PROJECTOR_ONCE", false)
  };
}

function readRuntimePositiveInt(
  env: NodeJS.ProcessEnv,
  runtimeKey: string,
  envName: string,
  fallback: number
): number {
  const envValue = readPositiveIntEnv(env, envName, fallback);
  if (env !== process.env) return envValue;
  const runtimeValue = readRuntimeControlNumberSync(runtimeKey, envValue);
  return Number.isFinite(runtimeValue) && runtimeValue > 0 ? runtimeValue : envValue;
}

export class QdrantProjectorWorkerDaemon {
  private readonly exporterName: string;
  private readonly intervalMs: number;
  private readonly idleLogEvery: number;
  private readonly logger: QdrantProjectorWorkerDaemonLogger;
  private readonly sleepImpl: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly state: {
    running: boolean;
    stopping: boolean;
    startedAt: string | null;
    stoppedAt: string | null;
    loopCount: number;
    lastTickAt: string | null;
    lastResultStatus: QdrantProjectorWorkerResult["status"] | null;
    lastError: string | null;
    lastCursor: QdrantSyncCursorState | null;
  } = {
    running: false,
    stopping: false,
    startedAt: null,
    stoppedAt: null,
    loopCount: 0,
    lastTickAt: null,
    lastResultStatus: null,
    lastError: null,
    lastCursor: null
  };
  private abortController: AbortController | null = null;
  private runPromise: Promise<void> | null = null;
  private idleLoops = 0;

  constructor(options: QdrantProjectorWorkerDaemonOptions) {
    this.exporterName = options.exporterName ?? "qdrant_projector";
    this.intervalMs = options.intervalMs ?? DEFAULT_LOOP_INTERVAL_MS;
    this.idleLogEvery = Math.max(1, options.idleLogEvery ?? DEFAULT_IDLE_LOG_EVERY);
    this.logger = options.logger ?? createConsoleLogger();
    this.sleepImpl = options.sleep ?? sleepWithSignal;
    this.worker = options.worker;
  }

  private readonly worker: QdrantProjectorWorkerLoop;

  start(): Promise<void> {
    if (this.runPromise) {
      return this.runPromise;
    }

    this.abortController = new AbortController();
    this.state.running = true;
    this.state.stopping = false;
    this.state.startedAt = new Date().toISOString();
    this.state.stoppedAt = null;
    this.logger.info("qdrant projector worker daemon starting", {
      exporterName: this.exporterName,
      intervalMs: this.intervalMs,
      idleLogEvery: this.idleLogEvery
    });

    this.runPromise = this.runLoop(this.abortController.signal).finally(() => {
      this.state.running = false;
      this.state.stopping = false;
      this.state.stoppedAt = new Date().toISOString();
      this.abortController = null;
      this.runPromise = null;
      this.logger.info("qdrant projector worker daemon stopped", {
        exporterName: this.exporterName,
        loopCount: this.state.loopCount,
        lastResultStatus: this.state.lastResultStatus,
        lastError: this.state.lastError
      });
    });

    return this.runPromise;
  }

  async stop(reason = "shutdown_signal"): Promise<void> {
    if (!this.runPromise) {
      return;
    }

    this.state.stopping = true;
    this.logger.info("qdrant projector worker daemon stopping", {
      exporterName: this.exporterName,
      reason
    });
    this.abortController?.abort();
    await this.runPromise;
  }

  getHealthSnapshot(): QdrantProjectorWorkerHealthSnapshot {
    return {
      exporterName: this.exporterName,
      running: this.state.running,
      stopping: this.state.stopping,
      startedAt: this.state.startedAt,
      stoppedAt: this.state.stoppedAt,
      loopCount: this.state.loopCount,
      lastTickAt: this.state.lastTickAt,
      lastResultStatus: this.state.lastResultStatus,
      lastError: this.state.lastError,
      lastCursor: this.state.lastCursor
    };
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      this.state.loopCount += 1;
      this.state.lastTickAt = new Date().toISOString();
      const results = await this.drainWorkerBatch();
      const result = results[results.length - 1] ?? {
        status: "idle" as const,
        memoryIds: []
      };

      for (const item of results) {
        this.state.lastResultStatus = item.status;
        this.state.lastError = item.error ?? null;
        this.state.lastCursor = item.cursor ?? null;
        this.logResult(item);
      }

      if (signal.aborted) {
        break;
      }

      await this.sleepImpl(this.nextSleepMs(result), signal);
    }
  }

  private async drainWorkerBatch(): Promise<readonly QdrantProjectorWorkerResult[]> {
    if (this.worker.drainUntilIdle) {
      return this.worker.drainUntilIdle();
    }
    return [await this.worker.drainOnce()];
  }

  private nextSleepMs(result: QdrantProjectorWorkerResult): number {
    if (result.status === "retried") {
      return result.retryAfterMs ?? this.intervalMs;
    }
    return this.intervalMs;
  }

  private logResult(result: QdrantProjectorWorkerResult): void {
    if (result.status === "idle") {
      this.idleLoops += 1;
      if (this.idleLoops === 1 || this.idleLoops % this.idleLogEvery === 0) {
        this.logger.info("qdrant projector worker idle", {
          exporterName: this.exporterName,
          idleLoops: this.idleLoops,
          cursor: result.cursor
        });
      }
      return;
    }

    this.idleLoops = 0;
    const fields = {
      exporterName: this.exporterName,
      eventId: result.eventId,
      memoryIds: result.memoryIds,
      attempts: result.attempts,
      retryAfterMs: result.retryAfterMs,
      error: result.error,
      cursor: result.cursor,
      syncResult: result.syncResult
    };

    if (result.status === "synced") {
      void markEmbeddingManifestDirty("qdrant_projector_synced").catch((error) =>
        this.logger.warn("embedding manifest dirty mark failed", {
          error: error instanceof Error ? error.message : String(error)
        })
      );
      this.logger.info("qdrant projector worker synced event", fields);
      return;
    }
    if (result.status === "retried") {
      this.logger.warn("qdrant projector worker scheduled retry", fields);
      return;
    }
    this.logger.error("qdrant projector worker moved event to dead-letter", fields);
  }
}

export async function createQdrantProjectorWorkerFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Promise<{
  readonly worker: QdrantProjectorWorker;
  readonly database: WriteTransactionRunner & { close?: () => Promise<void> };
  readonly config: QdrantProjectorWorkerRuntimeConfig;
}> {
  const config = loadQdrantProjectorWorkerRuntimeConfig(env);
  const database = new PostgresWriteDatabase({ config: loadMemoryV2PostgresConfig(env) });
  const outboxRepository = new DatabaseQdrantSyncOutboxRepository(database);
  const pointWriter = new HttpQdrantPointWriter({ config: loadMemoryV2QdrantConfig(env) });

  const embeddingProvider = new QwenEmbeddingProviderWrapper();
  const embeddingResolver = new ProjectorEmbeddingResolver({
    provider: embeddingProvider,
    database,
  });

  const projectionSyncService = new QdrantProjectionSyncService({
    database,
    pointWriter,
    embeddingResolver,
  });

  return {
    worker: new QdrantProjectorWorker({
      projectionSyncService,
      outboxRepository,
      exporterName: config.exporterName,
      batchSize: config.batchSize,
      maxAttempts: config.maxAttempts,
      retryDelayMs: config.retryDelayMs
    }),
    database,
    config
  };
}

function createConsoleLogger(): QdrantProjectorWorkerDaemonLogger {
  const log = createLogger("qdrant-projector");
  return {
    info(message, fields) {
      log.info(message, fields);
    },
    warn(message, fields) {
      log.warn(message, fields);
    },
    error(message, fields) {
      log.error(message, fields);
    }
  };
}

async function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function readStringEnv(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function readPositiveIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function readBooleanEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

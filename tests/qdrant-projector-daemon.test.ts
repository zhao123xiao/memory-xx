import assert from "node:assert/strict";
import test from "node:test";

import {
  QdrantProjectorWorkerDaemon,
  loadQdrantProjectorWorkerRuntimeConfig
} from "../app/qdrant-sync/daemon";
import type { QdrantProjectorWorkerResult } from "../app/qdrant-sync/outbox-worker";

class RecordingLogger {
  readonly entries: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];

  info(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ level: "info", message, fields });
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ level: "warn", message, fields });
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ level: "error", message, fields });
  }
}

test("qdrant projector daemon uses retry delay for transient failures and supports graceful stop", async () => {
  const logger = new RecordingLogger();
  const sleepCalls: number[] = [];
  const results: QdrantProjectorWorkerResult[] = [
    {
      status: "retried",
      eventId: "evt-1",
      memoryIds: ["mem-1"],
      attempts: 1,
      retryAfterMs: 3210,
      error: "temporary failure"
    },
    {
      status: "idle",
      memoryIds: []
    }
  ];
  let drainCount = 0;

  const daemon = new QdrantProjectorWorkerDaemon({
    worker: {
      async drainOnce() {
        const next = results[Math.min(drainCount, results.length - 1)]!;
        drainCount += 1;
        return next;
      }
    },
    exporterName: "worker-a",
    intervalMs: 999,
    idleLogEvery: 2,
    logger,
    sleep: async (ms, signal) => {
      sleepCalls.push(ms);
      if (drainCount >= 2) {
        queueMicrotask(() => {
          if (!signal.aborted) {
            void daemon.stop("test");
          }
        });
      }
      await Promise.resolve();
    }
  });

  await daemon.start();

  assert.deepEqual(sleepCalls, [3210, 999]);
  assert.equal(drainCount, 2);
  const health = daemon.getHealthSnapshot();
  assert.equal(health.running, false);
  assert.equal(health.lastResultStatus, "idle");
  assert.equal(health.lastError, null);
  assert.equal(logger.entries.some((entry) => entry.level === "warn" && entry.message.includes("scheduled retry")), true);
  assert.equal(logger.entries.some((entry) => entry.level === "info" && entry.message.includes("stopped")), true);
});

test("qdrant projector daemon throttles repeated idle logs", async () => {
  const logger = new RecordingLogger();
  let remaining = 3;
  let daemon: QdrantProjectorWorkerDaemon;

  daemon = new QdrantProjectorWorkerDaemon({
    worker: {
      async drainOnce() {
        remaining -= 1;
        return {
          status: "idle",
          memoryIds: []
        };
      }
    },
    idleLogEvery: 2,
    logger,
    sleep: async () => {
      if (remaining <= 0) {
        queueMicrotask(() => {
          void daemon.stop("idle-test");
        });
      }
      await Promise.resolve();
    }
  });

  await daemon.start();

  const idleLogs = logger.entries.filter((entry) => entry.message.includes("worker idle"));
  assert.equal(idleLogs.length, 2);
});

test("qdrant projector daemon runtime config reads env overrides", () => {
  const config = loadQdrantProjectorWorkerRuntimeConfig({
    MEMORY_XX_QDRANT_PROJECTOR_EXPORTER_NAME: "custom-exporter",
    MEMORY_XX_QDRANT_PROJECTOR_BATCH_SIZE: "8",
    MEMORY_XX_QDRANT_PROJECTOR_MAX_ATTEMPTS: "9",
    MEMORY_XX_QDRANT_PROJECTOR_RETRY_DELAY_MS: "7000",
    MEMORY_XX_QDRANT_PROJECTOR_INTERVAL_MS: "1500",
    MEMORY_XX_QDRANT_PROJECTOR_IDLE_LOG_EVERY: "4",
    MEMORY_XX_QDRANT_PROJECTOR_ONCE: "true"
  });

  assert.deepEqual(config, {
    exporterName: "custom-exporter",
    batchSize: 8,
    maxAttempts: 9,
    retryDelayMs: 7000,
    intervalMs: 1500,
    idleLogEvery: 4,
    once: true
  });
});

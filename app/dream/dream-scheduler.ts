// Dream scheduler — periodic dream cycle execution.

import { createLogger } from "../shared/logger";
import type { DreamWorker } from "./dream-worker";
import type { DreamReport } from "./dream-worker";

const log = createLogger("dream-scheduler");

export interface DreamSchedulerOptions {
  readonly intervalMs: number;
  readonly enabled: boolean;
}

const DEFAULT_OPTIONS: DreamSchedulerOptions = {
  intervalMs: 3600_000, // 1 hour
  enabled: false,
};

export function loadDreamSchedulerConfig(env: NodeJS.ProcessEnv): DreamSchedulerOptions {
  return {
    intervalMs: parseInt(env.MEMORY_V2_DREAM_INTERVAL_MS ?? "", 10) || DEFAULT_OPTIONS.intervalMs,
    enabled: env.MEMORY_V2_DREAM_ENABLED === "true",
  };
}

export class DreamScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastReport: DreamReport | null = null;

  constructor(
    private readonly worker: DreamWorker,
    private readonly options: DreamSchedulerOptions,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  get lastDreamReport(): DreamReport | null {
    return this.lastReport;
  }

  start(): void {
    if (this.timer) {
      log.warn("Dream scheduler already running");
      return;
    }
    if (!this.options.enabled) {
      log.info("Dream scheduler disabled");
      return;
    }

    log.info("Dream scheduler starting", { intervalMs: this.options.intervalMs });
    this.timer = setInterval(() => this.runCycle(), this.options.intervalMs);

    // Run first cycle immediately
    this.runCycle();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info("Dream scheduler stopped");
    }
  }

  async runOnce(): Promise<DreamReport> {
    return this.runCycle();
  }

  private async runCycle(): Promise<DreamReport> {
    if (this.running) {
      log.warn("Dream cycle already in progress, skipping");
      return this.lastReport ?? emptyDreamReport("dream_cycle_already_running");
    }

    this.running = true;
    try {
      this.lastReport = await this.worker.run();
      return this.lastReport;
    } finally {
      this.running = false;
    }
  }
}

function emptyDreamReport(reason: string): DreamReport {
  const now = new Date().toISOString();
  return {
    started_at: now,
    completed_at: now,
    total_duration_ms: 0,
    tasks: [{
      task_id: "dream_scheduler",
      task_name: "Dream Scheduler",
      status: "skipped",
      duration_ms: 0,
      summary: reason
    }],
    summary: { completed: 0, skipped: 1, failed: 0 }
  };
}

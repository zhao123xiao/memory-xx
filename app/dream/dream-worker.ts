// Dream worker — autonomous memory maintenance tasks.

import { createLogger } from "../shared/logger";

const log = createLogger("dream-worker");

export interface DreamTask {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  execute(): Promise<DreamTaskResult>;
}

export interface DreamTaskResult {
  readonly task_id: string;
  readonly task_name: string;
  readonly status: "completed" | "skipped" | "failed";
  readonly duration_ms: number;
  readonly summary: string;
  readonly details?: unknown;
}

export interface DreamReport {
  readonly started_at: string;
  readonly completed_at: string;
  readonly total_duration_ms: number;
  readonly tasks: readonly DreamTaskResult[];
  readonly summary: {
    readonly completed: number;
    readonly skipped: number;
    readonly failed: number;
  };
}

export class DreamWorker {
  private readonly tasks: DreamTask[] = [];

  registerTask(task: DreamTask): void {
    this.tasks.push(task);
    log.info("Dream task registered", { taskId: task.id, name: task.name });
  }

  async run(): Promise<DreamReport> {
    const startedAt = new Date().toISOString();
    log.info("Dream cycle starting", { taskCount: this.tasks.length });

    const results: DreamTaskResult[] = [];

    for (const task of this.tasks) {
      const taskStart = Date.now();
      try {
        log.info("Running dream task", { taskId: task.id, name: task.name });
        const result = await task.execute();
        results.push(result);
        log.info("Dream task completed", {
          taskId: task.id,
          status: result.status,
          duration_ms: Date.now() - taskStart,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error("Dream task failed", { taskId: task.id, error: errorMessage });
        results.push({
          task_id: task.id,
          task_name: task.name,
          status: "failed",
          duration_ms: Date.now() - taskStart,
          summary: `Error: ${errorMessage}`,
        });
      }
    }

    const completedAt = new Date().toISOString();
    const report: DreamReport = {
      started_at: startedAt,
      completed_at: completedAt,
      total_duration_ms: Date.now() - new Date(startedAt).getTime(),
      tasks: results,
      summary: {
        completed: results.filter((r) => r.status === "completed").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        failed: results.filter((r) => r.status === "failed").length,
      },
    };

    log.info("Dream cycle completed", report.summary);
    return report;
  }

  listTasks(): { id: string; name: string; description: string }[] {
    return this.tasks.map((t) => ({ id: t.id, name: t.name, description: t.description }));
  }
}

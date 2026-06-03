import { createLogger } from "../shared/logger";
const log = createLogger("consolidation-queue");
export interface ConsolidationJob {
  readonly id: string;
  readonly type: "dedupe" | "conflict" | "episode" | "full";
  readonly payload: Record<string, unknown>;
  readonly enqueued_at: string;
}
const queue: ConsolidationJob[] = [];
export function enqueue(job: Omit<ConsolidationJob, "id" | "enqueued_at">): string {
  const id = "job-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const full: ConsolidationJob = { ...job, id, enqueued_at: new Date().toISOString() };
  queue.push(full);
  log.info("Job enqueued", { id, type: job.type });
  return id;
}
export function dequeue(): ConsolidationJob | null { return queue.shift() ?? null; }
export function queueSize(): number { return queue.length; }

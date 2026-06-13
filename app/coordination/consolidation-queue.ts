import { createLogger } from "../shared/logger";

const log = createLogger("consolidation-queue");

export interface ConsolidationJob {
  readonly id: string;
  readonly type: "dedupe" | "conflict" | "episode" | "full";
  readonly payload: Record<string, unknown>;
  readonly enqueued_at: string;
}

const queue: ConsolidationJob[] = [];
let head = 0;
let maxQueueSizeOverride: number | null = null;

function maxQueueSize(): number {
  const configured = maxQueueSizeOverride ?? Number.parseInt(process.env.MEMORY_XX_CONSOLIDATION_QUEUE_MAX_SIZE ?? "10000", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 10_000;
}

function compactIfNeeded(): void {
  if (head === 0) return;
  if (head < 1024 && head < queue.length / 2) return;
  queue.splice(0, head);
  head = 0;
}

export function enqueue(job: Omit<ConsolidationJob, "id" | "enqueued_at">): string {
  if (queueSize() >= maxQueueSize()) {
    throw new Error("consolidation_queue_full");
  }
  const id = "job-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const full: ConsolidationJob = { ...job, id, enqueued_at: new Date().toISOString() };
  queue.push(full);
  log.info("Job enqueued", { id, type: job.type });
  return id;
}

export function dequeue(): ConsolidationJob | null {
  const job = queue[head] ?? null;
  if (!job) return null;
  head += 1;
  compactIfNeeded();
  return job;
}

export function queueSize(): number {
  return queue.length - head;
}

export function setMaxQueueSizeForTest(value: number | null): void {
  maxQueueSizeOverride = value;
}

export function clearQueueForTest(): void {
  queue.length = 0;
  head = 0;
}

import type { QueuePort } from "../ports";
import type { CoordinationTaskRecord } from "../types";

export class CoordinationDlqManager {
  constructor(private readonly queue: QueuePort) {}

  async list(): Promise<readonly CoordinationTaskRecord[]> {
    return this.queue.listDlq();
  }

  async replay(
    taskId: string,
    now: number,
    recoveredBy: string,
    delayMs = 0,
    note?: string
  ): Promise<CoordinationTaskRecord> {
    return this.queue.replayDlq({
      taskId,
      now,
      recoveredBy,
      delayMs,
      note
    });
  }
}

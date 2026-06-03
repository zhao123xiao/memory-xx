import type { WorkerPresenceRecord } from "../types";

export interface WorkerHeartbeatInput {
  readonly workerId: string;
  readonly now: number;
  readonly ttlMs: number;
  readonly staleGraceMs: number;
  readonly capabilities?: readonly string[];
  readonly currentLoad?: number;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface PresencePort {
  heartbeat(input: WorkerHeartbeatInput): Promise<WorkerPresenceRecord>;
  getWorker(workerId: string, now: number): Promise<WorkerPresenceRecord | null>;
  listWorkers(now: number): Promise<readonly WorkerPresenceRecord[]>;
  sweepPresence(now: number): Promise<readonly WorkerPresenceRecord[]>;
}

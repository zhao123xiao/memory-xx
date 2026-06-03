import type { DedupeStatistics, DedupeWindowRecord } from "../types";

export interface RegisterDedupeInput {
  readonly key: string;
  readonly taskId: string;
  readonly now: number;
  readonly ttlMs: number;
}

export interface RegisterDedupeResult {
  readonly accepted: boolean;
  readonly record: DedupeWindowRecord;
}

export interface DedupePort {
  register(input: RegisterDedupeInput): Promise<RegisterDedupeResult>;
  getStatistics(): Promise<DedupeStatistics>;
  purgeDedupe(now: number): Promise<number>;
}

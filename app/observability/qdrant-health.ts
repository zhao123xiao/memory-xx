export type QdrantOperationKind = "query" | "write";

export interface QdrantRuntimeSnapshot {
  readonly query_timeouts: number;
  readonly write_timeouts: number;
  readonly total_timeouts: number;
  readonly query_timeout_ms: number;
  readonly write_timeout_ms: number;
  readonly last_timeout_at: string | null;
}

const state = {
  queryTimeouts: 0,
  writeTimeouts: 0,
  lastTimeoutAt: null as string | null,
};

export function recordQdrantTimeout(kind: QdrantOperationKind): void {
  if (kind === "query") state.queryTimeouts += 1;
  if (kind === "write") state.writeTimeouts += 1;
  state.lastTimeoutAt = new Date().toISOString();
}

export function getQdrantRuntimeSnapshot(input: {
  readonly queryTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
} = {}): QdrantRuntimeSnapshot {
  return {
    query_timeouts: state.queryTimeouts,
    write_timeouts: state.writeTimeouts,
    total_timeouts: state.queryTimeouts + state.writeTimeouts,
    query_timeout_ms: input.queryTimeoutMs ?? 0,
    write_timeout_ms: input.writeTimeoutMs ?? 0,
    last_timeout_at: state.lastTimeoutAt,
  };
}

export function resetQdrantRuntimeSnapshot(): void {
  state.queryTimeouts = 0;
  state.writeTimeouts = 0;
  state.lastTimeoutAt = null;
}

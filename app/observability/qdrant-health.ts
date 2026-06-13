export type QdrantOperationKind = "query" | "write";

export interface QdrantRuntimeSnapshot {
  readonly query_timeouts: number;
  readonly write_timeouts: number;
  readonly total_timeouts: number;
  readonly query_timeout_ms: number;
  readonly write_timeout_ms: number;
  readonly first_timeout_at: string | null;
  readonly last_timeout_at: string | null;
  readonly last_query_timeout_at: string | null;
  readonly last_write_timeout_at: string | null;
}

const state = {
  queryTimeouts: 0,
  writeTimeouts: 0,
  firstTimeoutAt: null as string | null,
  lastTimeoutAt: null as string | null,
  lastQueryTimeoutAt: null as string | null,
  lastWriteTimeoutAt: null as string | null,
};

export function recordQdrantTimeout(kind: QdrantOperationKind): void {
  const observedAt = new Date(Date.now()).toISOString();
  if (kind === "query") state.queryTimeouts += 1;
  if (kind === "write") state.writeTimeouts += 1;
  if (!state.firstTimeoutAt) state.firstTimeoutAt = observedAt;
  state.lastTimeoutAt = observedAt;
  if (kind === "query") state.lastQueryTimeoutAt = observedAt;
  if (kind === "write") state.lastWriteTimeoutAt = observedAt;
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
    first_timeout_at: state.firstTimeoutAt,
    last_timeout_at: state.lastTimeoutAt,
    last_query_timeout_at: state.lastQueryTimeoutAt,
    last_write_timeout_at: state.lastWriteTimeoutAt,
  };
}

export function resetQdrantRuntimeSnapshot(): void {
  state.queryTimeouts = 0;
  state.writeTimeouts = 0;
  state.firstTimeoutAt = null;
  state.lastTimeoutAt = null;
  state.lastQueryTimeoutAt = null;
  state.lastWriteTimeoutAt = null;
}

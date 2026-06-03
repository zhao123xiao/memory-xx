import { COORDINATION_KEY_PREFIX } from "./constants";
import { type CoordinationGenerationKey, type LockScope, type PriorityLane } from "./types";

function encodeKeyPart(value: string | number): string {
  return encodeURIComponent(String(value));
}

function joinKey(parts: ReadonlyArray<string | number>): string {
  return [COORDINATION_KEY_PREFIX, ...parts.map(encodeKeyPart)].join(":");
}

export function buildCoordinationKey(...parts: ReadonlyArray<string | number>): string {
  return joinKey(parts);
}

export const coordinationKeys = {
  queueLane: (lane: PriorityLane): string => joinKey(["queue", lane, "ready"]),
  dlqLane: (lane: PriorityLane): string => joinKey(["queue", lane, "dlq"]),
  task: (taskId: string): string => joinKey(["task", taskId]),
  taskLease: (taskId: string): string => joinKey(["lease", taskId]),
  lock: (lockScope: LockScope, resourceId: string): string =>
    joinKey(["lock", lockScope, resourceId]),
  fencingCounter: (lockScope: LockScope, resourceId: string): string =>
    joinKey(["fencing", lockScope, resourceId]),
  singleFlight: (flightKey: string): string => joinKey(["singleflight", flightKey]),
  idempotency: (key: string): string => joinKey(["idempotency", key]),
  dedupe: (key: string): string => joinKey(["dedupe", key]),
  generation: (key: CoordinationGenerationKey): string =>
    key.facet === undefined
      ? joinKey(["generation", key.kind, key.scopeType, key.scopeId])
      : joinKey(["generation", key.kind, key.scopeType, key.scopeId, key.facet]),
  generationAudit: (eventId: string): string => joinKey(["generation-audit", eventId]),
  presence: (workerId: string): string => joinKey(["presence", workerId]),
  runtimeRun: (runId: string): string => joinKey(["runtime", "run", runId]),
  runtimeTask: (taskId: string): string => joinKey(["runtime", "task", taskId])
} as const;

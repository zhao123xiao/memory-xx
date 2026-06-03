import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_PRIORITY_LANE
} from "../constants";
import {
  type CoordinationScopeRef,
  type CoordinationTaskSpec,
  type PriorityLane
} from "../types";

export interface CreateCoordinationTaskInput {
  readonly taskId: string;
  readonly taskType: string;
  readonly scopes: readonly CoordinationScopeRef[];
  readonly now: number;
  readonly priority?: PriorityLane;
  readonly visibleAt?: number;
  readonly maxAttempts?: number;
  readonly payload?: unknown;
  readonly payloadRef?: string;
  readonly dedupeKey?: string;
  readonly idempotencyKey?: string;
  readonly singleFlightKey?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export function createCoordinationTask(
  input: CreateCoordinationTaskInput
): CoordinationTaskSpec {
  return {
    taskId: input.taskId,
    taskType: input.taskType,
    priority: input.priority ?? DEFAULT_PRIORITY_LANE,
    scopes: input.scopes,
    payload: input.payload,
    payloadRef: input.payloadRef,
    dedupeKey: input.dedupeKey,
    idempotencyKey: input.idempotencyKey,
    singleFlightKey: input.singleFlightKey,
    enqueueAt: input.now,
    visibleAt: input.visibleAt ?? input.now,
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    metadata: input.metadata
  };
}

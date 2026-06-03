import type { OutboxEventRow } from "../../db/schema/tables";
import { coordinationFailureFromError } from "../errors";
import {
  DEFAULT_DISPATCH_IDEMPOTENCY_TTL_MS
} from "../constants";
import type {
  EnqueueTaskResult,
  GenerationPort,
  IdempotencyPort
} from "../ports";
import type { CoordinationGenerationRecord } from "../types";
import {
  buildCoordinationDispatchPlan,
  type CoordinationDispatchEvent,
  type PlannedCoordinationTask
} from "../cache";
import { COORDINATION_DISPATCH_IDEMPOTENCY_PREFIX } from "../task-types";

export interface CoordinationDispatchTaskResult {
  readonly taskId: string;
  readonly accepted: boolean;
  readonly dedupeHit: boolean;
}

export interface CoordinationDispatchResult {
  readonly status: "applied" | "duplicate_succeeded" | "duplicate_inflight";
  readonly generationBumps: readonly CoordinationGenerationRecord[];
  readonly tasks: readonly CoordinationDispatchTaskResult[];
}

export interface CoordinationOutboxDispatcherDependencies {
  readonly generationPort: GenerationPort;
  readonly idempotencyPort: IdempotencyPort;
  readonly enqueueTask: (
    task: PlannedCoordinationTask,
    now: number
  ) => Promise<EnqueueTaskResult>;
  readonly dispatcherId?: string;
  readonly idempotencyTtlMs?: number;
}

function isDispatchResult(value: unknown): value is CoordinationDispatchResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<CoordinationDispatchResult>;
  return (
    (candidate.status === "applied" ||
      candidate.status === "duplicate_succeeded" ||
      candidate.status === "duplicate_inflight") &&
    Array.isArray(candidate.generationBumps) &&
    Array.isArray(candidate.tasks)
  );
}

export function coordinationDispatchEventFromOutbox(
  row: OutboxEventRow
): CoordinationDispatchEvent {
  return {
    eventId: row.id,
    aggregateId: row.aggregateId,
    requestId: row.requestId,
    eventType: row.eventType,
    payloadVersion: row.payloadVersion,
    createdAt: row.createdAt,
    payload: row.payload
  };
}

export class CoordinationOutboxDispatcher {
  private readonly generationPort: GenerationPort;
  private readonly idempotencyPort: IdempotencyPort;
  private readonly enqueueTask: CoordinationOutboxDispatcherDependencies["enqueueTask"];
  private readonly dispatcherId: string;
  private readonly idempotencyTtlMs: number;

  constructor(deps: CoordinationOutboxDispatcherDependencies) {
    this.generationPort = deps.generationPort;
    this.idempotencyPort = deps.idempotencyPort;
    this.enqueueTask = deps.enqueueTask;
    this.dispatcherId = deps.dispatcherId ?? "coordination-dispatcher";
    this.idempotencyTtlMs =
      deps.idempotencyTtlMs ?? DEFAULT_DISPATCH_IDEMPOTENCY_TTL_MS;
  }

  async dispatch(
    event: CoordinationDispatchEvent,
    now: number
  ): Promise<CoordinationDispatchResult> {
    const idempotencyKey = `${COORDINATION_DISPATCH_IDEMPOTENCY_PREFIX}:${event.eventId}`;
    const existing = await this.idempotencyPort.getIdempotency(idempotencyKey);
    if (existing !== null) {
      if (existing.status === "succeeded" && isDispatchResult(existing.result)) {
        return {
          ...existing.result,
          status: "duplicate_succeeded"
        };
      }

      return {
        status: "duplicate_inflight",
        generationBumps: [],
        tasks: []
      };
    }

    await this.idempotencyPort.start({
      key: idempotencyKey,
      ownerId: this.dispatcherId,
      ttlMs: this.idempotencyTtlMs,
      now
    });

    try {
      const plan = buildCoordinationDispatchPlan(event, now);
      const generationBumps: CoordinationGenerationRecord[] = [];
      for (const bump of plan.generationBumps) {
        generationBumps.push(await this.generationPort.bump(bump));
      }

      const tasks: CoordinationDispatchTaskResult[] = [];
      for (const task of plan.tasks) {
        const result = await this.enqueueTask(task, now);
        tasks.push({
          taskId: task.taskId,
          accepted: result.accepted,
          dedupeHit: result.dedupeHit
        });
      }

      const response: CoordinationDispatchResult = {
        status: "applied",
        generationBumps,
        tasks
      };
      await this.idempotencyPort.succeed({
        key: idempotencyKey,
        ownerId: this.dispatcherId,
        now,
        result: response
      });
      return response;
    } catch (error) {
      await this.idempotencyPort.fail({
        key: idempotencyKey,
        ownerId: this.dispatcherId,
        now,
        retriable: true,
        failure: coordinationFailureFromError(error, {
          code: "coord_dispatch_failed",
          retriable: true
        })
      });
      throw error;
    }
  }
}

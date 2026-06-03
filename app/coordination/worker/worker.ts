import {
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_PRESENCE_STALE_GRACE_MS,
  DEFAULT_PRESENCE_TTL_MS,
  DEFAULT_SINGLE_FLIGHT_TTL_MS
} from "../constants";
import { coordinationFailureFromError } from "../errors";
import type { CoordinationJobResult } from "../jobs";
import { type CoordinationHandlerRegistry } from "./handler-registry";
import type {
  IdempotencyPort,
  LeasePort,
  PresencePort,
  QueuePort,
  SingleFlightPort
} from "../ports";
import {
  CoordinationTaskStatus,
  DlqReason,
  type CoordinationFailure,
  type CoordinationTaskRecord
} from "../types";

export interface CoordinationWorkerDependencies {
  readonly workerId: string;
  readonly handlers: CoordinationHandlerRegistry;
  readonly queue: QueuePort;
  readonly leasePort: LeasePort;
  readonly presencePort: PresencePort;
  readonly singleFlightPort?: SingleFlightPort;
  readonly idempotencyPort?: IdempotencyPort;
  readonly leaseTtlMs?: number;
  readonly presenceTtlMs?: number;
  readonly presenceStaleGraceMs?: number;
  readonly singleFlightTtlMs?: number;
}

export interface CoordinationWorkerTickResult {
  readonly taskId?: string;
  readonly status:
    | "idle"
    | "succeeded"
    | "retried"
    | "dlq"
    | "already_succeeded"
    | "already_inflight";
}

export class CoordinationWorker {
  private readonly workerId: string;
  private readonly handlers: CoordinationHandlerRegistry;
  private readonly queue: QueuePort;
  private readonly leasePort: LeasePort;
  private readonly presencePort: PresencePort;
  private readonly singleFlightPort?: SingleFlightPort;
  private readonly idempotencyPort?: IdempotencyPort;
  private readonly leaseTtlMs: number;
  private readonly presenceTtlMs: number;
  private readonly presenceStaleGraceMs: number;
  private readonly singleFlightTtlMs: number;

  constructor(deps: CoordinationWorkerDependencies) {
    this.workerId = deps.workerId;
    this.handlers = deps.handlers;
    this.queue = deps.queue;
    this.leasePort = deps.leasePort;
    this.presencePort = deps.presencePort;
    this.singleFlightPort = deps.singleFlightPort;
    this.idempotencyPort = deps.idempotencyPort;
    this.leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.presenceTtlMs = deps.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS;
    this.presenceStaleGraceMs =
      deps.presenceStaleGraceMs ?? DEFAULT_PRESENCE_STALE_GRACE_MS;
    this.singleFlightTtlMs =
      deps.singleFlightTtlMs ?? DEFAULT_SINGLE_FLIGHT_TTL_MS;
  }

  async heartbeat(now: number): Promise<void> {
    await this.presencePort.heartbeat({
      workerId: this.workerId,
      now,
      ttlMs: this.presenceTtlMs,
      staleGraceMs: this.presenceStaleGraceMs,
      currentLoad: 1
    });
  }

  async drainOnce(now: number): Promise<CoordinationWorkerTickResult> {
    await this.heartbeat(now);

    const claimed = await this.queue.claimNext({
      workerId: this.workerId,
      leaseTtlMs: this.leaseTtlMs,
      now,
      requirePresence: true
    });

    if (claimed === null) {
      return { status: "idle" };
    }

    let singleFlightClaimed = false;
    try {
      await this.queue.markRunning(
        claimed.task.taskId,
        claimed.lease.leaseId,
        this.workerId,
        now
      );

      if (claimed.task.idempotencyKey !== undefined && this.idempotencyPort) {
        const record = await this.idempotencyPort.start({
          key: claimed.task.idempotencyKey,
          ownerId: this.workerId,
          ttlMs: this.leaseTtlMs * 4,
          now
        });
        if (record.status === "succeeded") {
          await this.leasePort.releaseLease({
            taskId: claimed.task.taskId,
            leaseId: claimed.lease.leaseId,
            ownerId: this.workerId,
            finalStatus: CoordinationTaskStatus.Succeeded,
            now
          });
          return {
            taskId: claimed.task.taskId,
            status: "already_succeeded"
          };
        }
      }

      if (claimed.task.singleFlightKey !== undefined && this.singleFlightPort) {
        const flight = await this.singleFlightPort.claim({
          key: claimed.task.singleFlightKey,
          ownerId: this.workerId,
          taskId: claimed.task.taskId,
          ttlMs: this.singleFlightTtlMs,
          now
        });
        singleFlightClaimed = flight.acquired;
        if (!flight.acquired) {
          await this.queue.requeue({
            taskId: claimed.task.taskId,
            now,
            delayMs: 1_000,
            ownerId: this.workerId,
            leaseId: claimed.lease.leaseId,
            error: {
              code: "coord_singleflight_busy",
              message: `Single-flight already active for ${claimed.task.singleFlightKey}`,
              retriable: true
            }
          });
          return {
            taskId: claimed.task.taskId,
            status: "already_inflight"
          };
        }
      }

      const handler = this.handlers.get(claimed.task.taskType);
      if (handler === undefined) {
        await this.sendTaskToDlq(
          claimed.task,
          claimed.lease.leaseId,
          now,
          {
            code: "coord_handler_missing",
            message: `No coordination handler registered for ${claimed.task.taskType}`,
            retriable: false
          },
          DlqReason.HandlerUnavailable
        );
        return { taskId: claimed.task.taskId, status: "dlq" };
      }

      const result = await handler.handle({
        task: claimed.task,
        lease: claimed.lease,
        workerId: this.workerId,
        now,
        renewLease: async (ttlMs = this.leaseTtlMs) =>
          this.leasePort.renew({
            taskId: claimed.task.taskId,
            leaseId: claimed.lease.leaseId,
            ownerId: this.workerId,
            ttlMs,
            now
          })
      });

      return this.applyJobResult(claimed.task, claimed.lease.leaseId, result, now);
    } catch (error) {
      const failure = coordinationFailureFromError(error, {
        retriable: true
      });
      await this.queue.requeue({
        taskId: claimed.task.taskId,
        now,
        delayMs: 1_000,
        ownerId: this.workerId,
        leaseId: claimed.lease.leaseId,
        error: failure
      });
      if (claimed.task.idempotencyKey !== undefined && this.idempotencyPort) {
        await this.idempotencyPort.fail({
          key: claimed.task.idempotencyKey,
          ownerId: this.workerId,
          now,
          retriable: failure.retriable,
          failure
        });
      }
      return { taskId: claimed.task.taskId, status: "retried" };
    } finally {
      if (
        singleFlightClaimed &&
        claimed.task.singleFlightKey !== undefined &&
        this.singleFlightPort
      ) {
        await this.singleFlightPort.releaseFlight(
          claimed.task.singleFlightKey,
          this.workerId
        );
      }
    }
  }

  private async applyJobResult(
    task: CoordinationTaskRecord,
    leaseId: string,
    result: CoordinationJobResult,
    now: number
  ): Promise<CoordinationWorkerTickResult> {
    if (result.kind === "succeeded") {
      await this.leasePort.releaseLease({
        taskId: task.taskId,
        leaseId,
        ownerId: this.workerId,
        finalStatus: CoordinationTaskStatus.Succeeded,
        now
      });
      if (task.idempotencyKey !== undefined && this.idempotencyPort) {
        await this.idempotencyPort.succeed({
          key: task.idempotencyKey,
          ownerId: this.workerId,
          now,
          result: result.result
        });
      }
      return { taskId: task.taskId, status: "succeeded" };
    }

    if (result.kind === "retry") {
      const failure: CoordinationFailure = {
        code: result.code ?? "coord_retry_requested",
        message:
          result.message ?? `Handler requested retry for task ${task.taskId}`,
        retriable: true
      };
      await this.queue.requeue({
        taskId: task.taskId,
        now,
        delayMs: result.delayMs,
        ownerId: this.workerId,
        leaseId,
        error: failure
      });
      if (task.idempotencyKey !== undefined && this.idempotencyPort) {
        await this.idempotencyPort.fail({
          key: task.idempotencyKey,
          ownerId: this.workerId,
          now,
          retriable: true,
          failure
        });
      }
      return { taskId: task.taskId, status: "retried" };
    }

    await this.sendTaskToDlq(
      task,
      leaseId,
      now,
      {
        code: result.code ?? "coord_dlq_requested",
        message: result.message ?? `Handler requested DLQ for task ${task.taskId}`,
        retriable: false
      },
      result.reason
    );
    return { taskId: task.taskId, status: "dlq" };
  }

  private async sendTaskToDlq(
    task: CoordinationTaskRecord,
    leaseId: string,
    now: number,
    failure: CoordinationFailure,
    reason: DlqReason
  ): Promise<void> {
    await this.queue.moveToDlq({
      taskId: task.taskId,
      now,
      ownerId: this.workerId,
      leaseId,
      reason,
      error: failure
    });
    if (task.idempotencyKey !== undefined && this.idempotencyPort) {
      await this.idempotencyPort.fail({
        key: task.idempotencyKey,
        ownerId: this.workerId,
        now,
        retriable: false,
        failure
      });
    }
  }
}

import { decideExpiredLeaseRecovery } from "../jobs";
import type {
  PresencePort,
  QueuePort,
  RuntimeContextPort,
  SingleFlightPort
} from "../ports";
import type { CoordinationTaskRecord, WorkerPresenceRecord } from "../types";

export interface RecoverySweepSummary {
  readonly expiredLeaseTasks: readonly CoordinationTaskRecord[];
  readonly staleWorkers: readonly WorkerPresenceRecord[];
  readonly runsPurged: number;
  readonly taskContextsPurged: number;
  readonly singleFlightsPurged: number;
}

export interface CoordinationRecoverySweeperDependencies {
  readonly queue: QueuePort;
  readonly presencePort: PresencePort;
  readonly runtimeContextPort?: RuntimeContextPort;
  readonly singleFlightPort?: SingleFlightPort;
}

export class CoordinationRecoverySweeper {
  private readonly queue: QueuePort;
  private readonly presencePort: PresencePort;
  private readonly runtimeContextPort?: RuntimeContextPort;
  private readonly singleFlightPort?: SingleFlightPort;

  constructor(deps: CoordinationRecoverySweeperDependencies) {
    this.queue = deps.queue;
    this.presencePort = deps.presencePort;
    this.runtimeContextPort = deps.runtimeContextPort;
    this.singleFlightPort = deps.singleFlightPort;
  }

  async sweep(now: number): Promise<RecoverySweepSummary> {
    const expired = await this.queue.findExpiredLeaseTasks(now);
    for (const task of expired) {
      const decision = decideExpiredLeaseRecovery(task, now);
      if (decision.action === "retry") {
        await this.queue.requeue({
          taskId: task.taskId,
          now,
          delayMs: decision.delayMs ?? 0,
          error: decision.failure,
          recoveryReason: decision.reason,
          recoveredBy: "recovery-sweeper"
        });
        continue;
      }

      await this.queue.moveToDlq({
        taskId: task.taskId,
        now,
        reason: decision.dlqReason!,
        error: decision.failure
      });
    }

    const staleWorkers = await this.presencePort.sweepPresence(now);
    const purgedRuntime = this.runtimeContextPort
      ? await this.runtimeContextPort.purgeExpired(now)
      : { runsPurged: 0, tasksPurged: 0 };
    const singleFlightsPurged = this.singleFlightPort
      ? await this.singleFlightPort.sweepFlights(now)
      : 0;

    return {
      expiredLeaseTasks: expired,
      staleWorkers,
      runsPurged: purgedRuntime.runsPurged,
      taskContextsPurged: purgedRuntime.tasksPurged,
      singleFlightsPurged
    };
  }
}

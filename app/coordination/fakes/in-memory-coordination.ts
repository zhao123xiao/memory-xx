import { randomUUID } from "node:crypto";

import {
  DEFAULT_DEDUPE_WINDOW_MS,
  INITIAL_GENERATION,
  PRIORITY_LANE_ORDER
} from "../constants";
import {
  FencingTokenRejectedError,
  LeaseRejectedError,
  LockConflictError,
  PresenceUnavailableError,
  TaskNotFoundError
} from "../errors";
import { coordinationKeys } from "../keys";
import type {
  DedupePort,
  EnqueueTaskInput,
  EnqueueTaskResult,
  FencingPort,
  GenerationPort,
  IdempotencyPort,
  LeasePort,
  LockPort,
  PresencePort,
  QueuePort,
  RegisterDedupeInput,
  RegisterDedupeResult,
  ReplayDlqTaskInput,
  RuntimeContextPort,
  SingleFlightPort
} from "../ports";
import {
  CoordinationTaskStatus,
  IdempotencyStatus,
  LockScope,
  PresenceState,
  RecoveryReason,
  type ClaimedCoordinationTask,
  type CoordinationBacklogSnapshot,
  type CoordinationFailure,
  type CoordinationGenerationKey,
  type CoordinationGenerationRecord,
  type CoordinationLaneSnapshot,
  type CoordinationLease,
  type CoordinationTaskRecord,
  type DedupeStatistics,
  type DedupeWindowRecord,
  type DistributedLock,
  type IdempotencyRecord,
  type RunRuntimeContext,
  type SingleFlightClaimResult,
  type SingleFlightRecord,
  type TaskRuntimeContext,
  type WorkerPresenceRecord
} from "../types";

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sortTasks(
  left: CoordinationTaskRecord,
  right: CoordinationTaskRecord
): number {
  const laneDelta =
    PRIORITY_LANE_ORDER.indexOf(left.priority) -
    PRIORITY_LANE_ORDER.indexOf(right.priority);
  if (laneDelta !== 0) {
    return laneDelta;
  }
  if (left.visibleAt !== right.visibleAt) {
    return left.visibleAt - right.visibleAt;
  }
  return left.enqueueAt - right.enqueueAt;
}

export class InMemoryCoordinationStore
  implements
    QueuePort,
    LeasePort,
    LockPort,
    FencingPort,
    GenerationPort,
    PresencePort,
    RuntimeContextPort,
    SingleFlightPort,
    IdempotencyPort,
    DedupePort
{
  private readonly tasks = new Map<string, CoordinationTaskRecord>();
  private readonly locks = new Map<string, DistributedLock>();
  private readonly fencingCounters = new Map<string, number>();
  private readonly generations = new Map<string, CoordinationGenerationRecord>();
  private readonly generationAudit = new Map<string, CoordinationGenerationRecord>();
  private readonly presence = new Map<string, WorkerPresenceRecord>();
  private readonly runContexts = new Map<string, RunRuntimeContext>();
  private readonly taskContexts = new Map<string, TaskRuntimeContext>();
  private readonly singleFlights = new Map<string, SingleFlightRecord>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly dedupe = new Map<string, DedupeWindowRecord>();
  private dedupeHits = 0;

  async enqueue(input: EnqueueTaskInput): Promise<EnqueueTaskResult> {
    const now = input.now ?? input.task.enqueueAt;
    if (input.task.dedupeKey !== undefined) {
      const dedupe = await this.register({
        key: input.task.dedupeKey,
        taskId: input.task.taskId,
        now,
        ttlMs: input.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS
      });
      if (!dedupe.accepted) {
        const existingTask = this.tasks.get(dedupe.record.firstTaskId);
        if (existingTask !== undefined) {
          return {
            accepted: false,
            dedupeHit: true,
            task: cloneValue(existingTask)
          };
        }
      }
    }

    const record: CoordinationTaskRecord = {
      ...input.task,
      status:
        input.task.visibleAt > now
          ? CoordinationTaskStatus.RetryWait
          : CoordinationTaskStatus.Queued,
      attempt: 0,
      createdAt: now,
      updatedAt: now,
      dedupeHits: 0
    };
    this.tasks.set(record.taskId, record);
    return {
      accepted: true,
      dedupeHit: false,
      task: cloneValue(record)
    };
  }

  async claimNext(input: {
    readonly workerId: string;
    readonly leaseTtlMs: number;
    readonly now: number;
    readonly requirePresence?: boolean;
  }): Promise<ClaimedCoordinationTask | null> {
    if (input.requirePresence) {
      const worker = await this.getWorker(input.workerId, input.now);
      if (worker === null || worker.state !== PresenceState.Alive) {
        throw new PresenceUnavailableError(input.workerId);
      }
    }

    const candidate = Array.from(this.tasks.values())
      .filter(
        (task) =>
          (task.status === CoordinationTaskStatus.Queued ||
            task.status === CoordinationTaskStatus.RetryWait ||
            task.status === CoordinationTaskStatus.Recovered) &&
          task.visibleAt <= input.now
      )
      .sort(sortTasks)[0];

    if (candidate === undefined) {
      return null;
    }

    const lease: CoordinationLease = {
      leaseId: randomUUID(),
      ownerId: input.workerId,
      fencingToken: await this.nextToken({
        lockScope: LockScope.Task,
        resourceId: candidate.taskId
      }),
      acquiredAt: input.now,
      deadlineAt: input.now + input.leaseTtlMs,
      lastRenewedAt: input.now
    };
    const claimed: CoordinationTaskRecord = {
      ...candidate,
      status: CoordinationTaskStatus.Leased,
      attempt: candidate.attempt + 1,
      updatedAt: input.now,
      lease,
      lastWorkerId: input.workerId,
      attemptStartedAt: input.now
    };
    this.tasks.set(claimed.taskId, claimed);
    return {
      task: cloneValue(claimed),
      lease: cloneValue(lease)
    };
  }

  async getTask(taskId: string): Promise<CoordinationTaskRecord | null> {
    return cloneValue(this.tasks.get(taskId) ?? null);
  }

  async markRunning(
    taskId: string,
    leaseId: string,
    ownerId: string,
    now: number
  ): Promise<CoordinationTaskRecord> {
    const task = this.requireTask(taskId);
    this.assertLeaseOwner(task, leaseId, ownerId, now);
    const updated: CoordinationTaskRecord = {
      ...task,
      status: CoordinationTaskStatus.Running,
      updatedAt: now
    };
    this.tasks.set(taskId, updated);
    return cloneValue(updated);
  }

  async renew(input: {
    readonly taskId: string;
    readonly leaseId: string;
    readonly ownerId: string;
    readonly ttlMs: number;
    readonly now: number;
  }): Promise<CoordinationLease> {
    const task = this.requireTask(input.taskId);
    this.assertLeaseOwner(task, input.leaseId, input.ownerId, input.now);
    const lease: CoordinationLease = {
      ...task.lease!,
      deadlineAt: input.now + input.ttlMs,
      lastRenewedAt: input.now
    };
    this.tasks.set(input.taskId, {
      ...task,
      lease,
      updatedAt: input.now
    });
    return cloneValue(lease);
  }

  async releaseLease(input: {
    readonly taskId: string;
    readonly leaseId: string;
    readonly ownerId: string;
    readonly finalStatus: CoordinationTaskStatus.Succeeded | CoordinationTaskStatus.FailedFinal | CoordinationTaskStatus.Recovered;
    readonly now: number;
  }): Promise<CoordinationTaskRecord> {
    const task = this.requireTask(input.taskId);
    this.assertLeaseOwner(task, input.leaseId, input.ownerId, input.now);
    const updated: CoordinationTaskRecord = {
      ...task,
      status: input.finalStatus,
      lease: undefined,
      updatedAt: input.now,
      completedAt: input.now
    };
    this.tasks.set(input.taskId, updated);
    return cloneValue(updated);
  }

  async requeue(input: {
    readonly taskId: string;
    readonly now: number;
    readonly delayMs: number;
    readonly error?: CoordinationFailure;
    readonly ownerId?: string;
    readonly leaseId?: string;
    readonly recoveryReason?: RecoveryReason;
    readonly recoveredBy?: string;
  }): Promise<CoordinationTaskRecord> {
    const task = this.requireTask(input.taskId);
    if (input.ownerId !== undefined || input.leaseId !== undefined) {
      this.assertLeaseOwner(task, input.leaseId, input.ownerId, input.now);
    }
    const updated: CoordinationTaskRecord = {
      ...task,
      status:
        input.recoveryReason === undefined
          ? CoordinationTaskStatus.RetryWait
          : CoordinationTaskStatus.Recovered,
      lease: undefined,
      visibleAt: input.now + input.delayMs,
      updatedAt: input.now,
      lastError: input.error,
      recovery:
        input.recoveryReason === undefined
          ? task.recovery
          : {
              reason: input.recoveryReason,
              recoveredAt: input.now,
              recoveredBy: input.recoveredBy ?? "unknown",
              note: input.error?.message
            }
    };
    this.tasks.set(input.taskId, updated);
    return cloneValue(updated);
  }

  async moveToDlq(input: {
    readonly taskId: string;
    readonly now: number;
    readonly reason: import("../types").DlqReason;
    readonly error: CoordinationFailure;
    readonly ownerId?: string;
    readonly leaseId?: string;
  }): Promise<CoordinationTaskRecord> {
    const task = this.requireTask(input.taskId);
    if (input.ownerId !== undefined || input.leaseId !== undefined) {
      this.assertLeaseOwner(task, input.leaseId, input.ownerId, input.now);
    }
    const updated: CoordinationTaskRecord = {
      ...task,
      status: CoordinationTaskStatus.Dlq,
      lease: undefined,
      updatedAt: input.now,
      completedAt: input.now,
      lastError: {
        ...input.error,
        details: {
          ...(input.error.details ?? {}),
          dlqReason: input.reason
        }
      }
    };
    this.tasks.set(input.taskId, updated);
    return cloneValue(updated);
  }

  async listDlq(): Promise<readonly CoordinationTaskRecord[]> {
    return Array.from(this.tasks.values())
      .filter((task) => task.status === CoordinationTaskStatus.Dlq)
      .map((task) => cloneValue(task));
  }

  async replayDlq(input: ReplayDlqTaskInput): Promise<CoordinationTaskRecord> {
    const task = this.requireTask(input.taskId);
    if (task.status !== CoordinationTaskStatus.Dlq) {
      throw new LeaseRejectedError(`Task ${input.taskId} is not in DLQ`);
    }
    const updated: CoordinationTaskRecord = {
      ...task,
      status: CoordinationTaskStatus.Recovered,
      visibleAt: input.now + (input.delayMs ?? 0),
      updatedAt: input.now,
      completedAt: undefined,
      recovery: {
        reason: RecoveryReason.DlqReplay,
        recoveredAt: input.now,
        recoveredBy: input.recoveredBy,
        note: input.note
      }
    };
    this.tasks.set(input.taskId, updated);
    return cloneValue(updated);
  }

  async findExpiredLeaseTasks(now: number): Promise<readonly CoordinationTaskRecord[]> {
    return Array.from(this.tasks.values())
      .filter(
        (task) =>
          task.lease !== undefined &&
          task.lease.deadlineAt <= now &&
          (task.status === CoordinationTaskStatus.Leased ||
            task.status === CoordinationTaskStatus.Running)
      )
      .map((task) => cloneValue(task));
  }

  async getBacklogSnapshot(now: number): Promise<CoordinationBacklogSnapshot> {
    const lanes: CoordinationLaneSnapshot[] = PRIORITY_LANE_ORDER.map((lane) => {
      const tasks = Array.from(this.tasks.values()).filter(
        (task) => task.priority === lane
      );
      const readyCount = tasks.filter(
        (task) =>
          (task.status === CoordinationTaskStatus.Queued ||
            task.status === CoordinationTaskStatus.Recovered) &&
          task.visibleAt <= now
      ).length;
      const retryWaitCount = tasks.filter(
        (task) =>
          task.status === CoordinationTaskStatus.RetryWait ||
          ((task.status === CoordinationTaskStatus.Queued ||
            task.status === CoordinationTaskStatus.Recovered) &&
            task.visibleAt > now)
      ).length;
      const leasedCount = tasks.filter(
        (task) =>
          task.status === CoordinationTaskStatus.Leased ||
          task.status === CoordinationTaskStatus.Running
      ).length;
      const dlqCount = tasks.filter(
        (task) => task.status === CoordinationTaskStatus.Dlq
      ).length;
      const oldestVisibleAt = tasks.length
        ? Math.min(...tasks.map((task) => task.visibleAt))
        : undefined;
      return {
        lane,
        readyCount,
        retryWaitCount,
        leasedCount,
        dlqCount,
        oldestVisibleAt,
        oldestAgeMs:
          oldestVisibleAt === undefined ? undefined : Math.max(0, now - oldestVisibleAt)
      };
    });

    return {
      takenAt: now,
      lanes,
      dedupeHits: this.dedupeHits,
      inflightCount: this.singleFlights.size
    };
  }

  async acquire(input: {
    readonly lockScope: LockScope;
    readonly resourceId: string;
    readonly ownerId: string;
    readonly ttlMs: number;
    readonly now: number;
    readonly leaseId?: string;
  }): Promise<DistributedLock | null> {
    const key = coordinationKeys.lock(input.lockScope, input.resourceId);
    const current = this.locks.get(key);
    if (current !== undefined && current.expiresAt > input.now) {
      return null;
    }

    const lock: DistributedLock = {
      lockScope: input.lockScope,
      resourceId: input.resourceId,
      ownerId: input.ownerId,
      leaseId: input.leaseId,
      fencingToken: await this.nextToken({
        lockScope: input.lockScope,
        resourceId: input.resourceId
      }),
      acquiredAt: input.now,
      expiresAt: input.now + input.ttlMs
    };
    this.locks.set(key, lock);
    return cloneValue(lock);
  }

  async releaseLock(input: {
    readonly lockScope: LockScope;
    readonly resourceId: string;
    readonly ownerId: string;
    readonly fencingToken: number;
  }): Promise<boolean> {
    const key = coordinationKeys.lock(input.lockScope, input.resourceId);
    const current = this.locks.get(key);
    if (current === undefined) {
      return false;
    }
    if (
      current.ownerId !== input.ownerId ||
      current.fencingToken !== input.fencingToken
    ) {
      throw new LockConflictError(input.resourceId, {
        ownerId: input.ownerId,
        fencingToken: input.fencingToken
      });
    }
    this.locks.delete(key);
    return true;
  }

  async getLock(
    lockScope: LockScope,
    resourceId: string
  ): Promise<DistributedLock | null> {
    return cloneValue(this.locks.get(coordinationKeys.lock(lockScope, resourceId)) ?? null);
  }

  async nextToken(input: {
    readonly lockScope: LockScope;
    readonly resourceId: string;
  }): Promise<number> {
    const key = coordinationKeys.fencingCounter(input.lockScope, input.resourceId);
    const next = (this.fencingCounters.get(key) ?? 0) + 1;
    this.fencingCounters.set(key, next);
    return next;
  }

  async isCurrentToken(input: {
    readonly lockScope: LockScope;
    readonly resourceId: string;
    readonly fencingToken: number;
  }): Promise<boolean> {
    const current = this.fencingCounters.get(
      coordinationKeys.fencingCounter(input.lockScope, input.resourceId)
    ) ?? 0;
    return current === input.fencingToken;
  }

  async getGeneration(
    key: CoordinationGenerationKey
  ): Promise<CoordinationGenerationRecord> {
    return cloneValue(
      this.generations.get(coordinationKeys.generation(key)) ?? {
        key,
        value: INITIAL_GENERATION,
        updatedAt: 0,
        reason: "initial"
      }
    );
  }

  async bump(input: {
    readonly key: CoordinationGenerationKey;
    readonly now: number;
    readonly reason: string;
    readonly sourceEventId?: string;
  }): Promise<CoordinationGenerationRecord> {
    const storageKey = coordinationKeys.generation(input.key);
    const auditKey =
      input.sourceEventId === undefined
        ? undefined
        : `${storageKey}:${input.sourceEventId}`;
    if (auditKey !== undefined) {
      const existing = this.generationAudit.get(auditKey);
      if (existing !== undefined) {
        return cloneValue(existing);
      }
    }
    const current = this.generations.get(storageKey);
    const record: CoordinationGenerationRecord = {
      key: input.key,
      value: (current?.value ?? INITIAL_GENERATION) + 1,
      updatedAt: input.now,
      reason: input.reason,
      lastSourceEventId: input.sourceEventId
    };
    this.generations.set(storageKey, record);
    if (auditKey !== undefined) {
      this.generationAudit.set(auditKey, record);
    }
    return cloneValue(record);
  }

  async heartbeat(input: {
    readonly workerId: string;
    readonly now: number;
    readonly ttlMs: number;
    readonly staleGraceMs: number;
    readonly capabilities?: readonly string[];
    readonly currentLoad?: number;
    readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
  }): Promise<WorkerPresenceRecord> {
    const record: WorkerPresenceRecord = {
      workerId: input.workerId,
      state: PresenceState.Alive,
      capabilities: [...(input.capabilities ?? [])],
      currentLoad: input.currentLoad ?? 0,
      heartbeatAt: input.now,
      expiresAt: input.now + input.ttlMs,
      staleAt: input.now + input.ttlMs + input.staleGraceMs,
      metadata: input.metadata
    };
    this.presence.set(input.workerId, record);
    return cloneValue(record);
  }

  async getWorker(
    workerId: string,
    now: number
  ): Promise<WorkerPresenceRecord | null> {
    const record = this.presence.get(workerId);
    if (record === undefined) {
      return null;
    }
    return cloneValue(this.derivePresence(record, now));
  }

  async listWorkers(now: number): Promise<readonly WorkerPresenceRecord[]> {
    return Array.from(this.presence.values()).map((record) =>
      cloneValue(this.derivePresence(record, now))
    );
  }

  async sweepPresence(now: number): Promise<readonly WorkerPresenceRecord[]> {
    const workers: WorkerPresenceRecord[] = [];
    for (const [workerId, record] of this.presence.entries()) {
      const updated = this.derivePresence(record, now);
      this.presence.set(workerId, updated);
      workers.push(cloneValue(updated));
    }
    return workers;
  }

  async putRunContext(context: RunRuntimeContext): Promise<RunRuntimeContext> {
    this.runContexts.set(context.runId, cloneValue(context));
    return cloneValue(context);
  }

  async getRunContext(runId: string, now: number): Promise<RunRuntimeContext | null> {
    const context = this.runContexts.get(runId);
    if (context === undefined || context.expiresAt <= now) {
      this.runContexts.delete(runId);
      return null;
    }
    return cloneValue(context);
  }

  async putTaskContext(context: TaskRuntimeContext): Promise<TaskRuntimeContext> {
    this.taskContexts.set(context.taskId, cloneValue(context));
    return cloneValue(context);
  }

  async getTaskContext(
    taskId: string,
    now: number
  ): Promise<TaskRuntimeContext | null> {
    const context = this.taskContexts.get(taskId);
    if (context === undefined || context.expiresAt <= now) {
      this.taskContexts.delete(taskId);
      return null;
    }
    return cloneValue(context);
  }

  async purgeExpired(now: number): Promise<{ runsPurged: number; tasksPurged: number }> {
    let runsPurged = 0;
    let tasksPurged = 0;
    for (const [runId, context] of this.runContexts.entries()) {
      if (context.expiresAt <= now) {
        this.runContexts.delete(runId);
        runsPurged += 1;
      }
    }
    for (const [taskId, context] of this.taskContexts.entries()) {
      if (context.expiresAt <= now) {
        this.taskContexts.delete(taskId);
        tasksPurged += 1;
      }
    }
    return { runsPurged, tasksPurged };
  }

  async claim(input: {
    readonly key: string;
    readonly ownerId: string;
    readonly taskId?: string;
    readonly ttlMs: number;
    readonly now: number;
  }): Promise<SingleFlightClaimResult> {
    const storageKey = coordinationKeys.singleFlight(input.key);
    const current = this.singleFlights.get(storageKey);
    if (current !== undefined && current.expiresAt > input.now) {
      return {
        acquired: false,
        record: cloneValue(current)
      };
    }
    const record: SingleFlightRecord = {
      key: input.key,
      ownerId: input.ownerId,
      taskId: input.taskId,
      createdAt: input.now,
      expiresAt: input.now + input.ttlMs
    };
    this.singleFlights.set(storageKey, record);
    return {
      acquired: true,
      record: cloneValue(record)
    };
  }

  async releaseFlight(key: string, ownerId: string): Promise<boolean> {
    const storageKey = coordinationKeys.singleFlight(key);
    const record = this.singleFlights.get(storageKey);
    if (record === undefined || record.ownerId !== ownerId) {
      return false;
    }
    this.singleFlights.delete(storageKey);
    return true;
  }

  async sweepFlights(now: number): Promise<number> {
    let purged = 0;
    for (const [key, record] of this.singleFlights.entries()) {
      if (record.expiresAt <= now) {
        this.singleFlights.delete(key);
        purged += 1;
      }
    }
    return purged;
  }

  async start(input: {
    readonly key: string;
    readonly ownerId: string;
    readonly ttlMs: number;
    readonly now: number;
  }): Promise<IdempotencyRecord> {
    const storageKey = coordinationKeys.idempotency(input.key);
    const existing = this.idempotency.get(storageKey);
    if (existing !== undefined && existing.expiresAt > input.now) {
      return cloneValue(existing);
    }
    const record: IdempotencyRecord = {
      key: input.key,
      ownerId: input.ownerId,
      status: IdempotencyStatus.Processing,
      createdAt: input.now,
      updatedAt: input.now,
      expiresAt: input.now + input.ttlMs
    };
    this.idempotency.set(storageKey, record);
    return cloneValue(record);
  }

  async succeed(input: {
    readonly key: string;
    readonly ownerId: string;
    readonly now: number;
    readonly result?: unknown;
  }): Promise<IdempotencyRecord> {
    const current = this.requireIdempotency(input.key);
    const updated: IdempotencyRecord = {
      ...current,
      ownerId: input.ownerId,
      status: IdempotencyStatus.Succeeded,
      updatedAt: input.now,
      result: input.result
    };
    this.idempotency.set(coordinationKeys.idempotency(input.key), updated);
    return cloneValue(updated);
  }

  async fail(input: {
    readonly key: string;
    readonly ownerId: string;
    readonly now: number;
    readonly retriable: boolean;
    readonly failure: CoordinationFailure;
  }): Promise<IdempotencyRecord> {
    const current = this.requireIdempotency(input.key);
    const updated: IdempotencyRecord = {
      ...current,
      ownerId: input.ownerId,
      status: input.retriable
        ? IdempotencyStatus.FailedRetriable
        : IdempotencyStatus.FailedFinal,
      updatedAt: input.now,
      failure: input.failure
    };
    this.idempotency.set(coordinationKeys.idempotency(input.key), updated);
    return cloneValue(updated);
  }

  async getIdempotency(key: string): Promise<IdempotencyRecord | null> {
    return cloneValue(this.idempotency.get(coordinationKeys.idempotency(key)) ?? null);
  }

  async register(input: RegisterDedupeInput): Promise<RegisterDedupeResult> {
    const storageKey = coordinationKeys.dedupe(input.key);
    const current = this.dedupe.get(storageKey);
    if (current !== undefined && current.expiresAt > input.now) {
      const updated: DedupeWindowRecord = {
        ...current,
        hitCount: current.hitCount + 1
      };
      this.dedupe.set(storageKey, updated);
      this.dedupeHits += 1;
      const firstTask = this.tasks.get(updated.firstTaskId);
      if (firstTask !== undefined) {
        this.tasks.set(firstTask.taskId, {
          ...firstTask,
          dedupeHits: firstTask.dedupeHits + 1
        });
      }
      return {
        accepted: false,
        record: cloneValue(updated)
      };
    }
    const record: DedupeWindowRecord = {
      key: input.key,
      firstTaskId: input.taskId,
      firstSeenAt: input.now,
      expiresAt: input.now + input.ttlMs,
      hitCount: 0
    };
    this.dedupe.set(storageKey, record);
    return {
      accepted: true,
      record: cloneValue(record)
    };
  }

  async getStatistics(): Promise<DedupeStatistics> {
    return {
      totalHits: this.dedupeHits,
      activeWindows: this.dedupe.size
    };
  }

  async purgeDedupe(now: number): Promise<number> {
    let purged = 0;
    for (const [key, record] of this.dedupe.entries()) {
      if (record.expiresAt <= now) {
        this.dedupe.delete(key);
        purged += 1;
      }
    }
    return purged;
  }

  async validateFencingToken(
    lockScope: LockScope,
    resourceId: string,
    fencingToken: number
  ): Promise<void> {
    const current = await this.isCurrentToken({
      lockScope,
      resourceId,
      fencingToken
    });
    if (!current) {
      throw new FencingTokenRejectedError(resourceId, fencingToken);
    }
  }

  private requireTask(taskId: string): CoordinationTaskRecord {
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      throw new TaskNotFoundError(taskId);
    }
    return task;
  }

  private assertLeaseOwner(
    task: CoordinationTaskRecord,
    leaseId: string | undefined,
    ownerId: string | undefined,
    now: number
  ): void {
    if (task.lease === undefined) {
      throw new LeaseRejectedError(`Task ${task.taskId} is not leased`);
    }
    if (task.lease.deadlineAt <= now) {
      throw new LeaseRejectedError(`Lease already expired for task ${task.taskId}`);
    }
    if (
      (leaseId !== undefined && task.lease.leaseId !== leaseId) ||
      (ownerId !== undefined && task.lease.ownerId !== ownerId)
    ) {
      throw new LeaseRejectedError(`Lease ownership rejected for task ${task.taskId}`, {
        expectedLeaseId: task.lease.leaseId,
        actualLeaseId: leaseId,
        expectedOwnerId: task.lease.ownerId,
        actualOwnerId: ownerId
      });
    }
  }

  private derivePresence(
    record: WorkerPresenceRecord,
    now: number
  ): WorkerPresenceRecord {
    if (now <= record.expiresAt) {
      return { ...record, state: PresenceState.Alive };
    }
    if (now <= record.staleAt) {
      return { ...record, state: PresenceState.Stale };
    }
    return { ...record, state: PresenceState.Offline };
  }

  private requireIdempotency(key: string): IdempotencyRecord {
    const record = this.idempotency.get(coordinationKeys.idempotency(key));
    if (record === undefined) {
      throw new LeaseRejectedError(`Idempotency key not started: ${key}`);
    }
    return record;
  }
}

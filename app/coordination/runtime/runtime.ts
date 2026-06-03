import { ScopeType } from "../../shared";
import {
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_RUN_CONTEXT_TTL_MS,
  DEFAULT_TASK_CONTEXT_TTL_MS
} from "../constants";
import { createCoordinationTask } from "../jobs";
import {
  retryLater,
  succeeded,
  type CoordinationJobHandler
} from "../jobs";
import type {
  EnqueueTaskResult,
  FencingPort,
  IdempotencyPort,
  LeasePort,
  LockPort,
  PresencePort,
  QueuePort,
  RuntimeContextPort,
  SingleFlightPort
} from "../ports";
import {
  CoordinationRuntimeScopeAdapter
} from "../context";
import {
  CoordinationOutboxDispatcher,
  coordinationDispatchEventFromOutbox,
  type CoordinationDispatchEvent,
  type CoordinationDispatchResult
} from "../dispatcher";
import { CoordinationTaskType } from "../task-types";
import { CoordinationRecoverySweeper, type RecoverySweepSummary } from "../recovery";
import {
  DlqReason,
  LockScope,
  PriorityLane,
  type CoordinationBacklogSnapshot,
  type CoordinationScopeRef,
  type TaskRuntimeContext,
  type RunRuntimeContext
} from "../types";
import {
  CoordinationHandlerRegistry,
  CoordinationWorker,
  type CoordinationWorkerTickResult
} from "../worker";
import {
  InMemoryCoordinationStore
} from "../fakes";

export interface StartCoordinationRunInput {
  readonly runId: string;
  readonly ownerId: string;
  readonly now: number;
  readonly ttlMs?: number;
  readonly scopes?: readonly CoordinationScopeRef[];
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface EnqueueCoordinationRuntimeTaskInput {
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
  readonly runId?: string;
  readonly parentTaskId?: string;
  readonly taskContextTtlMs?: number;
  readonly taskRuntimeScopes?: readonly CoordinationScopeRef[];
}

export interface InMemoryCoordinationRuntimeOptions {
  readonly workerId?: string;
  readonly store?: InMemoryCoordinationStore;
  readonly queue?: QueuePort;
  readonly leasePort?: LeasePort;
  readonly presencePort?: PresencePort;
  readonly runtimeContextPort?: RuntimeContextPort;
  readonly lockPort?: LockPort;
  readonly fencingPort?: FencingPort;
  readonly singleFlightPort?: SingleFlightPort;
  readonly idempotencyPort?: IdempotencyPort;
  readonly leaseTtlMs?: number;
  readonly registerHandlers?: readonly CoordinationJobHandler[];
  readonly nowProvider?: () => number;
}

function defaultRuntimeScopes(taskId: string): CoordinationScopeRef[] {
  return [{ type: ScopeType.Task, id: taskId }];
}

function buildScopeResourceId(scope: CoordinationScopeRef): string {
  return `${scope.type}:${scope.id}`;
}

function createCacheInvalidationHandler(
  deps: {
    lockPort: LockPort;
    fencingPort: FencingPort;
    lockTtlMs: number;
  }
): CoordinationJobHandler {
  return {
    taskType: CoordinationTaskType.CacheInvalidate,
    async handle(context) {
      const locks = [];
      for (const scope of context.task.scopes) {
        const resourceId = buildScopeResourceId(scope);
        const lock = await deps.lockPort.acquire({
          lockScope: LockScope.Cache,
          resourceId,
          ownerId: context.workerId,
          leaseId: context.lease.leaseId,
          ttlMs: deps.lockTtlMs,
          now: context.now
        });
        if (lock === null) {
          return retryLater(
            1_000,
            `Cache invalidation already in progress for ${resourceId}`,
            "coord_cache_invalidation_busy"
          );
        }

        locks.push(lock);
      }

      try {
        for (const lock of locks) {
          const current = await deps.fencingPort.isCurrentToken({
            lockScope: lock.lockScope,
            resourceId: lock.resourceId,
            fencingToken: lock.fencingToken
          });
          if (!current) {
            return {
              kind: "dlq",
              reason: DlqReason.FencingRejected,
              code: "coord_cache_fencing_rejected",
              message: `Cache invalidation fencing token is stale for ${lock.resourceId}`
            };
          }
        }

        return succeeded({
          taskId: context.task.taskId,
          scopes: context.task.scopes.map((scope) => ({ ...scope })),
          invalidatedAt: context.now
        });
      } finally {
        for (const lock of locks) {
          await deps.lockPort.releaseLock({
            lockScope: lock.lockScope,
            resourceId: lock.resourceId,
            ownerId: context.workerId,
            fencingToken: lock.fencingToken
          });
        }
      }
    }
  };
}

function createProjectionExportHandler(
  deps: {
    lockPort: LockPort;
    fencingPort: FencingPort;
    lockTtlMs: number;
  }
): CoordinationJobHandler {
  return {
    taskType: CoordinationTaskType.ProjectionExport,
    async handle(context) {
      const primaryScope = context.task.scopes[0];
      if (primaryScope === undefined) {
        return succeeded({ taskId: context.task.taskId, skipped: true });
      }

      const resourceId = buildScopeResourceId(primaryScope);
      const lock = await deps.lockPort.acquire({
        lockScope: LockScope.Projection,
        resourceId,
        ownerId: context.workerId,
        leaseId: context.lease.leaseId,
        ttlMs: deps.lockTtlMs,
        now: context.now
      });
      if (lock === null) {
        return retryLater(
          1_000,
          `Projection export already in progress for ${resourceId}`,
          "coord_projection_busy"
        );
      }

      try {
        const current = await deps.fencingPort.isCurrentToken({
          lockScope: lock.lockScope,
          resourceId: lock.resourceId,
          fencingToken: lock.fencingToken
        });
        if (!current) {
          return {
            kind: "dlq",
            reason: DlqReason.FencingRejected,
            code: "coord_projection_fencing_rejected",
            message: `Projection export fencing token is stale for ${resourceId}`
          };
        }

        return succeeded({
          taskId: context.task.taskId,
          exportedScope: { ...primaryScope },
          exportedAt: context.now
        });
      } finally {
        await deps.lockPort.releaseLock({
          lockScope: lock.lockScope,
          resourceId: lock.resourceId,
          ownerId: context.workerId,
          fencingToken: lock.fencingToken
        });
      }
    }
  };
}

export class InMemoryCoordinationRuntime {
  readonly store: InMemoryCoordinationStore;
  readonly handlers: CoordinationHandlerRegistry;
  readonly worker: CoordinationWorker;
  readonly dispatcher: CoordinationOutboxDispatcher;
  readonly recoverySweeper: CoordinationRecoverySweeper;
  readonly runtimeScopeAdapter: CoordinationRuntimeScopeAdapter;

  private readonly queue: QueuePort;
  private readonly runtimeContextPort: RuntimeContextPort;

  constructor(options: InMemoryCoordinationRuntimeOptions = {}) {
    this.store = options.store ?? new InMemoryCoordinationStore();
    this.queue = options.queue ?? this.store;
    const leasePort = options.leasePort ?? this.store;
    const presencePort = options.presencePort ?? this.store;
    this.runtimeContextPort = options.runtimeContextPort ?? this.store;
    const lockPort = options.lockPort ?? this.store;
    const fencingPort = options.fencingPort ?? this.store;
    const singleFlightPort = options.singleFlightPort ?? this.store;
    const idempotencyPort = options.idempotencyPort ?? this.store;

    this.handlers = new CoordinationHandlerRegistry();
    this.handlers.register(
      createCacheInvalidationHandler({
        lockPort,
        fencingPort,
        lockTtlMs: options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
      })
    );
    this.handlers.register(
      createProjectionExportHandler({
        lockPort,
        fencingPort,
        lockTtlMs: options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
      })
    );
    for (const handler of options.registerHandlers ?? []) {
      this.handlers.register(handler);
    }

    this.worker = new CoordinationWorker({
      workerId: options.workerId ?? "worker-main",
      handlers: this.handlers,
      queue: this.queue,
      leasePort,
      presencePort,
      singleFlightPort,
      idempotencyPort,
      leaseTtlMs: options.leaseTtlMs
    });
    this.dispatcher = new CoordinationOutboxDispatcher({
      generationPort: this.store,
      idempotencyPort,
      enqueueTask: (task, now) => this.enqueueTask({
        taskId: task.taskId,
        taskType: task.taskType,
        scopes: task.scopes,
        now,
        priority: task.priority,
        payload: task.payload,
        dedupeKey: task.dedupeKey,
        idempotencyKey: task.idempotencyKey,
        singleFlightKey: task.singleFlightKey,
        metadata: task.metadata
      })
    });
    this.recoverySweeper = new CoordinationRecoverySweeper({
      queue: this.queue,
      presencePort,
      runtimeContextPort: this.runtimeContextPort,
      singleFlightPort
    });
    this.runtimeScopeAdapter = new CoordinationRuntimeScopeAdapter(
      this.runtimeContextPort,
      options.nowProvider
    );
  }

  async startRun(input: StartCoordinationRunInput): Promise<RunRuntimeContext> {
    return this.runtimeContextPort.putRunContext({
      runId: input.runId,
      ownerId: input.ownerId,
      scopes:
        input.scopes === undefined || input.scopes.length === 0
          ? [{ type: ScopeType.Run, id: input.runId }]
          : input.scopes,
      startedAt: input.now,
      expiresAt: input.now + (input.ttlMs ?? DEFAULT_RUN_CONTEXT_TTL_MS),
      metadata: input.metadata
    });
  }

  async enqueueTask(
    input: EnqueueCoordinationRuntimeTaskInput
  ): Promise<EnqueueTaskResult> {
    const result = await this.queue.enqueue({
      task: createCoordinationTask({
        taskId: input.taskId,
        taskType: input.taskType,
        scopes: input.scopes,
        now: input.now,
        priority: input.priority,
        visibleAt: input.visibleAt,
        maxAttempts: input.maxAttempts,
        payload: input.payload,
        payloadRef: input.payloadRef,
        dedupeKey: input.dedupeKey,
        idempotencyKey: input.idempotencyKey,
        singleFlightKey: input.singleFlightKey,
        metadata: input.metadata
      }),
      now: input.now
    });

    if (result.accepted) {
      const context: TaskRuntimeContext = {
        taskId: input.taskId,
        parentRunId: input.runId ?? input.taskId,
        parentTaskId: input.parentTaskId,
        scopes:
          input.taskRuntimeScopes === undefined || input.taskRuntimeScopes.length === 0
            ? defaultRuntimeScopes(input.taskId)
            : [...input.taskRuntimeScopes],
        createdAt: input.now,
        expiresAt: input.now + (input.taskContextTtlMs ?? DEFAULT_TASK_CONTEXT_TTL_MS),
        metadata: input.metadata
      };
      await this.runtimeContextPort.putTaskContext(context);
    }

    return result;
  }

  async dispatch(event: CoordinationDispatchEvent, now: number): Promise<CoordinationDispatchResult> {
    return this.dispatcher.dispatch(event, now);
  }

  async dispatchOutboxRow(row: Parameters<typeof coordinationDispatchEventFromOutbox>[0], now: number): Promise<CoordinationDispatchResult> {
    return this.dispatch(coordinationDispatchEventFromOutbox(row), now);
  }

  async drainOnce(now: number): Promise<CoordinationWorkerTickResult> {
    return this.worker.drainOnce(now);
  }

  async sweep(now: number): Promise<RecoverySweepSummary> {
    return this.recoverySweeper.sweep(now);
  }

  async getBacklogSnapshot(now: number): Promise<CoordinationBacklogSnapshot> {
    return this.queue.getBacklogSnapshot(now);
  }
}

export function createInMemoryCoordinationRuntime(
  options: InMemoryCoordinationRuntimeOptions = {}
): InMemoryCoordinationRuntime {
  return new InMemoryCoordinationRuntime(options);
}

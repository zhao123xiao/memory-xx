import { randomUUID } from "node:crypto";

import type {
  GovernanceActionStatus,
  GovernancePolicyOverrideRow,
  GovernanceRunStatus,
  MemoryGovernanceActionRow,
  MemoryGovernanceFreezeRow,
  MemoryGovernanceRunRow,
} from "../schema/tables";
import {
  type WriteTransactionContext,
  isInMemoryTransactionContext
} from "../tx/write-transaction";
import {
  mapGovernancePolicyOverrideRow,
  mapMemoryGovernanceActionRow,
  mapMemoryGovernanceFreezeRow,
  mapMemoryGovernanceRunRow
} from "./support-row-mappers";
import type { JsonObject, ScopeType } from "../../shared/types";

export interface CreateGovernanceRunInput {
  readonly jobType: string;
  readonly mode: string;
  readonly policy?: string | null;
  readonly status?: GovernanceRunStatus;
  readonly metrics?: JsonObject;
  readonly error?: string | null;
  readonly leaseAcquiredBy?: string;
  readonly leaseTtlSeconds?: number;
}

export interface RecordGovernanceActionInput {
  readonly runId?: string | null;
  readonly actionType: string;
  readonly scopeType?: ScopeType | string | null;
  readonly scopeId?: string | null;
  readonly memoryId?: string | null;
  readonly relatedMemoryId?: string | null;
  readonly selector?: JsonObject;
  readonly evidence?: JsonObject;
  readonly beforeState?: JsonObject;
  readonly afterState?: JsonObject;
  readonly outboxEventIds?: readonly string[];
  readonly revertTokenHash?: string | null;
  readonly revertExpiresAt?: string | null;
  readonly status?: GovernanceActionStatus;
  readonly createdBy?: string;
}

export interface CreateFreezeInput {
  readonly scopeType: ScopeType | string;
  readonly scopeId: string;
  readonly actions: readonly string[];
  readonly reason: string;
  readonly actorId: string;
  readonly expiresAt: string;
}

export interface UpsertPolicyOverrideInput {
  readonly selectorHash: string;
  readonly selector: JsonObject;
  readonly policyType: string;
  readonly threshold?: number | null;
  readonly defaultThreshold?: number | null;
  readonly autoApproveEnabled?: boolean | null;
  readonly cleanRunCount?: number;
  readonly lastCohortAt?: string | null;
  readonly expiresAt: string;
  readonly metadata?: JsonObject;
}

function governanceRows<T extends keyof import("../schema/tables").WriteDatabaseState>(
  tx: WriteTransactionContext,
  key: T
): NonNullable<import("../schema/tables").WriteDatabaseState[T]> {
  if (!isInMemoryTransactionContext(tx)) {
    throw new Error("governanceRows is only available for in-memory transactions.");
  }
  const mutable = tx.state as unknown as Record<string, unknown>;
  mutable[key as string] ??= [];
  return mutable[key as string] as NonNullable<import("../schema/tables").WriteDatabaseState[T]>;
}

const DEFAULT_GOVERNANCE_LEASE_TTL_SECONDS = 10 * 60;

function defaultLeaseAcquiredBy(): string {
  return `pid:${process.pid}`;
}

function addSecondsIso(timestamp: string, seconds: number): string {
  return new Date(Date.parse(timestamp) + seconds * 1000).toISOString();
}

export class GovernanceRepository {
  async tryBeginRun(tx: WriteTransactionContext, input: CreateGovernanceRunInput): Promise<MemoryGovernanceRunRow> {
    const now = tx.now();
    const lockKey = `memory_xx_governance:${input.jobType}`;
    const requestedStatus = input.status ?? "running";
    const leaseTtlSeconds = input.leaseTtlSeconds ?? DEFAULT_GOVERNANCE_LEASE_TTL_SECONDS;
    const leaseAcquiredBy = input.leaseAcquiredBy ?? defaultLeaseAcquiredBy();
    if (isInMemoryTransactionContext(tx)) {
      const rows = governanceRows(tx, "memoryGovernanceRuns");
      if (requestedStatus === "running") {
        const activeLease = rows.find((row) =>
          row.jobType === input.jobType &&
          row.leaseAcquiredBy !== null &&
          (row.leaseExpiresAt === null || row.leaseExpiresAt > now)
        );
        if (activeLease) {
          const skipped: MemoryGovernanceRunRow = {
            id: randomUUID(),
            jobType: input.jobType,
            mode: input.mode,
            policy: input.policy ?? null,
            status: "skipped_lock_held",
            lockKey,
            leaseExpiresAt: null,
            heartbeatAt: null,
            leaseAcquiredBy: null,
            startedAt: now,
            finishedAt: now,
            metrics: input.metrics ?? {},
            error: "governance lock already held",
            createdAt: now,
            updatedAt: now,
          };
          rows.push(skipped);
          return skipped;
        }
      }
      const row: MemoryGovernanceRunRow = {
        id: randomUUID(),
        jobType: input.jobType,
        mode: input.mode,
        policy: input.policy ?? null,
        status: requestedStatus,
        lockKey,
        leaseExpiresAt: requestedStatus === "running" ? addSecondsIso(now, leaseTtlSeconds) : null,
        heartbeatAt: requestedStatus === "running" ? now : null,
        leaseAcquiredBy: requestedStatus === "running" ? leaseAcquiredBy : null,
        startedAt: now,
        finishedAt: requestedStatus !== "running" ? now : null,
        metrics: input.metrics ?? {},
        error: input.error ?? null,
        createdAt: now,
        updatedAt: now,
      };
      rows.push(row);
      return row;
    }

    if (requestedStatus !== "running") {
      const [row] = await tx.query(
        `
          INSERT INTO memory_governance_runs (
            id, job_type, mode, policy, status, lock_key, started_at, finished_at,
            metrics, error, lease_acquired_by, lease_expires_at, heartbeat_at,
            created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(),
            $7::jsonb, $8, NULL, NULL, NULL, NOW(), NOW())
          RETURNING *
        `,
        [
          randomUUID(),
          input.jobType,
          input.mode,
          input.policy ?? null,
          requestedStatus,
          lockKey,
          JSON.stringify(input.metrics ?? {}),
          input.error ?? null,
        ]
      );
      return mapMemoryGovernanceRunRow(row);
    }

    const [row] = await tx.query(
      `
        INSERT INTO memory_governance_runs (
          id, job_type, mode, policy, status, lock_key, started_at, finished_at,
          metrics, error, lease_acquired_by, lease_expires_at, heartbeat_at,
          created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, 'running', $5, NOW(), NULL,
          $6::jsonb, NULL, $7, NOW() + ($8::int * interval '1 second'), NOW(),
          NOW(), NOW())
        ON CONFLICT (job_type) WHERE lease_acquired_by IS NOT NULL
        DO UPDATE SET
          mode = EXCLUDED.mode,
          policy = EXCLUDED.policy,
          status = 'running',
          started_at = NOW(),
          finished_at = NULL,
          metrics = EXCLUDED.metrics,
          error = NULL,
          lease_acquired_by = EXCLUDED.lease_acquired_by,
          lease_expires_at = NOW() + ($8::int * interval '1 second'),
          heartbeat_at = NOW(),
          updated_at = NOW()
        WHERE memory_governance_runs.lease_acquired_by IS NULL
           OR memory_governance_runs.lease_expires_at < NOW()
        RETURNING *
      `,
      [
        randomUUID(),
        input.jobType,
        input.mode,
        input.policy ?? null,
        lockKey,
        JSON.stringify(input.metrics ?? {}),
        leaseAcquiredBy,
        leaseTtlSeconds,
      ]
    );
    if (row) return mapMemoryGovernanceRunRow(row);

    const [skipped] = await tx.query(
      `
        INSERT INTO memory_governance_runs (
          id, job_type, mode, policy, status, lock_key, started_at, finished_at,
          metrics, error, lease_acquired_by, lease_expires_at, heartbeat_at,
          created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, 'skipped_lock_held', $5, NOW(), NOW(),
          $6::jsonb, 'governance lock already held', NULL, NULL, NULL, NOW(), NOW())
        RETURNING *
      `,
      [
        randomUUID(),
        input.jobType,
        input.mode,
        input.policy ?? null,
        lockKey,
        JSON.stringify(input.metrics ?? {}),
      ]
    );
    return mapMemoryGovernanceRunRow(skipped);
  }

  async finishRun(
    tx: WriteTransactionContext,
    runId: string,
    status: Exclude<GovernanceRunStatus, "running">,
    metrics: JsonObject = {},
    error: string | null = null
  ): Promise<MemoryGovernanceRunRow> {
    const now = tx.now();
    if (isInMemoryTransactionContext(tx)) {
      const rows = governanceRows(tx, "memoryGovernanceRuns");
      const index = rows.findIndex((row) => row.id === runId);
      if (index < 0) throw new Error(`governance_run_not_found:${runId}`);
      const row = {
        ...rows[index],
        status,
        metrics,
        error,
        finishedAt: now,
        leaseAcquiredBy: null,
        leaseExpiresAt: null,
        updatedAt: now
      };
      rows[index] = row;
      return row;
    }
    const [row] = await tx.query(
      `
        UPDATE memory_governance_runs
        SET status = $2, metrics = $3::jsonb, error = $4,
            finished_at = $5::timestamptz,
            lease_acquired_by = NULL,
            lease_expires_at = NULL,
            updated_at = $5::timestamptz
        WHERE id = $1
        RETURNING *
      `,
      [runId, status, JSON.stringify(metrics), error, now]
    );
    if (!row) throw new Error(`governance_run_not_found:${runId}`);
    return mapMemoryGovernanceRunRow(row);
  }

  async heartbeatRunLease(
    tx: WriteTransactionContext,
    runId: string,
    leaseAcquiredBy: string,
    leaseTtlSeconds = DEFAULT_GOVERNANCE_LEASE_TTL_SECONDS
  ): Promise<boolean> {
    const now = tx.now();
    if (isInMemoryTransactionContext(tx)) {
      const rows = governanceRows(tx, "memoryGovernanceRuns");
      const index = rows.findIndex((row) =>
        row.id === runId &&
        row.status === "running" &&
        row.leaseAcquiredBy === leaseAcquiredBy
      );
      if (index < 0) return false;
      rows[index] = {
        ...rows[index],
        heartbeatAt: now,
        leaseExpiresAt: addSecondsIso(now, leaseTtlSeconds),
        updatedAt: now
      };
      return true;
    }

    const rows = await tx.query<{ id: string }>(
      `
        UPDATE memory_governance_runs
        SET heartbeat_at = NOW(),
            lease_expires_at = NOW() + ($3::int * interval '1 second'),
            updated_at = NOW()
        WHERE id = $1
          AND lease_acquired_by = $2
          AND status = 'running'
        RETURNING id
      `,
      [runId, leaseAcquiredBy, leaseTtlSeconds]
    );
    return rows.length > 0;
  }

  async releaseRunLease(
    tx: WriteTransactionContext,
    runId: string,
    leaseAcquiredBy: string
  ): Promise<boolean> {
    const now = tx.now();
    if (isInMemoryTransactionContext(tx)) {
      const rows = governanceRows(tx, "memoryGovernanceRuns");
      const index = rows.findIndex((row) => row.id === runId && row.leaseAcquiredBy === leaseAcquiredBy);
      if (index < 0) return false;
      rows[index] = {
        ...rows[index],
        leaseAcquiredBy: null,
        leaseExpiresAt: null,
        updatedAt: now
      };
      return true;
    }

    const rows = await tx.query<{ id: string }>(
      `
        UPDATE memory_governance_runs
        SET lease_acquired_by = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $1
          AND lease_acquired_by = $2
        RETURNING id
      `,
      [runId, leaseAcquiredBy]
    );
    return rows.length > 0;
  }

  async recordAction(tx: WriteTransactionContext, input: RecordGovernanceActionInput): Promise<MemoryGovernanceActionRow> {
    const now = tx.now();
    if (isInMemoryTransactionContext(tx)) {
      const row: MemoryGovernanceActionRow = {
        id: randomUUID(),
        runId: input.runId ?? null,
        actionType: input.actionType,
        scopeType: (input.scopeType ?? null) as MemoryGovernanceActionRow["scopeType"],
        scopeId: input.scopeId ?? null,
        memoryId: input.memoryId ?? null,
        relatedMemoryId: input.relatedMemoryId ?? null,
        selector: input.selector ?? {},
        evidence: input.evidence ?? {},
        beforeState: input.beforeState ?? {},
        afterState: input.afterState ?? {},
        outboxEventIds: input.outboxEventIds ? [...input.outboxEventIds] : [],
        revertTokenHash: input.revertTokenHash ?? null,
        revertExpiresAt: input.revertExpiresAt ?? null,
        revertedAt: null,
        status: input.status ?? "reported",
        createdBy: input.createdBy ?? "memory-governance",
        createdAt: now,
      };
      governanceRows(tx, "memoryGovernanceActions").push(row);
      return row;
    }
    const [row] = await tx.query(
      `
        INSERT INTO memory_governance_actions (
          id, run_id, action_type, scope_type, scope_id, memory_id, related_memory_id,
          selector, evidence, before_state, after_state, outbox_event_ids,
          revert_token_hash, revert_expires_at, status, created_by, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb,
          $12::jsonb, $13, $14::timestamptz, $15, $16, $17::timestamptz)
        RETURNING *
      `,
      [
        randomUUID(),
        input.runId ?? null,
        input.actionType,
        input.scopeType ?? null,
        input.scopeId ?? null,
        input.memoryId ?? null,
        input.relatedMemoryId ?? null,
        JSON.stringify(input.selector ?? {}),
        JSON.stringify(input.evidence ?? {}),
        JSON.stringify(input.beforeState ?? {}),
        JSON.stringify(input.afterState ?? {}),
        JSON.stringify(input.outboxEventIds ?? []),
        input.revertTokenHash ?? null,
        input.revertExpiresAt ?? null,
        input.status ?? "reported",
        input.createdBy ?? "memory-governance",
        now,
      ]
    );
    return mapMemoryGovernanceActionRow(row);
  }

  async createFreeze(tx: WriteTransactionContext, input: CreateFreezeInput): Promise<MemoryGovernanceFreezeRow> {
    const now = tx.now();
    if (isInMemoryTransactionContext(tx)) {
      const row: MemoryGovernanceFreezeRow = {
        id: randomUUID(),
        scopeType: input.scopeType as ScopeType,
        scopeId: input.scopeId,
        actions: [...input.actions],
        reason: input.reason,
        actorId: input.actorId,
        expiresAt: input.expiresAt,
        createdAt: now,
        liftedAt: null,
      };
      governanceRows(tx, "memoryGovernanceFreezes").push(row);
      return row;
    }
    const [row] = await tx.query(
      `
        INSERT INTO memory_governance_freezes (
          id, scope_type, scope_id, actions, reason, actor_id, expires_at, created_at, lifted_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, NULL)
        RETURNING *
      `,
      [randomUUID(), input.scopeType, input.scopeId, [...input.actions], input.reason, input.actorId, input.expiresAt, now]
    );
    return mapMemoryGovernanceFreezeRow(row);
  }

  async isScopeFrozen(
    tx: WriteTransactionContext,
    scopeType: ScopeType | string,
    scopeId: string,
    action: string,
    atIso = tx.now()
  ): Promise<boolean> {
    if (isInMemoryTransactionContext(tx)) {
      return governanceRows(tx, "memoryGovernanceFreezes").some((row) =>
        row.scopeType === scopeType &&
        row.scopeId === scopeId &&
        row.liftedAt === null &&
        row.expiresAt > atIso &&
        (row.actions.length === 0 || row.actions.includes(action) || row.actions.includes("*"))
      );
    }
    const [row] = await tx.query<{ frozen: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM memory_governance_freezes
          WHERE scope_type = $1
            AND scope_id = $2
            AND lifted_at IS NULL
            AND expires_at > $3::timestamptz
            AND (cardinality(actions) = 0 OR $4 = ANY(actions) OR '*' = ANY(actions))
        ) AS frozen
      `,
      [scopeType, scopeId, atIso, action]
    );
    return Boolean(row?.frozen);
  }

  async upsertPolicyOverride(tx: WriteTransactionContext, input: UpsertPolicyOverrideInput): Promise<GovernancePolicyOverrideRow> {
    const now = tx.now();
    if (isInMemoryTransactionContext(tx)) {
      const rows = governanceRows(tx, "governancePolicyOverrides");
      const existingIndex = rows.findIndex((row) => row.selectorHash === input.selectorHash);
      const base: GovernancePolicyOverrideRow = {
        id: existingIndex >= 0 ? rows[existingIndex].id : randomUUID(),
        selectorHash: input.selectorHash,
        selector: input.selector,
        policyType: input.policyType,
        threshold: input.threshold ?? null,
        defaultThreshold: input.defaultThreshold ?? null,
        autoApproveEnabled: input.autoApproveEnabled ?? null,
        cleanRunCount: input.cleanRunCount ?? (existingIndex >= 0 ? rows[existingIndex].cleanRunCount : 0),
        lastCohortAt: input.lastCohortAt ?? (existingIndex >= 0 ? rows[existingIndex].lastCohortAt : null),
        expiresAt: input.expiresAt,
        reviewedAt: existingIndex >= 0 ? rows[existingIndex].reviewedAt : null,
        metadata: input.metadata ?? {},
        createdAt: existingIndex >= 0 ? rows[existingIndex].createdAt : now,
        updatedAt: now,
      };
      if (existingIndex >= 0) rows[existingIndex] = base;
      else rows.push(base);
      return base;
    }
    const [row] = await tx.query(
      `
        INSERT INTO governance_policy_overrides (
          id, selector_hash, selector, policy_type, threshold, default_threshold,
          auto_approve_enabled, clean_run_count, last_cohort_at, expires_at,
          metadata, created_at, updated_at
        )
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9::timestamptz,
          $10::timestamptz, $11::jsonb, $12::timestamptz, $12::timestamptz)
        ON CONFLICT (selector_hash)
        DO UPDATE SET
          selector = EXCLUDED.selector,
          policy_type = EXCLUDED.policy_type,
          threshold = EXCLUDED.threshold,
          default_threshold = EXCLUDED.default_threshold,
          auto_approve_enabled = EXCLUDED.auto_approve_enabled,
          clean_run_count = EXCLUDED.clean_run_count,
          last_cohort_at = EXCLUDED.last_cohort_at,
          expires_at = EXCLUDED.expires_at,
          metadata = EXCLUDED.metadata,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `,
      [
        randomUUID(),
        input.selectorHash,
        JSON.stringify(input.selector),
        input.policyType,
        input.threshold ?? null,
        input.defaultThreshold ?? null,
        input.autoApproveEnabled ?? null,
        input.cleanRunCount ?? 0,
        input.lastCohortAt ?? null,
        input.expiresAt,
        JSON.stringify(input.metadata ?? {}),
        now,
      ]
    );
    return mapGovernancePolicyOverrideRow(row);
  }

  async findActivePolicyOverride(
    tx: WriteTransactionContext,
    selectorHash: string,
    policyType: string,
    atIso = tx.now()
  ): Promise<GovernancePolicyOverrideRow | null> {
    if (isInMemoryTransactionContext(tx)) {
      return governanceRows(tx, "governancePolicyOverrides").find((row) =>
        row.selectorHash === selectorHash &&
        row.policyType === policyType &&
        row.expiresAt > atIso
      ) ?? null;
    }
    const rows = await tx.query(
      `
        SELECT *
        FROM governance_policy_overrides
        WHERE selector_hash = $1
          AND policy_type = $2
          AND expires_at > $3::timestamptz
        LIMIT 1
      `,
      [selectorHash, policyType, atIso]
    );
    return rows[0] ? mapGovernancePolicyOverrideRow(rows[0]) : null;
  }

  async recordRunAlertIfNeeded(
    tx: WriteTransactionContext,
    input: { readonly jobType: string; readonly scheduleIntervalMs: number; readonly now?: string; readonly runId?: string | null }
  ): Promise<MemoryGovernanceActionRow | null> {
    const now = input.now ?? tx.now();
    if (isInMemoryTransactionContext(tx)) {
      const runs = [...governanceRows(tx, "memoryGovernanceRuns")]
        .filter((row) => row.jobType === input.jobType)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
      const recentBad = runs.slice(0, 3).length === 3 && runs.slice(0, 3).every((row) =>
        row.status === "failed" || row.status === "skipped_lock_held"
      );
      const lastSuccess = runs.find((row) => row.status === "success");
      const stale = !lastSuccess || Date.parse(now) - Date.parse(lastSuccess.finishedAt ?? lastSuccess.startedAt) > 2 * input.scheduleIntervalMs;
      if (!recentBad && !stale) return null;
      return this.recordAction(tx, {
        runId: input.runId ?? null,
        actionType: "governance_run_alert",
        selector: { job_type: input.jobType },
        evidence: { recent_bad: recentBad, stale_success: stale, schedule_interval_ms: input.scheduleIntervalMs, now },
        status: "reported",
      });
    }

    const rows = await tx.query<{
      id: string;
      status: GovernanceRunStatus;
      started_at: Date | string;
      finished_at: Date | string | null;
    }>(
      `
        SELECT id, status, started_at, finished_at
        FROM memory_governance_runs
        WHERE job_type = $1
        ORDER BY started_at DESC
        LIMIT 10
      `,
      [input.jobType]
    );
    const recentBad = rows.slice(0, 3).length === 3 && rows.slice(0, 3).every((row) =>
      row.status === "failed" || row.status === "skipped_lock_held"
    );
    const lastSuccess = rows.find((row) => row.status === "success");
    const lastSuccessAt = lastSuccess?.finished_at ?? lastSuccess?.started_at ?? null;
    const stale = !lastSuccessAt || Date.parse(now) - Date.parse(String(lastSuccessAt)) > 2 * input.scheduleIntervalMs;
    if (!recentBad && !stale) return null;
    return this.recordAction(tx, {
      runId: input.runId ?? null,
      actionType: "governance_run_alert",
      selector: { job_type: input.jobType },
      evidence: { recent_bad: recentBad, stale_success: stale, schedule_interval_ms: input.scheduleIntervalMs, now },
      status: "reported",
    });
  }
}

export type GovernanceExecutionMode = "dry_run" | "apply";
export type GovernanceRiskLevel = "safe" | "guarded" | "high_risk";

export interface GovernanceExecutionRequest<TPlan, TResult> {
  readonly actionType: string;
  readonly mode: GovernanceExecutionMode;
  readonly risk: GovernanceRiskLevel;
  readonly actorId: string;
  readonly idempotencyKey?: string;
  readonly plan: TPlan;
  readonly permissions?: {
    readonly canApply: boolean;
    readonly blockedReason?: string;
  };
  readonly lease?: {
    readonly acquire: () => Promise<boolean>;
    readonly release?: () => Promise<void>;
  };
  readonly apply: (plan: TPlan) => Promise<TResult>;
  readonly audit: (event: GovernanceExecutionAudit<TPlan, TResult>) => Promise<void>;
}

export interface GovernanceExecutionAudit<TPlan, TResult> {
  readonly action_type: string;
  readonly mode: GovernanceExecutionMode;
  readonly risk: GovernanceRiskLevel;
  readonly actor_id: string;
  readonly idempotency_key?: string;
  readonly status: "planned" | "applied" | "blocked" | "failed";
  readonly plan: TPlan;
  readonly result?: TResult;
  readonly blocked_reason?: string;
  readonly error?: string;
  readonly recorded_at: string;
}

export interface GovernanceExecutionResult<TResult> {
  readonly ok: boolean;
  readonly mode: GovernanceExecutionMode;
  readonly status: "planned" | "applied" | "blocked" | "failed";
  readonly can_apply: boolean;
  readonly blocked_reason?: string;
  readonly result?: TResult;
}

export async function executeGovernanceAction<TPlan, TResult>(
  request: GovernanceExecutionRequest<TPlan, TResult>
): Promise<GovernanceExecutionResult<TResult>> {
  const canApply = request.mode === "apply" && request.permissions?.canApply !== false;
  const permissionBlockedReason = request.permissions?.canApply === false
    ? request.permissions.blockedReason ?? "permission_denied"
    : undefined;

  if (request.mode === "dry_run") {
    await request.audit(buildAudit(request, { status: "planned" }));
    return { ok: true, mode: request.mode, status: "planned", can_apply: request.permissions?.canApply !== false };
  }

  if (permissionBlockedReason) {
    await request.audit(buildAudit(request, { status: "blocked", blocked_reason: permissionBlockedReason }));
    return { ok: false, mode: request.mode, status: "blocked", can_apply: false, blocked_reason: permissionBlockedReason };
  }

  const leaseAcquired = request.lease ? await request.lease.acquire() : true;
  if (!leaseAcquired) {
    const blockedReason = "lease_not_acquired";
    await request.audit(buildAudit(request, { status: "blocked", blocked_reason: blockedReason }));
    return { ok: false, mode: request.mode, status: "blocked", can_apply: false, blocked_reason: blockedReason };
  }

  try {
    const result = await request.apply(request.plan);
    await request.audit(buildAudit(request, { status: "applied", result }));
    return { ok: true, mode: request.mode, status: "applied", can_apply: canApply, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await request.audit(buildAudit(request, { status: "failed", error: message }));
    return { ok: false, mode: request.mode, status: "failed", can_apply: canApply, blocked_reason: message };
  } finally {
    await request.lease?.release?.();
  }
}

function buildAudit<TPlan, TResult>(
  request: GovernanceExecutionRequest<TPlan, TResult>,
  event: Pick<GovernanceExecutionAudit<TPlan, TResult>, "status" | "result" | "blocked_reason" | "error">
): GovernanceExecutionAudit<TPlan, TResult> {
  return {
    action_type: request.actionType,
    mode: request.mode,
    risk: request.risk,
    actor_id: request.actorId,
    idempotency_key: request.idempotencyKey,
    status: event.status,
    plan: request.plan,
    result: event.result,
    blocked_reason: event.blocked_reason,
    error: event.error,
    recorded_at: new Date().toISOString(),
  };
}

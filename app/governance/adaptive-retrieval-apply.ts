import { GovernanceRepository } from "../db/repositories/governance-repository";
import {
  withWriteTransaction,
  type WriteTransactionRunner,
} from "../db/tx/write-transaction";
import type { JsonObject } from "../shared";
import { stableGovernanceSelectorHash } from "./service";
import type { AdaptiveRetrievalApplyPlan } from "./adaptive-retrieval-calibration";

export const ADAPTIVE_RETRIEVAL_POLICY_TYPE = "adaptive_retrieval_confidence_gate";

export interface ExecuteAdaptiveRetrievalThresholdPlanInput {
  readonly plan: AdaptiveRetrievalApplyPlan;
  readonly actorId: string;
  readonly runId?: string | null;
  readonly defaultThreshold?: number;
  readonly ttlDays?: number;
}

export interface ExecuteAdaptiveRetrievalThresholdPlanResult {
  readonly ok: boolean;
  readonly status: "applied" | "blocked";
  readonly scope_key: string;
  readonly query_type: string;
  readonly threshold?: number;
  readonly default_threshold?: number;
  readonly override_id?: string;
  readonly blocked_reason?: string;
}

export function adaptiveRetrievalSelector(plan: AdaptiveRetrievalApplyPlan): JsonObject {
  return {
    policy_type: ADAPTIVE_RETRIEVAL_POLICY_TYPE,
    scope_key: plan.scope_key,
    query_type: plan.query_type,
  };
}

export function stableAdaptiveRetrievalSelectorHash(plan: AdaptiveRetrievalApplyPlan): string {
  return stableGovernanceSelectorHash(adaptiveRetrievalSelector(plan));
}

export async function executeAdaptiveRetrievalThresholdPlan(
  database: WriteTransactionRunner,
  input: ExecuteAdaptiveRetrievalThresholdPlanInput,
): Promise<ExecuteAdaptiveRetrievalThresholdPlanResult> {
  return withWriteTransaction(database, async (tx) => {
    const governance = new GovernanceRepository();
    const blockedReason = validatePlan(input.plan);
    if (blockedReason) {
      const result = blockedResult(input.plan, blockedReason);
      await governance.recordAction(tx, governanceActionInput(input, result, null));
      return result;
    }

    const defaultThreshold = clampThreshold(input.defaultThreshold ?? 0.2);
    const maxDelta = Math.min(Math.max(input.plan.max_delta, 0), 0.05);
    const threshold = clampThreshold(
      input.plan.delta === "loosen"
        ? defaultThreshold - maxDelta
        : defaultThreshold + maxDelta
    );
    const expiresAt = addDaysIso(tx.now(), input.ttlDays ?? 14);
    const selector = adaptiveRetrievalSelector(input.plan);
    const override = await governance.upsertPolicyOverride(tx, {
      selectorHash: stableGovernanceSelectorHash(selector),
      selector,
      policyType: ADAPTIVE_RETRIEVAL_POLICY_TYPE,
      threshold,
      defaultThreshold,
      autoApproveEnabled: null,
      cleanRunCount: 0,
      lastCohortAt: tx.now(),
      expiresAt,
      metadata: {
        source: "adaptive_retrieval_calibration",
        delta: input.plan.delta,
        max_delta: maxDelta,
        actor_id: input.actorId,
        run_id: input.runId ?? null,
      },
    });

    const result: ExecuteAdaptiveRetrievalThresholdPlanResult = {
      ok: true,
      status: "applied",
      scope_key: input.plan.scope_key,
      query_type: input.plan.query_type,
      threshold,
      default_threshold: defaultThreshold,
      override_id: override.id,
    };
    await governance.recordAction(tx, governanceActionInput(input, result, override as unknown as JsonObject));
    return result;
  });
}

function validatePlan(plan: AdaptiveRetrievalApplyPlan): string | null {
  if (plan.kind !== "adaptive_retrieval_threshold_delta") return "invalid_plan_kind";
  if (plan.scope_key.startsWith("memory:")) return "explicit_memory_lookup_not_adaptive";
  if (!plan.scope_key.trim()) return "missing_scope_key";
  if (!plan.query_type.trim()) return "missing_query_type";
  if (plan.delta !== "loosen" && plan.delta !== "tighten") return "invalid_delta";
  if (!Number.isFinite(plan.max_delta) || plan.max_delta <= 0) return "invalid_max_delta";
  return null;
}

function blockedResult(plan: AdaptiveRetrievalApplyPlan, blockedReason: string): ExecuteAdaptiveRetrievalThresholdPlanResult {
  return {
    ok: false,
    status: "blocked",
    scope_key: plan.scope_key,
    query_type: plan.query_type,
    blocked_reason: blockedReason,
  };
}

function governanceActionInput(
  input: ExecuteAdaptiveRetrievalThresholdPlanInput,
  result: ExecuteAdaptiveRetrievalThresholdPlanResult,
  afterState: JsonObject | null,
) {
  return {
    runId: input.runId ?? null,
    actionType: "adaptive_retrieval_threshold_delta",
    selector: adaptiveRetrievalSelector(input.plan),
    evidence: {
      plan: input.plan as unknown as JsonObject,
      blocked_reason: result.blocked_reason ?? null,
    },
    afterState: afterState ?? {},
    status: result.status === "applied" ? "applied" : "reported",
    createdBy: input.actorId,
  } as const;
}

function clampThreshold(value: number): number {
  return Math.round(Math.max(0.01, Math.min(0.99, value)) * 10_000) / 10_000;
}

function addDaysIso(timestamp: string, days: number): string {
  return new Date(Date.parse(timestamp) + Math.max(1, days) * 24 * 60 * 60 * 1000).toISOString();
}

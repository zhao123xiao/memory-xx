import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../../app/db/adapters/postgres-config.js";
import { quoteIdent } from "../lib/runtime-env.js";

export interface ApprovalLimitAdvice {
  readonly generated_at: string;
  readonly profiles: readonly Record<string, unknown>[];
  readonly note: string;
}

const PROFILE_BOUNDS = {
  project: { current: 20, min: 20, max: 40, targetDrainHours: 6 },
  workspace: { current: 10, min: 10, max: 20, targetDrainHours: 8 },
  user: { current: 5, min: 5, max: 10, targetDrainHours: 12 },
  global: { current: 1, min: 1, max: 1, targetDrainHours: 24 },
} as const;

const INELIGIBLE_REASONS = new Set([
  "sensitive_content_detected",
  "pii_requires_human_review",
  "question_only",
  "low_value_or_temporary_content",
  "temporary_temporal_validity",
  "semantic_duplicate",
  "semantic_conflict",
  "conflict_action_not_create",
  "memory_type_not_allowed",
  "scope_not_enabled",
  "global_scope_default_manual",
  "scope_dry_run_only",
]);

function scopeProfile(scopeType: string): keyof typeof PROFILE_BOUNDS | null {
  if (scopeType === "project") return "project";
  if (scopeType === "workspace") return "workspace";
  if (scopeType === "user") return "user";
  if (scopeType === "global") return "global";
  return null;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index] ?? 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function readReasons(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export async function buildApprovalCapacityAdvice(): Promise<ApprovalLimitAdvice> {
  const pgConfig = loadMemoryXXPostgresConfig(process.env);
  const schema = quoteIdent(pgConfig.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  try {
    const decisions = await pool.query<{
      scope_type: string;
      scope_id: string;
      decision: string;
      created_at: string;
      metadata: Record<string, unknown> | null;
    }>(
      `
        SELECT scope_type, scope_id, decision, created_at, metadata
        FROM ${schema}.auto_approval_decisions
        WHERE created_at >= now() - interval '7 days'
      `
    );
    const pending = await pool.query<{
      scope_type: string;
      scope_id: string;
      metadata: Record<string, unknown> | null;
      memory_type: string | null;
    }>(
      `
        SELECT scope_type, scope_id, metadata, memory_type
        FROM ${schema}.memory_records
        WHERE lifecycle_status = 'candidate'
          AND review_state = 'pending'
          AND is_current = true
      `
    );
    const feedback = await pool.query<{
      scope_type: string;
      scope_id: string;
      negative: string;
      total: string;
    }>(
      `
        SELECT r.scope_type, r.scope_id,
          count(*) FILTER (WHERE f.feedback_type IN ('wrong','deleted','not_relevant','changed_mind','negative'))::text AS negative,
          count(*)::text AS total
        FROM ${schema}.memory_feedback_events f
        JOIN ${schema}.memory_records r ON r.id = f.memory_id
        WHERE f.created_at >= now() - interval '7 days'
        GROUP BY 1,2
      `
    );
    const freezes = await pool.query<{ scope_type: string | null; scope_id: string | null; count: string }>(
      `
        SELECT selector->>'scope_type' AS scope_type, selector->>'scope_id' AS scope_id, count(*)::text AS count
        FROM ${schema}.governance_policy_overrides
        WHERE auto_approve_enabled = false
          AND expires_at > now()
        GROUP BY 1,2
      `
    );

    const rows = Object.entries(PROFILE_BOUNDS).map(([profile, bounds]) => {
      const profileDecisions = decisions.rows.filter((row) => scopeProfile(row.scope_type) === profile);
      const approvalsByHour = new Map<string, number>();
      for (const row of profileDecisions) {
        if (row.decision !== "approve") continue;
        const hour = new Date(row.created_at).toISOString().slice(0, 13);
        approvalsByHour.set(hour, (approvalsByHour.get(hour) ?? 0) + 1);
      }
      const pendingRows = pending.rows.filter((row) => scopeProfile(row.scope_type) === profile);
      const eligiblePending = pendingRows.filter((row) => {
        const reasons = readReasons(row.metadata?.blocked_reasons ?? row.metadata?.auto_approval_blocked_reasons);
        return reasons.length === 0 || reasons.every((reason) => !INELIGIBLE_REASONS.has(reason));
      }).length;
      const p95HourlyApproved = percentile([...approvalsByHour.values()], 0.95);
      const drainNeed = eligiblePending / bounds.targetDrainHours;
      const raw = Math.ceil(Math.max(p95HourlyApproved, drainNeed) * 1.25);
      const recommended = profile === "global" ? 1 : clamp(raw || bounds.min, bounds.min, bounds.max);
      const feedbackRows = feedback.rows.filter((row) => scopeProfile(row.scope_type) === profile);
      const negative = feedbackRows.reduce((sum, row) => sum + Number(row.negative ?? 0), 0);
      const totalFeedback = feedbackRows.reduce((sum, row) => sum + Number(row.total ?? 0), 0);
      const freezeCount = freezes.rows.filter((row) => scopeProfile(row.scope_type ?? "") === profile)
        .reduce((sum, row) => sum + Number(row.count ?? 0), 0);
      const reason = profile === "global"
        ? "global 默认人工审批，不建议提高。"
        : recommended > bounds.current
          ? "eligible pending 或真实小时峰值显示可提高。"
          : "当前上限足够，暂不建议提高。";
      return {
        profile,
        current_limit: bounds.current,
        recommended_limit: recommended,
        min: bounds.min,
        max: bounds.max,
        target_drain_hours: bounds.targetDrainHours,
        p95_hourly_approved: p95HourlyApproved,
        pending_total: pendingRows.length,
        eligible_pending: eligiblePending,
        negative_feedback_count: negative,
        feedback_total: totalFeedback,
        negative_feedback_rate: totalFeedback > 0 ? Math.round((negative / totalFeedback) * 10000) / 10000 : 0,
        frozen_cohorts: freezeCount,
        reason,
        apply_mode: "manual_runtime_json_only",
      };
    });
    return {
      generated_at: new Date().toISOString(),
      profiles: rows,
      note: "建议值只用于控制面板和报告，不会自动修改 runtime JSON。",
    };
  } finally {
    await pool.end();
  }
}

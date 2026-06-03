import type { MemoryPolicyAction, MemoryRecallPolicy } from "./memory-policy-engine";
import type { ExtractedMemoryClass } from "../intelligence/types";
import type { AutonomousAction } from "./memory-auto-approval-sweep";

export interface MemoryPolicyDecisionFact {
  readonly decided_at: string;
  readonly memory_class: ExtractedMemoryClass | string | null;
  readonly policy_action: MemoryPolicyAction | string | null;
  readonly recall_policy: MemoryRecallPolicy | string | null;
  readonly autonomous_action?: AutonomousAction | string | null;
  readonly has_policy_fields?: boolean;
  readonly legacy?: boolean;
  readonly source?: string | null;
}

export interface BuildMemoryPolicyReportInput {
  readonly now?: string;
  readonly decisions: readonly MemoryPolicyDecisionFact[];
  readonly compareObservationCount: number;
  readonly latestCompareObservationAt?: string | null;
  readonly compareWindowHours?: number;
}

export interface PolicyWindowSummary {
  readonly total: number;
  readonly policy_coverage_rate: number;
  readonly policy_actions: Record<string, number>;
  readonly memory_classes: Record<string, number>;
  readonly recall_policies: Record<string, number>;
  readonly autonomous_closure: {
    auto_approved_default: number;
    auto_approved_explicit_issue: number;
    auto_rejected_unknown: number;
    auto_rejected_test_noise: number;
    auto_rejected_sensitive: number;
  };
}

function hasPolicyFields(decision: MemoryPolicyDecisionFact): boolean {
  if (typeof decision.has_policy_fields === "boolean") return decision.has_policy_fields;
  return Boolean(decision.memory_class || decision.policy_action || decision.recall_policy);
}

function keyFor(decision: MemoryPolicyDecisionFact, key: string | null | undefined): string {
  if (!hasPolicyFields(decision) || decision.legacy) return "legacy_unknown";
  return key?.trim() || "unknown";
}

function bump(target: Record<string, number>, key: string): void {
  const normalized = key.trim() || "unknown";
  target[normalized] = (target[normalized] ?? 0) + 1;
}

function summarizeWindow(decisions: readonly MemoryPolicyDecisionFact[]): PolicyWindowSummary {
  const withPolicyFields = decisions.filter(hasPolicyFields).length;
  const summary: PolicyWindowSummary = {
    total: decisions.length,
    policy_coverage_rate: decisions.length === 0 ? 1 : withPolicyFields / decisions.length,
    policy_actions: {},
    memory_classes: {},
    recall_policies: {},
    autonomous_closure: {
      auto_approved_default: 0,
      auto_approved_explicit_issue: 0,
      auto_rejected_unknown: 0,
      auto_rejected_test_noise: 0,
      auto_rejected_sensitive: 0,
    },
  };
  for (const decision of decisions) {
    bump(summary.policy_actions, keyFor(decision, decision.policy_action));
    bump(summary.memory_classes, keyFor(decision, decision.memory_class));
    bump(summary.recall_policies, keyFor(decision, decision.recall_policy));
    if (decision.autonomous_action === "approve_default") summary.autonomous_closure.auto_approved_default += 1;
    if (decision.autonomous_action === "approve_explicit_issue") summary.autonomous_closure.auto_approved_explicit_issue += 1;
    if (decision.autonomous_action === "reject_unknown_source") summary.autonomous_closure.auto_rejected_unknown += 1;
    if (decision.autonomous_action === "reject_test_noise") summary.autonomous_closure.auto_rejected_test_noise += 1;
    if (decision.autonomous_action === "reject_sensitive") summary.autonomous_closure.auto_rejected_sensitive += 1;
  }
  return summary;
}

function filterSince(input: BuildMemoryPolicyReportInput, days: number): MemoryPolicyDecisionFact[] {
  const nowMs = Date.parse(input.now ?? new Date().toISOString());
  const since = nowMs - days * 24 * 60 * 60 * 1000;
  return input.decisions.filter((decision) => {
    const decidedAt = Date.parse(decision.decided_at);
    return Number.isFinite(decidedAt) && decidedAt >= since && decidedAt <= nowMs;
  });
}

export function buildMemoryPolicyReport(input: BuildMemoryPolicyReportInput) {
  const minimumCompareSamples = 20;
  return {
    generated_at: input.now ?? new Date().toISOString(),
    windows: {
      last_24h: summarizeWindow(filterSince(input, 1)),
      last_7d: summarizeWindow(filterSince(input, 7)),
    },
    compare_observations: {
      count: input.compareObservationCount,
      minimum: minimumCompareSamples,
      window_hours: input.compareWindowHours ?? 24,
      status: input.compareObservationCount >= minimumCompareSamples ? "ok" : "below_minimum",
      latest_observed_at: input.latestCompareObservationAt ?? null,
      recommended_command: "TMPDIR=/tmp npm run memory:intelligence-quality -- --compare-sample-size=20 --write-observations",
    },
  };
}

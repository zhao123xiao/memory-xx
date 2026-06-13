import { createHash } from "node:crypto";

import { LifecycleStatus, ReviewState, type JsonObject } from "../shared/types";
import type { GovernancePolicyOverrideRow, MemoryRecordRow } from "../db/schema/tables";

export interface SilentApproveCohortStats {
  readonly sampleSize: number;
  readonly falsePositiveRate: number;
  readonly adoptionRate: number;
  readonly cleanRunCount: number;
}

export interface ThresholdAdjustmentInput {
  readonly currentThreshold: number;
  readonly defaultThreshold: number;
  readonly maxThreshold?: number;
  readonly minThreshold?: number;
  readonly lastUpdatedAt?: string | null;
  readonly now: string;
  readonly stats: SilentApproveCohortStats;
}

export interface ThresholdAdjustmentResult {
  readonly threshold: number;
  readonly cleanRunCount: number;
  readonly changed: boolean;
  readonly reason:
    | "insufficient_sample"
    | "cooldown_active"
    | "false_positive_guardrail"
    | "clean_runs_relaxation"
    | "no_change";
}

export interface TestPollutionEvidence {
  readonly scopeId?: string | null;
  readonly source?: string | null;
  readonly agentId?: string | null;
  readonly title?: string | null;
  readonly content?: string | null;
  readonly createdAt?: string | null;
  readonly metadata?: JsonObject | null;
  readonly knownTestWindow?: { readonly start: string; readonly end: string } | null;
}

export interface TestPollutionScore {
  readonly score: number;
  readonly autoTombstoneAllowed: boolean;
  readonly reasons: readonly string[];
}

export type ProjectionLifecycleOperation = "upsert_recallable" | "delete_point" | "skip";

export function stableGovernanceSelectorHash(selector: JsonObject): string {
  return createHash("sha256").update(stableStringify(selector)).digest("hex");
}

export function adjustSilentApproveThreshold(input: ThresholdAdjustmentInput): ThresholdAdjustmentResult {
  const maxThreshold = input.maxThreshold ?? 0.98;
  const minThreshold = input.minThreshold ?? input.defaultThreshold;
  if (input.stats.sampleSize < 20) {
    return { threshold: input.currentThreshold, cleanRunCount: input.stats.cleanRunCount, changed: false, reason: "insufficient_sample" };
  }
  if (input.lastUpdatedAt && Date.parse(input.now) - Date.parse(input.lastUpdatedAt) < 48 * 60 * 60 * 1000) {
    return { threshold: input.currentThreshold, cleanRunCount: input.stats.cleanRunCount, changed: false, reason: "cooldown_active" };
  }
  if (input.stats.falsePositiveRate >= 0.05) {
    return {
      threshold: roundThreshold(Math.min(maxThreshold, input.currentThreshold + 0.03)),
      cleanRunCount: 0,
      changed: input.currentThreshold < maxThreshold,
      reason: "false_positive_guardrail",
    };
  }
  const cleanRunCount = input.stats.cleanRunCount + 1;
  if (cleanRunCount >= 3 && input.currentThreshold > minThreshold) {
    return {
      threshold: roundThreshold(Math.max(minThreshold, input.currentThreshold - 0.01)),
      cleanRunCount: 0,
      changed: true,
      reason: "clean_runs_relaxation",
    };
  }
  return { threshold: input.currentThreshold, cleanRunCount, changed: false, reason: "no_change" };
}

export function scoreTestPollution(input: TestPollutionEvidence): TestPollutionScore {
  const reasons: string[] = [];
  let score = 0;
  const scope = input.scopeId ?? "";
  const sourceAgent = `${input.source ?? ""} ${input.agentId ?? ""}`;
  const content = `${input.title ?? ""} ${input.content ?? ""}`;
  const metadata = input.metadata ?? {};

  if (/(^|[-_:])(test|load-test|mcp-user-flow|benchmark|smoke)([-_:]|$)/i.test(scope)) {
    score += 2;
    reasons.push("scope_test_marker");
  }
  if (/(test|benchmark|smoke|load)/i.test(sourceAgent)) {
    score += 1;
    reasons.push("source_or_agent_test_marker");
  }
  if (/(temporary test|benchmark sample|schema example|Unified API test|L[0-9]+ .*test|Lx test|测试记录|测试污染)/iu.test(content)) {
    score += 1;
    reasons.push("content_test_marker");
  }
  const testRunId = metadata.test_run_id ?? metadata.testRunId;
  if (typeof testRunId === "string" && testRunId.trim() !== "") {
    score += 1;
    reasons.push("metadata_test_run_id");
  } else if (input.createdAt && input.knownTestWindow && input.createdAt >= input.knownTestWindow.start && input.createdAt <= input.knownTestWindow.end) {
    score += 1;
    reasons.push("created_in_known_test_window");
  }
  if (metadata.governance_test_pollution === true) {
    score += 2;
    reasons.push("explicit_governance_test_pollution");
  }
  return { score, autoTombstoneAllowed: score >= 2, reasons };
}

export function projectionLifecycleOperation(
  memory: Pick<MemoryRecordRow, "lifecycleStatus" | "reviewState" | "isCurrent"> & {
    readonly metadata?: JsonObject;
    readonly recallPolicy?: string | null;
  }
): ProjectionLifecycleOperation {
  const recallPolicy = readProjectionRecallPolicy(memory);
  if (
    memory.lifecycleStatus === LifecycleStatus.Approved &&
    memory.isCurrent &&
    (recallPolicy === undefined || recallPolicy === null || recallPolicy === "" || recallPolicy === "default") &&
    (memory.reviewState === ReviewState.Approved ||
      memory.reviewState === ReviewState.SilentApproved ||
      memory.reviewState === ReviewState.NotRequired)
  ) {
    return "upsert_recallable";
  }
  if (
    memory.lifecycleStatus === LifecycleStatus.Approved &&
    memory.isCurrent &&
    ["explicit_only", "audit_only", "test_only", "never"].includes(recallPolicy ?? "")
  ) {
    return "delete_point";
  }
  if (memory.lifecycleStatus === LifecycleStatus.Archived) {
    return "delete_point";
  }
  if (memory.lifecycleStatus === LifecycleStatus.Tombstone || memory.lifecycleStatus === LifecycleStatus.Superseded) {
    return "delete_point";
  }
  if (process.env.MEMORY_XX_PROJECTION_PENDING_SKIP === "false") {
    return "delete_point";
  }
  return "skip";
}

function readProjectionRecallPolicy(input: {
  readonly metadata?: JsonObject;
  readonly recallPolicy?: string | null;
}): string | null {
  if (typeof input.recallPolicy === "string" && input.recallPolicy.trim() !== "") {
    return input.recallPolicy;
  }
  const metadata = input.metadata;
  if (!metadata) return null;
  const direct = metadata.recall_policy ?? metadata.recallPolicy;
  if (typeof direct === "string" && direct.trim() !== "") {
    return direct;
  }
  const autoApproval = metadata.auto_approval_policy;
  if (!autoApproval || typeof autoApproval !== "object" || Array.isArray(autoApproval)) {
    return null;
  }
  const memoryPolicy = (autoApproval as JsonObject).memory_policy;
  if (!memoryPolicy || typeof memoryPolicy !== "object" || Array.isArray(memoryPolicy)) {
    return null;
  }
  const nested = (memoryPolicy as JsonObject).recall_policy;
  return typeof nested === "string" && nested.trim() !== "" ? nested : null;
}

export function feedbackLineageContribution(input: {
  readonly confirmed?: number;
  readonly used?: number;
  readonly adopted?: number;
  readonly wrong?: number;
  readonly deleted?: number;
  readonly notRelevant?: number;
}): { readonly strengthDelta: number; readonly lineageRisk: JsonObject } {
  const positive = (input.confirmed ?? 0) + (input.used ?? 0) + (input.adopted ?? 0);
  const negative = (input.wrong ?? 0) + (input.deleted ?? 0) + (input.notRelevant ?? 0);
  return {
    strengthDelta: Math.min(0.20, positive * 0.04 * 0.5),
    lineageRisk: {
      inherited_negative_feedback_count: negative,
      negative_feedback_not_inherited_to_strength: true,
    },
  };
}

export function activeSilentApproveThreshold(
  override: GovernancePolicyOverrideRow | null,
  defaultThreshold: number
): { readonly threshold: number; readonly autoApproveEnabled: boolean; readonly source: "default" | "governance_override" } {
  if (!override) return { threshold: defaultThreshold, autoApproveEnabled: true, source: "default" };
  return {
    threshold: override.threshold ?? defaultThreshold,
    autoApproveEnabled: override.autoApproveEnabled ?? true,
    source: "governance_override",
  };
}

function roundThreshold(value: number): number {
  return Math.round(value * 100) / 100;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}

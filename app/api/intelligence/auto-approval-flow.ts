import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ExtractedMemory, ExtractionMode } from "../../intelligence/types";
import { GovernanceRepository } from "../../db/repositories/governance-repository";
import { isInMemoryTransactionContext, isPostgresTransactionContext, withWriteTransaction } from "../../db/tx/write-transaction";
import { activeSilentApproveThreshold, stableGovernanceSelectorHash } from "../../governance";
import { isAutoApprovalCandidateOnlyBypassScope, type AutoApprovalPolicyResult } from "../../governance/auto-approval-policy";
import { LifecycleStatus, ReviewState, type JsonObject } from "../../shared";
import * as runtime from "../../server/runtime";
import { readString } from "./request-parsing";

export function trustedAutoApprove(agentId: string, mode: ExtractionMode): boolean {
  if (mode !== "auto_approve") return false;
  if (process.env.MEMORY_XX_TRUSTED_AGENT_AUTO_APPROVE !== "true") return false;
  const trustedAgents = (process.env.MEMORY_XX_TRUSTED_AGENTS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return trustedAgents.includes(agentId);
}

export function isTrustedAgent(agentId: string): boolean {
  const trustedAgents = (process.env.MEMORY_XX_TRUSTED_AGENTS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return trustedAgents.includes(agentId);
}

export function readLatencyMode(value: unknown): "sync" | "fast_ack" {
  return value === "fast_ack" ? "fast_ack" : "sync";
}

export function readIdempotencyKey(payload: Record<string, unknown>): string | undefined {
  return readString(payload.idempotency_key ?? payload.request_id ?? payload.requestId) || undefined;
}

export interface SilentApprovePolicy {
  readonly threshold: number;
  readonly autoApproveEnabled: boolean;
  readonly source: "default" | "governance_override";
  readonly candidateOnly: boolean;
  readonly candidateOnlyReasons: readonly string[];
}

async function loadCandidateOnlyRuntimeFlag(): Promise<{ readonly enabled: boolean; readonly reasons: readonly string[] }> {
  if (process.env.MEMORY_XX_INTELLIGENCE_CANDIDATE_ONLY === "true") {
    return { enabled: true, reasons: ["env_candidate_only"] };
  }

  const runtimeDir = process.env.MEMORY_XX_RUNTIME_DIR?.trim() || path.join(process.cwd(), ".runtime");
  try {
    const raw = await readFile(path.join(runtimeDir, "intelligence-candidate-only.json"), "utf8");
    const parsed = JSON.parse(raw) as { enabled?: unknown; reasons?: unknown };
    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons.filter((item): item is string => typeof item === "string")
      : [];
    return { enabled: parsed.enabled === true, reasons };
  } catch {
    return { enabled: false, reasons: [] };
  }
}

export function qualityScoreOf(memory: ExtractedMemory, fallback: number): number {
  return memory.quality_gate?.score ?? fallback;
}

export function normalizeApprovalSource(source: string): string {
  return source === "memory-xx-intelligence-smart-write" || source === "memory-xx-mcp-smart-write"
    ? "smart_write"
    : source === "codex-session-tail" || source === "claude-code-session-tail" || source === "openclaw-session-tail"
      ? "conversation_ingest"
    : source;
}

export function approvalForMemory(input: {
  readonly agentId: string;
  readonly mode: ExtractionMode;
  readonly memory: ExtractedMemory;
  readonly extractionConfidence: number;
  readonly hasSemanticConflict: boolean;
  readonly silentApproveThreshold?: number;
  readonly silentApproveEnabled?: boolean;
}): {
  lifecycleStatus: LifecycleStatus.Candidate | LifecycleStatus.Approved;
  reviewState: ReviewState.Pending | ReviewState.Approved | ReviewState.SilentApproved | ReviewState.NotRequired;
  approvalMode: "candidate" | "silent_approved" | "auto_approve";
} {
  const trusted = trustedAutoApprove(input.agentId, input.mode);
  if (!trusted) {
    return { lifecycleStatus: LifecycleStatus.Candidate, reviewState: ReviewState.Pending, approvalMode: "candidate" };
  }
  if (input.silentApproveEnabled === false) {
    return { lifecycleStatus: LifecycleStatus.Candidate, reviewState: ReviewState.Pending, approvalMode: "candidate" };
  }

  const scopeMultiplier =
    input.memory.scope_type === "workspace" ? 0.95 :
      input.memory.scope_type === "global" ? 0.90 :
        1.0;
  const adjustedConfidence = Math.min(input.extractionConfidence, input.memory.confidence) * scopeMultiplier;
  const qualityScore = qualityScoreOf(input.memory, input.extractionConfidence);
  if (
    input.memory.operation === "add" &&
    qualityScore >= 0.85 &&
    !input.hasSemanticConflict &&
    adjustedConfidence >= (input.silentApproveThreshold ?? 0.90)
  ) {
    return {
      lifecycleStatus: LifecycleStatus.Approved,
      reviewState: ReviewState.SilentApproved,
      approvalMode: "silent_approved"
    };
  }

  return { lifecycleStatus: LifecycleStatus.Candidate, reviewState: ReviewState.Pending, approvalMode: "candidate" };
}

export async function loadSilentApprovePolicy(input: {
  readonly agentId: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly memoryType: string;
  readonly source: string;
}): Promise<SilentApprovePolicy> {
  const candidateOnlyFlag = await loadCandidateOnlyRuntimeFlag();
  const selector = {
    agent_id: input.agentId,
    scope_type: input.scopeType,
    scope_id: input.scopeId,
    memory_type: input.memoryType,
    source: input.source,
  } as const;
  const withCandidateOnly = (policy: ReturnType<typeof activeSilentApproveThreshold>): SilentApprovePolicy => ({
    ...policy,
    autoApproveEnabled: candidateOnlyFlag.enabled && !isAutoApprovalCandidateOnlyBypassScope(input.scopeType, input.scopeId) ? false : policy.autoApproveEnabled,
    candidateOnly: candidateOnlyFlag.enabled,
    candidateOnlyReasons: candidateOnlyFlag.reasons
  });
  const db = runtime.writeDatabase;
  if (!db) return withCandidateOnly(activeSilentApproveThreshold(null, 0.90));
  try {
    const selectorHash = stableGovernanceSelectorHash(selector as JsonObject);
    const override = await withWriteTransaction(db, (tx) =>
      new GovernanceRepository().findActivePolicyOverride(tx, selectorHash, "silent_approve")
    );
    return withCandidateOnly(activeSilentApproveThreshold(override, 0.90));
  } catch {
    return withCandidateOnly(activeSilentApproveThreshold(null, 0.90));
  }
}

export async function hasTrustedAgentScopeGrant(input: {
  readonly agentId: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly permission?: string;
  readonly database?: import("../../db/tx/write-transaction").WriteTransactionRunner | null;
}): Promise<boolean> {
  const db = input.database ?? runtime.writeDatabase;
  if (!db) return false;
  try {
    return await withWriteTransaction(db, async (tx) => {
      if (isPostgresTransactionContext(tx)) {
        const rows = await tx.query<{ ok: boolean }>(
          `
            SELECT true AS ok
            FROM trusted_agent_scope_grants
            WHERE agent_id = $1
              AND scope_type = $2
              AND (scope_id = $3 OR scope_id = '*')
              AND revoked_at IS NULL
              AND (expires_at IS NULL OR expires_at > now())
              AND ($4 = ANY(permissions) OR 'memory:admin' = ANY(permissions))
            LIMIT 1
          `,
          [input.agentId, input.scopeType, input.scopeId, input.permission ?? "memory:write"]
        );
        return Boolean(rows[0]?.ok);
      }
      return false;
    });
  } catch {
    return false;
  }
}

export async function countRecentSilentApproved(input: {
  readonly agentId: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly source: string;
  readonly database?: import("../../db/tx/write-transaction").WriteTransactionRunner | null;
}): Promise<number> {
  const db = input.database ?? runtime.writeDatabase;
  if (!db) return 0;
  try {
    return await withWriteTransaction(db, async (tx) => {
      if (isPostgresTransactionContext(tx)) {
        const rows = await tx.query<{ count: string | number }>(
          `
            SELECT count(*) AS count
            FROM memory_records
            WHERE lifecycle_status = 'approved'
              AND review_state = 'silent_approved'
              AND scope_type = $1
              AND scope_id = $2
              AND COALESCE(agent_id, metadata->>'agent_id', created_by) = $3
              AND COALESCE(metadata->>'source', '') = $4
              AND created_at >= now() - interval '1 hour'
          `,
          [input.scopeType, input.scopeId, input.agentId, input.source]
        );
        return Number(rows[0]?.count ?? 0);
      }
      const cutoff = Date.parse(tx.now()) - 60 * 60 * 1000;
      if (!isInMemoryTransactionContext(tx)) return 0;
      return tx.state.memoryRecords.filter((row) =>
        row.lifecycleStatus === LifecycleStatus.Approved &&
        row.reviewState === ReviewState.SilentApproved &&
        row.scopeType === input.scopeType &&
        row.scopeId === input.scopeId &&
        (row.agentId === input.agentId || row.createdBy === input.agentId || row.metadata.agent_id === input.agentId) &&
        row.metadata.source === input.source &&
        Date.parse(row.createdAt) >= cutoff
      ).length;
    });
  } catch {
    return 0;
  }
}

export async function recordAutoApprovalAudit(input: {
  readonly candidateMemoryId?: string | null;
  readonly approvedMemoryId?: string | null;
  readonly agentId: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly policy: AutoApprovalPolicyResult;
  readonly source: string;
  readonly memoryType: string | null;
  readonly database?: import("../../db/tx/write-transaction").WriteTransactionRunner | null;
}): Promise<void> {
  const db = input.database ?? runtime.writeDatabase;
  if (!db) return;
  await withWriteTransaction(db, async (tx) => {
    const governance = new GovernanceRepository();
    const productionCanaryDecision = input.policy.candidate_only_bypassed === true && (
      (input.scopeType === "project" && input.scopeId === "memory-xx") ||
      (input.scopeType === "user" && input.scopeId === "current-user")
    );
    const evidence = {
      source: input.source,
      memory_type: input.memoryType,
      decision: input.policy.decision,
      score: input.policy.score,
      reasons: [...input.policy.reasons],
      blocked_reasons: [...input.policy.blocked_reasons],
      policy_version: input.policy.policy_version,
      thresholds: input.policy.thresholds as unknown as JsonObject,
      scope_profile: input.policy.scope_profile,
      rollback_plan: input.policy.rollback_plan,
      privacy: input.policy.privacy,
      privacy_findings: Array.isArray(input.policy.privacy.findings) ? input.policy.privacy.findings : [],
      temporal: input.policy.temporal ?? {},
      memory_policy: input.policy.memory_policy as unknown as JsonObject,
      memory_class: input.policy.memory_policy.memory_class,
      storage_target: input.policy.memory_policy.storage_target,
      recall_policy: input.policy.memory_policy.recall_policy,
      lifecycle_intent: input.policy.memory_policy.lifecycle_intent,
      policy_action: input.policy.memory_policy.policy_action,
      ...(input.policy.candidate_only_bypassed ? { candidate_only_bypassed: true } : {}),
      ...(productionCanaryDecision
        ? {
            production_canary: true,
            production_canary_run_id: process.env.MEMORY_XX_PRODUCTION_CANARY_RUN_ID?.trim() || "memory-production-canary-7d-v1",
          }
        : {}),
      ...(input.policy.low_value ? { low_value: input.policy.low_value } : {}),
    } as unknown as JsonObject;
    await governance.recordAction(tx, {
      actionType: "auto_approval_decision",
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      memoryId: input.approvedMemoryId ?? input.candidateMemoryId ?? null,
      selector: {
        agent_id: input.agentId,
        scope_type: input.scopeType,
        scope_id: input.scopeId,
        source: input.source,
        memory_type: input.memoryType ?? "unknown",
      },
      evidence,
      afterState: {
        decision: input.policy.decision,
        lifecycle_status: input.policy.lifecycleStatus,
        review_state: input.policy.reviewState,
        memory_class: input.policy.memory_policy.memory_class,
        policy_action: input.policy.memory_policy.policy_action,
      },
      status: input.policy.decision === "approve" ? "applied" : "reported",
      createdBy: "memory-xx-auto-approval",
    });
    if (isPostgresTransactionContext(tx)) {
      await tx.query(
        `
          INSERT INTO auto_approval_decisions (
            id, candidate_memory_id, decision, policy_version, score, reasons,
            blocked_reasons, agent_id, scope_type, scope_id, approved_memory_id,
            rollback_memory_event_id, metadata, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, NULL, $12::jsonb, now())
          ON CONFLICT DO NOTHING
        `,
        [
          randomUUID(),
          input.candidateMemoryId ?? null,
          input.policy.decision,
          input.policy.policy_version,
          input.policy.score,
          JSON.stringify([...input.policy.reasons]),
          JSON.stringify([...input.policy.blocked_reasons]),
          input.agentId,
          input.scopeType,
          input.scopeId,
          input.approvedMemoryId ?? null,
          JSON.stringify(evidence),
        ]
      ).catch(() => undefined);
    }
  }).catch(() => undefined);
}

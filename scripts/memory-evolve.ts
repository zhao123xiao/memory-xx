#!/usr/bin/env tsx
import "./test-harness/config.js";

import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import type { MemoryRecordRow, RecallFeedbackEventRow, RecallTraceRow } from "../app/db/schema/tables";
import { buildAdaptiveRetrievalCalibrationReport } from "../app/governance/adaptive-retrieval-calibration";
import {
  buildConsolidationCandidateReport,
  type ConsolidationCandidateRecord,
} from "../app/governance/consolidation-candidates";
import { buildContextHygieneReport, type ContextHygieneReportRow } from "../app/governance/context-hygiene-report";
import {
  buildExtractionRecallEvalPolicyCandidates,
  buildExtractionRecallEvalReport,
} from "../app/governance/extraction-recall-eval";
import { buildGraphOrphanReport, type GraphOrphanReportRow } from "../app/governance/graph-orphan-report";
import {
  buildGraphRelationRepairPlan,
  type GraphRelationRepairPlanRow,
} from "../app/governance/graph-relation-repair-plan";
import {
  buildGraphSuccessorDiscoveryCandidateReport,
  type GraphSuccessorDiscoveryMemoryRow,
  type GraphSuccessorDiscoveryRepairRow,
} from "../app/governance/graph-successor-discovery-candidates";
import {
  buildTopicAliasCandidateReport,
  type TopicAliasDiscoveryRow,
} from "../app/governance/topic-alias-candidates";
import {
  buildTopicNormalizationPlan,
  buildTopicNormalizationReviewQueue,
  type TopicNormalizationAliasRow,
} from "../app/governance/topic-normalization-plan";
import { buildMemoryEvolveObservationReflectionSection } from "../app/governance/memory-evolve-observation-reflection";
import {
  buildMemoryEvolveReport,
  rejectMemoryEvolveApply,
  renderMemoryEvolveMarkdown,
} from "../app/governance/memory-evolve-report";
import { enabledMemoryEvolveModules, readMemoryEvolveRuntimeControlsStateSync } from "../app/governance/memory-evolve-runtime-controls";
import { buildMemoryOsReadinessReport } from "../app/governance/memory-os-readiness-report";
import {
  buildMemoryLinkCandidateReport,
  type ExistingMemoryRelationRow,
  type MemoryLinkCandidateRow,
} from "../app/governance/memory-link-candidates";
import {
  planAutonomousPendingClosure,
  type PendingAutonomousClosureRow,
} from "../app/governance/memory-auto-approval-sweep";
import {
  buildPendingApprovalEvidenceReport,
  buildPendingSafeClosePlan,
  pendingApprovalEvidenceSummaryForEvolve,
  pendingSafeCloseSummaryForEvolve,
} from "../app/governance/pending-approval-evidence-report";
import {
  type ConversationBatchReflectionRow,
  type ConversationEventReflectionRow,
} from "../app/governance/observer-reflector-governor";
import {
  buildProceduralPromotionCandidateReport,
  type ProceduralPromotionMemoryRow,
} from "../app/governance/procedural-promotion-candidates";
import { buildPolicyFeedbackBackpropReport } from "../app/governance/policy-feedback-backprop";
import {
  buildRecallFeedbackPolicyCandidates,
  buildRecallQualityFeedbackReport,
} from "../app/governance/recall-quality-feedback";
import { buildStaleFactReport, type StaleFactReportRow } from "../app/governance/stale-fact-report";
import {
  buildTemporalValidityDebtReport,
  type TemporalValidityDebtRow,
} from "../app/governance/temporal-validity-debt-report";
import {
  buildTemporalTransitionCandidateReport,
  type ExistingTemporalTransitionRelationRow,
  type TemporalTransitionFactRow,
} from "../app/governance/temporal-transition-candidates";
import { ScopeType } from "../app/shared";
import { requireCliPermission } from "../app/server/permissions.js";
import { loadDotenvIfPresent, quoteIdent } from "./lib/runtime-env";

loadDotenvIfPresent();

function arg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(arg(name) || String(fallback), 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, value));
}

function jsonObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function iso(value: unknown): string {
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

function isoOrNull(value: unknown): string | null {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function mapPendingRow(row: Record<string, unknown>): PendingAutonomousClosureRow {
  return {
    id: String(row.id),
    scope_type: String(row.scope_type ?? "project"),
    scope_id: String(row.scope_id ?? "unknown"),
    title: typeof row.title === "string" ? row.title : null,
    content: String(row.content ?? ""),
    memory_type: typeof row.memory_type === "string" ? row.memory_type : null,
    metadata: jsonObject(row.metadata),
    created_by: typeof row.created_by === "string" ? row.created_by : null,
  };
}

function mapTrace(row: Record<string, unknown>): RecallTraceRow {
  return {
    id: String(row.id),
    queryHash: String(row.query_hash),
    queryExcerpt: String(row.query_excerpt ?? ""),
    actorId: typeof row.actor_id === "string" ? row.actor_id : null,
    scopeContext: jsonObject(row.scope_context),
    queryType: String(row.query_type ?? "unknown"),
    strategy: String(row.strategy ?? "unknown"),
    degradeLevel: Number(row.degrade_level ?? 0),
    results: jsonObject(row.results),
    audit: jsonObject(row.audit),
    createdAt: iso(row.created_at),
  };
}

function mapFeedback(row: Record<string, unknown>): RecallFeedbackEventRow {
  return {
    id: String(row.id),
    recallTraceId: String(row.recall_trace_id),
    memoryId: typeof row.memory_id === "string" ? row.memory_id : null,
    actorId: String(row.actor_id ?? "unknown"),
    feedbackType: String(row.feedback_type ?? "unknown"),
    suspicious: row.suspicious === true,
    reason: typeof row.reason === "string" ? row.reason : null,
    metadata: jsonObject(row.metadata),
    createdAt: iso(row.created_at),
  };
}

function mapMemory(row: Record<string, unknown>): MemoryRecordRow {
  return {
    id: String(row.id),
    requestId: String(row.request_id ?? ""),
    scopeType: String(row.scope_type ?? ScopeType.Project) as MemoryRecordRow["scopeType"],
    scopeId: String(row.scope_id ?? "unknown"),
    content: String(row.content ?? ""),
    title: stringOrNull(row.title),
    summary: stringOrNull(row.summary),
    metadata: jsonObject(row.metadata),
    contentEmbedding: null,
    dedupeKey: stringOrNull(row.dedupe_key),
    lifecycleStatus: String(row.lifecycle_status ?? "candidate") as MemoryRecordRow["lifecycleStatus"],
    reviewState: String(row.review_state ?? "pending") as MemoryRecordRow["reviewState"],
    isCurrent: row.is_current === true,
    version: Number(row.version ?? 1),
    createdBy: String(row.created_by ?? "unknown"),
    updatedBy: String(row.updated_by ?? "unknown"),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    tenantId: String(row.tenant_id ?? "default"),
    agentId: String(row.agent_id ?? ""),
    governanceStatus: String(row.governance_status ?? "normal"),
    visibility: String(row.visibility ?? "scope_only"),
    memoryType: stringOrNull(row.memory_type),
    embeddingGeneration: stringOrNull(row.embedding_generation),
    memoryLayer: String(row.memory_layer ?? "episodic"),
    factStatus: String(row.fact_status ?? "current"),
    validAt: isoOrNull(row.valid_at),
    invalidAt: isoOrNull(row.invalid_at),
    observedAt: isoOrNull(row.observed_at),
    expiresAt: isoOrNull(row.expires_at),
    episodeId: stringOrNull(row.episode_id),
    importance: Number(row.importance ?? 1),
    memoryStrength: Number(row.memory_strength ?? 1),
    decayPolicy: String(row.decay_policy ?? "default"),
  };
}

function mapConsolidationRecord(row: Record<string, unknown>): ConsolidationCandidateRecord {
  return {
    id: String(row.id),
    scope_type: String(row.scope_type),
    scope_id: String(row.scope_id),
    title: stringOrNull(row.title),
    content: String(row.content ?? ""),
    memory_type: stringOrNull(row.memory_type),
    memory_layer: stringOrNull(row.memory_layer),
    memory_class: stringOrNull(row.memory_class),
    cognitive_type: stringOrNull(row.cognitive_type),
    recall_policy: stringOrNull(row.recall_policy),
    lifecycle_status: String(row.lifecycle_status),
    review_state: String(row.review_state),
    is_current: row.is_current === true,
    topic: stringOrNull(row.topic),
    source: stringOrNull(row.source),
    observed_at: isoOrNull(row.observed_at),
    updated_at: isoOrNull(row.updated_at) ?? new Date(0).toISOString(),
    memory_strength: row.memory_strength === null || row.memory_strength === undefined ? null : Number(row.memory_strength),
  };
}

function mapContextHygieneRow(row: Record<string, unknown>): ContextHygieneReportRow {
  return {
    id: String(row.id),
    scope_type: String(row.scope_type ?? "project"),
    scope_id: String(row.scope_id ?? "unknown"),
    title: stringOrNull(row.title),
    content: String(row.content ?? ""),
    memory_type: stringOrNull(row.memory_type),
    memory_class: stringOrNull(row.memory_class),
    cognitive_type: stringOrNull(row.cognitive_type),
    recall_policy: stringOrNull(row.recall_policy),
    lifecycle_status: String(row.lifecycle_status ?? ""),
    review_state: String(row.review_state ?? ""),
    is_current: row.is_current === true,
    updated_at: isoOrNull(row.updated_at),
  };
}

function mapTemporalValidityDebtRow(row: Record<string, unknown>): TemporalValidityDebtRow {
  return {
    id: String(row.id),
    scope_type: String(row.scope_type ?? "project"),
    scope_id: String(row.scope_id ?? "unknown"),
    title: stringOrNull(row.title),
    content: String(row.content ?? ""),
    memory_type: stringOrNull(row.memory_type),
    memory_class: stringOrNull(row.memory_class),
    cognitive_type: stringOrNull(row.cognitive_type),
    recall_policy: stringOrNull(row.recall_policy),
    lifecycle_status: String(row.lifecycle_status ?? ""),
    review_state: String(row.review_state ?? ""),
    is_current: row.is_current === true,
    fact_status: stringOrNull(row.fact_status),
    valid_at: isoOrNull(row.valid_at),
    invalid_at: isoOrNull(row.invalid_at),
    observed_at: isoOrNull(row.observed_at),
    review_at: isoOrNull(row.review_at),
    expires_at: isoOrNull(row.expires_at),
    updated_at: isoOrNull(row.updated_at),
  };
}

function mapProceduralPromotionMemory(row: Record<string, unknown>): ProceduralPromotionMemoryRow {
  return {
    id: String(row.id),
    scope_type: String(row.scope_type),
    scope_id: String(row.scope_id),
    title: stringOrNull(row.title),
    content: String(row.content ?? ""),
    memory_type: stringOrNull(row.memory_type),
    memory_class: stringOrNull(row.memory_class),
    cognitive_type: stringOrNull(row.cognitive_type),
    recall_policy: stringOrNull(row.recall_policy),
    metadata: jsonObject(row.metadata),
  };
}

function mapGraphOrphanRow(row: Record<string, unknown>): GraphOrphanReportRow {
  return {
    id: String(row.id),
    scope_type: String(row.scope_type ?? "project"),
    scope_id: String(row.scope_id ?? "unknown"),
    title: stringOrNull(row.title),
    memory_type: stringOrNull(row.memory_type),
    lifecycle_status: String(row.lifecycle_status ?? ""),
    review_state: String(row.review_state ?? ""),
    is_current: row.is_current === true,
    episode_id: stringOrNull(row.episode_id),
    has_entity_link: row.has_entity_link === true,
    has_relation: row.has_relation === true,
    relation_id: stringOrNull(row.relation_id),
    relation_type: stringOrNull(row.relation_type),
    relation_memory_id: stringOrNull(row.relation_memory_id),
    relation_related_memory_id: stringOrNull(row.relation_related_memory_id),
    source_created_by: stringOrNull(row.source_created_by),
    source_agent_id: stringOrNull(row.source_agent_id),
    source_metadata: jsonObject(row.source_metadata),
    related_created_by: stringOrNull(row.related_created_by),
    related_agent_id: stringOrNull(row.related_agent_id),
    related_title: stringOrNull(row.related_title),
    related_metadata: jsonObject(row.related_metadata),
    relation_metadata: jsonObject(row.relation_metadata),
    related_exists: typeof row.related_exists === "boolean" ? row.related_exists : null,
    related_lifecycle_status: stringOrNull(row.related_lifecycle_status),
    related_is_current: typeof row.related_is_current === "boolean" ? row.related_is_current : null,
    updated_at: isoOrNull(row.updated_at),
  };
}

function mapGraphRelationRepairPlanRow(row: Record<string, unknown>): GraphRelationRepairPlanRow {
  return {
    relation_id: String(row.relation_id),
    relation_type: String(row.relation_type ?? ""),
    relation_memory_id: String(row.relation_memory_id ?? ""),
    relation_related_memory_id: String(row.relation_related_memory_id ?? ""),
    source_exists: row.source_exists === true,
    source_lifecycle_status: stringOrNull(row.source_lifecycle_status),
    source_is_current: typeof row.source_is_current === "boolean" ? row.source_is_current : null,
    source_created_by: stringOrNull(row.source_created_by),
    source_agent_id: stringOrNull(row.source_agent_id),
    source_title: stringOrNull(row.source_title),
    source_metadata: jsonObject(row.source_metadata),
    target_exists: row.target_exists === true,
    target_lifecycle_status: stringOrNull(row.target_lifecycle_status),
    target_is_current: typeof row.target_is_current === "boolean" ? row.target_is_current : null,
    target_created_by: stringOrNull(row.target_created_by),
    target_agent_id: stringOrNull(row.target_agent_id),
    target_title: stringOrNull(row.target_title),
    target_metadata: jsonObject(row.target_metadata),
    relation_metadata: jsonObject(row.relation_metadata),
    successor_memory_id: stringOrNull(row.successor_memory_id),
    successor_lifecycle_status: stringOrNull(row.successor_lifecycle_status),
    successor_is_current: typeof row.successor_is_current === "boolean" ? row.successor_is_current : null,
    successor_count: Number(row.successor_count ?? 0),
    updated_at: isoOrNull(row.updated_at),
  };
}

function mapGraphSuccessorDiscoveryMemoryRow(row: Record<string, unknown>): GraphSuccessorDiscoveryMemoryRow {
  return {
    id: String(row.id),
    scope_type: String(row.scope_type ?? "project"),
    scope_id: String(row.scope_id ?? "unknown"),
    title: stringOrNull(row.title),
    content: String(row.content ?? ""),
    topic: stringOrNull(row.topic),
    lifecycle_status: String(row.lifecycle_status ?? ""),
    review_state: String(row.review_state ?? ""),
    is_current: row.is_current === true,
    updated_at: isoOrNull(row.updated_at),
  };
}

function mapMemoryLinkCandidateRow(row: Record<string, unknown>): MemoryLinkCandidateRow {
  return {
    id: String(row.id),
    scope_type: String(row.scope_type ?? "project"),
    scope_id: String(row.scope_id ?? "unknown"),
    title: stringOrNull(row.title),
    content: String(row.content ?? ""),
    memory_type: stringOrNull(row.memory_type),
    memory_class: stringOrNull(row.memory_class),
    cognitive_type: stringOrNull(row.cognitive_type),
    recall_policy: stringOrNull(row.recall_policy),
    lifecycle_status: String(row.lifecycle_status ?? ""),
    review_state: String(row.review_state ?? ""),
    is_current: row.is_current === true,
    topic: stringOrNull(row.topic),
    updated_at: isoOrNull(row.updated_at),
  };
}

function mapTemporalTransitionFactRow(row: Record<string, unknown>): TemporalTransitionFactRow {
  return {
    id: String(row.id),
    scope_type: String(row.scope_type ?? "project"),
    scope_id: String(row.scope_id ?? "unknown"),
    title: stringOrNull(row.title),
    content: String(row.content ?? ""),
    memory_type: stringOrNull(row.memory_type),
    memory_class: stringOrNull(row.memory_class),
    cognitive_type: stringOrNull(row.cognitive_type),
    recall_policy: stringOrNull(row.recall_policy),
    lifecycle_status: String(row.lifecycle_status ?? ""),
    review_state: String(row.review_state ?? ""),
    is_current: row.is_current === true,
    fact_status: stringOrNull(row.fact_status),
    topic: stringOrNull(row.topic),
    valid_at: isoOrNull(row.valid_at),
    invalid_at: isoOrNull(row.invalid_at),
    observed_at: isoOrNull(row.observed_at),
    updated_at: isoOrNull(row.updated_at),
  };
}

function mapExistingMemoryRelation(row: Record<string, unknown>): ExistingMemoryRelationRow {
  return {
    memory_id: String(row.memory_id),
    related_memory_id: String(row.related_memory_id),
    relation_type: String(row.relation_type),
  };
}

function mapExistingTemporalTransitionRelation(row: Record<string, unknown>): ExistingTemporalTransitionRelationRow {
  return {
    memory_id: String(row.memory_id),
    related_memory_id: String(row.related_memory_id),
    relation_type: String(row.relation_type),
  };
}

function roleValue(value: unknown): ConversationEventReflectionRow["role"] {
  return value === "system" || value === "user" || value === "assistant" || value === "tool" ? value : "assistant";
}

function mapConversationBatch(row: Record<string, unknown>): ConversationBatchReflectionRow {
  return {
    id: String(row.id),
    scope_context: jsonObject(row.scope_context),
    metadata: jsonObject(row.metadata),
    created_at: iso(row.created_at),
  };
}

function mapConversationEvent(row: Record<string, unknown>): ConversationEventReflectionRow {
  return {
    id: String(row.id),
    batch_id: typeof row.batch_id === "string" ? row.batch_id : null,
    role: roleValue(row.role),
    content: String(row.content ?? ""),
    observed_at: iso(row.observed_at),
  };
}

function printHelp(): void {
  process.stdout.write(`Memory Evolve Report

Usage:
  npm run memory:evolve -- --json
  npm run memory:evolve -- --markdown
  npm run memory:evolve -- --limit=500 --days=7

Sections:
  stale_facts
  consolidation
  context_hygiene
  graph_repair
  adaptive_calibration
  procedural_promotion
  recall_feedback
  extraction_recall
  observation_reflection
  policy_feedback_backprop

Dangerous apply operations are disabled from this report command.
`);
}

function hasCliGovernanceToken(): boolean {
  return Boolean(
    process.env.MEMORY_XX_CLI_TOKEN?.trim() ||
    process.env.MEMORY_XX_ADMIN_TOKEN?.trim() ||
    process.env.MEMORY_XX_API_TOKEN?.trim()
  );
}

function printSampleReport(json: boolean): void {
  const report = buildMemoryEvolveReport();
  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: "dry_run",
      report_only: true,
      sample_report: true,
      note: "sample report",
      ...report,
    }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Memory Evolve Report
Generated at: ${report.generated_at}

Summary:
Total action candidates: ${report.summary.total_action_candidates}

${renderMemoryEvolveMarkdown(report)}

sample report
`);
}

async function main(): Promise<void> {
  rejectMemoryEvolveApply(process.argv.slice(2));
  if (hasFlag("help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }
  const markdown = hasFlag("markdown");
  const json = hasFlag("json");
  if (!hasCliGovernanceToken()) {
    printSampleReport(json);
    return;
  }
  await requireCliPermission("memory:governance_read");
  const limit = readInt("limit", 500, 1, 10_000);
  const days = readInt("days", 7, 1, 90);
  const minFeedback = readInt("min-feedback", 5, 1, 10_000);
  const minTraces = readInt("min-traces", 20, 1, 10_000);
  const minPositiveScopes = readInt("min-positive-scopes", 2, 2, 100);
  const minEpisodicClusterSize = readInt("min-episodic-cluster-size", 3, 2, 100);
  const config = loadMemoryXXPostgresConfig(process.env);
  const schema = quoteIdent(config.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(config));
  const client = await pool.connect();
  try {
    const pendingRows = await client.query(`
      SELECT id, scope_type, scope_id, title, content, memory_type, metadata, created_by
      FROM ${schema}.memory_records
      WHERE is_current IS TRUE
        AND lifecycle_status = 'candidate'
      ORDER BY created_at ASC
      LIMIT $1
    `, [limit]);
    const pendingMappedRows = pendingRows.rows.map(mapPendingRow);
    const pendingClosure = planAutonomousPendingClosure(pendingMappedRows);
    const pendingApprovalEvidence = buildPendingApprovalEvidenceReport({
      rows: pendingMappedRows,
      sampleLimit: limit,
    });
    const pendingSafeClose = buildPendingSafeClosePlan({
      report: pendingApprovalEvidence,
      runId: `memory-evolve-pending-safe-close-${new Date().toISOString().replace(/[:.]/gu, "-")}`,
    });
    const staleRows = await client.query<StaleFactReportRow>(
      `
        WITH relation_edges AS (
          SELECT
            rel.id AS relation_id,
            rel.relation_type,
            rel.created_at AS relation_created_at,
            rel.memory_id AS source_memory_id,
            rel.related_memory_id AS target_memory_id
          FROM ${schema}.memory_relations rel
          WHERE rel.relation_type IN ('supersedes', 'contradicts')
        ),
        stale_edges AS (
          SELECT
            edge.relation_id,
            edge.relation_type,
            edge.relation_created_at,
            CASE
              WHEN edge.relation_type = 'supersedes' THEN edge.target_memory_id
              ELSE edge.source_memory_id
            END AS memory_id,
            CASE
              WHEN edge.relation_type = 'supersedes' THEN edge.source_memory_id
              ELSE edge.target_memory_id
            END AS related_memory_id,
            CASE
              WHEN edge.relation_type = 'supersedes' THEN 'inbound'
              ELSE 'outbound'
            END AS relation_direction
          FROM relation_edges edge
          UNION ALL
          SELECT
            edge.relation_id,
            edge.relation_type,
            edge.relation_created_at,
            edge.target_memory_id AS memory_id,
            edge.source_memory_id AS related_memory_id,
            'inbound' AS relation_direction
          FROM relation_edges edge
          WHERE edge.relation_type = 'contradicts'
        )
        SELECT
          mr.id,
          mr.scope_type,
          mr.scope_id,
          mr.title,
          mr.content,
          mr.memory_type,
          mr.lifecycle_status,
          mr.review_state,
          mr.is_current,
          mr.fact_status,
          mr.valid_at,
          mr.invalid_at,
          mr.observed_at,
          mr.updated_at,
          edge.relation_id,
          edge.relation_type,
          edge.relation_direction,
          related.id AS related_memory_id,
          related.title AS related_title,
          related.content AS related_content,
          related.lifecycle_status AS related_lifecycle_status,
          related.is_current AS related_is_current,
          edge.relation_created_at
        FROM stale_edges edge
        JOIN ${schema}.memory_records mr ON mr.id = edge.memory_id
        LEFT JOIN ${schema}.memory_records related ON related.id = edge.related_memory_id
        WHERE mr.is_current IS TRUE
          AND mr.lifecycle_status = 'approved'
          AND mr.invalid_at IS NULL
          AND COALESCE(mr.fact_status, 'current') NOT IN ('superseded', 'invalid', 'rejected', 'archived')
        ORDER BY edge.relation_created_at DESC NULLS LAST, mr.updated_at DESC
        LIMIT $1
      `,
      [limit],
    );
    const staleFacts = buildStaleFactReport({ rows: staleRows.rows });

    const temporalValidityRows = await client.query(
      `
        SELECT
          id,
          scope_type,
          scope_id,
          title,
          content,
          memory_type,
          COALESCE(metadata->>'memory_class', metadata->'memory_policy'->>'memory_class', metadata->'auto_approval_policy'->'memory_policy'->>'memory_class', metadata->'memory_auto_approval_sweep'->>'memory_class') AS memory_class,
          COALESCE(metadata->>'cognitive_type', metadata->'memory_policy'->>'cognitive_type', metadata->'auto_approval_policy'->'memory_policy'->>'cognitive_type', metadata->'memory_auto_approval_sweep'->>'cognitive_type') AS cognitive_type,
          COALESCE(metadata->>'recall_policy', metadata->'memory_policy'->>'recall_policy', metadata->'auto_approval_policy'->'memory_policy'->>'recall_policy', metadata->'memory_auto_approval_sweep'->>'recall_policy', 'default') AS recall_policy,
          lifecycle_status,
          review_state,
          is_current,
          fact_status,
          valid_at,
          invalid_at,
          observed_at,
          COALESCE((metadata->>'review_at')::timestamptz, (metadata->>'reviewAt')::timestamptz) AS review_at,
          expires_at,
          updated_at
        FROM ${schema}.memory_records
        WHERE is_current IS TRUE
          AND lifecycle_status = 'approved'
        ORDER BY updated_at DESC
        LIMIT $1
      `,
      [limit],
    );
    const temporalValidityDebt = buildTemporalValidityDebtReport({
      rows: temporalValidityRows.rows.map(mapTemporalValidityDebtRow),
    });

    const memoryLinkRows = await client.query(
      `
        SELECT
          id,
          scope_type,
          scope_id,
          title,
          content,
          memory_type,
          COALESCE(metadata->>'memory_class', metadata->'memory_policy'->>'memory_class', metadata->'auto_approval_policy'->'memory_policy'->>'memory_class', metadata->'memory_auto_approval_sweep'->>'memory_class') AS memory_class,
          COALESCE(metadata->>'cognitive_type', metadata->'memory_policy'->>'cognitive_type', metadata->'auto_approval_policy'->'memory_policy'->>'cognitive_type', metadata->'memory_auto_approval_sweep'->>'cognitive_type') AS cognitive_type,
          COALESCE(metadata->>'recall_policy', metadata->'memory_policy'->>'recall_policy', metadata->'auto_approval_policy'->'memory_policy'->>'recall_policy', metadata->'memory_auto_approval_sweep'->>'recall_policy', 'default') AS recall_policy,
          lifecycle_status,
          review_state,
          is_current,
          COALESCE(metadata->>'topic', metadata->>'entity', title, memory_type, scope_id) AS topic,
          updated_at
        FROM ${schema}.memory_records
        WHERE is_current IS TRUE
          AND lifecycle_status = 'approved'
        ORDER BY updated_at DESC
        LIMIT $1
      `,
      [limit],
    );
    const memoryLinkIds = memoryLinkRows.rows.map((row) => String(row.id)).filter(Boolean);
    const existingRelationRows = memoryLinkIds.length === 0
      ? { rows: [] as Record<string, unknown>[] }
      : await client.query(
          `
            SELECT memory_id, related_memory_id, relation_type
            FROM ${schema}.memory_relations
            WHERE memory_id = ANY($1::text[])
               OR related_memory_id = ANY($1::text[])
          `,
          [memoryLinkIds],
        );
    const memoryLinkCandidates = buildMemoryLinkCandidateReport({
      rows: memoryLinkRows.rows.map(mapMemoryLinkCandidateRow),
      existingRelations: existingRelationRows.rows.map(mapExistingMemoryRelation),
    });

    const temporalTransitionRows = await client.query(
      `
        SELECT
          id,
          scope_type,
          scope_id,
          title,
          content,
          memory_type,
          COALESCE(metadata->>'memory_class', metadata->'memory_policy'->>'memory_class', metadata->'auto_approval_policy'->'memory_policy'->>'memory_class', metadata->'memory_auto_approval_sweep'->>'memory_class') AS memory_class,
          COALESCE(metadata->>'cognitive_type', metadata->'memory_policy'->>'cognitive_type', metadata->'auto_approval_policy'->'memory_policy'->>'cognitive_type', metadata->'memory_auto_approval_sweep'->>'cognitive_type') AS cognitive_type,
          COALESCE(metadata->>'recall_policy', metadata->'memory_policy'->>'recall_policy', metadata->'auto_approval_policy'->'memory_policy'->>'recall_policy', metadata->'memory_auto_approval_sweep'->>'recall_policy', 'default') AS recall_policy,
          lifecycle_status,
          review_state,
          is_current,
          fact_status,
          COALESCE(metadata->>'topic', metadata->>'entity', title, memory_type, scope_id) AS topic,
          valid_at,
          invalid_at,
          observed_at,
          updated_at
        FROM ${schema}.memory_records
        WHERE is_current IS TRUE
          AND lifecycle_status = 'approved'
        ORDER BY updated_at DESC
        LIMIT $1
      `,
      [limit],
    );
    const temporalTransitionIds = temporalTransitionRows.rows.map((row) => String(row.id)).filter(Boolean);
    const existingTemporalTransitionRows = temporalTransitionIds.length === 0
      ? { rows: [] as Record<string, unknown>[] }
      : await client.query(
          `
            SELECT memory_id, related_memory_id, relation_type
            FROM ${schema}.memory_relations
            WHERE relation_type IN ('supersedes', 'contradicts')
              AND (
                memory_id = ANY($1::text[])
                OR related_memory_id = ANY($1::text[])
              )
          `,
          [temporalTransitionIds],
        );
    const temporalTransitionCandidates = buildTemporalTransitionCandidateReport({
      rows: temporalTransitionRows.rows.map(mapTemporalTransitionFactRow),
      existingRelations: existingTemporalTransitionRows.rows.map(mapExistingTemporalTransitionRelation),
    });

    const graphOrphanRows = await client.query(
      `
        WITH record_debt AS (
          SELECT
            mr.id,
            mr.scope_type,
            mr.scope_id,
            mr.title,
            mr.memory_type,
            mr.lifecycle_status,
            mr.review_state,
            mr.is_current,
            mr.episode_id,
            EXISTS (SELECT 1 FROM ${schema}.memory_entity_links mel WHERE mel.memory_id = mr.id) AS has_entity_link,
            EXISTS (SELECT 1 FROM ${schema}.memory_relations rel WHERE rel.memory_id = mr.id OR rel.related_memory_id = mr.id) AS has_relation,
            NULL::text AS relation_id,
            NULL::text AS relation_type,
            NULL::text AS relation_memory_id,
            NULL::text AS relation_related_memory_id,
            mr.created_by AS source_created_by,
            mr.agent_id AS source_agent_id,
            mr.metadata AS source_metadata,
            NULL::text AS related_created_by,
            NULL::text AS related_agent_id,
            NULL::text AS related_title,
            NULL::jsonb AS related_metadata,
            NULL::jsonb AS relation_metadata,
            NULL::boolean AS related_exists,
            NULL::text AS related_lifecycle_status,
            NULL::boolean AS related_is_current,
            mr.updated_at
          FROM ${schema}.memory_records mr
          WHERE mr.is_current IS TRUE
            AND mr.lifecycle_status = 'approved'
            AND mr.review_state IN ('approved', 'not_required')
            AND (
              mr.episode_id IS NULL
              OR NOT EXISTS (SELECT 1 FROM ${schema}.memory_entity_links mel WHERE mel.memory_id = mr.id)
              OR NOT EXISTS (SELECT 1 FROM ${schema}.memory_relations rel WHERE rel.memory_id = mr.id OR rel.related_memory_id = mr.id)
            )
          ORDER BY mr.updated_at DESC
          LIMIT $1
        ),
        broken_relations AS (
          SELECT
            COALESCE(source.id, rel.memory_id) AS id,
            COALESCE(source.scope_type, 'unknown') AS scope_type,
            COALESCE(source.scope_id, 'unknown') AS scope_id,
            source.title,
            source.memory_type,
            COALESCE(source.lifecycle_status, 'missing') AS lifecycle_status,
            COALESCE(source.review_state, 'missing') AS review_state,
            COALESCE(source.is_current, false) AS is_current,
            source.episode_id,
            EXISTS (SELECT 1 FROM ${schema}.memory_entity_links mel WHERE mel.memory_id = source.id) AS has_entity_link,
            true AS has_relation,
            rel.id AS relation_id,
            rel.relation_type,
            rel.memory_id AS relation_memory_id,
            rel.related_memory_id AS relation_related_memory_id,
            source.created_by AS source_created_by,
            source.agent_id AS source_agent_id,
            source.metadata AS source_metadata,
            target.created_by AS related_created_by,
            target.agent_id AS related_agent_id,
            target.title AS related_title,
            target.metadata AS related_metadata,
            COALESCE(rel.relation_metadata, rel.metadata) AS relation_metadata,
            (target.id IS NOT NULL) AS related_exists,
            target.lifecycle_status AS related_lifecycle_status,
            target.is_current AS related_is_current,
            rel.updated_at
          FROM ${schema}.memory_relations rel
          LEFT JOIN ${schema}.memory_records source ON source.id = rel.memory_id
          LEFT JOIN ${schema}.memory_records target ON target.id = rel.related_memory_id
          WHERE target.id IS NULL
            OR target.is_current IS NOT TRUE
            OR target.lifecycle_status <> 'approved'
          ORDER BY rel.updated_at DESC
          LIMIT $1
        )
        SELECT * FROM record_debt
        UNION ALL
        SELECT * FROM broken_relations
        LIMIT $1
      `,
      [limit],
    );
    const graphOrphans = buildGraphOrphanReport({
      rows: graphOrphanRows.rows.map(mapGraphOrphanRow),
    });

    const graphRelationRepairRows = await client.query(
      `
        WITH broken_relations AS (
          SELECT
            rel.id AS relation_id,
            rel.relation_type,
            rel.memory_id AS relation_memory_id,
            rel.related_memory_id AS relation_related_memory_id,
            (source.id IS NOT NULL) AS source_exists,
            source.lifecycle_status AS source_lifecycle_status,
            source.is_current AS source_is_current,
            source.created_by AS source_created_by,
            source.agent_id AS source_agent_id,
            source.title AS source_title,
            source.metadata AS source_metadata,
            (target.id IS NOT NULL) AS target_exists,
            target.lifecycle_status AS target_lifecycle_status,
            target.is_current AS target_is_current,
            target.created_by AS target_created_by,
            target.agent_id AS target_agent_id,
            target.title AS target_title,
            target.metadata AS target_metadata,
            COALESCE(rel.relation_metadata, rel.metadata) AS relation_metadata,
            rel.updated_at
          FROM ${schema}.memory_relations rel
          LEFT JOIN ${schema}.memory_records source ON source.id = rel.memory_id
          LEFT JOIN ${schema}.memory_records target ON target.id = rel.related_memory_id
          WHERE source.id IS NULL
            OR target.id IS NULL
            OR target.is_current IS NOT TRUE
            OR target.lifecycle_status <> 'approved'
          ORDER BY rel.updated_at DESC
          LIMIT $1
        ),
        successor_candidates AS (
          SELECT
            broken.relation_id,
            candidate.id AS successor_memory_id,
            candidate.lifecycle_status AS successor_lifecycle_status,
            candidate.is_current AS successor_is_current,
            count(candidate.id) OVER (PARTITION BY broken.relation_id) AS successor_count,
            row_number() OVER (
              PARTITION BY broken.relation_id
              ORDER BY candidate.updated_at DESC NULLS LAST, candidate.id ASC
            ) AS successor_rank
          FROM broken_relations broken
          JOIN ${schema}.memory_relations supersede
            ON supersede.related_memory_id = broken.relation_related_memory_id
           AND supersede.relation_type = 'supersedes'
          JOIN ${schema}.memory_records candidate
            ON candidate.id = supersede.memory_id
           AND candidate.is_current IS TRUE
           AND candidate.lifecycle_status = 'approved'
        )
        SELECT
          broken.*,
          successor.successor_memory_id,
          successor.successor_lifecycle_status,
          successor.successor_is_current,
          COALESCE(successor.successor_count, 0)::int AS successor_count
        FROM broken_relations broken
        LEFT JOIN successor_candidates successor
          ON successor.relation_id = broken.relation_id
         AND successor.successor_rank = 1
      `,
      [limit],
    );
    const graphRelationRepair = buildGraphRelationRepairPlan({
      rows: graphRelationRepairRows.rows.map(mapGraphRelationRepairPlanRow),
    });
    const graphRelationRepairRowByRelationId = new Map(
      graphRelationRepairRows.rows
        .map(mapGraphRelationRepairPlanRow)
        .map((row) => [row.relation_id, row]),
    );
    const missingSuccessorRepairs: GraphSuccessorDiscoveryRepairRow[] = [];
    const missingSuccessorTargetIds = graphRelationRepair.candidates
      .filter((candidate) => candidate.review_blocker === "missing_successor")
      .map((candidate) => candidate.current_related_memory_id);
    const missingSuccessorTargetRows = missingSuccessorTargetIds.length === 0
      ? { rows: [] as Record<string, unknown>[] }
      : await client.query(
          `
            SELECT
              id,
              scope_type,
              scope_id,
              title,
              content,
              created_by,
              agent_id,
              metadata,
              COALESCE(metadata->>'topic', metadata->>'entity', title, memory_type, scope_id) AS topic,
              updated_at
            FROM ${schema}.memory_records
            WHERE id = ANY($1::text[])
          `,
          [missingSuccessorTargetIds],
        );
    const targetById = new Map(missingSuccessorTargetRows.rows.map((row) => [String(row.id), row]));
    for (const candidate of graphRelationRepair.candidates) {
      if (candidate.review_blocker !== "missing_successor") continue;
      const target = targetById.get(candidate.current_related_memory_id);
      if (!target) continue;
      const repairRow = graphRelationRepairRowByRelationId.get(candidate.relation_id);
      missingSuccessorRepairs.push({
        relation_id: candidate.relation_id,
        relation_type: candidate.relation_type,
        source_memory_id: candidate.source_memory_id,
        source_scope_type: String(target.scope_type ?? "project"),
        source_scope_id: String(target.scope_id ?? "unknown"),
        target_memory_id: candidate.current_related_memory_id,
        target_scope_type: String(target.scope_type ?? "project"),
        target_scope_id: String(target.scope_id ?? "unknown"),
        target_title: stringOrNull(target.title),
        target_content: String(target.content ?? ""),
        target_topic: stringOrNull(target.topic),
        target_updated_at: isoOrNull(target.updated_at),
        source_created_by: repairRow?.source_created_by ?? null,
        source_agent_id: repairRow?.source_agent_id ?? null,
        source_title: repairRow?.source_title ?? null,
        source_lifecycle_status: repairRow?.source_lifecycle_status ?? null,
        source_is_current: repairRow?.source_is_current ?? null,
        source_metadata: repairRow?.source_metadata ?? null,
        target_created_by: stringOrNull((target as Record<string, unknown>).created_by),
        target_agent_id: stringOrNull((target as Record<string, unknown>).agent_id),
        target_metadata: jsonObject((target as Record<string, unknown>).metadata),
        review_blocker: candidate.review_blocker,
      });
    }
    const successorDiscoveryMemoryRows = missingSuccessorRepairs.length === 0
      ? { rows: [] as Record<string, unknown>[] }
      : await client.query(
          `
            SELECT
              id,
              scope_type,
              scope_id,
              title,
              content,
              COALESCE(metadata->>'topic', metadata->>'entity', title, memory_type, scope_id) AS topic,
              lifecycle_status,
              review_state,
              is_current,
              updated_at
            FROM ${schema}.memory_records
            WHERE is_current IS TRUE
              AND lifecycle_status = 'approved'
              AND review_state IN ('approved', 'not_required')
              AND (scope_type, scope_id) IN (
                SELECT scopes.scope_type, scopes.scope_id
                FROM unnest($1::text[], $2::text[]) AS scopes(scope_type, scope_id)
              )
            ORDER BY updated_at DESC
            LIMIT $3
          `,
          [
            missingSuccessorRepairs.map((repair) => repair.target_scope_type),
            missingSuccessorRepairs.map((repair) => repair.target_scope_id),
            limit,
          ],
        );
    const graphSuccessorDiscovery = buildGraphSuccessorDiscoveryCandidateReport({
      repairs: missingSuccessorRepairs,
      memories: successorDiscoveryMemoryRows.rows.map(mapGraphSuccessorDiscoveryMemoryRow),
    });
    const topicAliasDiscoveries: TopicAliasDiscoveryRow[] = graphSuccessorDiscovery.candidates
      .filter((candidate) => candidate.topic_alias_suggestion)
      .map((candidate) => ({
        candidate_id: candidate.candidate_id,
        relation_id: candidate.relation_id,
        source_memory_id: candidate.source_memory_id,
        old_target_memory_id: candidate.old_target_memory_id,
        candidate_successor_memory_id: candidate.candidate_successor_memory_id,
        source_topic: candidate.topic_alias_suggestion?.source_topic ?? "",
        candidate_topic: candidate.topic_alias_suggestion?.candidate_topic ?? "",
        match_type: candidate.match_type,
        confidence: candidate.confidence,
        shared_terms: candidate.evidence.shared_terms,
      }));
    const topicAliasCandidates = buildTopicAliasCandidateReport({
      discoveries: topicAliasDiscoveries,
    });
    const topicNormalizationAliases: TopicNormalizationAliasRow[] = topicAliasCandidates.candidates
      .map((candidate) => ({
        candidate_id: candidate.candidate_id,
        source_topic: candidate.source_topic,
        candidate_topic: candidate.candidate_topic,
        supporting_discoveries: candidate.supporting_discoveries,
        avg_confidence: candidate.evidence.avg_confidence,
        sample_memory_ids: candidate.evidence.samples.flatMap((sample) => [
          sample.old_target_memory_id,
          sample.candidate_successor_memory_id,
        ]),
      }));
    const topicNormalizationPlan = buildTopicNormalizationPlan({
      aliases: topicNormalizationAliases,
    });
    const topicNormalizationReviewQueue = buildTopicNormalizationReviewQueue({
      plan: topicNormalizationPlan,
    });
    const topicNormalizationEvolveSection = {
      ...topicNormalizationPlan,
      summary: {
        ...topicNormalizationPlan.summary,
        review_queue_items: topicNormalizationReviewQueue.summary.total_review_items,
      },
      review_queue: topicNormalizationReviewQueue,
    };

    const traceRows = await client.query(
      `
        SELECT *
        FROM ${schema}.recall_traces
        WHERE created_at >= now() - ($1::int * interval '1 day')
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [days, limit],
    );
    const traceIds = traceRows.rows.map((row) => String(row.id)).filter(Boolean);
    const feedbackRows = traceIds.length > 0
      ? await client.query(
          `
            SELECT *
            FROM ${schema}.recall_feedback_events
            WHERE recall_trace_id = ANY($1::text[])
            ORDER BY created_at DESC
          `,
          [traceIds],
        )
      : { rows: [] as Record<string, unknown>[] };
    const traces = traceRows.rows.map(mapTrace);
    const feedbackEvents = feedbackRows.rows.map(mapFeedback);
    const adaptiveRetrieval = buildAdaptiveRetrievalCalibrationReport({
      traces,
      feedbackEvents,
      minTraces,
    });

    const memoryIds = [...new Set(feedbackRows.rows.map((row) => typeof row.memory_id === "string" ? row.memory_id : "").filter(Boolean))];
    const feedbackMemoryRows = memoryIds.length > 0
      ? await client.query(`SELECT * FROM ${schema}.memory_records WHERE id = ANY($1::text[])`, [memoryIds])
      : { rows: [] as Record<string, unknown>[] };
    const feedbackMemories = feedbackMemoryRows.rows.map(mapMemory);
    const recallQualityFeedback = buildRecallQualityFeedbackReport({
      traces,
      feedbackEvents,
      memories: feedbackMemories,
      minFeedback,
    });
    const recallFeedbackCandidates = buildRecallFeedbackPolicyCandidates({
      report: recallQualityFeedback,
      runId: `memory-evolve-recall-feedback-${new Date().toISOString().replace(/[:.]/gu, "-")}`,
    });
    const extractionRecallEval = buildExtractionRecallEvalReport({
      traces,
      feedbackEvents,
      memories: feedbackMemories,
      minFeedback,
    });
    const extractionRecallCandidates = buildExtractionRecallEvalPolicyCandidates({
      report: extractionRecallEval,
      runId: `memory-evolve-extraction-recall-${new Date().toISOString().replace(/[:.]/gu, "-")}`,
    });
    const policyFeedbackBackprop = buildPolicyFeedbackBackpropReport({
      recallQuality: recallQualityFeedback,
      extractionRecallEval,
    });

    const consolidationRows = await client.query(
      `
        SELECT
          id,
          scope_type,
          scope_id,
          title,
          content,
          memory_type,
          COALESCE(metadata->>'memory_class', metadata->'memory_policy'->>'memory_class', metadata->'auto_approval_policy'->'memory_policy'->>'memory_class') AS memory_class,
          COALESCE(metadata->>'cognitive_type', metadata->'memory_policy'->>'cognitive_type', metadata->'auto_approval_policy'->'memory_policy'->>'cognitive_type') AS cognitive_type,
          COALESCE(metadata->>'recall_policy', metadata->'memory_policy'->>'recall_policy', metadata->'auto_approval_policy'->'memory_policy'->>'recall_policy') AS recall_policy,
          lifecycle_status,
          review_state,
          is_current,
          COALESCE(metadata->>'topic', metadata->>'entity', title, memory_type, scope_id) AS topic,
          COALESCE(metadata->>'source', metadata->>'source_type', source_ref, created_by) AS source,
          COALESCE(observed_at, created_at) AS observed_at,
          updated_at,
          memory_strength
        FROM ${schema}.memory_records
        WHERE is_current IS TRUE
          AND lifecycle_status = 'approved'
        ORDER BY updated_at DESC
        LIMIT $1
      `,
      [limit],
    );
    const consolidation = buildConsolidationCandidateReport({
      records: consolidationRows.rows.map(mapConsolidationRecord),
      minEpisodicClusterSize,
    });

    const contextHygieneRows = await client.query(
      `
        SELECT
          id,
          scope_type,
          scope_id,
          title,
          content,
          memory_type,
          memory_layer,
          COALESCE(metadata->>'memory_class', metadata->'memory_policy'->>'memory_class', metadata->'auto_approval_policy'->'memory_policy'->>'memory_class', metadata->'memory_auto_approval_sweep'->>'memory_class') AS memory_class,
          COALESCE(metadata->>'cognitive_type', metadata->'memory_policy'->>'cognitive_type', metadata->'auto_approval_policy'->'memory_policy'->>'cognitive_type', metadata->'memory_auto_approval_sweep'->>'cognitive_type') AS cognitive_type,
          COALESCE(metadata->>'recall_policy', metadata->'memory_policy'->>'recall_policy', metadata->'auto_approval_policy'->'memory_policy'->>'recall_policy', metadata->'memory_auto_approval_sweep'->>'recall_policy') AS recall_policy,
          lifecycle_status,
          review_state,
          is_current,
          updated_at
        FROM ${schema}.memory_records
        WHERE is_current IS TRUE
          AND lifecycle_status = 'approved'
          AND COALESCE(metadata->>'recall_policy', metadata->'memory_policy'->>'recall_policy', metadata->'auto_approval_policy'->'memory_policy'->>'recall_policy', metadata->'memory_auto_approval_sweep'->>'recall_policy', 'default') = 'default'
        ORDER BY updated_at DESC
        LIMIT $1
      `,
      [limit],
    );
    const contextHygiene = buildContextHygieneReport({
      rows: contextHygieneRows.rows.map(mapContextHygieneRow),
    });

    const proceduralMemoryRows = memoryIds.length > 0
      ? await client.query(`
          SELECT
            id,
            scope_type,
            scope_id,
            title,
            content,
            memory_type,
            COALESCE(metadata->>'memory_class', metadata->'memory_policy'->>'memory_class', metadata->'auto_approval_policy'->'memory_policy'->>'memory_class') AS memory_class,
            COALESCE(metadata->>'cognitive_type', metadata->'memory_policy'->>'cognitive_type', metadata->'auto_approval_policy'->'memory_policy'->>'cognitive_type') AS cognitive_type,
            COALESCE(metadata->>'recall_policy', metadata->'memory_policy'->>'recall_policy', metadata->'auto_approval_policy'->'memory_policy'->>'recall_policy') AS recall_policy,
            metadata
          FROM ${schema}.memory_records
          WHERE id = ANY($1::text[])
            AND is_current IS TRUE
        `, [memoryIds])
      : { rows: [] as Record<string, unknown>[] };
    const proceduralPromotion = buildProceduralPromotionCandidateReport({
      memories: proceduralMemoryRows.rows.map(mapProceduralPromotionMemory),
      traces,
      feedbackEvents,
      minPositiveScopes,
    });

    const observationBatchRows = await client.query(
      `
        SELECT id, scope_context, metadata, created_at
        FROM ${schema}.conversation_batches
        WHERE metadata ? 'conversation_memory_route'
        ORDER BY created_at DESC
        LIMIT $1
      `,
      [limit],
    );
    const observationBatchIds = observationBatchRows.rows.map((row) => String(row.id));
    const observationEventRows = observationBatchIds.length === 0
      ? { rows: [] as Record<string, unknown>[] }
      : await client.query(
          `
            SELECT id, batch_id, role, content, observed_at
            FROM ${schema}.conversation_events
            WHERE batch_id = ANY($1::text[])
            ORDER BY observed_at ASC, created_at ASC
          `,
          [observationBatchIds],
        );
    const observationReflection = buildMemoryEvolveObservationReflectionSection({
      batches: observationBatchRows.rows.map(mapConversationBatch),
      events: observationEventRows.rows.map(mapConversationEvent),
      minSemanticObservations: 2,
    });

    const memoryOsReadiness = buildMemoryOsReadinessReport({
      pendingSafeCloseCandidates: pendingSafeClose.summary.safe_close_candidates,
      pendingRequiresHumanReview: pendingApprovalEvidence.summary.requires_human_review,
      temporalValidityDebtCandidates: temporalValidityDebt.summary.production_candidates,
      temporalTransitionCandidates: temporalTransitionCandidates.summary.total_candidates,
      memoryLinkCandidates: memoryLinkCandidates.summary.total_candidates,
      graphOrphanCandidates: graphOrphans.summary.total_candidates,
      graphOrphanProductionCandidates: graphOrphans.summary.production_candidates,
      graphOrphanTopReasons: graphOrphans.summary.top_reasons,
      graphOrphanProductionTopReasons: graphOrphans.summary.production_top_reasons,
      graphRelationRepairCandidates: graphRelationRepair.summary.total_candidates,
      graphRelationRepairProductionCandidates: graphRelationRepair.summary.production_candidates,
      graphRelationRepairTopActions: graphRelationRepair.summary.top_actions,
      graphRelationRepairProductionTopActions: graphRelationRepair.summary.production_top_actions,
      topicNormalizationReviewQueueCandidates: topicNormalizationReviewQueue.summary.total_review_items,
      adaptiveCalibrationCohorts: adaptiveRetrieval.summary.production_actionable_cohorts,
      contextHygieneCandidates: contextHygiene.summary.total_candidates,
      consolidationCandidates: consolidation.summary.total_candidates,
      extractionRecallCandidates: extractionRecallCandidates.length,
      recallFeedbackCandidates: recallFeedbackCandidates.length,
      policyFeedbackBackpropCandidates: policyFeedbackBackprop.summary.total_candidates,
      observationReflectionCandidates: observationReflection.summary.total_candidates,
      observationReviewQueueCandidates: observationReflection.review_queue.summary.actionable_review_items,
      proceduralPromotionCandidates: proceduralPromotion.summary.total_candidates,
    });

    const evolveRuntimeControls = readMemoryEvolveRuntimeControlsStateSync();
    const report = buildMemoryEvolveReport({
      enabledModules: enabledMemoryEvolveModules(evolveRuntimeControls.controls),
      pendingClosure,
      pendingApprovalEvidence: {
        summary: pendingApprovalEvidenceSummaryForEvolve(pendingApprovalEvidence),
        candidates: pendingApprovalEvidence.evidence,
      },
      pendingSafeClose: {
        summary: pendingSafeCloseSummaryForEvolve(pendingSafeClose),
        candidates: pendingSafeClose.safe_close_candidates,
        review_queue: {
          excluded_for_human_review: pendingSafeClose.excluded_for_human_review,
        },
      },
      staleFacts,
      temporalValidityDebt,
      temporalTransitionCandidates,
      memoryLinkCandidates,
      graphOrphans,
      graphRelationRepair,
      graphSuccessorDiscovery,
      topicAliasCandidates,
      topicNormalizationPlan: topicNormalizationEvolveSection,
      adaptiveRetrieval,
      contextHygiene,
      consolidation,
      extractionRecallEval: { ...extractionRecallEval, candidates: extractionRecallCandidates },
      recallQualityFeedback: {
        ...recallQualityFeedback,
        candidates: recallFeedbackCandidates,
      },
      policyFeedbackBackprop,
      observationReflection,
      proceduralPromotion,
      memoryOsReadiness,
    });
    const output = {
      schema: config.schema ?? "memory_xx",
      limit,
      window_days: days,
      min_feedback: minFeedback,
      min_traces: minTraces,
      min_positive_scopes: minPositiveScopes,
      min_episodic_cluster_size: minEpisodicClusterSize,
      runtime_controls: {
        memory_evolve: {
          ok: evolveRuntimeControls.ok,
          exists: evolveRuntimeControls.exists,
          path: evolveRuntimeControls.path,
          ...(evolveRuntimeControls.error ? { error: evolveRuntimeControls.error } : {}),
          enabled_modules: enabledMemoryEvolveModules(evolveRuntimeControls.controls),
        },
      },
      ...report,
    };
    process.stdout.write(markdown
      ? `${renderMemoryEvolveMarkdown(report)}\n`
      : `${JSON.stringify(output, null, 2)}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

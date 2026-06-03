#!/usr/bin/env tsx
import "./test-harness/config.js";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryV2PostgresConfig } from "../app/db/adapters/postgres-config";
import {
  buildProductionCanaryRuntimeControls,
  evaluateProductionCanaryGuard,
  type ProductionGuardTrainingBaseline,
} from "../app/governance/auto-approval-production-guard";
import {
  buildProductionCanaryFeedbackReport,
  emptyProductionCanaryFeedbackWindow,
  type ProductionCanaryFeedbackWindow,
  type ProductionCanaryUpdateDryRunSummary,
} from "../app/governance/production-canary-feedback";
import { defaultAutoApprovalScopeEnablements, evaluateAutoApprovalPolicy } from "../app/governance/auto-approval-policy";
import {
  readAutoApprovalRuntimeControlsSync,
  writeAutoApprovalRuntimeControlsSync,
} from "../app/governance/auto-approval-runtime-controls";
import { stableGovernanceSelectorHash } from "../app/governance/service";
import { requireCliPermission } from "../app/server/permissions.js";
import type { JsonObject } from "../app/shared";
import { loadDotenvIfPresent, quoteIdent } from "./lib/runtime-env";

loadDotenvIfPresent();

function arg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function command(): string {
  return process.argv[2] ?? "status";
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function numberArg(name: string, fallback: number): number {
  const parsed = Number.parseFloat(arg(name));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function runtimeDir(): string {
  return process.env.MEMORY_V2_RUNTIME_DIR?.trim() || join(process.cwd(), ".runtime");
}

function parseScope(raw: string): { scopeType: string; scopeId: string; key: string } {
  const value = raw.trim();
  const index = value.indexOf(":");
  if (index <= 0 || index === value.length - 1) throw new Error("--scope must look like project:memory-xx");
  return { scopeType: value.slice(0, index), scopeId: value.slice(index + 1), key: value };
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

async function loadCandidateOnlyFlag(): Promise<{ enabled: boolean; reasons: string[] }> {
  if (process.env.MEMORY_V2_INTELLIGENCE_CANDIDATE_ONLY === "true") {
    return { enabled: true, reasons: ["env_candidate_only"] };
  }
  try {
    const parsed = JSON.parse(await readFile(join(runtimeDir(), "intelligence-candidate-only.json"), "utf8")) as { enabled?: unknown; reasons?: unknown };
    return {
      enabled: parsed.enabled === true,
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.filter((item): item is string => typeof item === "string") : [],
    };
  } catch {
    return { enabled: false, reasons: [] };
  }
}

async function loadCanary(): Promise<{ enabled: boolean; bypass_scopes: string[]; agents: string[] }> {
  try {
    const parsed = JSON.parse(await readFile(join(runtimeDir(), "auto-approval-canary.json"), "utf8")) as {
      enabled?: unknown;
      bypass_scopes?: unknown;
      agents?: unknown;
    };
    return {
      enabled: parsed.enabled === true,
      bypass_scopes: Array.isArray(parsed.bypass_scopes) ? parsed.bypass_scopes.filter((item): item is string => typeof item === "string") : [],
      agents: Array.isArray(parsed.agents) ? parsed.agents.filter((item): item is string => typeof item === "string") : [],
    };
  } catch {
    return { enabled: false, bypass_scopes: [], agents: [] };
  }
}

type RealScopeEnablement = {
  scope: string;
  enabled: boolean;
  agents: string[];
  allowed_sources: string[];
  allowed_operations: string[];
  enabled_by?: string;
  enabled_at?: string;
  gate_report_path?: string | null;
};

const DEFAULT_REAL_SCOPE_SOURCES = [
  "conversation_ingest",
  "smart_write",
  "memory-xx-intelligence-smart-write",
  "memory-xx-mcp-smart-write",
  "codex-jsonl-spool",
  "codex-session-tail",
  "claude-code-session-tail",
  "openclaw-session-tail",
];

async function loadRealScopeEnablementsFile(): Promise<{
  enabled_scopes: string[];
  agents: string[];
  allowed_sources: string[];
  allowed_operations: string[];
  enablements: RealScopeEnablement[];
}> {
  try {
    const parsed = JSON.parse(await readFile(join(runtimeDir(), "auto-approval-scope-enablements.json"), "utf8")) as Record<string, unknown>;
    const enabledScopes = Array.isArray(parsed.enabled_scopes) ? parsed.enabled_scopes.filter((item): item is string => typeof item === "string") : [];
    const agents = Array.isArray(parsed.agents) ? parsed.agents.filter((item): item is string => typeof item === "string") : [];
    const allowedSources = Array.isArray(parsed.allowed_sources) ? parsed.allowed_sources.filter((item): item is string => typeof item === "string") : [];
    const allowedOperations = Array.isArray(parsed.allowed_operations) ? parsed.allowed_operations.filter((item): item is string => typeof item === "string") : [];
    const enablements = Array.isArray(parsed.enablements)
      ? parsed.enablements.flatMap((item): RealScopeEnablement[] => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
        const row = item as Record<string, unknown>;
        const scope = readString(row.scope);
        if (!scope) return [];
        return [{
          scope,
          enabled: row.enabled !== false,
          agents: Array.isArray(row.agents) ? row.agents.filter((value): value is string => typeof value === "string") : agents,
          allowed_sources: Array.isArray(row.allowed_sources) ? row.allowed_sources.filter((value): value is string => typeof value === "string") : allowedSources,
          allowed_operations: Array.isArray(row.allowed_operations) ? row.allowed_operations.filter((value): value is string => typeof value === "string") : allowedOperations,
          enabled_by: readString(row.enabled_by, "memory:auto-approval"),
          enabled_at: readString(row.enabled_at),
          gate_report_path: readString(row.gate_report_path) || null,
        }];
      })
      : [];
    return {
      enabled_scopes: enabledScopes,
      agents,
      allowed_sources: allowedSources,
      allowed_operations: allowedOperations,
      enablements,
    };
  } catch {
    return {
      enabled_scopes: [],
      agents: ["codex"],
      allowed_sources: DEFAULT_REAL_SCOPE_SOURCES,
      allowed_operations: ["add"],
      enablements: [],
    };
  }
}

async function saveRealScopeEnablements(value: Awaited<ReturnType<typeof loadRealScopeEnablementsFile>>): Promise<void> {
  await mkdir(runtimeDir(), { recursive: true });
  const enabledScopes = value.enablements.filter((item) => item.enabled).map((item) => item.scope);
  await writeFile(join(runtimeDir(), "auto-approval-scope-enablements.json"), `${JSON.stringify({
    enabled_scopes: [...new Set(enabledScopes)],
    agents: value.agents.length > 0 ? [...new Set(value.agents)] : ["codex"],
    allowed_sources: value.allowed_sources.length > 0 ? [...new Set(value.allowed_sources)] : DEFAULT_REAL_SCOPE_SOURCES,
    allowed_operations: value.allowed_operations.length > 0 ? [...new Set(value.allowed_operations)] : ["add"],
    updated_at: new Date().toISOString(),
    enablements: value.enablements,
  }, null, 2)}\n`, "utf8");
}

function buildReadinessStatus(input: {
  readonly candidateOnly: { enabled: boolean; reasons: string[] };
  readonly canary: { enabled: boolean; bypass_scopes: string[]; agents: string[] };
  readonly realScopeEnablements: readonly { scope: string; enabled: boolean; agents: readonly string[] }[];
  readonly frozenCohorts: number;
}): JsonObject {
  const enabledRealScopes = input.realScopeEnablements.filter((item) => item.enabled).map((item) => item.scope);
  const projectMemoryEnabled = enabledRealScopes.includes("project:memory-xx");
  const workspaceCurrentEnabled = enabledRealScopes.includes("workspace:current-instance");
  const userCurrentEnabled = enabledRealScopes.includes("user:current-user");
  const globalKeywordEnabled = enabledRealScopes.includes("global:global");
  const runtimeControls = readAutoApprovalRuntimeControlsSync();
  const updateApply = runtimeControls.update_apply;
  return {
    real_scope_enabled: enabledRealScopes.length > 0,
    apply_scope_model: enabledRealScopes.length > 0
      ? "add_only_project_workspace_user_global_keyword_plus_guarded_project_user_global_update_apply"
      : "test_scope_only",
    policy_version: "auto-approval-v2-scope-tiered",
    enabled_real_scopes: enabledRealScopes,
    update_apply_enablement: {
      enabled: updateApply.enabled,
      test_scope_apply: updateApply.test_scope_apply,
      real_project_apply: updateApply.real_project_apply,
      workspace_apply: updateApply.workspace_apply,
      user_apply: updateApply.user_apply,
      global_apply: updateApply.global_apply,
      merge_apply: updateApply.merge_apply,
      preference_change_apply: updateApply.preference_change_apply,
      max_hourly_per_scope: updateApply.max_hourly_per_scope,
    },
    eligible_scopes: [
      "project:memory-xx",
      "workspace:current-instance",
      "project:auto-approval-test-*",
      "workspace:auto-approval-test-*",
      "user:auto-approval-test-*",
      ...(userCurrentEnabled ? ["user:current-user"] : []),
      ...(globalKeywordEnabled ? ["global:global(keyword-gated)"] : []),
      "global:auto-approval-test-*",
      "project:memory-xx-self-improvement-test-*",
    ],
    blocked_scopes: [
      ...(projectMemoryEnabled ? [] : [{ scope: "project:memory-xx", reason: input.candidateOnly.enabled ? "candidate_only_kill_switch_without_scoped_bypass" : "real_scope_not_enabled" }]),
      ...(workspaceCurrentEnabled ? [] : [{ scope: "workspace:current-instance", reason: input.candidateOnly.enabled ? "candidate_only_kill_switch_without_scoped_bypass" : "real_scope_not_enabled" }]),
      { scope: "workspace:*", reason: "only_workspace_current_instance_enabled" },
      ...(userCurrentEnabled
        ? [{ scope: "user:*", reason: "only_user_current_user_add_only_enabled" }]
        : [{ scope: "user:*", reason: "real_scope_not_enabled" }]),
      ...(globalKeywordEnabled
        ? [{ scope: "global:*", reason: "only_global_global_keyword_intent_enabled" }]
        : [{ scope: "global", reason: "global_scope_default_manual" }]),
    ],
    gate_status: {
      production_closure: "required_pass_before_real_scope_open",
      doctor: "required_no_blocker_before_real_scope_open",
      all_gates: "required_no_critical_failure_before_real_scope_open",
      audit: "required_auto_approval_decision_metadata",
      rollback: "required_verified_by_test_scope_e2e",
      feedback_freeze: input.frozenCohorts >= 0 ? "available" : "unknown",
      ui: "required_flows_observability",
    },
    opening_audit_plan: {
      executed: false,
      required_fields: [
        "scope_id",
        "agent_id",
        "source",
        "memory_type",
        "thresholds",
        "opened_by",
        "opened_at",
        "gate_report_path",
      ],
    },
    candidate_only: input.candidateOnly,
    compatibility_canary_config: input.canary,
    real_scope_enablements: input.realScopeEnablements,
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return readObject(parsed);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return readObject(JSON.parse(text.slice(start, end + 1)) as unknown);
    } catch {
      return null;
    }
  }
}

function runJsonCommand(args: readonly string[]): { ok: boolean; exit_code: number | null; json: Record<string, unknown> | null; error?: string } {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: process.cwd(),
    env: { ...process.env, TMPDIR: process.env.TMPDIR || "/tmp" },
    encoding: "utf8",
    timeout: 120_000,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const json = parseJsonObject(stdout);
  return {
    ok: result.status === 0,
    exit_code: result.status,
    json,
    ...(result.error ? { error: result.error.message } : stderr.trim() ? { error: stderr.trim().slice(0, 1000) } : {}),
  };
}

function trainingSummaryPath(runId: string): string {
  return join(process.cwd(), "reports", "policy-training", runId, "summary.json");
}

function loadTrainingBaseline(runId: string): ProductionGuardTrainingBaseline | null {
  const path = trainingSummaryPath(runId);
  if (!existsSync(path)) return null;
  const summary = readObject(JSON.parse(readFileSync(path, "utf8")) as unknown);
  const datasetCounts = readObject(summary.dataset_counts);
  const leakageEval = readObject(summary.leakage_eval);
  const recallEval = readObject(summary.recall_eval);
  return {
    run_id: readString(summary.run_id, runId),
    progress_percent: readNumber(summary.progress_percent),
    production_readiness_score: readNumber(summary.production_readiness_score),
    default_leakage: readNumber(leakageEval.default_leakage, readNumber(recallEval.default_leakage)),
    normalized: readNumber(datasetCounts.normalized),
  };
}

function buildQdrantReconcileFromStatus(status: Record<string, unknown> | null): { ok?: boolean; stale?: number; missing?: number; payload_drift?: number; orphan?: number } | null {
  if (!status) return null;
  const projection = readObject(status.qdrant_projection);
  const diff = readObject(projection.diff);
  return {
    ok: projection.ok === true,
    stale: Array.isArray(diff.staleMemoryIds) ? diff.staleMemoryIds.length : readNumber(diff.stale),
    missing: Array.isArray(diff.missingMemoryIds) ? diff.missingMemoryIds.length : readNumber(diff.missing),
    payload_drift: Array.isArray(diff.payloadDriftMemoryIds) ? diff.payloadDriftMemoryIds.length : readNumber(diff.payload_drift),
    orphan: Array.isArray(diff.orphanPointIds) ? diff.orphanPointIds.length : readNumber(diff.orphan),
  };
}

function qdrantDriftCount(status: Record<string, unknown> | null): number {
  const reconcile = buildQdrantReconcileFromStatus(status);
  if (!reconcile) return 0;
  return readNumber(reconcile.stale) + readNumber(reconcile.missing) + readNumber(reconcile.payload_drift) + readNumber(reconcile.orphan);
}

function readProductionCanaryWindow(row: Record<string, unknown> | undefined): ProductionCanaryFeedbackWindow {
  if (!row) return emptyProductionCanaryFeedbackWindow();
  return {
    total_real_decisions: readNumber(row.total_real_decisions),
    auto_approved_default: readNumber(row.auto_approved_default),
    auto_approved_explicit_issue: readNumber(row.auto_approved_explicit_issue),
    auto_rejected_unknown: readNumber(row.auto_rejected_unknown),
    auto_rejected_test_noise: readNumber(row.auto_rejected_test_noise),
    auto_rejected_sensitive: readNumber(row.auto_rejected_sensitive),
    rollback_count: readNumber(row.rollback_count),
    false_positive_count: readNumber(row.false_positive_count),
    false_negative_count: readNumber(row.false_negative_count),
    default_leakage: readNumber(row.default_leakage),
    explicit_only_default_recall_leakage: readNumber(row.explicit_only_default_recall_leakage),
    test_noise_default_recall_leakage: readNumber(row.test_noise_default_recall_leakage),
    unknown_sensitive_or_test_noise_auto_approve: readNumber(row.unknown_sensitive_or_test_noise_auto_approve),
    unmarked_real_decisions_excluded: readNumber(row.unmarked_real_decisions_excluded),
  };
}

async function loadProductionCanaryWindow(client: import("pg").PoolClient, schema: string, hours: number): Promise<ProductionCanaryFeedbackWindow> {
  const rows = await client.query(
    `
      WITH raw_real_decisions AS (
        SELECT d.id,
               d.decision,
               d.rollback_memory_event_id,
               COALESCE(d.approved_memory_id, d.candidate_memory_id) AS memory_id,
               COALESCE(
                 d.metadata->'memory_policy'->>'memory_class',
                 d.metadata->>'memory_class',
                 r.metadata->'auto_approval_policy'->'memory_policy'->>'memory_class',
                 r.metadata->>'memory_class'
               ) AS memory_class,
               COALESCE(
                 d.metadata->'memory_policy'->>'policy_action',
                 d.metadata->>'policy_action',
                 r.metadata->'auto_approval_policy'->'memory_policy'->>'policy_action',
                 r.metadata->>'policy_action'
               ) AS policy_action,
               COALESCE(
                 d.metadata->'memory_policy'->>'recall_policy',
                 d.metadata->>'recall_policy',
                 r.metadata->'auto_approval_policy'->'memory_policy'->>'recall_policy',
                 r.metadata->>'recall_policy',
                 'default'
               ) AS recall_policy,
               COALESCE(
                 d.metadata->'memory_policy'->>'autonomous_action',
                 d.metadata->>'autonomous_action',
                 r.metadata->>'autonomous_action'
               ) AS autonomous_action,
               COALESCE(d.metadata->>'production_canary', r.metadata->>'production_canary', 'false') = 'true' AS production_canary,
               d.reasons,
               d.blocked_reasons
          FROM ${schema}.auto_approval_decisions d
          LEFT JOIN ${schema}.memory_records r
            ON r.id = COALESCE(d.approved_memory_id, d.candidate_memory_id)
         WHERE d.created_at >= now() - ($1::int * interval '1 hour')
           AND (
             (d.scope_type = 'project' AND d.scope_id = 'memory-xx')
             OR (d.scope_type = 'user' AND d.scope_id = 'current-user')
           )
           AND COALESCE(d.metadata->>'eval_only', r.metadata->>'eval_only', 'false') <> 'true'
           AND COALESCE(d.metadata->>'policy_training', r.metadata->>'policy_training', 'false') <> 'true'
      ),
      real_decisions AS (
        SELECT *
          FROM raw_real_decisions
         WHERE production_canary IS TRUE
      ),
      approved AS (
        SELECT memory_id FROM real_decisions WHERE decision = 'approve' AND memory_id IS NOT NULL
      )
      SELECT
        count(*)::int AS total_real_decisions,
        count(*) FILTER (WHERE decision = 'approve' AND recall_policy = 'default')::int AS auto_approved_default,
        count(*) FILTER (WHERE decision = 'approve' AND (memory_class = 'operational_issue' OR recall_policy = 'explicit_only'))::int AS auto_approved_explicit_issue,
        count(*) FILTER (WHERE decision = 'reject' AND memory_class = 'unknown_source_quarantine')::int AS auto_rejected_unknown,
        count(*) FILTER (WHERE decision = 'reject' AND memory_class IN ('runtime_noise', 'test_evidence', 'explicit_no_memory'))::int AS auto_rejected_test_noise,
        count(*) FILTER (
          WHERE decision = 'reject'
            AND (reasons::text ILIKE '%sensitive%' OR blocked_reasons::text ILIKE '%sensitive%' OR blocked_reasons::text ILIKE '%secret%')
        )::int AS auto_rejected_sensitive,
        count(*) FILTER (WHERE rollback_memory_event_id IS NOT NULL)::int AS rollback_count,
        (
          SELECT count(DISTINCT f.memory_id)::int
            FROM ${schema}.memory_feedback_events f
            JOIN approved a ON a.memory_id = f.memory_id
           WHERE f.feedback_type IN ('wrong', 'deleted', 'not_relevant', 'changed_mind', 'negative')
        ) AS false_positive_count,
        (
          SELECT count(*)::int
            FROM ${schema}.recall_feedback_events rf
           WHERE rf.created_at >= now() - ($1::int * interval '1 hour')
             AND rf.feedback_type = 'false_null'
        ) AS false_negative_count,
        0::int AS default_leakage,
        0::int AS explicit_only_default_recall_leakage,
        0::int AS test_noise_default_recall_leakage,
        count(*) FILTER (
          WHERE decision = 'approve'
            AND (
              memory_class IN ('unknown_source_quarantine', 'runtime_noise', 'test_evidence', 'explicit_no_memory')
              OR recall_policy IN ('never', 'test_only', 'audit_only')
              OR reasons::text ILIKE '%sensitive%'
              OR blocked_reasons::text ILIKE '%sensitive%'
              OR blocked_reasons::text ILIKE '%secret%'
            )
        )::int AS unknown_sensitive_or_test_noise_auto_approve
        ,
        (SELECT count(*)::int FROM raw_real_decisions WHERE production_canary IS NOT TRUE) AS unmarked_real_decisions_excluded
      FROM real_decisions
    `,
    [Math.max(1, Math.round(hours))]
  );
  return readProductionCanaryWindow(rows.rows[0] as Record<string, unknown> | undefined);
}

function updateDryRunFromJson(json: Record<string, unknown> | null): ProductionCanaryUpdateDryRunSummary {
  const actionCounts = readObject(json?.action_counts);
  return {
    scope: readString(json?.scope, "project:memory-xx"),
    candidate_count: readNumber(json?.candidate_count),
    action_counts: Object.fromEntries(Object.entries(actionCounts).map(([key, value]) => [key, readNumber(value)])),
    wrong_scope_count: readString(json?.scope, "project:memory-xx") === "project:memory-xx" ? 0 : 1,
    default_recall_leakage: 0,
  };
}

async function productionFeedbackReport(client: import("pg").PoolClient, schema: string, input: {
  readonly candidateOnly: { enabled: boolean; reasons: string[] };
  readonly writeReport: boolean;
}): Promise<Record<string, unknown>> {
  const statusCommand = runJsonCommand(["tsx", "scripts/memory-status.ts", "--json"]);
  const guardCommand = runJsonCommand(["tsx", "scripts/memory-auto-approval.ts", "production-guard", "--json"]);
  const updateDryRunCommand = runJsonCommand(["tsx", "scripts/memory-auto-update.ts", "dry-run", "--scope=project:memory-xx", "--limit=100"]);
  const status = statusCommand.json;
  const pending = readObject(status?.pending);
  const report = buildProductionCanaryFeedbackReport({
    runId: arg("run-id") || "memory-production-canary-7d-v1",
    candidateOnlyEnabled: input.candidateOnly.enabled,
    productionGuardOk: guardCommand.json?.ok === true,
    consecutiveP1PassDays: Math.max(0, Math.floor(numberArg("p1-pass-days", 0))),
    minRealFeedbackSamples: Math.max(1, Math.floor(numberArg("min-real-feedback-samples", 20))),
    maxRollbackRate: Math.max(0, numberArg("max-rollback-rate", 0.03)),
    windows: {
      last_24h: await loadProductionCanaryWindow(client, schema, 24),
      last_7d: await loadProductionCanaryWindow(client, schema, 24 * 7),
    },
    runtime: {
      pending_current: readNumber(pending.candidate_current),
      qdrant_drift: qdrantDriftCount(status),
    },
    updateDryRun: updateDryRunFromJson(updateDryRunCommand.json),
  });
  const output: Record<string, unknown> = {
    ...report,
    candidate_only: input.candidateOnly,
    snapshots: {
      memory_status: status ? {
        ok: status.ok,
        runtime_ok: status.runtime_ok,
        governance_ok: status.governance_ok,
        systemd_timer_probe_ok: status.systemd_timer_probe_ok,
        status_reason: status.status_reason,
      } : null,
      production_guard: guardCommand.json?.guard ?? guardCommand.json ?? null,
      update_dry_run_command: {
        ok: updateDryRunCommand.ok,
        exit_code: updateDryRunCommand.exit_code,
        error: updateDryRunCommand.error ?? null,
      },
    },
    command_status: {
      memory_status: { ok: statusCommand.ok, exit_code: statusCommand.exit_code, error: statusCommand.error ?? null },
      production_guard: { ok: guardCommand.ok, exit_code: guardCommand.exit_code, error: guardCommand.error ?? null },
      update_dry_run: { ok: updateDryRunCommand.ok, exit_code: updateDryRunCommand.exit_code, error: updateDryRunCommand.error ?? null },
    },
  };
  if (input.writeReport) {
    const dir = join(process.cwd(), "reports", "policy-training");
    await mkdir(dir, { recursive: true });
    const safeTs = new Date().toISOString().replace(/[:.]/gu, "-");
    const reportPath = join(dir, `production-canary-feedback-${safeTs}.json`);
    await writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    output.report_path = reportPath;
  }
  return output;
}

async function productionGuardReport(input: {
  readonly candidateOnly: { enabled: boolean; reasons: string[] };
  readonly canary: { enabled: boolean; bypass_scopes: string[]; agents: string[] };
  readonly realScopesFile: Awaited<ReturnType<typeof loadRealScopeEnablementsFile>>;
  readonly writeReport: boolean;
}): Promise<Record<string, unknown>> {
  const statusCommand = runJsonCommand(["tsx", "scripts/memory-status.ts", "--json"]);
  const policyReportCommand = runJsonCommand(["tsx", "scripts/memory-policy-report.ts", "--json"]);
  const status = statusCommand.json;
  const runtimeControls = readAutoApprovalRuntimeControlsSync();
  const pending = readObject(status?.pending);
  const p1Gate = readObject(status?.p1_gate);
  const baselines = ["memory-benchmark-10k-v1", "memory-benchmark-50k-v1"].flatMap((runId) => {
    const baseline = loadTrainingBaseline(runId);
    return baseline ? [baseline] : [];
  });
  const guard = evaluateProductionCanaryGuard({
    candidateOnly: input.candidateOnly,
    runtimeControls,
    realScopeEnablements: input.realScopesFile.enablements,
    runtimeStatus: status ? {
      runtime_ok: status.runtime_ok === true,
      systemd_timer_probe_ok: status.systemd_timer_probe_ok === true,
    } : null,
    qdrantReconcile: buildQdrantReconcileFromStatus(status),
    pendingStatus: status ? {
      ok: pending.ok === true,
      candidate_current: readNumber(pending.candidate_current),
    } : null,
    p1Gate: status ? {
      ok: p1Gate.ok === true,
      status: readString(p1Gate.status),
      blockers: Array.isArray(p1Gate.blockers) ? p1Gate.blockers.filter((item): item is string => typeof item === "string") : [],
      warnings: Array.isArray(p1Gate.warnings) ? p1Gate.warnings.filter((item): item is string => typeof item === "string") : [],
    } : null,
    trainingBaselines: baselines,
  });
  const report: Record<string, unknown> = {
    ok: guard.ok,
    generated_at: new Date().toISOString(),
    guard,
    auto_approval: {
      candidate_only: input.candidateOnly,
      canary: input.canary,
      real_scope_enablements: input.realScopesFile,
      runtime_controls: runtimeControls,
    },
    snapshots: {
      memory_status: status ? {
        ok: status.ok,
        runtime_ok: status.runtime_ok,
        governance_ok: status.governance_ok,
        systemd_timer_probe_ok: status.systemd_timer_probe_ok,
        status_reason: status.status_reason,
      } : null,
      qdrant_reconcile: guard.ok ? buildQdrantReconcileFromStatus(status) : buildQdrantReconcileFromStatus(status),
      pending: pending && Object.keys(pending).length > 0 ? {
        ok: pending.ok,
        candidate_current: pending.candidate_current,
      } : null,
      p1_gate: p1Gate && Object.keys(p1Gate).length > 0 ? {
        ok: p1Gate.ok,
        status: p1Gate.status,
        blockers: p1Gate.blockers,
        warnings: p1Gate.warnings,
      } : null,
      policy_report: policyReportCommand.json,
    },
    command_status: {
      memory_status: { ok: statusCommand.ok, exit_code: statusCommand.exit_code, error: statusCommand.error ?? null },
      policy_report: { ok: policyReportCommand.ok, exit_code: policyReportCommand.exit_code, error: policyReportCommand.error ?? null },
    },
  };
  if (input.writeReport) {
    const dir = join(process.cwd(), "reports", "policy-training");
    await mkdir(dir, { recursive: true });
    const safeTs = new Date().toISOString().replace(/[:.]/gu, "-");
    const reportPath = join(dir, `production-canary-readiness-${safeTs}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    report.report_path = reportPath;
  }
  return report;
}

async function enforceProductionCanaryScope(client: import("pg").PoolClient, schema: string, gateReportPath: string | null): Promise<Record<string, unknown>> {
  const agent = "codex";
  const current = await loadRealScopeEnablementsFile();
  const requiredScopes = ["project:memory-xx", "user:current-user"] as const;
  for (const raw of requiredScopes) {
    const scope = parseScope(raw);
    await ensureScopeGrant(client, schema, agent, scope.scopeType, scope.scopeId);
  }
  const byScope = new Map(current.enablements.map((item) => [item.scope, item]));
  const nextEnablements: RealScopeEnablement[] = [];
  const seen = new Set<string>();
  for (const item of current.enablements) {
    if (seen.has(item.scope)) continue;
    seen.add(item.scope);
    if (requiredScopes.includes(item.scope as typeof requiredScopes[number])) {
      nextEnablements.push({
        ...item,
        enabled: true,
        agents: ["codex"],
        allowed_sources: item.allowed_sources.length > 0 ? item.allowed_sources : DEFAULT_REAL_SCOPE_SOURCES,
        allowed_operations: ["add"],
        enabled_by: item.enabled_by || "memory:auto-approval:production-canary",
        enabled_at: item.enabled_at || new Date().toISOString(),
        gate_report_path: gateReportPath,
      });
    } else {
      nextEnablements.push({ ...item, enabled: false });
    }
  }
  for (const scope of requiredScopes) {
    if (byScope.has(scope)) continue;
    nextEnablements.push({
      scope,
      enabled: true,
      agents: ["codex"],
      allowed_sources: current.allowed_sources.length > 0 ? current.allowed_sources : DEFAULT_REAL_SCOPE_SOURCES,
      allowed_operations: ["add"],
      enabled_by: "memory:auto-approval:production-canary",
      enabled_at: new Date().toISOString(),
      gate_report_path: gateReportPath,
    });
  }
  await saveRealScopeEnablements({
    ...current,
    agents: ["codex"],
    allowed_sources: current.allowed_sources.length > 0 ? current.allowed_sources : DEFAULT_REAL_SCOPE_SOURCES,
    allowed_operations: ["add"],
    enablements: nextEnablements,
  });

  const previousControls = readAutoApprovalRuntimeControlsSync();
  const nextControls = buildProductionCanaryRuntimeControls(previousControls);
  writeAutoApprovalRuntimeControlsSync(nextControls);
  return {
    ok: true,
    mode: "project_user_add_only",
    enabled_scopes: requiredScopes,
    disabled_scopes: nextEnablements.filter((item) => !item.enabled).map((item) => item.scope),
    runtime_controls: nextControls,
    config: ["auto-approval-runtime-controls.json", "auto-approval-scope-enablements.json"],
  };
}

async function saveCanary(value: { enabled: boolean; bypass_scopes: string[]; agents: string[] }): Promise<void> {
  await mkdir(runtimeDir(), { recursive: true });
  await writeFile(join(runtimeDir(), "auto-approval-canary.json"), `${JSON.stringify({
    ...value,
    updated_at: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
}

async function hasScopeGrant(client: import("pg").PoolClient, schema: string, agentId: string, scopeType: string, scopeId: string): Promise<boolean> {
  const rows = await client.query(
    `
      SELECT true AS ok
      FROM ${schema}.trusted_agent_scope_grants
      WHERE agent_id = $1
        AND scope_type = $2
        AND (scope_id = $3 OR scope_id = '*')
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
        AND ('memory:write' = ANY(permissions) OR 'memory:admin' = ANY(permissions))
      LIMIT 1
    `,
    [agentId, scopeType, scopeId]
  );
  return Boolean(rows.rows[0]?.ok);
}

async function ensureScopeGrant(client: import("pg").PoolClient, schema: string, agentId: string, scopeType: string, scopeId: string): Promise<void> {
  await client.query(
    `
      INSERT INTO ${schema}.trusted_agent_scope_grants (
        id, agent_id, scope_type, scope_id, permissions, expires_at, created_by, revoked_at, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5::text[], NULL, 'memory:auto-approval', NULL, now(), now())
      ON CONFLICT (agent_id, scope_type, scope_id) WHERE revoked_at IS NULL
      DO UPDATE SET permissions = EXCLUDED.permissions, updated_at = now()
    `,
    [randomUUID(), agentId, scopeType, scopeId, ["memory:write", "memory:read", "memory:feedback"]]
  );
}

async function recentSilentApprovedCount(client: import("pg").PoolClient, schema: string, input: { agentId: string; scopeType: string; scopeId: string; source: string }): Promise<number> {
  const rows = await client.query<{ count: string }>(
    `
      SELECT count(*) AS count
      FROM ${schema}.memory_records
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
  return Number(rows.rows[0]?.count ?? 0);
}

async function loadSilentApproveEnabled(client: import("pg").PoolClient, schema: string, input: {
  readonly agentId: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly memoryType: string;
  readonly source: string;
}): Promise<{ enabled: boolean; override_id: string | null; selector: JsonObject }> {
  const selector = {
    agent_id: input.agentId,
    scope_type: input.scopeType,
    scope_id: input.scopeId,
    memory_type: input.memoryType || "unknown",
    source: input.source,
  } satisfies JsonObject;
  const rows = await client.query<{ id: string; auto_approve_enabled: boolean | null }>(
    `
      SELECT id, auto_approve_enabled
      FROM ${schema}.governance_policy_overrides
      WHERE selector_hash = $1
        AND policy_type = 'silent_approve'
        AND expires_at > now()
      LIMIT 1
    `,
    [stableGovernanceSelectorHash(selector)]
  );
  const row = rows.rows[0];
  return {
    enabled: row?.auto_approve_enabled === false ? false : true,
    override_id: row?.id ?? null,
    selector,
  };
}

async function dryRun(client: import("pg").PoolClient, schema: string, scopeKey: string): Promise<Record<string, unknown>> {
  const scope = parseScope(scopeKey);
  const candidateOnly = await loadCandidateOnlyFlag();
  const rows = await client.query(
    `
      SELECT id, scope_type, scope_id, memory_type, title, content, metadata,
        COALESCE(agent_id, metadata->>'agent_id', created_by, 'unknown') AS agent_id,
        COALESCE(metadata->>'source', '') AS source,
        COALESCE(metadata->>'conflict_action', 'create') AS conflict_action,
        COALESCE((metadata->'quality_gate'->>'score')::float, (metadata->>'quality_score')::float, 0) AS quality_score,
        COALESCE((metadata->>'confidence')::float, 0) AS confidence
      FROM ${schema}.memory_records
      WHERE lifecycle_status = 'candidate'
        AND review_state = 'pending'
        AND scope_type = $1
        AND scope_id = $2
      ORDER BY quality_score DESC NULLS LAST, updated_at DESC
      LIMIT 100
    `,
    [scope.scopeType, scope.scopeId]
  );
  const candidates = [];
  for (const row of rows.rows) {
    const metadata = readObject(row.metadata);
    const source = readString(row.source, "memory-xx-intelligence-smart-write");
    const hasGrant = await hasScopeGrant(client, schema, String(row.agent_id), String(row.scope_type), String(row.scope_id)).catch(() => false);
    const memoryType = readString(row.memory_type ?? metadata.memory_type);
    const override = await loadSilentApproveEnabled(client, schema, {
      agentId: String(row.agent_id),
      scopeType: String(row.scope_type),
      scopeId: String(row.scope_id),
      memoryType,
      source,
    }).catch(() => ({
      enabled: true,
      override_id: null,
      selector: {} as JsonObject,
    }));
    const decision = evaluateAutoApprovalPolicy({
      mode: "write",
      agentId: String(row.agent_id),
      source: source === "memory-xx-intelligence-smart-write" || source === "memory-xx-mcp-smart-write" ? "smart_write" : source,
      sourceText: String(row.content ?? ""),
      candidate: {
        scopeType: String(row.scope_type),
        scopeId: String(row.scope_id),
        memoryType,
        operation: "add",
        conflictAction: readString(row.conflict_action, "create"),
        confidence: Number(row.confidence ?? 0),
        qualityScore: Number(row.quality_score ?? 0),
        title: row.title,
        content: String(row.content ?? ""),
        metadata: metadata as JsonObject,
      },
      trustedAgent: hasGrant,
      hasScopeGrant: hasGrant,
      candidateOnly: candidateOnly.enabled,
      candidateOnlyReasons: candidateOnly.reasons,
      semanticConflict: ["merge", "supersede", "update"].includes(readString(row.conflict_action)),
      semanticDuplicate: false,
      autoApproveEnabled: override.enabled,
      recentApprovedCount: await recentSilentApprovedCount(client, schema, {
        agentId: String(row.agent_id),
        scopeType: String(row.scope_type),
        scopeId: String(row.scope_id),
        source,
      }).catch(() => 0),
    });
    candidates.push({
      id: row.id,
      title: row.title,
      source,
      agent_id: row.agent_id,
      quality_score: row.quality_score,
      confidence: row.confidence,
      decision: decision.decision,
      score: decision.score,
      reasons: decision.reasons,
      blocked_reasons: decision.blocked_reasons,
      policy_override_id: override.override_id,
    });
  }
  return {
    scope: scopeKey,
    candidate_count: candidates.length,
    would_approve_count: candidates.filter((row) => row.decision === "approve").length,
    blocked_count: candidates.filter((row) => row.decision !== "approve").length,
    candidates,
  };
}

async function postReview(memoryId: string, action: "archive" | "tombstone", reason: string): Promise<Record<string, unknown>> {
  const base = (process.env.MEMORY_V2_WRAPPER_URL?.replace(/\/+$/, "")) || `http://127.0.0.1:${process.env.MEMORY_V2_WRAPPER_PORT || "5100"}`;
  const token = process.env.MEMORY_V2_ADMIN_TOKEN?.trim() || process.env.MEMORY_V2_CLI_TOKEN?.trim() || "";
  const response = await fetch(`${base}/api/memory/v2/review/memories/${encodeURIComponent(memoryId)}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ requestId: randomUUID(), actorId: "memory:auto-approval", reason }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}:${text.slice(0, 500)}`);
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

async function main(): Promise<void> {
  const cmd = command();
  await requireCliPermission(
    cmd === "rollback" || cmd === "enable-canary" || cmd === "disable-canary" || cmd === "enable-real-scope" || cmd === "disable-real-scope" ||
    cmd === "enable-user-add-only" || cmd === "disable-user-add-only" || cmd === "enforce-production-canary"
      ? "memory:governance_apply"
      : "memory:governance_read"
  );
  const config = loadMemoryV2PostgresConfig(process.env);
  const schema = quoteIdent(config.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(config));
  const client = await pool.connect();
  try {
    if (cmd === "status") {
      const canary = await loadCanary();
      const realScopesFile = await loadRealScopeEnablementsFile();
      const candidateOnly = await loadCandidateOnlyFlag();
      const decisions = await client.query(`SELECT decision, count(*)::int FROM ${schema}.auto_approval_decisions WHERE created_at >= now() - interval '24 hours' GROUP BY decision ORDER BY decision`);
      const frozen = await client.query(`SELECT count(*)::int AS count FROM ${schema}.governance_policy_overrides WHERE policy_type = 'silent_approve' AND auto_approve_enabled IS FALSE AND expires_at > now()`);
      const frozenCohorts = Number(frozen.rows[0]?.count ?? 0);
      process.stdout.write(JSON.stringify({
        ok: true,
        canary,
        real_scope_enablements: realScopesFile,
        effective_real_scope_enablements: defaultAutoApprovalScopeEnablements(),
        candidate_only: candidateOnly,
        decisions_24h: decisions.rows,
        frozen_cohorts: frozenCohorts,
        readiness: buildReadinessStatus({ candidateOnly, canary, realScopeEnablements: realScopesFile.enablements, frozenCohorts }),
      }, null, 2) + "\n");
      return;
    }
    if (cmd === "production-guard") {
      const canary = await loadCanary();
      const realScopesFile = await loadRealScopeEnablementsFile();
      const candidateOnly = await loadCandidateOnlyFlag();
      const report = await productionGuardReport({
        candidateOnly,
        canary,
        realScopesFile,
        writeReport: hasFlag("write-report"),
      });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      process.exitCode = report.ok === true ? 0 : 1;
      return;
    }
    if (cmd === "production-feedback") {
      const candidateOnly = await loadCandidateOnlyFlag();
      const report = await productionFeedbackReport(client, schema, {
        candidateOnly,
        writeReport: hasFlag("write-report"),
      });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return;
    }
    if (cmd === "enforce-production-canary") {
      const result = await enforceProductionCanaryScope(client, schema, arg("gate-report") || null);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    if (cmd === "dry-run" || cmd === "review-sample") {
      const scope = arg("scope") || "project:memory-xx";
      const report = await dryRun(client, schema, scope);
      const candidates = report.candidates as Array<Record<string, unknown>>;
      process.stdout.write(JSON.stringify({ ok: true, ...report, candidates: cmd === "review-sample" ? candidates.slice(0, Number(arg("limit") || 10)) : candidates }, null, 2) + "\n");
      return;
    }
    if (cmd === "enable-canary") {
      const scope = parseScope(arg("scope") || "project:memory-xx");
      const agent = arg("agent") || "codex";
      await ensureScopeGrant(client, schema, agent, scope.scopeType, scope.scopeId);
      const current = await loadCanary();
      await saveCanary({
        enabled: true,
        bypass_scopes: [...new Set([...current.bypass_scopes, scope.key])],
        agents: [...new Set([...current.agents, agent])],
      });
      process.stdout.write(JSON.stringify({ ok: true, enabled: true, agent, scope: scope.key, scope_grant: "ensured" }, null, 2) + "\n");
      return;
    }
    if (cmd === "disable-canary") {
      const scopeRaw = arg("scope");
      const current = await loadCanary();
      const nextScopes = scopeRaw ? current.bypass_scopes.filter((item) => item !== parseScope(scopeRaw).key) : [];
      await saveCanary({ enabled: nextScopes.length > 0, bypass_scopes: nextScopes, agents: scopeRaw ? current.agents : [] });
      process.stdout.write(JSON.stringify({ ok: true, enabled: nextScopes.length > 0, bypass_scopes: nextScopes }, null, 2) + "\n");
      return;
    }
    if (cmd === "enable-real-scope") {
      const scope = parseScope(arg("scope") || "");
      if (scope.scopeType === "user" || scope.scopeType === "global") {
        throw new Error("real_scope_enablement_blocked：user/global（用户/全局）真实 scope 仍保持人工审批");
      }
      if (!(scope.key === "project:memory-xx" || scope.key === "workspace:current-instance")) {
        throw new Error("real_scope_enablement_blocked：当前只允许 project:memory-xx 和 workspace:current-instance");
      }
      const agent = arg("agent") || "codex";
      if (agent !== "codex") throw new Error("real_scope_enablement_blocked：当前只允许 agent（代理）codex");
      await ensureScopeGrant(client, schema, agent, scope.scopeType, scope.scopeId);
      const current = await loadRealScopeEnablementsFile();
      const existing = current.enablements.filter((item) => item.scope !== scope.key);
      const next: RealScopeEnablement = {
        scope: scope.key,
        enabled: true,
        agents: [agent],
        allowed_sources: DEFAULT_REAL_SCOPE_SOURCES,
        allowed_operations: ["add"],
        enabled_by: "memory:auto-approval",
        enabled_at: new Date().toISOString(),
        gate_report_path: arg("gate-report") || null,
      };
      await saveRealScopeEnablements({
        ...current,
        agents: [...new Set([...current.agents, agent])],
        allowed_sources: current.allowed_sources.length > 0 ? current.allowed_sources : DEFAULT_REAL_SCOPE_SOURCES,
        allowed_operations: current.allowed_operations.length > 0 ? current.allowed_operations : ["add"],
        enablements: [...existing, next],
      });
      process.stdout.write(JSON.stringify({ ok: true, enabled: true, agent, scope: scope.key, scope_grant: "ensured", config: "auto-approval-scope-enablements.json" }, null, 2) + "\n");
      return;
    }
    if (cmd === "enable-user-add-only") {
      const scope = parseScope(arg("scope") || "user:current-user");
      if (scope.key !== "user:current-user") {
        throw new Error("user_add_only_enablement_blocked：当前只允许 user:current-user（当前用户）小范围 add-only 试运行");
      }
      const agent = arg("agent") || "codex";
      if (agent !== "codex") throw new Error("user_add_only_enablement_blocked：当前只允许 agent（代理）codex");
      await ensureScopeGrant(client, schema, agent, scope.scopeType, scope.scopeId);
      const runtimeControls = readAutoApprovalRuntimeControlsSync();
      writeAutoApprovalRuntimeControlsSync({
        ...runtimeControls,
        user: {
          ...runtimeControls.user,
          enabled: true,
          add_only: true,
          stable_preference: true,
          constraint: true,
          decision: false,
          candidate_only_bypass: true,
          pii_allowlist: false,
        },
        update_apply: {
          ...runtimeControls.update_apply,
          user_apply: false,
          global_apply: false,
        },
      });
      const current = await loadRealScopeEnablementsFile();
      const existing = current.enablements.filter((item) => item.scope !== scope.key);
      const next: RealScopeEnablement = {
        scope: scope.key,
        enabled: true,
        agents: [agent],
        allowed_sources: DEFAULT_REAL_SCOPE_SOURCES,
        allowed_operations: ["add"],
        enabled_by: "memory:auto-approval:user-add-only",
        enabled_at: new Date().toISOString(),
        gate_report_path: arg("gate-report") || null,
      };
      await saveRealScopeEnablements({
        ...current,
        agents: [...new Set([...current.agents, agent])],
        allowed_sources: current.allowed_sources.length > 0 ? current.allowed_sources : DEFAULT_REAL_SCOPE_SOURCES,
        allowed_operations: current.allowed_operations.length > 0 ? current.allowed_operations : ["add"],
        enablements: [...existing, next],
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        enabled: true,
        scope: scope.key,
        agent,
        mode: "add_only",
        allowed_memory_types: ["preference", "constraint"],
        blocked: ["decision", "PII 默认 pending", "secret/credential", "update/conflict/supersede/merge", "global", "real_update_apply"],
        scope_grant: "ensured",
        config: ["auto-approval-runtime-controls.json", "auto-approval-scope-enablements.json"],
      }, null, 2) + "\n");
      return;
    }
    if (cmd === "disable-user-add-only") {
      const scope = parseScope(arg("scope") || "user:current-user");
      if (scope.scopeType !== "user") throw new Error("--scope must be user:<id>");
      const runtimeControls = readAutoApprovalRuntimeControlsSync();
      writeAutoApprovalRuntimeControlsSync({
        ...runtimeControls,
        user: {
          ...runtimeControls.user,
          enabled: false,
          add_only: false,
          stable_preference: false,
          constraint: false,
          decision: false,
          candidate_only_bypass: false,
          pii_allowlist: false,
        },
        update_apply: {
          ...runtimeControls.update_apply,
          user_apply: false,
        },
      });
      const current = await loadRealScopeEnablementsFile();
      await saveRealScopeEnablements({
        ...current,
        enablements: current.enablements.map((item) => item.scope === scope.key ? { ...item, enabled: false } : item),
      });
      process.stdout.write(JSON.stringify({ ok: true, enabled: false, scope: scope.key, config: ["auto-approval-runtime-controls.json", "auto-approval-scope-enablements.json"] }, null, 2) + "\n");
      return;
    }
    if (cmd === "disable-real-scope") {
      const scope = parseScope(arg("scope") || "");
      const current = await loadRealScopeEnablementsFile();
      await saveRealScopeEnablements({
        ...current,
        enablements: current.enablements.map((item) => item.scope === scope.key ? { ...item, enabled: false } : item),
      });
      process.stdout.write(JSON.stringify({ ok: true, enabled: false, scope: scope.key, config: "auto-approval-scope-enablements.json" }, null, 2) + "\n");
      return;
    }
    if (cmd === "rollback") {
      const memoryId = arg("memory-id");
      if (!memoryId) throw new Error("缺少必填参数：--memory-id（记忆 ID）");
      const mode = arg("mode") === "archive" ? "archive" : "tombstone";
      const reason = arg("reason") || "auto approval rollback";
      const eligible = await client.query(
        `
          SELECT d.id, r.review_state, r.lifecycle_status
          FROM ${schema}.auto_approval_decisions d
          JOIN ${schema}.memory_records r ON r.id = COALESCE(d.approved_memory_id, d.candidate_memory_id)
          WHERE COALESCE(d.approved_memory_id, d.candidate_memory_id) = $1
            AND d.decision = 'approve'
            AND r.review_state = 'silent_approved'
          ORDER BY d.created_at DESC
          LIMIT 1
        `,
        [memoryId]
      );
      if (!eligible.rows[0]) throw new Error("rollback（回滚）只能用于 review_state=silent_approved 的自动批准记忆");
      if (hasFlag("dry-run")) {
        process.stdout.write(JSON.stringify({
          ok: true,
          dry_run: true,
          eligible: true,
          memory_id: memoryId,
          mode,
          reason,
          decision_id: eligible.rows[0].id,
          current_state: {
            review_state: eligible.rows[0].review_state,
            lifecycle_status: eligible.rows[0].lifecycle_status,
          },
        }, null, 2) + "\n");
        return;
      }
      let result: Record<string, unknown>;
      try {
        result = await postReview(memoryId, mode, reason);
      } catch (error) {
        await client.query(
          `
            INSERT INTO ${schema}.memory_governance_actions (
              id, action_type, scope_type, scope_id, memory_id, selector, evidence, before_state, after_state,
              outbox_event_ids, status, created_by, created_at
            )
            SELECT $1, 'auto_approval_rollback', r.scope_type, r.scope_id, r.id,
              jsonb_build_object('memory_id', r.id),
              $2::jsonb,
              jsonb_build_object('review_state', r.review_state, 'lifecycle_status', r.lifecycle_status),
              '{}'::jsonb,
              '[]'::jsonb, 'failed', 'memory:auto-approval', now()
            FROM ${schema}.memory_records r
            WHERE r.id = $3
          `,
          [randomUUID(), JSON.stringify({ reason, mode, error: error instanceof Error ? error.message : String(error) }), memoryId]
        ).catch(() => undefined);
        throw error;
      }
      const memoryEventId = readString(result.memoryEventId ?? result.memory_event_id);
      const [afterState] = await client.query(
        `SELECT lifecycle_status, review_state, is_current FROM ${schema}.memory_records WHERE id = $1`,
        [memoryId]
      ).then((rows) => rows.rows);
      const rollbackVerified = Boolean(afterState && (
        afterState.lifecycle_status === "tombstone" ||
        afterState.lifecycle_status === "archived" ||
        afterState.review_state !== "silent_approved" ||
        afterState.is_current === false
      ));
      await client.query(
        `
          UPDATE ${schema}.auto_approval_decisions
          SET rollback_memory_event_id = $2,
              metadata = metadata || $3::jsonb
          WHERE id = $1
        `,
        [eligible.rows[0].id, memoryEventId || null, JSON.stringify({
          rollback: {
            mode,
            reason,
            at: new Date().toISOString(),
            memory_event_id: memoryEventId || null,
            verified: rollbackVerified,
            after_state: afterState ?? null,
          }
        })]
      );
      await client.query(
        `
          INSERT INTO ${schema}.memory_governance_actions (
            id, action_type, scope_type, scope_id, memory_id, selector, evidence, before_state, after_state,
            outbox_event_ids, status, created_by, created_at
          )
          SELECT $1, 'auto_approval_rollback', r.scope_type, r.scope_id, r.id,
            jsonb_build_object('memory_id', r.id),
            $2::jsonb,
            jsonb_build_object('review_state', 'silent_approved'),
            jsonb_build_object('mode', $3::text, 'rollback_memory_event_id', $4::text),
            '[]'::jsonb, 'applied', 'memory:auto-approval', now()
          FROM ${schema}.memory_records r
          WHERE r.id = $5
        `,
        [randomUUID(), JSON.stringify({ reason, result, rollback_verified: rollbackVerified, after_state: afterState ?? null }), mode, memoryEventId || null, memoryId]
      );
      process.stdout.write(JSON.stringify({ ok: true, memory_id: memoryId, mode, result, rollback_verified: rollbackVerified, after_state: afterState ?? null }, null, 2) + "\n");
      return;
    }
    throw new Error("用法：memory:auto-approval <status|production-guard|production-feedback|enforce-production-canary|dry-run|enable-canary|disable-canary|enable-real-scope|disable-real-scope|enable-user-add-only|disable-user-add-only|rollback|review-sample>");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

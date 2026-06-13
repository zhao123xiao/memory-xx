import { resolveRuntimeModuleStates, type RuntimeEnv } from "./runtime-modules";

export type FullStackCapabilityProfile = "core" | "enhanced" | "full";
export type FullStackCapabilityMaturity = "stable" | "beta" | "experimental";
export type FullStackCapabilityState = "enabled" | "disabled" | "missing_dependency";

export interface FullStackCapability {
  readonly name: string;
  readonly label: string;
  readonly profile: FullStackCapabilityProfile;
  readonly maturity: FullStackCapabilityMaturity;
  readonly default_enabled: boolean;
  readonly env_enabled?: string;
  readonly dependencies?: readonly string[];
  readonly source_paths: readonly string[];
  readonly script_paths: readonly string[];
  readonly degraded_behavior: string;
}

export type FullStackCapabilityEnv = RuntimeEnv;

export interface FullStackCapabilitySnapshotItem {
  readonly state: FullStackCapabilityState;
  readonly enabled: boolean;
  readonly label: string;
  readonly profile: FullStackCapabilityProfile;
  readonly maturity: FullStackCapabilityMaturity;
  readonly env_enabled?: string;
  readonly dependencies?: readonly string[];
  readonly source_paths: readonly string[];
  readonly script_paths: readonly string[];
  readonly degraded_behavior: string;
  readonly reason?: string;
}

export interface FullStackCapabilitySnapshot {
  readonly enabled: readonly string[];
  readonly disabled: readonly string[];
  readonly missing_dependency: readonly string[];
  readonly states: Readonly<Record<string, FullStackCapabilitySnapshotItem>>;
}

export const FULL_STACK_CAPABILITIES: readonly FullStackCapability[] = [
  {
    name: "knowledge_ingest",
    label: "Knowledge Markdown ingest",
    profile: "enhanced",
    maturity: "beta",
    default_enabled: false,
    env_enabled: "MEMORY_XX_KNOWLEDGE_INGEST_ENABLED",
    source_paths: ["app/knowledge/service.ts", "app/knowledge/markdown-governance.ts"],
    script_paths: ["scripts/memory-knowledge-md.ts", "scripts/knowledge-graph-smoke.ts"],
    degraded_behavior: "Long-form documents are not ingested automatically; short memory write/recall continues.",
  },
  {
    name: "memory_knowledge_graph",
    label: "Memory knowledge graph",
    profile: "enhanced",
    maturity: "beta",
    default_enabled: false,
    env_enabled: "MEMORY_XX_MEMORY_GRAPH_ENABLED",
    source_paths: ["app/intelligence/graph-extraction.ts", "app/recall/retrievers/graph-retriever.ts", "app/graph-health.ts"],
    script_paths: [
      "scripts/memory-graph-report.ts",
      "scripts/graph-health.ts",
      "scripts/memory-graph-relation-repair-apply.ts",
      "scripts/knowledge-graph-smoke.ts",
    ],
    degraded_behavior: "Graph evidence and graph recall boosts are skipped; vector and lexical recall remain available.",
  },
  {
    name: "code_graph",
    label: "Repository code graph",
    profile: "enhanced",
    maturity: "beta",
    default_enabled: false,
    env_enabled: "MEMORY_XX_CODE_GRAPH_ENABLED",
    source_paths: ["app/code-graph.ts"],
    script_paths: ["scripts/memory-code-graph.ts"],
    degraded_behavior: "Repository symbol/import/call graph views are unavailable; memory graph and recall continue.",
  },
  {
    name: "temporal_decay",
    label: "Temporal decay and archive candidates",
    profile: "full",
    maturity: "beta",
    default_enabled: false,
    env_enabled: "MEMORY_XX_TEMPORAL_DECAY_ENABLED",
    source_paths: ["app/decay/index.ts", "app/decay/calculator.ts", "app/decay/production-decay.ts"],
    script_paths: [
      "scripts/decay-run.ts",
      "scripts/temporal-sweep.ts",
      "scripts/memory-temporal-policy.ts",
      "scripts/memory-stale-fact-report.ts",
      "scripts/temporal-ops-smoke.ts",
    ],
    degraded_behavior: "Temporal decay scoring and archive candidate generation are not run automatically.",
  },
  {
    name: "temporal_consolidation",
    label: "Temporal consolidation engine",
    profile: "full",
    maturity: "beta",
    default_enabled: false,
    env_enabled: "MEMORY_XX_CONSOLIDATION_ENABLED",
    source_paths: ["app/consolidation/index.ts", "app/consolidation/worker.ts", "app/consolidation/merge-engine.ts"],
    script_paths: [
      "scripts/memory-consolidate.ts",
      "scripts/memory-consolidation-candidates.ts",
      "scripts/temporal-ops-smoke.ts",
    ],
    degraded_behavior: "Duplicate/episode consolidation suggestions are not produced automatically.",
  },
  {
    name: "memory_dreaming",
    label: "Memory dreaming worker",
    profile: "full",
    maturity: "experimental",
    default_enabled: false,
    env_enabled: "MEMORY_XX_DREAMING_ENABLED",
    source_paths: ["app/dream/index.ts", "app/dream/dream-worker.ts", "app/dream/dream-scheduler.ts"],
    script_paths: ["scripts/run-dream-worker.ts", "scripts/memory-dreaming-smoke.ts"],
    degraded_behavior: "Background dreaming/promoted insight generation is disabled; explicit write/recall continues.",
  },
  {
    name: "policy_evaluation",
    label: "Policy corpus and evaluation",
    profile: "full",
    maturity: "beta",
    default_enabled: false,
    env_enabled: "MEMORY_XX_POLICY_EVAL_ENABLED",
    source_paths: ["app/governance/memory-policy-engine.ts", "app/governance/policy-corpus.ts", "app/governance/memory-policy-report.ts"],
    script_paths: [
      "scripts/memory-policy-corpus.ts",
      "scripts/memory-policy-eval.ts",
      "scripts/memory-policy-report.ts",
      "scripts/memory-governance-debt-plan.ts",
      "scripts/policy-ops-smoke.ts",
    ],
    degraded_behavior: "Policy evaluation reports are not refreshed automatically; runtime policy still executes.",
  },
  {
    name: "recall_quality",
    label: "Recall quality evaluation",
    profile: "full",
    maturity: "beta",
    default_enabled: false,
    env_enabled: "MEMORY_XX_RECALL_QUALITY_ENABLED",
    dependencies: ["fastpath", "lexical_sidecar", "reranker_adapter"],
    source_paths: ["app/recall/orchestrator.ts", "app/recall/reranker.ts"],
    script_paths: [
      "scripts/memory-quality.ts",
      "scripts/intelligence-quality.ts",
      "scripts/benchmark-reranker-policy.ts",
      "scripts/memory-local-agent-evidence.ts",
      "scripts/memory-recall-repair.ts",
      "scripts/memory-adaptive-retrieval-apply.ts",
      "scripts/memory-adaptive-retrieval-calibration.ts",
      "scripts/memory-extraction-recall-eval.ts",
      "scripts/memory-recall-quality-feedback.ts",
      "scripts/trace-replay-feedback.ts",
      "scripts/recall-quality-smoke.ts",
    ],
    degraded_behavior: "Release quality evidence is not refreshed automatically; recall still uses configured runtime paths.",
  },
  {
    name: "auto_approval_ops",
    label: "Auto-approval operations",
    profile: "full",
    maturity: "beta",
    default_enabled: false,
    env_enabled: "MEMORY_XX_AUTO_APPROVAL_ENABLED",
    source_paths: [
      "app/governance/auto-approval-runtime-controls.ts",
      "app/governance/auto-approval-production-guard.ts",
      "app/governance/memory-auto-approval-sweep.ts",
    ],
    script_paths: [
      "scripts/memory-auto-approval.ts",
      "scripts/memory-auto-approval-ops.ts",
      "scripts/memory-auto-approval-sweep.ts",
      "scripts/memory-auto-approval-limit-advisor.ts",
    ],
    degraded_behavior: "Pending memories remain reviewable manually; automatic approvals and sweeps do not run.",
  },
  {
    name: "auto_update_ops",
    label: "Auto-update operations",
    profile: "full",
    maturity: "beta",
    default_enabled: false,
    env_enabled: "MEMORY_XX_AUTO_UPDATE_ENABLED",
    source_paths: ["app/governance/auto-update-policy.ts", "app/write/services/create-memory-candidate-update.ts"],
    script_paths: ["scripts/memory-auto-update.ts"],
    degraded_behavior: "Supersede/update candidates are not applied automatically; normal write and manual review continue.",
  },
  {
    name: "embedding_manifest",
    label: "Embedding generation manifest",
    profile: "enhanced",
    maturity: "stable",
    default_enabled: false,
    env_enabled: "MEMORY_XX_EMBEDDING_MANIFEST_ENABLED",
    source_paths: ["app/embedding/generation-manifest.ts", "app/embedding/manifest-refresh.ts"],
    script_paths: ["scripts/embedding-manifest.ts", "scripts/embedding-ops-smoke.ts"],
    degraded_behavior: "Embedding generation validation is skipped; wrapper still uses the configured provider and Qdrant collection.",
  },
  {
    name: "embedding_calibration",
    label: "Embedding latency calibration",
    profile: "full",
    maturity: "beta",
    default_enabled: false,
    env_enabled: "MEMORY_XX_EMBEDDING_CALIBRATION_ENABLED",
    dependencies: ["embedding_proxy"],
    source_paths: ["app/server/embedding-provider.ts", "app/recall/query-embedding-resilience.ts"],
    script_paths: ["scripts/embedding-calibration.ts", "scripts/embedding-ops-smoke.ts"],
    degraded_behavior: "Embedding timeout/concurrency recommendations are not refreshed automatically.",
  },
  {
    name: "local_embedding_generation",
    label: "Local embedding generation",
    profile: "full",
    maturity: "beta",
    default_enabled: false,
    env_enabled: "MEMORY_XX_LOCAL_EMBEDDING_GENERATION_ENABLED",
    dependencies: ["embedding_proxy", "qdrant"],
    source_paths: ["app/embedding/index.ts", "app/qdrant-sync/projector-embedding-resolver.ts"],
    script_paths: [
      "scripts/generate-local-memory-embeddings.ts",
      "scripts/generate-embeddings.ts",
      "scripts/local-qwen8b-benchmark.ts",
      "scripts/local-embedding-generation-smoke.ts",
    ],
    degraded_behavior: "Bulk local vector regeneration is disabled; online writes still use the configured embedding provider.",
  },
  {
    name: "backup_and_restore",
    label: "Backup and restore runbook",
    profile: "full",
    maturity: "beta",
    default_enabled: false,
    env_enabled: "MEMORY_XX_BACKUP_ENABLED",
    source_paths: ["app/ops/preflight.ts", "app/ops/rollback.ts"],
    script_paths: ["scripts/memory-backup.ts", "scripts/backup-ops-smoke.ts"],
    degraded_behavior: "Automated backup planning is unavailable; database-native backups can still be run externally.",
  },
  {
    name: "platform_doctor",
    label: "Platform doctor and preflight",
    profile: "enhanced",
    maturity: "stable",
    default_enabled: false,
    env_enabled: "MEMORY_XX_PLATFORM_DOCTOR_ENABLED",
    source_paths: ["app/ops/preflight.ts", "app/runtime-config-validator.ts", "app/runtime-modules.ts"],
    script_paths: ["scripts/memory-platform-doctor.ts", "scripts/memory-doctor.ts", "scripts/runtime-profile-smoke.ts", "scripts/compose-core-smoke.ts", "scripts/cache-invalidation-smoke.ts", "scripts/markdown-projection-smoke.ts"],
    degraded_behavior: "Automated environment diagnosis is unavailable; health endpoints and explicit checks still work.",
  },
  {
    name: "trusted_agent_tools",
    label: "Trusted agent tooling",
    profile: "enhanced",
    maturity: "stable",
    default_enabled: false,
    env_enabled: "MEMORY_XX_TRUSTED_AGENT_TOOLS_ENABLED",
    source_paths: ["app/server/permissions.ts", "app/orchestrator/scope-plan.ts", "app/mcp/tool-registry.ts"],
    script_paths: ["scripts/memory-trusted-agent.ts", "scripts/trusted-agent-smoke.ts"],
    degraded_behavior: "Token and scope grant provisioning must be handled manually; strict scope enforcement remains available.",
  },
  {
    name: "qdrant_reconciliation",
    label: "Qdrant projection reconciliation",
    profile: "full",
    maturity: "beta",
    default_enabled: false,
    env_enabled: "MEMORY_XX_QDRANT_RECONCILE_ENABLED",
    dependencies: ["qdrant", "projector", "qdrant_proxy"],
    source_paths: ["app/qdrant-sync/consistency-reconcile.ts", "app/qdrant-sync/replay-repair.ts", "app/ops/outbox-recovery.ts"],
    script_paths: [
      "scripts/qdrant-reconcile.ts",
      "scripts/fix-qdrant-replay.ts",
      "scripts/replay-qdrant-outbox.ts",
      "scripts/outbox-recovery.ts",
      "scripts/qdrant-alias.ts",
      "scripts/qdrant-collection-audit.ts",
      "scripts/qdrant-reconciliation-smoke.ts",
    ],
    degraded_behavior: "Projection repair is not run automatically; vector freshness may lag while Postgres remains authoritative.",
  },
  {
    name: "conversation_ops",
    label: "Conversation source operations",
    profile: "enhanced",
    maturity: "beta",
    default_enabled: false,
    env_enabled: "MEMORY_XX_CONVERSATION_OPS_ENABLED",
    dependencies: ["conversation_monitor"],
    source_paths: ["app/conversation/conversation-source-status.ts", "app/conversation/conversation-monitor-report.ts"],
    script_paths: [
      "scripts/memory-conversation-sources.ts",
      "scripts/memory-conversation-monitor-report.ts",
      "scripts/conversation-monitor-smoke.ts",
    ],
    degraded_behavior: "Conversation source diagnostics and monitor reports are unavailable; direct memory APIs continue.",
  },
  {
    name: "governance_operations",
    label: "Governance operations",
    profile: "full",
    maturity: "beta",
    default_enabled: false,
    env_enabled: "MEMORY_XX_GOVERNANCE_OPS_ENABLED",
    source_paths: [
      "app/governance/service.ts",
      "app/governance/memory-policy-backfill.ts",
      "app/governance/pending-canary-training-report.ts",
      "app/governance/memory-status-truth.ts",
    ],
    script_paths: [
      "scripts/memory-governance-audit.ts",
      "scripts/memory-governance-cleanup.ts",
      "scripts/memory-governance-freeze.ts",
      "scripts/memory-governance-revert.ts",
      "scripts/memory-policy-backfill.ts",
      "scripts/memory-pending-canary-report.ts",
      "scripts/memory-pending-governance.ts",
      "scripts/memory-pending.ts",
      "scripts/memory-governance.ts",
      "scripts/memory-governance-dry-run-jobs.ts",
      "scripts/memory-governance-stuck-runs.ts",
      "scripts/memory-type-backfill.ts",
      "scripts/memory-event-lifecycle.ts",
      "scripts/memory-human-review-apply.ts",
      "scripts/governance-ops-smoke.ts",
    ],
    degraded_behavior: "Governance audits, cleanup, freeze/revert, and pending reports are not refreshed automatically; manual review APIs remain available.",
  },
  {
    name: "runtime_observability_retention",
    label: "Runtime observability retention",
    profile: "full",
    maturity: "beta",
    default_enabled: false,
    env_enabled: "MEMORY_XX_RUNTIME_OBSERVABILITY_RETENTION_ENABLED",
    source_paths: ["app/observability/domain-metrics.ts", "app/observability/mcp-tool-invocations.ts", "app/ops/runtime-artifacts-cleanup.ts"],
    script_paths: [
      "scripts/runtime-observability-retention.ts",
      "scripts/trace-retention.ts",
      "scripts/memory-cleanup-runtime-artifacts.ts",
      "scripts/archive-next-residue-logs.ts",
      "scripts/runtime-observability-smoke.ts",
    ],
    degraded_behavior: "Runtime traces and observability artifacts are not compacted automatically; online memory operations continue.",
  },
  {
    name: "write_ticket_maintenance",
    label: "Write ticket maintenance",
    profile: "full",
    maturity: "beta",
    default_enabled: false,
    env_enabled: "MEMORY_XX_WRITE_TICKET_MAINTENANCE_ENABLED",
    source_paths: ["app/db/repositories/write-ticket-repository.ts", "app/write/services/create-memory-candidate-update.ts"],
    script_paths: [
      "scripts/sweep-write-ticket-timeouts.ts",
      "scripts/archive-write-tickets.ts",
      "scripts/sweep-ingest-accepted.ts",
      "scripts/sweep-low-confidence-buffer.ts",
      "scripts/write-ticket-smoke.ts",
    ],
    degraded_behavior: "Expired write tickets are not swept or archived automatically; new writes still use the normal idempotency path.",
  },
  {
    name: "deployment_packaging",
    label: "Deployment packaging and security audit",
    profile: "full",
    maturity: "beta",
    default_enabled: false,
    env_enabled: "MEMORY_XX_DEPLOYMENT_PACKAGING_ENABLED",
    source_paths: ["app/ops/preflight.ts", "app/ops/rollback.ts", "app/runtime-config-validator.ts"],
    script_paths: ["scripts/memory-migration-preflight.ts", "scripts/memory-deployment-bundle.ts", "scripts/memory-secrets-audit.ts", "scripts/backup-ops-smoke.ts"],
    degraded_behavior: "Deployment bundle, migration preflight, and memory-specific secrets audit must be run manually or by external tooling.",
  },
  {
    name: "release_governance_gates",
    label: "Release governance gates",
    profile: "full",
    maturity: "beta",
    default_enabled: false,
    env_enabled: "MEMORY_XX_RELEASE_GOVERNANCE_GATES_ENABLED",
    dependencies: ["landing_scan", "canary_7d_report", "recall_quality"],
    source_paths: ["app/p0-production-gate.ts", "app/p1-production-gate.ts", "app/cutover-gate.ts", "app/governance/memory-landing-scan.ts", "app/governance/memory-canary-7d-report.ts"],
    script_paths: [
      "scripts/p0-production-gate.ts",
      "scripts/p1-production-gate.ts",
      "scripts/cutover-gate.ts",
      "scripts/memory-landing-scan.ts",
      "scripts/memory-canary-7d-report.ts",
      "scripts/freeze-m0.ts",
      "scripts/memory-capacity-audit.ts",
      "scripts/capacity-smoke.ts",
      "scripts/memory-consistency-scan.ts",
      "scripts/dlq-recovery.ts",
      "scripts/memory-quality-metadata-backfill.ts",
      "scripts/run-recall-shadow-r3.ts",
      "scripts/run-projection-shadow-r3.ts",
      "scripts/memory-parity-audit.ts",
      "scripts/verify-open-source-parity.ts",
      "scripts/open-source-full-stack-release-gate.ts",
      "scripts/full-ops-smoke.ts",
    ],
    degraded_behavior: "Release gates, landing/canary evidence, and capacity checks are not refreshed automatically; Core operations continue.",
  },
  {
    name: "self_improvement_ops",
    label: "Self-improvement operations agent",
    profile: "full",
    maturity: "experimental",
    default_enabled: false,
    env_enabled: "MEMORY_XX_SELF_IMPROVEMENT_ENABLED",
    source_paths: ["app/governance/memory-auto-approval-sweep.ts", "app/mcp/mcp-server.ts"],
    script_paths: [
      "scripts/memory-self-improvement.ts",
      "scripts/memory-evolve.ts",
      "scripts/memory-observation-reflection.ts",
      "scripts/memory-procedural-promotion-candidates.ts",
      "scripts/memory-graphiti-shadow-export.ts",
      "scripts/memory-sweep-test-pollution.ts",
      "scripts/self-improvement-ops-smoke.ts",
    ],
    degraded_behavior: "Report-only self-improvement proposals and Graphiti shadow export are disabled; normal governance and review continue.",
  },
];

export function buildFullStackCapabilitySnapshot(
  env: FullStackCapabilityEnv = process.env
): FullStackCapabilitySnapshot {
  const runtimeProfile = parseRuntimeProfile(env.MEMORY_XX_RUNTIME_PROFILE);
  const runtimeStates = new Map(resolveRuntimeModuleStates(runtimeProfile, env).map((state) => [state.module.name, state]));
  const capabilityNames = new Set(FULL_STACK_CAPABILITIES.map((capability) => capability.name));
  const preliminary = new Map<string, FullStackCapabilitySnapshotItem>();

  for (const capability of FULL_STACK_CAPABILITIES) {
    const enabled = readCapabilityEnabled(capability, env);
    preliminary.set(capability.name, {
      state: enabled ? "enabled" : "disabled",
      enabled,
      label: capability.label,
      profile: capability.profile,
      maturity: capability.maturity,
      env_enabled: capability.env_enabled,
      dependencies: capability.dependencies,
      source_paths: capability.source_paths,
      script_paths: capability.script_paths,
      degraded_behavior: capability.degraded_behavior,
      reason: enabled ? undefined : capability.env_enabled ? `${capability.env_enabled}=disabled` : "capability_disabled",
    });
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const capability of FULL_STACK_CAPABILITIES) {
      const current = preliminary.get(capability.name);
      if (!current || current.state !== "enabled") continue;

      const unavailable = (capability.dependencies ?? [])
        .map((dependency) => {
          const runtime = runtimeStates.get(dependency);
          if (runtime) return { name: dependency, state: runtime.state };
          const capabilityState = capabilityNames.has(dependency) ? preliminary.get(dependency) : undefined;
          if (capabilityState) return { name: dependency, state: capabilityState.state };
          return { name: dependency, state: "missing_dependency" as const };
        })
        .find((dependency) => dependency.state !== "enabled");

      if (!unavailable) continue;
      preliminary.set(capability.name, {
        ...current,
        state: "missing_dependency",
        reason: `dependency_unavailable:${unavailable.name}:${unavailable.state}`,
      });
      changed = true;
    }
  }

  const entries = [...preliminary.entries()];
  const enabled = entries.filter(([, state]) => state.enabled).map(([name]) => name);
  const disabled = entries.filter(([, state]) => state.state === "disabled").map(([name]) => name);
  const missingDependency = entries.filter(([, state]) => state.state === "missing_dependency").map(([name]) => name);
  return {
    enabled,
    disabled,
    missing_dependency: missingDependency,
    states: Object.fromEntries(entries),
  };
}

function parseRuntimeProfile(raw?: string): "core" | "enhanced" | "full" {
  const normalized = (raw ?? "core").trim().toLowerCase();
  return normalized === "enhanced" || normalized === "full" ? normalized : "core";
}

// `enabled` reflects operator intent; `state` reflects whether dependencies can
// actually support that capability in the current environment.

function readCapabilityEnabled(capability: FullStackCapability, env: FullStackCapabilityEnv): boolean {
  if (!capability.env_enabled) return capability.default_enabled;
  const raw = env[capability.env_enabled]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return capability.default_enabled;
  if (["1", "true", "yes", "on", "enabled"].includes(raw)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(raw)) return false;
  return capability.default_enabled;
}

export type FullStackCapabilityProfile = "core" | "enhanced" | "full";
export type FullStackCapabilityMaturity = "stable" | "beta" | "experimental";

export interface FullStackCapability {
  readonly name: string;
  readonly label: string;
  readonly profile: FullStackCapabilityProfile;
  readonly maturity: FullStackCapabilityMaturity;
  readonly default_enabled: boolean;
  readonly env_enabled?: string;
  readonly source_paths: readonly string[];
  readonly script_paths: readonly string[];
  readonly degraded_behavior: string;
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
    script_paths: ["scripts/memory-knowledge-md.ts"],
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
    script_paths: ["scripts/memory-graph-report.ts", "scripts/graph-health.ts"],
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
    script_paths: ["scripts/decay-run.ts", "scripts/temporal-sweep.ts"],
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
    script_paths: ["scripts/memory-consolidate.ts"],
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
    script_paths: [],
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
    script_paths: ["scripts/memory-policy-corpus.ts", "scripts/memory-policy-eval.ts", "scripts/memory-policy-report.ts"],
    degraded_behavior: "Policy evaluation reports are not refreshed automatically; runtime policy still executes.",
  },
  {
    name: "recall_quality",
    label: "Recall quality evaluation",
    profile: "full",
    maturity: "beta",
    default_enabled: false,
    env_enabled: "MEMORY_XX_RECALL_QUALITY_ENABLED",
    source_paths: ["app/recall/orchestrator.ts", "app/recall/reranker.ts"],
    script_paths: ["scripts/memory-quality.ts", "scripts/intelligence-quality.ts", "scripts/benchmark-reranker-policy.ts"],
    degraded_behavior: "Release quality evidence is not refreshed automatically; recall still uses configured runtime paths.",
  },
];

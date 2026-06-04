export type MemoryRuntimeProfile = "core" | "enhanced" | "full";
export type RuntimeModuleKind = "core" | "external" | "sidecar" | "worker" | "control" | "gate";
export type RuntimeModuleState = "enabled" | "disabled" | "degraded" | "missing_dependency";

export interface RuntimeModule {
  readonly name: string;
  readonly label: string;
  readonly kind: RuntimeModuleKind;
  readonly required_in: readonly MemoryRuntimeProfile[];
  readonly expected_in?: readonly MemoryRuntimeProfile[];
  readonly env_enabled?: string;
  readonly env_source_available?: string;
  readonly default_enabled?: boolean;
  readonly service?: string;
  readonly health_url?: string;
  readonly health_url_env?: string;
  readonly health_url_env_fallbacks?: readonly string[];
  readonly require_health_url_when_enabled?: boolean;
  readonly source_path?: string;
  readonly command?: string;
  readonly dependencies?: readonly string[];
  readonly degraded_behavior: string;
  readonly startable?: boolean;
  readonly stop_with_profile?: boolean;
}

export interface RuntimeModulePlan {
  readonly profile: MemoryRuntimeProfile;
  readonly required_modules: readonly RuntimeModule[];
  readonly expected_modules: readonly RuntimeModule[];
  readonly optional_modules: readonly RuntimeModule[];
  readonly gates: readonly RuntimeModule[];
}

export interface RuntimeModuleResolvedState {
  readonly module: RuntimeModule;
  readonly state: RuntimeModuleState;
  readonly enabled: boolean;
  readonly blocks_profile: boolean;
  readonly reason?: string;
}

export type RuntimeEnv = Pick<NodeJS.ProcessEnv, string>;

export interface RuntimeModuleSnapshotItem {
  readonly state: RuntimeModuleState;
  readonly role: "required" | "expected" | "optional";
  readonly enabled: boolean;
  readonly blocks_profile: boolean;
  readonly label: string;
  readonly kind: RuntimeModuleKind;
  readonly service?: string;
  readonly health_url?: string;
  readonly require_health_url_when_enabled?: boolean;
  readonly source_path?: string;
  readonly env_enabled?: string;
  readonly dependencies?: readonly string[];
  readonly degraded_behavior: string;
  readonly reason?: string;
}

export interface RuntimeModuleSnapshot {
  readonly mode: MemoryRuntimeProfile;
  readonly required_modules: readonly string[];
  readonly expected_modules: readonly string[];
  readonly optional_modules: readonly string[];
  readonly states: Readonly<Record<string, RuntimeModuleSnapshotItem>>;
}

const DEFAULT_WRAPPER_HEALTH_URL = process.env.MEMORY_XX_WRAPPER_HEALTH_URL?.trim() || "http://127.0.0.1:5100/health";
const DEFAULT_EMBEDDING_PROXY_HEALTH_URL = process.env.MEMORY_XX_EMBEDDING_PROXY_HEALTH_URL?.trim() || "http://127.0.0.1:5221/health";
const DEFAULT_FASTPATH_HEALTH_URL = process.env.MEMORY_XX_FASTPATH_HEALTH_URL?.trim() || "http://127.0.0.1:5200/health";
const DEFAULT_LEXICAL_HEALTH_URL = process.env.MEMORY_XX_LEXICAL_HEALTH_URL?.trim() || "http://127.0.0.1:5210/health";
const DEFAULT_RERANKER_HEALTH_URL = process.env.MEMORY_XX_RERANKER_HEALTH_URL?.trim() || "http://127.0.0.1:8085/health";
const DEFAULT_QDRANT_PROXY_HEALTH_URL = process.env.MEMORY_XX_QDRANT_PROXY_HEALTH_URL?.trim() || "http://127.0.0.1:6334/health";
const DEFAULT_MEM0_EXTRACTOR_HEALTH_URL = process.env.MEMORY_XX_MEM0_EXTRACTOR_HEALTH_URL?.trim() || "http://127.0.0.1:5220/health";
const DEFAULT_CONTROL_PANEL_HEALTH_URL = process.env.MEMORY_XX_CONTROL_PANEL_HEALTH_URL?.trim() || "http://127.0.0.1:5310/health";

export const RUNTIME_MODULES: readonly RuntimeModule[] = [
  {
    name: "wrapper",
    label: "memory-xx wrapper HTTP API",
    kind: "core",
    service: "memory-xx-wrapper.service",
    health_url: DEFAULT_WRAPPER_HEALTH_URL,
    health_url_env: "MEMORY_XX_WRAPPER_HEALTH_URL",
    required_in: ["core", "enhanced", "full"],
    default_enabled: true,
    startable: true,
    degraded_behavior: "HTTP/MCP memory API is unavailable.",
  },
  {
    name: "postgres",
    label: "PostgreSQL truth ledger",
    kind: "external",
    required_in: ["core", "enhanced", "full"],
    default_enabled: true,
    degraded_behavior: "Writes, review state, and recall ledger access fail.",
  },
  {
    name: "redis",
    label: "Redis cache and coordination",
    kind: "external",
    required_in: ["core", "enhanced", "full"],
    default_enabled: true,
    degraded_behavior: "Cache and coordination are bypassed; throughput and latency degrade.",
  },
  {
    name: "qdrant",
    label: "Qdrant vector projection",
    kind: "external",
    required_in: ["core", "enhanced", "full"],
    default_enabled: true,
    degraded_behavior: "Vector recall and current projection are unavailable.",
  },
  {
    name: "embedding_proxy",
    label: "Embedding proxy",
    kind: "sidecar",
    env_enabled: "MEMORY_XX_EMBEDDING_PROXY_ENABLED",
    env_source_available: "MEMORY_XX_EMBEDDING_PROXY_SOURCE_AVAILABLE",
    service: "memory-xx-embedding-proxy-next.service",
    health_url: DEFAULT_EMBEDDING_PROXY_HEALTH_URL,
    health_url_env: "MEMORY_XX_EMBEDDING_PROXY_HEALTH_URL",
    source_path: "sidecars/embedding-proxy/embedding-proxy.mjs",
    required_in: ["core", "enhanced", "full"],
    default_enabled: true,
    startable: true,
    degraded_behavior: "New query/write vectors fall back to cached/old results or non-vector paths.",
  },
  {
    name: "embedding_upstream",
    label: "OpenAI-compatible embedding upstream",
    kind: "external",
    env_enabled: "MEMORY_XX_EMBEDDING_UPSTREAM_ENABLED",
    service: "memory-xx-embedding-upstream.service",
    health_url: "http://127.0.0.1:8082/v3/models",
    health_url_env: "MEMORY_XX_EMBEDDING_UPSTREAM_HEALTH_URL",
    required_in: [],
    expected_in: ["core", "enhanced", "full"],
    default_enabled: true,
    startable: true,
    degraded_behavior: "Embedding proxy is online but cannot generate new vectors.",
  },
  {
    name: "projector",
    label: "Qdrant projector worker",
    kind: "worker",
    service: "memory-xx-qdrant-projector-worker.service",
    source_path: "scripts/run-qdrant-projector-worker.ts",
    required_in: ["core", "enhanced", "full"],
    default_enabled: true,
    startable: true,
    degraded_behavior: "Committed writes wait in outbox and Qdrant freshness lags.",
  },
  {
    name: "qdrant_proxy",
    label: "Qdrant collection proxy",
    kind: "sidecar",
    env_enabled: "MEMORY_XX_QDRANT_PROXY_ENABLED",
    env_source_available: "MEMORY_XX_QDRANT_PROXY_SOURCE_AVAILABLE",
    service: "memory-xx-qdrant-proxy-next.service",
    health_url: DEFAULT_QDRANT_PROXY_HEALTH_URL,
    health_url_env: "MEMORY_XX_QDRANT_PROXY_HEALTH_URL",
    source_path: "sidecars/qdrant-proxy/qdrant-collection-proxy.mjs",
    dependencies: ["qdrant"],
    required_in: [],
    expected_in: ["enhanced", "full"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "Collection blue/green routing is disabled; wrapper talks directly to Qdrant.",
  },
  {
    name: "fastpath",
    label: "Fastpath recall sidecar",
    kind: "sidecar",
    env_enabled: "MEMORY_XX_FASTPATH_ENABLED",
    env_source_available: "MEMORY_XX_FASTPATH_SOURCE_AVAILABLE",
    service: "memory-xx-fastpath.service",
    health_url: DEFAULT_FASTPATH_HEALTH_URL,
    health_url_env: "MEMORY_XX_FASTPATH_HEALTH_URL",
    source_path: "sidecars/fastpath/fastpath.mjs",
    dependencies: ["postgres", "redis", "qdrant", "embedding_proxy"],
    required_in: ["full"],
    expected_in: ["enhanced"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "Recall falls back to the Node wrapper path with higher latency.",
  },
  {
    name: "lexical_sidecar",
    label: "Lexical recall sidecar",
    kind: "sidecar",
    env_enabled: "MEMORY_XX_LEXICAL_SIDECAR_ENABLED",
    env_source_available: "MEMORY_XX_LEXICAL_SIDECAR_SOURCE_AVAILABLE",
    service: "memory-xx-lexical-sidecar.service",
    health_url: DEFAULT_LEXICAL_HEALTH_URL,
    health_url_env: "MEMORY_XX_LEXICAL_HEALTH_URL",
    source_path: "sidecars/lexical-sidecar/lexical-sidecar.mjs",
    dependencies: ["postgres"],
    required_in: ["full"],
    expected_in: ["enhanced"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "Exact keyword and hybrid recall quality degrade; vector/PostgreSQL fallback remains available.",
  },
  {
    name: "reranker_upstream",
    label: "OpenAI-compatible reranker upstream",
    kind: "external",
    env_enabled: "MEMORY_XX_RERANKER_UPSTREAM_ENABLED",
    service: "memory-xx-reranker-upstream.service",
    health_url_env: "MEMORY_XX_RERANKER_UPSTREAM_HEALTH_URL",
    health_url_env_fallbacks: ["MEMORY_XX_RERANKER_UPSTREAM_MODELS_URL", "MEMORY_XX_RERANKER_DOWNSTREAM_MODELS_URL"],
    require_health_url_when_enabled: true,
    required_in: ["full"],
    expected_in: ["enhanced"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "Reranker adapter is online but cannot call a model.",
  },
  {
    name: "reranker_adapter",
    label: "Reranker adapter",
    kind: "sidecar",
    env_enabled: "MEMORY_XX_RERANKER_ADAPTER_ENABLED",
    env_source_available: "MEMORY_XX_RERANKER_ADAPTER_SOURCE_AVAILABLE",
    service: "memory-xx-reranker-adapter-next.service",
    health_url: DEFAULT_RERANKER_HEALTH_URL,
    health_url_env: "MEMORY_XX_RERANKER_HEALTH_URL",
    source_path: "sidecars/reranker-adapter/reranker-adapter.mjs",
    dependencies: ["reranker_upstream"],
    required_in: ["full"],
    expected_in: ["enhanced"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "Model reranking is skipped and local rank fusion is used.",
  },
  {
    name: "llm_upstream",
    label: "OpenAI-compatible LLM upstream",
    kind: "external",
    env_enabled: "MEMORY_XX_LLM_UPSTREAM_ENABLED",
    health_url_env: "MEMORY_XX_LLM_UPSTREAM_HEALTH_URL",
    health_url_env_fallbacks: ["MEMORY_XX_MEM0_BASE_URL", "MEMORY_INTELLIGENCE_BASE_URL"],
    require_health_url_when_enabled: true,
    required_in: ["full"],
    expected_in: ["enhanced"],
    default_enabled: false,
    degraded_behavior: "Mem0 extraction and LLM-backed intelligence use built-in heuristics or remain disabled.",
  },
  {
    name: "mem0_extractor",
    label: "Mem0-style extraction sidecar",
    kind: "sidecar",
    env_enabled: "MEMORY_XX_MEM0_EXTRACTOR_ENABLED",
    env_source_available: "MEMORY_XX_MEM0_EXTRACTOR_SOURCE_AVAILABLE",
    service: "memory-xx-mem0-extractor.service",
    health_url: DEFAULT_MEM0_EXTRACTOR_HEALTH_URL,
    health_url_env: "MEMORY_XX_MEM0_EXTRACTOR_HEALTH_URL",
    source_path: "sidecars/mem0-extractor/extractor.py",
    dependencies: ["llm_upstream"],
    required_in: ["full"],
    expected_in: ["enhanced"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "Smart extraction falls back to built-in heuristics or manual write paths.",
  },
  {
    name: "conversation_monitor",
    label: "Conversation monitor worker",
    kind: "worker",
    env_enabled: "MEMORY_XX_CONVERSATION_MONITOR_ENABLED",
    service: "memory-xx-conversation-monitor-worker.service",
    source_path: "scripts/run-conversation-monitor-worker.ts",
    dependencies: ["postgres", "wrapper"],
    required_in: ["full"],
    expected_in: ["enhanced"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "Session ingestion is disabled; direct HTTP/MCP memory operations continue.",
  },
  {
    name: "markdown_projection",
    label: "Markdown projection exporter",
    kind: "worker",
    env_enabled: "MEMORY_XX_MARKDOWN_PROJECTION_ENABLED",
    service: "memory-xx-markdown-projection.service",
    source_path: "scripts/run-markdown-projection-worker.ts",
    dependencies: ["postgres"],
    required_in: [],
    expected_in: ["full"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "PostgreSQL remains the source of truth; Markdown review projections are not refreshed.",
  },
  {
    name: "memory_dreaming",
    label: "Memory dreaming worker",
    kind: "worker",
    env_enabled: "MEMORY_XX_DREAMING_ENABLED",
    service: "memory-xx-dream-worker.service",
    source_path: "scripts/run-dream-worker.ts",
    dependencies: ["wrapper"],
    required_in: [],
    expected_in: ["full"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "Background dreaming/promoted insight generation is disabled; explicit write/recall continues.",
  },
  {
    name: "control_panel",
    label: "Local control panel",
    kind: "control",
    env_enabled: "MEMORY_XX_CONTROL_PANEL_ENABLED",
    service: "memory-xx-control-panel.service",
    health_url: DEFAULT_CONTROL_PANEL_HEALTH_URL,
    health_url_env: "MEMORY_XX_CONTROL_PANEL_HEALTH_URL",
    source_path: "scripts/memory-control-panel.ts",
    dependencies: ["wrapper"],
    required_in: ["full"],
    expected_in: ["enhanced"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "CLI and API operations continue; web operations console is unavailable.",
  },
  {
    name: "cache_invalidation_worker",
    label: "Cache invalidation worker",
    kind: "worker",
    env_enabled: "MEMORY_XX_CACHE_INVALIDATION_WORKER_ENABLED",
    service: "memory-xx-cache-invalidation-worker.service",
    source_path: "scripts/run-cache-invalidation-worker.ts",
    dependencies: ["postgres", "redis"],
    required_in: [],
    expected_in: ["full"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "Durable cache invalidation requests are not drained automatically; direct write/recall continues and operators can run the worker manually.",
  },
  {
    name: "write_ticket_worker",
    label: "Write ticket worker",
    kind: "worker",
    env_enabled: "MEMORY_XX_WRITE_TICKET_WORKER_ENABLED",
    service: "memory-xx-write-ticket-worker.service",
    source_path: "scripts/run-write-ticket-worker.ts",
    dependencies: ["postgres"],
    required_in: [],
    expected_in: ["full"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "Asynchronous fast_ack write tickets are not processed automatically; synchronous write paths continue.",
  },
  {
    name: "maintenance_orchestrator",
    label: "Maintenance orchestrator",
    kind: "worker",
    env_enabled: "MEMORY_XX_MAINTENANCE_ENABLED",
    service: "memory-xx-maintenance.service",
    source_path: "scripts/maintenance.ts",
    dependencies: ["postgres", "redis", "qdrant", "projector"],
    required_in: [],
    expected_in: ["full"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "Scheduled maintenance is disabled; manual repair, sweep, and governance commands remain available.",
  },
  {
    name: "temporal_consolidation",
    label: "Temporal consolidation job",
    kind: "worker",
    env_enabled: "MEMORY_XX_CONSOLIDATION_ENABLED",
    service: "memory-xx-consolidation.service",
    source_path: "scripts/memory-consolidate.ts",
    dependencies: ["postgres"],
    required_in: [],
    expected_in: ["full"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "Temporal consolidation and archive recommendations are not run automatically.",
  },
  {
    name: "runtime_issue_detection",
    label: "Runtime issue detection",
    kind: "gate",
    env_enabled: "MEMORY_XX_RUNTIME_ISSUE_DETECTION_ENABLED",
    service: "memory-xx-detect.service",
    command: "TMPDIR=/tmp npm run memory:auto-repair -- --json",
    dependencies: ["wrapper", "projector"],
    required_in: [],
    expected_in: ["full"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "Automatic runtime issue detection is disabled; manual Doctor and repair checks remain available.",
  },
  {
    name: "auto_repair",
    label: "Safe automatic repair",
    kind: "worker",
    env_enabled: "MEMORY_XX_AUTO_REPAIR_ENABLED",
    service: "memory-xx-auto-repair.service",
    source_path: "scripts/memory-auto-repair.ts",
    command: "TMPDIR=/tmp npm run memory:auto-repair -- --apply --json",
    dependencies: ["postgres", "qdrant", "projector"],
    required_in: [],
    expected_in: ["full"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "Automatic repair is disabled; Qdrant and embedding repair must be run manually.",
  },
  {
    name: "repair_report",
    label: "Repair report",
    kind: "gate",
    env_enabled: "MEMORY_XX_REPAIR_REPORT_ENABLED",
    service: "memory-xx-repair-report.service",
    command: "TMPDIR=/tmp npm run memory:auto-repair -- --json && TMPDIR=/tmp npm run memory:doctor -- --target ops-ready --mode full --plan",
    dependencies: ["wrapper", "projector", "auto_repair"],
    required_in: [],
    expected_in: ["full"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "Daily repair reporting is disabled; operators must inspect Doctor and repair output manually.",
  },
  {
    name: "landing_scan",
    label: "Production landing scan",
    kind: "gate",
    env_enabled: "MEMORY_XX_LANDING_SCAN_ENABLED",
    service: "memory-xx-landing-scan.service",
    command: "TMPDIR=/tmp npm run memory:landing-scan -- --json --write-report --max-files=200",
    dependencies: ["wrapper"],
    required_in: [],
    expected_in: ["full"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "Production landing evidence is not refreshed automatically.",
  },
  {
    name: "canary_7d_report",
    label: "7-day production canary report",
    kind: "gate",
    env_enabled: "MEMORY_XX_CANARY_7D_REPORT_ENABLED",
    service: "memory-xx-canary-7d-report.service",
    command: "TMPDIR=/tmp npm run memory:canary-7d-report -- --json --write-report",
    dependencies: ["landing_scan"],
    required_in: [],
    expected_in: ["full"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "7-day canary evidence is not refreshed automatically.",
  },
  {
    name: "quality_runner",
    label: "Recall quality gates",
    kind: "gate",
    env_enabled: "MEMORY_XX_QUALITY_RUNNER_ENABLED",
    service: "memory-xx-quality-runner.service",
    command: "TMPDIR=/tmp npm run memory:quality -- --suite all",
    required_in: ["full"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "Recall quality has not completed release validation.",
  },
  {
    name: "governance_report",
    label: "Governance release report",
    kind: "gate",
    env_enabled: "MEMORY_XX_GOVERNANCE_REPORT_ENABLED",
    service: "memory-xx-governance-report.service",
    command: "TMPDIR=/tmp npm run memory:pending -- --limit=100 && TMPDIR=/tmp npm run memory:governance -- --dry-run --json",
    required_in: ["full"],
    default_enabled: false,
    startable: true,
    stop_with_profile: true,
    degraded_behavior: "Governance backlog has not completed release validation.",
  },
];

export function buildRuntimeModulePlan(profile: MemoryRuntimeProfile): RuntimeModulePlan {
  const required = RUNTIME_MODULES.filter((module) => module.required_in.includes(profile));
  const expected = RUNTIME_MODULES.filter((module) => module.expected_in?.includes(profile));
  const optional = RUNTIME_MODULES.filter(
    (module) => !module.required_in.includes(profile) && !(module.expected_in?.includes(profile))
  );
  return {
    profile,
    required_modules: required,
    expected_modules: expected,
    optional_modules: optional,
    gates: RUNTIME_MODULES.filter((module) => module.kind === "gate"),
  };
}

export function resolveRuntimeModuleStates(
  profile: MemoryRuntimeProfile,
  env: RuntimeEnv = process.env
): readonly RuntimeModuleResolvedState[] {
  const states = new Map<string, RuntimeModuleResolvedState>(
    RUNTIME_MODULES.map((module) => [module.name, resolveRuntimeModuleSelfState(module, profile, env)])
  );

  let changed = true;
  while (changed) {
    changed = false;
    for (const module of RUNTIME_MODULES) {
      const current = states.get(module.name);
      if (!current || current.state !== "enabled") continue;

      const unavailable = (module.dependencies ?? [])
        .map((dependency) => states.get(dependency))
        .find((dependency) => !dependency || dependency.state !== "enabled");

      if (!unavailable) continue;

      states.set(module.name, {
        module,
        state: "missing_dependency",
        enabled: true,
        blocks_profile: module.required_in.includes(profile),
        reason: unavailable
          ? `dependency_unavailable:${unavailable.module.name}:${unavailable.state}`
          : "dependency_unavailable:unknown",
      });
      changed = true;
    }
  }

  return RUNTIME_MODULES.map((module) => states.get(module.name) ?? resolveRuntimeModuleSelfState(module, profile, env));
}

export function resolveRuntimeModuleState(
  module: RuntimeModule,
  profile: MemoryRuntimeProfile,
  env: RuntimeEnv = process.env
): RuntimeModuleResolvedState {
  return resolveRuntimeModuleStates(profile, env).find((state) => state.module.name === module.name)
    ?? resolveRuntimeModuleSelfState(module, profile, env);
}

function resolveRuntimeModuleSelfState(
  module: RuntimeModule,
  profile: MemoryRuntimeProfile,
  env: RuntimeEnv
): RuntimeModuleResolvedState {
  const required = module.required_in.includes(profile);
  const expected = module.expected_in?.includes(profile) ?? false;
  const enabled = readEnabled(module, required || expected, env);
  if (!enabled) {
    return {
      module,
      state: "disabled",
      enabled: false,
      blocks_profile: false,
      reason: module.env_enabled ? `${module.env_enabled}=disabled` : "module_disabled",
    };
  }

  if (module.env_source_available && envFlag(module.env_source_available, env) === false) {
    return {
      module,
      state: "missing_dependency",
      enabled: true,
      blocks_profile: required,
      reason: `${module.env_source_available}=disabled`,
    };
  }

  const healthUrl = resolveRuntimeModuleHealthUrl(module, env);
  if (module.require_health_url_when_enabled && !healthUrl) {
    return {
      module,
      state: "missing_dependency",
      enabled: true,
      blocks_profile: required,
      reason: "health_url_unconfigured",
    };
  }

  return {
    module,
    state: "enabled",
    enabled: true,
    blocks_profile: false,
  };
}

export function buildRuntimeModuleSnapshot(
  profile: MemoryRuntimeProfile,
  env: RuntimeEnv = process.env
): RuntimeModuleSnapshot {
  const plan = buildRuntimeModulePlan(profile);
  const states = Object.fromEntries(resolveRuntimeModuleStates(profile, env).map((resolved) => {
    const role = resolved.module.required_in.includes(profile)
      ? "required"
      : resolved.module.expected_in?.includes(profile)
        ? "expected"
        : "optional";
    const item: RuntimeModuleSnapshotItem = {
      state: resolved.state,
      role,
      enabled: resolved.enabled,
      blocks_profile: resolved.blocks_profile,
      label: resolved.module.label,
      kind: resolved.module.kind,
      service: resolved.module.service,
      health_url: resolveRuntimeModuleHealthUrl(resolved.module, env),
      require_health_url_when_enabled: resolved.module.require_health_url_when_enabled,
      source_path: resolved.module.source_path,
      env_enabled: resolved.module.env_enabled,
      dependencies: resolved.module.dependencies,
      degraded_behavior: resolved.module.degraded_behavior,
      reason: resolved.reason,
    };
    return [resolved.module.name, item];
  }));

  return {
    mode: profile,
    required_modules: plan.required_modules.map((module) => module.name),
    expected_modules: plan.expected_modules.map((module) => module.name),
    optional_modules: plan.optional_modules.map((module) => module.name),
    states,
  };
}

export function resolveRuntimeModuleHealthUrl(module: RuntimeModule, env: RuntimeEnv = process.env): string | undefined {
  for (const name of [module.health_url_env, ...(module.health_url_env_fallbacks ?? [])]) {
    if (!name) continue;
    const value = env[name]?.trim();
    if (value) return value;
  }
  return module.health_url?.trim() || undefined;
}

function readEnabled(module: RuntimeModule, profileDefault: boolean, env: RuntimeEnv): boolean {
  if (!module.env_enabled) return module.default_enabled ?? profileDefault;
  const explicit = envFlag(module.env_enabled, env);
  if (explicit !== null) return explicit;
  return profileDefault || (module.default_enabled ?? false);
}

function envFlag(name: string, env: RuntimeEnv): boolean | null {
  const raw = env[name];
  if (raw === undefined) return null;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return null;
}

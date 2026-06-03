export type MemoryRuntimeProfile = "core" | "enhanced" | "full";

export type RuntimeComponentKind = "http" | "external" | "systemd" | "gate";

export interface RuntimeProfileComponent {
  readonly name: string;
  readonly label: string;
  readonly kind: RuntimeComponentKind;
  readonly required_in: readonly MemoryRuntimeProfile[];
  readonly expected_in?: readonly MemoryRuntimeProfile[];
  readonly degraded_behavior: string;
  readonly service?: string;
  readonly health_url?: string;
  readonly command?: string;
  readonly startable?: boolean;
  readonly stop_with_profile?: boolean;
}

export interface RuntimeProfilePlan {
  readonly profile: MemoryRuntimeProfile;
  readonly required_components: readonly RuntimeProfileComponent[];
  readonly expected_components: readonly RuntimeProfileComponent[];
  readonly optional_components: readonly RuntimeProfileComponent[];
  readonly full_gates: readonly RuntimeProfileComponent[];
}

const PROFILE_ORDER: readonly MemoryRuntimeProfile[] = ["core", "enhanced", "full"];
const DEFAULT_WRAPPER_HEALTH_URL = process.env.MEMORY_V2_WRAPPER_HEALTH_URL?.trim() || "http://127.0.0.1:5100/health";
const DEFAULT_EMBEDDING_PROXY_HEALTH_URL = process.env.MEMORY_V2_EMBEDDING_PROXY_HEALTH_URL?.trim() || "http://127.0.0.1:5221/health";
const DEFAULT_OVMS_UPSTREAM_URL = process.env.MEMORY_V2_OVMS_UPSTREAM_URL?.trim() || "http://127.0.0.1:8082/v3";
const DEFAULT_FASTPATH_HEALTH_URL = process.env.MEMORY_V2_FASTPATH_HEALTH_URL?.trim() || "http://127.0.0.1:5200/health";
const DEFAULT_LEXICAL_HEALTH_URL = process.env.MEMORY_V2_LEXICAL_HEALTH_URL?.trim() || "http://127.0.0.1:5210/health";
const DEFAULT_RERANKER_HEALTH_URL = process.env.MEMORY_V2_RERANKER_HEALTH_URL?.trim() || "http://127.0.0.1:8085/health";

export function parseMemoryRuntimeProfile(raw?: string): MemoryRuntimeProfile {
  const normalized = (raw ?? process.env.MEMORY_V2_RUNTIME_PROFILE ?? "core").trim().toLowerCase();
  return normalized === "enhanced" || normalized === "full" ? normalized : "core";
}

export function profileIncludes(profile: MemoryRuntimeProfile, baseline: MemoryRuntimeProfile): boolean {
  return PROFILE_ORDER.indexOf(profile) >= PROFILE_ORDER.indexOf(baseline);
}

export const RUNTIME_COMPONENTS: readonly RuntimeProfileComponent[] = [
  {
    name: "wrapper",
    label: "记忆 V2 主服务（Memory XX）",
    kind: "http",
    service: "memory-xx-wrapper.service",
    health_url: DEFAULT_WRAPPER_HEALTH_URL,
    required_in: ["core", "enhanced", "full"],
    degraded_behavior: "记忆 HTTP API（接口）不可用。",
    startable: true,
  },
  {
    name: "postgres",
    label: "关系数据库（PostgreSQL）",
    kind: "external",
    required_in: ["core", "enhanced", "full"],
    degraded_behavior: "所有写入和召回操作都会失败。",
  },
  {
    name: "redis",
    label: "缓存服务（Redis）",
    kind: "external",
    required_in: ["core", "enhanced", "full"],
    degraded_behavior: "缓存和协同能力降级，吞吐量下降。",
  },
  {
    name: "qdrant",
    label: "向量库（Qdrant）",
    kind: "external",
    required_in: ["core", "enhanced", "full"],
    degraded_behavior: "向量召回和向量投影不可用。",
  },
  {
    name: "embedding_proxy",
    label: "向量生成代理（Embedding）",
    kind: "http",
    service: "memory-xx-embedding-proxy-next.service",
    health_url: DEFAULT_EMBEDDING_PROXY_HEALTH_URL,
    required_in: ["core", "enhanced", "full"],
    degraded_behavior: "查询/写入向量降级为缓存、旧结果或纯关键词路径。",
    startable: true,
  },
  {
    name: "ovms_upstream",
    label: "本地 OVMS embedding 上游",
    kind: "systemd",
    service: "memory-xx-embedding-upstream.service",
    health_url: DEFAULT_OVMS_UPSTREAM_URL,
    required_in: ["core", "enhanced", "full"],
    degraded_behavior: "向量生成代理（Embedding）在线，但无法生成新的本地 Qwen3 向量。",
    startable: true,
  },
  {
    name: "projector",
    label: "向量投影后台任务（Qdrant projector worker）",
    kind: "systemd",
    service: "memory-xx-qdrant-projector-worker.service",
    required_in: ["core", "enhanced", "full"],
    degraded_behavior: "已提交写入需要依赖 outbox 重放，Qdrant 新鲜度会滞后。",
    startable: true,
  },
  {
    name: "fastpath",
    label: "快速召回路径（Go）",
    kind: "http",
    service: "memory-xx-fastpath.service",
    health_url: DEFAULT_FASTPATH_HEALTH_URL,
    required_in: ["full"],
    expected_in: ["enhanced"],
    degraded_behavior: "主服务回退到 Node 召回路径，延迟可能上升。",
    startable: true,
    stop_with_profile: true,
  },
  {
    name: "lexical",
    label: "关键词召回侧车（Rust）",
    kind: "http",
    service: "memory-xx-lexical-sidecar.service",
    health_url: DEFAULT_LEXICAL_HEALTH_URL,
    required_in: ["full"],
    expected_in: ["enhanced"],
    degraded_behavior: "精确匹配和来源召回质量下降，但仍可回退到向量/PostgreSQL。",
    startable: true,
    stop_with_profile: true,
  },
  {
    name: "reranker_upstream",
    label: "本地 Qwen3 reranker 上游",
    kind: "systemd",
    service: "memory-xx-reranker-upstream.service",
    health_url: "http://127.0.0.1:8084/v3/models",
    required_in: ["full"],
    expected_in: ["enhanced"],
    degraded_behavior: "重排序适配器在线，但无法调用 Windows GPU 上的 Qwen3 reranker 模型。",
    startable: true,
    stop_with_profile: true,
  },
  {
    name: "reranker",
    label: "重排序模型适配器",
    kind: "http",
    service: "memory-xx-reranker-adapter-next.service",
    health_url: DEFAULT_RERANKER_HEALTH_URL,
    required_in: ["full"],
    expected_in: ["enhanced"],
    degraded_behavior: "跳过模型重排序，保留本地排序。",
    startable: true,
    stop_with_profile: true,
  },
  {
    name: "graph_recall",
    label: "图谱召回基准",
    kind: "gate",
    command: "TMPDIR=/tmp npm run test:graph-recall",
    required_in: ["full"],
    expected_in: ["enhanced"],
    degraded_behavior: "复杂关系和时间线证据没有完成发布验证。",
  },
  {
    name: "quality_runner",
    label: "召回质量测试",
    kind: "gate",
    command: "TMPDIR=/tmp npm run memory:quality -- --suite all",
    required_in: ["full"],
    degraded_behavior: "召回质量没有完成发布验证。",
  },
  {
    name: "embedding_manifest_validator",
    label: "嵌入清单校验器（Embedding manifest）",
    kind: "gate",
    command: "TMPDIR=/tmp npm run memory:embedding-manifest -- validate -- --generation-id=<active-generation>",
    required_in: ["full"],
    degraded_behavior: "向量生成（Embedding）版本切换没有完成完整验证。",
  },
  {
    name: "governance_report",
    label: "治理和报告脚本",
    kind: "gate",
    command: "TMPDIR=/tmp npm run memory:pending -- --limit=100 && TMPDIR=/tmp npm run memory:governance -- --dry-run --json",
    required_in: ["full"],
    degraded_behavior: "治理积压没有完成发布前检查。",
  },
];

export function buildRuntimeProfilePlan(profile: MemoryRuntimeProfile): RuntimeProfilePlan {
  const required = RUNTIME_COMPONENTS.filter((component) => component.required_in.includes(profile));
  const expected = RUNTIME_COMPONENTS.filter((component) => component.expected_in?.includes(profile));
  const optional = RUNTIME_COMPONENTS.filter(
    (component) => !component.required_in.includes(profile) && !(component.expected_in?.includes(profile))
  );
  const fullGates = RUNTIME_COMPONENTS.filter((component) => component.kind === "gate");
  return {
    profile,
    required_components: required,
    expected_components: expected,
    optional_components: optional,
    full_gates: fullGates,
  };
}

export function componentRequiredInProfile(
  component: RuntimeProfileComponent,
  profile: MemoryRuntimeProfile
): boolean {
  return component.required_in.includes(profile);
}

export function componentExpectedInProfile(
  component: RuntimeProfileComponent,
  profile: MemoryRuntimeProfile
): boolean {
  return component.expected_in?.includes(profile) ?? false;
}

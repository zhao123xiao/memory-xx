import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  defaultAutoApprovalRuntimeControls,
  readAutoApprovalRuntimeControlsSync,
  writeAutoApprovalRuntimeControlsSync,
  type AutoApprovalRuntimeControls,
} from "../../app/governance/auto-approval-runtime-controls.js";
import {
  defaultRuntimeControlSettings,
  readRuntimeControlSettingsSync,
  runtimeControlSettingsPath,
  writeRuntimeControlSettingsSync,
  type RuntimeControlValue,
} from "../../app/runtime-control-settings.js";

export type SettingType = "boolean" | "number" | "string";
export type SettingSafety = "safe" | "guarded" | "high-risk";
export type SettingSource = "runtime_json" | "restart_pending" | "env" | "default";
export type SettingEffectStatus = "hot_reload" | "pending_restart" | "read_only_env" | "external_service_owned";
export type RuntimeCategory =
  | "config"
  | "service"
  | "worker"
  | "cache"
  | "queue"
  | "policy"
  | "health_gate"
  | "database"
  | "qdrant"
  | "recall"
  | "write"
  | "auto_approval"
  | "ui";

export interface ControlPanelRuntimeSettings {
  readonly version: 1;
  readonly updated_at?: string;
  readonly graph: {
    readonly default_scope_type: string;
    readonly default_scope_id: string;
    readonly default_limit: number;
  };
  readonly panel: {
    readonly refresh_interval_ms: number;
    readonly dense_mode: boolean;
    readonly default_page: string;
  };
}

export interface RuntimeRegistryItem {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly category: RuntimeCategory;
  readonly type: SettingType;
  readonly unit?: string;
  readonly value: RuntimeControlValue | null;
  readonly effective_value: RuntimeControlValue | null;
  readonly default_value: RuntimeControlValue;
  readonly source: SettingSource;
  readonly writable: boolean;
  readonly hot_reloadable: boolean;
  readonly requires_restart: boolean;
  readonly effect_status: SettingEffectStatus;
  readonly service?: string;
  readonly safety: SettingSafety;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly updated_at?: string;
  readonly env_key?: string;
}

export interface SettingDefinition {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly type: SettingType;
  readonly unit?: string;
  readonly source: SettingSource;
  readonly value: RuntimeControlValue | null;
  readonly default_value: RuntimeControlValue;
  readonly writable: boolean;
  readonly safety: SettingSafety;
  readonly requires_restart: boolean;
  readonly effect_status: SettingEffectStatus;
  readonly service?: string;
  readonly min?: number;
  readonly max?: number;
}

export interface SettingsSnapshot {
  readonly generated_at: string;
  readonly runtime_file: string;
  readonly runtime_control_file: string;
  readonly runtime: readonly SettingDefinition[];
  readonly env: readonly SettingDefinition[];
  readonly registry: readonly RuntimeRegistryItem[];
  readonly pending_restart: readonly RuntimeRegistryItem[];
}

export interface SettingsPreview {
  readonly generated_at: string;
  readonly changes: readonly {
    readonly key: string;
    readonly before: RuntimeControlValue | null;
    readonly after: RuntimeControlValue | null;
    readonly source: SettingSource;
    readonly hot_reloadable: boolean;
    readonly requires_restart: boolean;
    readonly effect_status: SettingEffectStatus;
    readonly service?: string;
    readonly safety: SettingSafety;
  }[];
  readonly high_risk_count: number;
  readonly restart_required_count: number;
  readonly services_to_restart: readonly string[];
}

const CONTROL_PANEL_SETTINGS_FILE = "control-panel-settings.json";

function runtimeDir(): string {
  return process.env.MEMORY_XX_RUNTIME_DIR?.trim() || join(process.cwd(), ".runtime");
}

export function controlPanelSettingsPath(): string {
  return join(runtimeDir(), CONTROL_PANEL_SETTINGS_FILE);
}

export function defaultControlPanelRuntimeSettings(): ControlPanelRuntimeSettings {
  return {
    version: 1,
    graph: {
      default_scope_type: process.env.MEMORY_XX_CONTROL_PANEL_GRAPH_SCOPE_TYPE?.trim() || "workspace",
      default_scope_id: process.env.MEMORY_XX_CONTROL_PANEL_GRAPH_SCOPE_ID?.trim() || "current-instance",
      default_limit: 80,
    },
    panel: {
      refresh_interval_ms: 30_000,
      dense_mode: true,
      default_page: "overview",
    },
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function boolValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return fallback;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function envNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const parsed = Number.parseInt(env[key] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function redactEnvValue(value: string | null): string | null {
  if (!value) return value;
  if (value.includes("@")) return value.replace(/:\/\/[^@]+@/u, "://****@");
  if (value.length > 12) return `${value.slice(0, 4)}****${value.slice(-4)}`;
  return "****";
}

export function normalizeControlPanelRuntimeSettings(value: unknown): ControlPanelRuntimeSettings {
  const defaults = defaultControlPanelRuntimeSettings();
  const root = objectValue(value);
  const graph = objectValue(root.graph);
  const panel = objectValue(root.panel);
  return {
    version: 1,
    ...(typeof root.updated_at === "string" ? { updated_at: root.updated_at } : {}),
    graph: {
      default_scope_type: stringValue(graph.default_scope_type, defaults.graph.default_scope_type),
      default_scope_id: stringValue(graph.default_scope_id, defaults.graph.default_scope_id),
      default_limit: numberValue(graph.default_limit, defaults.graph.default_limit, 10, 500),
    },
    panel: {
      refresh_interval_ms: numberValue(panel.refresh_interval_ms, defaults.panel.refresh_interval_ms, 5_000, 300_000),
      dense_mode: boolValue(panel.dense_mode, defaults.panel.dense_mode),
      default_page: stringValue(panel.default_page, defaults.panel.default_page),
    },
  };
}

export function readControlPanelRuntimeSettingsSync(): ControlPanelRuntimeSettings {
  try {
    return normalizeControlPanelRuntimeSettings(JSON.parse(readFileSync(controlPanelSettingsPath(), "utf8")) as unknown);
  } catch {
    return defaultControlPanelRuntimeSettings();
  }
}

export function writeControlPanelRuntimeSettingsSync(next: ControlPanelRuntimeSettings): void {
  const file = controlPanelSettingsPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...next, updated_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

function registryItem(input: Omit<RuntimeRegistryItem, "value" | "effective_value" | "source" | "updated_at" | "effect_status">, env: NodeJS.ProcessEnv): RuntimeRegistryItem {
  const runtime = readRuntimeControlSettingsSync();
  const pending = runtime.pending_restart[input.key];
  const runtimeValue = runtime.values[input.key];
  const envValue = input.env_key ? env[input.env_key] : undefined;
  const envParsed = input.type === "number" && envValue !== undefined
    ? numberValue(envValue, Number(input.default_value), input.min ?? 1, input.max ?? Number.MAX_SAFE_INTEGER)
    : input.type === "boolean" && envValue !== undefined
      ? boolValue(envValue, Boolean(input.default_value))
      : envValue;
  const effective = runtimeValue ?? envParsed ?? input.default_value;
  const value = pending ?? runtimeValue ?? envParsed ?? null;
  const source: SettingSource = pending !== undefined
    ? "restart_pending"
    : runtimeValue !== undefined
      ? "runtime_json"
      : envValue !== undefined
        ? "env"
        : "default";
  return {
    ...input,
    effect_status: input.hot_reloadable
      ? "hot_reload"
      : input.requires_restart
        ? "pending_restart"
        : "external_service_owned",
    value: input.env_key && input.env_key.toLowerCase().match(/token|password|url/u)
      ? redactEnvValue(String(value ?? "") || null)
      : value,
    effective_value: input.env_key && input.env_key.toLowerCase().match(/token|password|url/u)
      ? redactEnvValue(String(effective ?? "") || null)
      : effective,
    source,
    updated_at: runtime.updated_at,
  };
}

function envOnlyItem(
  key: string,
  label: string,
  description: string,
  defaultValue: string,
  service: string,
  env: NodeJS.ProcessEnv
): RuntimeRegistryItem {
  const value = env[key] ?? null;
  return {
    key,
    label,
    description,
    category: "config",
    type: "string",
    value: redactEnvValue(value),
    effective_value: redactEnvValue(value),
    default_value: defaultValue,
    source: value === null ? "default" : "env",
    writable: false,
    hot_reloadable: false,
    requires_restart: true,
    effect_status: "read_only_env",
    service,
    safety: "guarded",
    env_key: key,
  };
}

function autoApprovalControlLabel(group: "user" | "global" | "update_apply", key: string): string {
  const labels: Record<string, string> = {
    "user.enabled": "用户记忆自动审批总开关（user enabled）",
    "user.add_only": "用户记忆仅新增审批（user add-only）",
    "user.stable_preference": "用户稳定偏好自动审批（stable preference）",
    "user.constraint": "用户约束自动审批（user constraint）",
    "user.decision": "用户决策自动审批（user decision）",
    "user.candidate_only_bypass": "用户作用域候选模式绕过（candidate-only bypass）",
    "user.pii_allowlist": "用户 PII 白名单放行（PII allowlist）",
    "global.enabled": "全局记忆自动审批总开关（global enabled，仍需显式全局写入意图）",
    "global.add_only": "全局记忆仅新增审批（global add-only，仍需显式全局写入意图）",
    "global.fact": "全局事实自动审批（global fact）",
    "global.constraint": "全局约束自动审批（global constraint）",
    "global.procedure": "全局流程自动审批（global procedure）",
    "global.candidate_only_bypass": "全局作用域候选模式绕过（candidate-only bypass）",
    "update_apply.enabled": "自动更新应用总开关（update apply enabled）",
    "update_apply.test_scope_apply": "测试作用域允许真实更新（test-scope apply）",
    "update_apply.real_project_apply": "真实项目作用域允许更新（real project apply）",
    "update_apply.workspace_apply": "工作区作用域允许更新（workspace apply）",
    "update_apply.user_apply": "用户作用域允许更新（user apply）",
    "update_apply.global_apply": "全局作用域允许更新（global apply，仍需显式全局更新意图）",
    "update_apply.explicit_replacement": "明确替换可自动更新（explicit replacement）",
    "update_apply.same_fact_refresh": "同一事实刷新可自动更新（same fact refresh）",
    "update_apply.temporal_expiry": "时效过期可自动更新（temporal expiry）",
    "update_apply.merge_apply": "相似记忆合并应用（merge apply）",
    "update_apply.preference_change_apply": "偏好变化应用（preference change apply）",
    "update_apply.max_hourly_per_scope": "每作用域每小时更新上限（max hourly per scope）",
  };
  return labels[`${group}.${key}`] ?? `自动审批参数（${group}.${key}：自动审批运行时控制项）`;
}

function autoApprovalControlDescription(group: "user" | "global" | "update_apply", key: string): string {
  const descriptions: Record<string, string> = {
    "user.enabled": "控制 user（用户长期偏好和习惯）作用域是否允许进入自动审批路径。",
    "user.add_only": "只允许新增 add 自动审批；更新、冲突、合并仍由 update apply 策略单独控制。",
    "user.stable_preference": "允许明确、稳定、长期有效的用户偏好通过自动审批。",
    "user.constraint": "允许用户明确表达的长期约束进入自动审批。",
    "user.decision": "允许用户长期决策类记忆进入自动审批。",
    "user.candidate_only_bypass": "在 candidate-only（候选模式：全局安全开关）开启时，允许该用户作用域按策略绕过。",
    "user.pii_allowlist": "允许命中白名单的 PII（个人敏感信息）继续审批；高风险，默认应关闭。",
    "global.enabled": "控制 global（跨项目通用规则）作用域是否允许自动审批；即使开启，也必须出现“写进全局/写入全局记忆”等显式意图。",
    "global.add_only": "只允许全局新增 add 自动审批；仍要求显式全局写入意图，不会把普通事实误写到 global。",
    "global.fact": "允许全局事实类记忆自动审批。",
    "global.constraint": "允许全局约束类记忆自动审批。",
    "global.procedure": "允许全局流程/规则类记忆自动审批。",
    "global.candidate_only_bypass": "在 candidate-only 开启时，允许 global 作用域按策略绕过；高风险。",
    "update_apply.enabled": "控制真实长期 scope 是否允许执行自动更新 apply；测试 scope 不依赖该总开关。",
    "update_apply.test_scope_apply": "允许隔离测试 scope 执行真实 update apply，用于随机测试闭环。",
    "update_apply.real_project_apply": "允许真实 project 作用域执行 update apply；开启前必须有长期测试和回滚证据。",
    "update_apply.workspace_apply": "允许 workspace（本机环境和路径配置）作用域执行 update apply。",
    "update_apply.user_apply": "允许 user 作用域执行 update apply；偏好冲突风险较高。",
    "update_apply.global_apply": "允许 global 作用域执行 update apply；最高风险，即使开启也必须有显式全局更新/写入意图。",
    "update_apply.explicit_replacement": "用户明确说 A 改成 B 时，允许生成并应用替换计划。",
    "update_apply.same_fact_refresh": "同一事实更新为更完整版本时，允许刷新旧记忆。",
    "update_apply.temporal_expiry": "旧事实到期或失效时，允许 archive/tombstone 并写入新状态。",
    "update_apply.merge_apply": "允许相似记忆自动合并；容易误合并，默认应关闭。",
    "update_apply.preference_change_apply": "允许偏好变化自动应用；需要足够反馈样本后再开启。",
    "update_apply.max_hourly_per_scope": "限制单个 scope 每小时最多执行多少次 update apply。",
  };
  return descriptions[`${group}.${key}`] ?? "自动审批运行时参数，写入 auto-approval runtime JSON，立即参与策略读取。";
}

function autoApprovalRegistry(env: NodeJS.ProcessEnv): RuntimeRegistryItem[] {
  const controls = readAutoApprovalRuntimeControlsSync();
  const defaults = defaultAutoApprovalRuntimeControls();
  const definitions: RuntimeRegistryItem[] = [];
  for (const group of ["user", "global", "update_apply"] as const) {
    for (const [key, value] of Object.entries(controls[group])) {
      const defaultValue = (defaults[group] as Record<string, unknown>)[key] as RuntimeControlValue;
      definitions.push({
        key: `auto_approval.${group}.${key}`,
        label: autoApprovalControlLabel(group, key),
        description: autoApprovalControlDescription(group, key),
        category: "auto_approval",
        type: typeof value === "number" ? "number" : "boolean",
        unit: typeof value === "number" ? "updates/hour" : undefined,
        value: value as RuntimeControlValue,
        effective_value: value as RuntimeControlValue,
        default_value: defaultValue,
        source: "runtime_json",
        writable: true,
        hot_reloadable: true,
        requires_restart: false,
        effect_status: "hot_reload",
        safety: group === "update_apply" && key === "test_scope_apply" ? "safe" : key.includes("global") || key.includes("real") || key.includes("pii") ? "high-risk" : "guarded",
        min: typeof value === "number" ? 1 : undefined,
        max: typeof value === "number" ? 100 : undefined,
        step: typeof value === "number" ? 1 : undefined,
        updated_at: controls.updated_at,
      });
    }
  }
  void env;
  return definitions;
}

export function buildRuntimeRegistry(env: NodeJS.ProcessEnv = process.env): RuntimeRegistryItem[] {
  const panel = readControlPanelRuntimeSettingsSync();
  return [
    ...autoApprovalRegistry(env),
    registryItem({ key: "cache.redis.ttl.search_seconds", label: "搜索缓存过期时间（Redis search TTL）", description: "召回搜索结果在 Redis（缓存服务）中保留的秒数。", category: "cache", type: "number", unit: "seconds", default_value: 300, writable: true, hot_reloadable: true, requires_restart: false, safety: "guarded", min: 5, max: 86_400, step: 5, env_key: "MEMORY_XX_REDIS_TTL_SEARCH_SECONDS" }, env),
    registryItem({ key: "cache.redis.ttl.session_seconds", label: "会话缓存过期时间（Redis session TTL）", description: "会话召回缓存保留秒数。", category: "cache", type: "number", unit: "seconds", default_value: 1800, writable: true, hot_reloadable: true, requires_restart: false, safety: "guarded", min: 30, max: 86_400, step: 30, env_key: "MEMORY_XX_REDIS_TTL_SESSION_SECONDS" }, env),
    registryItem({ key: "cache.redis.ttl.recent_seconds", label: "最近记忆缓存过期时间（Redis recent TTL）", description: "最近记忆缓存保留秒数。", category: "cache", type: "number", unit: "seconds", default_value: 900, writable: true, hot_reloadable: true, requires_restart: false, safety: "guarded", min: 30, max: 86_400, step: 30, env_key: "MEMORY_XX_REDIS_TTL_RECENT_SECONDS" }, env),
    registryItem({ key: "cache.redis.ttl.startup_context_seconds", label: "启动上下文缓存过期时间（Redis startup-context TTL）", description: "项目启动上下文召回缓存保留秒数。", category: "cache", type: "number", unit: "seconds", default_value: 600, writable: true, hot_reloadable: true, requires_restart: false, safety: "guarded", min: 30, max: 86_400, step: 30, env_key: "MEMORY_XX_REDIS_TTL_STARTUP_CONTEXT_SECONDS" }, env),
    registryItem({ key: "cache.redis.empty_recall_ttl_seconds", label: "空召回缓存过期时间（Empty recall TTL）", description: "空结果召回缓存保留秒数，过长可能掩盖新写入。", category: "cache", type: "number", unit: "seconds", default_value: 15, writable: true, hot_reloadable: true, requires_restart: false, safety: "guarded", min: 1, max: 3600, step: 1, env_key: "MEMORY_XX_EMPTY_RECALL_CACHE_TTL_SECONDS" }, env),
    registryItem({ key: "cache.redis.connect_timeout_ms", label: "缓存服务连接超时（Redis connect timeout）", description: "Redis 客户端连接超时时间。", category: "cache", type: "number", unit: "ms", default_value: 2000, writable: true, hot_reloadable: true, requires_restart: false, safety: "guarded", min: 100, max: 30_000, step: 100, env_key: "MEMORY_XX_REDIS_CONNECT_TIMEOUT_MS" }, env),
    registryItem({ key: "cache.reranker.ttl_ms", label: "重排序缓存过期时间（Reranker cache TTL）", description: "模型重排序分数映射的本地缓存过期时间，新召回请求热生效。", category: "recall", type: "number", unit: "ms", default_value: 60_000, writable: true, hot_reloadable: true, requires_restart: false, safety: "guarded", min: 0, max: 3_600_000, step: 1000, env_key: "MEMORY_XX_RERANKER_CACHE_TTL_MS" }, env),
    registryItem({ key: "cache.query_embedding.ttl_ms", label: "查询向量缓存过期时间（Query embedding cache TTL）", description: "查询向量本地/共享缓存保留时间；wrapper（主服务）重启后新 provider（提供器）使用。", category: "cache", type: "number", unit: "ms", default_value: 1_800_000, writable: true, hot_reloadable: false, requires_restart: true, service: "memory-xx-wrapper.service", safety: "guarded", min: 1_000, max: 86_400_000, step: 1000 }, env),
    registryItem({ key: "write.rate_limit.max_requests", label: "写入/API 请求速率上限（rate limit max）", description: "单窗口允许请求数；运行时热更新后新请求立即使用。", category: "write", type: "number", unit: "requests", default_value: 60, writable: true, hot_reloadable: true, requires_restart: false, safety: "guarded", min: 1, max: 10_000, step: 1, env_key: "MEMORY_XX_RATE_LIMIT_MAX" }, env),
    registryItem({ key: "write.rate_limit.window_ms", label: "写入/API 请求速率窗口（rate limit window）", description: "请求速率限制的统计窗口长度。", category: "write", type: "number", unit: "ms", default_value: 60_000, writable: true, hot_reloadable: true, requires_restart: false, safety: "guarded", min: 1000, max: 3_600_000, step: 1000, env_key: "MEMORY_XX_RATE_LIMIT_WINDOW_MS" }, env),
    registryItem({ key: "write.ticket.ttl_seconds", label: "写入票据过期时间（Write ticket TTL）", description: "智能写入票据默认有效期，新 fast_ack（快速确认）请求热生效。", category: "write", type: "number", unit: "seconds", default_value: 120, writable: true, hot_reloadable: true, requires_restart: false, safety: "guarded", min: 10, max: 3600, step: 10, env_key: "MEMORY_XX_WRITE_TICKET_TTL_SECONDS" }, env),
    registryItem({ key: "write.semantic_lock.ttl_ms", label: "语义写入锁过期时间（Semantic lock TTL）", description: "同 scope（作用域）语义写入锁的最大持有时间，新 smart-write（智能写入）热生效。", category: "write", type: "number", unit: "ms", default_value: 30_000, writable: true, hot_reloadable: true, requires_restart: false, safety: "guarded", min: 1000, max: 300_000, step: 1000, env_key: "MEMORY_XX_SEMANTIC_LOCK_TTL_MS" }, env),
    registryItem({ key: "write.semantic_lock.wait_timeout_ms", label: "语义写入锁等待超时（Semantic lock wait timeout）", description: "发现相似写入正在进行时最多等待多久，新智能写入热生效。", category: "write", type: "number", unit: "ms", default_value: 5_000, writable: true, hot_reloadable: true, requires_restart: false, safety: "guarded", min: 100, max: 60_000, step: 100, env_key: "MEMORY_XX_SEMANTIC_LOCK_WAIT_TIMEOUT_MS" }, env),
    registryItem({ key: "write.smart_write.qdrant_preflight_timeout_ms", label: "智能写入向量预检超时（Smart-write Qdrant preflight timeout）", description: "智能写入前查询 Qdrant（向量库）相似记忆的超时时间，新请求热生效。", category: "write", type: "number", unit: "ms", default_value: 200, writable: true, hot_reloadable: true, requires_restart: false, safety: "guarded", min: 20, max: 10_000, step: 10, env_key: "MEMORY_XX_SMART_WRITE_QDRANT_PREFLIGHT_TIMEOUT_MS" }, env),
    registryItem({ key: "recall.default_limit", label: "默认召回数量（Default recall limit）", description: "控制面板和内部默认召回数量建议值。", category: "recall", type: "number", unit: "items", default_value: 10, writable: true, hot_reloadable: true, requires_restart: false, safety: "safe", min: 1, max: 100, step: 1 }, env),
    registryItem({ key: "recall.graph_health_ttl_ms", label: "图谱健康报告有效期（Graph health TTL）", description: "图谱健康 guard（保护检查）缓存有效期，新召回请求热生效。", category: "recall", type: "number", unit: "ms", default_value: 86_400_000, writable: true, hot_reloadable: true, requires_restart: false, safety: "guarded", min: 1000, max: 604_800_000, step: 1000, env_key: "MEMORY_XX_GRAPH_HEALTH_TTL_MS" }, env),
    registryItem({ key: "recall.reranker.timeout_ms", label: "重排序模型超时（Reranker timeout）", description: "模型重排序 HTTP 调用超时时间，新召回请求热生效。", category: "recall", type: "number", unit: "ms", default_value: 1500, writable: true, hot_reloadable: true, requires_restart: false, safety: "guarded", min: 100, max: 60_000, step: 100, env_key: "MEMORY_XX_RERANKER_TIMEOUT_MS" }, env),
    registryItem({ key: "recall.fastpath.primary_timeout_ms", label: "快速召回主路径超时（Fastpath primary timeout）", description: "Go fastpath（快速召回路径）主召回路径超时，新召回请求热生效。", category: "recall", type: "number", unit: "ms", default_value: 10_000, writable: true, hot_reloadable: true, requires_restart: false, safety: "guarded", min: 100, max: 60_000, step: 100, env_key: "MEMORY_XX_FASTPATH_PRIMARY_TIMEOUT_MS" }, env),
    registryItem({ key: "recall.fastpath.shadow_timeout_ms", label: "快速召回影子路径超时（Fastpath shadow timeout）", description: "shadow recall（影子召回观测路径）超时时间。", category: "recall", type: "number", unit: "ms", default_value: 10_000, writable: true, hot_reloadable: false, requires_restart: true, service: "memory-xx-wrapper.service", safety: "guarded", min: 100, max: 60_000, step: 100, env_key: "MEMORY_XX_FASTPATH_SHADOW_TIMEOUT_MS" }, env),
    registryItem({ key: "worker.qdrant_projector.interval_ms", label: "向量投影轮询间隔（Qdrant projector interval）", description: "Qdrant（向量库）投影 worker（后台任务）空闲轮询间隔。", category: "worker", type: "number", unit: "ms", default_value: 5000, writable: true, hot_reloadable: false, requires_restart: true, service: "memory-xx-qdrant-projector-worker.service", safety: "guarded", min: 500, max: 300_000, step: 500, env_key: "MEMORY_XX_QDRANT_PROJECTOR_INTERVAL_MS" }, env),
    registryItem({ key: "worker.qdrant_projector.batch_size", label: "向量投影批量大小（Qdrant projector batch size）", description: "每轮处理 outbox（投影事件队列）事件数量。", category: "worker", type: "number", unit: "items", default_value: 50, writable: true, hot_reloadable: false, requires_restart: true, service: "memory-xx-qdrant-projector-worker.service", safety: "guarded", min: 1, max: 1000, step: 1, env_key: "MEMORY_XX_QDRANT_PROJECTOR_BATCH_SIZE" }, env),
    registryItem({ key: "worker.qdrant_projector.max_attempts", label: "投影最大重试次数（Qdrant projector max attempts）", description: "投影失败进入 dead-letter（死信队列）前的最大尝试次数。", category: "worker", type: "number", unit: "attempts", default_value: 5, writable: true, hot_reloadable: false, requires_restart: true, service: "memory-xx-qdrant-projector-worker.service", safety: "guarded", min: 1, max: 100, step: 1, env_key: "MEMORY_XX_QDRANT_PROJECTOR_MAX_ATTEMPTS" }, env),
    registryItem({ key: "worker.qdrant_projector.retry_delay_ms", label: "投影重试延迟（Qdrant projector retry delay）", description: "Qdrant 投影失败后的基础重试延迟。", category: "worker", type: "number", unit: "ms", default_value: 5000, writable: true, hot_reloadable: false, requires_restart: true, service: "memory-xx-qdrant-projector-worker.service", safety: "guarded", min: 100, max: 300_000, step: 100, env_key: "MEMORY_XX_QDRANT_PROJECTOR_RETRY_DELAY_MS" }, env),
    registryItem({ key: "worker.cache_invalidation.batch_size", label: "缓存失效批量大小（Cache invalidation batch size）", description: "缓存失效 worker 每轮 claim（领取）的请求数量。", category: "worker", type: "number", unit: "items", default_value: 50, writable: true, hot_reloadable: false, requires_restart: true, service: "memory-xx-cache-invalidation-worker.service", safety: "guarded", min: 1, max: 1000, step: 1 }, env),
    registryItem({ key: "worker.cache_invalidation.max_attempts", label: "缓存失效最大重试次数（Cache invalidation max attempts）", description: "缓存失效请求被跳过前允许重试次数。", category: "worker", type: "number", unit: "attempts", default_value: 10, writable: true, hot_reloadable: false, requires_restart: true, service: "memory-xx-cache-invalidation-worker.service", safety: "guarded", min: 1, max: 100, step: 1 }, env),
    registryItem({ key: "worker.cache_invalidation.lease_ttl_seconds", label: "缓存失效租约时间（Cache invalidation lease TTL）", description: "缓存失效 worker 领取后的处理租约秒数。", category: "worker", type: "number", unit: "seconds", default_value: 120, writable: true, hot_reloadable: false, requires_restart: true, service: "memory-xx-cache-invalidation-worker.service", safety: "guarded", min: 10, max: 3600, step: 10 }, env),
    registryItem({ key: "worker.cache_invalidation.retry_base_seconds", label: "缓存失效基础重试延迟（Cache invalidation retry base）", description: "缓存失效失败后的基础重试延迟。", category: "worker", type: "number", unit: "seconds", default_value: 30, writable: true, hot_reloadable: false, requires_restart: true, service: "memory-xx-cache-invalidation-worker.service", safety: "guarded", min: 1, max: 3600, step: 1 }, env),
    registryItem({ key: "worker.cache_invalidation.retry_max_seconds", label: "缓存失效最大重试延迟（Cache invalidation retry max）", description: "缓存失效失败后的最大重试延迟。", category: "worker", type: "number", unit: "seconds", default_value: 600, writable: true, hot_reloadable: false, requires_restart: true, service: "memory-xx-cache-invalidation-worker.service", safety: "guarded", min: 1, max: 86_400, step: 1 }, env),
    registryItem({ key: "worker.conversation.poll_interval_ms", label: "对话监听轮询间隔（Conversation monitor interval）", description: "对话监听器检查 JSONL/HTTP spool（写入缓冲）的间隔。", category: "worker", type: "number", unit: "ms", default_value: 1000, writable: true, hot_reloadable: false, requires_restart: true, service: "openclaw-conversation-monitor-worker.service", safety: "guarded", min: 100, max: 60_000, step: 100, env_key: "MEMORY_XX_CONVERSATION_POLL_INTERVAL_MS" }, env),
    registryItem({ key: "worker.write_ticket.interval_ms", label: "写入票据 worker 间隔（Write ticket worker interval）", description: "写入票据 worker 主循环 sleep（休眠）间隔。", category: "worker", type: "number", unit: "ms", default_value: 1000, writable: true, hot_reloadable: false, requires_restart: true, service: "memory-xx-write-ticket-worker.service", safety: "guarded", min: 100, max: 60_000, step: 100, env_key: "MEMORY_XX_WRITE_TICKET_WORKER_INTERVAL_MS" }, env),
    registryItem({ key: "worker.write_ticket.batch_size", label: "写入票据批量大小（Write ticket worker batch size）", description: "写入票据 worker 每轮处理票据数量。", category: "worker", type: "number", unit: "items", default_value: 10, writable: true, hot_reloadable: false, requires_restart: true, service: "memory-xx-write-ticket-worker.service", safety: "guarded", min: 1, max: 1000, step: 1, env_key: "MEMORY_XX_WRITE_TICKET_WORKER_BATCH_SIZE" }, env),
    registryItem({ key: "worker.write_ticket.lease_ttl_seconds", label: "写入票据租约时间（Write ticket lease TTL）", description: "写入票据 worker 领取后的处理租约秒数。", category: "worker", type: "number", unit: "seconds", default_value: 120, writable: true, hot_reloadable: false, requires_restart: true, service: "memory-xx-write-ticket-worker.service", safety: "guarded", min: 10, max: 3600, step: 10, env_key: "MEMORY_XX_WRITE_TICKET_LEASE_TTL_SECONDS" }, env),
    registryItem({ key: "health.projector_stale_after_ms", label: "投影 worker 过期阈值（Projector stale threshold）", description: "超过该时间未 heartbeat（心跳）时，health gate（健康门禁）标记投影 worker 过期，新审批请求热生效。", category: "health_gate", type: "number", unit: "ms", default_value: 180_000, writable: true, hot_reloadable: true, requires_restart: false, safety: "guarded", min: 10_000, max: 3_600_000, step: 1000, env_key: "MEMORY_XX_AUTO_APPROVAL_PROJECTOR_STALE_AFTER_MS" }, env),
    registryItem({ key: "health.outbox_blocker_threshold", label: "投影队列阻断阈值（Outbox blocker threshold）", description: "outbox（投影事件队列）积压超过该值时阻断自动审批，新审批请求热生效。", category: "health_gate", type: "number", unit: "events", default_value: 100, writable: true, hot_reloadable: true, requires_restart: false, safety: "guarded", min: 1, max: 100_000, step: 1, env_key: "MEMORY_XX_AUTO_APPROVAL_OUTBOX_BLOCKER_THRESHOLD" }, env),
    registryItem({ key: "health.cache_invalidation_blocker_threshold", label: "缓存失效阻断阈值（Cache invalidation blocker threshold）", description: "缓存失效 backlog（积压）超过该值时阻断自动审批，新审批请求热生效。", category: "health_gate", type: "number", unit: "requests", default_value: 100, writable: true, hot_reloadable: true, requires_restart: false, safety: "guarded", min: 1, max: 100_000, step: 1, env_key: "MEMORY_XX_AUTO_APPROVAL_CACHE_INVALIDATION_BLOCKER_THRESHOLD" }, env),
    registryItem({ key: "health.qdrant_pg_diff_blocker_threshold", label: "向量库/数据库数量差异阻断阈值（Qdrant/PG diff threshold）", description: "Qdrant（向量库）和 PostgreSQL（关系数据库）的投影数量差超过该阈值时阻断自动审批，新审批请求热生效。", category: "health_gate", type: "number", unit: "records", default_value: 0, writable: true, hot_reloadable: true, requires_restart: false, safety: "guarded", min: 0, max: 10_000, step: 1, env_key: "MEMORY_XX_AUTO_APPROVAL_QDRANT_PG_DIFF_BLOCKER_THRESHOLD" }, env),
    registryItem({ key: "database.connection.idle_timeout_ms", label: "数据库空闲连接超时（PostgreSQL idle timeout）", description: "PostgreSQL 连接池空闲连接超时时间。", category: "database", type: "number", unit: "ms", default_value: 30_000, writable: true, hot_reloadable: false, requires_restart: true, service: "memory-xx-wrapper.service", safety: "guarded", min: 1000, max: 600_000, step: 1000, env_key: "MEMORY_XX_DATABASE_IDLE_TIMEOUT_MS" }, env),
    registryItem({ key: "database.dead_tuple_warning_ratio", label: "死元组告警比例（Dead tuple warning ratio）", description: "控制面板/doctor（诊断工具）展示 dead tuple（死元组）告警的比例建议值。", category: "database", type: "number", unit: "percent", default_value: 20, writable: true, hot_reloadable: true, requires_restart: false, safety: "safe", min: 1, max: 100, step: 1 }, env),
    registryItem({ key: "control_panel.panel.refresh_interval_ms", label: "控制面板刷新间隔（Control panel refresh interval）", description: "总览页自动刷新间隔。", category: "ui", type: "number", unit: "ms", default_value: panel.panel.refresh_interval_ms, writable: true, hot_reloadable: true, requires_restart: false, safety: "safe", min: 5_000, max: 300_000, step: 1000 }, env),
    registryItem({ key: "control_panel.panel.dense_mode", label: "紧凑模式（Dense mode）", description: "控制面板使用更高信息密度布局。", category: "ui", type: "boolean", default_value: panel.panel.dense_mode, writable: true, hot_reloadable: true, requires_restart: false, safety: "safe" }, env),
    registryItem({ key: "control_panel.graph.default_scope_type", label: "图谱默认作用域类型（Graph default scope_type）", description: "图谱页面初始 scope_type（作用域类型）。", category: "ui", type: "string", default_value: panel.graph.default_scope_type, writable: true, hot_reloadable: true, requires_restart: false, safety: "safe" }, env),
    registryItem({ key: "control_panel.graph.default_scope_id", label: "图谱默认作用域 ID（Graph default scope_id）", description: "图谱页面初始 scope_id（作用域 ID）。", category: "ui", type: "string", default_value: panel.graph.default_scope_id, writable: true, hot_reloadable: true, requires_restart: false, safety: "safe" }, env),
    registryItem({ key: "control_panel.graph.default_limit", label: "图谱默认节点数量（Graph default limit）", description: "图谱页面默认加载节点数量。", category: "ui", type: "number", unit: "items", default_value: panel.graph.default_limit, writable: true, hot_reloadable: true, requires_restart: false, safety: "safe", min: 10, max: 500, step: 10 }, env),
    envOnlyItem("MEMORY_XX_DATABASE_URL", "数据库连接地址（PostgreSQL URL）", "数据库连接地址，只读脱敏展示。", "postgres://postgres:postgres@127.0.0.1:5432/memory_xx", "memory-xx-wrapper.service", env),
    envOnlyItem("MEMORY_XX_DATABASE_SCHEMA", "数据库 schema（PostgreSQL schema）", "数据库 schema（命名空间）名称。", "memory_xx", "memory-xx-wrapper.service", env),
    envOnlyItem("MEMORY_XX_QDRANT_COLLECTION", "向量集合（Qdrant collection）", "Qdrant（向量库）集合名称。", "memory-xx", "memory-xx-qdrant-projector-worker.service", env),
    envOnlyItem("MEMORY_XX_QUERY_EMBEDDING_CACHE_VERSION", "查询向量缓存版本（Query embedding cache version）", "查询向量缓存版本，切换 embedding generation（嵌入代际）后应更新。", "", "memory-xx-wrapper.service", env),
    envOnlyItem("MEMORY_XX_ADMIN_TOKEN", "管理令牌（Admin token）", "管理 API token（接口令牌），只读脱敏展示。", "", "memory-xx-wrapper.service", env),
  ];
}

function toSettingDefinition(item: RuntimeRegistryItem): SettingDefinition {
  return {
    key: item.key,
    label: item.label,
    description: item.description,
    type: item.type,
    unit: item.unit,
    source: item.source,
    value: item.value,
    default_value: item.default_value,
    writable: item.writable,
    safety: item.safety,
    requires_restart: item.requires_restart,
    effect_status: item.effect_status,
    service: item.service,
    min: item.min,
    max: item.max,
  };
}

export function listControlPanelSettings(env: NodeJS.ProcessEnv = process.env): SettingsSnapshot {
  const registry = buildRuntimeRegistry(env);
  return {
    generated_at: new Date().toISOString(),
    runtime_file: controlPanelSettingsPath(),
    runtime_control_file: runtimeControlSettingsPath(),
    runtime: registry.filter((item) => item.writable).map(toSettingDefinition),
    env: registry.filter((item) => item.env_key && !item.writable).map(toSettingDefinition),
    registry,
    pending_restart: registry.filter((item) => item.source === "restart_pending"),
  };
}

function coerceRegistryValue(item: RuntimeRegistryItem, value: unknown): RuntimeControlValue {
  if (item.type === "boolean") return value === true || value === "true" || value === "1";
  if (item.type === "number") return numberValue(value, Number(item.default_value), item.min ?? Number.MIN_SAFE_INTEGER, item.max ?? Number.MAX_SAFE_INTEGER);
  return stringValue(value, String(item.default_value));
}

function writeControlPanelSetting(key: string, value: unknown): void {
  const current = readControlPanelRuntimeSettingsSync();
  const next = {
    ...current,
    graph: { ...current.graph },
    panel: { ...current.panel },
  };
  if (key === "control_panel.graph.default_scope_type") next.graph.default_scope_type = stringValue(value, current.graph.default_scope_type);
  else if (key === "control_panel.graph.default_scope_id") next.graph.default_scope_id = stringValue(value, current.graph.default_scope_id);
  else if (key === "control_panel.graph.default_limit") next.graph.default_limit = numberValue(value, current.graph.default_limit, 10, 500);
  else if (key === "control_panel.panel.refresh_interval_ms") next.panel.refresh_interval_ms = numberValue(value, current.panel.refresh_interval_ms, 5_000, 300_000);
  else if (key === "control_panel.panel.dense_mode") next.panel.dense_mode = boolValue(value, current.panel.dense_mode);
  else if (key === "control_panel.panel.default_page") next.panel.default_page = stringValue(value, current.panel.default_page);
  else throw new Error(`setting_not_writable:${key}`);
  writeControlPanelRuntimeSettingsSync(next);
}

function writeAutoApprovalSetting(key: string, value: unknown): void {
  const [, group, settingKey] = key.split(".");
  const current = readAutoApprovalRuntimeControlsSync();
  if (!group || !settingKey || !(group in current)) throw new Error(`unknown_runtime_setting:${key}`);
  const groupValue = current[group as keyof AutoApprovalRuntimeControls] as Record<string, unknown>;
  if (!(settingKey in groupValue)) throw new Error(`unknown_runtime_setting:${key}`);
  const next = {
    ...current,
    user: { ...current.user },
    global: { ...current.global },
    update_apply: { ...current.update_apply },
  };
  const target = next[group as keyof AutoApprovalRuntimeControls] as Record<string, unknown>;
  const existing = target[settingKey];
  target[settingKey] = typeof existing === "number"
    ? numberValue(value, existing, 1, 100)
    : value === true || value === "true" || value === "1";
  writeAutoApprovalRuntimeControlsSync(next);
}

export function previewRuntimeSettings(input: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): SettingsPreview {
  const registry = buildRuntimeRegistry(env);
  const changes = Object.entries(input).map(([key, raw]) => {
    const item = registry.find((candidate) => candidate.key === key);
    if (!item) throw new Error(`unknown_runtime_setting:${key}`);
    if (!item.writable) throw new Error(`setting_not_writable:${key}`);
    const after = coerceRegistryValue(item, raw);
    return {
      key,
      before: item.effective_value,
      after,
      source: item.requires_restart ? "restart_pending" as const : "runtime_json" as const,
      hot_reloadable: item.hot_reloadable,
      requires_restart: item.requires_restart,
      effect_status: item.effect_status,
      service: item.service,
      safety: item.safety,
    };
  });
  const services = [...new Set(changes.map((change) => change.service).filter((service): service is string => Boolean(service)))];
  return {
    generated_at: new Date().toISOString(),
    changes,
    high_risk_count: changes.filter((change) => change.safety === "high-risk").length,
    restart_required_count: changes.filter((change) => change.requires_restart).length,
    services_to_restart: services,
  };
}

export function updateRuntimeSettingsBatch(input: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): SettingsSnapshot {
  const registry = buildRuntimeRegistry(env);
  const runtimeControls = readRuntimeControlSettingsSync();
  const nextRuntime = {
    ...defaultRuntimeControlSettings(),
    ...runtimeControls,
    values: { ...runtimeControls.values },
    pending_restart: { ...runtimeControls.pending_restart },
  };
  for (const [key, raw] of Object.entries(input)) {
    const item = registry.find((candidate) => candidate.key === key);
    if (!item) throw new Error(`unknown_runtime_setting:${key}`);
    if (!item.writable) throw new Error(`setting_not_writable:${key}`);
    const value = coerceRegistryValue(item, raw);
    if (key.startsWith("auto_approval.")) {
      writeAutoApprovalSetting(key, value);
    } else if (key.startsWith("control_panel.")) {
      writeControlPanelSetting(key, value);
    } else if (item.requires_restart) {
      nextRuntime.pending_restart[key] = value;
      delete nextRuntime.values[key];
    } else {
      nextRuntime.values[key] = value;
      delete nextRuntime.pending_restart[key];
    }
  }
  writeRuntimeControlSettingsSync(nextRuntime);
  return listControlPanelSettings(env);
}

export function updateRuntimeSetting(key: string, value: unknown): SettingsSnapshot {
  return updateRuntimeSettingsBatch({ [key]: value });
}

export function resetRuntimeSettings(keys: readonly string[], env: NodeJS.ProcessEnv = process.env): SettingsSnapshot {
  const runtimeControls = readRuntimeControlSettingsSync();
  const nextRuntime = {
    ...runtimeControls,
    values: { ...runtimeControls.values },
    pending_restart: { ...runtimeControls.pending_restart },
  };
  for (const key of keys) {
    delete nextRuntime.values[key];
    delete nextRuntime.pending_restart[key];
  }
  writeRuntimeControlSettingsSync(nextRuntime);
  return listControlPanelSettings(env);
}

export function restartPlan(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const pending = listControlPanelSettings(env).pending_restart;
  const services = [...new Set(pending.map((item) => item.service).filter((service): service is string => Boolean(service)))];
  return {
    generated_at: new Date().toISOString(),
    pending_count: pending.length,
    services,
    commands: services.map((service) => `systemctl --user restart ${service}`),
    pending,
    note: "Control panel does not restart services automatically. Review and run commands manually.",
  };
}

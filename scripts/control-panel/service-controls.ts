import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  defaultAutoApprovalRuntimeControls,
  readAutoApprovalRuntimeControlsSync,
  writeAutoApprovalRuntimeControlsSync,
  type AutoApprovalRuntimeControls,
} from "../../app/governance/auto-approval-runtime-controls.js";
import { objectValue, parseKeyValueLines } from "./utils.js";

export interface ServiceControlDefinition {
  readonly unit: string;
  readonly label: string;
  readonly description: string;
}

export interface ServiceControlStatus extends ServiceControlDefinition {
  readonly active: boolean;
  readonly active_state: string;
  readonly sub_state: string;
  readonly load_state: string;
  readonly error?: string;
  readonly runtime_control?: boolean;
}

export interface AutoApprovalControlStatus {
  readonly group: "user" | "global" | "update_apply";
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly active: boolean;
  readonly safety: "safe" | "guarded" | "high-risk";
}

const execFileAsync = promisify(execFile);
const RUNTIME_DIR = process.env.MEMORY_XX_RUNTIME_DIR?.trim() || path.join(process.cwd(), ".runtime");
const CONVERSATION_CONTROL_PATH = path.join(RUNTIME_DIR, "conversation-monitor.json");
const CONVERSATION_HEARTBEAT_PATH = path.join(RUNTIME_DIR, "conversation-monitor-heartbeat.json");

const SERVICE_CONTROLS: readonly ServiceControlDefinition[] = [
  { unit: "memory-xx-wrapper.service", label: "记忆主服务", description: "HTTP/MCP 记忆主入口" },
  { unit: "memory-xx-mem0-extractor.service", label: "记忆抽取器（Mem0）", description: "mem0（记忆抽取框架）抽取侧车" },
  { unit: "memory-xx-embedding-upstream.service", label: "Embedding 上游模型", description: "Windows GPU 上的 Qwen3 embedding（向量生成）模型常驻管理器" },
  { unit: "memory-xx-embedding-proxy.service", label: "向量生成代理", description: "本地 OVMS（OpenVINO 模型服务）embedding（向量生成）代理" },
  { unit: "memory-xx-qdrant-projector-worker.service", label: "向量投影器", description: "异步写入 Qdrant（向量库）的投影 worker" },
  { unit: "memory-xx-qdrant-proxy.service", label: "向量库代理", description: "Qdrant collection（向量集合）代理" },
  { unit: "memory-xx-fastpath.service", label: "快速召回路径", description: "Go 快速召回侧车" },
  { unit: "memory-xx-lexical-sidecar.service", label: "关键词召回侧车", description: "Rust 关键词召回侧车" },
  { unit: "memory-xx-reranker-upstream.service", label: "Reranker 上游模型", description: "Windows GPU 上的 Qwen3 reranker（重排序）模型常驻管理器" },
  { unit: "memory-xx-reranker-adapter.service", label: "重排序适配器", description: "排序模型 adapter（适配器）" },
];

const AUTO_APPROVAL_CONTROL_DEFINITIONS: readonly AutoApprovalControlStatus[] = [
  { group: "user", key: "enabled", label: "用户作用域总开关", description: "允许 user scope（用户作用域）进入自动审批正式策略", active: false, safety: "high-risk" },
  { group: "user", key: "add_only", label: "用户作用域仅新增", description: "只允许新增长期偏好/约束/决策", active: false, safety: "high-risk" },
  { group: "user", key: "stable_preference", label: "用户偏好", description: "允许稳定用户偏好自动批准", active: false, safety: "guarded" },
  { group: "user", key: "constraint", label: "用户约束", description: "允许用户长期约束自动批准", active: false, safety: "guarded" },
  { group: "user", key: "decision", label: "用户决策", description: "允许用户明确长期决策自动批准", active: false, safety: "guarded" },
  { group: "user", key: "candidate_only_bypass", label: "用户作用域绕过候选模式", description: "candidate-only（候选模式）开启时允许 user scope（用户作用域）执行 scoped bypass（作用域绕过）", active: false, safety: "high-risk" },
  { group: "user", key: "pii_allowlist", label: "用户 PII 白名单", description: "保留开关位；PII 默认仍走人工审核", active: false, safety: "high-risk" },
  { group: "global", key: "enabled", label: "全局作用域总开关", description: "允许 global scope（全局作用域）进入自动审批正式策略；仍必须明确说写进全局记忆", active: false, safety: "high-risk" },
  { group: "global", key: "add_only", label: "全局作用域仅新增", description: "只允许新增跨项目通用规则；普通内容不会自动写入 global（全局）", active: false, safety: "high-risk" },
  { group: "global", key: "fact", label: "全局事实", description: "允许跨项目通用事实自动批准", active: false, safety: "high-risk" },
  { group: "global", key: "constraint", label: "全局约束", description: "允许跨项目通用约束自动批准", active: false, safety: "high-risk" },
  { group: "global", key: "procedure", label: "全局流程", description: "允许跨项目通用流程自动批准", active: false, safety: "high-risk" },
  { group: "global", key: "candidate_only_bypass", label: "全局作用域绕过候选模式", description: "candidate-only（候选模式）开启时允许 global scope（全局作用域）执行 scoped bypass（作用域绕过）", active: false, safety: "high-risk" },
  { group: "update_apply", key: "enabled", label: "自动更新应用总开关", description: "允许非测试 scope（作用域）进入 update apply（自动更新应用）门控", active: false, safety: "high-risk" },
  { group: "update_apply", key: "test_scope_apply", label: "测试作用域更新应用", description: "允许隔离 project:auto-update-test-* 测试作用域执行 apply（应用更新）", active: true, safety: "safe" },
  { group: "update_apply", key: "real_project_apply", label: "项目作用域自动更新", description: "允许真实 project scope（项目作用域）执行 update apply（自动更新应用）", active: false, safety: "high-risk" },
  { group: "update_apply", key: "workspace_apply", label: "工作区作用域自动更新", description: "允许真实 workspace scope（工作区作用域）执行 update apply（自动更新应用）", active: false, safety: "high-risk" },
  { group: "update_apply", key: "user_apply", label: "用户作用域自动更新", description: "允许真实 user scope（用户作用域）执行 update apply（自动更新应用）", active: false, safety: "high-risk" },
  { group: "update_apply", key: "global_apply", label: "全局作用域自动更新", description: "允许真实 global scope（全局作用域）执行 update apply（自动更新应用）；仍必须明确说写进/更新全局记忆", active: false, safety: "high-risk" },
  { group: "update_apply", key: "explicit_replacement", label: "明确替换", description: "允许 A 改成 B 这类明确替换执行 apply（应用更新）", active: true, safety: "guarded" },
  { group: "update_apply", key: "same_fact_refresh", label: "事实刷新", description: "允许同一事实确认仍有效时执行 apply（应用更新）", active: true, safety: "guarded" },
  { group: "update_apply", key: "temporal_expiry", label: "过期归档", description: "允许过期事实归档/替换时执行 apply（应用更新）", active: true, safety: "guarded" },
  { group: "update_apply", key: "merge_apply", label: "合并应用", description: "预留高风险合并开关；策略仍会拒绝未实现合并", active: false, safety: "high-risk" },
  { group: "update_apply", key: "preference_change_apply", label: "偏好变更应用", description: "允许明确用户偏好变更执行 apply（应用更新）", active: false, safety: "high-risk" },
];

function serviceControlDefinition(unit: string): ServiceControlDefinition | null {
  return SERVICE_CONTROLS.find((service) => service.unit === unit) ?? null;
}

async function systemctl(args: readonly string[]): Promise<string> {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR?.trim() || (uid === null ? "" : `/run/user/${uid}`);
  const busAddress = process.env.DBUS_SESSION_BUS_ADDRESS?.trim() || (xdgRuntimeDir ? `unix:path=${xdgRuntimeDir}/bus` : "");
  const { stdout } = await execFileAsync("systemctl", ["--user", ...args], {
    env: {
      ...process.env,
      ...(xdgRuntimeDir ? { XDG_RUNTIME_DIR: xdgRuntimeDir } : {}),
      ...(busAddress ? { DBUS_SESSION_BUS_ADDRESS: busAddress } : {}),
    },
    timeout: 12_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.toString();
}

async function serviceStatus(definition: ServiceControlDefinition): Promise<ServiceControlStatus> {
  try {
    const raw = await systemctl(["show", definition.unit, "--property=LoadState,ActiveState,SubState", "--no-pager"]);
    const parsed = parseKeyValueLines(raw);
    const activeState = parsed.ActiveState || "unknown";
    return {
      ...definition,
      active: activeState === "active",
      active_state: activeState,
      sub_state: parsed.SubState || "unknown",
      load_state: parsed.LoadState || "unknown",
    };
  } catch (error) {
    return {
      ...definition,
      active: false,
      active_state: "unknown",
      sub_state: "unknown",
      load_state: "unknown",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim();
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return fallback;
}

async function readConversationControlFile(): Promise<Record<string, unknown>> {
  try {
    return objectValue(JSON.parse(await readFile(CONVERSATION_CONTROL_PATH, "utf8")));
  } catch {
    return {};
  }
}

export async function readConversationControls(): Promise<{ conversation_monitor: boolean; conversation_auto_extract: boolean }> {
  const file = await readConversationControlFile();
  return {
    conversation_monitor: typeof file.conversation_monitor === "boolean"
      ? file.conversation_monitor
      : envBool("MEMORY_XX_CONVERSATION_MONITOR", false),
    conversation_auto_extract: typeof file.conversation_auto_extract === "boolean"
      ? file.conversation_auto_extract
      : envBool("MEMORY_XX_CONVERSATION_AUTO_EXTRACT", false),
  };
}

export async function readConversationHeartbeat(): Promise<Record<string, unknown> | null> {
  try {
    return objectValue(JSON.parse(await readFile(CONVERSATION_HEARTBEAT_PATH, "utf8")));
  } catch {
    return null;
  }
}

async function writeConversationControls(next: { conversation_monitor: boolean; conversation_auto_extract: boolean }): Promise<void> {
  await mkdir(path.dirname(CONVERSATION_CONTROL_PATH), { recursive: true });
  await writeFile(CONVERSATION_CONTROL_PATH, JSON.stringify({ ...next, updated_at: new Date().toISOString() }, null, 2));
}

async function conversationRuntimeControls(): Promise<ServiceControlStatus[]> {
  const controls = await readConversationControls();
  return [
    {
      unit: "conversation_monitor",
      label: "对话监听",
      description: "监听本地 JSONL/HTTP 对话 turn",
      active: controls.conversation_monitor,
      active_state: controls.conversation_monitor ? "active" : "inactive",
      sub_state: "runtime-flag",
      load_state: "loaded",
      runtime_control: true,
    },
    {
      unit: "conversation_auto_extract",
      label: "自动抽取",
      description: "自动 flush 并调用 mem0 official 抽取",
      active: controls.conversation_auto_extract,
      active_state: controls.conversation_auto_extract ? "active" : "inactive",
      sub_state: "runtime-flag",
      load_state: "loaded",
      runtime_control: true,
    },
  ];
}

export async function serviceControls(): Promise<readonly ServiceControlStatus[]> {
  const services = await Promise.all(SERVICE_CONTROLS.map((definition) => serviceStatus(definition)));
  return [...services, ...await conversationRuntimeControls()];
}

export async function setServiceEnabled(unit: string, enabled: boolean): Promise<ServiceControlStatus> {
  const definition = serviceControlDefinition(unit);
  if (!definition) {
    throw new Error(`service_not_allowed:${unit}`);
  }
  await systemctl([enabled ? "start" : "stop", definition.unit]);
  return serviceStatus(definition);
}

export async function setConversationControl(unit: string, enabled: boolean): Promise<ServiceControlStatus> {
  const controls = await readConversationControls();
  if (unit === "conversation_monitor") controls.conversation_monitor = enabled;
  else if (unit === "conversation_auto_extract") controls.conversation_auto_extract = enabled;
  else throw new Error(`runtime_control_not_allowed:${unit}`);
  await writeConversationControls(controls);
  const next = await conversationRuntimeControls();
  const found = next.find((item) => item.unit === unit);
  if (!found) throw new Error(`runtime_control_not_found:${unit}`);
  return found;
}

export function autoApprovalControlDefinitions(): readonly AutoApprovalControlStatus[] {
  const controls = readAutoApprovalRuntimeControlsSync();
  return AUTO_APPROVAL_CONTROL_DEFINITIONS.map((definition) => ({
    ...definition,
    active: Boolean((controls[definition.group] as Record<string, unknown>)[definition.key]),
  }));
}

export function setAutoApprovalRuntimeControl(group: string, key: string, enabled: boolean): AutoApprovalRuntimeControls {
  const definition = AUTO_APPROVAL_CONTROL_DEFINITIONS.find((item) => item.group === group && item.key === key);
  if (!definition) throw new Error(`auto_approval_control_not_allowed:${group}.${key}`);
  const current = readAutoApprovalRuntimeControlsSync();
  const next = {
    ...defaultAutoApprovalRuntimeControls(),
    ...current,
    user: { ...current.user },
    global: { ...current.global },
    update_apply: { ...current.update_apply },
  };
  (next[group as keyof AutoApprovalRuntimeControls] as Record<string, unknown>)[key] = enabled;
  writeAutoApprovalRuntimeControlsSync(next);
  return readAutoApprovalRuntimeControlsSync();
}

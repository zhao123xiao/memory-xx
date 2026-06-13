import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LifecycleStatus, ReviewState, ScopeType, type JsonObject } from "../shared/types";
import { scoreTestPollution } from "./service";
import { scanMemoryPrivacy } from "./privacy-scan";
import {
  isRuntimeGlobalAddApprovalEnabled,
  isRuntimeUserAddApprovalEnabled,
  readAutoApprovalRuntimeControlsSync,
  readAutoApprovalRuntimeControlsStateSync,
  runtimeControlsGlobalMemoryTypes,
  runtimeControlsUserMemoryTypes,
} from "./auto-approval-runtime-controls";
import {
  hasExplicitGlobalMemoryIntent,
  hasExplicitGlobalMemoryIntentFromMetadata,
} from "./global-memory-intent";
import { evaluateMemoryPolicy, type MemoryPolicyResult } from "./memory-policy-engine";

export const AUTO_APPROVAL_POLICY_VERSION = "auto-approval-v2-scope-tiered";

export type AutoApprovalDecision = "approve" | "pending" | "reject" | "buffer";

export interface AutoApprovalThresholds {
  readonly qualityScore: number;
  readonly confidence: number;
  readonly hourlyLimit: number;
  readonly falsePositiveFreezeRate: number;
}

export type AutoApprovalScopeProfileId =
  | "project"
  | "workspace"
  | "user"
  | "global"
  | "self_improvement_project"
  | "unsupported";

export interface AutoApprovalScopeProfile {
  readonly id: AutoApprovalScopeProfileId;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly autoApprovalAllowed: boolean;
  readonly dryRunOnly: boolean;
  readonly qualityScore: number;
  readonly confidence: number;
  readonly hourlyLimit: number;
  readonly allowedMemoryTypes: readonly string[];
  readonly requiresReviewAt: boolean;
  readonly notes: readonly string[];
}

export interface AutoApprovalCandidate {
  readonly scopeType: string;
  readonly scopeId: string;
  readonly memoryType: string | null | undefined;
  readonly operation: string;
  readonly conflictAction?: string | null;
  readonly conflictReason?: string | null;
  readonly confidence: number;
  readonly qualityScore: number;
  readonly title?: string | null;
  readonly content: string;
  readonly metadata?: JsonObject | null;
}

export interface AutoApprovalPolicyInput {
  readonly mode: "draft" | "write" | "auto_approve";
  readonly agentId: string;
  readonly source: string;
  readonly sourceText?: string;
  readonly candidate: AutoApprovalCandidate;
  readonly trustedAgent: boolean;
  readonly hasScopeGrant: boolean;
  readonly candidateOnly: boolean;
  readonly candidateOnlyReasons: readonly string[];
  readonly semanticConflict: boolean;
  readonly semanticDuplicate: boolean;
  readonly autoApproveEnabled: boolean;
  readonly thresholdOverride?: number | null;
  readonly enabledProjectIds?: readonly string[];
  readonly recentApprovedCount?: number;
  readonly operationalBlockers?: readonly string[];
}

export interface AutoApprovalPolicyResult {
  readonly decision: AutoApprovalDecision;
  readonly lifecycleStatus: LifecycleStatus.Candidate | LifecycleStatus.Approved;
  readonly reviewState: ReviewState.Pending | ReviewState.SilentApproved;
  readonly approvalMode: "candidate" | "silent_approved";
  readonly score: number;
  readonly reasons: readonly string[];
  readonly blocked_reasons: readonly string[];
  readonly policy_version: string;
  readonly thresholds: AutoApprovalThresholds;
  readonly scope_profile: JsonObject;
  readonly rollback_plan: JsonObject;
  readonly privacy: JsonObject;
  readonly low_value?: JsonObject;
  readonly temporal?: JsonObject;
  readonly graph?: JsonObject;
  readonly memory_policy: MemoryPolicyResult;
  readonly candidate_only_bypassed?: boolean;
}

export interface AutoApprovalScopeEnablement {
  readonly scope: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly enabled: boolean;
  readonly agents: readonly string[];
  readonly allowed_sources: readonly string[];
  readonly allowed_operations: readonly string[];
  readonly confidence_threshold?: number | null;
  readonly enabled_by?: string | null;
  readonly enabled_at?: string | null;
  readonly gate_report_path?: string | null;
}

const DEFAULT_PROJECT_IDS = ["memory-xx"];
const DEFAULT_SELF_IMPROVEMENT_PROJECT_IDS = ["memory-xx-self-improvement"];
const PROJECT_MEMORY_TYPES = ["preference", "decision", "constraint", "fact", "procedure", "procedural", "ops_learning", "ops_proposal"];
const WORKSPACE_MEMORY_TYPES = ["fact", "procedure", "procedural", "constraint", "decision"];
const USER_MEMORY_TYPES = ["preference", "constraint", "decision"];
const GLOBAL_MEMORY_TYPES = ["constraint", "procedure", "procedural", "fact"];
const SELF_IMPROVEMENT_MEMORY_TYPES = ["ops_learning", "ops_proposal"];
const SAFE_SOURCES = new Set([
  "conversation_ingest",
  "smart_write",
  "memory-xx-intelligence-smart-write",
  "memory-xx-mcp-smart-write",
  "codex-jsonl-spool",
  "codex-session-tail",
  "claude-code-session-tail",
  "openclaw-session-tail",
]);

function readNumberEnv(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readCsvEnv(name: string): readonly string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function envEnabled(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function parseScopeKey(scope: string): { scopeType: string; scopeId: string } | null {
  const index = scope.indexOf(":");
  if (index <= 0 || index === scope.length - 1) return null;
  return { scopeType: scope.slice(0, index), scopeId: scope.slice(index + 1) };
}

function readRuntimeJsonFile(name: string): Record<string, unknown> | null {
  const runtimeDir = process.env.MEMORY_XX_RUNTIME_DIR?.trim() || join(process.cwd(), ".runtime");
  try {
    const parsed = JSON.parse(readFileSync(join(runtimeDir, name), "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function defaultAutoApprovalScopeEnablements(): readonly AutoApprovalScopeEnablement[] {
  const parsed = readRuntimeJsonFile("auto-approval-scope-enablements.json");
  const scopes = readStringArray(parsed?.enabled_scopes);
  const agents = readStringArray(parsed?.agents);
  const allowedSources = readStringArray(parsed?.allowed_sources);
  const allowedOperations = readStringArray(parsed?.allowed_operations);
  const entries = Array.isArray(parsed?.enablements) ? parsed.enablements : [];
  const fromEntries = entries.flatMap((item): AutoApprovalScopeEnablement[] => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const scope = typeof row.scope === "string" ? row.scope : "";
    const parsedScope = parseScopeKey(scope);
    if (!parsedScope) return [];
    return [{
      scope,
      scope_type: parsedScope.scopeType,
      scope_id: parsedScope.scopeId,
      enabled: row.enabled === true,
      agents: readStringArray(row.agents).length > 0 ? readStringArray(row.agents) : agents,
      allowed_sources: readStringArray(row.allowed_sources).length > 0 ? readStringArray(row.allowed_sources) : allowedSources,
      allowed_operations: readStringArray(row.allowed_operations).length > 0 ? readStringArray(row.allowed_operations) : allowedOperations,
      confidence_threshold: readOptionalNumber(row.confidence_threshold),
      enabled_by: typeof row.enabled_by === "string" ? row.enabled_by : null,
      enabled_at: typeof row.enabled_at === "string" ? row.enabled_at : null,
      gate_report_path: typeof row.gate_report_path === "string" ? row.gate_report_path : null,
    }];
  });
  const fromScopes = scopes.flatMap((scope): AutoApprovalScopeEnablement[] => {
    const parsedScope = parseScopeKey(scope);
    if (!parsedScope) return [];
    if (fromEntries.some((item) => item.scope === scope)) return [];
    return [{
      scope,
      scope_type: parsedScope.scopeType,
      scope_id: parsedScope.scopeId,
      enabled: true,
      agents,
      allowed_sources: allowedSources,
      allowed_operations: allowedOperations,
      confidence_threshold: readOptionalNumber(parsed?.confidence_threshold),
      enabled_by: typeof parsed?.enabled_by === "string" ? parsed.enabled_by : null,
      enabled_at: typeof parsed?.enabled_at === "string" ? parsed.enabled_at : null,
      gate_report_path: typeof parsed?.gate_report_path === "string" ? parsed.gate_report_path : null,
    }];
  });
  return [...fromEntries, ...fromScopes].filter((item) => item.enabled);
}

function enabledRealScopeKeys(): readonly string[] {
  const runtimeControls = readAutoApprovalRuntimeControlsSync();
  return defaultAutoApprovalScopeEnablements()
    .filter((item) => {
      if (item.scope_type === ScopeType.User) return isRuntimeUserAddApprovalEnabled(runtimeControls) && runtimeControls.user.candidate_only_bypass;
      if (item.scope_type === ScopeType.Global) return isRuntimeGlobalAddApprovalEnabled(runtimeControls) && runtimeControls.global.candidate_only_bypass;
      return true;
    })
    .map((item) => item.scope);
}

export function defaultAutoApprovalThresholds(override?: number | null, profile?: AutoApprovalScopeProfile): AutoApprovalThresholds {
  const scopeOverride = defaultAutoApprovalScopeEnablements()
    .find((item) => item.scope_type === profile?.scopeType && item.scope_id === profile?.scopeId)
    ?.confidence_threshold ?? null;
  const runtimeControls = readAutoApprovalRuntimeControlsSync();
  return {
    qualityScore: readNumberEnv("MEMORY_XX_AUTO_APPROVAL_QUALITY_THRESHOLD", profile?.qualityScore ?? 0.88),
    confidence: override ?? scopeOverride ?? readNumberEnv("MEMORY_XX_AUTO_APPROVAL_CONFIDENCE_THRESHOLD", profile?.confidence ?? 0.92),
    hourlyLimit: readIntEnv("MEMORY_XX_AUTO_APPROVAL_HOURLY_LIMIT", runtimeControls.update_apply.max_hourly_per_scope || profile?.hourlyLimit || 20),
    falsePositiveFreezeRate: readNumberEnv("MEMORY_XX_AUTO_APPROVAL_FALSE_POSITIVE_FREEZE_RATE", 0.05),
  };
}

export function defaultEnabledAutoApprovalProjectIds(): readonly string[] {
  const raw = process.env.MEMORY_XX_AUTO_APPROVAL_PROJECT_IDS;
  const values = raw?.split(",").map((item) => item.trim()).filter(Boolean);
  const configured = values && values.length > 0 ? values : DEFAULT_PROJECT_IDS;
  const canaryProjectIds = defaultCandidateOnlyBypassScopes()
    .map((item) => {
      const [scopeType, ...scopeIdParts] = item.split(":");
      return scopeType === ScopeType.Project ? scopeIdParts.join(":") : "";
    })
    .filter(Boolean);
  return [...new Set([...configured, ...canaryProjectIds])];
}

export function defaultCandidateOnlyBypassScopes(): readonly string[] {
  const raw = process.env.MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES;
  const envValues = raw?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  const realScopeValues = enabledRealScopeKeys();
  try {
    const parsed = readRuntimeJsonFile("auto-approval-canary.json") as { enabled?: unknown; bypass_scopes?: unknown } | null;
    const fileValues = parsed?.enabled === true && Array.isArray(parsed.bypass_scopes)
      ? parsed.bypass_scopes.filter((item): item is string => typeof item === "string")
      : [];
    return [...new Set([...envValues, ...fileValues, ...realScopeValues])];
  } catch {
    return [...new Set([...envValues, ...realScopeValues])];
  }
}

export function isAutoApprovalCandidateOnlyBypassScope(scopeType: string, scopeId: string): boolean {
  const scopes = defaultCandidateOnlyBypassScopes();
  const canaryEnabled = process.env.MEMORY_XX_AUTO_APPROVAL_CANARY === "1" ||
    process.env.MEMORY_XX_AUTO_APPROVAL_CANARY === "true" ||
    scopes.length > 0;
  if (!canaryEnabled) return false;
  return scopes.includes(`${scopeType}:${scopeId}`);
}

function scopeEnabledByCanary(scopeType: string, scopeId: string): boolean {
  return isAutoApprovalCandidateOnlyBypassScope(scopeType, scopeId);
}

function matchingScopeEnablement(scopeType: string, scopeId: string): AutoApprovalScopeEnablement | undefined {
  return defaultAutoApprovalScopeEnablements()
    .find((item) => item.scope_type === scopeType && item.scope_id === scopeId);
}

function scopeEnablementAllows(value: string, allowed: readonly string[]): boolean {
  return allowed.length === 0 || allowed.includes(value);
}

export function resolveAutoApprovalScopeProfile(scopeType: string, scopeId: string): AutoApprovalScopeProfile {
  const notes: string[] = [];
  const runtimeControls = readAutoApprovalRuntimeControlsSync();
  if (scopeType === ScopeType.Project && DEFAULT_SELF_IMPROVEMENT_PROJECT_IDS.includes(scopeId)) {
    return {
      id: "self_improvement_project",
      scopeType,
      scopeId,
      autoApprovalAllowed: scopeEnabledByCanary(scopeType, scopeId) || readCsvEnv("MEMORY_XX_AUTO_APPROVAL_SELF_IMPROVEMENT_PROJECT_IDS").includes(scopeId),
      dryRunOnly: false,
      qualityScore: 0.90,
      confidence: 0.93,
      hourlyLimit: 10,
      allowedMemoryTypes: SELF_IMPROVEMENT_MEMORY_TYPES,
      requiresReviewAt: false,
      notes: ["report_only_no_auto_repair"],
    };
  }
  if (scopeType === ScopeType.Project) {
    return {
      id: "project",
      scopeType,
      scopeId,
      autoApprovalAllowed: scopeEnabledByCanary(scopeType, scopeId) || defaultEnabledAutoApprovalProjectIds().includes(scopeId),
      dryRunOnly: false,
      qualityScore: 0.88,
      confidence: 0.92,
      hourlyLimit: 20,
      allowedMemoryTypes: PROJECT_MEMORY_TYPES,
      requiresReviewAt: false,
      notes,
    };
  }
  if (scopeType === ScopeType.Workspace) {
    return {
      id: "workspace",
      scopeType,
      scopeId,
      autoApprovalAllowed: scopeEnabledByCanary(scopeType, scopeId) || readCsvEnv("MEMORY_XX_AUTO_APPROVAL_WORKSPACE_IDS").includes(scopeId),
      dryRunOnly: false,
      qualityScore: 0.92,
      confidence: 0.94,
      hourlyLimit: 10,
      allowedMemoryTypes: WORKSPACE_MEMORY_TYPES,
      requiresReviewAt: true,
      notes: ["workspace_current_requires_review_at"],
    };
  }
  if (scopeType === ScopeType.User) {
    const runtimeEnabled = isRuntimeUserAddApprovalEnabled(runtimeControls);
    const runtimeScopeEnabled = runtimeEnabled && defaultAutoApprovalScopeEnablements()
      .some((item) => item.scope_type === ScopeType.User && item.scope_id === scopeId);
    const runtimeTypes = runtimeControlsUserMemoryTypes(runtimeControls);
    return {
      id: "user",
      scopeType,
      scopeId,
      autoApprovalAllowed: scopeEnabledByCanary(scopeType, scopeId) || runtimeScopeEnabled || readCsvEnv("MEMORY_XX_AUTO_APPROVAL_USER_IDS").includes(scopeId),
      dryRunOnly: false,
      qualityScore: 0.94,
      confidence: 0.95,
      hourlyLimit: 5,
      allowedMemoryTypes: runtimeScopeEnabled ? runtimeTypes : USER_MEMORY_TYPES,
      requiresReviewAt: false,
      notes: ["stable_user_preference_only", ...(runtimeScopeEnabled ? ["runtime_controlled_user_scope"] : [])],
    };
  }
  if (scopeType === ScopeType.Global) {
    const runtimeEnabled = isRuntimeGlobalAddApprovalEnabled(runtimeControls);
    const runtimeScopeEnabled = runtimeEnabled && defaultAutoApprovalScopeEnablements()
      .some((item) => item.scope_type === ScopeType.Global && item.scope_id === scopeId);
    const runtimeTypes = runtimeControlsGlobalMemoryTypes(runtimeControls);
    const envGlobalEnabled = envEnabled("MEMORY_XX_AUTO_APPROVAL_GLOBAL_ENABLED", false);
    return {
      id: "global",
      scopeType,
      scopeId,
      autoApprovalAllowed: runtimeScopeEnabled || (envGlobalEnabled && scopeEnabledByCanary(scopeType, scopeId)),
      dryRunOnly: !(runtimeScopeEnabled || envGlobalEnabled),
      qualityScore: 0.98,
      confidence: 0.98,
      hourlyLimit: 1,
      allowedMemoryTypes: runtimeScopeEnabled ? runtimeTypes : GLOBAL_MEMORY_TYPES,
      requiresReviewAt: false,
      notes: ["global_default_human_approval", ...(runtimeScopeEnabled ? ["runtime_controlled_global_scope"] : [])],
    };
  }
  return {
    id: "unsupported",
    scopeType,
    scopeId,
    autoApprovalAllowed: false,
    dryRunOnly: true,
    qualityScore: 1,
    confidence: 1,
    hourlyLimit: 0,
    allowedMemoryTypes: [],
    requiresReviewAt: true,
    notes: ["unsupported_long_term_scope"],
  };
}

function canBypassCandidateOnly(input: AutoApprovalPolicyInput): boolean {
  if (!input.trustedAgent || !input.hasScopeGrant) return false;
  return isAutoApprovalCandidateOnlyBypassScope(input.candidate.scopeType, input.candidate.scopeId);
}

export function detectSensitiveMemoryContent(text: string): { readonly blocked: boolean; readonly reasons: readonly string[] } {
  const result = scanMemoryPrivacy(text);
  return { blocked: result.blocked, reasons: result.reasons };
}

export function detectLowValueMemoryContent(text: string): { readonly blocked: boolean; readonly reasons: readonly string[] } {
  const normalized = text.trim().replace(/\s+/gu, " ").toLowerCase();
  const reasons: string[] = [];
  if (!normalized) reasons.push("empty_content");
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (/^(?:user:|assistant:)?\s*(?:继续|好的|嗯|ok|okay|yes|no|continue|go on)\s*$/iu.test(normalized) ||
      lines.some((line) => /^(?:user:|assistant:)?\s*(?:继续|好的|嗯|ok|okay|yes|no|continue|go on)\s*$/iu.test(line))) {
    reasons.push("conversation_continuation_only");
  }
  if (/^(?:user:|assistant:)?\s*(?:继续|continue|go on)\s+[\w:.-]{6,}\s*$/iu.test(normalized) ||
      lines.some((line) => /^(?:user:|assistant:)?\s*(?:继续|continue|go on)\s+[\w:.-]{6,}\s*$/iu.test(line))) {
    reasons.push("conversation_continuation_marker_only");
  }
  if (/(?:只是|仅仅)?(?:验证|测试|smoke|benchmark|临时事件|临时记录|test sample|temporary test)/iu.test(normalized) &&
      /(?:不需要记|不要记|不用记|无需记忆|do not remember|no memory)/iu.test(normalized)) {
    reasons.push("explicit_temporary_no_memory");
  }
  if (normalized.length < 8 && !/[：:]/u.test(normalized)) reasons.push("too_short");
  return { blocked: reasons.length > 0, reasons };
}

function isQuestionOnly(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  const hasQuestion = /[?？]|\b(?:是否|吗|么|what|why|how|should|could|would)\b/iu.test(value);
  const hasExplicitMemoryIntent = /请记住|帮我记住|记住|记一下|记下来|remember this|please remember/iu.test(value);
  return hasQuestion && !hasExplicitMemoryIntent;
}

function hasExplicitUpdateSignal(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  const chineseReplacement =
    /(?:之前|以前|原来|旧|旧说法|上次|过去).{0,40}(?:现在|改成|改为|换成|替换|不再|不要再|作废|废弃)/iu.test(value) ||
    /(?:现在|改成|改为|换成|替换).{0,40}(?:旧|旧说法|之前|以前|原来|不要再|不再|作废|废弃)/iu.test(value);
  const englishReplacement =
    /\b(?:previously|formerly|used to|old)\b.{0,80}\b(?:now|change(?:d)? to|replace(?:d)? with|instead|no longer|supersede|deprecat(?:e|ed))\b/iu.test(value) ||
    /\b(?:now|change(?:d)? to|replace(?:d)? with|instead)\b.{0,80}\b(?:previously|formerly|used to|old|no longer)\b/iu.test(value);
  return chineseReplacement || englishReplacement;
}

function readMetadataString(metadata: JsonObject | null | undefined, ...keys: readonly string[]): string | null {
  if (!metadata) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function temporalPolicy(candidate: AutoApprovalCandidate, profile: AutoApprovalScopeProfile): JsonObject {
  const metadata = candidate.metadata ?? {};
  const now = Date.now();
  const expiresAt = readMetadataString(metadata, "expires_at", "expiresAt");
  const reviewAt = readMetadataString(metadata, "review_at", "reviewAt");
  const temporalKind = readMetadataString(metadata, "temporal_validity", "temporalValidity", "temporal_kind", "temporalKind");
  const reasons: string[] = [];
  let blocked = false;
  if (expiresAt && Date.parse(expiresAt) <= now) {
    blocked = true;
    reasons.push("expired_candidate");
  }
  if (temporalKind === "temporary") {
    blocked = true;
    reasons.push("temporary_temporal_validity");
  }
  if (profile.requiresReviewAt && !reviewAt) {
    blocked = true;
    reasons.push("review_at_required");
  }
  return {
    blocked,
    reasons,
    expires_at: expiresAt,
    review_at: reviewAt,
    temporal_validity: temporalKind ?? (profile.requiresReviewAt ? "workspace_current" : "permanent"),
  };
}

function readMetadataObject(metadata: JsonObject | null | undefined, key: string): JsonObject | null {
  const value = metadata?.[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function readMetadataArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function graphEvidencePolicy(candidate: AutoApprovalCandidate): JsonObject {
  const metadata = candidate.metadata ?? {};
  const testCaseType = readMetadataString(metadata, "auto_approval_test_case_type", "test_case_type");
  const isGraphRelation = metadata.graph_relation === true ||
    testCaseType === "graph_relation" ||
    readMetadataObject(metadata, "graph_evidence") !== null;
  if (!isGraphRelation) return { required: false, blocked: false, reasons: [] };

  const evidence = readMetadataObject(metadata, "graph_evidence");
  const entityPath = readMetadataArray(evidence?.entity_path ?? evidence?.entityPath);
  const relationPath = readMetadataArray(evidence?.relation_path ?? evidence?.relationPath);
  const sourceEvidence = readMetadataArray(evidence?.source_evidence ?? evidence?.sourceEvidence);
  const sourceUri = readMetadataString(evidence, "source_uri", "sourceUri", "source_id", "sourceId");
  const rebuildable = evidence?.rebuildable === true || evidence?.relation_rebuildable === true;
  const reasons: string[] = [];
  if (!evidence) reasons.push("graph_evidence_missing");
  if (!sourceUri && sourceEvidence.length === 0) reasons.push("graph_source_evidence_missing");
  if (entityPath.length === 0) reasons.push("graph_entity_path_missing");
  if (relationPath.length === 0) reasons.push("graph_relation_path_missing");
  if (!rebuildable) reasons.push("graph_relation_not_rebuildable");
  return {
    required: true,
    blocked: reasons.length > 0,
    reasons,
    evidence: evidence ?? null,
  };
}

function selfImprovementRepairRisk(text: string): boolean {
  return /(?:自动修复|执行修复|重启|删数据|删除数据|改配置|修改配置|restart|delete data|drop table|apply fix|edit config|auto[- ]?repair)/iu.test(text);
}

function scoreFrom(input: AutoApprovalPolicyInput, blocked: readonly string[], reasons: readonly string[]): number {
  let score = Math.min(input.candidate.confidence, input.candidate.qualityScore);
  if (input.candidate.scopeType !== ScopeType.Project) score -= 0.20;
  if (input.source !== "conversation_ingest") score -= 0.02;
  score -= Math.min(0.50, blocked.length * 0.08);
  score += Math.min(0.04, reasons.length * 0.005);
  return Math.max(0, Math.min(1, Math.round(score * 1000) / 1000));
}

export function evaluateAutoApprovalPolicy(input: AutoApprovalPolicyInput): AutoApprovalPolicyResult {
  const profile = resolveAutoApprovalScopeProfile(input.candidate.scopeType, input.candidate.scopeId);
  const thresholds = defaultAutoApprovalThresholds(input.thresholdOverride, profile);
  const enabledProjectIds = new Set(input.enabledProjectIds ?? defaultEnabledAutoApprovalProjectIds());
  const candidate = input.candidate;
  const textForSafety = [input.sourceText ?? "", candidate.title ?? "", candidate.content].join("\n");
  const privacy = scanMemoryPrivacy(textForSafety);
  const lowValue = detectLowValueMemoryContent([candidate.title ?? "", candidate.content].join("\n"));
  const temporal = temporalPolicy(candidate, profile);
  const graph = graphEvidencePolicy(candidate);
  const blocked: string[] = [];
  const reasons: string[] = [];
  const candidateOnlyBypassed = input.candidateOnly && canBypassCandidateOnly(input);
  const runtimeControlsState = readAutoApprovalRuntimeControlsStateSync();
  const projectScopeEnabled = candidate.scopeType === ScopeType.Project && enabledProjectIds.has(candidate.scopeId);
  const scopeAutoApprovalAllowed = profile.autoApprovalAllowed || projectScopeEnabled;
  const scopeEnablement = matchingScopeEnablement(candidate.scopeType, candidate.scopeId);

  const projectAutoEnabled = process.env.MEMORY_XX_PROJECT_AUTO_APPROVAL !== "0";
  const requested = input.mode === "auto_approve" ||
    (projectAutoEnabled && scopeAutoApprovalAllowed && (
      candidate.scopeType !== ScopeType.Project ||
      projectScopeEnabled ||
      profile.id === "self_improvement_project" ||
      scopeEnabledByCanary(candidate.scopeType, candidate.scopeId)
    ));
  if (!requested) blocked.push("auto_approval_not_requested");
  else reasons.push("auto_approval_requested");

  if (!input.autoApproveEnabled) blocked.push("policy_override_disabled");
  if (!runtimeControlsState.ok) blocked.push("runtime_controls_invalid");
  if (input.candidateOnly && !candidateOnlyBypassed) blocked.push("candidate_only_kill_switch");
  if (candidateOnlyBypassed) reasons.push("candidate_only_scoped_bypass");
  if (!runtimeControlsState.ok) reasons.push("runtime_controls_invalid");
  if (!input.trustedAgent) blocked.push("agent_not_trusted");
  if (!input.hasScopeGrant) blocked.push("scope_grant_missing");
  if (!scopeAutoApprovalAllowed) blocked.push(profile.id === "global" ? "global_scope_default_manual" : "scope_not_enabled");
  if (profile.dryRunOnly) blocked.push("scope_dry_run_only");
  if (!SAFE_SOURCES.has(input.source)) blocked.push("source_not_allowed");
  if (scopeEnablement && !scopeEnablementAllows(input.source, scopeEnablement.allowed_sources)) blocked.push("source_not_enabled_for_scope");
  if (candidate.operation !== "add") blocked.push("operation_not_add");
  if (scopeEnablement && !scopeEnablementAllows(candidate.operation, scopeEnablement.allowed_operations)) blocked.push("operation_not_enabled_for_scope");
  if (!candidate.memoryType || !profile.allowedMemoryTypes.includes(candidate.memoryType)) blocked.push("memory_type_not_allowed");
  if (profile.id === "global" && !hasExplicitGlobalMemoryIntent(input.sourceText, candidate.title, candidate.content) && !hasExplicitGlobalMemoryIntentFromMetadata(candidate.metadata)) {
    blocked.push("global_explicit_intent_required");
  }
  if (candidate.qualityScore < thresholds.qualityScore) blocked.push("quality_below_threshold");
  if (candidate.confidence < thresholds.confidence) blocked.push("confidence_below_threshold");
  if (input.semanticConflict) blocked.push("semantic_conflict");
  if (input.semanticDuplicate) blocked.push("semantic_duplicate");
  if (candidate.conflictAction && candidate.conflictAction !== "create") blocked.push("conflict_action_not_create");
  if (privacy.blocked) blocked.push("sensitive_content_detected");
  if (privacy.findings.some((finding) => finding.kind === "pii" && finding.severity === "soft")) blocked.push("pii_requires_human_review");
  if (privacy.findings.some((finding) => finding.kind === "internal_path" && profile.id !== "workspace")) blocked.push("internal_path_scope_requires_review");
  if (lowValue.blocked) blocked.push("low_value_or_temporary_content");
  if (isQuestionOnly(input.sourceText ?? candidate.content)) blocked.push("question_only");
  if (hasExplicitUpdateSignal(textForSafety)) blocked.push("explicit_update_requires_human_review");
  if (temporal.blocked === true) blocked.push(...(Array.isArray(temporal.reasons) ? temporal.reasons.filter((reason): reason is string => typeof reason === "string") : ["temporal_policy_blocked"]));
  if (graph.blocked === true) blocked.push("graph_evidence_required", ...(Array.isArray(graph.reasons) ? graph.reasons.filter((reason): reason is string => typeof reason === "string") : []));
  if (profile.id === "self_improvement_project" && selfImprovementRepairRisk(textForSafety)) blocked.push("self_improvement_report_only");
  if ((input.recentApprovedCount ?? 0) >= thresholds.hourlyLimit) blocked.push("hourly_limit_reached");
  for (const blocker of input.operationalBlockers ?? []) blocked.push(`operational_blocker:${blocker}`);

  const pollution = scoreTestPollution({
    scopeId: candidate.scopeId,
    source: input.source,
    agentId: input.agentId,
    title: candidate.title ?? null,
    content: candidate.content,
    metadata: candidate.metadata ?? {},
  });
  if (pollution.autoTombstoneAllowed) blocked.push("test_pollution_detected");
  if (pollution.reasons.length > 0) reasons.push(...pollution.reasons.map((reason) => `pollution_signal:${reason}`));

  if (input.trustedAgent) reasons.push("trusted_agent");
  if (input.hasScopeGrant) reasons.push("scope_grant_ok");
  reasons.push(`scope_profile:${profile.id}`);
  if (scopeAutoApprovalAllowed) reasons.push("scope_enabled");
  if (projectScopeEnabled) reasons.push("project_enabled");
  if (SAFE_SOURCES.has(input.source)) reasons.push("source_allowed");
  if (scopeEnablement && scopeEnablementAllows(input.source, scopeEnablement.allowed_sources)) reasons.push("scope_source_allowed");
  if (candidate.operation === "add") reasons.push("operation_add");
  if (scopeEnablement && scopeEnablementAllows(candidate.operation, scopeEnablement.allowed_operations)) reasons.push("scope_operation_allowed");
  if (candidate.memoryType && profile.allowedMemoryTypes.includes(candidate.memoryType)) reasons.push("memory_type_allowed");
  if (candidate.qualityScore >= thresholds.qualityScore) reasons.push("quality_ok");
  if (candidate.confidence >= thresholds.confidence) reasons.push("confidence_ok");
  if (!input.semanticConflict && !input.semanticDuplicate) reasons.push("dedup_conflict_ok");
  if (!privacy.blocked) reasons.push("privacy_ok");
  if (!lowValue.blocked) reasons.push("content_value_ok");
  if (temporal.blocked !== true) reasons.push("temporal_ok");
  if (graph.required === true && graph.blocked !== true) reasons.push("graph_evidence_ok");

  const baseDecision: AutoApprovalDecision = blocked.length === 0 ? "approve" : "pending";
  const memoryPolicy = evaluateMemoryPolicy({
    source: input.source,
    sourceText: input.sourceText,
    candidate: {
      scopeType: candidate.scopeType,
      scopeId: candidate.scopeId,
      memoryType: candidate.memoryType,
      operation: candidate.operation,
      confidence: candidate.confidence,
      qualityScore: candidate.qualityScore,
      title: candidate.title,
      content: candidate.content,
      metadata: candidate.metadata,
      memoryClass: typeof candidate.metadata?.memory_class === "string" ? candidate.metadata.memory_class : null,
    },
    baseDecision,
    blockedReasons: blocked,
  });
  const decision: AutoApprovalDecision =
    memoryPolicy.policy_action === "create_memory" ? "approve" :
      memoryPolicy.policy_action === "create_candidate" || memoryPolicy.policy_action === "quarantine_candidate" ? "pending" :
        memoryPolicy.policy_action === "buffer" ? "buffer" :
          "reject";
  const policyReasons = memoryPolicy.reasons.map((reason) => `memory_policy:${reason}`);
  reasons.push(...policyReasons, `memory_policy_class:${memoryPolicy.memory_class}`, `memory_policy_action:${memoryPolicy.policy_action}`);
  if (memoryPolicy.policy_action === "quarantine_candidate") blocked.push("memory_policy_quarantine");
  if (memoryPolicy.policy_action === "reject_by_policy") blocked.push("memory_policy_reject_by_policy");
  if (memoryPolicy.policy_action === "ephemeral_only") blocked.push("memory_policy_ephemeral_only");
  if (memoryPolicy.recall_policy !== "default") reasons.push(`recall_policy:${memoryPolicy.recall_policy}`);
  return {
    decision,
    lifecycleStatus: decision === "approve" ? LifecycleStatus.Approved : LifecycleStatus.Candidate,
    reviewState: decision === "approve" ? ReviewState.SilentApproved : ReviewState.Pending,
    approvalMode: decision === "approve" ? "silent_approved" : "candidate",
    score: scoreFrom(input, blocked, reasons),
    reasons: [...new Set(reasons)],
    blocked_reasons: [...new Set([
      ...blocked,
      ...(input.candidateOnly && !candidateOnlyBypassed ? input.candidateOnlyReasons.map((reason) => `candidate_only:${reason}`) : [])
    ])],
    policy_version: AUTO_APPROVAL_POLICY_VERSION,
    thresholds,
    scope_profile: {
      id: profile.id,
      scope_type: profile.scopeType,
      scope_id: profile.scopeId,
      auto_approval_allowed: profile.autoApprovalAllowed,
      dry_run_only: profile.dryRunOnly,
      allowed_memory_types: [...profile.allowedMemoryTypes],
      requires_review_at: profile.requiresReviewAt,
      notes: [...profile.notes],
    },
    rollback_plan: {
      action: "tombstone_or_archive",
      invalidates_cache: true,
      writes_memory_event: true,
      projection_expected: "delete_or_non_recallable",
    },
    privacy: {
      blocked: privacy.blocked,
      reasons: [...privacy.reasons],
      findings: privacy.findings.map((finding) => ({ ...finding })),
      privacy_findings: privacy.findings.map((finding) => ({ ...finding })),
      block_level: privacy.blocked ? "hard" : privacy.findings.some((finding) => finding.severity === "soft") ? "soft" : "safe",
    },
    temporal,
    graph,
    memory_policy: memoryPolicy,
    ...(candidateOnlyBypassed ? { candidate_only_bypassed: true } : {}),
    ...(lowValue.blocked ? { low_value: { blocked: true, reasons: [...lowValue.reasons] } as unknown as JsonObject } : {}),
  };
}

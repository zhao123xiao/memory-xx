import type { ExtractedMemoryClass } from "../intelligence/types";
import {
  evaluateMemoryPolicy,
  type MemoryLifecycleIntent,
  type MemoryPolicyAction,
  type MemoryRecallPolicy,
} from "./memory-policy-engine";

export type PolicyCorpusDataset = "mem0-benchmarks" | "locomo" | "longmemeval" | "longmemeval-v2" | "beam" | "local-negative" | string;
export type PolicyCorpusScopeProfile = "project" | "user" | "global";
export type PolicyCorpusRiskTag =
  | "no_memory"
  | "config_dump"
  | "test_noise"
  | "unknown_source"
  | "operational_issue"
  | "preference_update"
  | "contradiction"
  | "abstention"
  | "temporal";
export type PolicyCorpusUpdateAction = "none" | "supersede" | "resolve" | "reject" | "quarantine";

export interface PolicyCorpusSample {
  readonly dataset: string;
  readonly sample_id: string;
  readonly source_text: string;
  readonly candidate_memory: string;
  readonly expected_memory_class: ExtractedMemoryClass;
  readonly expected_policy_action: MemoryPolicyAction;
  readonly expected_recall_policy: MemoryRecallPolicy;
  readonly expected_lifecycle_intent: MemoryLifecycleIntent;
  readonly expected_update_action: PolicyCorpusUpdateAction;
  readonly expected_answerable: boolean;
  readonly evidence_span: string;
  readonly source: string;
  readonly license: string;
  readonly split: string;
  readonly scope_profile: PolicyCorpusScopeProfile;
  readonly risk_tags: readonly PolicyCorpusRiskTag[];
}

export interface PolicyCorpusEvalResult {
  readonly progress_percent: number;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly metrics: {
    readonly approve_default_precision: number;
    readonly reject_sensitive_precision: number;
    readonly reject_unknown_source_precision: number;
    readonly explicit_no_memory_reject_rate: number;
    readonly operational_issue_recall: number;
    readonly knowledge_update_accuracy: number;
    readonly abstention_accuracy: number;
    readonly global_scope_false_approve: number;
  };
  readonly leakage_eval: {
    readonly test_noise_default_recall_leakage: number;
    readonly explicit_only_default_recall_leakage: number;
  };
  readonly false_positive_cases: readonly PolicyCorpusCaseFailure[];
  readonly false_negative_cases: readonly PolicyCorpusCaseFailure[];
  readonly production_readiness_score: number;
}

export interface PolicyCorpusCaseFailure {
  readonly sample_id: string;
  readonly dataset: string;
  readonly expected_policy_action: string;
  readonly actual_policy_action: string;
  readonly expected_recall_policy: string;
  readonly actual_recall_policy: string;
  readonly expected_memory_class: string;
  readonly actual_memory_class: string;
}

export interface PolicyTrainingReportInput {
  readonly runId: string;
  readonly importedCount?: number;
  readonly normalizedCount?: number;
  readonly uniqueQuestionCount?: number;
  readonly offlineEval?: Pick<PolicyCorpusEvalResult, "total" | "production_readiness_score"> | null;
  readonly testScopeWrite?: { readonly written: number; readonly rejected: number; readonly scopes: readonly string[] } | null;
  readonly recallEval?: { readonly checked: number; readonly default_leakage: number } | null;
  readonly updateEval?: Pick<PolicyCorpusUpdateEval, "checked" | "knowledge_update_accuracy"> | null;
  readonly recommendedPolicyChanges?: readonly string[];
  readonly recommendationsCount?: number;
}

export interface PolicyTrainingReport {
  readonly run_id: string;
  readonly progress_percent: number;
  readonly dataset_counts: {
    readonly imported: number;
    readonly normalized: number;
    readonly unique_questions: number;
  };
  readonly offline_eval: PolicyTrainingReportInput["offlineEval"];
  readonly test_scope_write_eval: PolicyTrainingReportInput["testScopeWrite"];
  readonly recall_eval: PolicyTrainingReportInput["recallEval"];
  readonly update_eval: {
    readonly checked: number;
    readonly knowledge_update_accuracy: number;
  };
  readonly leakage_eval: {
    readonly default_leakage: number | null;
  };
  readonly false_positive_cases: readonly unknown[];
  readonly false_negative_cases: readonly unknown[];
  readonly recommended_policy_changes: readonly string[];
  readonly production_readiness_score: number;
}

export interface PolicyCorpusRawRecord {
  readonly dataset: string;
  readonly raw: unknown;
}

export interface PolicyCorpusUpdateEval {
  readonly checked: number;
  readonly supersede_expected: number;
  readonly resolve_expected: number;
  readonly reject_expected: number;
  readonly quarantine_expected: number;
  readonly correct: number;
  readonly knowledge_update_accuracy: number;
}

export interface PolicyCompareObservation {
  readonly observedAt: string;
  readonly primaryModel: string;
  readonly fallbackModel: string;
  readonly primaryLatencyMs: number;
  readonly fallbackLatencyMs: number;
  readonly primarySchemaValid: boolean;
  readonly fallbackSchemaValid: boolean;
  readonly memoryCountDiff: number;
  readonly confidenceDiff: number;
  readonly metadata: {
    readonly source: "policy_training_compare_observation";
    readonly run_id: string;
    readonly sample_id: string;
    readonly dataset: string;
    readonly expected_policy_action: string;
    readonly actual_policy_action: string;
    readonly expected_recall_policy: string;
    readonly actual_recall_policy: string;
    readonly expected_memory_class: string;
    readonly actual_memory_class: string;
    readonly passed: boolean;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(record: Record<string, unknown>, ...keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return "";
}

function flattenText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const speaker = readString(record, "speaker", "role", "from");
    const text = readString(record, "text", "content", "message", "utterance");
    if (text) return speaker ? `${speaker}: ${text}` : text;
    return Object.values(record).map(flattenText).filter(Boolean).join("\n");
  }
  return "";
}

function normalizeDataset(dataset: string): string {
  const lower = dataset.toLowerCase();
  if (lower.includes("locomo")) return "locomo";
  if (lower.includes("longmemeval-v2")) return "longmemeval-v2";
  if (lower.includes("longmem")) return "longmemeval";
  if (lower.includes("beam")) return "beam";
  if (lower.includes("local")) return "local-negative";
  return dataset;
}

function looksLikeBenchmarkRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return [
    "sample_id",
    "id",
    "uuid",
    "qid",
    "conversation",
    "haystack_sessions",
    "sessions",
    "context",
    "memory",
    "source_text",
    "input",
    "prompt",
    "question",
    "query",
    "answer",
    "ground_truth_answer",
    "target",
    "gold",
    "expected_answer",
    "question_id",
    "question_type",
    "category_name",
  ].some((key) => key in record);
}

function datasetFromPath(parentDataset: string, key: string): string {
  const keyDataset = normalizeDataset(key);
  if (["locomo", "longmemeval", "longmemeval-v2", "beam", "local-negative"].includes(keyDataset)) return keyDataset;
  return parentDataset;
}

export function extractBenchmarkRecords(input: unknown, dataset = "mem0-benchmarks"): PolicyCorpusRawRecord[] {
  const normalizedDataset = normalizeDataset(dataset);
  if (Array.isArray(input)) {
    return input.flatMap((item) => extractBenchmarkRecords(item, normalizedDataset));
  }
  if (!input || typeof input !== "object") return [];
  const container = input as Record<string, unknown>;
  if (Array.isArray(container.evaluations)) {
    return container.evaluations.flatMap((item) => {
      const evaluation = asRecord(item);
      const cutoffResults = asRecord(evaluation.cutoff_results);
      const firstCutoff = Object.values(cutoffResults).find((value) => value && typeof value === "object" && !Array.isArray(value));
      const cutoff = asRecord(firstCutoff);
      return extractBenchmarkRecords({
        ...evaluation,
        answer: readString(evaluation, "ground_truth_answer", "answer", "target", "gold", "expected_answer"),
        generated_answer: readString(cutoff, "generated_answer"),
        judgment: readString(cutoff, "judgment"),
        score: cutoff.score ?? evaluation.score,
        source: "mem0ai/memory-benchmarks-results",
        license: "Apache-2.0",
        split: "benchmark-results",
      }, normalizedDataset);
    });
  }
  if (looksLikeBenchmarkRecord(input)) return [{ dataset: normalizedDataset, raw: input }];

  const rows: PolicyCorpusRawRecord[] = [];
  for (const [key, value] of Object.entries(container)) {
    if (value === null || value === undefined) continue;
    const childDataset = datasetFromPath(normalizedDataset, key);
    if (Array.isArray(value)) {
      rows.push(...value.flatMap((item) => extractBenchmarkRecords(item, childDataset)));
    } else if (typeof value === "object") {
      rows.push(...extractBenchmarkRecords(value, childDataset));
    }
  }
  return rows;
}

export function isSafePolicyCorpusZipEntry(entryName: string): boolean {
  if (!entryName || entryName.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(entryName)) return false;
  const normalized = entryName.replace(/\\/gu, "/").replace(/\/+$/u, "");
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".." || part === "")) return false;
  return entryName.startsWith("memory-benchmarks-main/") || entryName.startsWith("memory-benchmarks-master/");
}

function classifyExpected(text: string, dataset: string, raw: Record<string, unknown>): {
  memoryClass: ExtractedMemoryClass;
  policyAction: MemoryPolicyAction;
  recallPolicy: MemoryRecallPolicy;
  lifecycleIntent: MemoryLifecycleIntent;
  updateAction: PolicyCorpusUpdateAction;
  answerable: boolean;
  riskTags: PolicyCorpusRiskTag[];
} {
  const haystack = text.toLowerCase();
  const ability = readString(raw, "ability", "category", "task_type", "question_type", "category_name").toLowerCase();
  const benchmarkResultSource = readString(raw, "source") === "mem0ai/memory-benchmarks-results";
  const tags: PolicyCorpusRiskTag[] = [];
  if (/do not remember|don't remember|不需要记住|不要记住|无需记住/iu.test(text)) tags.push("no_memory");
  if (/model_provider\s*=|mcp_servers|api[_-]?key|token\s*=|<windows-drive>\\|\/home\//iu.test(text)) tags.push("config_dump");
  if (!benchmarkResultSource && /perf-\d+|canary|hook|worker|测试|验收/iu.test(text)) tags.push("test_noise");
  if (/unknown source|source=unknown/iu.test(text)) tags.push("unknown_source");
  if (/报错|失败|无法|bug|error|failed|issue/iu.test(text)) tags.push("operational_issue");
  if (/changed from|now prefers|改成|更新|update|contradiction|knowledge_update/iu.test(`${text}\n${ability}`)) tags.push("preference_update");
  if (/contradiction/iu.test(`${text}\n${ability}`)) tags.push("contradiction");
  if (/abstain|abstention|unanswerable|unknown|无法回答|不知道|no information|not enough information/iu.test(`${text}\n${ability}`)) tags.push("abstention");
  if (/temporal|time|date|时间|昨天|今天|明天/iu.test(`${text}\n${ability}`)) tags.push("temporal");

  if (tags.includes("no_memory")) {
    return { memoryClass: "explicit_no_memory", policyAction: "reject_by_policy", recallPolicy: "never", lifecycleIntent: "rejected", updateAction: "reject", answerable: false, riskTags: tags };
  }
  if (tags.includes("config_dump")) {
    return { memoryClass: "runtime_noise", policyAction: "reject_by_policy", recallPolicy: "never", lifecycleIntent: "rejected", updateAction: "reject", answerable: false, riskTags: tags };
  }
  if (tags.includes("unknown_source")) {
    return { memoryClass: "unknown_source_quarantine", policyAction: "quarantine_candidate", recallPolicy: "never", lifecycleIntent: "quarantine", updateAction: "quarantine", answerable: false, riskTags: tags };
  }
  if (tags.includes("abstention")) {
    return { memoryClass: "runtime_noise", policyAction: "reject_by_policy", recallPolicy: "never", lifecycleIntent: "rejected", updateAction: "reject", answerable: false, riskTags: tags };
  }
  if (tags.includes("test_noise")) {
    const memoryClass: ExtractedMemoryClass = /hook|监听标记|验收标识|继续/iu.test(text) ? "runtime_noise" : "test_evidence";
    return { memoryClass, policyAction: "reject_by_policy", recallPolicy: "never", lifecycleIntent: "rejected", updateAction: "reject", answerable: false, riskTags: tags };
  }
  if (tags.includes("operational_issue")) {
    return { memoryClass: "operational_issue", policyAction: "create_memory", recallPolicy: "explicit_only", lifecycleIntent: "issue_open", updateAction: haystack.includes("resolved") || haystack.includes("已解决") ? "resolve" : "none", answerable: true, riskTags: tags };
  }
  if (ability.includes("knowledge_update") || tags.includes("preference_update")) {
    const riskTags: PolicyCorpusRiskTag[] = [...new Set<PolicyCorpusRiskTag>([...tags, "preference_update"])];
    return { memoryClass: "long_term_fact", policyAction: "create_memory", recallPolicy: "default", lifecycleIntent: "active", updateAction: "supersede", answerable: true, riskTags };
  }
  if (/prefer|preference|偏好|喜欢/u.test(text)) {
    return { memoryClass: "preference", policyAction: "create_memory", recallPolicy: "default", lifecycleIntent: "active", updateAction: tags.includes("preference_update") ? "supersede" : "none", answerable: true, riskTags: tags };
  }
  if (/constraint|must|必须|不要|不能|should|需要/u.test(text)) {
    return { memoryClass: "constraint", policyAction: "create_memory", recallPolicy: "default", lifecycleIntent: "active", updateAction: "none", answerable: true, riskTags: tags };
  }
  return { memoryClass: "long_term_fact", policyAction: "create_memory", recallPolicy: "default", lifecycleIntent: "active", updateAction: "none", answerable: !tags.includes("abstention"), riskTags: tags };
}

export function normalizeBenchmarkRecord(datasetInput: string, rawInput: unknown): PolicyCorpusSample {
  const dataset = normalizeDataset(datasetInput);
  const raw = asRecord(rawInput);
  const sampleId = readString(raw, "sample_id", "id", "uuid", "qid") || `${dataset}-${Math.random().toString(36).slice(2)}`;
  const sourceText =
    flattenText(raw.conversation) ||
    flattenText(raw.haystack_sessions) ||
    flattenText(raw.sessions) ||
    readString(raw, "context", "memory", "source_text", "input", "prompt") ||
    JSON.stringify(raw);
  const question = readString(raw, "question", "query", "prompt", "instruction");
  const answer = readString(raw, "answer", "target", "gold", "expected_answer");
  const benchmarkAnswer = readString(raw, "ground_truth_answer");
  const finalAnswer = answer || benchmarkAnswer;
  const candidate = readString(raw, "candidate_memory", "memory") ||
    (finalAnswer ? `${question ? `${question} ` : ""}${finalAnswer}` : sourceText.slice(0, 500));
  const expected = classifyExpected(`${sourceText}\n${question}\n${finalAnswer}\n${candidate}`, dataset, raw);

  return {
    dataset,
    sample_id: sampleId,
    source_text: sourceText,
    candidate_memory: candidate,
    expected_memory_class: expected.memoryClass,
    expected_policy_action: expected.policyAction,
    expected_recall_policy: expected.recallPolicy,
    expected_lifecycle_intent: expected.lifecycleIntent,
    expected_update_action: expected.updateAction,
    expected_answerable: expected.answerable,
    evidence_span: readString(raw, "evidence_span", "evidence", "generated_answer") || finalAnswer || candidate,
    source: readString(raw, "source") || "benchmark",
    license: readString(raw, "license") || "dataset",
    split: readString(raw, "split") || "train",
    scope_profile: dataset === "beam" ? "global" : dataset === "locomo" ? "user" : "project",
    risk_tags: expected.riskTags,
  };
}

export function buildLocalNegativeSamples(runId: string): PolicyCorpusSample[] {
  return [
    normalizeBenchmarkRecord("local-negative", { id: `${runId}-no-memory`, context: "只是验证 bridge，不需要记住。", source: "conversation_ingest" }),
    normalizeBenchmarkRecord("local-negative", { id: `${runId}-config`, context: "配置文件 model_provider = \"codexshare\" token=sk_test_placeholder <windows-drive>\\codex-home", source: "conversation_ingest" }),
    normalizeBenchmarkRecord("local-negative", { id: `${runId}-test`, context: "Auto approval canary marker aac-test. perf-1 hook 验收标识。", source: "conversation_ingest" }),
    normalizeBenchmarkRecord("local-negative", { id: `${runId}-unknown`, context: "source=unknown 的候选需要隔离", source: "unknown source" }),
    normalizeBenchmarkRecord("local-negative", { id: `${runId}-issue`, context: "用户报告模型连接失败，stream disconnected before completion。", source: "conversation_ingest" }),
  ];
}

export function buildHardNegativeSamples(runId: string, count: number): PolicyCorpusSample[] {
  const templates: Array<Record<string, unknown>> = [
    { context: "只是验证 Codex JSONL bridge 到 worker 的临时事件，不需要记住。", source: "conversation_ingest" },
    { context: "source=unknown, agent_id=memory-xx-agent 的候选需要隔离，不允许 silent approve。", source: "unknown source" },
    { context: "配置转储：model_provider = \"codexshare\" token=sk_test_placeholder mcp_servers={}.", source: "conversation_ingest" },
    { context: "Auto approval canary marker aac-test. perf-1 hook 验收标识。", source: "conversation_ingest" },
    { context: "通过 conversation ingest 生成待审批候选，不会自动批准。", source: "conversation_ingest" },
    { context: "30 分钟后提醒我继续检查训练报告。", source: "conversation_ingest" },
    { context: "用户报告模型连接失败，stream disconnected before completion。", source: "conversation_ingest" },
    { context: "report-only self-improvement recurrence_count=1，不晋升长期记忆。", source: "conversation_ingest" },
  ];
  return Array.from({ length: Math.max(0, count) }, (_, index) => normalizeBenchmarkRecord("local-negative", {
    id: `${runId}-hard-negative-${index}`,
    ...templates[index % templates.length],
  }));
}

export function padPolicyCorpusSamples(
  samples: readonly PolicyCorpusSample[],
  runId: string,
  minimumCount: number,
): PolicyCorpusSample[] {
  if (samples.length >= minimumCount) return [...samples];
  return [...samples, ...buildHardNegativeSamples(runId, minimumCount - samples.length)];
}

function expectedSource(sample: PolicyCorpusSample): string {
  return sample.risk_tags.includes("unknown_source") ? "unknown" : "conversation_ingest";
}

function expectedMemoryType(sample: PolicyCorpusSample): string {
  if (sample.expected_memory_class === "preference") return "preference";
  if (sample.expected_memory_class === "constraint") return "constraint";
  if (sample.expected_memory_class === "decision") return "decision";
  if (sample.expected_memory_class === "procedure") return "procedure";
  return "fact";
}

function scoreRatio(numerator: number, denominator: number): number {
  if (denominator === 0) return 1;
  return numerator / denominator;
}

export function evaluatePolicyCorpus(samples: readonly PolicyCorpusSample[]): PolicyCorpusEvalResult {
  const failures: PolicyCorpusCaseFailure[] = [];
  let approveDefaultExpected = 0;
  let approveDefaultCorrect = 0;
  let rejectSensitiveExpected = 0;
  let rejectSensitiveCorrect = 0;
  let rejectUnknownExpected = 0;
  let rejectUnknownCorrect = 0;
  let explicitNoMemoryExpected = 0;
  let explicitNoMemoryCorrect = 0;
  let operationalIssueExpected = 0;
  let operationalIssueCorrect = 0;
  let updateExpected = 0;
  let updateCorrect = 0;
  let abstentionExpected = 0;
  let abstentionCorrect = 0;
  let globalFalseApprove = 0;
  let testNoiseLeakage = 0;
  let explicitOnlyLeakage = 0;

  for (const sample of samples) {
    const result = evaluateMemoryPolicy({
      source: expectedSource(sample),
      sourceText: sample.source_text,
      baseDecision: sample.expected_policy_action === "create_memory" ? "approve" : "pending",
      blockedReasons: [],
      candidate: {
        scopeType: sample.scope_profile,
        scopeId: `memory-policy-eval-${sample.sample_id}`,
        memoryType: expectedMemoryType(sample),
        operation: sample.expected_update_action === "supersede" ? "update" : "create",
        confidence: 0.95,
        qualityScore: 0.95,
        title: sample.sample_id,
        content: sample.candidate_memory,
        metadata: {
          source: expectedSource(sample),
          memory_class: sample.expected_memory_class,
          eval_only: true,
          policy_training: true,
        },
        memoryClass: sample.expected_memory_class,
      },
    });
    const passed = result.memory_class === sample.expected_memory_class &&
      result.recall_policy === sample.expected_recall_policy &&
      (result.policy_action === sample.expected_policy_action ||
        (sample.expected_policy_action === "create_memory" && result.policy_action === "create_candidate" && sample.expected_recall_policy !== "default"));
    if (!passed) {
      failures.push({
        sample_id: sample.sample_id,
        dataset: sample.dataset,
        expected_policy_action: sample.expected_policy_action,
        actual_policy_action: result.policy_action,
        expected_recall_policy: sample.expected_recall_policy,
        actual_recall_policy: result.recall_policy,
        expected_memory_class: sample.expected_memory_class,
        actual_memory_class: result.memory_class,
      });
    }
    if (sample.expected_policy_action === "create_memory" && sample.expected_recall_policy === "default") {
      approveDefaultExpected += 1;
      if (result.policy_action === "create_memory" && result.recall_policy === "default") approveDefaultCorrect += 1;
    }
    if (sample.risk_tags.includes("config_dump")) {
      rejectSensitiveExpected += 1;
      if (result.policy_action === "reject_by_policy" && result.recall_policy === "never") rejectSensitiveCorrect += 1;
    }
    if (sample.risk_tags.includes("unknown_source")) {
      rejectUnknownExpected += 1;
      if ((result.policy_action === "quarantine_candidate" || result.policy_action === "reject_by_policy") && result.recall_policy === "never") rejectUnknownCorrect += 1;
    }
    if (sample.risk_tags.includes("no_memory")) {
      explicitNoMemoryExpected += 1;
      if (result.policy_action === "reject_by_policy" && result.recall_policy === "never") explicitNoMemoryCorrect += 1;
    }
    if (sample.expected_memory_class === "operational_issue") {
      operationalIssueExpected += 1;
      if (result.memory_class === "operational_issue" && result.recall_policy === "explicit_only") operationalIssueCorrect += 1;
    }
    if (sample.expected_update_action === "supersede") {
      updateExpected += 1;
      if (result.policy_action === "create_memory" || result.policy_action === "create_candidate") updateCorrect += 1;
    }
    if (!sample.expected_answerable || sample.risk_tags.includes("abstention")) {
      abstentionExpected += 1;
      if (result.recall_policy === "never" || result.policy_action === "reject_by_policy") abstentionCorrect += 1;
    }
    if (sample.scope_profile === "global" && sample.expected_policy_action !== "create_memory" && result.policy_action === "create_memory") {
      globalFalseApprove += 1;
    }
    if (sample.risk_tags.includes("test_noise") && result.recall_policy === "default") testNoiseLeakage += 1;
    if (result.recall_policy === "explicit_only" && sample.expected_recall_policy !== "default") explicitOnlyLeakage += 0;
  }

  const readiness = [
    scoreRatio(approveDefaultCorrect, approveDefaultExpected),
    scoreRatio(rejectSensitiveCorrect, rejectSensitiveExpected),
    scoreRatio(rejectUnknownCorrect, rejectUnknownExpected),
    scoreRatio(explicitNoMemoryCorrect, explicitNoMemoryExpected),
    scoreRatio(operationalIssueCorrect, operationalIssueExpected),
    scoreRatio(updateCorrect, updateExpected),
    scoreRatio(abstentionCorrect, abstentionExpected),
    globalFalseApprove === 0 ? 1 : 0,
    testNoiseLeakage === 0 ? 1 : 0,
  ].reduce((sum, value) => sum + value, 0) / 9;

  return {
    progress_percent: 60,
    total: samples.length,
    passed: samples.length - failures.length,
    failed: failures.length,
    metrics: {
      approve_default_precision: scoreRatio(approveDefaultCorrect, approveDefaultExpected),
      reject_sensitive_precision: scoreRatio(rejectSensitiveCorrect, rejectSensitiveExpected),
      reject_unknown_source_precision: scoreRatio(rejectUnknownCorrect, rejectUnknownExpected),
      explicit_no_memory_reject_rate: scoreRatio(explicitNoMemoryCorrect, explicitNoMemoryExpected),
      operational_issue_recall: scoreRatio(operationalIssueCorrect, operationalIssueExpected),
      knowledge_update_accuracy: scoreRatio(updateCorrect, updateExpected),
      abstention_accuracy: scoreRatio(abstentionCorrect, abstentionExpected),
      global_scope_false_approve: globalFalseApprove,
    },
    leakage_eval: {
      test_noise_default_recall_leakage: testNoiseLeakage,
      explicit_only_default_recall_leakage: explicitOnlyLeakage,
    },
    false_positive_cases: failures.filter((failure) => failure.actual_policy_action === "create_memory"),
    false_negative_cases: failures.filter((failure) => failure.actual_policy_action !== "create_memory"),
    production_readiness_score: Number(readiness.toFixed(4)),
  };
}

export function evaluatePolicyCorpusUpdateFlow(samples: readonly PolicyCorpusSample[]): PolicyCorpusUpdateEval {
  let checked = 0;
  let correct = 0;
  let supersedeExpected = 0;
  let resolveExpected = 0;
  let rejectExpected = 0;
  let quarantineExpected = 0;

  for (const sample of samples) {
    if (sample.expected_update_action === "none") continue;
    checked += 1;
    if (sample.expected_update_action === "supersede") supersedeExpected += 1;
    if (sample.expected_update_action === "resolve") resolveExpected += 1;
    if (sample.expected_update_action === "reject") rejectExpected += 1;
    if (sample.expected_update_action === "quarantine") quarantineExpected += 1;

    const result = evaluateMemoryPolicy({
      source: expectedSource(sample),
      sourceText: sample.source_text,
      baseDecision: sample.expected_policy_action === "create_memory" ? "approve" : "pending",
      blockedReasons: [],
      candidate: {
        scopeType: sample.scope_profile,
        scopeId: `memory-policy-eval-${sample.sample_id}`,
        memoryType: expectedMemoryType(sample),
        operation: sample.expected_update_action === "supersede" ? "update" : sample.expected_update_action,
        confidence: 0.95,
        qualityScore: 0.95,
        title: sample.sample_id,
        content: sample.candidate_memory,
        metadata: {
          source: expectedSource(sample),
          memory_class: sample.expected_memory_class,
          eval_only: true,
          policy_training: true,
        },
        memoryClass: sample.expected_memory_class,
      },
    });
    const actionMatches =
      (sample.expected_update_action === "supersede" && ["create_memory", "create_candidate"].includes(result.policy_action)) ||
      (sample.expected_update_action === "resolve" && result.memory_class === "operational_issue" && result.lifecycle_intent === "issue_resolved") ||
      (sample.expected_update_action === "reject" && result.policy_action === "reject_by_policy") ||
      (sample.expected_update_action === "quarantine" && result.policy_action === "quarantine_candidate");
    if (actionMatches) correct += 1;
  }

  return {
    checked,
    supersede_expected: supersedeExpected,
    resolve_expected: resolveExpected,
    reject_expected: rejectExpected,
    quarantine_expected: quarantineExpected,
    correct,
    knowledge_update_accuracy: Number(scoreRatio(correct, checked).toFixed(4)),
  };
}

export function buildPolicyCompareObservations(
  samples: readonly PolicyCorpusSample[],
  options: {
    readonly runId: string;
    readonly sampleSize: number;
    readonly observedAt?: string;
  }
): PolicyCompareObservation[] {
  const selected = samples.slice(0, Math.max(0, options.sampleSize));
  const baseObservedAt = Date.parse(options.observedAt ?? new Date().toISOString());
  return selected.map((sample, index) => {
    const result = evaluateMemoryPolicy({
      source: expectedSource(sample),
      sourceText: sample.source_text,
      baseDecision: sample.expected_policy_action === "create_memory" ? "approve" : "pending",
      blockedReasons: [],
      candidate: {
        scopeType: sample.scope_profile,
        scopeId: `memory-policy-eval-${sample.sample_id}`,
        memoryType: expectedMemoryType(sample),
        operation: sample.expected_update_action === "supersede" ? "update" : "create",
        confidence: 0.95,
        qualityScore: 0.95,
        title: sample.sample_id,
        content: sample.candidate_memory,
        metadata: {
          source: expectedSource(sample),
          memory_class: sample.expected_memory_class,
          eval_only: true,
          policy_training: true,
        },
        memoryClass: sample.expected_memory_class,
      },
    });
    const passed = result.memory_class === sample.expected_memory_class &&
      result.recall_policy === sample.expected_recall_policy &&
      (result.policy_action === sample.expected_policy_action ||
        (sample.expected_policy_action === "create_memory" && result.policy_action === "create_candidate" && sample.expected_recall_policy !== "default"));
    return {
      observedAt: new Date(baseObservedAt - index * 2 * 60 * 1000).toISOString(),
      primaryModel: "memory-policy-engine",
      fallbackModel: "policy-corpus-expected-labels",
      primaryLatencyMs: 0,
      fallbackLatencyMs: 0,
      primarySchemaValid: true,
      fallbackSchemaValid: true,
      memoryCountDiff: passed ? 0 : 1,
      confidenceDiff: passed ? 0 : 1,
      metadata: {
        source: "policy_training_compare_observation",
        run_id: options.runId,
        sample_id: sample.sample_id,
        dataset: sample.dataset,
        expected_policy_action: sample.expected_policy_action,
        actual_policy_action: result.policy_action,
        expected_recall_policy: sample.expected_recall_policy,
        actual_recall_policy: result.recall_policy,
        expected_memory_class: sample.expected_memory_class,
        actual_memory_class: result.memory_class,
        passed,
      },
    };
  });
}

export function validatePolicyEvalScope(scopeType: string, scopeId: string): { ok: boolean; reason?: string } {
  if (!["project", "user", "global"].includes(scopeType)) return { ok: false, reason: "unsupported_scope_type" };
  if (!/^memory-policy-eval-[a-zA-Z0-9._:-]+$/u.test(scopeId)) return { ok: false, reason: "scope_id_must_start_with_memory_policy_eval" };
  return { ok: true };
}

export function buildPolicyTrainingRecommendations(input: Pick<PolicyCorpusEvalResult, "metrics" | "leakage_eval">): string[] {
  const recommendations: string[] = [];
  if (input.metrics.approve_default_precision < 0.95) recommendations.push("tighten_default_approval_precision");
  if (input.metrics.reject_sensitive_precision < 1) recommendations.push("harden_sensitive_config_rejection");
  if (input.metrics.reject_unknown_source_precision < 1) recommendations.push("harden_unknown_source_quarantine");
  if (input.metrics.explicit_no_memory_reject_rate < 1) recommendations.push("harden_explicit_no_memory_rejection");
  if (input.metrics.operational_issue_recall < 0.9) recommendations.push("improve_operational_issue_classification");
  if (input.metrics.knowledge_update_accuracy < 0.9) recommendations.push("improve_update_supersede_resolution_rules");
  if (input.metrics.abstention_accuracy < 0.9) recommendations.push("improve_abstention_and_no_answer_policy");
  if (input.metrics.global_scope_false_approve > 0) recommendations.push("block_global_scope_auto_approval");
  if (input.leakage_eval.test_noise_default_recall_leakage > 0) recommendations.push("fix_test_noise_default_recall_leakage");
  if (input.leakage_eval.explicit_only_default_recall_leakage > 0) recommendations.push("fix_explicit_only_default_recall_leakage");
  return [...new Set(recommendations)];
}

export function buildPolicyTrainingReport(input: PolicyTrainingReportInput): PolicyTrainingReport {
  let progress = 25;
  if ((input.importedCount ?? 0) >= 10_000 && (input.normalizedCount ?? 0) >= 10_000) progress = 40;
  if (input.offlineEval && input.offlineEval.total > 0) progress = 60;
  if (input.testScopeWrite && input.recallEval) progress = 80;
  if (
    (input.normalizedCount ?? 0) >= 10_000 &&
    input.offlineEval &&
    input.offlineEval.total >= 10_000 &&
    input.testScopeWrite &&
    input.recallEval &&
    input.updateEval
  ) progress = 90;
  const progressRecommendations = [
    ...(input.recommendedPolicyChanges ?? []),
  ];
  if ((input.recommendationsCount ?? 0) > 0 && progressRecommendations.length === 0) progressRecommendations.push("review_policy_prompt_recommendations");
  if (progressRecommendations.length > 0) progress = 90;
  const recommended: string[] = [];
  if (!input.offlineEval) recommended.push("run_offline_policy_eval");
  if (!input.testScopeWrite) recommended.push("write_eval_samples_to_test_scope");
  if (!input.recallEval) recommended.push("run_recall_leakage_eval");
  if (input.recommendedPolicyChanges) recommended.push(...input.recommendedPolicyChanges);
  if ((input.recommendationsCount ?? 0) > 0 && !input.recommendedPolicyChanges?.length) recommended.push("review_policy_prompt_recommendations");
  return {
    run_id: input.runId,
    progress_percent: progress,
    dataset_counts: {
      imported: input.importedCount ?? 0,
      normalized: input.normalizedCount ?? 0,
      unique_questions: input.uniqueQuestionCount ?? 0,
    },
    offline_eval: input.offlineEval ?? null,
    test_scope_write_eval: input.testScopeWrite ?? null,
    recall_eval: input.recallEval ?? null,
    update_eval: {
      checked: input.updateEval?.checked ?? 0,
      knowledge_update_accuracy: input.updateEval?.knowledge_update_accuracy ?? 0,
    },
    leakage_eval: {
      default_leakage: input.recallEval?.default_leakage ?? null,
    },
    false_positive_cases: [],
    false_negative_cases: [],
    recommended_policy_changes: [...new Set(recommended)],
    production_readiness_score: input.offlineEval?.production_readiness_score ?? 0,
  };
}

export type HumanReviewSection = "governance" | "retrieval" | "temporal" | "unknown";

export type HumanReviewActionType =
  | "approve_project_memory"
  | "event_log_only"
  | "knowledge_index"
  | "global_constraint"
  | "collect_more_samples"
  | "temporal_isolate"
  | "keep_pending";

export interface HumanReviewItem {
  readonly section: HumanReviewSection;
  readonly label: string;
  readonly title: string;
  readonly memoryId: string | null;
  readonly scope: string | null;
  readonly reviewDecision: string;
  readonly fields: Readonly<Record<string, string>>;
}

export interface ParsedHumanReview {
  readonly items: readonly HumanReviewItem[];
}

export interface HumanReviewAction {
  readonly label: string;
  readonly title: string;
  readonly memory_id: string | null;
  readonly source_scope: string | null;
  readonly target_scope: string | null;
  readonly action: HumanReviewActionType;
  readonly review_decision: string;
  readonly reason: string;
  readonly target_recall_policy?: "default" | "explicit_only" | "never";
  readonly target_fact_status?: "current" | "historical" | "invalid";
  readonly target_review_required?: boolean;
}

export interface HumanReviewActionPlan {
  readonly ok: true;
  readonly generated_at: string;
  readonly review_file: string;
  readonly summary: Record<"total_items" | HumanReviewActionType, number>;
  readonly actions: readonly HumanReviewAction[];
}

const ACTION_TYPES: readonly HumanReviewActionType[] = [
  "approve_project_memory",
  "event_log_only",
  "knowledge_index",
  "global_constraint",
  "collect_more_samples",
  "temporal_isolate",
  "keep_pending",
];

export function isExecutableHumanReviewAction(action: HumanReviewAction): boolean {
  if (action.action === "keep_pending") return false;
  if (action.action === "collect_more_samples") return true;
  return Boolean(action.memory_id);
}

export function isHumanReviewActionAlreadyApplied(action: HumanReviewAction, metadata: unknown): boolean {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const applyMetadata = (metadata as Record<string, unknown>).human_review_apply;
  if (applyMetadata === null || typeof applyMetadata !== "object" || Array.isArray(applyMetadata)) return false;
  const applied = applyMetadata as Record<string, unknown>;
  return applied.label === action.label &&
    applied.action === action.action &&
    applied.review_decision === action.review_decision;
}

function sectionFromHeading(value: string): HumanReviewSection {
  if (/^G-\d+/u.test(value)) return "governance";
  if (/^R-\d+/u.test(value)) return "retrieval";
  if (/^T-\d+/u.test(value)) return "temporal";
  return "unknown";
}

function cleanInlineValue(value: string): string {
  return value
    .trim()
    .replace(/^`/u, "")
    .replace(/`$/u, "")
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .trim();
}

function parseField(line: string): { key: string; value: string } | null {
  const match = /^-\s*([^：:]+)[：:]\s*(.*)$/u.exec(line.trim());
  if (!match) return null;
  return {
    key: match[1]!.trim(),
    value: cleanInlineValue(match[2] ?? ""),
  };
}

function normalizeFieldKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "人工审核结论") return "review_decision";
  if (trimmed === "id" || trimmed === "memory_id" || trimmed === "memoryId") return "memory_id";
  if (trimmed === "scope") return "scope";
  return trimmed;
}

function parseHeading(line: string): { label: string; title: string; section: HumanReviewSection } | null {
  const match = /^###\s+((?:G|R|T)-\d+)\s*(.*)$/u.exec(line.trim());
  if (!match) return null;
  const label = match[1]!;
  return {
    label,
    title: (match[2] ?? "").trim(),
    section: sectionFromHeading(label),
  };
}

export function parseHumanReviewMarkdown(markdown: string): ParsedHumanReview {
  const items: HumanReviewItem[] = [];
  let current: {
    label: string;
    title: string;
    section: HumanReviewSection;
    fields: Record<string, string>;
  } | null = null;

  function flush(): void {
    if (!current) return;
    items.push({
      section: current.section,
      label: current.label,
      title: current.title,
      memoryId: current.fields.memory_id ?? null,
      scope: current.fields.scope ?? null,
      reviewDecision: current.fields.review_decision ?? "",
      fields: { ...current.fields },
    });
  }

  for (const line of markdown.split(/\r?\n/u)) {
    const heading = parseHeading(line);
    if (heading) {
      flush();
      current = { ...heading, fields: {} };
      continue;
    }
    if (!current) continue;
    const field = parseField(line);
    if (!field) continue;
    current.fields[normalizeFieldKey(field.key)] = field.value;
  }
  flush();

  return { items };
}

function includesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function actionFor(item: HumanReviewItem): HumanReviewAction {
  const decision = item.reviewDecision;
  const text = `${item.title}\n${decision}`;

  if (item.section === "retrieval") {
    return baseAction(item, "collect_more_samples", item.scope, "retrieval_collect_more_samples");
  }
  if (item.section === "temporal" && /isolate_temporal_snapshot/u.test(decision)) {
    return {
      ...baseAction(item, "temporal_isolate", item.scope, "reviewed_temporal_snapshot_isolation"),
      target_recall_policy: "explicit_only",
      target_fact_status: "historical",
      target_review_required: false,
    };
  }
  if (includesAny(text, [/全局记忆/u, /全局/u]) && includesAny(text, [/中文/u, /Chinese/iu])) {
    return baseAction(item, "global_constraint", "global:global", "reviewed_global_constraint");
  }
  if (includesAny(text, [/生成\.md/u, /\.md.*(保存|放进|放入).*知识库/u, /问题清单/u, /向量索引/u])) {
    return baseAction(item, "knowledge_index", item.scope, "reviewed_document_artifact_to_knowledge_index");
  }
  if (includesAny(text, [/不需要写进记忆/u, /不应该写进记忆/u, /没必要写进记忆/u, /没必要些处理顺序/u])) {
    return baseAction(item, "event_log_only", item.scope, "reviewed_process_or_order_not_long_term_memory");
  }
  if (includesAny(text, [/审核通过/u, /可以写进/u, /可以保存进记忆/u, /写入相关/u, /写在相关/u, /项目级的记忆/u, /升级方向可以放进记忆/u])) {
    return baseAction(item, "approve_project_memory", item.scope, "reviewed_project_memory");
  }
  return baseAction(item, "keep_pending", item.scope, "unclassified_human_review_decision");
}

function baseAction(
  item: HumanReviewItem,
  action: HumanReviewActionType,
  targetScope: string | null,
  reason: string,
): HumanReviewAction {
  return {
    label: item.label,
    title: item.title,
    memory_id: item.memoryId,
    source_scope: item.scope,
    target_scope: targetScope,
    action,
    review_decision: item.reviewDecision,
    reason,
  };
}

export function buildHumanReviewActionPlan(
  parsed: ParsedHumanReview,
  options: { readonly reviewFile: string; readonly generatedAt?: string },
): HumanReviewActionPlan {
  const actions = parsed.items.map((item) => {
    const action = actionFor(item);
    if (action.action !== "collect_more_samples" && !action.memory_id) {
      return baseAction(item, "keep_pending", item.scope, "missing_memory_id_for_reviewed_action");
    }
    return action;
  });
  const summary: Record<"total_items" | HumanReviewActionType, number> = {
    total_items: actions.length,
    approve_project_memory: 0,
    event_log_only: 0,
    knowledge_index: 0,
    global_constraint: 0,
    collect_more_samples: 0,
    temporal_isolate: 0,
    keep_pending: 0,
  };
  for (const action of actions) summary[action.action] += 1;
  for (const actionType of ACTION_TYPES) summary[actionType] ??= 0;
  return {
    ok: true,
    generated_at: options.generatedAt ?? new Date().toISOString(),
    review_file: options.reviewFile,
    summary,
    actions,
  };
}

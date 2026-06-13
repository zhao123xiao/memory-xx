import {
  isTemporalMemoryRelationType,
  type TemporalMemoryRelationType,
} from "../shared/memory-relation-types";

export interface MemoryLinkCandidateRow {
  readonly id: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly title: string | null;
  readonly content: string;
  readonly memory_type: string | null;
  readonly memory_class: string | null;
  readonly cognitive_type: string | null;
  readonly recall_policy: string | null;
  readonly lifecycle_status: string;
  readonly review_state: string;
  readonly is_current: boolean;
  readonly topic: string | null;
  readonly updated_at: string | null;
}

export interface ExistingMemoryRelationRow {
  readonly memory_id: string;
  readonly related_memory_id: string;
  readonly relation_type: string;
}

export interface MemoryLinkCandidate {
  readonly candidate_type: "memory_link_candidate";
  readonly candidate_id: string;
  readonly memory_id: string;
  readonly related_memory_id: string;
  readonly relation_type: TemporalMemoryRelationType;
  readonly scope: string;
  readonly topic: string | null;
  readonly confidence: number;
  readonly suggested_action: "review_memory_link";
  readonly apply_allowed: false;
  readonly blockers: readonly ["report_only", "requires_human_review"];
  readonly evidence: {
    readonly source_kind: string;
    readonly target_kind: string;
    readonly shared_terms: readonly string[];
    readonly report_only: true;
  };
}

export interface MemoryLinkCandidateReport {
  readonly ok: true;
  readonly generated_at: string;
  readonly report_only: true;
  readonly apply_allowed: false;
  readonly summary: {
    readonly total_rows: number;
    readonly total_candidates: number;
    readonly by_relation_type: Partial<Record<TemporalMemoryRelationType, number>>;
    readonly report_only: true;
  };
  readonly candidates: readonly MemoryLinkCandidate[];
}

export interface BuildMemoryLinkCandidateReportInput {
  readonly generatedAt?: string;
  readonly rows: readonly MemoryLinkCandidateRow[];
  readonly existingRelations: readonly ExistingMemoryRelationRow[];
  readonly maxCandidatesPerTopic?: number;
}

type MemoryKind = "issue" | "fix" | "test" | "procedure" | "other";

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function textOf(row: MemoryLinkCandidateRow): string {
  return `${row.title ?? ""}\n${row.content}`.trim();
}

function isApprovedCurrent(row: MemoryLinkCandidateRow): boolean {
  return row.is_current &&
    normalize(row.lifecycle_status) === "approved" &&
    ["approved", "not_required"].includes(normalize(row.review_state));
}

function kindOf(row: MemoryLinkCandidateRow): MemoryKind {
  const text = textOf(row);
  const memoryType = normalize(row.memory_type);
  const memoryClass = normalize(row.memory_class);
  const cognitiveType = normalize(row.cognitive_type);
  if (cognitiveType === "procedural" || memoryType === "procedure" || memoryClass === "procedure") return "procedure";
  if (memoryClass === "test_evidence" || /(?:验证通过|test|tests?|exit 0|passed|通过)/iu.test(text)) return "test";
  if (/(?:修复|解决|设置|workaround|fix|fixed|resolve|resolved|TMPDIR=\/tmp)/iu.test(text)) return "fix";
  if (memoryClass === "operational_issue" || /(?:失败|报错|故障|问题|不兼容|error|failed|failure|bug|regression)/iu.test(text)) return "issue";
  return "other";
}

function relationFor(source: MemoryKind, target: MemoryKind): TemporalMemoryRelationType | null {
  if (source === "issue" && target === "fix") return "same_issue_as";
  if (source === "fix" && target === "issue") return "same_issue_as";
  if (source === "test" && target === "fix") return "caused_by";
  if (source === "fix" && target === "test") return "supports";
  if (source === "procedure" && target === "issue") return "derived_procedure_from";
  return null;
}

function tokenSet(row: MemoryLinkCandidateRow): Set<string> {
  const text = textOf(row).toLowerCase();
  const tokens = text.match(/[a-z0-9_/-]{3,}|[\u4e00-\u9fff]{2,}/giu) ?? [];
  return new Set(tokens.map((token) => token.toLowerCase()));
}

function sharedTerms(left: MemoryLinkCandidateRow, right: MemoryLinkCandidateRow): string[] {
  const rightTokens = tokenSet(right);
  return [...tokenSet(left)]
    .filter((token) => rightTokens.has(token))
    .filter((token) => !["the", "and", "with", "memory", "tests"].includes(token))
    .sort()
    .slice(0, 8);
}

function stablePart(value: string): string {
  return value.replace(/[^a-z0-9_-]+/giu, "-").replace(/^-+|-+$/gu, "").toLowerCase();
}

function relationKey(memoryId: string, relatedMemoryId: string, relationType: string): string {
  return `${memoryId}\u0000${relatedMemoryId}\u0000${relationType}`;
}

function unorderedRelationKey(memoryId: string, relatedMemoryId: string, relationType: string): string {
  const [left, right] = [memoryId, relatedMemoryId].sort();
  return `${left}\u0000${right}\u0000${relationType}`;
}

function relationExists(
  existing: ReadonlySet<string>,
  memoryId: string,
  relatedMemoryId: string,
  relationType: TemporalMemoryRelationType,
): boolean {
  return existing.has(relationKey(memoryId, relatedMemoryId, relationType)) ||
    existing.has(relationKey(relatedMemoryId, memoryId, relationType));
}

function increment<TKey extends string>(target: Partial<Record<TKey, number>>, key: TKey): void {
  target[key] = (target[key] ?? 0) + 1;
}

function topicKey(row: MemoryLinkCandidateRow): string {
  return `${row.scope_type}:${row.scope_id}:${normalize(row.topic) || "topic:unknown"}`;
}

function confidenceFor(relationType: TemporalMemoryRelationType, terms: readonly string[]): number {
  const base = relationType === "derived_procedure_from" ? 0.78 : 0.74;
  return Math.min(0.95, base + Math.min(terms.length, 4) * 0.04);
}

function dedupeCandidateKey(candidate: MemoryLinkCandidate): string {
  return `${candidate.memory_id}\u0000${candidate.relation_type}`;
}

function bestPerSourceRelation(candidates: readonly MemoryLinkCandidate[]): MemoryLinkCandidate[] {
  const best = new Map<string, MemoryLinkCandidate>();
  for (const candidate of candidates) {
    const key = dedupeCandidateKey(candidate);
    const current = best.get(key);
    if (!current ||
        candidate.confidence > current.confidence ||
        (candidate.confidence === current.confidence && candidate.related_memory_id.localeCompare(current.related_memory_id) < 0)) {
      best.set(key, candidate);
    }
  }
  return [...best.values()];
}

function dedupeSymmetricRelations(candidates: readonly MemoryLinkCandidate[]): MemoryLinkCandidate[] {
  const best = new Map<string, MemoryLinkCandidate>();
  for (const candidate of candidates) {
    const key = candidate.relation_type === "same_issue_as"
      ? unorderedRelationKey(candidate.memory_id, candidate.related_memory_id, candidate.relation_type)
      : `${candidate.memory_id}\u0000${candidate.related_memory_id}\u0000${candidate.relation_type}`;
    const current = best.get(key);
    const candidatePreferredIssueSource = candidate.relation_type === "same_issue_as" && candidate.evidence.source_kind === "issue";
    const currentPreferredIssueSource = current?.relation_type === "same_issue_as" && current.evidence.source_kind === "issue";
    if (!current ||
        (candidatePreferredIssueSource && !currentPreferredIssueSource) ||
        (!currentPreferredIssueSource && candidate.confidence > current.confidence) ||
        (!currentPreferredIssueSource && candidate.confidence === current.confidence && candidate.memory_id.localeCompare(current.memory_id) < 0)) {
      best.set(key, candidate);
    }
  }
  return [...best.values()];
}

export function buildMemoryLinkCandidateReport(input: BuildMemoryLinkCandidateReportInput): MemoryLinkCandidateReport {
  const maxCandidatesPerTopic = input.maxCandidatesPerTopic ?? 50;
  const existing = new Set(input.existingRelations.map((relation) =>
    relationKey(relation.memory_id, relation.related_memory_id, relation.relation_type)
  ));
  const grouped = new Map<string, MemoryLinkCandidateRow[]>();
  for (const row of input.rows.filter(isApprovedCurrent)) {
    const rows = grouped.get(topicKey(row)) ?? [];
    rows.push(row);
    grouped.set(topicKey(row), rows);
  }

  const candidates: MemoryLinkCandidate[] = [];
  for (const rows of grouped.values()) {
    const topicCandidates: MemoryLinkCandidate[] = [];
    for (const source of rows) {
      for (const target of rows) {
        if (source.id === target.id) continue;
        const sourceKind = kindOf(source);
        const targetKind = kindOf(target);
        const relationType = relationFor(sourceKind, targetKind);
        if (!relationType || !isTemporalMemoryRelationType(relationType)) continue;
        if (relationExists(existing, source.id, target.id, relationType)) continue;
        const terms = sharedTerms(source, target);
        if (terms.length === 0 && normalize(source.topic) === "topic:unknown") continue;
        topicCandidates.push({
          candidate_type: "memory_link_candidate",
          candidate_id: stablePart(["memory-link", relationType, source.id, target.id].join(":")),
          memory_id: source.id,
          related_memory_id: target.id,
          relation_type: relationType,
          scope: `${source.scope_type}:${source.scope_id}`,
          topic: source.topic,
          confidence: confidenceFor(relationType, terms),
          suggested_action: "review_memory_link",
          apply_allowed: false,
          blockers: ["report_only", "requires_human_review"],
          evidence: {
            source_kind: sourceKind,
            target_kind: targetKind,
            shared_terms: terms,
            report_only: true,
          },
        });
      }
    }
    candidates.push(...dedupeSymmetricRelations(bestPerSourceRelation(topicCandidates))
      .sort((left, right) =>
        right.confidence - left.confidence ||
        left.relation_type.localeCompare(right.relation_type) ||
        left.memory_id.localeCompare(right.memory_id) ||
        left.related_memory_id.localeCompare(right.related_memory_id)
      )
      .slice(0, maxCandidatesPerTopic));
  }

  const byRelationType: Partial<Record<TemporalMemoryRelationType, number>> = {};
  for (const candidate of candidates) increment(byRelationType, candidate.relation_type);
  const sorted = candidates.sort((left, right) =>
    left.relation_type.localeCompare(right.relation_type) ||
    left.memory_id.localeCompare(right.memory_id) ||
    left.related_memory_id.localeCompare(right.related_memory_id)
  );

  return {
    ok: true,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    report_only: true,
    apply_allowed: false,
    summary: {
      total_rows: input.rows.length,
      total_candidates: sorted.length,
      by_relation_type: byRelationType,
      report_only: true,
    },
    candidates: sorted,
  };
}

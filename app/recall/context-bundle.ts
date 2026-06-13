import { createHash } from "node:crypto";

import { ScopeType } from "../shared";
import { inferCognitiveType, type CognitiveType } from "../shared/cognitive-type";
import { isTemporalMemoryRelationType } from "../shared/memory-relation-types";
import {
  QueryType,
  type RecallContextBundle,
  type RecallContextBundleLayer,
  type RecallContextBundleAudit,
  type RecallContextBundleBudget,
  type RecallContextBundleItem,
  type RecallResultItem,
  type RecallContextPromptRender,
  type GraphPathSegment,
  type GraphRelationEvidence,
} from "./types";

export { inferCognitiveType, type CognitiveType };

export interface BuildRecallContextBundleInput {
  readonly queryType: QueryType;
  readonly results: readonly RecallResultItem[];
  readonly tokenBudget?: RecallContextBundleBudget;
}

export interface RecallContextBundleContract {
  readonly requested_mode: false | "summary" | "full" | undefined;
  readonly mode: "disabled" | "summary" | "full";
  readonly tokenBudget?: RecallContextBundleBudget;
}

export interface RecallContextBundleCacheContractInput {
  readonly query: string;
  readonly queryType: QueryType;
  readonly allowedScopes: readonly { readonly type: ScopeType | string; readonly id: string }[];
  readonly policyVersion: string;
  readonly mode: "disabled" | "summary" | "full";
  readonly tokenBudget?: RecallContextBundleBudget;
  readonly recallPolicy?: string;
  readonly filterMode?: string;
  readonly generation?: string;
}

export interface RecallContextBundleCacheContract {
  readonly version: "context-bundle-cache-contract-v1";
  readonly enabled: false;
  readonly cache_scope: "session_local";
  readonly cache_key: string;
  readonly query_fingerprint: string;
  readonly query_type: QueryType;
  readonly allowed_scope_keys: readonly string[];
  readonly policy_version: string;
  readonly mode: "disabled" | "summary" | "full";
  readonly budget_fingerprint: string;
  readonly recall_policy: string;
  readonly filter_mode: string;
  readonly generation: string;
  readonly invalidation_rules: readonly string[];
}

export type RecallContextPagingContractFindingReason =
  | "token_budget_total_mismatch"
  | "layer_over_budget"
  | "resident_layer_marked_expandable"
  | "expandable_layer_marked_resident"
  | "resident_item_in_expandable_layer"
  | "tool_expand_item_in_resident_layer"
  | "non_recallable_item_in_resident_layer"
  | "truncated_items_visible";

export interface RecallContextPagingContractFinding {
  readonly severity: "violation" | "warning";
  readonly reason: RecallContextPagingContractFindingReason;
  readonly layer_id?: RecallContextBundleLayer["id"];
  readonly memory_id?: string;
  readonly detail: string;
}

export interface RecallContextPagingContractAudit {
  readonly ok: boolean;
  readonly report_only: true;
  readonly summary: {
    readonly layers: number;
    readonly resident_layers: number;
    readonly expandable_layers: number;
    readonly resident_items: number;
    readonly expandable_items: number;
    readonly truncated_items: number;
    readonly violations: number;
    readonly warnings: number;
  };
  readonly violations: readonly RecallContextPagingContractFinding[];
  readonly warnings: readonly RecallContextPagingContractFinding[];
}

const DEFAULT_BUDGET = {
  l0_always_resident: 320,
  l1_pinned_scope_facts: 900,
  l2_query_working_set: 1800,
  l3_expandable_deep_memory: 2400,
} as const;

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function hashJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 32);
}

function normalizeQueryForFingerprint(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function normalizedBudget(input: RecallContextBundleBudget | undefined): RecallContextBundle["token_budget"] {
  return budget(input);
}

function scopeKey(scope: { readonly type: ScopeType | string; readonly id: string }): string {
  return `${String(scope.type).trim().toLowerCase()}:${scope.id.trim()}`;
}

export function buildRecallContextBundleCacheContract(
  input: RecallContextBundleCacheContractInput,
): RecallContextBundleCacheContract {
  const allowedScopeKeys = [...new Set(input.allowedScopes.map(scopeKey).filter((item) => item !== ":"))].sort();
  const budgetValue = normalizedBudget(input.tokenBudget);
  const queryFingerprint = hashJson({
    query: normalizeQueryForFingerprint(input.query),
  });
  const budgetFingerprint = hashJson(budgetValue);
  const recallPolicy = input.recallPolicy?.trim() || "default";
  const filterMode = input.filterMode?.trim() || "default";
  const generation = input.generation?.trim() || "unknown";
  const keyPayload = {
    version: "context-bundle-cache-contract-v1",
    query_fingerprint: queryFingerprint,
    query_type: input.queryType,
    allowed_scope_keys: allowedScopeKeys,
    policy_version: input.policyVersion,
    mode: input.mode,
    budget_fingerprint: budgetFingerprint,
    recall_policy: recallPolicy,
    filter_mode: filterMode,
    generation,
  };
  return {
    version: "context-bundle-cache-contract-v1",
    enabled: false,
    cache_scope: "session_local",
    cache_key: `context-bundle:${hashJson(keyPayload)}`,
    query_fingerprint: queryFingerprint,
    query_type: input.queryType,
    allowed_scope_keys: allowedScopeKeys,
    policy_version: input.policyVersion,
    mode: input.mode,
    budget_fingerprint: budgetFingerprint,
    recall_policy: recallPolicy,
    filter_mode: filterMode,
    generation,
    invalidation_rules: [
      "allowed_scope_set_change",
      "context_bundle_budget_change",
      "context_bundle_mode_change",
      "filter_mode_change",
      "memory_scope_generation_change",
      "policy_version_change",
      "query_fingerprint_change",
      "query_type_change",
      "recall_policy_change",
    ],
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function budget(input: RecallContextBundleBudget | undefined): RecallContextBundle["token_budget"] {
  const l0 = input?.l0AlwaysResident ?? DEFAULT_BUDGET.l0_always_resident;
  const l1 = input?.l1PinnedScopeFacts ?? DEFAULT_BUDGET.l1_pinned_scope_facts;
  const l2 = input?.l2QueryWorkingSet ?? DEFAULT_BUDGET.l2_query_working_set;
  const l3 = input?.l3ExpandableDeepMemory ?? DEFAULT_BUDGET.l3_expandable_deep_memory;
  return {
    total: l0 + l1 + l2 + l3,
    l0_always_resident: l0,
    l1_pinned_scope_facts: l1,
    l2_query_working_set: l2,
    l3_expandable_deep_memory: l3,
  };
}

export function resolveRecallContextBundleContract(input: {
  readonly mode?: false | "summary" | "full";
  readonly tokenBudget?: RecallContextBundleBudget;
}): RecallContextBundleContract {
  return {
    requested_mode: input.mode,
    mode: input.mode === false ? "disabled" : input.mode ?? "full",
    tokenBudget: input.tokenBudget,
  };
}

function toBundleItem(
  result: RecallResultItem,
  cognitiveType: CognitiveType,
  resident: boolean,
  inclusionPolicy: RecallContextBundleItem["inclusion_policy"],
  overrides: Partial<Pick<RecallContextBundleItem, "content" | "temporal_chain">> = {},
): RecallContextBundleItem {
  const content = overrides.content ?? result.content;
  return {
    memory_id: result.memory_id,
    title: result.title,
    content,
    scope: result.scope,
    score: result.final_score ?? result.rerank_score ?? result.score,
    cognitive_type: cognitiveType,
    memory_type: result.memory_type,
    memory_layer: result.memory_layer,
    recall_policy: result.recall_policy,
    source_retrievers: result.source_retrievers,
    estimated_tokens: estimateTokens(`${result.title ?? ""}\n${content}`),
    resident,
    inclusion_policy: inclusionPolicy,
    ...(overrides.temporal_chain ? { temporal_chain: overrides.temporal_chain } : {}),
  };
}

function temporalRelationEvidence(result: RecallResultItem): GraphRelationEvidence[] {
  const relationEvidence = result.graph_relation_evidence ?? [];
  const relationTypes = result.graph_relations ?? [];
  return relationEvidence.filter((relation) => isTemporalMemoryRelationType(relation.relation_type))
    .concat(
      relationTypes
        .filter(isTemporalMemoryRelationType)
        .filter((relationType) => !relationEvidence.some((relation) => relation.relation_type === relationType))
        .map((relationType, index) => ({
          id: `graph-relation:${result.memory_id}:${relationType}:${index}`,
          relation_type: relationType,
          source_memory_id: result.memory_id,
          target_memory_id: result.memory_id,
          match_reason: "relation_path" as const,
        }))
    );
}

function temporalPathEvidence(result: RecallResultItem, relations: readonly GraphRelationEvidence[]): GraphPathSegment[] {
  const paths = (result.graph_path_evidence ?? []).filter((path) => isTemporalMemoryRelationType(path.relation_type));
  if (paths.length > 0) return paths;
  return relations.map((relation) => ({
    from: relation.source_memory_id,
    to: relation.target_memory_id,
    relation_type: relation.relation_type,
    evidence: relation.match_reason,
  }));
}

function temporalChainItem(result: RecallResultItem, cognitiveType: CognitiveType): RecallContextBundleItem | null {
  const relations = temporalRelationEvidence(result);
  if (relations.length === 0) return null;
  const paths = temporalPathEvidence(result, relations);
  const relationTypes = [...new Set(relations.map((relation) => relation.relation_type))];
  const summary = [
    `Temporal graph chain for ${result.memory_id}.`,
    `relations=${relationTypes.join(",")}`,
    paths.length > 0
      ? `paths=${paths.map((path) => `${path.from} -${path.relation_type}-> ${path.to}`).join("; ")}`
      : "",
  ].filter(Boolean).join(" ");
  return toBundleItem(result, cognitiveType, false, "tool_expand_only", {
    content: summary,
    temporal_chain: {
      relations,
      paths,
      relation_types: relationTypes,
    },
  });
}

function layer(
  id: RecallContextBundleLayer["id"],
  label: string,
  tokenBudget: number,
  resident: boolean,
  invalidationRules: readonly string[],
): RecallContextBundleLayer {
  return {
    id,
    label,
    token_budget: tokenBudget,
    used_tokens: 0,
    resident,
    invalidation_rules: invalidationRules,
    items: [],
  };
}

function pushWithinBudget(layerValue: RecallContextBundleLayer, item: RecallContextBundleItem): RecallContextBundleLayer {
  if (layerValue.used_tokens + item.estimated_tokens > layerValue.token_budget) {
    return layerValue;
  }
  return {
    ...layerValue,
    used_tokens: layerValue.used_tokens + item.estimated_tokens,
    items: [...layerValue.items, item],
  };
}

function isCoreResident(result: RecallResultItem, cognitiveType: CognitiveType): boolean {
  return (
    cognitiveType === "semantic" &&
    result.scope.type === ScopeType.User &&
    (normalize(result.memory_layer) === "core" || normalize(result.memory_type) === "preference")
  );
}

function isPinnedScopeFact(result: RecallResultItem, cognitiveType: CognitiveType): boolean {
  return (
    cognitiveType === "semantic" &&
    result.scope.type !== ScopeType.Run &&
    result.scope.type !== ScopeType.Task &&
    normalize(result.recall_policy) !== "explicit_only"
  );
}

function includeEpisodicInWorkingSet(queryType: QueryType): boolean {
  return [
    QueryType.TimelineHistory,
    QueryType.HistoricalQuery,
    QueryType.EpisodeLookup,
    QueryType.DebugRecall,
    QueryType.DebugAuditQuery,
  ].includes(queryType);
}

export function buildRecallContextBundle(input: BuildRecallContextBundleInput): RecallContextBundle {
  const tokenBudget = budget(input.tokenBudget);
  let l0 = layer("l0_always_resident", "L0 always-resident identity and hard constraints", tokenBudget.l0_always_resident, true, [
    "policy_version_change",
    "user_scope_change",
  ]);
  let l1 = layer("l1_pinned_scope_facts", "L1 pinned durable scope facts", tokenBudget.l1_pinned_scope_facts, true, [
    "scope_set_change",
    "memory_write_or_supersede",
    "policy_version_change",
  ]);
  let l2 = layer("l2_query_working_set", "L2 query working set", tokenBudget.l2_query_working_set, true, [
    "query_change",
    "turn_change",
    "negative_recall_feedback",
  ]);
  let l3 = layer("l3_expandable_deep_memory", "L3 expandable deep memory", tokenBudget.l3_expandable_deep_memory, false, [
    "explicit_tool_expand",
    "scope_set_change",
    "policy_version_change",
  ]);

  let truncated = 0;
  for (const result of input.results) {
    const cognitiveType = result.cognitive_type ?? inferCognitiveType({
      memory_type: result.memory_type,
      memory_layer: result.memory_layer,
      recall_policy: result.recall_policy,
    });

    const beforeCounts = l0.items.length + l1.items.length + l2.items.length + l3.items.length;
    const temporalItem = temporalChainItem(result, cognitiveType);

    if (cognitiveType === "audit") {
      l3 = pushWithinBudget(l3, toBundleItem(result, cognitiveType, false, "tool_expand_only"));
    } else if (isCoreResident(result, cognitiveType)) {
      l0 = pushWithinBudget(l0, toBundleItem(result, cognitiveType, true, "always"));
    } else if (isPinnedScopeFact(result, cognitiveType)) {
      l1 = pushWithinBudget(l1, toBundleItem(result, cognitiveType, true, "pinned"));
    } else if (cognitiveType === "procedural" || (cognitiveType === "episodic" && includeEpisodicInWorkingSet(input.queryType))) {
      l2 = pushWithinBudget(l2, toBundleItem(result, cognitiveType, true, "query_working_set"));
    } else {
      l3 = pushWithinBudget(l3, toBundleItem(result, cognitiveType, false, "tool_expand_only"));
    }
    if (temporalItem) {
      l3 = pushWithinBudget(l3, temporalItem);
    }
    const afterCounts = l0.items.length + l1.items.length + l2.items.length + l3.items.length;
    if (afterCounts === beforeCounts) truncated += 1;
  }

  const bundle: RecallContextBundle = {
    version: "context-bundle-v1",
    token_budget: tokenBudget,
    layers: {
      l0_always_resident: l0,
      l1_pinned_scope_facts: l1,
      l2_query_working_set: l2,
      l3_expandable_deep_memory: l3,
    },
    audit: {
      total_input_items: input.results.length,
      resident_items: l0.items.length + l1.items.length + l2.items.length,
      expandable_items: l3.items.length,
      truncated_items: truncated,
      redacted_items: 0,
    },
  };
  return {
    ...bundle,
    audit: {
      ...bundle.audit,
      paging_contract: auditRecallContextPagingContract(bundle),
    },
  };
}

export function summarizeRecallContextBundle(bundle: RecallContextBundle): RecallContextBundle {
  const redactLayer = (layerValue: RecallContextBundleLayer): RecallContextBundleLayer => ({
    ...layerValue,
    items: [],
  });
  const redactedItems =
    bundle.layers.l0_always_resident.items.length +
    bundle.layers.l1_pinned_scope_facts.items.length +
    bundle.layers.l2_query_working_set.items.length +
    bundle.layers.l3_expandable_deep_memory.items.length;

  return {
    ...bundle,
    layers: {
      l0_always_resident: redactLayer(bundle.layers.l0_always_resident),
      l1_pinned_scope_facts: redactLayer(bundle.layers.l1_pinned_scope_facts),
      l2_query_working_set: redactLayer(bundle.layers.l2_query_working_set),
      l3_expandable_deep_memory: redactLayer(bundle.layers.l3_expandable_deep_memory),
    },
    audit: {
      ...bundle.audit,
      redacted_items: redactedItems,
    },
  };
}

export function buildRecallContextBundleAudit(input: {
  readonly contract: RecallContextBundleContract;
  readonly bundle?: RecallContextBundle;
  readonly totalInputItems: number;
}): RecallContextBundleAudit {
  const appliedBudgets = input.bundle?.token_budget ?? budget(input.contract.tokenBudget);
  return {
    requested_mode: input.contract.requested_mode,
    mode: input.contract.mode,
    requested_budgets: input.contract.tokenBudget ?? {},
    applied_budgets: appliedBudgets,
    total_input_items: input.bundle?.audit.total_input_items ?? input.totalInputItems,
    resident_items: input.bundle?.audit.resident_items ?? 0,
    expandable_items: input.bundle?.audit.expandable_items ?? 0,
    truncated_items: input.bundle?.audit.truncated_items ?? 0,
    redacted_items: input.bundle?.audit.redacted_items ?? 0,
  };
}

function expectedTotalBudget(bundle: RecallContextBundle): number {
  return bundle.token_budget.l0_always_resident +
    bundle.token_budget.l1_pinned_scope_facts +
    bundle.token_budget.l2_query_working_set +
    bundle.token_budget.l3_expandable_deep_memory;
}

function contextLayers(bundle: RecallContextBundle): readonly RecallContextBundleLayer[] {
  return [
    bundle.layers.l0_always_resident,
    bundle.layers.l1_pinned_scope_facts,
    bundle.layers.l2_query_working_set,
    bundle.layers.l3_expandable_deep_memory,
  ];
}

function finding(input: {
  readonly severity: "violation" | "warning";
  readonly reason: RecallContextPagingContractFindingReason;
  readonly layer_id?: RecallContextBundleLayer["id"];
  readonly memory_id?: string;
  readonly detail: string;
}): RecallContextPagingContractFinding {
  return input;
}

export function auditRecallContextPagingContract(bundle: RecallContextBundle): RecallContextPagingContractAudit {
  const violations: RecallContextPagingContractFinding[] = [];
  const warnings: RecallContextPagingContractFinding[] = [];
  const layers = contextLayers(bundle);
  const residentLayerIds = new Set<RecallContextBundleLayer["id"]>([
    "l0_always_resident",
    "l1_pinned_scope_facts",
    "l2_query_working_set",
  ]);

  const expectedTotal = expectedTotalBudget(bundle);
  if (bundle.token_budget.total !== expectedTotal) {
    violations.push(finding({
      severity: "violation",
      reason: "token_budget_total_mismatch",
      detail: `token_budget.total=${bundle.token_budget.total} expected=${expectedTotal}`,
    }));
  }

  for (const layerValue of layers) {
    const residentLayer = residentLayerIds.has(layerValue.id);
    if (layerValue.used_tokens > layerValue.token_budget) {
      violations.push(finding({
        severity: "violation",
        reason: "layer_over_budget",
        layer_id: layerValue.id,
        detail: `used_tokens=${layerValue.used_tokens} token_budget=${layerValue.token_budget}`,
      }));
    }
    if (residentLayer && !layerValue.resident) {
      violations.push(finding({
        severity: "violation",
        reason: "resident_layer_marked_expandable",
        layer_id: layerValue.id,
        detail: "resident L0-L2 layer must have resident=true",
      }));
    }
    if (!residentLayer && layerValue.resident) {
      violations.push(finding({
        severity: "violation",
        reason: "expandable_layer_marked_resident",
        layer_id: layerValue.id,
        detail: "L3 expandable deep memory must have resident=false",
      }));
    }
    for (const itemValue of layerValue.items) {
      if (!residentLayer && itemValue.resident) {
        violations.push(finding({
          severity: "violation",
          reason: "resident_item_in_expandable_layer",
          layer_id: layerValue.id,
          memory_id: itemValue.memory_id,
          detail: "L3 item must not be resident",
        }));
      }
      if (residentLayer && itemValue.inclusion_policy === "tool_expand_only") {
        violations.push(finding({
          severity: "violation",
          reason: "tool_expand_item_in_resident_layer",
          layer_id: layerValue.id,
          memory_id: itemValue.memory_id,
          detail: "tool_expand_only item cannot be injected into resident prompt layers",
        }));
      }
      if (residentLayer && (normalize(itemValue.recall_policy) === "never" || itemValue.cognitive_type === "audit")) {
        violations.push(finding({
          severity: "violation",
          reason: "non_recallable_item_in_resident_layer",
          layer_id: layerValue.id,
          memory_id: itemValue.memory_id,
          detail: "audit or recall_policy=never item cannot be resident context",
        }));
      }
    }
  }

  if (bundle.audit.truncated_items > 0) {
    warnings.push(finding({
      severity: "warning",
      reason: "truncated_items_visible",
      detail: `truncated_items=${bundle.audit.truncated_items}`,
    }));
  }

  const residentLayers = layers.filter((layerValue) => layerValue.resident).length;
  const expandableLayers = layers.length - residentLayers;
  return {
    ok: violations.length === 0,
    report_only: true,
    summary: {
      layers: layers.length,
      resident_layers: residentLayers,
      expandable_layers: expandableLayers,
      resident_items: bundle.audit.resident_items,
      expandable_items: bundle.audit.expandable_items,
      truncated_items: bundle.audit.truncated_items,
      violations: violations.length,
      warnings: warnings.length,
    },
    violations,
    warnings,
  };
}

function formatScope(item: RecallContextBundleItem): string {
  return `${item.scope.type}:${item.scope.id}`;
}

function formatResidentItem(item: RecallContextBundleItem): string {
  const title = item.title ? ` ${item.title}` : "";
  return [
    `- [${item.memory_id}]${title}`,
    `  scope=${formatScope(item)} cognitive_type=${item.cognitive_type} memory_type=${item.memory_type ?? "unknown"} score=${item.score.toFixed(4)}`,
    `  ${item.content}`,
  ].join("\n");
}

function formatExpandableReference(item: RecallContextBundleItem): string {
  const title = item.title ? ` title="${item.title}"` : "";
  const temporal = item.temporal_chain
    ? ` temporal_chain=${item.temporal_chain.relation_types.join(",")} paths=${item.temporal_chain.paths.map((path) => `${path.from} -${path.relation_type}-> ${path.to}`).join("; ")}`
    : "";
  return `- [${item.memory_id}]${title} scope=${formatScope(item)} cognitive_type=${item.cognitive_type} inclusion=${item.inclusion_policy} score=${item.score.toFixed(4)}${temporal}`;
}

function renderLayerSection(layerValue: RecallContextBundleLayer): string {
  if (layerValue.items.length === 0) {
    return `## ${layerValue.label}\n(no resident memories)`;
  }
  return `## ${layerValue.label}\n${layerValue.items.map(formatResidentItem).join("\n")}`;
}

export function renderRecallContextPrompt(bundle: RecallContextBundle): RecallContextPromptRender {
  const residentLayers = [
    bundle.layers.l0_always_resident,
    bundle.layers.l1_pinned_scope_facts,
    bundle.layers.l2_query_working_set,
  ];
  const expandableLayer = bundle.layers.l3_expandable_deep_memory;
  const residentItems = residentLayers.flatMap((layerValue) => [...layerValue.items]);
  const expandableItems = [...expandableLayer.items];
  const prompt = [
    "# Memory Context",
    "Use these resident memories as scoped context. Treat lower layers as more query-specific.",
    ...residentLayers.map(renderLayerSection),
  ].join("\n\n");
  const expandableReferences = [
    "## L3 expandable deep memory references",
    expandableItems.length === 0
      ? "(no expandable references)"
      : expandableItems.map(formatExpandableReference).join("\n"),
  ].join("\n");

  return {
    prompt,
    expandable_references: expandableReferences,
    resident_memory_ids: residentItems.map((item) => item.memory_id),
    expandable_memory_ids: expandableItems.map((item) => item.memory_id),
    audit: {
      resident_items: residentItems.length,
      expandable_items: expandableItems.length,
      prompt_chars: prompt.length,
      expandable_reference_chars: expandableReferences.length,
    },
  };
}

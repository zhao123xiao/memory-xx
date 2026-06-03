import {
  RECALL_RERANK_CONFIG,
  basenameSourcePath,
  isDailyLogSourcePath,
  normalizeComparableText,
  normalizeSourcePath,
  type QueryAliasTargetMarker
} from "./query-aliases";
import {
  QueryType,
  type QueryConstraints,
  type RetrieverCandidate
} from "./types";

export interface CandidateSignals {
  readonly normalized_title: string;
  readonly normalized_content: string;
  readonly normalized_source_paths: readonly string[];
  readonly source_basenames: readonly string[];
  readonly normalized_sections: readonly string[];
  readonly normalized_matched_terms: ReadonlySet<string>;
  readonly memory_type?: string;
  readonly is_canonical_source: boolean;
  readonly is_canonical_status_row: boolean;
  readonly is_daily_log_source: boolean;
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function exactComparableMatch(left: string, right: string | undefined): boolean {
  return Boolean(
    left && right && normalizeComparableText(left) === normalizeComparableText(right)
  );
}

function tokenizeComparableText(value: string | undefined | null): string[] {
  return normalizeComparableText(value)
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

function computeExtraClusterCueTerms(
  signals: CandidateSignals,
  constraints: QueryConstraints
): string[] {
  const structuralTerms = new Set<string>([
    ...tokenizeComparableText(signals.normalized_title),
    ...signals.normalized_sections.flatMap((section) => tokenizeComparableText(section)),
    ...signals.source_basenames.flatMap((basename) => tokenizeComparableText(basename)),
    ...signals.normalized_source_paths.flatMap((path) => tokenizeComparableText(path))
  ]);

  return unique(
    constraints.query_terms
      .map((term) => normalizeComparableText(term))
      .filter((term) => term.length >= 2 && !structuralTerms.has(term))
  );
}

export function countExtraClusterCueMatches(
  signals: CandidateSignals,
  constraints: QueryConstraints
): number {
  const cueTerms = computeExtraClusterCueTerms(signals, constraints);
  if (cueTerms.length === 0) {
    return 0;
  }

  return cueTerms.filter(
    (term) =>
      signals.normalized_matched_terms.has(term) ||
      signals.normalized_content.includes(term)
  ).length;
}

export function buildCandidateSignals(candidate: RetrieverCandidate): CandidateSignals {
  const sourcePaths = unique([
    normalizeSourcePath(candidate.record.source?.path),
    normalizeSourcePath(candidate.record.canonical_source_path)
  ]);
  const sourceBasenames = unique(sourcePaths.map((path) => basenameSourcePath(path)));
  const normalizedSections = unique([
    normalizeComparableText(candidate.record.section),
    normalizeComparableText(candidate.record.canonical_section)
  ]);

  const memoryType = candidate.record.memory_type?.trim().toLowerCase();
  const isCanonicalSource = sourcePaths.some((path) =>
    RECALL_RERANK_CONFIG.canonical_sort_bonus.canonical_source_paths
      .map((canonicalPath) => normalizeSourcePath(canonicalPath))
      .includes(path)
  );

  return {
    normalized_title: normalizeComparableText(candidate.record.title),
    normalized_content: normalizeComparableText(candidate.record.content),
    normalized_source_paths: sourcePaths,
    source_basenames: sourceBasenames,
    normalized_sections: normalizedSections,
    normalized_matched_terms: new Set(
      candidate.matched_terms.map((term) => normalizeComparableText(term)).filter(Boolean)
    ),
    memory_type: memoryType,
    is_canonical_source: isCanonicalSource,
    is_canonical_status_row:
      isCanonicalSource &&
      Boolean(
        memoryType &&
          RECALL_RERANK_CONFIG.canonical_sort_bonus.canonical_status_memory_types.includes(
            memoryType
          )
      ),
    is_daily_log_source: sourcePaths.some((path) => isDailyLogSourcePath(path))
  };
}

function matchesAliasMarker(
  marker: QueryAliasTargetMarker,
  signals: CandidateSignals
): boolean {
  const normalizedValues = marker.values.map((value) => {
    if (marker.field === "source_path") {
      return normalizeSourcePath(value);
    }

    return normalizeComparableText(value);
  });
  const matcher = marker.match ?? "includes";

  const someExact = (haystacks: readonly string[]) =>
    haystacks.some((haystack) => normalizedValues.includes(haystack));
  const someIncludes = (haystacks: readonly string[]) =>
    haystacks.some((haystack) =>
      normalizedValues.some((value) => Boolean(value) && haystack.includes(value))
    );

  switch (marker.field) {
    case "title":
      return matcher === "exact"
        ? someExact([signals.normalized_title])
        : someIncludes([signals.normalized_title]);
    case "source_path":
      return matcher === "exact"
        ? someExact([...signals.normalized_source_paths, ...signals.source_basenames])
        : someIncludes([...signals.normalized_source_paths, ...signals.source_basenames]);
    case "content":
      return matcher === "exact"
        ? someExact([signals.normalized_content])
        : someIncludes([signals.normalized_content]);
    case "section_path":
      return matcher === "exact"
        ? someExact(signals.normalized_sections)
        : someIncludes(signals.normalized_sections);
    case "matched_terms":
      return normalizedValues.some((value) => signals.normalized_matched_terms.has(value));
    default:
      return false;
  }
}

export function aliasGroupMatchesSignals(
  aliasGroup: (typeof RECALL_RERANK_CONFIG.alias_groups)[number],
  signals: CandidateSignals,
  queryType: QueryType
): boolean {
  let nonSourcePathMatched = false;
  let sourcePathMatched = false;

  for (const marker of aliasGroup.target_markers) {
    if (marker.field === "source_path") {
      sourcePathMatched ||= matchesAliasMarker(marker, signals);
      continue;
    }

    nonSourcePathMatched ||= matchesAliasMarker(marker, signals);
  }

  if (nonSourcePathMatched) {
    return true;
  }

  if (!sourcePathMatched) {
    return false;
  }

  if (aliasGroup.document_lookup_source_path_ok) {
    return true;
  }

  return (
    queryType === QueryType.SourceAudit ||
    queryType === QueryType.ExactLookup ||
    queryType === QueryType.DecisionLookup ||
    queryType === QueryType.PreferenceLookup
  );
}

import {
  basenameSourcePath,
  normalizeComparableText,
  normalizeSourcePath,
  queryMatchesAlias,
  RECALL_RERANK_CONFIG
} from "./query-aliases";
import {
  QueryType,
  type QueryConstraints,
  type RetrieverCandidate
} from "./types";

export interface DerivedClusterKey {
  readonly key?: string;
  readonly reasons: readonly string[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function aliasGroupMatchesCandidate(
  candidate: RetrieverCandidate,
  constraints: QueryConstraints,
  aliasGroup: (typeof RECALL_RERANK_CONFIG.alias_groups)[number]
): boolean {
  const normalizedTitle = normalizeComparableText(candidate.record.title);
  const normalizedContent = normalizeComparableText(candidate.record.content);
  const normalizedSections = unique([
    normalizeComparableText(candidate.record.section),
    normalizeComparableText(candidate.record.canonical_section)
  ]);
  const normalizedSourcePaths = unique([
    normalizeSourcePath(candidate.record.source?.path),
    normalizeSourcePath(candidate.record.canonical_source_path),
    basenameSourcePath(candidate.record.source?.path),
    basenameSourcePath(candidate.record.canonical_source_path)
  ]);
  const normalizedMatchedTerms = new Set(
    candidate.matched_terms.map((term) => normalizeComparableText(term)).filter(Boolean)
  );

  let nonSourcePathMatched = false;
  let sourcePathMatched = false;

  for (const marker of aliasGroup.target_markers) {
    const values = marker.values.map((value) =>
      marker.field === "source_path"
        ? normalizeSourcePath(value)
        : normalizeComparableText(value)
    );
    const exact = marker.match === "exact";
    const includes = (haystacks: readonly string[]) =>
      haystacks.some((haystack) =>
        values.some((value) => Boolean(value) && haystack.includes(value))
      );
    const matches = (haystacks: readonly string[]) =>
      exact ? haystacks.some((haystack) => values.includes(haystack)) : includes(haystacks);

    switch (marker.field) {
      case "title":
        nonSourcePathMatched ||= matches([normalizedTitle]);
        break;
      case "content":
        nonSourcePathMatched ||= matches([normalizedContent]);
        break;
      case "section_path":
        nonSourcePathMatched ||= matches(normalizedSections);
        break;
      case "matched_terms":
        nonSourcePathMatched ||= values.some((value) => normalizedMatchedTerms.has(value));
        break;
      case "source_path":
        sourcePathMatched ||= matches(normalizedSourcePaths);
        break;
      default:
        break;
    }
  }

  if (nonSourcePathMatched) {
    return true;
  }

  if (!sourcePathMatched) {
    return false;
  }

  return (
    constraints.classification.query_type === QueryType.SourceAudit ||
    constraints.classification.query_type === QueryType.ExactLookup ||
    constraints.classification.query_type === QueryType.DecisionLookup ||
    constraints.classification.query_type === QueryType.PreferenceLookup
  );
}

function resolveProjectClusterLabel(candidate: RetrieverCandidate): string | undefined {
  const sourcePaths = [
    normalizeSourcePath(candidate.record.source?.path),
    normalizeSourcePath(candidate.record.canonical_source_path)
  ].filter(Boolean);
  const isProjectLedger = sourcePaths.includes("memory/projects.md");
  if (!isProjectLedger) {
    return undefined;
  }

  const projectHeader = [
    candidate.record.title,
    candidate.record.section,
    candidate.record.canonical_section
  ].find((value) => /^项目：/u.test((value ?? "").trim()));
  if (!projectHeader) {
    return undefined;
  }

  return normalizeComparableText(projectHeader.replace(/^项目：/u, ""));
}

export function deriveClusterKey(
  candidate: RetrieverCandidate,
  constraints: QueryConstraints
): DerivedClusterKey {
  const reasons: string[] = [];

  for (const aliasGroup of RECALL_RERANK_CONFIG.alias_groups) {
    if (!queryMatchesAlias(constraints.normalized_query, aliasGroup.aliases)) {
      continue;
    }

    if (aliasGroupMatchesCandidate(candidate, constraints, aliasGroup)) {
      const key = `alias:${aliasGroup.key}`;
      reasons.push(`cluster_key:${key}`);
      return { key, reasons };
    }
  }

  const projectClusterLabel = resolveProjectClusterLabel(candidate);
  if (projectClusterLabel) {
    const key = `project:${projectClusterLabel}`;
    reasons.push(`cluster_key:${key}`);
    return { key, reasons };
  }

  const canonicalSourcePath = normalizeSourcePath(candidate.record.canonical_source_path);
  const canonicalSection = normalizeComparableText(candidate.record.canonical_section);
  if (canonicalSourcePath && canonicalSection) {
    const key = `canonical-section:${canonicalSourcePath}#${canonicalSection}`;
    reasons.push(`cluster_key:${key}`);
    return { key, reasons };
  }

  const normalizedTitle = normalizeComparableText(candidate.record.title);
  if (normalizedTitle) {
    const key = `title:${normalizedTitle}`;
    reasons.push(`cluster_key:${key}`);
    return { key, reasons };
  }

  const sourcePath = normalizeSourcePath(candidate.record.source?.path);
  if (sourcePath && normalizedTitle) {
    const key = `title-source:${sourcePath}#${normalizedTitle}`;
    reasons.push(`cluster_key:${key}`);
    return { key, reasons };
  }

  return { key: undefined, reasons };
}

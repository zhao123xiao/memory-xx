import { QueryType, type QueryConstraints } from "./types";
import {
  basenameSourcePath,
  normalizeComparableText,
  normalizeSourcePath,
  resolveDocumentAliasTargets
} from "./query-aliases";

export interface RetrievalQueryPolicy {
  readonly mode: "natural_language" | "document_lookup" | "term_lookup";
  readonly allow_ilike_fallback: boolean;
  readonly ilike_patterns: readonly string[];
  readonly exact_title_query: string;
  readonly exact_title_queries: readonly string[];
  readonly exact_section_query: string;
  readonly exact_section_queries: readonly string[];
  readonly exact_source_path_query: string;
  readonly exact_source_path_queries: readonly string[];
  readonly exact_source_basename_query: string;
  readonly exact_source_basename_queries: readonly string[];
  readonly reasons: readonly string[];
}

const CHINESE_CHAR_PATTERN = /[\u4e00-\u9fff]/u;
const DOCUMENT_FILENAME_PATTERN = /(?:^|[\s/])[^\s/]+\.(md|ts|json|sql|py)\b/i;
const EMBEDDED_SOURCE_PATH_PATTERN = /(?:^|\s)((?:[a-z0-9._-]+\/)+[a-z0-9._-]+\.(?:md|ts|json|sql|py))\b/gi;
const EXPLICIT_SECTION_QUERIES = new Set([
  "project index",
  "system decisions",
  "persona",
  "collaboration",
  "core constraints",
  "constraints.md"
]);
const SHORT_ILIKE_TOKENS = new Set([
  "md",
  "db",
  "ts",
  "sql",
  "py",
  "id",
  "go"
]);
const ENGLISH_TOKEN_PATTERN = /[a-z0-9][a-z0-9._/-]*/gi;

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function extractEnglishLongTokens(query: string): string[] {
  return unique(
    [...query.matchAll(ENGLISH_TOKEN_PATTERN)]
      .map((match) => match[0]?.toLowerCase() ?? "")
      .flatMap((token) => {
        const trimmed = token.trim();
        if (!trimmed) {
          return [];
        }

        if (/^[a-z0-9]+$/.test(trimmed)) {
          return trimmed.length >= 4 && !SHORT_ILIKE_TOKENS.has(trimmed)
            ? [trimmed]
            : [];
        }

        const basename = basenameSourcePath(trimmed);
        const segments = trimmed
          .split(/[^a-z0-9]+/i)
          .map((part) => part.trim().toLowerCase())
          .filter(
            (part) => part.length >= 4 && !SHORT_ILIKE_TOKENS.has(part)
          );
        const hasCompositeDelimiter = /[._/-]/.test(trimmed);

        return unique([
          basename.length >= 4 && !SHORT_ILIKE_TOKENS.has(basename)
            ? basename
            : "",
          trimmed.length >= 4 ? trimmed : "",
          ...(hasCompositeDelimiter ? [] : segments)
        ]);
      })
  );
}

function extractEmbeddedSourcePaths(query: string): string[] {
  return unique(
    [...query.matchAll(EMBEDDED_SOURCE_PATH_PATTERN)].map((match) =>
      normalizeSourcePath(match[1] ?? "")
    )
  );
}

function isDocumentLookupQuery(
  query: string,
  aliasTargetCount: number,
  embeddedSourcePaths: readonly string[]
): boolean {
  const normalizedComparable = normalizeComparableText(query);
  const normalizedPath = normalizeSourcePath(query);

  return (
    DOCUMENT_FILENAME_PATTERN.test(query) ||
    normalizedPath.includes("/") ||
    embeddedSourcePaths.length > 0 ||
    EXPLICIT_SECTION_QUERIES.has(normalizedComparable) ||
    aliasTargetCount > 0
  );
}

export function buildRetrievalQueryPolicy(
  constraints: QueryConstraints
): RetrievalQueryPolicy {
  const rawQuery = constraints.normalized_query.trim();
  const exactTitleQuery = rawQuery.trim().toLowerCase();
  const normalizedExactTitleQuery = normalizeComparableText(rawQuery);
  const exactSectionQuery = normalizeComparableText(rawQuery);
  const exactSourcePathQuery = normalizeSourcePath(rawQuery);
  const exactSourceBasenameQuery = basenameSourcePath(rawQuery);
  const aliasTargets = resolveDocumentAliasTargets(rawQuery);
  const embeddedSourcePaths = extractEmbeddedSourcePaths(rawQuery);
  const exactTitleQueries = unique([
    exactTitleQuery,
    normalizedExactTitleQuery,
    ...aliasTargets.title_queries
  ]);
  const exactSectionQueries = unique([
    exactSectionQuery,
    ...aliasTargets.section_queries
  ]);
  const exactSourcePathQueries = unique([
    exactSourcePathQuery,
    ...embeddedSourcePaths,
    ...aliasTargets.source_path_queries
  ]);
  const exactSourceBasenameQueries = unique([
    exactSourceBasenameQuery,
    ...exactSourcePathQueries.map((path) => basenameSourcePath(path))
  ]);
  const englishLongTokens = extractEnglishLongTokens(rawQuery);
  const hasChinese = CHINESE_CHAR_PATTERN.test(rawQuery);
  const documentLookup = isDocumentLookupQuery(
    rawQuery,
    aliasTargets.alias_keys.length,
    embeddedSourcePaths
  );
  const reasons: string[] = [];

  if (documentLookup) {
    reasons.push("document_lookup_exact_match_mode");
    reasons.push(
      ...aliasTargets.alias_keys.map(
        (aliasKey) => `document_lookup_alias:${aliasKey}`
      )
    );
    const allExactEmpty = exactTitleQueries.length === 0 && exactSectionQueries.length === 0 && exactSourcePathQueries.length === 0 && exactSourceBasenameQueries.length === 0;
    const fallbackIlikePatterns = allExactEmpty ? ["%" + rawQuery + "%"] : [];
    return {
      mode: "document_lookup",
      allow_ilike_fallback: allExactEmpty ? true : false,
      ilike_patterns: fallbackIlikePatterns,
      exact_title_query: exactTitleQueries[0] ?? "",
      exact_title_queries: exactTitleQueries,
      exact_section_query: exactSectionQueries[0] ?? "",
      exact_section_queries: exactSectionQueries,
      exact_source_path_query: exactSourcePathQueries[0] ?? "",
      exact_source_path_queries: exactSourcePathQueries,
      exact_source_basename_query: exactSourceBasenameQueries[0] ?? "",
      exact_source_basename_queries: exactSourceBasenameQueries,
      reasons
    };
  }

  if (hasChinese && englishLongTokens.length === 0) {
    reasons.push("chinese_natural_language_no_ilike");
    return {
      mode: "natural_language",
      allow_ilike_fallback: false,
      ilike_patterns: [],
      exact_title_query: exactTitleQueries[0] ?? "",
      exact_title_queries: exactTitleQueries,
      exact_section_query: exactSectionQueries[0] ?? "",
      exact_section_queries: exactSectionQueries,
      exact_source_path_query: exactSourcePathQueries[0] ?? "",
      exact_source_path_queries: exactSourcePathQueries,
      exact_source_basename_query: exactSourceBasenameQueries[0] ?? "",
      exact_source_basename_queries: exactSourceBasenameQueries,
      reasons
    };
  }

  const ilikePatterns = unique(
    englishLongTokens.flatMap((token) => {
      const basename = basenameSourcePath(token);
      const patterns = [
        token.length >= 4 ? `%${token}%` : "",
        basename !== token && basename.length >= 4 ? `%${basename}%` : ""
      ];

      return patterns;
    })
  ).slice(0, 6);

  if (ilikePatterns.length > 0) {
    reasons.push("long_english_token_ilike_fallback");
  } else if (
    constraints.classification.query_type === QueryType.SourceAudit ||
    constraints.classification.query_type === QueryType.ExactLookup
  ) {
    reasons.push("exact_query_without_ilike_fallback");
  }

  return {
    mode: hasChinese ? "natural_language" : "term_lookup",
    allow_ilike_fallback: ilikePatterns.length > 0,
    ilike_patterns: ilikePatterns,
    exact_title_query: exactTitleQueries[0] ?? "",
    exact_title_queries: exactTitleQueries,
    exact_section_query: exactSectionQueries[0] ?? "",
    exact_section_queries: exactSectionQueries,
    exact_source_path_query: exactSourcePathQueries[0] ?? "",
    exact_source_path_queries: exactSourcePathQueries,
    exact_source_basename_query: exactSourceBasenameQueries[0] ?? "",
    exact_source_basename_queries: exactSourceBasenameQueries,
    reasons
  };
}

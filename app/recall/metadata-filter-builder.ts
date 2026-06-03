import {
  QueryType,
  type QueryClassification,
  type RecallMetadataConstraints,
  type RecallRecord
} from "./types";

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "to",
  "for",
  "of",
  "and",
  "what",
  "when",
  "where",
  "why",
  "how",
  "is",
  "are",
  "was",
  "were",
  "do",
  "did",
  "in",
  "on",
  "at",
  "about",
  "with"
]);

const CHINESE_STOPWORDS = new Set([
  "的",
  "是",
  "了",
  "在",
  "有",
  "什么",
  "怎么",
  "哪些",
  "哪",
  "我",
  "你",
  "他",
  "她",
  "它",
  "们",
  "这",
  "那",
  "和",
  "与",
  "或",
  "不",
  "没",
  "到",
  "被",
  "把",
  "给",
  "对",
  "从",
  "向",
  "用",
  "为",
  "以",
  "可以",
  "能",
  "会",
  "要",
  "将",
  "应",
  "该",
  "已",
  "曾",
  "就",
  "也",
  "都",
  "还",
  "又",
  "再",
  "才",
  "却",
  "并",
  "而",
  "且",
  "但",
  "如果",
  "因为",
  "所以",
  "虽然",
  "然后",
  "接着"
]);

const CHINESE_CHAR_PATTERN = /[\u4e00-\u9fff]/u;
const TOKEN_SEGMENT_PATTERN = /[a-z0-9_]+|[\u4e00-\u9fff]+/giu;
const PRONOUN_LIKE_STOPWORD_PREFIXES = new Set(["我", "你", "他", "她", "它", "们", "这", "那"]);
const CANONICAL_MEMORY_MD_HEADER_QUERIES = new Set([
  "system decisions",
  "project index",
  "persona"
]);

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function parseYears(query: string): number[] {
  return [...query.matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1]));
}

function parseProjectIds(query: string): string[] {
  const matches = [...query.matchAll(/\bproject[:=]\s*([a-z0-9._-]+)/gi)];
  return unique(matches.map((match) => match[1].toLowerCase()));
}

function parseSourceTypes(query: string): string[] {
  const matches = [...query.matchAll(/\bsource[:=]\s*([a-z0-9._-]+)/gi)];
  const fileTypeMatches = [...query.matchAll(/\.(md|ts|json|sql|py)\b/gi)].map(
    (match) => match[1].toLowerCase()
  );
  return unique([
    ...matches.map((match) => match[1].toLowerCase()),
    ...fileTypeMatches
  ]);
}

function parseTags(query: string): string[] {
  const hashMatches = [...query.matchAll(/#([a-z0-9_-]+)/gi)].map((match) =>
    match[1].toLowerCase()
  );
  const tagMatches = [...query.matchAll(/\btag[:=]\s*([a-z0-9_-]+)/gi)].map(
    (match) => match[1].toLowerCase()
  );
  return unique([...hashMatches, ...tagMatches]);
}

function parseEntityNames(rawQuery: string): string[] {
  const englishNames = [...rawQuery.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g)].map(
    (match) => match[1]
  );
  const quotedNames = [...rawQuery.matchAll(/"([^"]+)"/g)].map((match) =>
    match[1].trim()
  );
  return unique([...englishNames, ...quotedNames]);
}

function shouldSuppressEntityNameExtraction(input: {
  query: string;
  classification: QueryClassification;
}): boolean {
  const normalizedQuery = input.query.trim().toLowerCase();
  return CANONICAL_MEMORY_MD_HEADER_QUERIES.has(normalizedQuery);
}

function segmentChineseStopwords(
  token: string,
  start = 0,
  memo = new Map<number, string[] | null>()
): string[] | null {
  if (start === token.length) {
    return [];
  }

  if (memo.has(start)) {
    return memo.get(start) ?? null;
  }

  for (let end = token.length; end > start; end -= 1) {
    const part = token.slice(start, end);
    if (!CHINESE_STOPWORDS.has(part)) {
      continue;
    }

    const remainder = segmentChineseStopwords(token, end, memo);
    if (remainder) {
      const result = [part, ...remainder];
      memo.set(start, result);
      return result;
    }
  }

  memo.set(start, null);
  return null;
}

function isPureChineseStopwordToken(token: string): boolean {
  if (CHINESE_STOPWORDS.has(token)) {
    return true;
  }

  const segments = segmentChineseStopwords(token);
  if (!segments || segments.length === 0) {
    return false;
  }

  if (segments.some((segment) => segment.length > 1)) {
    return true;
  }

  return (
    segments.length >= 2 && PRONOUN_LIKE_STOPWORD_PREFIXES.has(segments[0] ?? "")
  );
}

function hasChineseStopwordEdge(token: string): boolean {
  for (let size = 1; size < token.length; size += 1) {
    const prefix = token.slice(0, size);
    const suffix = token.slice(token.length - size);
    if (
      isPureChineseStopwordToken(prefix) ||
      isPureChineseStopwordToken(suffix)
    ) {
      return true;
    }
  }

  return false;
}

function tokenizeChineseSegment(segment: string): string[] {
  const chars = [...segment];
  const tokens: string[] = [];

  for (let index = 0; index < chars.length - 1; index += 1) {
    tokens.push(chars.slice(index, index + 2).join(""));
  }

  for (let size = 3; size <= Math.min(chars.length, 4); size += 1) {
    for (let start = 0; start + size <= chars.length; start += 1) {
      const token = chars.slice(start, start + size).join("");
      if (!hasChineseStopwordEdge(token)) {
        tokens.push(token);
      }
    }
  }

  return unique(
    tokens.filter(
      (token) => token.length >= 2 && !isPureChineseStopwordToken(token)
    )
  );
}

function buildQueryTerms(query: string): string[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!CHINESE_CHAR_PATTERN.test(normalizedQuery)) {
    return unique(
      normalizedQuery
        .split(/[^a-z0-9_\u4e00-\u9fff]+/u)
        .filter((term) => term.length >= 2 && !STOPWORDS.has(term))
    );
  }

  const segments = normalizedQuery.match(TOKEN_SEGMENT_PATTERN) ?? [];

  return unique(
    segments.flatMap((segment) => {
      if (CHINESE_CHAR_PATTERN.test(segment)) {
        return tokenizeChineseSegment(segment);
      }

      return segment.length >= 2 && !STOPWORDS.has(segment) ? [segment] : [];
    })
  );
}

export function buildMetadataConstraints(input: {
  query: string;
  classification: QueryClassification;
}): RecallMetadataConstraints {
  const years = parseYears(input.query);
  const projectIds = parseProjectIds(input.query);
  const sourceTypes = parseSourceTypes(input.query);
  const tags = parseTags(input.query);
  const entityNames = shouldSuppressEntityNameExtraction(input)
    ? []
    : parseEntityNames(input.query);

  if (
    input.classification.query_type === QueryType.ProjectContext &&
    projectIds.length === 0
  ) {
    const fromTerms = buildQueryTerms(input.query).filter((term) =>
      /^p[-_][a-z0-9._-]+$/i.test(term)
    );
    projectIds.push(...fromTerms);
  }

  return {
    project_ids: unique(projectIds),
    tags,
    entity_names: entityNames,
    source_types: sourceTypes,
    years,
    date_from: years.length > 0 ? `${Math.min(...years)}-01-01` : undefined,
    date_to: years.length > 0 ? `${Math.max(...years)}-12-31` : undefined
  };
}

export function matchesMetadataConstraints(
  record: RecallRecord,
  constraints: RecallMetadataConstraints
): boolean {
  if (
    constraints.project_ids.length > 0 &&
    (!record.project_id ||
      !constraints.project_ids.includes(record.project_id.toLowerCase()))
  ) {
    return false;
  }

  if (
    constraints.tags.length > 0 &&
    !constraints.tags.every((tag) =>
      (record.tags ?? []).map((value) => value.toLowerCase()).includes(tag)
    )
  ) {
    return false;
  }

  if (
    constraints.entity_names.length > 0 &&
    !constraints.entity_names.some((entityName) =>
      (record.entity_names ?? []).includes(entityName)
    )
  ) {
    return false;
  }

  if (
    constraints.source_types.length > 0 &&
    !constraints.source_types.includes(
      (record.source?.source_type ?? "").toLowerCase()
    )
  ) {
    return false;
  }

  if (constraints.years.length > 0 && record.created_at) {
    const recordYear = new Date(record.created_at).getUTCFullYear();
    if (!constraints.years.includes(recordYear)) {
      return false;
    }
  }

  return true;
}

export function tokenizeRecallQuery(query: string): string[] {
  return buildQueryTerms(query);
}

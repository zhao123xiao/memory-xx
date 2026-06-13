export type GraphDebtBackfillLane = "production" | "test_only";

export interface GraphDebtBackfillLaneInput {
  readonly scope_type?: string | null;
  readonly scope_id?: string | null;
  readonly title?: string | null;
  readonly relation_id?: string | null;
}

export interface GraphDebtBackfillPredicateOptions {
  readonly productionOnly: boolean;
  readonly relationTable?: string;
  readonly excludeRelationDebt?: boolean;
}

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function hasTestSignal(value: string | null | undefined): boolean {
  const normalized = normalize(value);
  return normalized.includes("test") ||
    normalized.includes("测试") ||
    normalized.includes("fixture") ||
    normalized.includes("debug") ||
    normalized.includes("benchmark") ||
    normalized.includes("policy-corpus");
}

function assertAlias(value: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe SQL alias: ${value}`);
  }
}

function assertSqlTable(value: string): void {
  const ident = String.raw`(?:"[a-zA-Z_][a-zA-Z0-9_]*"|[a-zA-Z_][a-zA-Z0-9_]*)`;
  const pattern = new RegExp(`^${ident}(?:\\.${ident})?$`, "u");
  if (!pattern.test(value)) {
    throw new Error(`Unsafe SQL table: ${value}`);
  }
}

export function classifyGraphDebtBackfillLane(input: GraphDebtBackfillLaneInput): GraphDebtBackfillLane {
  if (normalize(input.relation_id).startsWith("relation_debt_")) return "test_only";
  if (hasTestSignal(input.scope_id) || hasTestSignal(input.title)) return "test_only";
  return "production";
}

export function buildGraphDebtBackfillScopePredicate(
  alias: string,
  options: GraphDebtBackfillPredicateOptions,
): string {
  assertAlias(alias);
  if (!options.productionOnly) return "TRUE";
  const relationTable = options.relationTable ?? "memory_relations";
  assertSqlTable(relationTable);
  const predicates = [
    `NOT (lower(COALESCE(${alias}.scope_id, '')) LIKE '%test%')`,
    `NOT (lower(COALESCE(${alias}.scope_id, '')) LIKE '%测试%')`,
    `NOT (lower(COALESCE(${alias}.scope_id, '')) LIKE '%fixture%')`,
    `NOT (lower(COALESCE(${alias}.scope_id, '')) LIKE '%debug%')`,
    `NOT (lower(COALESCE(${alias}.scope_id, '')) LIKE '%benchmark%')`,
    `NOT (lower(COALESCE(${alias}.scope_id, '')) LIKE '%policy-corpus%')`,
    `NOT (lower(COALESCE(${alias}.title, '')) LIKE '%test%')`,
    `NOT (lower(COALESCE(${alias}.title, '')) LIKE '%测试%')`,
    `NOT (lower(COALESCE(${alias}.title, '')) LIKE '%fixture%')`,
    `NOT (lower(COALESCE(${alias}.title, '')) LIKE '%debug%')`,
    `NOT (
      ${alias}.metadata->>'eval_only' = 'true'
      AND ${alias}.metadata->>'policy_training' = 'true'
      AND ${alias}.metadata->>'recall_policy' = 'test_only'
    )`,
  ];
  if (options.excludeRelationDebt ?? true) {
    predicates.push(`NOT EXISTS (
      SELECT 1 FROM ${relationTable} rel
      WHERE (rel.memory_id = ${alias}.id OR rel.related_memory_id = ${alias}.id)
        AND rel.id LIKE 'relation_debt_%'
    )`);
  }
  return predicates.join("\n          AND ");
}

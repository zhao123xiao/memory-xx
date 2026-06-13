import { config } from "../config.js";
import { createPool, query, closePool } from "../lib/db-helpers.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import { createEmptyReport, finalizeReport, type CheckResult } from "../report-model.js";
import { buildGraphDebtBackfillScopePredicate } from "../../../app/governance/graph-debt-backfill-policy.js";

const runId = generateRunId();
const report = createEmptyReport("L14", runId);

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : severity === "warning" ? "WARN" : "FAIL";
  console.log(`  [${icon}] ${name}: ${scrubSecrets(detail)}`);
}

async function readMemoryRecordColumns(pool: ReturnType<typeof createPool>): Promise<Set<string>> {
  const result = await query(pool, `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = 'memory_records'
  `, [config.dbSchema]);
  return new Set(result.rows.map((row: { column_name: string }) => row.column_name));
}

function missingIdentityExpression(columns: Set<string>): string {
  const hasDedupeKey = columns.has("dedupe_key");
  const hasSignatureHash = columns.has("signature_hash");
  if (hasDedupeKey && hasSignatureHash) {
    return "(dedupe_key IS NULL OR dedupe_key = '' OR signature_hash IS NULL OR signature_hash = '')";
  }
  if (hasDedupeKey) {
    return "(dedupe_key IS NULL OR dedupe_key = '')";
  }
  if (hasSignatureHash) {
    return "(signature_hash IS NULL OR signature_hash = '')";
  }
  return "FALSE";
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  L14 Data Governance — run_id: ${runId}`);
  console.log(`${"=".repeat(50)}\n`);

  const pool = createPool();
  try {
    const memoryRecordColumns = await readMemoryRecordColumns(pool);
    const identityMissingSql = missingIdentityExpression(memoryRecordColumns);
    const duplicate = await query(pool, `
      WITH active AS (
        SELECT scope_type, scope_id, COALESCE(memory_type, 'unknown') AS memory_type,
               regexp_replace(lower(trim(content)), '\\s+', ' ', 'g') AS normalized_content
        FROM ${config.dbSchema}.memory_records
        WHERE is_current IS TRUE AND lifecycle_status = 'approved' AND review_state IN ('approved', 'not_required')
      ),
      clusters AS (
        SELECT scope_type, scope_id, memory_type, normalized_content, count(*)::int AS cnt
        FROM active
        GROUP BY 1,2,3,4
        HAVING count(*) > 1
      )
      SELECT count(*)::int AS clusters, COALESCE(sum(cnt), 0)::int AS records FROM clusters
    `);
    const duplicateClusters = Number(duplicate.rows[0]?.clusters ?? 0);
    const duplicateRecords = Number(duplicate.rows[0]?.records ?? 0);
    check("duplicates:exact-active", duplicateClusters === 0,
      `clusters=${duplicateClusters}, records=${duplicateRecords}`,
      duplicateClusters === 0 ? "critical" : "warning");
    report.metrics["exact_duplicate_clusters"] = duplicateClusters;
    report.metrics["exact_duplicate_records"] = duplicateRecords;

    const testPollution = await query(pool, `
      WITH scored AS (
        SELECT
          metadata,
          (
          CASE WHEN scope_id ~* '(^|[-_:])(test|load-test|mcp-user-flow|benchmark|smoke)([-_:]|$)' THEN 2 ELSE 0 END +
          CASE WHEN COALESCE(metadata->>'source', source_ref, source_kind, '') ~* '(test|benchmark|smoke|load)' THEN 1 ELSE 0 END +
          CASE WHEN COALESCE(title, '') || ' ' || content ~* '(temporary test|benchmark sample|schema example|Unified API test|L[0-9]+ .*test|测试记录|测试污染)' THEN 1 ELSE 0 END
        ) AS test_score,
        (
          metadata->>'eval_only' = 'true'
          AND metadata->>'policy_training' = 'true'
          AND metadata->>'recall_policy' = 'test_only'
        ) AS isolated_eval_corpus
        FROM ${config.dbSchema}.memory_records
        WHERE is_current IS TRUE AND lifecycle_status IN ('approved', 'candidate')
      )
      SELECT
        count(*) FILTER (WHERE test_score >= 2 AND NOT isolated_eval_corpus)::int AS production_test_pollution,
        count(*) FILTER (WHERE test_score >= 2 AND isolated_eval_corpus)::int AS isolated_eval_corpus
      FROM scored
    `);
    const productionTestPollution = Number(testPollution.rows[0]?.production_test_pollution ?? 0);
    const isolatedEvalCorpus = Number(testPollution.rows[0]?.isolated_eval_corpus ?? 0);
    check("test-pollution:production-cleanup-candidates", productionTestPollution === 0,
      `production_test_pollution=${productionTestPollution}, isolated_eval_corpus=${isolatedEvalCorpus}`,
      productionTestPollution === 0 ? "critical" : "warning");
    report.metrics["production_test_pollution"] = productionTestPollution;
    report.metrics["isolated_eval_corpus"] = isolatedEvalCorpus;

    const productionProvenancePredicate = buildGraphDebtBackfillScopePredicate("mr", {
      productionOnly: true,
      relationTable: `${config.dbSchema}.memory_relations`,
      excludeRelationDebt: false,
    });
    const provenance = await query(pool, `
      WITH scored AS (
        SELECT
          mr.*,
          NOT (${productionProvenancePredicate}) AS non_production_lane,
          (source_kind IS NULL OR source_kind = '' OR source_ref IS NULL OR source_ref = '') AS missing_source,
          ${identityMissingSql} AS missing_identity,
          (valid_at IS NULL OR observed_at IS NULL) AS missing_time
        FROM ${config.dbSchema}.memory_records mr
        WHERE mr.is_current IS TRUE AND mr.lifecycle_status = 'approved' AND mr.review_state IN ('approved', 'not_required')
      )
      SELECT
        count(*)::int AS active,
        count(*) FILTER (WHERE missing_source)::int AS missing_source,
        count(*) FILTER (WHERE missing_identity)::int AS missing_identity,
        count(*) FILTER (WHERE missing_time)::int AS missing_time,
        count(*) FILTER (WHERE missing_source AND NOT non_production_lane)::int AS production_missing_source,
        count(*) FILTER (WHERE missing_source AND non_production_lane)::int AS non_production_missing_source,
        count(*) FILTER (WHERE missing_identity AND NOT non_production_lane)::int AS production_missing_identity,
        count(*) FILTER (WHERE missing_identity AND non_production_lane)::int AS non_production_missing_identity,
        count(*) FILTER (WHERE missing_time AND NOT non_production_lane)::int AS production_missing_time,
        count(*) FILTER (WHERE missing_time AND non_production_lane)::int AS non_production_missing_time
      FROM scored
    `);
    const row = provenance.rows[0] ?? {};
    const active = Number(row.active ?? 0);
    const missingSource = Number(row.missing_source ?? 0);
    const missingIdentity = Number(row.missing_identity ?? 0);
    const missingTime = Number(row.missing_time ?? 0);
    const productionMissingSource = Number(row.production_missing_source ?? 0);
    const nonProductionMissingSource = Number(row.non_production_missing_source ?? 0);
    const productionMissingIdentity = Number(row.production_missing_identity ?? 0);
    const nonProductionMissingIdentity = Number(row.non_production_missing_identity ?? 0);
    const productionMissingTime = Number(row.production_missing_time ?? 0);
    const nonProductionMissingTime = Number(row.non_production_missing_time ?? 0);
    check("provenance:production-required-fields",
      productionMissingSource === 0 && productionMissingIdentity === 0 && productionMissingTime === 0,
      `active=${active}, production_missing_source=${productionMissingSource}, production_missing_identity=${productionMissingIdentity}, production_missing_time=${productionMissingTime}, non_production_missing_source=${nonProductionMissingSource}, non_production_missing_identity=${nonProductionMissingIdentity}, non_production_missing_time=${nonProductionMissingTime}`,
      productionMissingSource === 0 && productionMissingIdentity === 0 && productionMissingTime === 0 ? "critical" : "warning");
    report.metrics["provenance_missing_source"] = missingSource;
    report.metrics["provenance_missing_identity"] = missingIdentity;
    report.metrics["provenance_missing_time"] = missingTime;
    report.metrics["production_missing_source"] = productionMissingSource;
    report.metrics["production_missing_identity"] = productionMissingIdentity;
    report.metrics["production_missing_time"] = productionMissingTime;
    report.metrics["non_production_missing_source"] = nonProductionMissingSource;
    report.metrics["non_production_missing_identity"] = nonProductionMissingIdentity;
    report.metrics["non_production_missing_time"] = nonProductionMissingTime;
  } finally {
    await closePool(pool);
  }

  finalizeReport(report);
  console.log(`@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  check("fatal", false, error instanceof Error ? error.message : String(error));
  finalizeReport(report);
  console.log(`@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);
  process.exit(1);
});

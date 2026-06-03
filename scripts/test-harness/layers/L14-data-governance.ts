import { config } from "../config.js";
import { createPool, query, closePool } from "../lib/db-helpers.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import { createEmptyReport, finalizeReport, type CheckResult } from "../report-model.js";

const runId = generateRunId();
const report = createEmptyReport("L14", runId);

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : severity === "warning" ? "WARN" : "FAIL";
  console.log(`  [${icon}] ${name}: ${scrubSecrets(detail)}`);
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  L14 Data Governance — run_id: ${runId}`);
  console.log(`${"=".repeat(50)}\n`);

  const pool = createPool();
  try {
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
        SELECT (
          CASE WHEN scope_id ~* '(^|[-_:])(test|load-test|mcp-user-flow|benchmark|smoke)([-_:]|$)' THEN 2 ELSE 0 END +
          CASE WHEN COALESCE(metadata->>'source', source_ref, source_kind, '') ~* '(test|benchmark|smoke|load)' THEN 1 ELSE 0 END +
          CASE WHEN COALESCE(title, '') || ' ' || content ~* '(temporary test|benchmark sample|schema example|Unified API test|L[0-9]+ .*test|测试记录|测试污染)' THEN 1 ELSE 0 END
        ) AS test_score
        FROM ${config.dbSchema}.memory_records
        WHERE is_current IS TRUE AND lifecycle_status IN ('approved', 'candidate')
      )
      SELECT count(*) FILTER (WHERE test_score >= 2)::int AS high_confidence_test_pollution FROM scored
    `);
    const highConfidenceTests = Number(testPollution.rows[0]?.high_confidence_test_pollution ?? 0);
    check("test-pollution:high-confidence", highConfidenceTests === 0,
      `high_confidence_test_pollution=${highConfidenceTests}`,
      highConfidenceTests === 0 ? "critical" : "warning");
    report.metrics["high_confidence_test_pollution"] = highConfidenceTests;

    const provenance = await query(pool, `
      SELECT
        count(*)::int AS active,
        count(*) FILTER (WHERE source_kind IS NULL OR source_kind = '' OR source_ref IS NULL OR source_ref = '')::int AS missing_source,
        count(*) FILTER (WHERE dedupe_key IS NULL OR dedupe_key = '' OR signature_hash IS NULL OR signature_hash = '')::int AS missing_identity,
        count(*) FILTER (WHERE valid_at IS NULL OR observed_at IS NULL)::int AS missing_time
      FROM ${config.dbSchema}.memory_records
      WHERE is_current IS TRUE AND lifecycle_status = 'approved' AND review_state IN ('approved', 'not_required')
    `);
    const row = provenance.rows[0] ?? {};
    const active = Number(row.active ?? 0);
    const missingSource = Number(row.missing_source ?? 0);
    const missingIdentity = Number(row.missing_identity ?? 0);
    const missingTime = Number(row.missing_time ?? 0);
    check("provenance:required-fields", missingSource === 0 && missingIdentity === 0 && missingTime === 0,
      `active=${active}, missing_source=${missingSource}, missing_identity=${missingIdentity}, missing_time=${missingTime}`,
      missingSource === 0 && missingIdentity === 0 && missingTime === 0 ? "critical" : "warning");
    report.metrics["provenance_missing_source"] = missingSource;
    report.metrics["provenance_missing_identity"] = missingIdentity;
    report.metrics["provenance_missing_time"] = missingTime;
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
